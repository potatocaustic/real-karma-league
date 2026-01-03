#!/usr/bin/env python3
"""
S6 Season Reconstruction - Unified Module

This module provides the complete workflow for reconstructing Season 6 data:
1. Load games with player handles and rankings
2. Match players to Supabase karma data (direct + fuzzy)
3. Discover missing player_ids using multiple strategies
4. Output fully enhanced games with karma scores

Can be run standalone or imported as a module.

Example usage:
    from s6_reconstruction import S6Reconstructor

    reconstructor = S6Reconstructor(
        supabase_url="your-url",
        supabase_key="your-key"
    )
    reconstructor.run_full_pipeline()
"""

import json
import os
import time
import requests
from collections import defaultdict
from typing import Dict, List, Optional, Tuple, Set, Any
from dataclasses import dataclass, field
from datetime import datetime
from difflib import SequenceMatcher

try:
    from supabase import create_client, Client
    SUPABASE_AVAILABLE = True
except ImportError:
    SUPABASE_AVAILABLE = False
    print("⚠️  Install supabase: pip install supabase")


# Constants
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RANKED_DAYS_API = "https://api.real.vg/rankeddays"
KARMA_RANKS_API = "https://api.real.vg/userkarmaranks/day"


@dataclass
class PlayerMatch:
    """Represents a matched player with karma data."""
    handle: str
    player_id: Optional[str]
    ranking: Optional[int]  # Weekly ranking from CSV
    karma_amount: Optional[int] = None
    karma_rank: Optional[int] = None  # Daily rank from Supabase
    match_method: str = "none"
    confidence: str = "none"
    evidence: str = ""


@dataclass
class MatchStats:
    """Statistics for the matching process."""
    direct_matches: int = 0
    username_matches: int = 0
    rank_discoveries: int = 0
    api_discoveries: int = 0
    outside_top_1000: int = 0
    no_match: int = 0

    def to_dict(self) -> dict:
        return {
            "direct_matches": self.direct_matches,
            "username_matches": self.username_matches,
            "rank_discoveries": self.rank_discoveries,
            "api_discoveries": self.api_discoveries,
            "outside_top_1000": self.outside_top_1000,
            "no_match": self.no_match,
        }


class S6Reconstructor:
    """
    Main class for Season 6 data reconstruction.

    Workflow:
    1. Load games data (s6-games-enhanced.json)
    2. Load existing handle-to-id mappings
    3. Fetch karma data from Supabase for all game dates
    4. Phase 1: Direct match known player_ids to karma
    5. Phase 2: Discover unknown player_ids via username matching
    6. Phase 3: Discover via rank pattern matching
    7. Phase 4: Verify uncertain matches via ranked days API
    8. Output enhanced data with karma scores
    """

    def __init__(self,
                 supabase_url: str = None,
                 supabase_key: str = None,
                 rank_tolerance: int = 50,
                 data_dir: str = None):
        """
        Initialize the reconstructor.

        Args:
            supabase_url: Supabase project URL
            supabase_key: Supabase API key (anon or service role)
            rank_tolerance: Tolerance for rank-based matching (±ranks)
            data_dir: Directory containing data files (default: script directory)
        """
        self.data_dir = data_dir or SCRIPT_DIR
        self.output_dir = os.path.join(self.data_dir, "output")
        self.rank_tolerance = rank_tolerance
        self.stats = MatchStats()

        # Initialize Supabase
        self.supabase: Optional[Client] = None
        if supabase_url and supabase_key and SUPABASE_AVAILABLE:
            try:
                self.supabase = create_client(supabase_url, supabase_key)
                print("✅ Connected to Supabase")
            except Exception as e:
                print(f"❌ Supabase connection failed: {e}")

        # Data containers
        self.games: List[dict] = []
        self.handle_to_id: Dict[str, str] = {}
        self.discovered_ids: Dict[str, dict] = {}  # handle -> {user_id, confidence, method}

        # Caches
        self.karma_cache: Dict[str, Dict[str, dict]] = {}  # date -> user_id -> {amount, rank, username}
        self.username_to_id: Dict[str, Set[str]] = defaultdict(set)  # username -> set of user_ids
        self.ranked_days_cache: Dict[str, List[dict]] = {}  # user_id -> [{day, karma, rank}]

    def load_data(self,
                  games_file: str = "s6-games-enhanced.json",
                  handle_to_id_file: str = "s6-handle-to-id.json") -> bool:
        """Load games data and existing mappings."""
        games_path = os.path.join(self.data_dir, games_file)
        handle_path = os.path.join(self.data_dir, handle_to_id_file)

        try:
            with open(games_path, 'r', encoding='utf-8') as f:
                self.games = json.load(f)
            print(f"✅ Loaded {len(self.games)} games from {games_file}")
        except FileNotFoundError:
            print(f"❌ Games file not found: {games_path}")
            return False

        if os.path.exists(handle_path):
            with open(handle_path, 'r', encoding='utf-8') as f:
                self.handle_to_id = json.load(f)
            print(f"✅ Loaded {len(self.handle_to_id)} handle mappings")

        return True

    def fetch_karma_for_date(self, date_str: str) -> Dict[str, dict]:
        """
        Fetch all karma rankings for a date from Supabase.
        Returns: user_id -> {amount, rank, username}
        """
        if date_str in self.karma_cache:
            return self.karma_cache[date_str]

        if not self.supabase:
            return {}

        try:
            response = self.supabase.table("karma_rankings") \
                .select("user_id, username, amount, rank") \
                .eq("scrape_date", date_str) \
                .execute()

            karma_map = {}
            for entry in response.data:
                user_id = entry["user_id"]
                username = entry.get("username", "").lower().strip()

                karma_map[user_id] = {
                    "amount": entry["amount"],
                    "rank": entry["rank"],
                    "username": entry.get("username", "")
                }

                # Build username index
                if username:
                    self.username_to_id[username].add(user_id)

            self.karma_cache[date_str] = karma_map
            return karma_map

        except Exception as e:
            print(f"❌ Error fetching karma for {date_str}: {e}")
            return {}

    def prefetch_karma_data(self):
        """Pre-fetch karma data for all game dates."""
        dates = set(game["game_date"] for game in self.games)
        print(f"\n📅 Pre-fetching karma data for {len(dates)} dates...")

        for i, date_str in enumerate(sorted(dates)):
            data = self.fetch_karma_for_date(date_str)
            print(f"  [{i+1}/{len(dates)}] {date_str}: {len(data)} entries")

    def match_direct(self, player_id: str, game_date: str) -> Optional[dict]:
        """Direct match: Look up player_id in karma data."""
        karma = self.karma_cache.get(game_date, {})
        return karma.get(player_id)

    def discover_by_username(self, handle: str) -> Optional[Tuple[str, str]]:
        """
        Find user_id by username matching.
        Returns: (user_id, confidence) or None
        """
        handle_lower = handle.lower()

        # Exact match
        if handle_lower in self.username_to_id:
            ids = self.username_to_id[handle_lower]
            if len(ids) == 1:
                return (list(ids)[0], "high")

        # Fuzzy match
        best_match = None
        best_ratio = 0.0

        for username, ids in self.username_to_id.items():
            if len(ids) > 1:
                continue

            ratio = SequenceMatcher(None, handle_lower, username).ratio()
            if ratio > 0.85 and ratio > best_ratio:
                best_ratio = ratio
                best_match = list(ids)[0]

        if best_match:
            confidence = "high" if best_ratio > 0.95 else ("medium" if best_ratio > 0.9 else "low")
            return (best_match, confidence)

        return None

    def discover_by_rank(self, handle: str, weekly_ranking: int, game_date: str,
                         excluded_ids: Set[str]) -> Optional[Tuple[str, dict]]:
        """
        Find user_id by rank proximity.
        Returns: (user_id, karma_data) or None
        """
        karma = self.karma_cache.get(game_date, {})
        candidates = []

        for user_id, data in karma.items():
            if user_id in excluded_ids:
                continue

            rank_diff = abs(data["rank"] - weekly_ranking)
            if rank_diff <= self.rank_tolerance:
                candidates.append((user_id, data, rank_diff))

        if not candidates:
            return None

        # Sort by rank proximity
        candidates.sort(key=lambda x: x[2])

        # Prefer username match
        for user_id, data, rank_diff in candidates:
            username = data.get("username", "").lower()
            if username == handle.lower():
                return (user_id, data)

        # Single candidate
        if len(candidates) == 1:
            return (candidates[0][0], candidates[0][1])

        # Best match with uncertainty flag
        best = candidates[0]
        return (best[0], {**best[1], "_uncertain": True, "_candidates": len(candidates)})

    def fetch_ranked_days(self, user_id: str, limit_date: str = "2025-03-01") -> List[dict]:
        """Fetch ranked days history for a player."""
        if user_id in self.ranked_days_cache:
            return self.ranked_days_cache[user_id]

        all_data = []
        oldest = None

        while True:
            url = f"{RANKED_DAYS_API}/{user_id}?sort=latest"
            if oldest:
                url += f"&before={oldest}"

            try:
                resp = requests.get(url, timeout=30)
                resp.raise_for_status()
                days = resp.json().get('days', [])

                if not days:
                    break

                all_data.extend(days)
                oldest = days[-1]['day']

                if oldest < limit_date:
                    break

                time.sleep(0.5)

            except Exception:
                break

        self.ranked_days_cache[user_id] = all_data
        return all_data

    def process_phase1_direct(self):
        """Phase 1: Direct matching for known player_ids."""
        print("\n📌 Phase 1: Direct matching...")

        matched_per_date: Dict[str, Set[str]] = defaultdict(set)

        for game in self.games:
            game_date = game["game_date"]

            for roster_key in ["roster_a", "roster_b"]:
                for player in game[roster_key]:
                    player_id = player.get("player_id")
                    if not player_id:
                        continue

                    karma = self.match_direct(player_id, game_date)
                    if karma:
                        player["karma_amount"] = karma["amount"]
                        player["karma_rank"] = karma["rank"]
                        player["match_method"] = "direct"
                        matched_per_date[game_date].add(player_id)
                        self.stats.direct_matches += 1
                    else:
                        player["match_method"] = "outside_top_1000"
                        self.stats.outside_top_1000 += 1

        print(f"  Direct matches: {self.stats.direct_matches}")
        return matched_per_date

    def process_phase2_username(self):
        """Phase 2: Username-based discovery."""
        print("\n🔤 Phase 2: Username matching...")

        for game in self.games:
            for roster_key in ["roster_a", "roster_b"]:
                for player in game[roster_key]:
                    if player.get("player_id"):
                        continue

                    handle = player["handle"]
                    result = self.discover_by_username(handle)

                    if result:
                        user_id, confidence = result
                        player["player_id"] = user_id
                        player["match_method"] = "username"
                        player["match_confidence"] = confidence

                        self.discovered_ids[handle.lower()] = {
                            "user_id": user_id,
                            "confidence": confidence,
                            "method": "username"
                        }
                        self.stats.username_matches += 1

        print(f"  Username matches: {self.stats.username_matches}")

    def process_phase3_rank(self, matched_per_date: Dict[str, Set[str]]):
        """Phase 3: Rank-based discovery."""
        print("\n📊 Phase 3: Rank-based discovery...")

        for game in self.games:
            game_date = game["game_date"]
            excluded = matched_per_date[game_date]

            for roster_key in ["roster_a", "roster_b"]:
                for player in game[roster_key]:
                    if player.get("player_id"):
                        continue

                    ranking = player.get("ranking")
                    if not ranking:
                        continue

                    handle = player["handle"]

                    # Check if already discovered
                    if handle.lower() in self.discovered_ids:
                        user_id = self.discovered_ids[handle.lower()]["user_id"]
                        karma = self.match_direct(user_id, game_date)
                        if karma:
                            player["player_id"] = user_id
                            player["karma_amount"] = karma["amount"]
                            player["karma_rank"] = karma["rank"]
                            player["match_method"] = "previously_discovered"
                            excluded.add(user_id)
                        continue

                    result = self.discover_by_rank(handle, ranking, game_date, excluded)
                    if result:
                        user_id, karma = result
                        player["player_id"] = user_id
                        player["karma_amount"] = karma["amount"]
                        player["karma_rank"] = karma["rank"]
                        player["match_method"] = "rank_discovery"

                        if karma.get("_uncertain"):
                            player["match_uncertain"] = True

                        self.discovered_ids[handle.lower()] = {
                            "user_id": user_id,
                            "confidence": "low" if karma.get("_uncertain") else "medium",
                            "method": "rank"
                        }
                        excluded.add(user_id)
                        self.stats.rank_discoveries += 1
                    else:
                        self.stats.no_match += 1

        print(f"  Rank discoveries: {self.stats.rank_discoveries}")

    def process_phase4_verify(self):
        """Phase 4: Verify uncertain matches using ranked days API."""
        print("\n🌐 Phase 4: API verification...")

        verified = 0
        for game in self.games:
            game_date = game["game_date"]

            for roster_key in ["roster_a", "roster_b"]:
                for player in game[roster_key]:
                    if not player.get("match_uncertain"):
                        continue

                    user_id = player.get("player_id")
                    if not user_id:
                        continue

                    ranked_days = self.fetch_ranked_days(user_id)
                    for day in ranked_days:
                        if day["day"] == game_date:
                            if abs(day["rank"] - player.get("karma_rank", 0)) <= 5:
                                player["match_verified"] = True
                                verified += 1
                            break

        print(f"  Verified: {verified}")

    def run_full_pipeline(self) -> List[dict]:
        """Run the complete reconstruction pipeline."""
        print("\n" + "=" * 60)
        print("🎮 S6 SEASON RECONSTRUCTION")
        print("=" * 60)

        # Pre-fetch data
        self.prefetch_karma_data()

        # Run phases
        matched_per_date = self.process_phase1_direct()
        self.process_phase2_username()
        self.process_phase3_rank(matched_per_date)
        self.process_phase4_verify()

        # Summary
        self._print_summary()

        return self.games

    def _print_summary(self):
        """Print matching summary."""
        print("\n" + "=" * 60)
        print("📊 RECONSTRUCTION SUMMARY")
        print("=" * 60)
        print(f"\nMatching Statistics:")
        for key, value in self.stats.to_dict().items():
            print(f"  {key}: {value}")
        print(f"\nNewly discovered IDs: {len(self.discovered_ids)}")

    def save_results(self):
        """Save all output files."""
        os.makedirs(self.output_dir, exist_ok=True)

        # Enhanced games
        games_file = os.path.join(self.output_dir, "s6-games-with-karma.json")
        with open(games_file, 'w', encoding='utf-8') as f:
            json.dump(self.games, f, indent=2)
        print(f"✅ Saved: {games_file}")

        # Discoveries
        discoveries_file = os.path.join(self.output_dir, "s6-discoveries.json")
        with open(discoveries_file, 'w', encoding='utf-8') as f:
            json.dump(self.discovered_ids, f, indent=2)
        print(f"✅ Saved: {discoveries_file}")

        # Merged handle-to-id
        merged = {**self.handle_to_id}
        for handle, data in self.discovered_ids.items():
            merged[handle] = data["user_id"]
        merged_file = os.path.join(self.output_dir, "s6-handle-to-id-complete.json")
        with open(merged_file, 'w', encoding='utf-8') as f:
            json.dump(merged, f, indent=2)
        print(f"✅ Saved: {merged_file}")

        # Report
        report = {
            "generated": datetime.now().isoformat(),
            "stats": self.stats.to_dict(),
            "discoveries_count": len(self.discovered_ids),
            "total_handles": len(merged),
        }
        report_file = os.path.join(self.output_dir, "s6-reconstruction-report.json")
        with open(report_file, 'w', encoding='utf-8') as f:
            json.dump(report, f, indent=2)
        print(f"✅ Saved: {report_file}")


def main():
    """CLI entry point."""
    import argparse

    parser = argparse.ArgumentParser(description="Reconstruct S6 season data")
    parser.add_argument("--supabase-url", help="Supabase URL (or SUPABASE_URL env var)")
    parser.add_argument("--supabase-key", help="Supabase key (or SUPABASE_KEY env var)")
    parser.add_argument("--rank-tolerance", type=int, default=50)
    parser.add_argument("--games-file", default="s6-games-enhanced.json")
    parser.add_argument("--handle-map", default="s6-handle-to-id.json")

    args = parser.parse_args()

    url = args.supabase_url or os.environ.get("SUPABASE_URL")
    key = args.supabase_key or os.environ.get("SUPABASE_KEY")

    if not url or not key:
        print("❌ Supabase credentials required.")
        print("   Set SUPABASE_URL and SUPABASE_KEY environment variables.")
        return 1

    reconstructor = S6Reconstructor(
        supabase_url=url,
        supabase_key=key,
        rank_tolerance=args.rank_tolerance
    )

    if not reconstructor.load_data(args.games_file, args.handle_map):
        return 1

    reconstructor.run_full_pipeline()
    reconstructor.save_results()

    print("\n✅ Reconstruction complete!")
    return 0


if __name__ == "__main__":
    exit(main())
