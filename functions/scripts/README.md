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
