# Seed Minor League Players

This directory contains scripts to seed the `minor_v2_players` collection in Firestore from CSV data.

## Overview

The seeding process:
1. Fetches player data from a Google Sheets CSV export
2. Creates player documents in `minor_v2_players` collection
3. Creates `seasonal_stats/S9` subcollections for each player
4. Generates a rollback file for reversibility

## Files

- **seed-minor-players.js** - Main seeding script
- **rollback-minor-players.js** - Rollback/deletion script
- **rollback/** - Directory containing rollback data files

## Prerequisites

1. Node.js 18+ installed (this project uses Node 22)
2. Firebase Admin SDK configured
3. Required npm packages:
   ```bash
   npm install firebase-admin
   ```
   Note: `node-fetch` is not required as fetch is built-in for Node.js 18+

## Data Source

**CSV URL:** https://docs.google.com/spreadsheets/d/e/2PACX-1vR2E--N7B6cD-_HWaIpxIObmDVuIxqgXhfHkf6vE1FGHeAccozSl416DtQF-lGeWUhiF_Bm-geu9yMU/pub?output=csv

**CSV Structure:**
```csv
player_handle,player_id,current_team_id
tahadd,WJqABwDJ,HSK
oscar_rios10,Y3OqYyXJ,HSK
...
```

## Player Document Structure

Each player document is created at `minor_v2_players/{player_id}` with:

### Root Document Fields
```javascript
{
  player_id: string,
  player_handle: string,
  player_status: "ACTIVE",
  current_team_id: string
}
```

### Seasonal Stats Subcollection
Path: `minor_v2_players/{player_id}/seasonal_stats/S9`

All stats fields are initialized to 0:
- Regular season stats: `aag_mean`, `aag_median`, `games_played`, `GEM`, `total_points`, `WAR`, etc.
- Postseason stats: `post_aag_mean`, `post_games_played`, `post_total_points`, etc.
- Leaderboard ranks: `total_points_rank`, `GEM_rank`, `WAR_rank`, etc.
- Metadata: `rookie`, `all_star`, `season`

## Usage

### 1. Seed Players

Run the seeding script:

```bash
node scripts/seed-minor-players.js
```

**What it does:**
1. Fetches CSV data from Google Sheets
2. Validates player data (skips entries without `player_id`)
3. Waits 5 seconds for confirmation (Ctrl+C to cancel)
4. Creates player documents in batches
5. Creates seasonal_stats subcollections
6. Saves rollback data to `scripts/rollback/minor-players-S9-<timestamp>.json`

**Example Output:**
```
============================================================
SEED MINOR LEAGUE PLAYERS
============================================================
Collection: minor_v2_players
Season: S9
CSV Source: https://docs.google.com/...
============================================================
✓ Fetched 148 players from CSV
✓ Found 143 valid players (with player_id)

⚠️  WARNING: This will create player documents in Firestore.
Press Ctrl+C to cancel, or wait 5 seconds to continue...

Seeding 148 players to minor_v2_players...
⚠️  Skipping player lucas - no player_id
✓ Committed batch (100 players processed)
✓ Committed final batch

✓ Successfully created 143 players
⚠️  Skipped 5 players (missing player_id)

✓ Rollback data saved to: scripts/rollback/minor-players-S9-1732147890123.json
  To rollback, run: node scripts/rollback-minor-players.js minor-players-S9-1732147890123.json
```

### 2. Rollback (If Needed)

If something goes wrong or you need to undo the seeding:

```bash
node scripts/rollback-minor-players.js <rollback-file.json>
```

**Example:**
```bash
node scripts/rollback-minor-players.js minor-players-S9-1732147890123.json
# or with full path:
node scripts/rollback-minor-players.js scripts/rollback/minor-players-S9-1732147890123.json
```

**What it does:**
1. Loads the rollback data file
2. Shows details (timestamp, collection, number of players)
3. Waits 5 seconds for confirmation (Ctrl+C to cancel)
4. Deletes all seasonal_stats subcollection documents
5. Deletes all player documents
6. Archives the rollback file

**Example Output:**
```
============================================================
ROLLBACK MINOR LEAGUE PLAYERS
============================================================
Rollback file: minor-players-S9-1732147890123.json
Timestamp: 2024-11-21T10:31:30.123Z
Collection: minor_v2_players
Season: S9
Players to delete: 143
============================================================

⚠️  WARNING: This will DELETE player documents from Firestore.
This action cannot be undone!
Press Ctrl+C to cancel, or wait 5 seconds to continue...

Deleting 143 players from minor_v2_players...
✓ Deleted 143 of 143 players

============================================================
✓ ROLLBACK COMPLETE
============================================================
Total players deleted: 143
============================================================
```

## Configuration

Edit `seed-minor-players.js` to change:

```javascript
const CSV_URL = "...";                          // Source CSV URL
const SEASON_ID = "S9";                        // Season identifier
const COLLECTION_NAME = "minor_v2_players";    // Target collection
const BATCH_SIZE = 500;                        // Firestore batch size
```

## Notes

- **Player Validation:** Players without a `player_id` are automatically skipped and logged
- **Batching:** Operations are batched to stay within Firestore limits (500 operations per batch)
- **Safety:** 5-second delay before execution allows cancellation
- **Reversibility:** Every seeding operation creates a rollback file
- **Idempotency:** Re-running the seed script will overwrite existing documents (not create duplicates)

## Troubleshooting

**Error: "Failed to fetch CSV"**
- Check internet connection
- Verify CSV URL is accessible
- Ensure Google Sheet is published

**Error: "Permission denied"**
- Verify Firebase Admin SDK is properly initialized
- Check Firestore security rules
- Ensure you have admin permissions

**Error: "Rollback file not found"**
- Check the filename/path is correct
- Look in `scripts/rollback/` directory
- Ensure the rollback file was created during seeding

## Related Files

- `/home/user/real-karma-league/scripts/seed-firestore.js` - Main major league seeding script
- `/home/user/real-karma-league/scripts/initialize-minor-league.js` - Minor league initialization
- `/home/user/real-karma-league/minplayers.md` - Original requirements document
