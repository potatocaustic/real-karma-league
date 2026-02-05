#!/usr/bin/env python3
"""
Player ID Discovery Module

Uses multiple data sources to discover player_ids for unknown players:
1. Supabase username matching (karma_rankings table)
2. Multi-date rank pattern matching
3. Ranked days API for verification and discovery

This is a companion to match-s6-karma.py - run this after the initial matching
to fill in remaining gaps.

Usage:
    python discover-player-ids.py --season 6
"""

import json
import os
import time
import uuid
import argparse
import requests
from collections import defaultdict
from typing import Dict, List, Optional, Set, Tuple
from difflib import SequenceMatcher

try:
    from supabase import create_client, Client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False
try:
    from hashids import Hashids
    HASHIDS_AVAILABLE = True
except ImportError:
    HASHIDS_AVAILABLE = False
    print("⚠️  Hashids not installed. Run: pip install hashids")


# Configuration
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "output")
REAL_API_BASE = "https://web.realsports.io"
REAL_VERSION = "27"
RANKED_DAYS_API = f"{REAL_API_BASE}/rankeddays"
REQUEST_DELAY = 0.5

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


class PlayerDiscovery:
    """
    Discovers player_ids for handles without mappings using multiple strategies.
    """

    def __init__(self, supabase_url: str = None, supabase_key: str = None):
        self.supabase: Optional[Client] = None
        if supabase_url and supabase_key and SUPABASE_AVAILABLE:
            try:
                self.supabase = create_client(supabase_url, supabase_key)
                print("✅ Connected to Supabase")
            except Exception as e:
                print(f"❌ Supabase connection failed: {e}")

        # Data
        self.games: List[dict] = []
        self.existing_mappings: Dict[str, str] = {}  # handle -> player_id

        # Caches
        self.karma_by_date: Dict[str, List[dict]] = {}  # date -> [{user_id, username, rank, amount}]
        self.ranked_days_cache: Dict[str, List[dict]] = {}  # user_id -> [{day, karma, rank}]

        # Discovery results
        self.discoveries: Dict[str, dict] = {}  # handle -> {user_id, confidence, method, evidence}

    def load_data(self, games_file: str, handle_to_id_file: str = None):
        """Load games and existing mappings."""
        with open(games_file, 'r', encoding='utf-8') as f:
            self.games = json.load(f)
        print(f"✅ Loaded {len(self.games)} games")

        if handle_to_id_file and os.path.exists(handle_to_id_file):
            with open(handle_to_id_file, 'r', encoding='utf-8') as f:
                self.existing_mappings = json.load(f)
            print(f"✅ Loaded {len(self.existing_mappings)} existing mappings")

    def fetch_all_karma_data(self):
        """Fetch karma data for all game dates."""
        if not self.supabase:
            return

        dates = set(game["game_date"] for game in self.games)
        print(f"\n📅 Fetching karma data for {len(dates)} dates...")

        for date_str in sorted(dates):
            try:
                response = self.supabase.table("karma_rankings") \
                    .select("user_id, username, amount, rank") \
                    .eq("scrape_date", date_str) \
                    .order("rank") \
                    .execute()

                self.karma_by_date[date_str] = response.data
                print(f"  {date_str}: {len(response.data)} entries")

            except Exception as e:
                print(f"  ❌ Error fetching {date_str}: {e}")

    def build_player_profiles(self) -> Dict[str, dict]:
        """
        Build profiles for unknown players based on game appearances.
        Returns: handle -> {dates: [date], rankings: {date: rank}, game_count: n}
        """
        profiles = defaultdict(lambda: {"dates": [], "rankings": {}, "game_count": 0})

        for game in self.games:
            game_date = game["game_date"]

            for roster_key in ["roster_a", "roster_b"]:
                for player in game[roster_key]:
                    handle = player["handle"].lower()

                    # Skip if already known
                    if handle in self.existing_mappings:
                        continue
                    if player.get("player_id"):
                        continue

                    profiles[handle]["dates"].append(game_date)
                    profiles[handle]["game_count"] += 1

                    ranking = player.get("ranking")
                    if ranking:
                        profiles[handle]["rankings"][game_date] = ranking

        return dict(profiles)

    def strategy_username_match(self) -> Dict[str, dict]:
        """
        Strategy 1: Match handles to Supabase usernames.
        Uses fuzzy matching to account for variations.
        """
        print("\n🔤 Strategy 1: Username matching...")
        discoveries = {}

        # Build username -> user_id index from all karma data
        username_index: Dict[str, Set[str]] = defaultdict(set)  # lowercase username -> set of user_ids

        for date_str, entries in self.karma_by_date.items():
            for entry in entries:
                username = entry.get("username", "").lower().strip()
                if username:
                    username_index[username].add(entry["user_id"])

        print(f"  Built index with {len(username_index)} unique usernames")

        # Get profiles of unknown players
        profiles = self.build_player_profiles()

        for handle, profile in profiles.items():
            handle_lower = handle.lower()

            # Direct match
            if handle_lower in username_index:
                user_ids = username_index[handle_lower]
                if len(user_ids) == 1:
                    user_id = list(user_ids)[0]
                    discoveries[handle] = {
                        "user_id": user_id,
                        "confidence": "high",
                        "method": "username_exact",
                        "evidence": f"Exact username match: {handle_lower}"
                    }
                    continue

            # Fuzzy match
            best_match = None
            best_ratio = 0

            for username, user_ids in username_index.items():
                if len(user_ids) > 1:
                    continue  # Skip ambiguous usernames

                ratio = SequenceMatcher(None, handle_lower, username).ratio()
                if ratio > 0.85 and ratio > best_ratio:
                    best_ratio = ratio
                    best_match = (username, list(user_ids)[0])

            if best_match:
                discoveries[handle] = {
                    "user_id": best_match[1],
                    "confidence": "medium" if best_ratio > 0.9 else "low",
                    "method": "username_fuzzy",
                    "evidence": f"Fuzzy match: {handle_lower} ≈ {best_match[0]} ({best_ratio:.2f})"
                }

        print(f"  Found {len(discoveries)} matches via username")
        return discoveries

    def strategy_rank_pattern(self) -> Dict[str, dict]:
        """
        Strategy 2: Match players by rank patterns across multiple dates.
        If a player appears in N games with rankings, find user_ids with matching rank patterns.
        """
        print("\n📊 Strategy 2: Rank pattern matching...")
        discoveries = {}

        profiles = self.build_player_profiles()

        # Focus on players with rankings on multiple dates
        for handle, profile in profiles.items():
            if handle in discoveries:
                continue

            rankings = profile["rankings"]
            if len(rankings) < 2:
                continue  # Need at least 2 dates for pattern matching

            # Find candidate user_ids that appear on all dates
            date_candidates: Dict[str, Set[str]] = {}

            for date_str, expected_rank in rankings.items():
                if date_str not in self.karma_by_date:
                    continue

                # Find entries close to expected rank
                candidates = set()
                for entry in self.karma_by_date[date_str]:
                    rank_diff = abs(entry["rank"] - expected_rank)
                    if rank_diff <= 30:  # Tighter tolerance for pattern matching
                        candidates.add(entry["user_id"])

                date_candidates[date_str] = candidates

            if not date_candidates:
                continue

            # Find intersection of all date candidates
            common_candidates = set.intersection(*date_candidates.values())

            if len(common_candidates) == 1:
                user_id = list(common_candidates)[0]
                discoveries[handle] = {
                    "user_id": user_id,
                    "confidence": "high",
                    "method": "rank_pattern",
                    "evidence": f"Matched rank pattern across {len(rankings)} dates"
                }
            elif len(common_candidates) > 1:
                # Score candidates by total rank deviation
                best_candidate = None
                best_score = float('inf')

                for candidate in common_candidates:
                    total_deviation = 0
                    for date_str, expected_rank in rankings.items():
                        for entry in self.karma_by_date.get(date_str, []):
                            if entry["user_id"] == candidate:
                                total_deviation += abs(entry["rank"] - expected_rank)
                                break

                    if total_deviation < best_score:
                        best_score = total_deviation
                        best_candidate = candidate

                if best_candidate:
                    discoveries[handle] = {
                        "user_id": best_candidate,
                        "confidence": "medium",
                        "method": "rank_pattern",
                        "evidence": f"Best rank pattern match across {len(rankings)} dates (deviation: {best_score})"
                    }

        print(f"  Found {len(discoveries)} matches via rank patterns")
        return discoveries

    def strategy_ranked_days_api(self, candidates: Dict[str, List[str]]) -> Dict[str, dict]:
        """
        Strategy 3: Use ranked days API to verify candidates.

        Args:
            candidates: handle -> [potential user_ids]
        """
        print("\n🌐 Strategy 3: Ranked days API verification...")
        discoveries = {}

        for handle, user_ids in candidates.items():
            if not user_ids:
                continue

            profiles = self.build_player_profiles()
            if handle not in profiles:
                continue

            expected_rankings = profiles[handle]["rankings"]
            if not expected_rankings:
                continue

            best_match = None
            best_score = float('inf')

            for user_id in user_ids[:5]:  # Limit API calls
                # Fetch ranked days for this user
                ranked_days = self._fetch_ranked_days(user_id)
                if not ranked_days:
                    continue

                # Build date -> rank map
                user_ranks = {d["day"]: d["rank"] for d in ranked_days}

                # Score: sum of rank deviations on matching dates
                score = 0
                matches = 0
                for date_str, expected_rank in expected_rankings.items():
                    if date_str in user_ranks:
                        score += abs(user_ranks[date_str] - expected_rank)
                        matches += 1

                if matches > 0 and score / matches < 30:  # Average deviation < 30
                    avg_deviation = score / matches
                    if avg_deviation < best_score:
                        best_score = avg_deviation
                        best_match = user_id

            if best_match:
                discoveries[handle] = {
                    "user_id": best_match,
                    "confidence": "high" if best_score < 10 else "medium",
                    "method": "ranked_days_api",
                    "evidence": f"Verified via ranked days API (avg deviation: {best_score:.1f})"
                }

        print(f"  Found {len(discoveries)} matches via API verification")
        return discoveries

    def _fetch_ranked_days(self, user_id: str) -> List[dict]:
        """Fetch ranked days for a user with caching."""
        if user_id in self.ranked_days_cache:
            return self.ranked_days_cache[user_id]

        all_data = []
        oldest_date = None

        while True:
            url = f"{RANKED_DAYS_API}/{user_id}?sort=latest"
            if oldest_date:
                url += f"&before={oldest_date}"

            try:
                response = requests.get(url, headers=build_real_headers(), timeout=30)
                response.raise_for_status()
                data = response.json()

                days = data.get('days', [])
                if not days:
                    break

                all_data.extend(days)
                oldest_date = days[-1]['day']

                # Limit to recent history (S6 season)
                if oldest_date < "2025-03-01":
                    break

                time.sleep(REQUEST_DELAY)

            except Exception:
                break

        self.ranked_days_cache[user_id] = all_data
        return all_data

    def run_all_strategies(self):
        """Run all discovery strategies and merge results."""
        print("\n" + "=" * 60)
        print("🔍 PLAYER ID DISCOVERY")
        print("=" * 60)

        # Fetch karma data first
        self.fetch_all_karma_data()

        # Run strategies
        username_discoveries = self.strategy_username_match()
        self.discoveries.update(username_discoveries)

        # Exclude already discovered handles
        rank_discoveries = self.strategy_rank_pattern()
        for handle, result in rank_discoveries.items():
            if handle not in self.discoveries:
                self.discoveries[handle] = result

        # Collect remaining candidates for API verification
        remaining_candidates = {}
        profiles = self.build_player_profiles()
        for handle, profile in profiles.items():
            if handle in self.discoveries:
                continue
            if handle in self.existing_mappings:
                continue

            # Collect candidates from rank proximity
            candidates = set()
            for date_str, expected_rank in profile["rankings"].items():
                if date_str in self.karma_by_date:
                    for entry in self.karma_by_date[date_str]:
                        if abs(entry["rank"] - expected_rank) <= 50:
                            candidates.add(entry["user_id"])

            if candidates:
                remaining_candidates[handle] = list(candidates)

        # Run API verification on remaining candidates
        api_discoveries = self.strategy_ranked_days_api(remaining_candidates)
        for handle, result in api_discoveries.items():
            if handle not in self.discoveries:
                self.discoveries[handle] = result

    def save_results(self):
        """Save discovery results."""
        os.makedirs(OUTPUT_DIR, exist_ok=True)

        # Full discoveries with metadata
        discoveries_file = os.path.join(OUTPUT_DIR, "s6-player-discoveries.json")
        with open(discoveries_file, 'w', encoding='utf-8') as f:
            json.dump(self.discoveries, f, indent=2)
        print(f"\n✅ Saved discoveries to: {discoveries_file}")

        # Simple handle -> user_id mapping
        simple_map = {h: d["user_id"] for h, d in self.discoveries.items()}
        simple_file = os.path.join(OUTPUT_DIR, "s6-discovered-handles.json")
        with open(simple_file, 'w', encoding='utf-8') as f:
            json.dump(simple_map, f, indent=2)
        print(f"✅ Saved simple mapping to: {simple_file}")

        # Merged with existing mappings
        merged = {**self.existing_mappings, **simple_map}
        merged_file = os.path.join(OUTPUT_DIR, "s6-handle-to-id-complete.json")
        with open(merged_file, 'w', encoding='utf-8') as f:
            json.dump(merged, f, indent=2)
        print(f"✅ Saved complete mapping to: {merged_file}")

        # Summary
        print(f"\n📊 Discovery Summary:")
        print(f"  Previous mappings: {len(self.existing_mappings)}")
        print(f"  New discoveries: {len(self.discoveries)}")
        print(f"  Total mapped: {len(merged)}")

        by_method = defaultdict(int)
        by_confidence = defaultdict(int)
        for d in self.discoveries.values():
            by_method[d["method"]] += 1
            by_confidence[d["confidence"]] += 1

        print(f"\n  By method:")
        for method, count in by_method.items():
            print(f"    {method}: {count}")

        print(f"\n  By confidence:")
        for conf, count in by_confidence.items():
            print(f"    {conf}: {count}")


def main():
    parser = argparse.ArgumentParser(description="Discover player IDs using multiple strategies")
    parser.add_argument("--games-file", type=str,
                        default=os.path.join(SCRIPT_DIR, "s6-games-enhanced.json"),
                        help="Path to games file")
    parser.add_argument("--handle-map", type=str,
                        default=os.path.join(SCRIPT_DIR, "s6-handle-to-id.json"),
                        help="Path to existing handle-to-id mapping")
    parser.add_argument("--supabase-url", type=str,
                        help="Supabase URL (or set SUPABASE_URL env var)")
    parser.add_argument("--supabase-key", type=str,
                        help="Supabase API key (or set SUPABASE_KEY env var)")

    args = parser.parse_args()

    supabase_url = args.supabase_url or os.environ.get("SUPABASE_URL")
    supabase_key = args.supabase_key or os.environ.get("SUPABASE_KEY")

    if not supabase_url or not supabase_key:
        print("⚠️  Supabase credentials required for discovery.")
        print("   Set SUPABASE_URL and SUPABASE_KEY environment variables.")
        return 1

    discoverer = PlayerDiscovery(supabase_url, supabase_key)
    discoverer.load_data(args.games_file, args.handle_map)
    discoverer.run_all_strategies()
    discoverer.save_results()

    print("\n✅ Discovery complete!")
    return 0


if __name__ == "__main__":
    exit(main())
