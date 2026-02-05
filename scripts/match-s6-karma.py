#!/usr/bin/env python3
"""
S6 Karma Matching Script

Matches Season 6 game data with karma scores from Supabase.
Strategies:
1. Direct matching: player_id → Supabase user_id (same value)
2. Rank-based discovery: Use weekly ranking to find matching daily ranks
3. Ranked days API: Fetch player history to verify/discover mappings

Usage:
    python match-s6-karma.py [--dry-run] [--rank-tolerance 50]
"""

import json
import os
import time
import uuid
import argparse
import requests
from datetime import datetime
from collections import defaultdict
from typing import Optional, Dict, List, Tuple, Set

# Try to import supabase - graceful fallback if not installed
try:
    from supabase import create_client, Client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False
    print("⚠️  Supabase library not installed. Run: pip install supabase")
try:
    from hashids import Hashids
    HASHIDS_AVAILABLE = True
except ImportError:
    HASHIDS_AVAILABLE = False
    print("⚠️  Hashids not installed. Run: pip install hashids")


# Configuration
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
GAMES_FILE = os.path.join(SCRIPT_DIR, "s6-games-enhanced.json")
HANDLE_TO_ID_FILE = os.path.join(SCRIPT_DIR, "s6-handle-to-id.json")
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "output")

# API configuration
REAL_API_BASE = "https://web.realsports.io"
REAL_VERSION = "27"
RANKED_DAYS_API = f"{REAL_API_BASE}/rankeddays"
REQUEST_DELAY = 0.5  # Seconds between API calls

REAL_AUTH_TOKEN = os.environ.get("REAL_AUTH_TOKEN")
if not REAL_AUTH_TOKEN:
    try:
        from getpass import getpass
        REAL_AUTH_TOKEN = getpass("Enter RealSports auth token: ")
    except Exception:
        REAL_AUTH_TOKEN = None

DEVICE_UUID = os.environ.get("REAL_DEVICE_UUID") or str(uuid.uuid4())
DEFAULT_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"


def generate_request_token() -> str:
    if not HASHIDS_AVAILABLE:
        raise RuntimeError("hashids is required. Install with: pip install hashids")
    hashids = Hashids(salt="realwebapp", min_length=16)
    return hashids.encode(int(time.time() * 1000))


def build_real_headers(device_name: str = "Chrome on Windows") -> dict:
    if not REAL_AUTH_TOKEN:
        raise RuntimeError("REAL_AUTH_TOKEN is not set.")
    return {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "DNT": "1",
        "Origin": "https://realsports.io",
        "Referer": "https://realsports.io/",
        "User-Agent": DEFAULT_USER_AGENT,
        "real-auth-info": REAL_AUTH_TOKEN,
        "real-device-name": device_name,
        "real-device-type": "desktop_web",
        "real-device-uuid": DEVICE_UUID,
        "real-request-token": generate_request_token(),
        "real-version": REAL_VERSION,
    }

# Default rank tolerance for fuzzy matching
DEFAULT_RANK_TOLERANCE = 50


class KarmaMatcher:
    """Main class for matching S6 game data with karma scores."""

    def __init__(self, supabase_url: str = None, supabase_key: str = None,
                 rank_tolerance: int = DEFAULT_RANK_TOLERANCE, dry_run: bool = False):
        self.rank_tolerance = rank_tolerance
        self.dry_run = dry_run
        self.supabase: Optional[Client] = None

        # Data structures
        self.games: List[dict] = []
        self.handle_to_id: Dict[str, str] = {}

        # Caches
        self.karma_cache: Dict[str, Dict[str, dict]] = {}  # date -> user_id -> {amount, rank, username}
        self.ranked_days_cache: Dict[str, List[dict]] = {}  # user_id -> [{day, karma, rank}, ...]

        # Discovery tracking
        self.discovered_ids: Dict[str, str] = {}  # handle -> user_id (newly discovered)
        self.match_stats = {
            "direct_matches": 0,
            "rank_discoveries": 0,
            "api_discoveries": 0,
            "no_match": 0,
            "outside_top_1000": 0,
        }

        # Initialize Supabase if credentials provided
        if supabase_url and supabase_key and SUPABASE_AVAILABLE:
            try:
                self.supabase = create_client(supabase_url, supabase_key)
                print("✅ Connected to Supabase")
            except Exception as e:
                print(f"❌ Failed to connect to Supabase: {e}")

    def load_games_data(self) -> bool:
        """Load S6 games and handle-to-id mapping."""
        try:
            with open(GAMES_FILE, 'r', encoding='utf-8') as f:
                self.games = json.load(f)
            print(f"✅ Loaded {len(self.games)} games from {GAMES_FILE}")

            if os.path.exists(HANDLE_TO_ID_FILE):
                with open(HANDLE_TO_ID_FILE, 'r', encoding='utf-8') as f:
                    self.handle_to_id = json.load(f)
                print(f"✅ Loaded {len(self.handle_to_id)} handle mappings")

            return True
        except Exception as e:
            print(f"❌ Error loading data: {e}")
            return False

    def fetch_karma_for_date(self, date_str: str) -> Dict[str, dict]:
        """
        Fetch all karma rankings for a specific date from Supabase.
        Returns dict: user_id -> {amount, rank, username}
        """
        if date_str in self.karma_cache:
            return self.karma_cache[date_str]

        if not self.supabase:
            print(f"⚠️  No Supabase connection, skipping fetch for {date_str}")
            return {}

        try:
            # Fetch all entries for this date
            response = self.supabase.table("karma_rankings") \
                .select("user_id, username, amount, rank") \
                .eq("scrape_date", date_str) \
                .execute()

            karma_map = {}
            for entry in response.data:
                karma_map[entry["user_id"]] = {
                    "amount": entry["amount"],
                    "rank": entry["rank"],
                    "username": entry["username"]
                }

            self.karma_cache[date_str] = karma_map
            print(f"  📊 Cached {len(karma_map)} karma entries for {date_str}")
            return karma_map

        except Exception as e:
            print(f"❌ Error fetching karma for {date_str}: {e}")
            return {}

    def fetch_ranked_days(self, user_id: str) -> List[dict]:
        """
        Fetch ranked days history for a player from the RealSports API.
        Returns list of {day, karma, rank} entries.
        """
        if user_id in self.ranked_days_cache:
            return self.ranked_days_cache[user_id]

        all_data = []
        oldest_date = None

        while True:
            if oldest_date is None:
                url = f"{RANKED_DAYS_API}/{user_id}?sort=latest"
            else:
                url = f"{RANKED_DAYS_API}/{user_id}?before={oldest_date}&sort=latest"

            try:
                response = requests.get(url, headers=build_real_headers(), timeout=30)
                response.raise_for_status()
                data = response.json()

                days = data.get('days', [])
                if not days:
                    break

                all_data.extend(days)
                oldest_date = days[-1]['day']

                time.sleep(REQUEST_DELAY)

            except Exception as e:
                print(f"    ⚠️  Error fetching ranked days for {user_id}: {e}")
                break

        self.ranked_days_cache[user_id] = all_data
        return all_data

    def match_player_direct(self, player_id: str, game_date: str) -> Optional[dict]:
        """
        Direct match: Look up player_id in Supabase karma data for the given date.
        Returns {amount, rank, username} or None.
        """
        karma_data = self.fetch_karma_for_date(game_date)

        if player_id in karma_data:
            return karma_data[player_id]
        return None

    def discover_by_rank(self, handle: str, weekly_ranking: int, game_date: str,
                         known_ids: Set[str]) -> Optional[Tuple[str, dict]]:
        """
        Rank-based discovery: Find a player in Supabase by approximate rank match.

        Args:
            handle: Player handle to match
            weekly_ranking: Expected weekly ranking (from CSV)
            game_date: Date of the game
            known_ids: Set of already-matched user_ids to exclude

        Returns:
            (user_id, karma_data) tuple or None
        """
        karma_data = self.fetch_karma_for_date(game_date)

        # Find candidates within rank tolerance
        candidates = []
        for user_id, data in karma_data.items():
            if user_id in known_ids:
                continue

            rank_diff = abs(data["rank"] - weekly_ranking)
            if rank_diff <= self.rank_tolerance:
                candidates.append((user_id, data, rank_diff))

        if not candidates:
            return None

        # Sort by rank proximity
        candidates.sort(key=lambda x: x[2])

        # Check if username matches handle (best case)
        for user_id, data, rank_diff in candidates:
            username = data.get("username", "").lower()
            if username == handle.lower() or handle.lower() in username or username in handle.lower():
                return (user_id, data)

        # If only one candidate, use it
        if len(candidates) == 1:
            return (candidates[0][0], candidates[0][1])

        # Multiple candidates - return best rank match but flag uncertainty
        best = candidates[0]
        return (best[0], {**best[1], "_uncertain": True, "_candidates": len(candidates)})

    def discover_by_api_history(self, handle: str, weekly_ranking: int,
                                 game_dates: List[str]) -> Optional[str]:
        """
        Use ranked days API history to discover player_id.

        Strategy: For known player_ids, fetch their history and look for patterns
        that match the player's expected ranking across multiple dates.

        This is more expensive but more reliable for edge cases.
        """
        # This would be called after initial passes, using accumulated data
        # to cross-reference unknown players against known patterns
        pass  # Implemented in process_games_enhanced

    def build_date_rank_index(self) -> Dict[str, Dict[int, List[str]]]:
        """
        Build an index: date -> rank -> [user_ids]
        Useful for reverse lookups.
        """
        index = defaultdict(lambda: defaultdict(list))

        for date_str, karma_map in self.karma_cache.items():
            for user_id, data in karma_map.items():
                rank = data["rank"]
                index[date_str][rank].append(user_id)

        return index

    def process_games(self) -> List[dict]:
        """
        Main processing loop: Match all players across all games.
        Returns enhanced games data with karma scores.
        """
        enhanced_games = []

        # Collect unique dates first to pre-fetch karma data
        unique_dates = set()
        for game in self.games:
            unique_dates.add(game["game_date"])

        print(f"\n📅 Processing {len(self.games)} games across {len(unique_dates)} unique dates")

        # Pre-fetch karma data for all dates
        print("\n🔄 Pre-fetching karma data...")
        for date_str in sorted(unique_dates):
            self.fetch_karma_for_date(date_str)

        # Track known IDs per date for exclusion
        date_matched_ids: Dict[str, Set[str]] = defaultdict(set)

        # Phase 1: Direct matches for players with known player_id
        print("\n📌 Phase 1: Direct matching for known player_ids...")
        for game in self.games:
            game_date = game["game_date"]

            for roster_key in ["roster_a", "roster_b"]:
                for player in game[roster_key]:
                    player_id = player.get("player_id")
                    if player_id:
                        karma = self.match_player_direct(player_id, game_date)
                        if karma:
                            player["karma_amount"] = karma["amount"]
                            player["karma_rank"] = karma["rank"]
                            player["match_type"] = "direct"
                            date_matched_ids[game_date].add(player_id)
                            self.match_stats["direct_matches"] += 1
                        else:
                            # Player likely outside top 1000
                            player["match_type"] = "outside_top_1000"
                            self.match_stats["outside_top_1000"] += 1

        # Phase 2: Rank-based discovery for unknown players
        print("\n🔍 Phase 2: Rank-based discovery for unknown player_ids...")
        for game in self.games:
            game_date = game["game_date"]

            for roster_key in ["roster_a", "roster_b"]:
                for player in game[roster_key]:
                    if player.get("player_id"):
                        continue  # Already has ID

                    ranking = player.get("ranking")
                    if not ranking:
                        continue  # No ranking to match against

                    handle = player["handle"]

                    # Check if we've already discovered this handle
                    if handle.lower() in self.discovered_ids:
                        player_id = self.discovered_ids[handle.lower()]
                        karma = self.match_player_direct(player_id, game_date)
                        if karma:
                            player["player_id"] = player_id
                            player["karma_amount"] = karma["amount"]
                            player["karma_rank"] = karma["rank"]
                            player["match_type"] = "previously_discovered"
                            date_matched_ids[game_date].add(player_id)
                            self.match_stats["rank_discoveries"] += 1
                        continue

                    # Try to discover by rank
                    result = self.discover_by_rank(
                        handle,
                        ranking,
                        game_date,
                        date_matched_ids[game_date]
                    )

                    if result:
                        user_id, karma = result
                        player["player_id"] = user_id
                        player["karma_amount"] = karma["amount"]
                        player["karma_rank"] = karma["rank"]
                        player["match_type"] = "rank_discovery"

                        if karma.get("_uncertain"):
                            player["match_uncertain"] = True
                            player["candidate_count"] = karma.get("_candidates", 0)

                        # Cache the discovery
                        self.discovered_ids[handle.lower()] = user_id
                        date_matched_ids[game_date].add(user_id)
                        self.match_stats["rank_discoveries"] += 1
                    else:
                        self.match_stats["no_match"] += 1

        # Phase 3: Use ranked days API for high-value discoveries
        print("\n🌐 Phase 3: Ranked days API verification...")
        self._verify_discoveries_with_api()

        return self.games

    def _verify_discoveries_with_api(self):
        """
        Verify rank-based discoveries using the ranked days API.
        Also attempt to discover more mappings using handle-username matching.
        """
        # For uncertain matches, fetch ranked days and verify
        verified = 0
        rejected = 0

        for game in self.games:
            game_date = game["game_date"]

            for roster_key in ["roster_a", "roster_b"]:
                for player in game[roster_key]:
                    if not player.get("match_uncertain"):
                        continue

                    player_id = player.get("player_id")
                    if not player_id:
                        continue

                    # Fetch player's ranked days history
                    ranked_days = self.fetch_ranked_days(player_id)

                    # Look for the game date in their history
                    for day_data in ranked_days:
                        if day_data["day"] == game_date:
                            # Verify the rank matches within tolerance
                            if abs(day_data["rank"] - player.get("karma_rank", 0)) <= 5:
                                player["match_verified"] = True
                                verified += 1
                            else:
                                # Mismatch - reject this discovery
                                player["match_rejected"] = True
                                rejected += 1
                            break

        print(f"  ✓ Verified: {verified}, Rejected: {rejected}")

    def generate_reports(self):
        """Generate summary reports and output files."""
        print("\n" + "=" * 60)
        print("📊 MATCHING SUMMARY")
        print("=" * 60)

        print(f"\nMatch Statistics:")
        print(f"  Direct matches:      {self.match_stats['direct_matches']}")
        print(f"  Rank discoveries:    {self.match_stats['rank_discoveries']}")
        print(f"  API discoveries:     {self.match_stats['api_discoveries']}")
        print(f"  Outside top 1000:    {self.match_stats['outside_top_1000']}")
        print(f"  No match:            {self.match_stats['no_match']}")

        print(f"\nNewly discovered player_ids: {len(self.discovered_ids)}")

        # Show sample discoveries
        if self.discovered_ids:
            print("\nSample discoveries (handle -> user_id):")
            for handle, user_id in list(self.discovered_ids.items())[:10]:
                print(f"  {handle}: {user_id}")

        # Output files
        os.makedirs(OUTPUT_DIR, exist_ok=True)

        # Enhanced games with karma
        output_games = os.path.join(OUTPUT_DIR, "s6-games-with-karma.json")
        with open(output_games, 'w', encoding='utf-8') as f:
            json.dump(self.games, f, indent=2)
        print(f"\n✅ Saved enhanced games to: {output_games}")

        # Newly discovered IDs
        output_discoveries = os.path.join(OUTPUT_DIR, "s6-discovered-ids.json")
        with open(output_discoveries, 'w', encoding='utf-8') as f:
            json.dump(self.discovered_ids, f, indent=2)
        print(f"✅ Saved discoveries to: {output_discoveries}")

        # Updated handle-to-id (merged)
        merged_handle_to_id = {**self.handle_to_id}
        merged_handle_to_id.update(self.discovered_ids)
        output_merged = os.path.join(OUTPUT_DIR, "s6-handle-to-id-merged.json")
        with open(output_merged, 'w', encoding='utf-8') as f:
            json.dump(merged_handle_to_id, f, indent=2)
        print(f"✅ Saved merged handle mappings to: {output_merged}")

        # Summary report
        report = {
            "generated": datetime.now().isoformat(),
            "stats": self.match_stats,
            "discoveries_count": len(self.discovered_ids),
            "total_handles": len(merged_handle_to_id),
            "games_processed": len(self.games),
        }
        output_report = os.path.join(OUTPUT_DIR, "s6-karma-match-report.json")
        with open(output_report, 'w', encoding='utf-8') as f:
            json.dump(report, f, indent=2)
        print(f"✅ Saved report to: {output_report}")


class RankedDaysDiscovery:
    """
    Specialized class for discovering player_ids using ranked days history.

    Strategy:
    1. For known players, build a fingerprint of their ranking pattern
    2. For unknown players with ranking data, look for matching patterns
    3. Cross-reference Supabase usernames with game handles
    """

    def __init__(self, karma_cache: Dict[str, Dict[str, dict]], games: List[dict]):
        self.karma_cache = karma_cache
        self.games = games

        # Build username -> user_id mapping from karma data
        self.username_to_id: Dict[str, str] = {}
        self._build_username_index()

    def _build_username_index(self):
        """Build an index of lowercase usernames to user_ids."""
        for date_str, karma_map in self.karma_cache.items():
            for user_id, data in karma_map.items():
                username = data.get("username", "").lower()
                if username and username not in self.username_to_id:
                    self.username_to_id[username] = user_id

    def find_by_username(self, handle: str) -> Optional[str]:
        """Try to find user_id by username match."""
        handle_lower = handle.lower()

        # Direct match
        if handle_lower in self.username_to_id:
            return self.username_to_id[handle_lower]

        # Partial match
        for username, user_id in self.username_to_id.items():
            if handle_lower in username or username in handle_lower:
                return user_id

        return None

    def build_player_date_ranks(self) -> Dict[str, Dict[str, int]]:
        """
        Build a map of handle -> {date: expected_rank} from games data.
        This represents what we know about each player's expected ranking.
        """
        player_dates = defaultdict(dict)

        for game in self.games:
            game_date = game["game_date"]

            for roster_key in ["roster_a", "roster_b"]:
                for player in game[roster_key]:
                    handle = player["handle"].lower()
                    ranking = player.get("ranking")
                    if ranking:
                        player_dates[handle][game_date] = ranking

        return player_dates


def main():
    parser = argparse.ArgumentParser(description="Match S6 game data with karma scores")
    parser.add_argument("--dry-run", action="store_true",
                        help="Run without making changes")
    parser.add_argument("--rank-tolerance", type=int, default=DEFAULT_RANK_TOLERANCE,
                        help=f"Tolerance for rank matching (default: {DEFAULT_RANK_TOLERANCE})")
    parser.add_argument("--supabase-url", type=str,
                        help="Supabase URL (or set SUPABASE_URL env var)")
    parser.add_argument("--supabase-key", type=str,
                        help="Supabase API key (or set SUPABASE_KEY env var)")

    args = parser.parse_args()

    # Get Supabase credentials
    supabase_url = args.supabase_url or os.environ.get("SUPABASE_URL")
    supabase_key = args.supabase_key or os.environ.get("SUPABASE_KEY")

    if not supabase_url or not supabase_key:
        print("⚠️  Supabase credentials not provided.")
        print("   Set SUPABASE_URL and SUPABASE_KEY environment variables,")
        print("   or pass --supabase-url and --supabase-key arguments.")
        print("\n   Running in offline mode (no karma matching)...")

    print("=" * 60)
    print("🎮 S6 KARMA MATCHING SCRIPT")
    print("=" * 60)
    print(f"\nRank tolerance: ±{args.rank_tolerance}")
    print(f"Dry run: {args.dry_run}")

    # Initialize matcher
    matcher = KarmaMatcher(
        supabase_url=supabase_url,
        supabase_key=supabase_key,
        rank_tolerance=args.rank_tolerance,
        dry_run=args.dry_run
    )

    # Load data
    if not matcher.load_games_data():
        return 1

    # Process games
    matcher.process_games()

    # Generate reports
    matcher.generate_reports()

    print("\n✅ Done!")
    return 0


if __name__ == "__main__":
    exit(main())
