# Game Data Extraction Tool - Progress Report

## Overview

This document tracks progress on the **RKL Replay Board** tool (`app.py`), a Streamlit application designed to parse historical game data from scraped RealApp comments for the Real Karma League website.

### Problem Statement

The RKL has years of historical game data stored in RealApp comments (group ID 17515). This data includes:
- **Lineups**: Team compositions with player @mentions, captains, and game dates
- **Results**: Final scores, winners, and point adjustments
- **Leaderboards**: Weekly standings and statistics

The challenge: This data exists only in unstructured text posts and needs to be parsed into structured database records for the website.

---

## Completed Features

### 1. Core Infrastructure

- **SQLite Database** (`rkl.db`)
  - `rkl_comments` table: Raw scraped comments from RealApp
  - `thread_state` table: Workflow status tracking (todo/done/review/skipped)
  - `manual_extract` table: Parsed game data records

- **Database Migrations**: Automatic column additions for new fields without data loss

### 2. Lineup Parsing

**Commit:** `a3ec0a5` - Initial upload

Extracts from lineup posts:
- **Team Names**: Multiple detection strategies (inline "vs", standalone "vs" divider, result format)
- **Player Mentions**: Splits into Team A and Team B based on "vs" divider position
- **Captains**: Detects via `(c)` markers, plain "c" suffix, or emoji-only trailing content
- **Game Date**: Inferred from thread post timestamp (converted to US Eastern time)
- **Postseason Info**: Round names (Finals, Semifinals, etc.) and team seeds

**Key Functions:**
- `guess_teams()` - Multi-strategy team name detection
- `extract_mentions_by_team()` - Splits @mentions by team
- `detect_captains()` - Identifies captain markers
- `detect_postseason_info()` - Extracts round/seed data

### 3. Result Parsing

**Commit:** `a15674b` - Add game results parsing and extraction support

Extracts from result posts:
- **Scores**: Parses formats like "34,565" or "47,547.5"
- **Winner**: Detected via ✅/❌ emoji or `:check_mark_button:`/`:cross_mark:` RealApp codes
- **Team Records**: Parses "(W-L)" or "(W-L-T)" patterns
- **Adjustments**: Extracts penalty/bonus lines like "TeamName -1950"

**Key Regex Patterns:**
```python
RESULT_FULL_RE = re.compile(
    r"^\s*(?:\((\d+)\)\s*|(\d+)\.\s*)?(.+?)\s*\((\d+)-(\d+)(?:-\d+)?\)\s*[-–:]\s*([\d,]+(?:\.\d+)?)\s*(.*)$"
)
ADJUSTMENT_LINE_RE = re.compile(
    r"^\s*([A-Za-z][A-Za-z0-9\s]+?)\s+([+-]?\d[\d,]*(?:\.\d+)?)\s*$"
)
```

### 4. Post Type Detection

**Commit:** `573d7a8` - Improve result detection and lineup matching accuracy

The `guess_kind()` function classifies posts:
- **Leaderboard**: Contains "Top Team Scores" or "Median"
- **Result**: Has win/loss markers + scores, or 2+ team records with scores
- **Lineup**: Contains "Lineups" or "vs" with @mentions
- **Other**: Default fallback

**Detection Signals:**
- Win/loss emoji (✅❌🏆) and RealApp codes
- Score number patterns (4-6 digits with optional commas)
- Team record patterns like `(10-4)`
- Separator lines (`---`)

### 5. Automatic Lineup-to-Result Matching

**Commit:** `488a7c1` - Add automatic lineup-to-result matching for correct game dates

**Problem:** Results are often posted the morning after games, so the post date doesn't reflect the actual game date.

**Solution:** Match result posts to existing lineup extracts using team names:

```python
def find_matching_lineup(team_a: str, team_b: str, result_date: str) -> dict | None
def find_all_matching_lineups(team_a: str, team_b: str, result_date: str) -> list[dict]
def _teams_match(lineup_a, lineup_b, result_a, result_b) -> tuple[bool, bool, int]
```

**Matching Logic:**
- Exact match: Both team names identical (score: 100)
- Fuzzy match: Names contain each other (score: 50-90 based on length ratio)
- **Both teams must match** - prevents false positives
- Results sorted by match score descending, then date descending

### 6. Result-Lineup Row Merging

**Commit:** `c812f3a` - Update linked lineup row instead of creating new result row

When a result is linked to a lineup:
- **Updates** the existing lineup row with score/winner/adjustment data
- **Does not** create a duplicate row
- Keeps all data for one game in a single record

### 7. Two-Phase Extraction Workflow

**Commit:** `aa38d7f` - Add two-phase extraction workflow for lineups and results

**UI Controls:**
- Radio buttons: "Lineups only", "Results only", "Both"
- Buttons: "📄 This page", "📚 All matching"

**Workflow:**
1. Run with "Lineups only" to extract all lineup data first
2. Run with "Results only" to extract results and link to existing lineups
3. Results update their linked lineup rows instead of creating new records

**Skip Logic:**
- Lineups: Skip if comment already extracted
- Results: Skip if linked lineup already has score data

---

## Database Schema

### `manual_extract` Table

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER | Primary key |
| `created_at` | TEXT | Extraction timestamp |
| `thread_id` | INTEGER | Parent thread ID |
| `comment_id` | INTEGER | Source comment ID |
| `source` | TEXT | "feed" or "replies" |
| `kind` | TEXT | "lineup", "result", "leaderboard", "other" |
| `game_date` | TEXT | YYYY-MM-DD format |
| `team_a` | TEXT | Team A name |
| `team_b` | TEXT | Team B name |
| `captain_a` | TEXT | Team A captain username |
| `captain_b` | TEXT | Team B captain username |
| `mentions_a` | TEXT | Team A players (comma-separated) |
| `mentions_b` | TEXT | Team B players (comma-separated) |
| `seed_a` | TEXT | Team A postseason seed |
| `seed_b` | TEXT | Team B postseason seed |
| `round_name` | TEXT | Postseason round (e.g., "RKL Finals") |
| `score_a` | REAL | Team A final score |
| `score_b` | REAL | Team B final score |
| `winner` | TEXT | "A" or "B" |
| `adjustment_a` | REAL | Team A score adjustment |
| `adjustment_b` | REAL | Team B score adjustment |
| `linked_extract_id` | INTEGER | FK to lineup extract (for results) |
| `raw_text` | TEXT | Original comment text |
| `notes` | TEXT | Manual notes or "auto-extracted" |

---

## Bug Fixes

### TypeError in Sort (Commit: `6fd9460`)

**Issue:** `TypeError: bad operand type for unary -: 'str'` when sorting matches by date.

**Cause:** Attempted to negate a string date in sort key: `-(x["game_date"] or "0000-00-00")`

**Fix:** Two-pass stable sort:
```python
results.sort(key=lambda x: (x["game_date"] or "0000-00-00"), reverse=True)  # Date desc
results.sort(key=lambda x: -x["match_score"])  # Score desc (stable preserves date order)
```

### Result Detection (Commit: `573d7a8`)

**Issue:** Many result posts not being recognized.

**Cause:** Only checked for Unicode emoji, not RealApp emoji codes.

**Fix:** Added detection for:
- RealApp codes: `:check_mark_button:`, `:cross_mark:`
- Team record patterns: `(10-4)`
- Score + separator combinations

### Matching Accuracy (Commit: `573d7a8`)

**Issue:** Auto-matching suggested wrong lineups; was matching if EITHER team appeared ANYWHERE.

**Fix:** Required BOTH teams to match with the `_teams_match()` scoring function.

---

## UI Features

### Thread List (Left Panel)
- Status icons: ⬜ todo, ✅ done, 🟨 review, 🚫 skipped
- Extract count badge: 📋N
- Keyword search
- Date filtering
- Queue modes: Lineups, Results, Leaderboards

### Thread Detail (Right Panel)
- Status action buttons
- Reply list with extract buttons
- Collapsible existing extracts with inline editing
- Manual extract form with auto-detection
- Prev/Next reply navigation
- Export to CSV

### Auto-Extract Controls (Sidebar)
- Skip already-extracted checkbox
- Extract type radio: Lineups only / Results only / Both
- This page / All matching buttons

---

## Usage Guide

### Basic Workflow

1. **Start the app:**
   ```bash
   streamlit run app.py
   ```

2. **Filter threads** using sidebar controls (date, keyword, queue mode)

3. **Extract lineups first:**
   - Select "Lineups only"
   - Click "📚 All matching" to bulk extract

4. **Extract results second:**
   - Select "Results only"
   - Click "📚 All matching"
   - Results will link to and update matching lineup rows

5. **Manual review:**
   - Click threads to inspect
   - Use "Extract" button on replies for manual extraction
   - Edit existing extracts inline

6. **Export:**
   - Click "Download manual_extract.csv" at bottom of detail panel

### Tips

- Use "Lineups (likely)" queue mode to focus on lineup posts
- Use "Results (likely)" queue mode to focus on result posts
- Mark threads as "done" after reviewing to track progress
- The 🤖 badge indicates auto-extracted records

---

## Files

| File | Description |
|------|-------------|
| `app.py` | Main Streamlit application (81KB, ~2000 lines) |
| `rkl.db` | SQLite database with comments and extracts |
| `rkl_comments.sql` | Source SQL dump (not in repo) |

---

## Future Improvements

Potential enhancements not yet implemented:

1. **Batch editing** - Edit multiple extracts at once
2. **Duplicate detection** - Flag potential duplicate extracts
3. **Validation rules** - Ensure scores are reasonable, dates in range
4. **Statistics dashboard** - Show extraction progress metrics
5. **Undo functionality** - Revert recent changes
6. **Player name normalization** - Handle username variations

---

## Commit History

| Hash | Description |
|------|-------------|
| `aa38d7f` | Add two-phase extraction workflow for lineups and results |
| `c812f3a` | Update linked lineup row instead of creating new result row |
| `6fd9460` | Fix TypeError in sort: can't negate string for date sorting |
| `573d7a8` | Improve result detection and lineup matching accuracy |
| `488a7c1` | Add automatic lineup-to-result matching for correct game dates |
| `a15674b` | Add game results parsing and extraction support |
| `a3ec0a5` | Initial app.py upload |

---

*Last updated: 2026-01-12*
