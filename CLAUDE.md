# CLAUDE.md

This file provides guidance for Claude (AI assistant) when working with this codebase.

## Project Overview

Real Karma League (RKL) is a fantasy sports league management platform supporting multi-league (Major/Minor) competitions with season management, live scoring, rosters, trades, drafts, and comprehensive statistics.

## Key Commands

```bash
# Backend (Cloud Functions)
cd functions && npm install     # Install dependencies
npm run serve                   # Start Firebase emulators locally
npm run deploy                  # Deploy Cloud Functions to Firebase
npm run logs                    # View live function logs

# Full deployment
firebase deploy                 # Deploy all (functions + hosting)
firebase deploy --only functions  # Deploy functions only

# Local development
firebase emulators:start        # Start all emulators
firebase functions:shell        # Interactive testing shell

# Admin interface (Python/Streamlit)
streamlit run app.py            # Run admin portal locally
```

## Architecture

### Directory Structure
- `/functions/` - Firebase Cloud Functions backend (Node.js 22)
  - `/admin/`, `/auth/`, `/draft/`, `/games/`, `/lineups/`, `/live-scoring/`, `/playoffs/`, `/seasons/`, `/stats-rankings/`, `/transactions/` - Domain-specific function modules
  - `/utils/` - Shared utilities (firebase-helpers.js, stats-helpers.js, ranking-helpers.js)
  - `index.js` - Main entry point that re-exports all functions
- `/js/` - Frontend JavaScript modules (ES modules)
- `/css/` - Stylesheets
- `/commish/` - Commissioner portal
- `/S7/`, `/S8/`, `/S9/` - Season-specific pages
- `app.py` - Python/Streamlit admin interface

### Tech Stack
- **Database**: Firestore (NoSQL)
- **Backend**: Firebase Cloud Functions (Node.js 22)
- **Frontend**: Vanilla JS with Firebase SDK 10.12.4 (ES modules)
- **Admin UI**: Python 3 with Streamlit
- **Auth**: Firebase Authentication
- **Hosting**: Firebase Hosting
- **CI/CD**: GitHub Actions

## Critical Conventions

### League Context (IMPORTANT)
The app supports Major and Minor leagues with separate Firestore collections. The `minor_` prefix is applied at different levels depending on collection type:

**Top-level collections** - Use `minor_` prefix:
- `minor_seasons`, `minor_v2_players`, `minor_v2_teams`
- `minor_live_games`, `minor_transactions`, `minor_draft_results`
- `minor_leaderboards`, `minor_daily_scores`, `minor_power_rankings`, etc.

**Season subcollections** - NO `minor_` prefix (parent already prefixed):
- `minor_seasons/{seasonId}/games/{gameId}` (not `minor_games`)
- `minor_seasons/{seasonId}/lineups/{lineupId}` (not `minor_lineups`)
- Same for `post_games`, `post_lineups`, `exhibition_games`, `exhibition_lineups`

**Player/Team subcollections** - USE `minor_` prefix (even though parent prefixed):
- `minor_v2_players/{playerId}/minor_seasonal_stats/{recordId}`
- `minor_v2_teams/{teamId}/minor_seasonal_records/{recordId}`

**Other conventions**:
- Dev collections use `_dev` suffix (e.g., `v2_players_dev`)
- Use `getCollectionName(baseName, league)` from `firebase-helpers.js` for top-level collections
- Shared collections (no prefix): `users`, `notifications`, `scorekeeper_activity_log`

### Firestore Data Model
- **Seasons**: Top-level documents (S7, S8, S9) with nested subcollections
- **Players**: `v2_players` collection with `seasonal_stats` subcollections
- **Teams**: `v2_teams` collection with `seasonal_records` subcollections
- **Games**: Nested under season documents (`games`, `post_games`, `exhibition_games`)
- **Lineups**: Nested under season documents (`lineups`, `post_lineups`, `exhibition_lineups`)

### Cloud Functions Patterns
- Functions organized by domain in subdirectories
- Export both major and minor variants (e.g., `onRegularGameUpdate_V2`, `minor_onRegularGameUpdate_V2`)
- Use Firestore batches for atomic multi-document writes
- Use `HttpsError` with appropriate error codes
- Main `index.js` re-exports from all submodules

### Frontend Patterns
- Firebase initialized in `js/firebase-init.js` (exports auth, db, functions)
- League context via `localStorage` and `window.__currentLeague`
- Page config: `window.firebasePageConfig = { useProdCollections: true/false }`
- Auth state managed via `onAuthStateChanged` listener

### Security Roles
- **admin**: Full access to all operations
- **scorekeeper**: Can submit game scores and lineups
- **gm**: Can manage their assigned team's players
- **commish**: League-specific commissioner (`role_major`, `role_minor`)

## Key Files

- `functions/index.js` - Cloud Functions entry point
- `functions/utils/firebase-helpers.js` - Collection naming, batch operations, common queries
- `functions/utils/stats-helpers.js` - Statistics calculation logic
- `functions/utils/ranking-helpers.js` - Player/team ranking calculations
- `js/firebase-init.js` - Frontend Firebase initialization
- `firestore.rules` - Security rules (role-based access)
- `firestore.indexes.json` - Composite indexes for queries
- `docs/FIREBASE_STRUCTURE.md` - Comprehensive database schema documentation

## Testing

No automated test framework is currently configured. Test manually using:
- `firebase functions:shell` for function testing
- `firebase emulators:start` for local development
- Test on staging environment before production

## Common Tasks

### Adding a New Cloud Function
1. Create function in appropriate subdirectory under `/functions/`
2. Export from the subdirectory's index file
3. Re-export from main `functions/index.js`
4. If league-specific, create both major and minor variants

### Modifying Firestore Collections
1. Review `docs/FIREBASE_STRUCTURE.md` for schema details
2. Use `getCollectionName()` for proper league/dev prefixing
3. Update `firestore.rules` if access patterns change
4. Add composite indexes to `firestore.indexes.json` if needed

### Frontend Changes
1. JavaScript modules go in `/js/`
2. Stylesheets go in `/css/`
3. Use ES module imports for Firebase SDK
4. Respect league context via `window.__currentLeague`

## Naming Conventions

- **Collections/Documents**: snake_case (e.g., `v2_players`, `seasonal_stats`)
- **Fields**: camelCase (e.g., `teamId`, `gamesPlayed`)
- **Functions**: Descriptive with league prefix for minor (e.g., `minor_onRegularGameUpdate_V2`)
- **Single-game stats fields**: PascalCase prefix (e.g., `SingleGameWar`, `global_rank`)
