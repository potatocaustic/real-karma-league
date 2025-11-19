# Minor League Teams Seeding Script

This script seeds the `minor_v2_teams` collection in Firestore with data from the Google Sheets CSV.

## Overview

The script creates:
1. **Root-level team documents** at `minor_v2_teams/{team_id}` with fields:
   - `team_id`
   - `conference` (Northern/Southern)
   - `current_gm_handle`
   - `gm_player_id`
   - `gm_uid` (null for all teams)

2. **Seasonal records** at `minor_v2_teams/{team_id}/minor_seasonal_records/S9` with:
   - All standard seasonal stat fields (initialized to 0)
   - `team_name`
   - `team_id`
   - `gm_player_id`
   - `season: "S9"`

## Data Source

The script fetches data from this Google Sheets CSV:
https://docs.google.com/spreadsheets/d/e/2PACX-1vRzKZ3Bhr1kC5176yPZ6hLvIl2t_Y1-LbGxVliiGNxPa0jFqheH6kMp_HoVexd78mWUnx1k857lC3oj/pub?output=csv

## Usage

### To Seed the Teams

```bash
node scripts/seed-minor-teams.js seed
```

This will:
- Fetch the 30 teams from the CSV
- Create documents in `minor_v2_teams` collection
- Create seasonal records for S9
- Show progress for each team

### To Cleanup/Revert

```bash
node scripts/seed-minor-teams.js cleanup
```

This will:
- Delete all documents from `minor_v2_teams`
- Delete all seasonal records subcollections
- Wait 3 seconds before proceeding (safety delay)
- Show progress for each deletion

## Structure

The script follows the exact structure of `v2_teams` (major league teams) collection:

```
minor_v2_teams/
  {team_id}/
    conference: "Northern" | "Southern"
    current_gm_handle: string
    gm_player_id: string
    gm_uid: null
    team_id: string

    minor_seasonal_records/
      S9/
        season: "S9"
        team_id: string
        team_name: string
        gm_player_id: string
        wins: 0
        losses: 0
        pam: 0
        ... (all other seasonal stat fields)
```

## Teams Seeded

- **Northern Conference**: 15 teams (Huskies, Da Bois, Rams, Knights, Buffalos, Seagulls, Titans, Fruit, Vultures, Crows, Raptors, Dogs, Wizards, Mafia, Eggheads)
- **Southern Conference**: 15 teams (Goats, Chiefs, Leeks, Avatars, Kings, Hippos, Legends, Strips, Venom, Minors, Savages, Twins, Methsters, SuperSonics, Tigers)

## Reversibility

The script is fully reversible. If something goes wrong:

1. Run the cleanup command to remove all seeded data
2. Fix any issues
3. Run the seed command again

The cleanup function deletes all documents and subcollections created by the seed function, returning the database to its pre-seeded state.

## Notes

- The script uses batched writes for efficiency
- Progress is logged to console for each team
- Error handling is included for network and database errors
- The structure matches the major league `v2_teams` exactly for consistency
