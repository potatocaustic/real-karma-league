# Migration Scripts

This directory contains one-time migration scripts for database maintenance.

## migrate-minor-league-snapshots.js

Migrates minor league game flow snapshot data from the major league collection (`game_flow_snapshots`) to the proper minor league collection (`minor_game_flow_snapshots`).

### Background

Due to a bug in the Firebase collection naming helper (fixed in commit 7b00db1), minor league game snapshots were incorrectly being written to the major league `game_flow_snapshots` collection. This script identifies and migrates those snapshots to the correct location.

### Prerequisites

You need Firebase Admin credentials to run this script. Set up authentication using one of these methods:

1. **Service Account Key (Recommended for local execution)**:
   ```bash
   export GOOGLE_APPLICATION_CREDENTIALS="/path/to/serviceAccountKey.json"
   ```

2. **Application Default Credentials**:
   ```bash
   gcloud auth application-default login
   ```

### Usage

```bash
# From the functions directory:
cd functions

# Dry run (recommended first) - shows what would be migrated without making changes
node scripts/migrate-minor-league-snapshots.js --dry-run

# Migrate snapshots (keeps originals in game_flow_snapshots)
node scripts/migrate-minor-league-snapshots.js

# Migrate and delete originals from game_flow_snapshots
node scripts/migrate-minor-league-snapshots.js --delete
```

### Options

- `--dry-run` - Shows what would be migrated without making any changes
- `--delete` - Deletes migrated snapshots from the original `game_flow_snapshots` collection after copying

### What it does

1. Collects all minor league game IDs by querying:
   - All seasons in `minor_seasons` collection
   - All games in each season's `games` and `post_games` subcollections
   - Currently live games in `minor_live_games` collection

2. Finds snapshot documents in `game_flow_snapshots` that match minor league game IDs

3. Copies those snapshots to `minor_game_flow_snapshots` collection

4. Optionally deletes the originals (if `--delete` flag is used)

### Safety

- Uses Firestore batched writes for atomic operations
- Handles large datasets by processing in batches of 500 documents
- Includes dry-run mode for safe preview before migration
- Preserves all snapshot data during migration

### When to run

Run this script once after deploying the fix from commit 7b00db1. After running:

1. Verify the migrated data in `minor_game_flow_snapshots`
2. Check that minor league game flow charts display correctly in the frontend
3. Run again with `--delete` flag to clean up the misplaced snapshots from `game_flow_snapshots` (optional)

---

## migrate-draft-prospects.js

Migrates S9 draft prospects from `minor_seasons/S9/draft_prospects` to `seasons/S9/draft_prospects`.

### Background

Draft prospects were mistakenly entered into the minor league collection when the user had `localStorage.rkl_current_league` set to `'minor'` from a previous session. The draft prospect entry code is working correctly; this was a user error from not noticing the league context indicator.

### Prerequisites

Same as above - you need Firebase Admin credentials via `GOOGLE_APPLICATION_CREDENTIALS` environment variable or Application Default Credentials.

### Usage

```bash
# From the functions directory:
cd functions

# Dry run (default) - shows document count and sample data
node scripts/migrate-draft-prospects.js

# Execute migration (keeps originals)
node scripts/migrate-draft-prospects.js --execute

# Execute migration and delete originals
node scripts/migrate-draft-prospects.js --execute --delete
```

### Options

- `--execute` - Actually perform the migration (default is dry run)
- `--delete` - Delete from minor league collection after copying

### What it does

1. Reads all documents from `minor_seasons/S9/draft_prospects`
2. Shows document count and sample data (player handles, karma values)
3. If `--execute` is specified, copies documents to `seasons/S9/draft_prospects`
4. If `--delete` is also specified, removes the source documents

### Safety

- Dry run mode by default (must explicitly use `--execute`)
- Uses Firestore batched writes for atomic operations
- Shows preview of data before migration

---

## verify-rks9-optimization.js

Read-only verification script to validate the RKL-S9.js efficiency optimizations.

### Background

The RKL-S9.js file was refactored from bulk upfront loading (fetching ALL games from 3 collections at page load) to on-demand lazy loading with caching. This script verifies the production data structure to confirm the optimization assumptions.

### Usage

```bash
cd functions
node scripts/verify-rks9-optimization.js
```

### What it verifies

1. **Game counts** - Counts games in each collection (games, post_games, exhibition_games) for both Major and Minor leagues
2. **Live games** - Verifies that `live_games` documents have the `collectionName` field
3. **Finals query** - Tests the optimized Finals query (`where('series_id', '==', 'Finals'), limit(1)`)
4. **Incomplete postseason query** - Tests the query for counting remaining teams
5. **Recent games simulation** - Shows what `loadRecentGames()` would fetch
6. **Live scoring status** - Shows current scoring status

### Output

The script outputs a summary comparing old vs new document read counts and estimated savings (90-98% reduction).

---

## fix-s9-season-completion.js

One-time data fix script to clean up orphaned incomplete Finals games and mark S9 as complete.

### Background

The S9 season has orphaned incomplete Finals games that prevent correct season completion display. The `advanceBracket` function should have deleted these incomplete games when the series winner was set, but this didn't run properly after the Finals concluded.

### Prerequisites

Same as above - you need Firebase Admin credentials via `GOOGLE_APPLICATION_CREDENTIALS` environment variable.

### Usage

```bash
cd functions

# Dry run (default) - shows what would be changed
node scripts/fix-s9-season-completion.js

# Execute the fix
node scripts/fix-s9-season-completion.js --execute
```

### What it does

1. Finds incomplete Finals games (`completed == 'FALSE'` and `series_id == 'Finals'`)
2. Verifies there's already a completed Finals game with a `series_winner`
3. Deletes the orphaned incomplete Finals games
4. Sets S9's `current_week` to "Season Complete"

### Safety

- Dry run mode by default (must explicitly use `--execute`)
- Validates that a Finals winner exists before proceeding
- Uses Firestore batched writes for atomic operations
- Shows detailed preview of what will be changed
