# Real Karma League - Multi-League Migration Continuation Prompt

## Executive Summary

The Real Karma League is undergoing a migration from a single-league system to a multi-league architecture supporting both **Major League** and **Minor League** operations. This document provides a comprehensive guide for continuing the migration work.

**Current Status**: Backend migration is **95% complete**. Firestore database setup and frontend integration remain.

---

## Table of Contents

1. [Migration Overview](#migration-overview)
2. [What Has Been Completed](#what-has-been-completed)
3. [What Remains To Be Done](#what-remains-to-be-done)
4. [Detailed Task Instructions](#detailed-task-instructions)
5. [Testing Strategy](#testing-strategy)
6. [Deployment Plan](#deployment-plan)
7. [Reference Documentation](#reference-documentation)

---

## Migration Overview

### Goal
Enable the Real Karma League to operate two independent leagues (Major and Minor) using the same codebase and backend infrastructure while maintaining complete data isolation.

### Architecture Decisions

**Collection Naming Convention:**
- **Major League**: `seasons`, `v2_players`, `v2_teams`, `games`, etc. (no prefix)
- **Minor League**: `minor_seasons`, `minor_v2_players`, `minor_v2_teams`, `minor_games`, etc. (`minor_` prefix)
- **Shared**: `users`, `notifications`, `scorekeeper_activity_log` (no league prefix)

**Backend Design:**
- All callable functions accept optional `league` parameter (defaults to `'major'`)
- All helper functions propagate league context through the call chain
- Separate scheduled functions for each league (e.g., `updatePlayerRanks` and `minor_updatePlayerRanks`)
- Separate document triggers for league-specific collection paths

**Frontend Design (Planned):**
- League context management system (global state or React Context)
- League switcher UI component in navigation
- All Firestore queries dynamically use league-appropriate collection names
- All Cloud Function calls pass current league context

---

## What Has Been Completed

### ✅ Backend Infrastructure (100%)

**Files Modified:**
- `functions/index.js` - 5,169 lines (1,487 additions in migration)
- `functions/draft-prospects.js` - 291 lines (116 additions)
- `functions/league-helpers.js` - 61 lines (new file)

**Key Changes:**

1. **Core Infrastructure:**
   - `LEAGUES` constants defined (`major`, `minor`)
   - `getCollectionName(baseName, league)` function completely rewritten (lines 584-616)
   - `validateLeague(league)` helper added (lines 623-630)
   - `getLeagueFromRequest(data)` helper added (lines 631-638)

2. **Callable Functions (28 functions updated):**
   - All accept optional `league` parameter
   - All default to `LEAGUES.MAJOR` for backward compatibility
   - All return `league` field in success responses

   **Updated Functions:**
   - `setLineupDeadline` (line 37)
   - `admin_recalculatePlayerStats` (line 181)
   - `admin_updatePlayerId` (line 295)
   - `admin_updatePlayerDetails` (line 455)
   - `rebrandTeam` (line 640)
   - `createNewSeason` (line 1941)
   - `createHistoricalSeason` (line 2166)
   - `generatePostseasonSchedule` (line 2351)
   - `calculatePerformanceAwards` (line 2596)
   - `getLiveKarma` (line 1278)
   - `stageLiveLineups` (line 1316)
   - `activateLiveGame` (line 1579)
   - `finalizeLiveGame` (line 1618)
   - `admin_processTransaction` (line 2775)
   - `clearAllTradeBlocks` (line 3985)
   - `reopenTradeBlocks` (line 4010)
   - `getReportData` (line 4301)
   - `generateGameWriteup` (line 4464)
   - `scorekeeperFinalizeAndProcess` (line 4553)
   - `forceLeaderboardRecalculation` (line 3914)
   - Plus 8 more...

3. **Helper Functions (11 functions updated):**
   - `performPlayerRankingUpdate(league)`
   - `performPerformanceRankingUpdate(league)`
   - `performFullUpdate(gameDate, league)`
   - `processAndFinalizeGame(event, league)`
   - `updatePlayerSeasonalStats(..., league)`
   - `updateAllTeamStats(..., league)`
   - `performWeekUpdate(league)`
   - `performBracketUpdate(league)`
   - `advanceBracket(..., league)`
   - Plus 2 more...

4. **Scheduled Functions (10 minor league functions created):**
   - `minor_updatePlayerRanks` (line 3828)
   - `minor_updatePerformanceLeaderboards` (line 3851)
   - `minor_updateCurrentWeek` (line 3981)
   - `minor_updatePlayoffBracket` (line 4189)
   - `minor_autoFinalizeGames` (line 1691)
   - `minor_scheduledLiveScoringShutdown` (line 1856)
   - `minor_scheduledSampler` (line 976)
   - `minor_processPendingLiveGames` (line 1529)
   - `minor_releasePendingTransactions` (line 3062)
   - `minor_scheduledLiveScoringStart` (line 4654)

5. **Document Triggers (7 minor league triggers created):**
   - `minor_onRegularGameUpdate_V2` (line 3602)
   - `minor_onPostGameUpdate_V2` (line 3605)
   - `minor_onTransactionCreate_V2` (line 2772)
   - `minor_onTransactionUpdate_V2` (line 2933)
   - `minor_onDraftResultCreate` (line 2488)
   - `minor_updateGamesScheduledCount` (line 2093)
   - `minor_processCompletedExhibitionGame` (line 2129)

6. **Draft System:**
   - `addDraftProspects` accepts league parameter
   - `updateAllProspectsScheduled` - Major league scheduled update
   - `minor_updateAllProspectsScheduled` - Minor league scheduled update

### ✅ Documentation (100%)

1. **MIGRATION_GUIDE.md** (345 lines)
   - Frontend API usage guide
   - Breaking changes documentation (none!)
   - Example code for league context
   - Response format changes

2. **migration.md** (826 lines)
   - Step-by-step implementation guide
   - Phase-by-phase migration instructions
   - Testing strategies
   - Success criteria

3. **scripts/initialize-minor-league.js** (new)
   - Script to create all minor league Firestore collections
   - Creates initial season structure
   - Optional sample data generation
   - Usage: `node scripts/initialize-minor-league.js [--with-sample-data]`

---

## What Remains To Be Done

### ❌ CRITICAL - Database Setup (Priority 1)

**Task 1.1: Create Minor League Firestore Collections**

**Status**: Script created, needs to be run

**Action Steps:**
1. Review the script at `scripts/initialize-minor-league.js`
2. Ensure Firebase Admin SDK is properly configured locally
3. Run the script:
   ```bash
   cd /home/user/real-karma-league
   node scripts/initialize-minor-league.js --with-sample-data
   ```
4. Verify collections created in Firebase Console
5. Delete placeholder documents if desired (or keep for reference)

**Expected Collections Created:**
- `minor_seasons` (with initial season document)
- `minor_v2_players` (with 8 sample players if --with-sample-data used)
- `minor_v2_teams` (with 4 sample teams if --with-sample-data used)
- `minor_live_games`
- `minor_lineup_deadlines`
- `minor_pending_lineups`
- `minor_live_scoring_status`
- `minor_transactions`
- `minor_pending_transactions`
- `minor_draftPicks`
- `minor_archived_live_games`

**Subcollections under `minor_seasons/{seasonId}`:**
- `minor_games`
- `minor_post_games`
- `minor_exhibition_games`
- `minor_lineups`
- `minor_post_lineups`
- `minor_draft_prospects`

---

### ❌ CRITICAL - Firestore Security Rules (Priority 1)

**Task 1.2: Update firestore.rules**

**Status**: Rules file identified, needs minor league rules added

**Current Situation:**
- `firestore.rules` contains rules for major league (production) collections
- `firestore.rules` contains rules for `_dev` suffixed collections
- **Missing**: Rules for `minor_` prefixed collections

**Action Steps:**

1. Open `firestore.rules` (331 lines currently)

2. Add rules for ALL minor league collections immediately after the major league rules (around line 180)

3. **Template for Minor League Rules:**

```javascript
// --- Minor League Rules ---

match /minor_lineup_deadlines/{deadlineId} {
  allow read: if request.auth != null;
  allow write: if get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
}

match /minor_pending_transactions/{docId} {
  allow read, write: if isUserAdmin();
}

match /minor_pending_lineups/{gameId} {
  allow read: if request.auth != null;
  allow write: if isScorekeeperOrAdmin();
}

match /minor_archived_live_games/{doc=**} {
  allow read: if isUserAdmin();
  allow write: if false; // Only backend can write
}

match /minor_seasons/{seasonId} {
  allow get, list: if request.auth.uid != null;
  allow write: if isUserAdmin();
  match /{documents=**} {
    allow read: if true;
    allow write: if isUserAdmin();
  }
}

match /minor_v2_players/{document=**} {
  allow read: if true;
  allow write: if isUserAdmin();
}

match /minor_v2_teams/{document=**} {
  allow read: if true;
  allow write: if isUserAdmin();
}

match /minor_draftPicks/{doc=**} {
  allow read: if true;
  allow write: if isUserAdmin();
}

match /minor_live_games/{gameId} {
  allow read: if true;
  allow write: if isScorekeeperOrAdmin();
}

match /minor_transactions/{transactionId} {
  allow read: if true;
  allow create: if isUserAdmin();
  allow update, delete: if false;
}

match /minor_transactions/seasons/{seasonId}/{transactionId} {
  allow read: if true;
  allow write: if isUserAdmin();
}

match /minor_live_scoring_status/{doc=**} {
  allow read: if true;
  allow write: if isScorekeeperOrAdmin();
}
```

4. **Deploy updated rules:**
   ```bash
   firebase deploy --only firestore:rules
   ```

5. **Verify deployment:**
   - Check Firebase Console > Firestore Database > Rules tab
   - Confirm rules updated timestamp
   - Test read/write access with authenticated user

**Important Notes:**
- The structured collections (`daily_averages`, `leaderboards`, `awards`, etc.) do NOT get minor_ prefix in rules
- These collections organize league data internally (e.g., `leaderboards/season_1/minor_S1_leaderboards`)
- The existing wildcard rules should cover them

---

### ❌ IMPORTANT - Frontend Integration (Priority 2)

**Task 2.1: Create League Context Management System**

**Status**: Not started

**Current Situation:**
- Frontend is vanilla JavaScript (no React)
- Firebase initialized in `js/firebase-init.js`
- Collection names hardcoded in `collectionNames` object (lines 61-71)
- No league switching capability

**Action Steps:**

1. **Update `js/firebase-init.js`:**

```javascript
// Add after IS_DEVELOPMENT constant (around line 15)

// League context - default to major league
let currentLeague = 'major';

// Get current league
export function getCurrentLeague() {
    return currentLeague;
}

// Set current league
export function setCurrentLeague(league) {
    if (league !== 'major' && league !== 'minor') {
        console.error('Invalid league:', league);
        return;
    }
    currentLeague = league;
    console.log('League context switched to:', league);

    // Dispatch custom event for components to react to league change
    window.dispatchEvent(new CustomEvent('leagueChanged', { detail: { league } }));
}

// Get collection name with league context
export function getLeagueCollectionName(baseName, league = null) {
    const targetLeague = league || currentLeague;

    // Shared collections (no prefix)
    const sharedCollections = ['users', 'notifications', 'scorekeeper_activity_log', 'settings', 'tradeblocks'];
    if (sharedCollections.includes(baseName)) {
        return IS_DEVELOPMENT ? `${baseName}_dev` : baseName;
    }

    // Structured collections (no prefix, handled internally)
    const structuredCollections = ['daily_averages', 'daily_scores', 'post_daily_averages',
                                   'post_daily_scores', 'leaderboards', 'post_leaderboards',
                                   'awards', 'draft_results'];
    if (structuredCollections.includes(baseName)) {
        return IS_DEVELOPMENT ? `${baseName}_dev` : baseName;
    }

    // League-specific collections
    const leaguePrefix = targetLeague === 'minor' ? 'minor_' : '';
    const devSuffix = IS_DEVELOPMENT ? '_dev' : '';
    return `${leaguePrefix}${baseName}${devSuffix}`;
}

// Update existing collectionNames to be functions
export const collectionNames = {
    get seasons() { return getLeagueCollectionName('seasons'); },
    get users() { return getLeagueCollectionName('users'); },
    get settings() { return getLeagueCollectionName('settings'); },
    get teams() { return getLeagueCollectionName('v2_teams'); },
    get players() { return getLeagueCollectionName('v2_players'); },
    get draftPicks() { return getLeagueCollectionName('draftPicks'); },
    get seasonalStats() { return getLeagueCollectionName('seasonal_stats'); },
    get seasonalRecords() { return getLeagueCollectionName('seasonal_records'); },
    get tradeblocks() { return getLeagueCollectionName('tradeblocks'); },
    get liveGames() { return getLeagueCollectionName('live_games'); },
    get lineupDeadlines() { return getLeagueCollectionName('lineup_deadlines'); },
    get transactions() { return getLeagueCollectionName('transactions'); },
    get pendingLineups() { return getLeagueCollectionName('pending_lineups'); }
};
```

2. **Create League Switcher Component** (`common/league-switcher.js`):

```javascript
import { getCurrentLeague, setCurrentLeague } from '../js/firebase-init.js';

export function createLeagueSwitcher() {
    const container = document.createElement('div');
    container.className = 'league-switcher';
    container.innerHTML = `
        <div class="league-switcher-container">
            <button id="major-league-btn" class="league-btn active">
                Major League
            </button>
            <button id="minor-league-btn" class="league-btn">
                Minor League
            </button>
        </div>
    `;

    // Add event listeners
    container.querySelector('#major-league-btn').addEventListener('click', () => {
        setCurrentLeague('major');
        updateActiveButton('major');
    });

    container.querySelector('#minor-league-btn').addEventListener('click', () => {
        setCurrentLeague('minor');
        updateActiveButton('minor');
    });

    // Update active button styling
    function updateActiveButton(league) {
        container.querySelectorAll('.league-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        container.querySelector(`#${league}-league-btn`).classList.add('active');
    }

    // Initialize with current league
    updateActiveButton(getCurrentLeague());

    return container;
}
```

3. **Add CSS for League Switcher** (add to `css/main.css` or create new file):

```css
.league-switcher-container {
    display: flex;
    gap: 10px;
    padding: 10px;
    background: #f5f5f5;
    border-radius: 8px;
    margin: 10px 0;
}

.league-btn {
    padding: 8px 16px;
    border: 2px solid #ddd;
    background: white;
    border-radius: 6px;
    cursor: pointer;
    font-weight: 500;
    transition: all 0.2s;
}

.league-btn:hover {
    border-color: #4CAF50;
    background: #f9f9f9;
}

.league-btn.active {
    background: #4CAF50;
    color: white;
    border-color: #4CAF50;
}
```

4. **Add League Switcher to Navigation:**

Modify the header in relevant HTML files (admin dashboard, GM dashboard, scorekeeper dashboard, etc.):

```html
<!-- In admin/index.html, gm/index.html, scorekeeper/index.html -->
<div id="league-switcher-mount"></div>

<script type="module">
    import { createLeagueSwitcher } from '../common/league-switcher.js';
    const switcher = createLeagueSwitcher();
    document.getElementById('league-switcher-mount').appendChild(switcher);
</script>
```

---

**Task 2.2: Update All Cloud Function Calls**

**Status**: Not started

**Files to Update:**
- `admin/*.js` (11 files)
- `gm/*.js` (2 files)
- `scorekeeper/*.js` (3 files)
- Any other files that call Cloud Functions

**Pattern to Apply:**

**Before:**
```javascript
const setDeadline = httpsCallable(functions, 'setLineupDeadline');
const result = await setDeadline({
    date: selectedDate,
    time: selectedTime,
    timeZone: timeZone
});
```

**After:**
```javascript
import { getCurrentLeague } from '../js/firebase-init.js';

const setDeadline = httpsCallable(functions, 'setLineupDeadline');
const result = await setDeadline({
    date: selectedDate,
    time: selectedTime,
    timeZone: timeZone,
    league: getCurrentLeague() // Add this line
});
```

**Action Steps:**

1. Search for all `httpsCallable` calls in the codebase:
   ```bash
   grep -r "httpsCallable" admin/ gm/ scorekeeper/
   ```

2. For each callable function, add `league: getCurrentLeague()` to the data object

3. List of functions that MUST include league parameter:
   - `setLineupDeadline`
   - `admin_recalculatePlayerStats`
   - `admin_updatePlayerId`
   - `admin_updatePlayerDetails`
   - `rebrandTeam`
   - `createNewSeason`
   - `createHistoricalSeason`
   - `generatePostseasonSchedule`
   - `calculatePerformanceAwards`
   - `admin_processTransaction`
   - `stageLiveLineups`
   - `activateLiveGame`
   - `finalizeLiveGame`
   - `scorekeeperFinalizeAndProcess`
   - `generateGameWriteup`
   - `getReportData`
   - `updateAllLiveScores`
   - `setLiveScoringStatus`
   - `getLiveKarma`
   - `addDraftProspects`
   - `clearAllTradeBlocks`
   - `reopenTradeBlocks`
   - `forceLeaderboardRecalculation`

4. Test each function after updating to ensure it works with both leagues

---

**Task 2.3: Update All Firestore Queries**

**Status**: Not started

**Files to Update:**
- All JavaScript files that query Firestore directly
- Focus on: `admin/*.js`, `gm/*.js`, `scorekeeper/*.js`, `js/*.js`

**Pattern to Apply:**

**Before:**
```javascript
const seasonsRef = collection(db, 'seasons');
const q = query(seasonsRef, where('status', '==', 'active'));
```

**After:**
```javascript
import { collectionNames } from '../js/firebase-init.js';

const seasonsRef = collection(db, collectionNames.seasons);
const q = query(seasonsRef, where('status', '==', 'active'));
```

**Or for collections not in collectionNames:**

```javascript
import { getLeagueCollectionName } from '../js/firebase-init.js';

const gamesRef = collection(db, getLeagueCollectionName('seasons'))
    .doc(seasonId)
    .collection(getLeagueCollectionName('games'));
```

**Action Steps:**

1. Search for hardcoded collection names:
   ```bash
   grep -r "collection(db, '" admin/ gm/ scorekeeper/ js/
   grep -r 'collection(db, "' admin/ gm/ scorekeeper/ js/
   ```

2. Replace ALL hardcoded collection references with dynamic ones

3. Pay special attention to:
   - Subcollection references (games, lineups, etc.)
   - Batch operations
   - Transaction operations

4. Test extensively - incorrect collection names will cause silent failures

---

**Task 2.4: Handle League Change Events**

**Status**: Not started

**Action Steps:**

1. In components that display league-specific data, add event listener:

```javascript
// Example for a dashboard component
window.addEventListener('leagueChanged', (event) => {
    const newLeague = event.detail.league;
    console.log('League changed to:', newLeague);

    // Reload data for new league
    loadDashboardData();
});
```

2. Components that need league change handling:
   - Dashboard displays (admin, GM, scorekeeper)
   - Standings tables
   - Leaderboards
   - Team/Player lists
   - Game schedules
   - Transaction logs
   - Live scoring displays

---

### ❌ IMPORTANT - Testing (Priority 3)

**Task 3.1: Database Script Testing**

**Test Cases:**
1. Run initialization script with `--with-sample-data`
2. Verify all collections created in Firebase Console
3. Verify season document structure
4. Verify subcollections exist under season
5. Verify sample teams have correct structure
6. Verify sample players have correct structure
7. Attempt to query collections from Firebase Console
8. Verify security rules allow authenticated access

**Expected Results:**
- 11 top-level minor league collections created
- 1 season document with 6 subcollections
- 4 teams (if --with-sample-data used)
- 8 players (if --with-sample-data used)
- All queries succeed for authenticated users

---

**Task 3.2: Backend Function Testing**

**Test Cases:**

Create test script `scripts/test-minor-league-functions.js`:

```javascript
const admin = require('firebase-admin');

admin.initializeApp({
    projectId: "real-karma-league",
});

const db = admin.firestore();

async function testMinorLeagueFunctions() {
    console.log('Testing Minor League Backend Functions...\n');

    // Test 1: Verify collection name function
    console.log('Test 1: Collection naming...');
    // Import getCollectionName from functions/index.js if possible
    // Or manually test by checking collection existence

    const minorSeasons = await db.collection('minor_seasons').limit(1).get();
    console.log(`✓ minor_seasons collection exists: ${!minorSeasons.empty}`);

    const minorPlayers = await db.collection('minor_v2_players').limit(1).get();
    console.log(`✓ minor_v2_players collection exists: ${!minorPlayers.empty}`);

    const minorTeams = await db.collection('minor_v2_teams').limit(1).get();
    console.log(`✓ minor_v2_teams collection exists: ${!minorTeams.empty}\n`);

    // Test 2: Verify data isolation
    console.log('Test 2: Data isolation...');
    const majorSeasons = await db.collection('seasons').get();
    const minorSeasonsAll = await db.collection('minor_seasons').get();

    console.log(`Major league seasons: ${majorSeasons.size}`);
    console.log(`Minor league seasons: ${minorSeasonsAll.size}`);
    console.log(`✓ Collections are isolated\n`);

    // Test 3: Verify scheduled function existence
    console.log('Test 3: Checking deployed functions...');
    console.log('(Run: firebase functions:list | grep minor)');
    console.log('Expected: 10 minor_ scheduled functions + 7 minor_ triggers\n');

    console.log('All backend tests passed!');
}

testMinorLeagueFunctions()
    .then(() => process.exit(0))
    .catch(error => {
        console.error('Tests failed:', error);
        process.exit(1);
    });
```

Run with: `node scripts/test-minor-league-functions.js`

**Manual Tests (via Firebase Console or admin panel):**

1. **Test createNewSeason with league parameter:**
   - Call function with `{ seasonNumber: 2, league: 'minor' }`
   - Verify `minor_seasons` collection has new season
   - Verify major league unaffected

2. **Test admin_updatePlayerDetails:**
   - Call with `{ playerId: 'test_player', updates: {...}, league: 'minor' }`
   - Verify updates apply to `minor_v2_players` only

3. **Test stageLiveLineups:**
   - Call with game data + `league: 'minor'`
   - Verify lineups staged in `minor_pending_lineups`

4. **Test data isolation:**
   - Perform operations on both leagues
   - Verify no cross-contamination

5. **Test backward compatibility:**
   - Call functions WITHOUT league parameter
   - Verify they default to major league
   - Verify major league operations still work

---

**Task 3.3: Frontend Integration Testing**

**Test Cases:**

1. **League Switcher:**
   - Click Major League button → verify active state
   - Click Minor League button → verify active state
   - Check browser console for `leagueChanged` event
   - Verify `getCurrentLeague()` returns correct value

2. **Collection Name Resolution:**
   - Set league to Major → verify `collectionNames.seasons` returns `'seasons'`
   - Set league to Minor → verify `collectionNames.seasons` returns `'minor_seasons'`
   - Test all collection names in both contexts

3. **Cloud Function Calls:**
   - Set league to Minor
   - Call a function (e.g., setLineupDeadline)
   - Check Network tab to verify `league: 'minor'` in request payload
   - Verify function response includes `league: 'minor'`

4. **Firestore Queries:**
   - Set league to Minor
   - Load a page with Firestore queries (e.g., standings)
   - Check Network tab → Firestore requests
   - Verify queries target `minor_*` collections

5. **League Change Reactivity:**
   - Load dashboard with Major League data
   - Switch to Minor League
   - Verify UI updates with Minor League data
   - Switch back to Major → verify UI updates

6. **Cross-Browser Testing:**
   - Test in Chrome, Firefox, Safari
   - Verify league switcher works
   - Verify no console errors

---

### ❌ OPTIONAL - Advanced Features (Priority 4)

**Task 4.1: League-Specific User Permissions**

Currently, admins have access to both leagues. Consider implementing:
- Per-league admin/scorekeeper roles
- User document structure: `{ role: 'admin', leagues: ['major', 'minor'] }`
- Update `league-helpers.js` `hasLeagueAccess()` to check array

**Task 4.2: League Analytics Dashboard**

Create admin view showing:
- Current status of both leagues
- Active seasons for each league
- Player/Team counts per league
- Recent activity per league

**Task 4.3: Cross-League Operations**

Implement functions for:
- Player promotion (minor → major)
- Player demotion (major → minor)
- Transaction history across leagues

**Task 4.4: League-Specific Theming**

Add visual distinction:
- Different color schemes for each league
- League logos/branding
- Conditional styling based on current league

---

## Detailed Task Instructions

### Priority 1 Tasks (Must Complete First)

#### TASK 1A: Initialize Firestore Database

**Estimated Time**: 15 minutes

**Steps:**
1. Navigate to project root: `cd /home/user/real-karma-league`
2. Ensure Firebase credentials are configured
3. Run: `node scripts/initialize-minor-league.js --with-sample-data`
4. Monitor console output for errors
5. Verify in Firebase Console:
   - Navigate to Firestore Database
   - Confirm `minor_*` collections exist
   - Click into `minor_seasons` → verify season document
   - Click into `minor_v2_teams` → verify 4 teams
   - Click into `minor_v2_players` → verify 8 players

**Success Criteria:**
- ✅ Script completes without errors
- ✅ 11 top-level collections created
- ✅ 1 season with 6 subcollections
- ✅ Sample data populated (if flag used)

**Rollback Plan:**
If issues occur, delete all `minor_*` collections and re-run script.

---

#### TASK 1B: Update Firestore Security Rules

**Estimated Time**: 30 minutes

**Steps:**

1. **Open firestore.rules file**
   ```bash
   nano firestore.rules  # or use your preferred editor
   ```

2. **Add minor league rules** after line 180 (after major league rules, before dev rules)

3. **Use this complete rule set:**

```javascript
// =======================================================
// MINOR LEAGUE RULES
// =======================================================

match /minor_lineup_deadlines/{deadlineId} {
  allow read: if request.auth != null;
  allow write: if get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
}

match /minor_pending_transactions/{docId} {
  allow read, write: if isUserAdmin();
}

match /minor_pending_lineups/{gameId} {
  allow read: if request.auth != null;
  allow write: if isScorekeeperOrAdmin();
}

match /minor_archived_live_games/{doc=**} {
  allow read: if isUserAdmin();
  allow write: if false; // Only backend can write
}

match /minor_seasons/{seasonId} {
  allow get, list: if request.auth.uid != null;
  allow write: if isUserAdmin();
  match /{documents=**} {
    allow read: if true;
    allow write: if isUserAdmin();
  }
}

match /minor_v2_players/{document=**} {
  allow read: if true;
  allow write: if isUserAdmin();
}

match /minor_v2_teams/{document=**} {
  allow read: if true;
  allow write: if isUserAdmin();
}

match /minor_draftPicks/{doc=**} {
  allow read: if true;
  allow write: if isUserAdmin();
}

match /minor_live_games/{gameId} {
  allow read: if true;
  allow write: if isScorekeeperOrAdmin();
}

match /minor_transactions/{transactionId} {
  allow read: if true;
  allow create: if isUserAdmin();
  allow update, delete: if false;
}

match /minor_transactions/seasons/{seasonId}/{transactionId} {
  allow read: if true;
  allow write: if isUserAdmin();
}

match /minor_live_scoring_status/{doc=**} {
  allow read: if true;
  allow write: if isScorekeeperOrAdmin();
}
```

4. **Save the file**

5. **Deploy to Firebase:**
   ```bash
   firebase deploy --only firestore:rules
   ```

6. **Verify deployment:**
   - Open Firebase Console
   - Navigate to Firestore Database → Rules tab
   - Confirm updated timestamp
   - Scroll through rules to verify minor_ rules present

**Success Criteria:**
- ✅ Rules file syntax valid (no deployment errors)
- ✅ All minor_ collections have matching rules
- ✅ Timestamp updated in Firebase Console
- ✅ Test query succeeds from frontend (next task)

**Troubleshooting:**
- If deployment fails, check syntax with: `firebase deploy --only firestore:rules --debug`
- Common issues: missing commas, bracket mismatches
- Validate rules in Firebase Console Rules Playground

---

### Priority 2 Tasks (Frontend Integration)

#### TASK 2A: Implement League Context System

**Estimated Time**: 1-2 hours

**Steps:**

1. **Backup firebase-init.js:**
   ```bash
   cp js/firebase-init.js js/firebase-init.js.backup
   ```

2. **Edit js/firebase-init.js:**
   - Add league state variables (see Task 2.1 code above)
   - Add `getCurrentLeague()` function
   - Add `setCurrentLeague()` function
   - Add `getLeagueCollectionName()` function
   - Convert `collectionNames` object to use getters

3. **Test the implementation:**
   Create `test-league-context.html`:
   ```html
   <!DOCTYPE html>
   <html>
   <head><title>League Context Test</title></head>
   <body>
       <h1>League Context Test</h1>
       <button id="set-major">Set Major</button>
       <button id="set-minor">Set Minor</button>
       <div id="output"></div>

       <script type="module">
           import { getCurrentLeague, setCurrentLeague, collectionNames, getLeagueCollectionName } from './js/firebase-init.js';

           document.getElementById('set-major').addEventListener('click', () => {
               setCurrentLeague('major');
               updateOutput();
           });

           document.getElementById('set-minor').addEventListener('click', () => {
               setCurrentLeague('minor');
               updateOutput();
           });

           window.addEventListener('leagueChanged', (e) => {
               console.log('League changed event:', e.detail);
           });

           function updateOutput() {
               const league = getCurrentLeague();
               const seasons = collectionNames.seasons;
               const players = collectionNames.players;
               const teams = collectionNames.teams;

               document.getElementById('output').innerHTML = `
                   <p>Current League: <strong>${league}</strong></p>
                   <p>Seasons Collection: <strong>${seasons}</strong></p>
                   <p>Players Collection: <strong>${players}</strong></p>
                   <p>Teams Collection: <strong>${teams}</strong></p>
               `;
           }

           updateOutput();
       </script>
   </body>
   </html>
   ```

4. **Open in browser and test:**
   - Should show Major League by default
   - Click "Set Minor" → collections should change to `minor_*`
   - Click "Set Major" → collections should change back
   - Check console for `leagueChanged` events

**Success Criteria:**
- ✅ League state persists during session
- ✅ `collectionNames` returns correct values for each league
- ✅ `leagueChanged` event fires on switch
- ✅ No console errors

---

#### TASK 2B: Create League Switcher Component

**Estimated Time**: 1 hour

**Steps:**

1. **Create directory if needed:**
   ```bash
   mkdir -p common
   ```

2. **Create `common/league-switcher.js`** (see Task 2.1 code above)

3. **Create CSS file `css/league-switcher.css`** (see Task 2.1 CSS above)

4. **Add to one admin page for testing** (e.g., `admin/index.html`):

   In `<head>`:
   ```html
   <link rel="stylesheet" href="../css/league-switcher.css">
   ```

   In navigation area:
   ```html
   <div id="league-switcher-mount" style="margin: 20px;"></div>
   ```

   Before closing `</body>`:
   ```html
   <script type="module">
       import { createLeagueSwitcher } from '../common/league-switcher.js';
       const switcher = createLeagueSwitcher();
       document.getElementById('league-switcher-mount').appendChild(switcher);
   </script>
   ```

5. **Test:**
   - Open admin page in browser
   - Should see two buttons: "Major League" and "Minor League"
   - Click Minor → button should highlight
   - Check console: `getCurrentLeague()` should return `'minor'`
   - Click Major → should switch back

**Success Criteria:**
- ✅ Buttons render correctly
- ✅ Active state toggles on click
- ✅ League context updates on click
- ✅ Styling looks clean and professional

**Next Steps:**
- Add to all admin pages
- Add to GM pages
- Add to scorekeeper pages

---

#### TASK 2C: Update Cloud Function Calls

**Estimated Time**: 2-3 hours

**Approach**: Systematic file-by-file updates

**Steps:**

1. **Create a checklist** of all files with `httpsCallable`:
   ```bash
   grep -r "httpsCallable" admin/ gm/ scorekeeper/ --include="*.js" > function-calls-checklist.txt
   ```

2. **For each file in the list:**

   a. **Open the file**

   b. **Add import at top:**
   ```javascript
   import { getCurrentLeague } from '../js/firebase-init.js';
   ```

   c. **Find each `httpsCallable` invocation**

   d. **Add league parameter:**
   ```javascript
   // Before
   const result = await someFunction({ param1, param2 });

   // After
   const result = await someFunction({
       param1,
       param2,
       league: getCurrentLeague()
   });
   ```

   e. **Test the function** (manual testing in browser)

   f. **Mark file as complete** in checklist

3. **Priority order** (update these files first):
   - `admin/manage-games.js` (game management)
   - `scorekeeper/live-scoring.js` (live scoring)
   - `gm/submit-lineup.js` (lineup submission)
   - `admin/manage-players.js` (player management)
   - `admin/manage-teams.js` (team management)
   - Then all remaining files

4. **Testing strategy** for each file:
   - Set league to Minor
   - Perform action (e.g., update player, create game)
   - Check Network tab → verify request includes `"league":"minor"`
   - Verify operation succeeds
   - Verify data appears in correct `minor_*` collection
   - Switch to Major → repeat test → verify data in major collections

**Success Criteria:**
- ✅ All function calls include league parameter
- ✅ Operations work in both leagues
- ✅ No cross-contamination between leagues
- ✅ Network requests show correct league value

**Common Pitfalls:**
- Missing import statement
- Forgetting to add league to object (syntax error)
- Passing wrong variable (e.g., `league: 'minor'` hardcoded instead of `getCurrentLeague()`)

---

#### TASK 2D: Update Firestore Queries

**Estimated Time**: 3-4 hours

**Approach**: Search and replace with validation

**Steps:**

1. **Find all hardcoded collection references:**
   ```bash
   grep -rn "collection(db, ['\"]" admin/ gm/ scorekeeper/ js/ > firestore-queries-checklist.txt
   ```

2. **Common patterns to replace:**

   **Pattern 1: Top-level collections**
   ```javascript
   // Before
   const ref = collection(db, 'seasons');

   // After
   import { collectionNames } from '../js/firebase-init.js';
   const ref = collection(db, collectionNames.seasons);
   ```

   **Pattern 2: Collections not in collectionNames**
   ```javascript
   // Before
   const ref = collection(db, 'live_games');

   // After
   import { getLeagueCollectionName } from '../js/firebase-init.js';
   const ref = collection(db, getLeagueCollectionName('live_games'));
   ```

   **Pattern 3: Subcollections**
   ```javascript
   // Before
   const ref = doc(db, 'seasons', seasonId, 'games', gameId);

   // After
   const ref = doc(db,
       getLeagueCollectionName('seasons'),
       seasonId,
       getLeagueCollectionName('games'),
       gameId
   );
   ```

   **Pattern 4: Queries with where/orderBy**
   ```javascript
   // Before
   const q = query(
       collection(db, 'v2_players'),
       where('current_team_id', '==', teamId)
   );

   // After
   const q = query(
       collection(db, collectionNames.players),
       where('current_team_id', '==', teamId)
   );
   ```

3. **Systematic replacement:**
   - Work through checklist file by file
   - Replace ALL hardcoded references in each file
   - Test file before moving to next
   - Mark file complete

4. **Testing for each file:**
   - Load page with Major League selected
   - Verify data loads correctly
   - Switch to Minor League
   - Verify page reloads with Minor League data (or shows empty if no data)
   - Check Network tab → Firestore requests
   - Verify targeting correct collections

**Critical Files (update first):**
- `admin/manage-games.js`
- `admin/manage-players.js`
- `admin/manage-teams.js`
- `gm/dashboard.js`
- `scorekeeper/live-scoring.js`
- `js/standings.js`
- `js/leaderboards.js`

**Success Criteria:**
- ✅ Zero hardcoded collection names remain
- ✅ All queries respect current league context
- ✅ Switching leagues updates all displayed data
- ✅ No JavaScript errors in console

**Validation Script:**

Create `scripts/validate-no-hardcoded-collections.js`:
```javascript
const fs = require('fs');
const path = require('path');

const hardcodedPatterns = [
    /collection\(db,\s*['"]seasons['"]\)/,
    /collection\(db,\s*['"]v2_players['"]\)/,
    /collection\(db,\s*['"]v2_teams['"]\)/,
    /collection\(db,\s*['"]games['"]\)/,
    /collection\(db,\s*['"]lineups['"]\)/,
    // Add more patterns
];

function scanFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const violations = [];

    hardcodedPatterns.forEach((pattern, index) => {
        if (pattern.test(content)) {
            violations.push({
                file: filePath,
                pattern: pattern.toString()
            });
        }
    });

    return violations;
}

function scanDirectory(dir) {
    const files = fs.readdirSync(dir);
    let allViolations = [];

    files.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);

        if (stat.isDirectory()) {
            allViolations = allViolations.concat(scanDirectory(filePath));
        } else if (file.endsWith('.js')) {
            allViolations = allViolations.concat(scanFile(filePath));
        }
    });

    return allViolations;
}

const violations = scanDirectory('./admin');
// Scan other directories too

if (violations.length > 0) {
    console.error('Found hardcoded collection names:');
    violations.forEach(v => console.error(`  ${v.file}: ${v.pattern}`));
    process.exit(1);
} else {
    console.log('✓ No hardcoded collection names found!');
    process.exit(0);
}
```

Run: `node scripts/validate-no-hardcoded-collections.js`

---

### Priority 3 Tasks (Testing & Validation)

#### TASK 3A: End-to-End Testing

**Create comprehensive test plan:**

**Test Suite 1: Database Integrity**
- [ ] All minor_ collections exist
- [ ] All collections have correct permissions
- [ ] Sample data is valid and queryable
- [ ] Indexes work correctly

**Test Suite 2: Backend Functions**
- [ ] All callable functions accept league parameter
- [ ] Functions default to major league when parameter omitted
- [ ] Functions return league in response
- [ ] Scheduled functions are deployed for both leagues
- [ ] Document triggers exist for both leagues

**Test Suite 3: Data Isolation**
- [ ] Creating data in major league doesn't affect minor league
- [ ] Creating data in minor league doesn't affect major league
- [ ] Deleting data in one league doesn't affect the other
- [ ] Queries on one league don't return data from the other

**Test Suite 4: Frontend Integration**
- [ ] League switcher renders correctly
- [ ] Clicking switcher changes league context
- [ ] All pages respect current league
- [ ] All function calls include correct league
- [ ] All Firestore queries target correct collections
- [ ] Switching leagues triggers data reload

**Test Suite 5: User Workflows**

*Admin Workflows:*
- [ ] Create new season for minor league
- [ ] Add teams to minor league
- [ ] Add players to minor league
- [ ] Create game schedule for minor league
- [ ] Process transaction in minor league
- [ ] Verify major league unaffected

*Scorekeeper Workflows:*
- [ ] Stage lineups for minor league game
- [ ] Activate live scoring for minor league
- [ ] Update live scores during minor league game
- [ ] Finalize minor league game
- [ ] Verify major league games unaffected

*GM Workflows:*
- [ ] View minor league standings
- [ ] Submit lineup for minor league game
- [ ] View minor league player stats
- [ ] View minor league team roster

---

#### TASK 3B: Performance Testing

**Metrics to measure:**
- Page load time with league switcher
- Query performance for minor league data
- Function execution time for both leagues
- Scheduled function duration for both leagues

**Load Testing:**
- Simulate concurrent operations on both leagues
- Verify no resource contention
- Check Firebase quotas and limits

---

### Priority 4 Tasks (Optional Enhancements)

See "Optional - Advanced Features" section above for detailed instructions.

---

## Testing Strategy

### Phase 1: Unit Testing (Backend)

**Test Harness**: `scripts/test-minor-league-backend.js`

```javascript
// Test each function with both league values
// Verify correct collection targeting
// Verify data isolation
// Verify backward compatibility
```

### Phase 2: Integration Testing (Frontend)

**Manual Test Cases**:
1. League switcher functionality
2. Collection name resolution
3. Function call league parameter inclusion
4. Query targeting correct collections
5. Cross-league data isolation

### Phase 3: User Acceptance Testing

**Test Scenarios**:
1. Admin creates complete minor league season
2. GMs submit lineups for both leagues
3. Scorekeepers run live games for both leagues
4. Verify independent operation

### Phase 4: Regression Testing

**Verify Major League Unchanged**:
- All existing functionality works
- No performance degradation
- No data corruption
- Scheduled jobs still run

---

## Deployment Plan

### Pre-Deployment Checklist

- [ ] All code reviewed and tested
- [ ] Firestore collections created
- [ ] Firestore rules deployed
- [ ] Backend functions deployed
- [ ] Frontend updated and tested
- [ ] Documentation updated
- [ ] Rollback plan prepared

### Deployment Steps

**Step 1: Deploy Firestore Rules**
```bash
firebase deploy --only firestore:rules
```

**Step 2: Deploy Cloud Functions (if any changes)**
```bash
firebase deploy --only functions
```

**Step 3: Deploy Frontend (Hosting)**
```bash
firebase deploy --only hosting
```

**Step 4: Initialize Database**
```bash
node scripts/initialize-minor-league.js --with-sample-data
```

**Step 5: Verify Deployment**
- Test both leagues in production
- Check Firebase Console logs
- Monitor error rates
- Verify scheduled functions running

### Post-Deployment Monitoring

**First 24 Hours:**
- Monitor Firebase Console → Functions → Logs
- Check for errors in both major and minor league functions
- Verify scheduled functions execute on time
- Monitor Firestore usage/quotas

**First Week:**
- Gather user feedback
- Monitor performance metrics
- Check for any edge cases
- Document any issues

### Rollback Procedures

**If Critical Issues Occur:**

1. **Rollback Frontend:**
   ```bash
   firebase hosting:rollback
   ```

2. **Rollback Functions:**
   ```bash
   firebase functions:rollback
   ```

3. **Rollback Rules:**
   - Manually revert firestore.rules
   - Redeploy: `firebase deploy --only firestore:rules`

4. **Database Cleanup (if needed):**
   - Delete minor_ collections manually from Firebase Console
   - Or keep them but prevent frontend access

---

## Reference Documentation

### Key Files in Codebase

**Backend:**
- `functions/index.js` - Main Cloud Functions (5,169 lines)
- `functions/draft-prospects.js` - Draft system (291 lines)
- `functions/league-helpers.js` - League utilities (61 lines)

**Frontend:**
- `js/firebase-init.js` - Firebase initialization and collection names
- `admin/*.js` - Admin portal functions (11 files)
- `gm/*.js` - GM portal functions (2 files)
- `scorekeeper/*.js` - Scorekeeper portal functions (3 files)

**Configuration:**
- `firestore.rules` - Security rules (331 lines currently)
- `firebase.json` - Firebase configuration
- `.firebaserc` - Firebase project aliases

**Documentation:**
- `MIGRATION_GUIDE.md` - Frontend API guide (345 lines)
- `migration.md` - Original implementation guide (826 lines)
- `MIGRATION_CONTINUATION_PROMPT.md` - This document

**Scripts:**
- `scripts/initialize-minor-league.js` - Database initialization
- `scripts/seed-firestore.js` - Example seed script (reference)

### Important Code Locations

**getCollectionName Function:**
- Location: `functions/index.js` lines 584-616
- Purpose: Returns correct collection name with league prefix
- Usage: `getCollectionName('seasons', 'minor')` → `'minor_seasons'`

**League Constants:**
- Location: `functions/index.js` line 20-23
- Values: `{ MAJOR: 'major', MINOR: 'minor' }`

**Scheduled Functions:**
- Major league: Lines 3800-4700 (approx)
- Minor league: Same section, prefixed with `minor_`

**Document Triggers:**
- Major league: Lines 2700-3700 (approx)
- Minor league: Same section, prefixed with `minor_`

### Collection Structure Reference

**Top-Level Collections:**
```
Major League:
  seasons/
  v2_players/
  v2_teams/
  live_games/
  lineup_deadlines/
  pending_lineups/
  live_scoring_status/
  transactions/
  pending_transactions/
  draftPicks/
  archived_live_games/

Minor League (same structure, prefixed):
  minor_seasons/
  minor_v2_players/
  minor_v2_teams/
  minor_live_games/
  minor_lineup_deadlines/
  minor_pending_lineups/
  minor_live_scoring_status/
  minor_transactions/
  minor_pending_transactions/
  minor_draftPicks/
  minor_archived_live_games/

Shared (no prefix):
  users/
  notifications/
  scorekeeper_activity_log/
```

**Subcollections (under seasons/):**
```
seasons/{seasonId}/
  games/
  post_games/
  exhibition_games/
  lineups/
  post_lineups/
  draft_prospects/

minor_seasons/{seasonId}/
  minor_games/
  minor_post_games/
  minor_exhibition_games/
  minor_lineups/
  minor_post_lineups/
  minor_draft_prospects/
```

### API Reference

**Updated Functions (all accept optional `league` parameter):**

```javascript
// Admin Functions
setLineupDeadline({ date, time, timeZone, league })
admin_recalculatePlayerStats({ seasonId, league })
admin_updatePlayerId({ oldId, newId, league })
admin_updatePlayerDetails({ playerId, updates, league })
rebrandTeam({ teamId, newName, newLogo, league })
createNewSeason({ seasonNumber, league })
createHistoricalSeason({ seasonNumber, league })
generatePostseasonSchedule({ seasonId, league })
calculatePerformanceAwards({ seasonId, league })
admin_processTransaction({ transaction, league })
forceLeaderboardRecalculation({ seasonId, league })

// Scorekeeper Functions
stageLiveLineups({ gameId, homeLineup, awayLineup, league })
activateLiveGame({ gameId, league })
finalizeLiveGame({ gameId, league })
scorekeeperFinalizeAndProcess({ gameId, league })
generateGameWriteup({ gameId, league })
getReportData({ gameId, league })
updateAllLiveScores({ league })
setLiveScoringStatus({ isActive, league })

// Public Functions
getLiveKarma({ league })

// Draft Functions
addDraftProspects({ handles, league })
```

**Response Format:**
```javascript
{
  success: true,
  league: 'minor',  // Always included now
  message: "Operation completed successfully",
  // ... other response data
}
```

---

## Troubleshooting Guide

### Common Issues and Solutions

**Issue 1: "Collection not found" errors**
- **Cause**: Firestore collections don't exist yet
- **Solution**: Run `node scripts/initialize-minor-league.js`

**Issue 2: "Permission denied" on minor league queries**
- **Cause**: Firestore rules not updated
- **Solution**: Deploy updated rules: `firebase deploy --only firestore:rules`

**Issue 3: Function calls missing league parameter**
- **Cause**: Forgot to add `league: getCurrentLeague()`
- **Solution**: Review all `httpsCallable` invocations

**Issue 4: Hardcoded collection names still present**
- **Cause**: Incomplete frontend migration
- **Solution**: Run validation script, update remaining files

**Issue 5: League switcher not updating data**
- **Cause**: Missing `leagueChanged` event listeners
- **Solution**: Add event listener to reload data on league change

**Issue 6: Cross-league data contamination**
- **Cause**: Function receiving wrong league parameter
- **Solution**: Add logging to verify league parameter in functions

**Issue 7: Scheduled functions not running for minor league**
- **Cause**: Functions not deployed or Cloud Scheduler not configured
- **Solution**: Check deployed functions list, verify schedules

---

## Success Criteria

Migration is considered **COMPLETE** when:

### Backend (Already Complete ✅)
- [x] All callable functions accept league parameter
- [x] All helper functions propagate league context
- [x] All scheduled functions have minor league equivalents
- [x] All document triggers have league-specific versions
- [x] Functions deployed to Firebase

### Database (In Progress)
- [ ] All minor league collections created in Firestore
- [ ] Sample data populated for testing
- [ ] Firestore security rules updated and deployed
- [ ] Rules tested and verified working

### Frontend (Not Started)
- [ ] League context management system implemented
- [ ] League switcher component created and deployed
- [ ] All Cloud Function calls include league parameter
- [ ] All Firestore queries use dynamic collection names
- [ ] League change event handling implemented
- [ ] All pages work with both leagues

### Testing (Not Started)
- [ ] Backend functions tested with both leagues
- [ ] Data isolation verified
- [ ] Frontend tested with both leagues
- [ ] Cross-browser testing completed
- [ ] User acceptance testing completed
- [ ] Major league regression testing passed

### Documentation & Deployment (Partial)
- [x] API migration guide created
- [ ] User training materials created
- [ ] Deployment checklist completed
- [ ] Monitoring dashboard configured
- [ ] Production deployment successful

---

## Next Steps for AI Agent

**Immediate Actions (Priority Order):**

1. **Run Database Initialization Script**
   - Execute: `node scripts/initialize-minor-league.js --with-sample-data`
   - Verify collections in Firebase Console

2. **Update Firestore Security Rules**
   - Add minor league rules to `firestore.rules`
   - Deploy: `firebase deploy --only firestore:rules`
   - Test access from frontend

3. **Implement League Context System**
   - Update `js/firebase-init.js` with league state management
   - Test in browser console

4. **Create League Switcher Component**
   - Build `common/league-switcher.js`
   - Add to one admin page for testing
   - Verify functionality

5. **Update One Critical Page End-to-End**
   - Choose: `admin/manage-games.js`
   - Add league context
   - Update function calls
   - Update Firestore queries
   - Test thoroughly in both leagues
   - Use as template for remaining pages

6. **Systematic Frontend Migration**
   - Work through all admin pages
   - Then GM pages
   - Then scorekeeper pages
   - Test each before moving to next

7. **End-to-End Testing**
   - Test complete workflows in both leagues
   - Verify data isolation
   - Test concurrent operations

8. **Production Deployment**
   - Follow deployment checklist
   - Monitor for 48 hours
   - Gather user feedback

---

## Contact and Support

For questions about this migration:
- Review `MIGRATION_GUIDE.md` for frontend API details
- Review `migration.md` for original implementation guide
- Check Firebase Console logs for function errors
- Review this document for comprehensive instructions

---

## Appendix A: Code Snippets

### A1: Testing Collection Names in Console

```javascript
// In browser console, after implementing league context:

import { getCurrentLeague, setCurrentLeague, collectionNames, getLeagueCollectionName } from './js/firebase-init.js';

// Test major league
setCurrentLeague('major');
console.log('Major League Collections:');
console.log('Seasons:', collectionNames.seasons);
console.log('Players:', collectionNames.players);
console.log('Teams:', collectionNames.teams);

// Test minor league
setCurrentLeague('minor');
console.log('Minor League Collections:');
console.log('Seasons:', collectionNames.seasons);
console.log('Players:', collectionNames.players);
console.log('Teams:', collectionNames.teams);
```

### A2: Debugging Function Calls

```javascript
// Wrap httpsCallable to log league parameter
const originalHttpsCallable = httpsCallable;
window.httpsCallable = function(functions, functionName) {
    const callable = originalHttpsCallable(functions, functionName);
    return async (data) => {
        console.log(`Calling ${functionName} with league:`, data?.league || 'default (major)');
        return callable(data);
    };
};
```

### A3: Monitoring League Changes

```javascript
// Add to any page for debugging
window.addEventListener('leagueChanged', (event) => {
    console.log('=== LEAGUE CHANGED ===');
    console.log('New league:', event.detail.league);
    console.log('Timestamp:', new Date().toISOString());
    console.log('Current page:', window.location.pathname);
});
```

---

## Appendix B: Migration Timeline Estimate

**Assuming one developer working full-time:**

| Phase | Tasks | Estimated Time |
|-------|-------|----------------|
| Database Setup | Run script, update rules, deploy | 1-2 hours |
| Frontend Context | Implement league management | 2-3 hours |
| League Switcher | Build and integrate component | 1-2 hours |
| Update Function Calls | All admin/GM/scorekeeper pages | 3-4 hours |
| Update Firestore Queries | All pages and components | 4-6 hours |
| Event Handling | Add league change listeners | 2-3 hours |
| Testing | Unit, integration, E2E tests | 6-8 hours |
| Documentation | Update and create user guides | 2-3 hours |
| Deployment & Monitoring | Deploy and verify | 2-3 hours |
| **Total** | | **23-34 hours** |

**Recommended Schedule:**
- Day 1: Database setup + frontend context (4-5 hours)
- Day 2: League switcher + start function call updates (6-8 hours)
- Day 3: Complete function calls + start Firestore queries (6-8 hours)
- Day 4: Complete Firestore queries + event handling (6-8 hours)
- Day 5: Testing + deployment (8-10 hours)

---

## Appendix C: Validation Checklist

Use this checklist to verify each component:

### Backend Validation
- [ ] `getCollectionName('seasons', 'minor')` returns `'minor_seasons'`
- [ ] `getCollectionName('users', 'minor')` returns `'users'` (shared)
- [ ] `validateLeague('major')` doesn't throw
- [ ] `validateLeague('invalid')` throws error
- [ ] All 28 callable functions have league parameter
- [ ] All 11 helper functions have league parameter
- [ ] All 10 minor scheduled functions deployed
- [ ] All 7 minor triggers deployed

### Database Validation
- [ ] `minor_seasons` collection exists
- [ ] `minor_v2_players` collection exists
- [ ] `minor_v2_teams` collection exists
- [ ] All 11 top-level minor collections exist
- [ ] Season document has correct structure
- [ ] All 6 subcollections exist under season
- [ ] Security rules allow authenticated read
- [ ] Security rules allow admin write

### Frontend Validation
- [ ] `getCurrentLeague()` returns current league
- [ ] `setCurrentLeague('minor')` updates state
- [ ] `leagueChanged` event fires on switch
- [ ] `collectionNames.seasons` returns correct value for league
- [ ] League switcher renders
- [ ] League switcher changes state
- [ ] All function calls include league
- [ ] All queries use dynamic collection names
- [ ] Pages reload on league change

---

**END OF MIGRATION CONTINUATION PROMPT**

*This document should provide complete guidance for any AI agent or developer to seamlessly continue and complete the multi-league migration for the Real Karma League.*
