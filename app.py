import sqlite3
import re
import csv
import io
from datetime import datetime, date, timedelta
from zoneinfo import ZoneInfo
import streamlit as st

DB = "rkl.db"
EASTERN = ZoneInfo("America/New_York")

# ----------------------------
# DB helpers
# ----------------------------
@st.cache_resource
def db():
    con = sqlite3.connect(DB, check_same_thread=False)
    con.row_factory = sqlite3.Row
    _init_db(con)
    return con

def q(sql, params=()):
    return db().execute(sql, params).fetchall()

def x(sql, params=()):
    db().execute(sql, params)
    db().commit()

def _init_db(con: sqlite3.Connection):
    cur = con.cursor()
    cur.executescript("""
    CREATE TABLE IF NOT EXISTS thread_state (
        thread_id INTEGER PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'todo',   -- todo | done | review | skipped
        updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_thread_state_status ON thread_state(status);

    CREATE TABLE IF NOT EXISTS manual_extract (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT,
        thread_id INTEGER,
        comment_id INTEGER,
        source TEXT,          -- feed/replies
        kind TEXT,            -- lineup/result/leaderboard/other
        game_date TEXT,       -- YYYY-MM-DD
        team_a TEXT,
        team_b TEXT,
        mentions TEXT,        -- comma-separated (legacy)
        notes TEXT,
        raw_text TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_manual_extract_thread ON manual_extract(thread_id);
    """)
    con.commit()
    
    # Migration: add columns if missing
    migrations = [
        ("captain_a", "TEXT"),
        ("captain_b", "TEXT"),
        ("mentions_a", "TEXT"),  # Team A players
        ("mentions_b", "TEXT"),  # Team B players
        ("seed_a", "TEXT"),      # Postseason seed
        ("seed_b", "TEXT"),
        ("round_name", "TEXT"),  # e.g., "RKL Finals", "Round 1"
        # Result-specific fields
        ("score_a", "REAL"),     # Team A score
        ("score_b", "REAL"),     # Team B score
        ("winner", "TEXT"),      # "A", "B", or null
        ("adjustment_a", "REAL"),  # Score adjustment for team A
        ("adjustment_b", "REAL"),  # Score adjustment for team B
        # Linking results to lineups
        ("linked_extract_id", "INTEGER"),  # FK to another manual_extract (lineup)
    ]
    for col_name, col_type in migrations:
        try:
            cur.execute(f"SELECT {col_name} FROM manual_extract LIMIT 1")
        except sqlite3.OperationalError:
            cur.execute(f"ALTER TABLE manual_extract ADD COLUMN {col_name} {col_type}")
            con.commit()

# ----------------------------
# Lightweight heuristics (assistive, not perfect)
# ----------------------------
VS_ANY_RE = re.compile(r"\bvs\.?\b", re.IGNORECASE)
MENTION_RE = re.compile(r"@([A-Za-z0-9._]+)")
SCORE_NUM_RE = re.compile(r"\b\d{1,3}(?:,\d{3})+\b")
TOP_SCORES_RE = re.compile(r"top\s+team\s+scores", re.IGNORECASE)
MEDIAN_RE = re.compile(r"\bmedian\b", re.IGNORECASE)
WINLOSS_MARK_RE = re.compile(r"[✅❌]")
LINEUPS_WORD_RE = re.compile(r"\blineups\b", re.IGNORECASE)

INLINE_VS_SPLIT_RE = re.compile(r"\bvs\.?\b", re.IGNORECASE)

# Team name parsing patterns
# Matches: "TeamName (W-L)" or "TeamName (W-L-T)" with optional trailing stuff
TEAM_RECORD_RE = re.compile(r"^(.+?)\s*\(\d+-\d+(?:-\d+)?\)")
# Matches result lines: "TeamName (W-L) - 47,502 ✅" or "TeamName (W-L) - 48,858 ❌"
RESULT_LINE_RE = re.compile(r"^(.+?)\s*\(\d+-\d+(?:-\d+)?\)\s*[-–]\s*[\d,]+\s*[✅❌]", re.UNICODE)
# Matches leaderboard rank lines: "1. TeamName (W-L) - 51,513 ✅"
LEADERBOARD_LINE_RE = re.compile(r"^\d+\.\s*(.+?)\s*\(\d+-\d+(?:-\d+)?\)\s*[-–]\s*[\d,]+", re.UNICODE)
# Standalone vs line (just "vs" or "vs." on its own line)
STANDALONE_VS_RE = re.compile(r"^\s*vs\.?\s*$", re.IGNORECASE)

# Captain detection patterns
# Explicit captain marker: "@username (c)" or "@username (C)"
CAPTAIN_EXPLICIT_RE = re.compile(r"@([A-Za-z0-9._]+)\s*\([cC]\)")
# Plain 'c' marker: "@username c" (space + lowercase c + end/space/newline)
CAPTAIN_PLAIN_C_RE = re.compile(r"@([A-Za-z0-9._]+)\s+[cC](?:\s|$)")
# Mention with trailing content (to check if only non-alphanumeric follows)
MENTION_WITH_TRAIL_RE = re.compile(r"@([A-Za-z0-9._]+)(.*?)(?=@[A-Za-z0-9._]+|$)", re.DOTALL)
# RealApp emoji pattern: :emoji_name (single colon at start, no closing colon)
REALAPP_EMOJI_RE = re.compile(r":[a-z_0-9]+")

# Postseason patterns
# Round names like "RKL Finals", "Round 1", "Semifinals", "Quarter Finals", etc.
ROUND_NAME_RE = re.compile(r"(RKL\s+Finals|Finals|Semi\s*-?\s*Finals?|Quarter\s*-?\s*Finals?|Round\s+\d+|Playoffs?\s+Round\s+\d+|Wild\s*Card|Game\s+\d+)", re.IGNORECASE)
# Seed pattern: "1 TeamName" or "(1) TeamName" or "1. TeamName" at start of line
SEED_TEAM_RE = re.compile(r"^\s*(?:\((\d+)\)|(\d+)\.?\s+)(.+?)(?:\s*\(\d+-\d+\))?\s*$")

# ----------------------------
# Result parsing patterns
# ----------------------------
# Win/loss indicators (including RealApp emoji)
WIN_INDICATOR_RE = re.compile(r"(✅+|:check_mark_button|🏆)")
LOSS_INDICATOR_RE = re.compile(r"(❌|:cross_mark)")

# Score patterns - matches numbers with commas and optional decimals
# Examples: 34,565 or 47,547.5 or 51458
SCORE_EXTRACT_RE = re.compile(r"([\d,]+(?:\.\d+)?)")

# Result line patterns - several variations seen in the data
# Pattern 1: "(seed) TeamName (W-L) - 34,565 ✅" or "seed. TeamName (W-L): 51,458 ✅✅✅"
RESULT_FULL_RE = re.compile(
    r"^\s*(?:\((\d+)\)\s*|(\d+)\.\s*)?(.+?)\s*\((\d+)-(\d+)(?:-\d+)?\)\s*[-–:]\s*([\d,]+(?:\.\d+)?)\s*(.*)$",
    re.UNICODE
)

# Pattern 2: Simple "TeamName - Score" without record (for adjustments)
ADJUSTMENT_LINE_RE = re.compile(
    r"^\s*([A-Za-z][A-Za-z0-9\s]+?)\s+([+-]?\d[\d,]*(?:\.\d+)?)\s*$"
)

# Adjustment header patterns
ADJUSTMENT_HEADER_RE = re.compile(
    r"(advent\s+deduction|deduction|adjustment|penalty|bonus)",
    re.IGNORECASE
)

# Separator lines (dashes)
SEPARATOR_RE = re.compile(r"^[-–—]{3,}$")

def parse_score(score_str: str) -> float | None:
    """Parse a score string like '34,565' or '47,547.5' to a float."""
    if not score_str:
        return None
    try:
        # Remove commas and parse
        return float(score_str.replace(",", ""))
    except ValueError:
        return None

def detect_winner(line: str) -> str | None:
    """Detect if a line indicates a win or loss."""
    if WIN_INDICATOR_RE.search(line):
        return "win"
    if LOSS_INDICATOR_RE.search(line):
        return "loss"
    return None

def parse_result_line(line: str) -> dict | None:
    """
    Parse a single result line.
    Returns: {team, record_w, record_l, score, seed, winner} or None
    """
    line = line.strip()
    if not line:
        return None

    m = RESULT_FULL_RE.match(line)
    if m:
        seed = m.group(1) or m.group(2)  # (seed) or seed.
        team = m.group(3).strip()
        record_w = int(m.group(4))
        record_l = int(m.group(5))
        score_str = m.group(6)
        trailing = m.group(7) or ""

        # Clean team name (remove leading seed if duplicated)
        team = re.sub(r"^\d+\.\s*", "", team).strip()

        score = parse_score(score_str)
        winner = detect_winner(trailing)

        return {
            "team": team,
            "record_w": record_w,
            "record_l": record_l,
            "score": score,
            "seed": seed,
            "winner": winner,
        }
    return None

def parse_adjustment_line(line: str) -> dict | None:
    """
    Parse an adjustment line like "Diabetics -1950".
    Returns: {team, adjustment} or None
    """
    m = ADJUSTMENT_LINE_RE.match(line.strip())
    if m:
        team = m.group(1).strip()
        adj_str = m.group(2).replace(",", "")
        try:
            adjustment = float(adj_str)
            return {"team": team, "adjustment": adjustment}
        except ValueError:
            return None
    return None

def extract_game_result(text: str) -> dict | None:
    """
    Extract game result data from a results post.
    Returns: {
        team_a, team_b, score_a, score_b,
        record_a_w, record_a_l, record_b_w, record_b_l,
        seed_a, seed_b, winner,
        adjustment_a, adjustment_b,
        round_name
    } or None
    """
    if not text:
        return None

    lines = text.splitlines()
    result_lines = []
    adjustments = []
    in_adjustment_section = False
    round_name = None

    for ln in lines:
        ln_stripped = ln.strip()

        # Check for round name in first few lines
        if len(result_lines) == 0 and not round_name:
            m = ROUND_NAME_RE.search(ln_stripped)
            if m:
                # Take the whole line as round name (e.g., "👑 RKL FINALS GAME 5 👑")
                round_name = ln_stripped
                continue

        # Skip separator lines
        if SEPARATOR_RE.match(ln_stripped):
            continue

        # Check for adjustment section header
        if ADJUSTMENT_HEADER_RE.search(ln_stripped):
            in_adjustment_section = True
            continue

        # Parse result lines
        parsed = parse_result_line(ln_stripped)
        if parsed:
            result_lines.append(parsed)
            continue

        # Parse adjustment lines (if in adjustment section or looks like one)
        if in_adjustment_section or (len(result_lines) >= 2):
            adj = parse_adjustment_line(ln_stripped)
            if adj:
                adjustments.append(adj)

    # Need at least 2 result lines for a game
    if len(result_lines) < 2:
        return None

    # Take the first two as the teams
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
    # Fallback: higher score wins
    elif team_a_data.get("score") and team_b_data.get("score"):
        if team_a_data["score"] > team_b_data["score"]:
            winner = "A"
        elif team_b_data["score"] > team_a_data["score"]:
            winner = "B"

    # Match adjustments to teams
    adjustment_a = None
    adjustment_b = None
    team_a_lower = team_a_data["team"].lower()
    team_b_lower = team_b_data["team"].lower()

    for adj in adjustments:
        adj_team_lower = adj["team"].lower()
        # Fuzzy match team names
        if adj_team_lower in team_a_lower or team_a_lower in adj_team_lower:
            adjustment_a = adj["adjustment"]
        elif adj_team_lower in team_b_lower or team_b_lower in adj_team_lower:
            adjustment_b = adj["adjustment"]

    return {
        "team_a": team_a_data["team"],
        "team_b": team_b_data["team"],
        "score_a": team_a_data.get("score"),
        "score_b": team_b_data.get("score"),
        "record_a_w": team_a_data.get("record_w"),
        "record_a_l": team_a_data.get("record_l"),
        "record_b_w": team_b_data.get("record_w"),
        "record_b_l": team_b_data.get("record_l"),
        "seed_a": team_a_data.get("seed"),
        "seed_b": team_b_data.get("seed"),
        "winner": winner,
        "adjustment_a": adjustment_a,
        "adjustment_b": adjustment_b,
        "round_name": round_name,
    }

def find_matching_lineup(team_a: str, team_b: str, result_date: str = None) -> dict | None:
    """
    Find a matching lineup extract for a result based on team names.

    Args:
        team_a: First team name from result
        team_b: Second team name from result
        result_date: Date when result was posted (YYYY-MM-DD), used to limit search range

    Returns:
        Dict with lineup info {id, game_date, team_a, team_b, swapped} or None
        'swapped' is True if teams are in reverse order in the lineup
    """
    if not team_a or not team_b:
        return None

    team_a_lower = team_a.lower().strip()
    team_b_lower = team_b.lower().strip()

    # Build date range query - look for lineups within 3 days before result
    date_clause = ""
    params = []
    if result_date:
        date_clause = "AND game_date <= ? AND game_date >= date(?, '-3 days')"
        params = [result_date, result_date]

    # Query for lineups matching these teams (in either order)
    sql = f"""
        SELECT id, game_date, team_a, team_b, thread_id, comment_id
        FROM manual_extract
        WHERE kind = 'lineup'
          AND (
              (lower(team_a) = ? AND lower(team_b) = ?)
              OR (lower(team_a) = ? AND lower(team_b) = ?)
          )
          {date_clause}
        ORDER BY game_date DESC
        LIMIT 5
    """

    matches = q(sql, (team_a_lower, team_b_lower, team_b_lower, team_a_lower) + tuple(params))

    if not matches:
        # Try fuzzy matching - team name might have slight variations
        sql_fuzzy = f"""
            SELECT id, game_date, team_a, team_b, thread_id, comment_id
            FROM manual_extract
            WHERE kind = 'lineup'
              AND (
                  (lower(team_a) LIKE ? AND lower(team_b) LIKE ?)
                  OR (lower(team_a) LIKE ? AND lower(team_b) LIKE ?)
              )
              {date_clause}
            ORDER BY game_date DESC
            LIMIT 5
        """
        matches = q(sql_fuzzy, (
            f"%{team_a_lower}%", f"%{team_b_lower}%",
            f"%{team_b_lower}%", f"%{team_a_lower}%"
        ) + tuple(params))

    if not matches:
        return None

    # Return the most recent match
    match = matches[0]
    match_team_a = (match["team_a"] or "").lower().strip()

    # Determine if teams are swapped
    swapped = (match_team_a == team_b_lower or team_b_lower in match_team_a)

    return {
        "id": match["id"],
        "game_date": match["game_date"],
        "team_a": match["team_a"],
        "team_b": match["team_b"],
        "thread_id": match["thread_id"],
        "comment_id": match["comment_id"],
        "swapped": swapped,
    }

def find_all_matching_lineups(team_a: str, team_b: str, result_date: str = None) -> list[dict]:
    """
    Find all potential matching lineups for a result.
    Returns list of matches for user to choose from.
    """
    if not team_a or not team_b:
        return []

    team_a_lower = team_a.lower().strip()
    team_b_lower = team_b.lower().strip()

    # Build date range query - look for lineups within 7 days before result
    date_clause = ""
    params = []
    if result_date:
        date_clause = "AND game_date <= ? AND game_date >= date(?, '-7 days')"
        params = [result_date, result_date]

    sql = f"""
        SELECT id, game_date, team_a, team_b, thread_id, comment_id
        FROM manual_extract
        WHERE kind = 'lineup'
          AND (
              (lower(team_a) LIKE ? OR lower(team_b) LIKE ?)
              OR (lower(team_a) LIKE ? OR lower(team_b) LIKE ?)
          )
          {date_clause}
        ORDER BY game_date DESC
        LIMIT 10
    """

    matches = q(sql, (
        f"%{team_a_lower}%", f"%{team_a_lower}%",
        f"%{team_b_lower}%", f"%{team_b_lower}%"
    ) + tuple(params))

    results = []
    for match in matches:
        match_team_a = (match["team_a"] or "").lower().strip()
        match_team_b = (match["team_b"] or "").lower().strip()

        # Score the match quality
        exact_match = (
            (match_team_a == team_a_lower and match_team_b == team_b_lower) or
            (match_team_a == team_b_lower and match_team_b == team_a_lower)
        )

        results.append({
            "id": match["id"],
            "game_date": match["game_date"],
            "team_a": match["team_a"],
            "team_b": match["team_b"],
            "thread_id": match["thread_id"],
            "comment_id": match["comment_id"],
            "exact_match": exact_match,
        })

    # Sort by exact match first, then by date
    results.sort(key=lambda x: (not x["exact_match"], x["game_date"] or ""), reverse=True)

    return results

def detect_postseason_info(text: str):
    """
    Detect postseason round name and team seeds.
    Returns: (round_name, seed_a, seed_b)
    """
    if not text:
        return (None, None, None)
    
    lines = text.splitlines()
    round_name = None
    seed_a = None
    seed_b = None
    
    # Look for round name in first few lines
    for ln in lines[:5]:
        ln_stripped = ln.strip()
        m = ROUND_NAME_RE.match(ln_stripped)
        if m:
            round_name = ln_stripped
            break
    
    # Find vs line to split into team sections
    vs_line_idx = None
    for i, ln in enumerate(lines):
        if STANDALONE_VS_RE.match(ln):
            vs_line_idx = i
            break
    
    if vs_line_idx is not None:
        # Look for seeded team line before vs
        for i in range(vs_line_idx - 1, max(0, vs_line_idx - 10) - 1, -1):
            ln = lines[i].strip()
            if ln.startswith("@"):
                continue
            m = SEED_TEAM_RE.match(ln)
            if m:
                seed_a = m.group(1) or m.group(2)
                break
        
        # Look for seeded team line after vs
        for i in range(vs_line_idx + 1, min(len(lines), vs_line_idx + 10)):
            ln = lines[i].strip()
            if ln.startswith("@"):
                continue
            m = SEED_TEAM_RE.match(ln)
            if m:
                seed_b = m.group(1) or m.group(2)
                break
    
    return (round_name, seed_a, seed_b)

def extract_mentions_by_team(text: str):
    """
    Split mentions into Team A and Team B based on vs divider.
    Returns: (mentions_a, mentions_b, all_mentions)
    """
    if not text:
        return ([], [], [])
    
    lines = text.splitlines()
    all_mentions = MENTION_RE.findall(text)
    
    # Find vs line
    vs_line_idx = None
    for i, ln in enumerate(lines):
        if STANDALONE_VS_RE.match(ln):
            vs_line_idx = i
            break
    
    if vs_line_idx is None:
        # No vs divider - try inline "vs" split
        for i, ln in enumerate(lines):
            if VS_ANY_RE.search(ln):
                parts = INLINE_VS_SPLIT_RE.split(ln, maxsplit=1)
                if len(parts) == 2:
                    mentions_a = MENTION_RE.findall(parts[0])
                    mentions_b = MENTION_RE.findall(parts[1])
                    return (mentions_a, mentions_b, all_mentions)
        # No split found
        return ([], [], all_mentions)
    
    # Split by vs line
    text_before = "\n".join(lines[:vs_line_idx])
    text_after = "\n".join(lines[vs_line_idx + 1:])
    
    mentions_a = MENTION_RE.findall(text_before)
    mentions_b = MENTION_RE.findall(text_after)
    
    return (mentions_a, mentions_b, all_mentions)

def guess_kind(text: str) -> str:
    t = text or ""
    if TOP_SCORES_RE.search(t) or MEDIAN_RE.search(t):
        return "leaderboard"
    if WINLOSS_MARK_RE.search(t) and SCORE_NUM_RE.search(t):
        return "result"
    if (LINEUPS_WORD_RE.search(t) or VS_ANY_RE.search(t)) and MENTION_RE.search(t):
        return "lineup"
    # GOTD posts
    if re.search(r"\bGOTD\b", t, re.IGNORECASE) and MENTION_RE.search(t):
        return "lineup"
    # Postseason posts (round names)
    if ROUND_NAME_RE.search(t) and MENTION_RE.search(t) and VS_ANY_RE.search(t):
        return "lineup"
    return "other"

def clean_team_name(name: str) -> str:
    """Clean up a team name by removing trailing records, punctuation, seeds, etc."""
    if not name:
        return ""
    name = name.strip()
    # Remove leading seed numbers: "1 Team", "(1) Team", "1. Team"
    name = re.sub(r"^\s*(?:\(\d+\)\s*|\d+\.\s*|\d+\s+)", "", name)
    # Remove trailing (W-L) record if present
    name = re.sub(r"\s*\(\d+-\d+(?:-\d+)?\)\s*$", "", name)
    # Remove trailing score/checkmarks
    name = re.sub(r"\s*[-–]\s*[\d,]+\s*[✅❌]?\s*$", "", name)
    # Remove leading rank numbers like "1. " (redundant but safe)
    name = re.sub(r"^\d+\.\s*", "", name)
    # Remove leading/trailing punctuation and whitespace
    name = name.strip(" \t\n-–:•")
    return name[:80] if name else ""

def guess_teams(text: str):
    """
    Improved team detection with multiple strategies:
    1. Results format: two lines with "Team (W-L) - score ✅/❌"
    2. Leaderboard format: "1. Team (W-L) - score"
    3. Inline "Team A (W-L) vs Team B (W-L)"
    4. Multi-line with standalone "vs" separator
    """
    if not text:
        return (None, None)
    
    lines = text.splitlines()
    
    # Strategy 1: Look for results format (two consecutive result lines)
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
    
    # Strategy 2: Leaderboard format (get first two ranked teams)
    leaderboard_teams = []
    for ln in lines:
        m = LEADERBOARD_LINE_RE.match(ln.strip())
        if m:
            team = clean_team_name(m.group(1))
            if team:
                leaderboard_teams.append(team)
        if len(leaderboard_teams) >= 2:
            break
    if len(leaderboard_teams) >= 2:
        return (leaderboard_teams[0], leaderboard_teams[1])
    
    # Strategy 3: Inline "Team A vs Team B" (with or without records)
    for ln in lines[:12]:  # Check first 12 lines
        if VS_ANY_RE.search(ln):
            parts = INLINE_VS_SPLIT_RE.split(ln, maxsplit=1)
            if len(parts) == 2:
                team_a = clean_team_name(parts[0])
                team_b = clean_team_name(parts[1])
                if team_a or team_b:
                    return (team_a or None, team_b or None)
    
    # Strategy 4: Multi-line with standalone "vs" divider
    vs_line_idx = None
    for i, ln in enumerate(lines):
        if STANDALONE_VS_RE.match(ln):
            vs_line_idx = i
            break
    
    if vs_line_idx is not None:
        # Look for team-like content before and after vs line
        team_a = None
        team_b = None
        
        # Search backward from vs for team A
        # Skip over mention lines (lines starting with @) without limit
        # But stop after checking 15 lines total to avoid runaway
        for i in range(vs_line_idx - 1, max(0, vs_line_idx - 15) - 1, -1):
            ln = lines[i].strip()
            if not ln:
                continue
            # Skip lines that start with @ (mention lines)
            if ln.startswith("@"):
                continue
            # Found a non-mention line - check if it's a team
            m = TEAM_RECORD_RE.match(ln)
            if m:
                team_a = clean_team_name(m.group(1))
                break
            # Or just use the line if it looks team-ish (short, no @)
            elif len(ln) < 50:
                team_a = clean_team_name(ln)
                break
        
        # Search forward from vs for team B
        # Same logic: skip mention lines
        for i in range(vs_line_idx + 1, min(len(lines), vs_line_idx + 15)):
            ln = lines[i].strip()
            if not ln:
                continue
            if ln.startswith("@"):
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

def extract_mentions(text: str):
    if not text:
        return []
    return MENTION_RE.findall(text)

def is_captain_marker(text_after_mention: str) -> bool:
    """
    Check if the text following a @mention indicates captain status.
    Returns True if:
    - Text starts with "(c)" or "(C)"
    - Text starts with just "c" or "C" followed by whitespace/end
    - Text contains ONLY non-alphanumeric chars (emojis/symbols like 💤🔥)
    - Text contains only RealApp emoji codes like :doughnut: :crown:
    """
    if not text_after_mention:
        return False
    
    text_after = text_after_mention.strip()
    
    # Check for explicit (c) marker
    if re.match(r"^\s*\([cC]\)", text_after):
        return True
    
    # Check for plain c marker (just "c" or "C" followed by space/end)
    if re.match(r"^\s*[cC](?:\s|$)", text_after):
        return True
    
    # Check if remaining text until next @ or end has no alphanumeric chars
    # Get text until next mention or end of line
    until_next = re.split(r"[@\n]", text_after)[0]
    if until_next.strip():
        # Remove RealApp emoji codes like :doughnut: :crown: :flag_usa:
        cleaned = REALAPP_EMOJI_RE.sub("", until_next)
        # Remove whitespace
        cleaned = cleaned.strip()
        # If there's nothing left, or only non-alphanumeric remains, it's a captain
        if not cleaned:
            return True
        has_alpha = any(c.isalnum() for c in cleaned)
        if not has_alpha:
            return True
    
    return False

def detect_captains(text: str):
    """
    Detect captain candidates from text.
    Returns: (captain_a_guess, captain_b_guess, all_candidates)
    
    Strategy:
    1. If there's a standalone "vs" line, split into team A/B blocks
    2. Find explicit (c) markers
    3. Find plain 'c' markers
    4. Find implicit markers (mention followed by only emoji/symbols)
    5. Return best guesses per team block
    """
    if not text:
        return (None, None, [])
    
    lines = text.splitlines()
    all_mentions = extract_mentions(text)
    
    # Find explicit captains: @user (c)
    explicit_captains = CAPTAIN_EXPLICIT_RE.findall(text)
    
    # Find plain c captains: @user c
    plain_c_captains = CAPTAIN_PLAIN_C_RE.findall(text)
    
    # Find implicit captains (mention followed by only non-alphanumeric/emoji)
    implicit_captains = []
    for m in MENTION_WITH_TRAIL_RE.finditer(text):
        username = m.group(1)
        trailing = m.group(2)
        if username not in explicit_captains and username not in plain_c_captains and is_captain_marker(trailing):
            implicit_captains.append(username)
    
    all_captain_candidates = list(dict.fromkeys(explicit_captains + plain_c_captains + implicit_captains))
    
    # Try to split by "vs" line to assign captains to teams
    vs_line_idx = None
    for i, ln in enumerate(lines):
        if STANDALONE_VS_RE.match(ln):
            vs_line_idx = i
            break
    
    captain_a = None
    captain_b = None
    
    if vs_line_idx is not None:
        # Split text into before-vs and after-vs blocks
        text_before_vs = "\n".join(lines[:vs_line_idx])
        text_after_vs = "\n".join(lines[vs_line_idx + 1:])
        
        # Find captains in each block
        captains_before = []
        captains_after = []
        
        for cap in all_captain_candidates:
            # Check which block contains this captain mention with marker
            pattern = rf"@{re.escape(cap)}"
            if re.search(pattern, text_before_vs):
                captains_before.append(cap)
            if re.search(pattern, text_after_vs):
                captains_after.append(cap)
        
        captain_a = captains_before[0] if captains_before else None
        captain_b = captains_after[0] if captains_after else None
    else:
        # No clear split, just return first two captain candidates
        if len(all_captain_candidates) >= 1:
            captain_a = all_captain_candidates[0]
        if len(all_captain_candidates) >= 2:
            captain_b = all_captain_candidates[1]
    
    return (captain_a, captain_b, all_captain_candidates)

DATE_MMDD_RE = re.compile(r"\b(\d{1,2})[/-](\d{1,2})\b")

def parse_timestamp_to_eastern(ts_str: str | None) -> date | None:
    """Parse timestamp string and convert to US Eastern date."""
    if not ts_str:
        return None
    try:
        # Parse ISO format timestamp
        dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00").replace(" ", "T"))
        # Convert to Eastern time
        dt_eastern = dt.astimezone(EASTERN)
        return dt_eastern.date()
    except Exception:
        return None

def infer_game_date(thread_created_ts: str | None) -> str | None:
    """
    Use the thread's posted date (in US Eastern time) as the game date.
    """
    eastern_date = parse_timestamp_to_eastern(thread_created_ts)
    if eastern_date:
        return eastern_date.isoformat()
    return None

def auto_extract_comment(thread_id: int, comment_id: int, source: str,
                          text: str, thread_text: str, thread_created_ts: str) -> dict | None:
    """
    Automatically extract data from a comment.
    Returns dict with extracted data, or None if not extractable (no teams/mentions found).
    """
    if not text:
        return None

    combined_text = (thread_text or "") + "\n\n" + text

    # Detect type
    kind = guess_kind(text)

    # Get game date from thread
    game_date = infer_game_date(thread_created_ts)

    # Handle results
    if kind == "result":
        result = extract_game_result(text)
        if result and result.get("team_a") and result.get("team_b"):
            # Try to find a matching lineup to get the correct game date
            linked_lineup = find_matching_lineup(
                result["team_a"],
                result["team_b"],
                game_date  # Use thread date as upper bound
            )

            # Use lineup's game_date if found, otherwise fall back to thread date
            actual_game_date = game_date
            linked_extract_id = None
            if linked_lineup:
                actual_game_date = linked_lineup["game_date"]
                linked_extract_id = linked_lineup["id"]

            return {
                "thread_id": thread_id,
                "comment_id": comment_id,
                "source": source,
                "kind": kind,
                "game_date": actual_game_date,
                "team_a": result["team_a"],
                "team_b": result["team_b"],
                "captain_a": None,
                "captain_b": None,
                "mentions_a": None,
                "mentions_b": None,
                "seed_a": result.get("seed_a"),
                "seed_b": result.get("seed_b"),
                "round_name": result.get("round_name"),
                "score_a": result.get("score_a"),
                "score_b": result.get("score_b"),
                "winner": result.get("winner"),
                "adjustment_a": result.get("adjustment_a"),
                "adjustment_b": result.get("adjustment_b"),
                "linked_extract_id": linked_extract_id,
                "raw_text": text,
            }
        return None

    # Handle lineups (original logic)
    if kind != "lineup":
        return None

    # Get teams
    team_a, team_b = guess_teams(combined_text)

    # Need at least one team to be a valid extraction
    if not team_a and not team_b:
        return None

    # Get mentions by team
    mentions_a, mentions_b, all_mentions = extract_mentions_by_team(text)

    # Need some mentions to be useful
    if not mentions_a and not mentions_b:
        return None

    # Get captains
    captain_a, captain_b, _ = detect_captains(text)

    # Get postseason info
    round_name, seed_a, seed_b = detect_postseason_info(text)

    return {
        "thread_id": thread_id,
        "comment_id": comment_id,
        "source": source,
        "kind": kind,
        "game_date": game_date,
        "team_a": team_a,
        "team_b": team_b,
        "captain_a": captain_a,
        "captain_b": captain_b,
        "mentions_a": ", ".join(mentions_a) if mentions_a else None,
        "mentions_b": ", ".join(mentions_b) if mentions_b else None,
        "seed_a": seed_a,
        "seed_b": seed_b,
        "round_name": round_name,
        "score_a": None,
        "score_b": None,
        "winner": None,
        "adjustment_a": None,
        "adjustment_b": None,
        "linked_extract_id": None,
        "raw_text": text,
    }

def run_auto_extract_for_thread(thread_id: int, skip_existing: bool = True) -> tuple[int, int]:
    """
    Auto-extract from a thread: first try the thread itself (for GOTD/postseason),
    then process all replies.
    Returns (extracted_count, skipped_count).
    """
    # Get thread info
    thread = q("SELECT plain_text, created_at_ts, source FROM rkl_comments WHERE comment_id = ?", (thread_id,))
    if not thread:
        return (0, 0)
    
    thread_text = thread[0]["plain_text"]
    thread_created_ts = thread[0]["created_at_ts"]
    thread_source = thread[0]["source"]
    
    extracted = 0
    skipped = 0
    
    # First, try to extract from the thread itself (for GOTD/postseason standalone posts)
    if skip_existing:
        existing = q("SELECT id FROM manual_extract WHERE comment_id = ? LIMIT 1", (thread_id,))
        if existing:
            skipped += 1
        else:
            result = auto_extract_comment(
                thread_id=thread_id,
                comment_id=thread_id,
                source=thread_source or "feed",
                text=thread_text,
                thread_text="",  # No parent thread text for main feed posts
                thread_created_ts=thread_created_ts
            )
            if result:
                x("""
                  INSERT INTO manual_extract(
                    created_at, thread_id, comment_id, source, kind, game_date, team_a, team_b,
                    mentions, notes, raw_text, captain_a, captain_b, mentions_a, mentions_b,
                    seed_a, seed_b, round_name, score_a, score_b, winner, adjustment_a, adjustment_b,
                    linked_extract_id
                  ) VALUES (datetime('now'),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, (
                    result["thread_id"], result["comment_id"], result["source"],
                    result["kind"], result["game_date"], result["team_a"], result["team_b"],
                    "", "auto-extracted", result["raw_text"],
                    result["captain_a"], result["captain_b"],
                    result["mentions_a"], result["mentions_b"],
                    result["seed_a"], result["seed_b"], result["round_name"],
                    result.get("score_a"), result.get("score_b"), result.get("winner"),
                    result.get("adjustment_a"), result.get("adjustment_b"),
                    result.get("linked_extract_id")
                ))
                extracted += 1
    else:
        # Not skipping existing - try to extract from thread
        result = auto_extract_comment(
            thread_id=thread_id,
            comment_id=thread_id,
            source=thread_source or "feed",
            text=thread_text,
            thread_text="",
            thread_created_ts=thread_created_ts
        )
        if result:
            x("""
              INSERT INTO manual_extract(
                created_at, thread_id, comment_id, source, kind, game_date, team_a, team_b,
                mentions, notes, raw_text, captain_a, captain_b, mentions_a, mentions_b,
                seed_a, seed_b, round_name, score_a, score_b, winner, adjustment_a, adjustment_b,
                linked_extract_id
              ) VALUES (datetime('now'),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (
                result["thread_id"], result["comment_id"], result["source"],
                result["kind"], result["game_date"], result["team_a"], result["team_b"],
                "", "auto-extracted", result["raw_text"],
                result["captain_a"], result["captain_b"],
                result["mentions_a"], result["mentions_b"],
                result["seed_a"], result["seed_b"], result["round_name"],
                result.get("score_a"), result.get("score_b"), result.get("winner"),
                result.get("adjustment_a"), result.get("adjustment_b"),
                result.get("linked_extract_id")
            ))
            extracted += 1

    # Get all replies
    replies = q(
        """SELECT comment_id, plain_text, source FROM rkl_comments 
           WHERE source='replies' AND (thread_root_id = ? OR parent_comment_id = ?)
           ORDER BY created_at_ts ASC""",
        (thread_id, thread_id)
    )
    
    for reply in replies:
        comment_id = reply["comment_id"]
        
        # Check if already extracted
        if skip_existing:
            existing = q("SELECT id FROM manual_extract WHERE comment_id = ? LIMIT 1", (comment_id,))
            if existing:
                skipped += 1
                continue
        
        # Try to auto-extract
        result = auto_extract_comment(
            thread_id=thread_id,
            comment_id=comment_id,
            source="replies",
            text=reply["plain_text"],
            thread_text=thread_text,
            thread_created_ts=thread_created_ts
        )
        
        if result:
            x("""
              INSERT INTO manual_extract(
                created_at, thread_id, comment_id, source, kind, game_date, team_a, team_b,
                mentions, notes, raw_text, captain_a, captain_b, mentions_a, mentions_b,
                seed_a, seed_b, round_name, score_a, score_b, winner, adjustment_a, adjustment_b,
                linked_extract_id
              ) VALUES (datetime('now'),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (
                result["thread_id"], result["comment_id"], result["source"],
                result["kind"], result["game_date"], result["team_a"], result["team_b"],
                "", "auto-extracted", result["raw_text"],
                result["captain_a"], result["captain_b"],
                result["mentions_a"], result["mentions_b"],
                result["seed_a"], result["seed_b"], result["round_name"],
                result.get("score_a"), result.get("score_b"), result.get("winner"),
                result.get("adjustment_a"), result.get("adjustment_b"),
                result.get("linked_extract_id")
            ))
            extracted += 1
        else:
            skipped += 1

    return (extracted, skipped)

def run_auto_extract_bulk(thread_ids: list[int], skip_existing: bool = True) -> tuple[int, int, int]:
    """
    Auto-extract for multiple threads.
    Returns (total_extracted, total_skipped, threads_processed).
    """
    total_extracted = 0
    total_skipped = 0
    
    for tid in thread_ids:
        ext, skip = run_auto_extract_for_thread(tid, skip_existing)
        total_extracted += ext
        total_skipped += skip
    
    return (total_extracted, total_skipped, len(thread_ids))

def highlight(text: str) -> str:
    """
    Simple markdown highlighting for mentions, vs, captains, and checkmarks.
    """
    if not text:
        return ""
    t = text
    # Highlight captain markers
    t = re.sub(r"(@[A-Za-z0-9._]+)\s*(\([cC]\))", r"**\1** 🎖️\2", t)
    # Highlight other mentions
    t = re.sub(r"(@[A-Za-z0-9._]+)(?!\s*\([cC]\))", r"**\1**", t)
    t = re.sub(r"(\bvs\.?\b)", r"`\1`", t, flags=re.IGNORECASE)
    return t

# ----------------------------
# UI
# ----------------------------
st.set_page_config(layout="wide")
st.title("RKL Replay Board (offline) — with Manual Assist")

# Sidebar filters / queues
st.sidebar.header("Work Mode")
mode = st.sidebar.selectbox(
    "Queue",
    ["All", "Lineups (likely)", "Results (likely)", "Leaderboards (likely)"],
    index=0
)

st.sidebar.header("Filters")
kw = st.sidebar.text_input("Keyword (plain text contains)")

# Date filter
date_filter = st.sidebar.date_input(
    "Filter by date (game date in title)",
    value=None,
    format="MM/DD/YYYY"
)

only_threads = st.sidebar.checkbox("Threads only (feed)", value=True)
has_replies = st.sidebar.checkbox("Only threads with replies", value=False)

status_filter = st.sidebar.selectbox(
    "Status",
    ["All", "todo", "done", "review", "skipped"],
    index=0
)
hide_done = st.sidebar.checkbox("Hide done by default", value=True)

limit = st.sidebar.slider("Threads per page", 25, 200, 50, 25)

# Auto-Extract section
st.sidebar.divider()
st.sidebar.header("🤖 Auto-Extract")
st.sidebar.caption("Automatically extract lineup data from threads")

auto_skip_existing = st.sidebar.checkbox("Skip already-extracted", value=True, 
    help="Don't re-extract comments that have already been extracted")

if st.sidebar.button("Auto-extract current page", help="Extract all lineups from threads on this page"):
    st.session_state.auto_extract_pending = "page"
    
if st.sidebar.button("Auto-extract ALL matching", type="secondary",
    help="Extract from ALL threads matching current filters (may take a while)"):
    st.session_state.auto_extract_pending = "all"

# Keyset pagination state
if "cursor" not in st.session_state:
    st.session_state.cursor = None
if "cursor_history" not in st.session_state:
    st.session_state.cursor_history = []  # Stack of previous cursors for back navigation

# Build WHERE clause for threads
where = []
params = []

if only_threads:
    where.append("c.source = 'feed'")
if kw:
    where.append("c.plain_text LIKE ?")
    params.append(f"%{kw}%")
if date_filter:
    # Filter by the thread's posted date (converted to Eastern time in Python)
    # We'll filter by a date range in UTC that covers the Eastern day
    # Eastern day starts at 05:00 UTC (or 04:00 during DST)
    # For simplicity, filter by date portion of created_at_ts (close enough)
    date_str = date_filter.isoformat()
    where.append("DATE(c.created_at_ts) = ?")
    params.append(date_str)
if has_replies:
    where.append("COALESCE(c.reply_count,0) > 0")

# queue heuristics (SQL-friendly)
if mode == "Lineups (likely)":
    where.append("(c.plain_text LIKE '%Lineups%' OR lower(c.plain_text) LIKE '% vs %')")
    where.append("COALESCE(c.reply_count,0) > 0")
elif mode == "Results (likely)":
    where.append("(c.plain_text LIKE '%✅%' OR c.plain_text LIKE '%❌%')")
elif mode == "Leaderboards (likely)":
    where.append("(c.plain_text LIKE '%Top Team Scores%' OR c.plain_text LIKE '%Median%')")

# status filter via LEFT JOIN to thread_state
join_state = "LEFT JOIN thread_state s ON s.thread_id = c.comment_id"
if status_filter != "All":
    where.append("COALESCE(s.status,'todo') = ?")
    params.append(status_filter)
elif hide_done:
    where.append("COALESCE(s.status,'todo') != 'done'")

where_sql = ("WHERE " + " AND ".join(where)) if where else ""

# keyset cursor on created_at_ts + comment_id
cursor = st.session_state.cursor
if cursor:
    where_sql += (" AND " if where_sql else "WHERE ") + "(c.created_at_ts, c.comment_id) < (?, ?)"
    params.extend([cursor[0], cursor[1]])

threads = q(
    f"""
    SELECT c.comment_id, c.created_at_ts, c.reply_count, c.plain_text,
           COALESCE(s.status,'todo') AS status,
           (SELECT COUNT(*) FROM manual_extract e WHERE e.thread_id = c.comment_id) AS extract_count
    FROM rkl_comments c
    {join_state}
    {where_sql}
    ORDER BY c.created_at_ts DESC, c.comment_id DESC
    LIMIT ?
    """,
    tuple(params + [limit])
)

# Handle auto-extract requests
if st.session_state.get("auto_extract_pending") == "page" and threads:
    thread_ids = [int(r["comment_id"]) for r in threads]
    with st.spinner(f"Auto-extracting from {len(thread_ids)} threads..."):
        extracted, skipped, processed = run_auto_extract_bulk(thread_ids, auto_skip_existing)
    st.toast(f"✅ Extracted {extracted} lineups, skipped {skipped} (from {processed} threads)")
    st.session_state.auto_extract_pending = None
    st.rerun()

if st.session_state.get("auto_extract_pending") == "all":
    # Query ALL matching threads (no LIMIT)
    all_threads = q(
        f"""
        SELECT c.comment_id
        FROM rkl_comments c
        {join_state}
        {where_sql.replace("(c.created_at_ts, c.comment_id) < (?, ?)", "1=1") if cursor else where_sql}
        ORDER BY c.created_at_ts DESC
        """,
        tuple([p for p in params if p not in (cursor[0] if cursor else None, cursor[1] if cursor else None)])
        if cursor else tuple(params)
    )
    thread_ids = [int(r["comment_id"]) for r in all_threads]
    
    if thread_ids:
        with st.spinner(f"Auto-extracting from {len(thread_ids)} threads (this may take a while)..."):
            extracted, skipped, processed = run_auto_extract_bulk(thread_ids, auto_skip_existing)
        st.toast(f"✅ Extracted {extracted} lineups, skipped {skipped} (from {processed} threads)")
    else:
        st.toast("No threads match current filters")
    st.session_state.auto_extract_pending = None
    st.rerun()

colL, colR = st.columns([1, 2])

with colL:
    st.subheader("Threads")
    if not threads:
        st.info("No threads match filters.")
    else:
        for r in threads:
            status = r["status"]
            extract_count = r["extract_count"] or 0
            status_icon = {"todo":"⬜", "done":"✅", "review":"🟨", "skipped":"🚫"}.get(status, "⬜")
            extract_icon = f"📋{extract_count}" if extract_count > 0 else ""
            label = f"{status_icon} {r['created_at_ts'] or ''} · #{r['comment_id']} · replies:{r['reply_count'] or 0} {extract_icon}"
            if st.button(label, key=f"t{r['comment_id']}"):
                st.session_state.selected = int(r["comment_id"])
                st.session_state.reply_cursor = None
                st.session_state.extract_comment_id = int(r["comment_id"])
                st.session_state.extract_source = "feed"
            st.caption((r["plain_text"] or "")[:160])

        last = threads[-1]
        st.session_state.next_cursor = (last["created_at_ts"], last["comment_id"])

    c1, c2, c3 = st.columns(3)
    with c1:
        # Previous page - go back in cursor history
        can_go_back = len(st.session_state.cursor_history) > 0
        if st.button("◀ Prev page", disabled=not can_go_back):
            if st.session_state.cursor_history:
                st.session_state.cursor = st.session_state.cursor_history.pop()
                st.rerun()
    with c2:
        if st.button("Next page ▶") and threads:
            # Save current cursor to history before moving forward
            st.session_state.cursor_history.append(st.session_state.cursor)
            st.session_state.cursor = st.session_state.next_cursor
            st.rerun()
    with c3:
        if st.button("⏮ Reset"):
            st.session_state.cursor = None
            st.session_state.cursor_history = []
            st.rerun()

with colR:
    sel = st.session_state.get("selected")
    if not sel:
        st.info("Select a thread on the left.")
    else:
        thread = q("SELECT * FROM rkl_comments WHERE comment_id = ?", (sel,))
        thread_text = thread[0]["plain_text"] if thread else ""
        thread_created = thread[0]["created_at_ts"] if thread else None
        thread_reply_count = thread[0]["reply_count"] if thread else 0

        st.subheader(f"Thread #{sel}")

        # Thread status actions
        a1, a2, a3, a4, a5 = st.columns([1,1,1,1,1])
        def set_status(new_status: str):
            x(
                "INSERT INTO thread_state(thread_id,status,updated_at) VALUES (?,?,datetime('now')) "
                "ON CONFLICT(thread_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at",
                (sel, new_status)
            )
            st.toast(f"Thread #{sel} → {new_status}")
        if a1.button("✅ Done"):
            set_status("done"); st.rerun()
        if a2.button("🟨 Review"):
            set_status("review"); st.rerun()
        if a3.button("🚫 Skip"):
            set_status("skipped"); st.rerun()
        if a4.button("⬜ Todo"):
            set_status("todo"); st.rerun()
        if a5.button("🤖 Auto", help="Auto-extract all replies in this thread"):
            with st.spinner("Auto-extracting..."):
                extracted, skipped = run_auto_extract_for_thread(sel, skip_existing=True)
            st.toast(f"Extracted {extracted}, skipped {skipped}")
            st.rerun()

        st.markdown(highlight(thread_text) or "*[no text]*")

        st.divider()

        # Replies + pagination
        st.markdown(f"### Replies (expected: {thread_reply_count or 0})")
        if "reply_cursor" not in st.session_state:
            st.session_state.reply_cursor = None

        reply_kw = st.text_input("Filter replies (keyword contains)", key="reply_kw")

        params2 = [sel, sel]  # thread_root_id OR parent_comment_id
        where2 = "WHERE source='replies' AND (thread_root_id = ? OR parent_comment_id = ?)"
        if reply_kw:
            where2 += " AND plain_text LIKE ?"
            params2.append(f"%{reply_kw}%")

        if st.session_state.reply_cursor:
            where2 += " AND (created_at_ts, comment_id) < (?, ?)"
            params2.extend([st.session_state.reply_cursor[0], st.session_state.reply_cursor[1]])

        reps = q(
            f"""
            SELECT r.comment_id, r.created_at_ts, r.plain_text, r.thread_root_id, r.parent_comment_id,
                   (SELECT COUNT(*) FROM manual_extract e WHERE e.comment_id = r.comment_id) AS extracted
            FROM rkl_comments r
            {where2}
            ORDER BY created_at_ts DESC, comment_id DESC
            LIMIT 100
            """,
            tuple(params2)
        )

        def render_reply(r):
            """Render a single reply with extract button."""
            rid = int(r["comment_id"])
            rc = r["created_at_ts"] or ""
            is_extracted = r["extracted"] > 0
            extracted_badge = " ✅extracted" if is_extracted else ""
            st.caption(f"{rc} · reply #{rid} (root={r['thread_root_id']}, parent={r['parent_comment_id']}){extracted_badge}")

            b1, b2 = st.columns([1, 12])
            with b1:
                if st.button("Extract", key=f"ex{rid}"):
                    st.session_state.extract_comment_id = rid
                    st.session_state.extract_source = "replies"
                    st.toast(f"Selected reply #{rid} for extraction")
            with b2:
                st.markdown(highlight(r["plain_text"] or ""))
            st.divider()

        if not reps:
            st.info("No replies found (or filtered out). Try clearing the reply filter.")
        else:
            # Show first 5 replies directly
            VISIBLE_COUNT = 5
            visible_reps = reps[:VISIBLE_COUNT]
            hidden_reps = reps[VISIBLE_COUNT:]
            
            for r in visible_reps:
                render_reply(r)
            
            # Show remaining replies in expander
            if hidden_reps:
                with st.expander(f"Show {len(hidden_reps)} more replies..."):
                    for r in hidden_reps:
                        render_reply(r)

        if reps:
            last = reps[-1]
            if st.button("More replies"):
                st.session_state.reply_cursor = (last["created_at_ts"], last["comment_id"])
                st.rerun()
        if st.button("Back to newest replies"):
            st.session_state.reply_cursor = None
            st.rerun()

        # ----------------------------
        # Existing Extracts for this thread
        # ----------------------------
        thread_extracts = q(
            "SELECT * FROM manual_extract WHERE thread_id = ? ORDER BY id DESC",
            (sel,)
        )
        if thread_extracts:
            with st.expander(f"📋 Existing extracts for this thread ({len(thread_extracts)})", expanded=False):
                for ext in thread_extracts:
                    ext_id = ext["id"]
                    ext_comment = ext["comment_id"]
                    ext_kind = ext["kind"] or "?"
                    ext_date = ext["game_date"] or "?"
                    ext_team_a = ext["team_a"] or ""
                    ext_team_b = ext["team_b"] or ""
                    cap_a = ext["captain_a"] if "captain_a" in ext.keys() else ""
                    cap_b = ext["captain_b"] if "captain_b" in ext.keys() else ""
                    mentions_a = ext["mentions_a"] if "mentions_a" in ext.keys() else ""
                    mentions_b = ext["mentions_b"] if "mentions_b" in ext.keys() else ""
                    ext_score_a = ext["score_a"] if "score_a" in ext.keys() else None
                    ext_score_b = ext["score_b"] if "score_b" in ext.keys() else None
                    ext_winner = ext["winner"] if "winner" in ext.keys() else ""
                    ext_adj_a = ext["adjustment_a"] if "adjustment_a" in ext.keys() else None
                    ext_adj_b = ext["adjustment_b"] if "adjustment_b" in ext.keys() else None
                    is_auto = ext["notes"] == "auto-extracted"
                    auto_badge = " 🤖" if is_auto else ""

                    col_info, col_edit, col_del = st.columns([8, 1, 1])
                    with col_info:
                        # Build display line
                        display_line = f"**#{ext_comment}**{auto_badge} · {ext_kind} · {ext_date} · {ext_team_a} vs {ext_team_b}"
                        if ext_score_a or ext_score_b:
                            winner_mark = ""
                            if ext_winner == "A":
                                winner_mark = " ✅"
                            elif ext_winner == "B":
                                winner_mark = " ❌"
                            display_line += f" | {ext_score_a or '?'}{winner_mark} - {ext_score_b or '?'}"
                        st.markdown(display_line)
                        # Second line with details
                        detail_parts = []
                        if mentions_a or mentions_b:
                            detail_parts.append(f"A: {mentions_a or '-'} | B: {mentions_b or '-'}")
                        if cap_a or cap_b:
                            detail_parts.append(f"Caps: {cap_a or '-'}, {cap_b or '-'}")
                        if ext_adj_a or ext_adj_b:
                            detail_parts.append(f"Adj: {ext_adj_a or 0}, {ext_adj_b or 0}")
                        if detail_parts:
                            st.caption(" | ".join(detail_parts))
                    with col_edit:
                        if st.button("✏️", key=f"edit_{ext_id}", help="Edit this extract"):
                            st.session_state.editing_extract_id = ext_id
                    with col_del:
                        if st.button("🗑️", key=f"del_{ext_id}", help="Delete this extract"):
                            x("DELETE FROM manual_extract WHERE id = ?", (ext_id,))
                            st.rerun()

                    # Inline edit form
                    if st.session_state.get("editing_extract_id") == ext_id:
                        with st.container():
                            st.markdown("---")
                            e1, e2, e3, e4 = st.columns(4)
                            with e1:
                                new_team_a = st.text_input("Team A", value=ext_team_a, key=f"eta_{ext_id}")
                            with e2:
                                new_team_b = st.text_input("Team B", value=ext_team_b, key=f"etb_{ext_id}")
                            with e3:
                                new_cap_a = st.text_input("Cap A", value=cap_a, key=f"eca_{ext_id}")
                            with e4:
                                new_cap_b = st.text_input("Cap B", value=cap_b, key=f"ecb_{ext_id}")

                            e5, e6 = st.columns(2)
                            with e5:
                                new_mentions_a = st.text_input("Team A Players", value=mentions_a, key=f"ema_{ext_id}")
                            with e6:
                                new_mentions_b = st.text_input("Team B Players", value=mentions_b, key=f"emb_{ext_id}")

                            # Result fields for editing
                            e_r1, e_r2, e_r3, e_r4, e_r5 = st.columns([1, 1, 0.5, 1, 1])
                            with e_r1:
                                new_score_a = st.text_input("Score A", value=str(ext_score_a) if ext_score_a else "", key=f"esa_{ext_id}")
                            with e_r2:
                                new_score_b = st.text_input("Score B", value=str(ext_score_b) if ext_score_b else "", key=f"esb_{ext_id}")
                            with e_r3:
                                winner_opts = ["", "A", "B"]
                                new_winner = st.selectbox("Winner", options=winner_opts,
                                    index=winner_opts.index(ext_winner) if ext_winner in winner_opts else 0, key=f"ew_{ext_id}")
                            with e_r4:
                                new_adj_a = st.text_input("Adj A", value=str(ext_adj_a) if ext_adj_a else "", key=f"eaa_{ext_id}")
                            with e_r5:
                                new_adj_b = st.text_input("Adj B", value=str(ext_adj_b) if ext_adj_b else "", key=f"eab_{ext_id}")

                            e7, e8, e9 = st.columns([1,1,2])
                            with e7:
                                if st.button("💾 Save", key=f"save_{ext_id}"):
                                    # Parse floats
                                    def parse_edit_float(s):
                                        if not s:
                                            return None
                                        try:
                                            return float(s.replace(",", ""))
                                        except ValueError:
                                            return None
                                    x("""UPDATE manual_extract SET
                                         team_a=?, team_b=?, captain_a=?, captain_b=?,
                                         mentions_a=?, mentions_b=?, score_a=?, score_b=?,
                                         winner=?, adjustment_a=?, adjustment_b=?, notes=?
                                       WHERE id=?""",
                                      (new_team_a, new_team_b, new_cap_a, new_cap_b,
                                       new_mentions_a, new_mentions_b,
                                       parse_edit_float(new_score_a), parse_edit_float(new_score_b),
                                       new_winner or None, parse_edit_float(new_adj_a), parse_edit_float(new_adj_b),
                                       "" if is_auto else ext["notes"],  # Clear auto-extracted note on edit
                                       ext_id))
                                    st.session_state.editing_extract_id = None
                                    st.rerun()
                            with e8:
                                if st.button("Cancel", key=f"cancel_{ext_id}"):
                                    st.session_state.editing_extract_id = None
                                    st.rerun()
                            st.markdown("---")
        
        # ----------------------------
        # Manual Extract panel
        # ----------------------------
        st.divider()
        
        # Get all reply IDs for this thread (for navigation)
        all_replies = q(
            """SELECT comment_id FROM rkl_comments 
               WHERE source='replies' AND (thread_root_id = ? OR parent_comment_id = ?)
               ORDER BY created_at_ts ASC, comment_id ASC""",
            (sel, sel)
        )
        reply_ids = [int(r["comment_id"]) for r in all_replies]
        
        extract_id = int(st.session_state.get("extract_comment_id", sel))
        extract_source = st.session_state.get("extract_source", "feed")

        rec = q("SELECT comment_id, created_at_ts, plain_text, source FROM rkl_comments WHERE comment_id = ?", (extract_id,))
        extract_text = rec[0]["plain_text"] if rec else ""
        extract_created = rec[0]["created_at_ts"] if rec else None
        
        # Header row with title and quick navigation
        hdr1, hdr2, hdr3, hdr4, hdr5 = st.columns([3, 1, 1, 1, 1])
        with hdr1:
            st.markdown("## Manual Extract")
        
        # Find current position in reply list
        current_idx = None
        if extract_id in reply_ids:
            current_idx = reply_ids.index(extract_id)
        
        with hdr2:
            # Prev button
            can_go_prev = (current_idx is not None and current_idx > 0)
            if st.button("◀ Prev", help="Previous reply", disabled=not can_go_prev):
                if can_go_prev:
                    st.session_state.extract_comment_id = reply_ids[current_idx - 1]
                    st.session_state.extract_source = "replies"
                    st.rerun()
        
        with hdr3:
            # Next button
            can_go_next = reply_ids and (current_idx is None or current_idx < len(reply_ids) - 1)
            if st.button("Next ▶", help="Next reply", disabled=not can_go_next):
                if current_idx is None and reply_ids:
                    # Currently on thread or unknown - go to first reply
                    st.session_state.extract_comment_id = reply_ids[0]
                    st.session_state.extract_source = "replies"
                    st.rerun()
                elif current_idx is not None and current_idx < len(reply_ids) - 1:
                    st.session_state.extract_comment_id = reply_ids[current_idx + 1]
                    st.session_state.extract_source = "replies"
                    st.rerun()
        
        with hdr4:
            if st.button("⏮ Thread", help="Back to thread root"):
                st.session_state.extract_comment_id = sel
                st.session_state.extract_source = "feed"
                st.rerun()
        with hdr5:
            # Show position in reply list
            if current_idx is not None:
                st.caption(f"{current_idx + 1}/{len(reply_ids)}")
            elif reply_ids:
                st.caption(f"Thread (→{len(reply_ids)})")
            else:
                st.caption("Thread")
        
        # Check if this specific comment has already been extracted
        already_extracted = q(
            "SELECT id, kind, game_date, team_a, team_b FROM manual_extract WHERE comment_id = ? ORDER BY id DESC LIMIT 1",
            (extract_id,)
        )
        
        if already_extracted:
            ext = already_extracted[0]
            st.warning(f"⚠️ Already extracted: #{extract_id} → {ext['kind']} · {ext['game_date']} · {ext['team_a']} vs {ext['team_b']}")
        else:
            st.caption(f"Extracting from: #{extract_id} ({extract_source})")

        # Combined text for better detection (thread + selected reply)
        combined_text = (thread_text or "") + "\n\n" + (extract_text or "")

        kind_guess = guess_kind(extract_text)

        # Result-specific extraction
        result_data = None
        score_a_guess = None
        score_b_guess = None
        winner_guess = None
        adjustment_a_guess = None
        adjustment_b_guess = None
        matched_lineups = []
        linked_extract_id_guess = None

        if kind_guess == "result":
            result_data = extract_game_result(extract_text)
            if result_data:
                score_a_guess = result_data.get("score_a")
                score_b_guess = result_data.get("score_b")
                winner_guess = result_data.get("winner")
                adjustment_a_guess = result_data.get("adjustment_a")
                adjustment_b_guess = result_data.get("adjustment_b")

        # Get teams - prefer result data if available
        if result_data and result_data.get("team_a"):
            team_a_guess = result_data["team_a"]
            team_b_guess = result_data.get("team_b")
            seed_a_guess = result_data.get("seed_a")
            seed_b_guess = result_data.get("seed_b")
            round_name_guess = result_data.get("round_name")
        else:
            team_a_guess, team_b_guess = guess_teams(combined_text)
            # Postseason detection
            round_name_guess, seed_a_guess, seed_b_guess = detect_postseason_info(extract_text)

        # Team-specific mentions
        mentions_a_guess, mentions_b_guess, all_mentions_guess = extract_mentions_by_team(extract_text)

        # Captain detection
        captain_a_guess, captain_b_guess, captain_candidates = detect_captains(extract_text)

        # date guess uses thread's posted date in Eastern time
        thread_date_guess = infer_game_date(thread_created)
        game_date_guess = thread_date_guess

        # For results, try to find matching lineup to get correct game date
        if kind_guess == "result" and team_a_guess and team_b_guess:
            matched_lineups = find_all_matching_lineups(team_a_guess, team_b_guess, thread_date_guess)
            if matched_lineups:
                # Use the best match's date
                best_match = matched_lineups[0]
                game_date_guess = best_match["game_date"]
                linked_extract_id_guess = best_match["id"]

        # Build captain dropdown options: candidates first, then all mentions, with blank option
        captain_options = [""] + list(dict.fromkeys(captain_candidates + all_mentions_guess))
        
        def safe_index(lst, val, default=0):
            try:
                return lst.index(val)
            except ValueError:
                return default

        # Compact form layout
        row1a, row1b, row1c, row1d = st.columns([1, 1, 1, 1])
        with row1a:
            kind = st.selectbox("Type", ["lineup","result","leaderboard","other"], index=["lineup","result","leaderboard","other"].index(kind_guess))
        with row1b:
            game_date = st.text_input("Game date", value=game_date_guess or "", placeholder="YYYY-MM-DD")
        with row1c:
            team_a = st.text_input("Team A", value=team_a_guess or "")
        with row1d:
            team_b = st.text_input("Team B", value=team_b_guess or "")

        # Captains and seeds row
        row2a, row2b, row2c, row2d, row2e = st.columns([1, 1, 0.5, 0.5, 2])
        with row2a:
            captain_a = st.selectbox("Cap A", options=captain_options, index=safe_index(captain_options, captain_a_guess, 0))
        with row2b:
            captain_b = st.selectbox("Cap B", options=captain_options, index=safe_index(captain_options, captain_b_guess, 0))
        with row2c:
            seed_a = st.text_input("Seed A", value=seed_a_guess or "", placeholder="#")
        with row2d:
            seed_b = st.text_input("Seed B", value=seed_b_guess or "", placeholder="#")
        with row2e:
            round_name = st.text_input("Round", value=round_name_guess or "", placeholder="e.g., RKL Finals")

        # Team mentions row
        row3a, row3b = st.columns(2)
        with row3a:
            mentions_a = st.text_input("Team A Players", value=", ".join(mentions_a_guess), help="Comma-separated")
        with row3b:
            mentions_b = st.text_input("Team B Players", value=", ".join(mentions_b_guess), help="Comma-separated")

        # Result-specific fields (scores, winner, adjustments)
        row4a, row4b, row4c, row4d, row4e = st.columns([1, 1, 0.5, 1, 1])
        with row4a:
            score_a_str = st.text_input("Score A", value=str(score_a_guess) if score_a_guess else "", placeholder="e.g., 34565")
        with row4b:
            score_b_str = st.text_input("Score B", value=str(score_b_guess) if score_b_guess else "", placeholder="e.g., 37201")
        with row4c:
            winner_options = ["", "A", "B"]
            winner = st.selectbox("Winner", options=winner_options, index=winner_options.index(winner_guess) if winner_guess in winner_options else 0)
        with row4d:
            adj_a_str = st.text_input("Adj A", value=str(adjustment_a_guess) if adjustment_a_guess else "", placeholder="e.g., -1950")
        with row4e:
            adj_b_str = st.text_input("Adj B", value=str(adjustment_b_guess) if adjustment_b_guess else "", placeholder="e.g., -1500")

        # Parse score/adjustment strings to floats
        def parse_float(s):
            if not s:
                return None
            try:
                return float(s.replace(",", ""))
            except ValueError:
                return None

        score_a = parse_float(score_a_str)
        score_b = parse_float(score_b_str)
        adjustment_a = parse_float(adj_a_str)
        adjustment_b = parse_float(adj_b_str)

        # For results: show matched lineups and allow selection
        linked_extract_id = None
        if kind == "result" and matched_lineups:
            st.markdown("#### 🔗 Matched Lineup")
            # Build options: "date - team_a vs team_b (id: X)" or "None (use thread date)"
            lineup_options = ["(None - use thread date)"]
            lineup_id_map = {0: None}  # index -> extract_id

            for i, lu in enumerate(matched_lineups):
                exact = "✓" if lu.get("exact_match") else ""
                option_text = f"{lu['game_date']} - {lu['team_a']} vs {lu['team_b']} {exact}"
                lineup_options.append(option_text)
                lineup_id_map[i + 1] = lu["id"]

            # Default to first match (index 1) if we have matches
            default_idx = 1 if len(lineup_options) > 1 else 0

            selected_idx = st.selectbox(
                "Link to lineup (auto-sets game date)",
                range(len(lineup_options)),
                format_func=lambda x: lineup_options[x],
                index=default_idx,
                key=f"lineup_select_{extract_id}"
            )

            linked_extract_id = lineup_id_map.get(selected_idx)

            # Update game_date based on selection
            if linked_extract_id:
                for lu in matched_lineups:
                    if lu["id"] == linked_extract_id:
                        game_date = lu["game_date"]
                        break
            else:
                game_date = thread_date_guess

        # Show detection hints
        hints = []
        if captain_candidates:
            hints.append(f"🎖️ Captains: {', '.join(captain_candidates)}")
        if round_name_guess:
            hints.append(f"🏆 Postseason: {round_name_guess}")
        if score_a_guess or score_b_guess:
            hints.append(f"📊 Scores detected: {score_a_guess} vs {score_b_guess}")
        if linked_extract_id:
            hints.append(f"🔗 Linked to lineup #{linked_extract_id}")
        if hints:
            st.caption(" | ".join(hints))

        notes = st.text_area("Notes", value="", height=60)
        
        # Collapsible raw text (saves space)
        with st.expander("Raw text (for reference)", expanded=False):
            st.code(extract_text or "", language=None)

        # Save buttons row
        save1, save2, save3 = st.columns([1, 1, 2])
        
        def do_save():
            x("""
              INSERT INTO manual_extract(
                created_at, thread_id, comment_id, source, kind, game_date, team_a, team_b,
                mentions, notes, raw_text, captain_a, captain_b, mentions_a, mentions_b,
                seed_a, seed_b, round_name, score_a, score_b, winner, adjustment_a, adjustment_b,
                linked_extract_id
              ) VALUES (datetime('now'),?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (sel, extract_id, extract_source, kind, game_date, team_a, team_b,
                  "", notes, extract_text, captain_a or None, captain_b or None,
                  mentions_a or None, mentions_b or None, seed_a or None, seed_b or None,
                  round_name or None, score_a, score_b, winner or None, adjustment_a, adjustment_b,
                  linked_extract_id))
        
        with save1:
            if st.button("💾 Save", use_container_width=True):
                do_save()
                st.success("Saved!")
        
        with save2:
            if st.button("💾 Save & Next ▶", type="primary", use_container_width=True):
                do_save()
                # Advance to next reply using current_idx
                if current_idx is None and reply_ids:
                    st.session_state.extract_comment_id = reply_ids[0]
                    st.session_state.extract_source = "replies"
                    st.toast(f"Saved & moved to reply 1/{len(reply_ids)}")
                elif current_idx is not None and current_idx < len(reply_ids) - 1:
                    st.session_state.extract_comment_id = reply_ids[current_idx + 1]
                    st.session_state.extract_source = "replies"
                    st.toast(f"Saved & advanced to reply {current_idx + 2}/{len(reply_ids)}")
                else:
                    st.toast("Saved! (was last reply)")
                st.rerun()
        
        with save3:
            if st.button("⏭ Skip to Next", help="Skip without saving"):
                if current_idx is None and reply_ids:
                    st.session_state.extract_comment_id = reply_ids[0]
                    st.session_state.extract_source = "replies"
                elif current_idx is not None and current_idx < len(reply_ids) - 1:
                    st.session_state.extract_comment_id = reply_ids[current_idx + 1]
                    st.session_state.extract_source = "replies"
                st.rerun()

        # Export extracts
        st.markdown("### Export")
        extracts = q("SELECT * FROM manual_extract ORDER BY id DESC LIMIT 50000")
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["id","created_at","thread_id","comment_id","source","kind","game_date",
                    "team_a","team_b","captain_a","captain_b","mentions_a","mentions_b",
                    "seed_a","seed_b","round_name","score_a","score_b","winner",
                    "adjustment_a","adjustment_b","linked_extract_id","notes"])

        def safe_get(row, col):
            try:
                return row[col] if col in row.keys() else ""
            except:
                return ""

        for r in extracts:
            w.writerow([
                r["id"], r["created_at"], r["thread_id"], r["comment_id"], r["source"],
                r["kind"], r["game_date"], r["team_a"], r["team_b"],
                safe_get(r, "captain_a"), safe_get(r, "captain_b"),
                safe_get(r, "mentions_a"), safe_get(r, "mentions_b"),
                safe_get(r, "seed_a"), safe_get(r, "seed_b"), safe_get(r, "round_name"),
                safe_get(r, "score_a"), safe_get(r, "score_b"), safe_get(r, "winner"),
                safe_get(r, "adjustment_a"), safe_get(r, "adjustment_b"),
                safe_get(r, "linked_extract_id"),
                r["notes"]
            ])

        st.download_button(
            "Download manual_extract.csv",
            data=buf.getvalue().encode("utf-8"),
            file_name="manual_extract.csv",
            mime="text/csv",
        )

st.caption("Tip: Queue modes + status tracking + Extract button should eliminate most copy/paste. 🎖️ = captain, 🏆 = postseason")