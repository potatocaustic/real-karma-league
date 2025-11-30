# Minor League Draft Picks Seeder

This script populates the `minor_draftPicks` collection in Firestore with draft capital data for minor league teams based on the contents of `minor-draft-capital.md`.

## Overview

The minor league draft structure mirrors the major league draft system, with the key difference being that **minor league teams have 2 rounds of draft picks** while major league teams have 3 rounds.

## Data Source

The script reads from `minor-draft-capital.md` which contains historical draft pick trades organized by season, showing:
- **Incoming picks**: Draft picks acquired from other teams via trades
- **Outgoing picks**: Draft picks traded away to other teams

## Collection Structure

Each draft pick document in `minor_draftPicks` follows this schema:

```javascript
{
  pick_id: "S10_Buffalos_1",           // Format: {season}_{team}_{round}
  pick_description: "S10 Buffalos 1st", // Human-readable description
  season: 10,                           // Season number (integer)
  round: 1,                             // Round number (1 or 2)
  original_team: "Buffalos",            // Team that originally owned this pick
  current_owner: "SuperSonics",         // Team that currently owns this pick
  acquired_week: null,                  // Week when pick was acquired (if traded)
  base_owner: null,                     // Additional ownership tracking field
  notes: "Traded to SuperSonics",       // Trade notes
  trade_id: null                        // Reference to trade transaction
}
```

## How It Works

The seeder performs the following steps:

1. **Parse markdown file**: Extracts draft pick data from `minor-draft-capital.md` for all seasons (S9-S14)

2. **Generate all picks**: Creates 2 draft picks (rounds 1-2) for each of the 29 minor league teams for each season
   - Total picks generated: 29 teams × 2 rounds × 6 seasons = **348 draft picks**

3. **Process trades**: Updates `current_owner` field based on trades documented in the markdown:
   - If a team has incoming picks, those picks' `current_owner` is updated to that team
   - If a team's outgoing shows "(traded)", that pick's ownership goes to whoever has it in their incoming list
   - Team name changes (e.g., Bullets → Strips) are handled so picks from old team names don't create false trades

4. **Write to Firestore**: Commits all draft picks to the `minor_draftPicks` collection in batches

## Usage

### Prerequisites

1. Ensure you have Firebase Admin SDK installed:
   ```bash
   npm install firebase-admin
   ```

2. Ensure you have proper Firebase credentials configured

### Seeding the Collection

To populate the `minor_draftPicks` collection:

```bash
node scripts/seed-minor-draft-picks.js seed
```

This will:
- Parse `minor-draft-capital.md`
- Generate all draft picks with proper ownership
- Write them to Firestore
- Display a summary of created picks and trades

### Cleaning Up

To remove all documents from the `minor_draftPicks` collection:

```bash
node scripts/seed-minor-draft-picks.js cleanup
```

⚠️ **Warning**: This will delete all draft pick data. The operation includes a 3-second delay before executing to allow cancellation.

## Example Output

```
=== Starting Minor League Draft Picks Seeding ===

Step 1: Parsing minor-draft-capital.md...
✓ Found data for seasons: S10, S11, S12, S13, S14, S9

Step 2: Generating all draft picks for all teams...
✓ Generated 348 draft picks (29 teams × 2 rounds × 6 seasons)

Step 3: Processing trades and updating pick ownership...
✓ Updated ownership for 51 traded picks

Step 4: Writing to Firestore...
  ✓ Committed batch 1: 348/348 picks written

=== ✅ Minor League Draft Picks Seeding Complete! ===
Total picks created: 348
Picks traded: 51
Collection: minor_draftPicks
```

## Trade Examples

### Example 1: Simple Trade
- **Buffalos S10 1st**: Originally owned by Buffalos, traded to SuperSonics
  ```javascript
  {
    original_team: "Buffalos",
    current_owner: "SuperSonics",
    notes: "Traded to SuperSonics"
  }
  ```

### Example 2: Multiple Incoming Picks
- **Rams S10 1st round**: Rams own 3 first-round picks
  - Their own pick (not traded)
  - Wizards S10 1st (acquired via trade)
  - Fruit S10 1st (acquired via trade)

### Example 3: Traded Away Own Pick
- **Rams S10 2nd round**: Rams traded away their own 2nd round pick
  - Current owner would be whoever acquired it (documented in their incoming picks)

## Data Model Reference

This collection mirrors the structure of the major league `draftPicks` collection as documented in `FIREBASE_STRUCTURE.md`, with the following differences:

- **Collection name**: `minor_draftPicks` (vs `draftPicks`)
- **Number of rounds**: 2 (vs 3 for major league)
- **Teams**: 30 minor league teams (vs 30 major league teams)

## Validation

The script has been tested to ensure:
- ✅ All 348 draft picks are created correctly (29 teams, not 30 - Bullets is not a separate team)
- ✅ Trades are properly reflected in ownership changes
- ✅ Team name changes are handled correctly (Bullets → Strips)
- ✅ Document IDs follow the correct format
- ✅ All required fields are populated
- ✅ Season numbers are stored as integers
- ✅ Round numbers are 1 or 2 only

## Team Name Changes

The script handles historical team name changes:

- **Bullets → Strips**: The Bullets were renamed to Strips. When "Bullets S12 2RP" appears in Strips' incoming picks, this is recognized as their own pick (not a trade) and is handled correctly.

The `TEAM_NAME_CHANGES` constant in the script maps old team names to current names and ensures:
- No duplicate teams are created
- Picks are properly attributed to the current team name
- "Incoming" picks from a team's old name are recognized as their own picks, not trades

## Related Files

- **Data source**: `/minor-draft-capital.md`
- **Database structure reference**: `/FIREBASE_STRUCTURE.md`
- **Major league season creation**: `/functions/seasons/season-creation.js` (lines 66-82)
- **Similar seeders**:
  - `/scripts/seed-minor-teams.js`
  - `/scripts/seed-minor-players.js`

## Notes

- The script uses batch writes for efficient Firestore operations (450 documents per batch)
- Historical season S9 is included with limited trade data
- Some teams may not appear in certain seasons if they had no draft pick activity
- The script is idempotent - running it multiple times will overwrite existing data with the same values
- Team name changes (like Bullets → Strips) are handled automatically
