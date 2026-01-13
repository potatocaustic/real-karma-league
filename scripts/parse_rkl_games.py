#!/usr/bin/env python3
"""
RKL Game Parser - Automated extraction of game data from RealApp comments SQL dump.

This script parses the rkl_comments.sql file and extracts:
- Game lineups (teams, players, captains)
- Game results (scores, winners)
- Individual player stats (score, rank) when available
- Links results to their corresponding lineups

Filters OUT:
- Exhibition tournaments (2v2, 3v3, 4v4 tourneys, march madness)
- All-Star games, Rising Stars games, GM games
- Leaderboard posts, rankings posts

Usage:
    python parse_rkl_games.py [--sql-path ../rkl_comments.sql] [--output-dir ./output]
"""

import re
import json
import csv
import argparse
from datetime import datetime, timedelta
from pathlib import Path
from dataclasses import dataclass, field, asdict
from typing import Optional
from collections import defaultdict
from zoneinfo import ZoneInfo

EASTERN = ZoneInfo("America/New_York")

# ============================================================================
# REGEX PATTERNS (adapted from app.py with enhancements)
# ============================================================================

# Core patterns
MENTION_RE = re.compile(r"@([A-Za-z0-9._]+)")
VS_ANY_RE = re.compile(r"\bvs\.?\b", re.IGNORECASE)
STANDALONE_VS_RE = re.compile(r"^\s*vs\.?\s*$", re.IGNORECASE)

# Score patterns
SCORE_NUM_RE = re.compile(r"\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\b|\b\d{4,6}(?:\.\d+)?\b")
SCORE_EXTRACT_RE = re.compile(r"([\d,]+(?:\.\d+)?)")

# Team patterns
TEAM_RECORD_RE = re.compile(r"^(.+?)\s*\(\d+-\d+(?:-\d+)?\)")
# Result line patterns - support optional separator between record and score
RESULT_LINE_RE = re.compile(r"^(.+?)\s*\(\d+-\d+(?:-\d+)?\)\s*[-–]?\s*[\d,]+\s*[✅❌]", re.UNICODE)
RESULT_FULL_RE = re.compile(
    r"^\s*(?:\((\d+)\)\s*|(\d+)\.\s*)?(.+?)\s*\((\d+)-(\d+)(?:-\d+)?\)\s*[-–:]?\s*([\d,]+(?:\.\d+)?)\s*(.*)$",
    re.UNICODE
)
LEADERBOARD_LINE_RE = re.compile(r"^\d+\.\s*(.+?)\s*\(\d+-\d+(?:-\d+)?\)\s*[-–]\s*[\d,]+", re.UNICODE)

# Content detection
TOP_SCORES_RE = re.compile(r"top\s+team\s+scores", re.IGNORECASE)
MEDIAN_RE = re.compile(r"\bmedian\b", re.IGNORECASE)
WINLOSS_MARK_RE = re.compile(r"[✅❌🏆]|:check_mark_button|:cross_mark")
LINEUPS_WORD_RE = re.compile(r"\blineups?\b", re.IGNORECASE)
RECORD_PATTERN_RE = re.compile(r"\(\d+-\d+(?:-\d+)?\)")
GOTD_RE = re.compile(r"\bGOTD\b", re.IGNORECASE)
SEPARATOR_RE = re.compile(r"^[-–—~]{3,}$")

# Captain detection
CAPTAIN_EXPLICIT_RE = re.compile(r"@([A-Za-z0-9._]+)\s*\([cC]\)")
CAPTAIN_PLAIN_C_RE = re.compile(r"@([A-Za-z0-9._]+)\s+[cC](?:\s|$)")
MENTION_WITH_TRAIL_RE = re.compile(r"@([A-Za-z0-9._]+)(.*?)(?=@[A-Za-z0-9._]+|$)", re.DOTALL)
REALAPP_EMOJI_RE = re.compile(r":[a-z_0-9]+")

# Postseason patterns
ROUND_NAME_RE = re.compile(
    r"(RKL\s+Finals?|Finals?|Semi\s*-?\s*Finals?|Quarter\s*-?\s*Finals?|"
    r"Round\s+\d+|Playoffs?\s+Round\s+\d+|Wild\s*Card|Game\s+\d+)",
    re.IGNORECASE
)
SEED_TEAM_RE = re.compile(r"^\s*(?:\((\d+)\)|(\d+)\.?\s+)(.+?)(?:\s*\(\d+-\d+\))?\s*$")

# Win/loss detection - includes (W)/(L) text markers
WIN_INDICATOR_RE = re.compile(r"(✅+|:check_mark_button|🏆|\(W\))")
LOSS_INDICATOR_RE = re.compile(r"(❌|:cross_mark|\(L\))")

# Adjustment patterns
ADJUSTMENT_LINE_RE = re.compile(r"^\s*([A-Za-z][A-Za-z0-9\s]+?)\s+([+-]?\d[\d,]*(?:\.\d+)?)\s*$")
ADJUSTMENT_HEADER_RE = re.compile(r"(advent\s+deduction|deduction|adjustment|penalty|bonus)", re.IGNORECASE)

# Individual player stats: @handle (score, rankth) or @handle (score*1.5, rankth)
PLAYER_STATS_RE = re.compile(
    r"@([A-Za-z0-9._]+)\s*\((\d{1,3}(?:,\d{3})*(?:\.\d+)?)"
    r"(?:\*1\.5)?\s*,?\s*(\d+)(?:st|nd|rd|th)?\)?",
    re.IGNORECASE
)

# Alternative player stats: @handle (rankth) only
PLAYER_RANK_ONLY_RE = re.compile(
    r"@([A-Za-z0-9._]+)\s*\((\d+)(?:st|nd|rd|th)\)",
    re.IGNORECASE
)

# ============================================================================
# EXHIBITION/TOURNAMENT FILTERS
# ============================================================================

# Primary exhibition patterns - always filter these
EXHIBITION_PRIMARY = [
    re.compile(r"\b2v2\b", re.IGNORECASE),
    re.compile(r"\b3v3\b", re.IGNORECASE),
    re.compile(r"\b4v4\b", re.IGNORECASE),
    re.compile(r"\b1v1\b", re.IGNORECASE),
    re.compile(r"\bmarch\s*madness\b", re.IGNORECASE),
    re.compile(r"\ball[\s-]*star\s*game\b", re.IGNORECASE),
    re.compile(r"\brising\s*stars?\s*game\b", re.IGNORECASE),
    re.compile(r"\bgm\s*game\b", re.IGNORECASE),
    re.compile(r"\bexhibition\b", re.IGNORECASE),
]

# Secondary patterns - only filter if combined with "tourney" or "tournament"
EXHIBITION_CONTEXT_REQUIRED = [
    re.compile(r"\b(?:sweet\s*16|elite\s*8|final\s*four)\b", re.IGNORECASE),
    re.compile(r"\bround\s*of\s*(?:64|32|16|8)\b", re.IGNORECASE),
]

TOURNEY_WORD_RE = re.compile(r"\btourne?y|tournament\b", re.IGNORECASE)

def is_exhibition(text: str) -> bool:
    """Check if text indicates an exhibition/tournament game to be excluded."""
    if not text:
        return False

    # Primary patterns - always exclude
    for pattern in EXHIBITION_PRIMARY:
        if pattern.search(text):
            return True

    # Secondary patterns - only exclude if "tourney" or "tournament" also present
    if TOURNEY_WORD_RE.search(text):
        for pattern in EXHIBITION_CONTEXT_REQUIRED:
            if pattern.search(text):
                return True

    return False


# ============================================================================
# DATA CLASSES
# ============================================================================

@dataclass
class PlayerStat:
    """Individual player statistics from a game result."""
    handle: str
    score: Optional[float] = None
    rank: Optional[int] = None
    is_captain: bool = False
    team: str = ""  # "A" or "B"


@dataclass
class GameLineup:
    """A game lineup extracted from a comment."""
    comment_id: int
    thread_id: int
    created_at: str
    game_date: str
    team_a: str
    team_b: str
    captain_a: Optional[str] = None
    captain_b: Optional[str] = None
    players_a: list = field(default_factory=list)
    players_b: list = field(default_factory=list)
    seed_a: Optional[str] = None
    seed_b: Optional[str] = None
    round_name: Optional[str] = None
    is_postseason: bool = False
    raw_text: str = ""


@dataclass
class GameResult:
    """A game result with scores."""
    comment_id: int
    thread_id: int
    created_at: str
    game_date: str
    team_a: str
    team_b: str
    score_a: Optional[float] = None
    score_b: Optional[float] = None
    winner: Optional[str] = None  # "A" or "B"
    adjustment_a: Optional[float] = None
    adjustment_b: Optional[float] = None
    player_stats: list = field(default_factory=list)
    seed_a: Optional[str] = None
    seed_b: Optional[str] = None
    round_name: Optional[str] = None
    is_postseason: bool = False
    linked_lineup_id: Optional[int] = None
    raw_text: str = ""


@dataclass
class CompleteGame:
    """A complete game with lineup and result data combined."""
    game_id: int
    game_date: str
    game_type: str  # "regular", "postseason"
    team_a: str
    team_b: str
    captain_a: Optional[str] = None
    captain_b: Optional[str] = None
    players_a: list = field(default_factory=list)
    players_b: list = field(default_factory=list)
    score_a: Optional[float] = None
    score_b: Optional[float] = None
    winner: Optional[str] = None
    adjustment_a: Optional[float] = None
    adjustment_b: Optional[float] = None
    player_stats: list = field(default_factory=list)
    seed_a: Optional[str] = None
    seed_b: Optional[str] = None
    round_name: Optional[str] = None
    lineup_comment_id: Optional[int] = None
    result_comment_id: Optional[int] = None
    lineup_thread_id: Optional[int] = None
    result_thread_id: Optional[int] = None


# ============================================================================
# SQL PARSING
# ============================================================================

class CommentRecord:
    """Represents a parsed comment record from SQL."""
    def __init__(self, comment_id: int, group_id: int, source: str, created_at_ts: str,
                 reply_count: int, depth: int, parent_comment_id: Optional[int],
                 thread_root_id: int, plain_text: str):
        self.comment_id = comment_id
        self.group_id = group_id
        self.source = source
        self.created_at_ts = created_at_ts
        self.reply_count = reply_count
        self.depth = depth
        self.parent_comment_id = parent_comment_id
        self.thread_root_id = thread_root_id
        self.plain_text = plain_text


def parse_sql_dump(sql_path: Path, progress_callback=None) -> list[CommentRecord]:
    """Parse the PostgreSQL dump and extract comment records."""
    comments = []

    # Pattern to match INSERT statements
    insert_pattern = re.compile(
        r"INSERT INTO rkl_comments.*?VALUES\s*\("
        r"(\d+),"           # comment_id
        r"(\d+),"           # group_id
        r"'([^']*)',"       # source
        r"'([^']*)',"       # created_at_ts
        r"'[^']*',"         # created_at_text (skip)
        r"([^,]*),"         # pin_priority
        r"(\d+|NULL),"      # reply_count
        r"(\d+),"           # depth
        r"(\d+|NULL),"      # parent_comment_id
        r"(\d+|NULL),"      # replying_to_comment_id (skip)
        r"(\d+|NULL),"      # reply_num (skip)
        r"(\d+|NULL),"      # user_id (skip)
        r"(\d+),"           # thread_root_id
        r"'((?:[^']|'')*)'", # plain_text (handle escaped quotes)
        re.DOTALL
    )

    print(f"Reading SQL dump from {sql_path}...")

    with open(sql_path, 'r', encoding='utf-8') as f:
        content = f.read()

    print(f"Parsing {len(content):,} bytes...")

    # Find all INSERT statements
    matches = insert_pattern.findall(content)

    for i, m in enumerate(matches):
        if progress_callback and i % 10000 == 0:
            progress_callback(i, len(matches))

        try:
            comment_id = int(m[0])
            group_id = int(m[1])
            source = m[2]
            created_at_ts = m[3]
            reply_count = int(m[5]) if m[5] != 'NULL' else 0
            depth = int(m[6])
            parent_comment_id = int(m[7]) if m[7] != 'NULL' else None
            thread_root_id = int(m[11])
            plain_text = m[12].replace("''", "'")  # Unescape SQL quotes

            comments.append(CommentRecord(
                comment_id=comment_id,
                group_id=group_id,
                source=source,
                created_at_ts=created_at_ts,
                reply_count=reply_count,
                depth=depth,
                parent_comment_id=parent_comment_id,
                thread_root_id=thread_root_id,
                plain_text=plain_text
            ))
        except (ValueError, IndexError) as e:
            continue  # Skip malformed records

    print(f"Parsed {len(comments):,} comments")
    return comments


# ============================================================================
# TEXT PARSING UTILITIES
# ============================================================================

def parse_timestamp_to_date(ts_str: str) -> Optional[str]:
    """Parse timestamp string and convert to YYYY-MM-DD in Eastern time."""
    if not ts_str:
        return None
    try:
        dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00").replace(" ", "T"))
        dt_eastern = dt.astimezone(EASTERN)
        return dt_eastern.date().isoformat()
    except Exception:
        return None


def parse_score(score_str: str) -> Optional[float]:
    """Parse a score string like '34,565' to float."""
    if not score_str:
        return None
    try:
        return float(score_str.replace(",", ""))
    except ValueError:
        return None


def clean_team_name(name: str) -> str:
    """Clean up a team name."""
    if not name:
        return ""
    name = name.strip()
    name = re.sub(r"^\s*(?:\(\d+\)\s*|\d+\.\s*|\d+\s+)", "", name)
    name = re.sub(r"\s*\(\d+-\d+(?:-\d+)?\)\s*$", "", name)
    name = re.sub(r"\s*[-–]\s*[\d,]+\s*[✅❌]?\s*$", "", name)
    name = re.sub(r"^\d+\.\s*", "", name)
    name = name.strip(" \t\n-–:•~")
    return name[:80] if name else ""


def is_captain_marker(text_after: str) -> bool:
    """Check if text following a mention indicates captain status."""
    if not text_after:
        return False
    text = text_after.strip()
    if re.match(r"^\s*\([cC]\)", text):
        return True
    if re.match(r"^\s*[cC](?:\s|$)", text):
        return True
    until_next = re.split(r"[@\n]", text)[0]
    if until_next.strip():
        cleaned = REALAPP_EMOJI_RE.sub("", until_next).strip()
        if not cleaned or not any(c.isalnum() for c in cleaned):
            return True
    return False


# ============================================================================
# CONTENT TYPE DETECTION
# ============================================================================

def detect_content_type(text: str) -> str:
    """Detect if text is a lineup, result, leaderboard, or other."""
    if not text:
        return "other"

    # Check for leaderboard first
    if TOP_SCORES_RE.search(text) or MEDIAN_RE.search(text):
        return "leaderboard"

    # Count key indicators
    has_winloss = WINLOSS_MARK_RE.search(text)
    has_scores = SCORE_NUM_RE.search(text)
    has_records = RECORD_PATTERN_RE.search(text)
    has_separator = bool(re.search(r"^[-–—~]{3,}$", text, re.MULTILINE))
    record_count = len(RECORD_PATTERN_RE.findall(text))
    mention_count = len(MENTION_RE.findall(text))
    has_vs = VS_ANY_RE.search(text)
    has_gotd = GOTD_RE.search(text)
    has_lineups_word = LINEUPS_WORD_RE.search(text)

    # Result detection - need win/loss markers OR team records with scores
    if has_winloss and has_scores:
        return "result"
    # Two team records with large scores (not lineup mentions) = result
    if record_count >= 2 and has_scores:
        # Check for large scores (team scores are typically 30000+)
        large_scores = re.findall(r"\b\d{2},\d{3}\b|\b[3-9]\d{4}\b", text)
        if large_scores:
            return "result"
    if has_records and has_separator and has_scores:
        return "result"

    # Lineup detection - GOTD posts or lineup threads with multiple mentions
    # GOTD posts are lineups even without explicit "vs" word
    if has_gotd and mention_count >= 4:
        return "lineup"

    # Standard lineup detection
    if has_vs and mention_count >= 2:
        return "lineup"

    # Posts with "Lineups" in header and mentions
    if has_lineups_word and mention_count >= 2:
        return "lineup"

    # Posts with team records and multiple mentions (likely lineup)
    if has_records and mention_count >= 4 and has_separator:
        return "lineup"

    # Postseason lineups
    if ROUND_NAME_RE.search(text) and mention_count >= 2 and (has_vs or has_separator):
        return "lineup"

    # If we have many mentions with separators, likely a lineup
    if mention_count >= 6 and has_separator:
        return "lineup"

    return "other"


# ============================================================================
# LINEUP EXTRACTION
# ============================================================================

def extract_mentions_by_team(text: str) -> tuple[list[str], list[str]]:
    """Split mentions into Team A and Team B based on vs divider."""
    if not text:
        return ([], [])

    lines = text.splitlines()

    # Strategy 1: Find standalone vs line (common in GOTD posts)
    vs_line_idx = None
    for i, ln in enumerate(lines):
        ln_stripped = ln.strip()
        # Check for standalone "vs" or "vs." or lines with only separators + vs
        if STANDALONE_VS_RE.match(ln_stripped):
            vs_line_idx = i
            break
        # Also check for vs surrounded by separator characters
        if re.match(r"^[-–—~]*\s*vs\.?\s*[-–—~]*$", ln_stripped, re.IGNORECASE):
            vs_line_idx = i
            break

    if vs_line_idx is not None:
        text_before = "\n".join(lines[:vs_line_idx])
        text_after = "\n".join(lines[vs_line_idx + 1:])
        mentions_a = MENTION_RE.findall(text_before)
        mentions_b = MENTION_RE.findall(text_after)
        if mentions_a or mentions_b:
            return (mentions_a, mentions_b)

    # Strategy 2: Look for separator lines (------) as team dividers
    separator_indices = [i for i, ln in enumerate(lines) if SEPARATOR_RE.match(ln.strip())]
    if len(separator_indices) >= 2:
        # Take the middle separator as divider
        mid_idx = separator_indices[len(separator_indices) // 2]
        text_before = "\n".join(lines[:mid_idx])
        text_after = "\n".join(lines[mid_idx + 1:])
        mentions_a = MENTION_RE.findall(text_before)
        mentions_b = MENTION_RE.findall(text_after)
        if mentions_a and mentions_b:
            return (mentions_a, mentions_b)

    # Strategy 3: Look for team name patterns as dividers
    # Pattern: "TeamName (W-L)" on its own line
    team_header_indices = []
    for i, ln in enumerate(lines):
        ln_stripped = ln.strip()
        # Skip lines that are mentions
        if ln_stripped.startswith("@"):
            continue
        # Check for team name with record
        if TEAM_RECORD_RE.match(ln_stripped):
            team_header_indices.append(i)

    if len(team_header_indices) >= 2:
        # Split between first and second team header
        first_team_idx = team_header_indices[0]
        second_team_idx = team_header_indices[1]
        text_before = "\n".join(lines[first_team_idx:second_team_idx])
        text_after = "\n".join(lines[second_team_idx:])
        mentions_a = MENTION_RE.findall(text_before)
        mentions_b = MENTION_RE.findall(text_after)
        if mentions_a or mentions_b:
            return (mentions_a, mentions_b)

    # Strategy 4: Inline vs split
    for ln in lines:
        if VS_ANY_RE.search(ln):
            parts = re.split(r"\bvs\.?\b", ln, maxsplit=1, flags=re.IGNORECASE)
            if len(parts) == 2:
                mentions_a = MENTION_RE.findall(parts[0])
                mentions_b = MENTION_RE.findall(parts[1])
                if mentions_a or mentions_b:
                    return (mentions_a, mentions_b)

    return ([], [])


def detect_captains(text: str) -> tuple[Optional[str], Optional[str], list[str]]:
    """Detect captain candidates from text."""
    if not text:
        return (None, None, [])

    lines = text.splitlines()

    explicit = CAPTAIN_EXPLICIT_RE.findall(text)
    plain_c = CAPTAIN_PLAIN_C_RE.findall(text)

    implicit = []
    for m in MENTION_WITH_TRAIL_RE.finditer(text):
        username = m.group(1)
        trailing = m.group(2)
        if username not in explicit and username not in plain_c and is_captain_marker(trailing):
            implicit.append(username)

    all_candidates = list(dict.fromkeys(explicit + plain_c + implicit))

    # Try to assign to teams by vs split
    vs_line_idx = None
    for i, ln in enumerate(lines):
        if STANDALONE_VS_RE.match(ln):
            vs_line_idx = i
            break

    captain_a, captain_b = None, None

    if vs_line_idx is not None:
        text_before = "\n".join(lines[:vs_line_idx])
        text_after = "\n".join(lines[vs_line_idx + 1:])

        for cap in all_candidates:
            pattern = rf"@{re.escape(cap)}"
            if re.search(pattern, text_before) and captain_a is None:
                captain_a = cap
            elif re.search(pattern, text_after) and captain_b is None:
                captain_b = cap
    else:
        if len(all_candidates) >= 1:
            captain_a = all_candidates[0]
        if len(all_candidates) >= 2:
            captain_b = all_candidates[1]

    return (captain_a, captain_b, all_candidates)


def guess_teams(text: str) -> tuple[Optional[str], Optional[str]]:
    """Extract team names from text."""
    if not text:
        return (None, None)

    lines = text.splitlines()

    # Strategy 1: Result format - "Team (W-L) - score ✅"
    result_teams = []
    for ln in lines:
        m = RESULT_LINE_RE.match(ln.strip())
        if m:
            team = clean_team_name(m.group(1))
            if team:
                result_teams.append(team)
        if len(result_teams) >= 2:
            break
    if len(result_teams) >= 2:
        return (result_teams[0], result_teams[1])

    # Strategy 2: Team record format - "Team (W-L)" on its own line
    # Common in GOTD posts
    team_record_teams = []
    for ln in lines:
        ln_stripped = ln.strip()
        # Skip lines that start with @, are separators, or are too long
        if ln_stripped.startswith("@") or SEPARATOR_RE.match(ln_stripped) or len(ln_stripped) > 50:
            continue
        m = TEAM_RECORD_RE.match(ln_stripped)
        if m:
            team = clean_team_name(m.group(1))
            if team and len(team) > 1:
                team_record_teams.append(team)
        if len(team_record_teams) >= 2:
            break
    if len(team_record_teams) >= 2:
        return (team_record_teams[0], team_record_teams[1])

    # Strategy 3: Leaderboard format
    lb_teams = []
    for ln in lines:
        m = LEADERBOARD_LINE_RE.match(ln.strip())
        if m:
            team = clean_team_name(m.group(1))
            if team:
                lb_teams.append(team)
        if len(lb_teams) >= 2:
            break
    if len(lb_teams) >= 2:
        return (lb_teams[0], lb_teams[1])

    # Strategy 4: Multi-line with vs or separator divider
    # Find the divider line
    divider_idx = None
    for i, ln in enumerate(lines):
        ln_stripped = ln.strip()
        if STANDALONE_VS_RE.match(ln_stripped):
            divider_idx = i
            break
        # Also check for vs surrounded by separators
        if re.match(r"^[-–—~]*\s*vs\.?\s*[-–—~]*$", ln_stripped, re.IGNORECASE):
            divider_idx = i
            break

    # If no vs found, look for separator pattern (separators around "vs" or between teams)
    if divider_idx is None:
        separator_indices = [i for i, ln in enumerate(lines) if SEPARATOR_RE.match(ln.strip())]
        if len(separator_indices) >= 2:
            # Use middle separator as divider
            divider_idx = separator_indices[len(separator_indices) // 2]

    if divider_idx is not None:
        team_a, team_b = None, None

        # Search backward for team A
        for i in range(divider_idx - 1, max(0, divider_idx - 15) - 1, -1):
            ln = lines[i].strip()
            if not ln or ln.startswith("@"):
                continue
            if SEPARATOR_RE.match(ln):
                continue
            m = TEAM_RECORD_RE.match(ln)
            if m:
                team_a = clean_team_name(m.group(1))
                break
            elif len(ln) < 50:
                team_a = clean_team_name(ln)
                break

        # Search forward for team B
        for i in range(divider_idx + 1, min(len(lines), divider_idx + 15)):
            ln = lines[i].strip()
            if not ln or ln.startswith("@"):
                continue
            if SEPARATOR_RE.match(ln):
                continue
            m = TEAM_RECORD_RE.match(ln)
            if m:
                team_b = clean_team_name(m.group(1))
                break
            elif len(ln) < 50:
                team_b = clean_team_name(ln)
                break

        if team_a or team_b:
            return (team_a, team_b)

    return (None, None)


def detect_postseason_info(text: str) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """Detect postseason round name and seeds."""
    if not text:
        return (None, None, None)

    lines = text.splitlines()
    round_name = None
    seed_a, seed_b = None, None

    for ln in lines[:5]:
        m = ROUND_NAME_RE.search(ln.strip())
        if m:
            round_name = ln.strip()
            break

    vs_line_idx = None
    for i, ln in enumerate(lines):
        if STANDALONE_VS_RE.match(ln):
            vs_line_idx = i
            break

    if vs_line_idx is not None:
        for i in range(vs_line_idx - 1, max(0, vs_line_idx - 10) - 1, -1):
            ln = lines[i].strip()
            if ln.startswith("@"):
                continue
            m = SEED_TEAM_RE.match(ln)
            if m:
                seed_a = m.group(1) or m.group(2)
                break

        for i in range(vs_line_idx + 1, min(len(lines), vs_line_idx + 10)):
            ln = lines[i].strip()
            if ln.startswith("@"):
                continue
            m = SEED_TEAM_RE.match(ln)
            if m:
                seed_b = m.group(1) or m.group(2)
                break

    return (round_name, seed_a, seed_b)


def extract_lineup(comment: CommentRecord, thread_text: str = "") -> Optional[GameLineup]:
    """Extract lineup data from a comment."""
    text = comment.plain_text
    if not text:
        return None

    # Skip exhibition games
    combined = (thread_text or "") + "\n" + text
    if is_exhibition(combined):
        return None

    content_type = detect_content_type(text)
    if content_type != "lineup":
        return None

    team_a, team_b = guess_teams(combined)
    if not team_a and not team_b:
        return None

    players_a, players_b = extract_mentions_by_team(text)
    if not players_a and not players_b:
        return None

    captain_a, captain_b, _ = detect_captains(text)
    round_name, seed_a, seed_b = detect_postseason_info(text)
    game_date = parse_timestamp_to_date(comment.created_at_ts)

    return GameLineup(
        comment_id=comment.comment_id,
        thread_id=comment.thread_root_id,
        created_at=comment.created_at_ts,
        game_date=game_date or "",
        team_a=team_a or "",
        team_b=team_b or "",
        captain_a=captain_a,
        captain_b=captain_b,
        players_a=players_a,
        players_b=players_b,
        seed_a=seed_a,
        seed_b=seed_b,
        round_name=round_name,
        is_postseason=bool(round_name or seed_a or seed_b),
        raw_text=text
    )


# ============================================================================
# RESULT EXTRACTION
# ============================================================================

def detect_winner(line: str) -> Optional[str]:
    """Detect if a line indicates a win or loss."""
    if WIN_INDICATOR_RE.search(line):
        return "win"
    if LOSS_INDICATOR_RE.search(line):
        return "loss"
    return None


def parse_result_line(line: str) -> Optional[dict]:
    """Parse a single result line."""
    line = line.strip()
    if not line:
        return None

    m = RESULT_FULL_RE.match(line)
    if m:
        seed = m.group(1) or m.group(2)
        team = m.group(3).strip()
        team = re.sub(r"^\d+\.\s*", "", team).strip()
        record_w = int(m.group(4))
        record_l = int(m.group(5))
        score_str = m.group(6)
        trailing = m.group(7) or ""

        return {
            "team": team,
            "record_w": record_w,
            "record_l": record_l,
            "score": parse_score(score_str),
            "seed": seed,
            "winner": detect_winner(trailing),
        }
    return None


def extract_player_stats(text: str, team_a: str, team_b: str) -> list[PlayerStat]:
    """Extract individual player statistics from result text."""
    stats = []

    # Try full stats pattern: @handle (score, rankth)
    for m in PLAYER_STATS_RE.finditer(text):
        handle = m.group(1)
        score = parse_score(m.group(2))
        rank = int(m.group(3))
        stats.append(PlayerStat(
            handle=handle,
            score=score,
            rank=rank,
            is_captain="*1.5" in m.group(0) or "(c)" in text[max(0, m.start()-10):m.end()+5].lower()
        ))

    # Try rank-only pattern: @handle (rankth)
    for m in PLAYER_RANK_ONLY_RE.finditer(text):
        handle = m.group(1)
        rank = int(m.group(2))
        # Skip if already captured with full stats
        if not any(s.handle == handle for s in stats):
            stats.append(PlayerStat(
                handle=handle,
                score=None,
                rank=rank,
                is_captain=False
            ))

    return stats


def extract_game_result_data(text: str) -> Optional[dict]:
    """Extract game result data from text."""
    if not text:
        return None

    lines = text.splitlines()
    result_lines = []
    adjustments = []
    in_adj_section = False
    round_name = None

    for ln in lines:
        ln_stripped = ln.strip()

        if len(result_lines) == 0 and not round_name:
            m = ROUND_NAME_RE.search(ln_stripped)
            if m:
                round_name = ln_stripped
                continue

        if SEPARATOR_RE.match(ln_stripped):
            continue

        if ADJUSTMENT_HEADER_RE.search(ln_stripped):
            in_adj_section = True
            continue

        parsed = parse_result_line(ln_stripped)
        if parsed:
            result_lines.append(parsed)
            continue

        if in_adj_section or len(result_lines) >= 2:
            adj_m = ADJUSTMENT_LINE_RE.match(ln_stripped)
            if adj_m:
                team = adj_m.group(1).strip()
                adj_str = adj_m.group(2).replace(",", "")
                try:
                    adjustments.append({"team": team, "adjustment": float(adj_str)})
                except ValueError:
                    pass

    if len(result_lines) < 2:
        return None

    team_a_data = result_lines[0]
    team_b_data = result_lines[1]

    # Determine winner
    winner = None
    if team_a_data.get("winner") == "win":
        winner = "A"
    elif team_b_data.get("winner") == "win":
        winner = "B"
    elif team_a_data.get("winner") == "loss":
        winner = "B"
    elif team_b_data.get("winner") == "loss":
        winner = "A"
    elif team_a_data.get("score") and team_b_data.get("score"):
        if team_a_data["score"] > team_b_data["score"]:
            winner = "A"
        elif team_b_data["score"] > team_a_data["score"]:
            winner = "B"

    # Match adjustments
    adj_a, adj_b = None, None
    ta_lower = team_a_data["team"].lower()
    tb_lower = team_b_data["team"].lower()

    for adj in adjustments:
        adj_team = adj["team"].lower()
        if adj_team in ta_lower or ta_lower in adj_team:
            adj_a = adj["adjustment"]
        elif adj_team in tb_lower or tb_lower in adj_team:
            adj_b = adj["adjustment"]

    return {
        "team_a": team_a_data["team"],
        "team_b": team_b_data["team"],
        "score_a": team_a_data.get("score"),
        "score_b": team_b_data.get("score"),
        "seed_a": team_a_data.get("seed"),
        "seed_b": team_b_data.get("seed"),
        "winner": winner,
        "adjustment_a": adj_a,
        "adjustment_b": adj_b,
        "round_name": round_name,
    }


def extract_result(comment: CommentRecord, thread_text: str = "") -> Optional[GameResult]:
    """Extract result data from a comment."""
    text = comment.plain_text
    if not text:
        return None

    combined = (thread_text or "") + "\n" + text
    if is_exhibition(combined):
        return None

    content_type = detect_content_type(text)
    if content_type != "result":
        return None

    result_data = extract_game_result_data(text)
    if not result_data:
        return None

    team_a = result_data["team_a"]
    team_b = result_data["team_b"]

    player_stats = extract_player_stats(text, team_a, team_b)
    game_date = parse_timestamp_to_date(comment.created_at_ts)

    return GameResult(
        comment_id=comment.comment_id,
        thread_id=comment.thread_root_id,
        created_at=comment.created_at_ts,
        game_date=game_date or "",
        team_a=team_a,
        team_b=team_b,
        score_a=result_data.get("score_a"),
        score_b=result_data.get("score_b"),
        winner=result_data.get("winner"),
        adjustment_a=result_data.get("adjustment_a"),
        adjustment_b=result_data.get("adjustment_b"),
        player_stats=[asdict(s) for s in player_stats],
        seed_a=result_data.get("seed_a"),
        seed_b=result_data.get("seed_b"),
        round_name=result_data.get("round_name"),
        is_postseason=bool(result_data.get("round_name") or result_data.get("seed_a")),
        raw_text=text
    )


# ============================================================================
# LINEUP-RESULT LINKING
# ============================================================================

def normalize_team_name(name: str) -> str:
    """Normalize team name for matching."""
    return name.lower().strip() if name else ""


def teams_match(lineup_a: str, lineup_b: str, result_a: str, result_b: str) -> bool:
    """Check if teams match (in either order)."""
    la = normalize_team_name(lineup_a)
    lb = normalize_team_name(lineup_b)
    ra = normalize_team_name(result_a)
    rb = normalize_team_name(result_b)

    # Exact match either order
    if (la == ra and lb == rb) or (la == rb and lb == ra):
        return True

    # Fuzzy match - check if names contain each other
    def fuzzy(s1: str, s2: str) -> bool:
        if not s1 or not s2:
            return False
        return s1 in s2 or s2 in s1

    return (fuzzy(la, ra) and fuzzy(lb, rb)) or (fuzzy(la, rb) and fuzzy(lb, ra))


def fuzzy_team_match(name1: str, name2: str) -> bool:
    """Check if two team names match with fuzzy logic."""
    n1 = normalize_team_name(name1)
    n2 = normalize_team_name(name2)
    if not n1 or not n2:
        return False
    # Exact match
    if n1 == n2:
        return True
    # Substring match (one contains the other)
    if n1 in n2 or n2 in n1:
        return True
    # Common team name abbreviations/variations
    # E.g., "MLB" might be stored as "mlb" or "M.L.B."
    n1_clean = re.sub(r"[^a-z0-9]", "", n1)
    n2_clean = re.sub(r"[^a-z0-9]", "", n2)
    if n1_clean == n2_clean:
        return True
    return False


def link_results_to_lineups(lineups: list[GameLineup], results: list[GameResult]) -> list[CompleteGame]:
    """Link results to their corresponding lineups and create complete games."""
    games = []
    used_lineup_ids = set()
    game_id = 1

    # Index lineups by date for faster lookup
    lineups_by_date = defaultdict(list)
    for lu in lineups:
        lineups_by_date[lu.game_date].append(lu)

    # Also index by team names for broader matching
    lineups_by_teams = defaultdict(list)
    for lu in lineups:
        key_a = normalize_team_name(lu.team_a)
        key_b = normalize_team_name(lu.team_b)
        if key_a and key_b:
            # Store in canonical order
            team_key = tuple(sorted([key_a, key_b]))
            lineups_by_teams[team_key].append(lu)

    for result in results:
        # Find matching lineup with expanded date range (same day, 1-3 days before)
        potential_dates = [result.game_date]
        if result.game_date:
            try:
                d = datetime.fromisoformat(result.game_date)
                for days_back in range(1, 4):
                    potential_dates.append((d - timedelta(days=days_back)).isoformat())
            except:
                pass

        matched_lineup = None
        best_match_score = 0

        # Strategy 1: Match by date + team names
        for date in potential_dates:
            for lu in lineups_by_date.get(date, []):
                if lu.comment_id in used_lineup_ids:
                    continue
                if teams_match(lu.team_a, lu.team_b, result.team_a, result.team_b):
                    matched_lineup = lu
                    break
            if matched_lineup:
                break

        # Strategy 2: If no date match, try team name matching across all lineups
        if not matched_lineup:
            result_team_key = tuple(sorted([
                normalize_team_name(result.team_a),
                normalize_team_name(result.team_b)
            ]))

            # Look for lineups with same teams, prioritize by date proximity
            candidate_lineups = lineups_by_teams.get(result_team_key, [])

            if not candidate_lineups:
                # Try fuzzy team matching
                for team_key, lus in lineups_by_teams.items():
                    if (fuzzy_team_match(team_key[0], result_team_key[0]) and
                        fuzzy_team_match(team_key[1], result_team_key[1])):
                        candidate_lineups.extend(lus)
                    elif (fuzzy_team_match(team_key[0], result_team_key[1]) and
                          fuzzy_team_match(team_key[1], result_team_key[0])):
                        candidate_lineups.extend(lus)

            for lu in candidate_lineups:
                if lu.comment_id in used_lineup_ids:
                    continue
                # Check date proximity (within 7 days)
                if lu.game_date and result.game_date:
                    try:
                        lu_date = datetime.fromisoformat(lu.game_date)
                        res_date = datetime.fromisoformat(result.game_date)
                        days_diff = abs((res_date - lu_date).days)
                        if days_diff <= 7:
                            matched_lineup = lu
                            break
                    except:
                        pass

        if matched_lineup:
            used_lineup_ids.add(matched_lineup.comment_id)

            # Determine if teams are in same order or swapped
            la_norm = normalize_team_name(matched_lineup.team_a)
            ra_norm = normalize_team_name(result.team_a)
            teams_swapped = la_norm != ra_norm and (la_norm in normalize_team_name(result.team_b) or
                                                     normalize_team_name(result.team_b) in la_norm)

            game = CompleteGame(
                game_id=game_id,
                game_date=matched_lineup.game_date,
                game_type="postseason" if matched_lineup.is_postseason else "regular",
                team_a=matched_lineup.team_a,
                team_b=matched_lineup.team_b,
                captain_a=matched_lineup.captain_a if not teams_swapped else matched_lineup.captain_b,
                captain_b=matched_lineup.captain_b if not teams_swapped else matched_lineup.captain_a,
                players_a=matched_lineup.players_a if not teams_swapped else matched_lineup.players_b,
                players_b=matched_lineup.players_b if not teams_swapped else matched_lineup.players_a,
                score_a=result.score_a if not teams_swapped else result.score_b,
                score_b=result.score_b if not teams_swapped else result.score_a,
                winner=result.winner if not teams_swapped else ("B" if result.winner == "A" else "A" if result.winner == "B" else None),
                adjustment_a=result.adjustment_a if not teams_swapped else result.adjustment_b,
                adjustment_b=result.adjustment_b if not teams_swapped else result.adjustment_a,
                player_stats=result.player_stats,
                seed_a=matched_lineup.seed_a if not teams_swapped else matched_lineup.seed_b,
                seed_b=matched_lineup.seed_b if not teams_swapped else matched_lineup.seed_a,
                round_name=matched_lineup.round_name or result.round_name,
                lineup_comment_id=matched_lineup.comment_id,
                result_comment_id=result.comment_id,
                lineup_thread_id=matched_lineup.thread_id,
                result_thread_id=result.thread_id,
            )
        else:
            # Result without matching lineup - create game from result only
            game = CompleteGame(
                game_id=game_id,
                game_date=result.game_date,
                game_type="postseason" if result.is_postseason else "regular",
                team_a=result.team_a,
                team_b=result.team_b,
                score_a=result.score_a,
                score_b=result.score_b,
                winner=result.winner,
                adjustment_a=result.adjustment_a,
                adjustment_b=result.adjustment_b,
                player_stats=result.player_stats,
                seed_a=result.seed_a,
                seed_b=result.seed_b,
                round_name=result.round_name,
                result_comment_id=result.comment_id,
                result_thread_id=result.thread_id,
            )

        games.append(game)
        game_id += 1

    # Add unmatched lineups as games without results
    for lu in lineups:
        if lu.comment_id not in used_lineup_ids:
            game = CompleteGame(
                game_id=game_id,
                game_date=lu.game_date,
                game_type="postseason" if lu.is_postseason else "regular",
                team_a=lu.team_a,
                team_b=lu.team_b,
                captain_a=lu.captain_a,
                captain_b=lu.captain_b,
                players_a=lu.players_a,
                players_b=lu.players_b,
                seed_a=lu.seed_a,
                seed_b=lu.seed_b,
                round_name=lu.round_name,
                lineup_comment_id=lu.comment_id,
                lineup_thread_id=lu.thread_id,
            )
            games.append(game)
            game_id += 1

    return games


# ============================================================================
# MAIN PARSING PIPELINE
# ============================================================================

@dataclass
class SingleTeamResult:
    """A single team's result from an individual post."""
    comment_id: int
    created_at: str
    game_date: str
    team: str
    score: float
    wins: int
    losses: int
    is_winner: Optional[bool] = None  # True if this game was a win


# Pattern for single-team result posts
SINGLE_TEAM_RESULT_PATTERNS = [
    # "Voyage (1-7) - 49,743" or "Voyage (1-7) - 49,743 ✅"
    re.compile(r"^\s*([A-Za-z][A-Za-z\s]*?)\s*\((\d+)-(\d+)\)\s*[-–:]\s*([\d,]+(?:\.\d+)?)\s*([✅❌]|\(W\)|\(L\))?\s*$", re.UNICODE),
    # "Gravediggers (2-0) 35,479 ✅" (no separator between record and score)
    re.compile(r"^\s*([A-Za-z][A-Za-z\s]*?)\s*\((\d+)-(\d+)\)\s+([\d,]+(?:\.\d+)?)\s*([✅❌]|\(W\)|\(L\))?\s*$", re.UNICODE),
    # "outlaws(2-4): 47,202"
    re.compile(r"^\s*([A-Za-z][A-Za-z\s]*?)\s*\((\d+)-(\d+)\)\s*:\s*([\d,]+(?:\.\d+)?)\s*([✅❌]|\(W\)|\(L\))?\s*$", re.UNICODE),
    # "Empire: 32,943 (0-1)"
    re.compile(r"^\s*([A-Za-z][A-Za-z\s]*?):\s*([\d,]+(?:\.\d+)?)\s*\((\d+)-(\d+)\)\s*([✅❌]|\(W\)|\(L\))?\s*$", re.UNICODE),
]


def extract_single_team_result(comment: CommentRecord) -> Optional[SingleTeamResult]:
    """Extract a single team result from a comment."""
    text = comment.plain_text
    if not text:
        return None

    # Skip if this looks like a full result or lineup
    if MENTION_RE.search(text):
        return None
    if VS_ANY_RE.search(text):
        return None

    lines = text.strip().splitlines()
    if len(lines) > 3:  # Single team results are usually 1-2 lines
        return None

    for line in lines:
        line = line.strip()
        if not line:
            continue

        for pattern in SINGLE_TEAM_RESULT_PATTERNS:
            m = pattern.match(line)
            if m:
                groups = m.groups()

                # Handle different group orders based on pattern
                if len(groups) == 5:
                    if groups[1].isdigit():  # First pattern: team, wins, losses, score, marker
                        team = groups[0].strip()
                        wins = int(groups[1])
                        losses = int(groups[2])
                        score = parse_score(groups[3])
                        marker = groups[4]
                    else:  # Third pattern: team, score, wins, losses, marker
                        team = groups[0].strip()
                        score = parse_score(groups[1])
                        wins = int(groups[2])
                        losses = int(groups[3])
                        marker = groups[4]

                    if not team or not score:
                        continue

                    # Determine if this was a win
                    is_winner = None
                    if marker in ['✅', '(W)']:
                        is_winner = True
                    elif marker in ['❌', '(L)']:
                        is_winner = False

                    game_date = parse_timestamp_to_date(comment.created_at_ts)

                    return SingleTeamResult(
                        comment_id=comment.comment_id,
                        created_at=comment.created_at_ts,
                        game_date=game_date or "",
                        team=team,
                        score=score,
                        wins=wins,
                        losses=losses,
                        is_winner=is_winner
                    )

    return None


def match_single_team_results(single_results: list[SingleTeamResult], lineups: list[GameLineup]) -> list[GameResult]:
    """Match pairs of single-team results to create full game results."""
    matched_results = []

    # Group single results by date
    by_date = defaultdict(list)
    for sr in single_results:
        if sr.game_date:
            by_date[sr.game_date].append(sr)

    # Also index lineups by date and teams for matching
    lineups_by_date_teams = {}
    for lu in lineups:
        if lu.game_date and lu.team_a and lu.team_b:
            key = (lu.game_date, frozenset([lu.team_a.lower(), lu.team_b.lower()]))
            lineups_by_date_teams[key] = lu

    used_result_ids = set()

    # For each date, try to pair up results
    for date, results in by_date.items():
        # Try to match each result with another
        for i, r1 in enumerate(results):
            if r1.comment_id in used_result_ids:
                continue

            r1_team_lower = r1.team.lower()

            # Look for a matching opponent in lineups
            for lu in lineups:
                if lu.game_date != date:
                    continue

                lu_team_a = lu.team_a.lower() if lu.team_a else ""
                lu_team_b = lu.team_b.lower() if lu.team_b else ""

                # Check if r1 matches one of the lineup teams
                opponent_team = None
                if r1_team_lower == lu_team_a or r1_team_lower in lu_team_a or lu_team_a in r1_team_lower:
                    opponent_team = lu_team_b
                elif r1_team_lower == lu_team_b or r1_team_lower in lu_team_b or lu_team_b in r1_team_lower:
                    opponent_team = lu_team_a

                if not opponent_team:
                    continue

                # Look for the opponent's result
                for r2 in results:
                    if r2.comment_id in used_result_ids or r2.comment_id == r1.comment_id:
                        continue

                    r2_team_lower = r2.team.lower()
                    if r2_team_lower == opponent_team or r2_team_lower in opponent_team or opponent_team in r2_team_lower:
                        # Found a match! Create a game result
                        used_result_ids.add(r1.comment_id)
                        used_result_ids.add(r2.comment_id)

                        # Determine which is team A and which is team B based on lineup order
                        if r1_team_lower == lu_team_a or r1_team_lower in lu_team_a or lu_team_a in r1_team_lower:
                            team_a_result, team_b_result = r1, r2
                        else:
                            team_a_result, team_b_result = r2, r1

                        # Determine winner
                        winner = None
                        if team_a_result.is_winner is True:
                            winner = "A"
                        elif team_b_result.is_winner is True:
                            winner = "B"
                        elif team_a_result.score > team_b_result.score:
                            winner = "A"
                        elif team_b_result.score > team_a_result.score:
                            winner = "B"

                        result = GameResult(
                            comment_id=team_a_result.comment_id,
                            thread_id=0,  # Unknown for single results
                            created_at=team_a_result.created_at,
                            game_date=date,
                            team_a=lu.team_a,  # Use lineup team names for consistency
                            team_b=lu.team_b,
                            score_a=team_a_result.score,
                            score_b=team_b_result.score,
                            winner=winner,
                            raw_text=f"{team_a_result.team}: {team_a_result.score} vs {team_b_result.team}: {team_b_result.score}"
                        )
                        matched_results.append(result)
                        break
                else:
                    continue
                break

    return matched_results


def extract_leaderboard_scores(text: str, game_date: str) -> dict:
    """Extract team scores from leaderboard/top scores posts.

    Returns a dict mapping team_name -> {'score': float, 'winner': bool}
    """
    if not text:
        return {}

    scores = {}

    # Pattern: "N. TeamName (W-L) - score (W)/(L)" or "N. TeamName (W-L) - score ✅/❌"
    # Also: "TeamName: score (W-L)"
    leaderboard_patterns = [
        # "5. Jammers (1-0) - 41,796 (W)"
        re.compile(r"^\s*\d+\.\s*(.+?)\s*\(\d+-\d+\)\s*[-–:]\s*([\d,]+(?:\.\d+)?)\s*(?:\(([WL])\)|([✅❌]))?", re.UNICODE),
        # "Empire: 32,943 (0-1)"
        re.compile(r"^\s*([A-Za-z][A-Za-z\s]+?):\s*([\d,]+(?:\.\d+)?)\s*\((\d+)-(\d+)\)", re.UNICODE),
    ]

    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue

        for pattern in leaderboard_patterns:
            m = pattern.match(line)
            if m:
                groups = m.groups()
                team = groups[0].strip()
                score = parse_score(groups[1])

                # Determine winner status
                is_winner = None
                if len(groups) > 2:
                    if groups[2] == 'W' or groups[3] == '✅':
                        is_winner = True
                    elif groups[2] == 'L' or groups[3] == '❌':
                        is_winner = False

                if team and score:
                    scores[team.lower()] = {'score': score, 'winner': is_winner, 'raw_team': team}
                break

    return scores


def process_comments(comments: list[CommentRecord]) -> tuple[list[GameLineup], list[GameResult], dict, list[SingleTeamResult]]:
    """Process all comments and extract lineups, results, leaderboard scores, and single-team results."""
    lineups = []
    results = []
    single_team_results = []
    leaderboard_scores = defaultdict(dict)  # date -> team -> score_info

    # Group by thread for context
    threads = defaultdict(list)
    for c in comments:
        threads[c.thread_root_id].append(c)

    # Sort each thread by created_at
    for tid in threads:
        threads[tid].sort(key=lambda x: x.created_at_ts)

    print(f"Processing {len(threads)} threads...")

    for tid, thread_comments in threads.items():
        # Get thread root text for context
        root_text = ""
        for c in thread_comments:
            if c.comment_id == tid:
                root_text = c.plain_text
                break

        # Skip exhibition threads
        if is_exhibition(root_text):
            continue

        # Process each comment in thread
        for c in thread_comments:
            game_date = parse_timestamp_to_date(c.created_at_ts)

            # Skip exhibition comments
            if is_exhibition(c.plain_text):
                continue

            # Try lineup extraction
            lineup = extract_lineup(c, root_text)
            if lineup:
                lineups.append(lineup)
                continue  # If it's a lineup, don't try other extractions

            # Try result extraction
            result = extract_result(c, root_text)
            if result:
                results.append(result)
                continue

            # Try single-team result extraction
            single_result = extract_single_team_result(c)
            if single_result:
                single_team_results.append(single_result)
                continue

            # Also extract leaderboard scores for backup matching
            content_type = detect_content_type(c.plain_text)
            if content_type == "leaderboard" and game_date:
                lb_scores = extract_leaderboard_scores(c.plain_text, game_date)
                if lb_scores:
                    leaderboard_scores[game_date].update(lb_scores)

    print(f"Extracted {len(lineups)} lineups and {len(results)} results")
    print(f"Extracted {len(single_team_results)} single-team results")
    print(f"Extracted leaderboard scores for {len(leaderboard_scores)} dates")
    return lineups, results, leaderboard_scores, single_team_results


def run_parser(sql_path: Path, output_dir: Path, date_range: tuple[str, str] = None):
    """Run the complete parsing pipeline."""

    # Parse SQL dump
    comments = parse_sql_dump(sql_path)

    # Filter by date range if specified
    if date_range:
        start_date, end_date = date_range
        print(f"Filtering to date range: {start_date} to {end_date}")
        comments = [c for c in comments if start_date <= c.created_at_ts[:10] <= end_date]
        print(f"Filtered to {len(comments)} comments in date range")

    # Extract lineups, results, leaderboard scores, and single-team results
    lineups, results, leaderboard_scores, single_team_results = process_comments(comments)

    # Match single-team results into paired game results
    matched_single_results = match_single_team_results(single_team_results, lineups)
    if matched_single_results:
        print(f"Matched {len(matched_single_results)} games from single-team results")
        results.extend(matched_single_results)

    # Link and create complete games
    games = link_results_to_lineups(lineups, results)

    # Fill in missing scores from leaderboard data
    games_filled = 0
    for game in games:
        if game.score_a is None and game.game_date:
            # Look for scores in leaderboard data for this date and adjacent dates
            for date_offset in range(0, 3):
                try:
                    d = datetime.fromisoformat(game.game_date)
                    check_date = (d + timedelta(days=date_offset)).isoformat()
                except:
                    continue

                date_scores = leaderboard_scores.get(check_date, {})
                if not date_scores:
                    continue

                team_a_lower = game.team_a.lower() if game.team_a else ""
                team_b_lower = game.team_b.lower() if game.team_b else ""

                score_a_info = date_scores.get(team_a_lower)
                score_b_info = date_scores.get(team_b_lower)

                if score_a_info and score_b_info:
                    game.score_a = score_a_info['score']
                    game.score_b = score_b_info['score']
                    if score_a_info.get('winner') is True:
                        game.winner = "A"
                    elif score_b_info.get('winner') is True:
                        game.winner = "B"
                    elif game.score_a > game.score_b:
                        game.winner = "A"
                    elif game.score_b > game.score_a:
                        game.winner = "B"
                    games_filled += 1
                    break

    if games_filled > 0:
        print(f"Filled {games_filled} games with leaderboard scores")

    # Sort by date
    games.sort(key=lambda g: (g.game_date or "", g.game_id))

    # Create output directory
    output_dir.mkdir(parents=True, exist_ok=True)

    # Save outputs
    games_path = output_dir / "parsed_games.json"
    with open(games_path, 'w', encoding='utf-8') as f:
        json.dump([asdict(g) for g in games], f, indent=2, ensure_ascii=False)
    print(f"Saved {len(games)} games to {games_path}")

    # Save lineups separately
    lineups_path = output_dir / "parsed_lineups.json"
    with open(lineups_path, 'w', encoding='utf-8') as f:
        json.dump([asdict(lu) for lu in lineups], f, indent=2, ensure_ascii=False)
    print(f"Saved {len(lineups)} lineups to {lineups_path}")

    # Save results separately
    results_path = output_dir / "parsed_results.json"
    with open(results_path, 'w', encoding='utf-8') as f:
        json.dump([asdict(r) for r in results], f, indent=2, ensure_ascii=False)
    print(f"Saved {len(results)} results to {results_path}")

    # Save CSV summary
    csv_path = output_dir / "parsed_games.csv"
    with open(csv_path, 'w', encoding='utf-8', newline='') as f:
        writer = csv.writer(f)
        writer.writerow([
            "game_id", "game_date", "game_type",
            "team_a", "team_b",
            "captain_a", "captain_b",
            "players_a", "players_b",
            "score_a", "score_b", "winner",
            "adjustment_a", "adjustment_b",
            "round_name", "seed_a", "seed_b",
            "lineup_comment_id", "result_comment_id"
        ])
        for g in games:
            writer.writerow([
                g.game_id, g.game_date, g.game_type,
                g.team_a, g.team_b,
                g.captain_a or "", g.captain_b or "",
                ", ".join(g.players_a), ", ".join(g.players_b),
                g.score_a or "", g.score_b or "", g.winner or "",
                g.adjustment_a or "", g.adjustment_b or "",
                g.round_name or "", g.seed_a or "", g.seed_b or "",
                g.lineup_comment_id or "", g.result_comment_id or ""
            ])
    print(f"Saved CSV summary to {csv_path}")

    # Print summary
    print("\n" + "="*60)
    print("PARSING COMPLETE")
    print("="*60)
    print(f"Total games found: {len(games)}")

    regular = [g for g in games if g.game_type == "regular"]
    postseason = [g for g in games if g.game_type == "postseason"]
    with_scores = [g for g in games if g.score_a is not None]
    with_lineups = [g for g in games if g.lineup_comment_id is not None]
    with_player_stats = [g for g in games if g.player_stats]

    print(f"  Regular season: {len(regular)}")
    print(f"  Postseason: {len(postseason)}")
    print(f"  With scores: {len(with_scores)}")
    print(f"  With full lineups: {len(with_lineups)}")
    print(f"  With player stats: {len(with_player_stats)}")

    if games:
        dates = sorted(set(g.game_date for g in games if g.game_date))
        if dates:
            print(f"  Date range: {dates[0]} to {dates[-1]}")

    return games


def main():
    parser = argparse.ArgumentParser(description="Parse RKL game data from SQL dump")
    parser.add_argument("--sql-path", type=str, default="../rkl_comments.sql",
                        help="Path to the SQL dump file")
    parser.add_argument("--output-dir", type=str, default="./output/parsed",
                        help="Output directory for parsed data")
    parser.add_argument("--start-date", type=str, default=None,
                        help="Start date filter (YYYY-MM-DD)")
    parser.add_argument("--end-date", type=str, default=None,
                        help="End date filter (YYYY-MM-DD)")

    args = parser.parse_args()

    sql_path = Path(args.sql_path)
    output_dir = Path(args.output_dir)

    if not sql_path.exists():
        print(f"Error: SQL file not found at {sql_path}")
        return 1

    date_range = None
    if args.start_date and args.end_date:
        date_range = (args.start_date, args.end_date)

    run_parser(sql_path, output_dir, date_range)
    return 0


if __name__ == "__main__":
    exit(main())
