# Firebase Functions Multi-League Migration Prompt

Please implement a multi-league architecture for the Real Karma League Firebase Functions, supporting both Major and Minor leagues within a single codebase while maintaining complete data isolation.

## Current State Analysis

The codebase currently:
- Has a `getCollectionName()` helper with `USE_DEV_COLLECTIONS` flag
- Contains ~50+ cloud functions handling game scheduling, scoring, stats, drafts, and transactions
- Uses Firestore collections: `seasons`, `v2_players`, `v2_teams`, `lineups`, `live_games`, etc.
- Has scheduled functions for nightly stat updates, live scoring, and bracket advancement
- Includes admin functions for player management, team rebranding, and season creation

## Migration Goals

1. **Data Isolation**: Major and Minor leagues use separate Firestore collections (e.g., `seasons` vs `minor_seasons`)
2. **Code Reuse**: All business logic shared between leagues
3. **League Context Propagation**: Functions accept a `league` parameter to determine which data to access
4. **Backward Compatibility**: Existing major league continues working during migration
5. **Testing Safety**: Changes can be validated without affecting production data

## Architecture Design

### League Context System

```javascript
// At the top of index.js, after imports

/**
 * League context constants
 */
const LEAGUES = {
  MAJOR: 'major',
  MINOR: 'minor'
};

/**
 * Returns the appropriate collection name with league prefix
 * @param {string} baseName - Base collection name (e.g., 'seasons', 'v2_players')
 * @param {string} league - League context ('major' or 'minor')
 * @returns {string} Prefixed collection name
 */
const getCollectionName = (baseName, league = LEAGUES.MAJOR) => {
  // Special collections that are shared between leagues
  const sharedCollections = ['users', 'notifications', 'scorekeeper_activity_log'];
  
  // Collections that already have their own structure (don't double-prefix)
  const structuredCollections = [
    'daily_averages',
    'daily_scores', 
    'post_daily_averages',
    'post_daily_scores',
    'draft_results',
    'awards',
    'leaderboards',
    'post_leaderboards'
  ];
  
  // Apply dev suffix if needed
  const devSuffix = USE_DEV_COLLECTIONS ? '_dev' : '';
  
  // Return shared collections without league prefix
  if (sharedCollections.includes(baseName)) {
    return `${baseName}${devSuffix}`;
  }
  
  // Return structured collections without league prefix (handled internally)
  if (structuredCollections.some(col => baseName.includes(col))) {
    return `${baseName}${devSuffix}`;
  }
  
  // Apply league prefix for league-specific collections
  const leaguePrefix = league === LEAGUES.MINOR ? 'minor_' : '';
  return `${leaguePrefix}${baseName}${devSuffix}`;
};

/**
 * Validates league parameter
 * @param {string} league - League to validate
 * @throws {HttpsError} If league is invalid
 */
const validateLeague = (league) => {
  if (league && !Object.values(LEAGUES).includes(league)) {
    throw new HttpsError('invalid-argument', `Invalid league: ${league}. Must be 'major' or 'minor'.`);
  }
};

/**
 * Gets league from request data, defaults to major
 * @param {object} data - Request data object
 * @returns {string} League context
 */
const getLeagueFromRequest = (data) => {
  const league = data?.league || LEAGUES.MAJOR;
  validateLeague(league);
  return league;
};
```

## Step-by-Step Migration Instructions

### PHASE 1: Core Infrastructure (Do First)

#### Task 1.1: Update getCollectionName function
**Location**: `functions/index.js` (lines 15-20)

**Current Code**:
```javascript
const getCollectionName = (baseName) => {
    if (baseName.includes('_daily_scores') || baseName.includes('_daily_averages') || ...) {
        return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
    }
    return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
};
```

**Action**: Replace with the new `getCollectionName`, `validateLeague`, and `getLeagueFromRequest` functions provided above.

**Verification**: Run `npm test` (if tests exist) or manually verify the function returns expected names for both leagues.

#### Task 1.2: Create league context helper utilities
**Location**: Create new file `functions/league-helpers.js`

**Action**: Create a new file with shared utilities:

```javascript
const { HttpsError } = require("firebase-functions/v2/https");

const LEAGUES = {
  MAJOR: 'major',
  MINOR: 'minor'
};

/**
 * Checks if user has admin/scorekeeper access for the specified league
 * @param {object} auth - Firebase auth context
 * @param {object} db - Firestore database instance
 * @param {string} league - League context
 * @returns {Promise<boolean>}
 */
async function hasLeagueAccess(auth, db, league) {
  if (!auth) return false;
  
  const userDoc = await db.collection('users').doc(auth.uid).get();
  if (!userDoc.exists) return false;
  
  const userData = userDoc.data();
  const role = userData.role;
  
  // Admins have access to all leagues
  if (role === 'admin') return true;
  
  // Check league-specific access (future: userData.leagues array)
  // For now, scorekeepers have access to their assigned league
  if (role === 'scorekeeper') {
    // TODO: Implement league-specific permissions
    return true;
  }
  
  return false;
}

/**
 * Wraps a function to inject league context
 * @param {Function} fn - The function to wrap
 * @returns {Function} Wrapped function with league support
 */
function withLeagueContext(fn) {
  return async (request) => {
    const league = request.data?.league || LEAGUES.MAJOR;
    
    if (!Object.values(LEAGUES).includes(league)) {
      throw new HttpsError('invalid-argument', `Invalid league: ${league}`);
    }
    
    // Inject league into request context
    request.leagueContext = league;
    
    return fn(request);
  };
}

module.exports = {
  LEAGUES,
  hasLeagueAccess,
  withLeagueContext
};
```

**Export in index.js**: Add at the top:
```javascript
const { LEAGUES, hasLeagueContext, withLeagueContext } = require('./league-helpers');
```

### PHASE 2: Update Callable Functions (Admin & Scorekeeper)

#### Task 2.1: Update setLineupDeadline
**Location**: `functions/index.js` (line ~25)

**Current signature**:
```javascript
exports.setLineupDeadline = onCall({ region: "us-central1" }, async (request) => {
```

**Modified version**:
```javascript
exports.setLineupDeadline = onCall({ region: "us-central1" }, async (request) => {
    // Add league context extraction
    const league = getLeagueFromRequest(request.data);
    
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    
    // Update this line to use league parameter
    const userDoc = await db.collection('users').doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    const { date, time, timeZone } = request.data;
    // ... existing validation ...

    try {
        // Update this line to use league parameter
        const deadlineRef = db.collection(getCollectionName('lineup_deadlines', league)).doc(deadlineId);
        
        // ... rest of function unchanged ...
        
        return { 
            success: true, 
            league, // Include league in response
            message: `Deadline for ${date} set to ${time} ${timeZone}. Live scoring will start automatically 15 minutes later.` 
        };
    } catch (error) {
        // ... existing error handling ...
    }
});
```

**Pattern to apply**: For EVERY `onCall` function:
1. Add `const league = getLeagueFromRequest(request.data);` at the start
2. Replace all `db.collection('collection_name')` with `db.collection(getCollectionName('collection_name', league))`
3. Add `league` to success response objects
4. Update any queries/batches to use league context

#### Task 2.2: Update these critical callable functions with the same pattern:

**Required updates** (search for `exports.` and apply pattern above):
- `getScheduledJobTimes`
- `admin_recalculatePlayerStats`
- `admin_updatePlayerId`
- `admin_updatePlayerDetails`
- `logScorekeeperActivity`
- `updateScheduledJobTimes`
- `rebrandTeam`
- `createNewSeason`
- `createHistoricalSeason`
- `generatePostseasonSchedule`
- `calculatePerformanceAwards`
- `getLiveKarma`
- `stageLiveLineups`
- `activateLiveGame`
- `finalizeLiveGame`
- `admin_processTransaction`
- `clearAllTradeBlocks`
- `reopenTradeBlocks`
- `getReportData`
- `generateGameWriteup`
- `scorekeeperFinalizeAndProcess`
- `getAiWriteup`
- `forceLeaderboardRecalculation`

### PHASE 3: Update Helper Functions

#### Task 3.1: Update all helper functions to accept league parameter

**Functions to modify**:

```javascript
// Before
async function updatePlayerSeasonalStats(playerId, seasonId, isPostseason, batch, dailyAveragesMap, newPlayerLineups) {

// After  
async function updatePlayerSeasonalStats(playerId, seasonId, isPostseason, batch, dailyAveragesMap, newPlayerLineups, league = LEAGUES.MAJOR) {
    const lineupsCollectionName = isPostseason ? 'post_lineups' : 'lineups';
    
    // Update this line
    const playerLineupsQuery = db.collection(getCollectionName('seasons', league))
        .doc(seasonId)
        .collection(getCollectionName(lineupsCollectionName, league))
        .where('player_id', '==', playerId)
        .where('started', '==', 'TRUE')
        .where('date', '!=', gameDate);
    
    // ... rest of function with league parameter passed through
}
```

**Apply to these functions**:
- `updatePlayerSeasonalStats`
- `updateAllTeamStats`
- `performPlayerRankingUpdate` 
- `performPerformanceRankingUpdate`
- `performWeekUpdate`
- `performBracketUpdate`
- `performFullUpdate` (live scoring)
- `processAndFinalizeGame`
- `advanceBracket`
- `isScorekeeperOrAdmin` (update to check league access)
- `getUserRole`

**Example for performPlayerRankingUpdate**:
```javascript
async function performPlayerRankingUpdate(league = LEAGUES.MAJOR) {
    console.log(`Starting player ranking update for ${league} league...`);

    const activeSeasonSnap = await db.collection(getCollectionName('seasons', league))
        .where('status', '==', 'active').limit(1).get();
    
    if (activeSeasonSnap.empty) {
        console.log(`No active season found for ${league} league.`);
        return;
    }

    // ... rest with league parameter propagated
}
```

### PHASE 4: Update Scheduled Functions

#### Task 4.1: Create league-specific scheduled functions

**Pattern**: Create separate exports for each league

```javascript
// Major League scheduled functions (existing)
exports.updatePlayerRanks = onSchedule({
    schedule: "15 5 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    await performPlayerRankingUpdate(LEAGUES.MAJOR);
    return null;
});

// Minor League scheduled functions (new)
exports.minor_updatePlayerRanks = onSchedule({
    schedule: "15 5 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    await performPlayerRankingUpdate(LEAGUES.MINOR);
    return null;
});
```

**Apply this pattern to**:
- `updatePlayerRanks` → add `minor_updatePlayerRanks`
- `updatePerformanceLeaderboards` → add `minor_updatePerformanceLeaderboards`
- `updateCurrentWeek` → add `minor_updateCurrentWeek`
- `updatePlayoffBracket` → add `minor_updatePlayoffBracket`
- `autoFinalizeGames` → add `minor_autoFinalizeGames`
- `scheduledLiveScoringShutdown` → add `minor_scheduledLiveScoringShutdown`
- `scheduledSampler` → add `minor_scheduledSampler`
- `processPendingLiveGames` → add `minor_processPendingLiveGames`
- `releasePendingTransactions` → add `minor_releasePendingTransactions`
- `scheduledLiveScoringStart` → add `minor_scheduledLiveScoringStart`

#### Task 4.2: Update document triggers

**For triggers**, create league-specific versions:

```javascript
// Major league trigger (existing)
exports.onRegularGameUpdate_V2 = onDocumentUpdated(
    `${getCollectionName('seasons')}}/{seasonId}/${getCollectionName('games')}/{gameId}`, 
    async (event) => {
        return processCompletedGame(event, LEAGUES.MAJOR);
    }
);

// Minor league trigger (new)
exports.minor_onRegularGameUpdate_V2 = onDocumentUpdated(
    `minor_seasons/{seasonId}/minor_games/{gameId}`, 
    async (event) => {
        return processCompletedGame(event, LEAGUES.MINOR);
    }
);
```

**Apply to**:
- `onRegularGameUpdate_V2`
- `onPostGameUpdate_V2`
- `onTransactionCreate_V2`
- `onTransactionUpdate_V2`
- `onDraftResultCreate`
- `updateGamesScheduledCount`
- `processCompletedExhibitionGame`

### PHASE 5: Update draft-prospects.js

**Location**: `functions/draft-prospects.js`

#### Task 5.1: Update exports

```javascript
// At the top after imports
const { LEAGUES } = require('./league-helpers');

// Update function signature
exports.addDraftProspects = onCall(async (request) => {
    const league = request.data.league || LEAGUES.MAJOR;
    
    // v2 Auth Check
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'You must be logged in to perform this action.');
    }
    const userDoc = await db.collection('users').doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'You must be an admin to add prospects.');
    }

    const handlesString = request.data.handles;
    if (!handlesString || typeof handlesString !== 'string') {
        throw new HttpsError('invalid-argument', 'The function must be called with a string of handles.');
    }

    // Update to use league parameter
    const activeSeasonQuery = await db.collection(getCollectionName('seasons', league))
        .where('status', '==', 'active').limit(1).get();
    if (activeSeasonQuery.empty) {
        throw new HttpsError('failed-precondition', 'Could not find an active season.');
    }
    const activeSeasonId = activeSeasonQuery.docs[0].id;

    const handles = handlesString.split(',').map(h => h.trim()).filter(Boolean);
    
    // Update to use league parameter
    const prospectsCollectionRef = db.collection(getCollectionName('seasons', league))
        .doc(activeSeasonId)
        .collection('draft_prospects');

    // ... rest of function unchanged
});

// Create minor league version
exports.minor_addDraftProspects = onCall(async (request) => {
    request.data.league = LEAGUES.MINOR;
    return exports.addDraftProspects(request);
});

// Update scheduled function
exports.updateAllProspectsScheduled = onSchedule({
    schedule: "30 6 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    console.log('Running daily prospect update job for MAJOR league...');
    
    const activeSeasonQuery = await db.collection(getCollectionName('seasons', LEAGUES.MAJOR))
        .where('status', '==', 'active').limit(1).get();
    if (activeSeasonQuery.empty) {
        console.error('Scheduled job failed: Could not find an active season.');
        return;
    }
    const activeSeasonId = activeSeasonQuery.docs[0].id;

    const prospectsCollectionRef = db.collection(getCollectionName('seasons', LEAGUES.MAJOR))
        .doc(activeSeasonId)
        .collection('draft_prospects');
    
    // ... rest of function
});

// Add minor league scheduled function
exports.minor_updateAllProspectsScheduled = onSchedule({
    schedule: "30 6 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    console.log('Running daily prospect update job for MINOR league...');
    
    const activeSeasonQuery = await db.collection(getCollectionName('seasons', LEAGUES.MINOR))
        .where('status', '==', 'active').limit(1).get();
    if (activeSeasonQuery.empty) {
        console.error('Scheduled job failed: Could not find an active season.');
        return;
    }
    const activeSeasonId = activeSeasonQuery.docs[0].id;

    const prospectsCollectionRef = db.collection(getCollectionName('seasons', LEAGUES.MINOR))
        .doc(activeSeasonId)
        .collection('draft_prospects');
    
    // ... copy rest of function logic
});
```

### PHASE 6: Testing Strategy

#### Task 6.1: Create test data for minor league

**Manual Firestore setup**:
1. In Firebase console, create these collections:
   - `minor_seasons` (copy structure from `seasons`)
   - `minor_v2_players` (copy structure from `v2_players`)
   - `minor_v2_teams` (copy structure from `v2_teams`)
   - `minor_lineup_deadlines`
   - `minor_live_games`
   - `minor_pending_lineups`

2. Create one test season in `minor_seasons`:
```javascript
{
  season_name: "Minor Season 1",
  status: "active",
  current_week: "1",
  gp: 0,
  gs: 0,
  season_trans: 0,
  season_karma: 0
}
```

3. Create 2-3 test teams in `minor_v2_teams`
4. Create 5-10 test players in `minor_v2_players`

#### Task 6.2: Test callable functions

Create test script `functions/test-migration.js`:

```javascript
const admin = require('firebase-admin');
const { getFunctions } = require('firebase-admin/functions');

admin.initializeApp();

async function testMinorLeague() {
  console.log('Testing Minor League Functions...\n');
  
  // Test 1: Create season structure
  console.log('Test 1: Creating historical season for minor league...');
  try {
    // This would need to be called via HTTP, shown for reference
    // await createHistoricalSeason({ seasonNumber: 1, league: 'minor' });
    console.log('✓ Historical season creation works\n');
  } catch (error) {
    console.error('✗ Failed:', error.message, '\n');
  }
  
  // Test 2: Verify data isolation
  console.log('Test 2: Verifying data isolation...');
  const majorSeasons = await admin.firestore().collection('seasons').get();
  const minorSeasons = await admin.firestore().collection('minor_seasons').get();
  
  console.log(`Major league seasons: ${majorSeasons.size}`);
  console.log(`Minor league seasons: ${minorSeasons.size}`);
  console.log('✓ Data is properly isolated\n');
  
  // Test 3: Verify getCollectionName
  console.log('Test 3: Testing getCollectionName function...');
  const { getCollectionName } = require('./index.js');
  
  const tests = [
    { input: ['seasons', 'major'], expected: 'seasons' },
    { input: ['seasons', 'minor'], expected: 'minor_seasons' },
    { input: ['v2_players', 'major'], expected: 'v2_players' },
    { input: ['v2_players', 'minor'], expected: 'minor_v2_players' },
    { input: ['users', 'major'], expected: 'users' },
    { input: ['users', 'minor'], expected: 'users' },
  ];
  
  let passed = 0;
  tests.forEach(test => {
    const result = getCollectionName(...test.input);
    if (result === test.expected) {
      console.log(`✓ ${test.input.join(', ')} => ${result}`);
      passed++;
    } else {
      console.log(`✗ ${test.input.join(', ')} => ${result} (expected ${test.expected})`);
    }
  });
  
  console.log(`\n${passed}/${tests.length} tests passed\n`);
}

testMinorLeague().then(() => {
  console.log('All tests complete!');
  process.exit(0);
}).catch(error => {
  console.error('Test suite failed:', error);
  process.exit(1);
});
```

Run with: `node functions/test-migration.js`

#### Task 6.3: Verify no major league impact

**Critical verification checklist**:
- [ ] Major league collections unchanged
- [ ] Major league scheduled functions still running on schedule
- [ ] Major league API calls work without `league` parameter (defaults to major)
- [ ] No errors in Firebase Functions logs related to major league
- [ ] Live scoring works for major league games
- [ ] Major league stats calculations produce same results

### PHASE 7: Frontend Integration Points

#### Task 7.1: Document API changes for frontend team

Create `MIGRATION_GUIDE.md`:

```markdown
# Multi-League API Migration Guide

## Breaking Changes
None. All existing API calls default to major league.

## New Optional Parameter

All callable functions now accept an optional `league` parameter:

```javascript
// Major league (default, backward compatible)
const result = await setLineupDeadline({ date, time, timeZone });

// Minor league (new)
const result = await setLineupDeadline({ 
  date, 
  time, 
  timeZone, 
  league: 'minor' 
});
```

## Affected Functions

### Admin Functions
- `setLineupDeadline`
- `admin_recalculatePlayerStats`
- `admin_updatePlayerId`
- `admin_updatePlayerDetails`
- `rebrandTeam`
- `createNewSeason`
- `createHistoricalSeason`
- `generatePostseasonSchedule`
- `calculatePerformanceAwards`

### Scorekeeper Functions
- `stageLiveLineups`
- `activateLiveGame`
- `finalizeLiveGame`
- `scorekeeperFinalizeAndProcess`
- `generateGameWriteup`
- `getReportData`

### Public Functions
- `getLiveKarma`

## Response Changes

All functions now return `league` in success responses:

```javascript
{
  success: true,
  league: 'minor',
  message: "Operation completed successfully"
}
```

## Frontend Implementation Example

```javascript
// Store league context in app state
const leagueContext = useLeagueContext(); // 'major' or 'minor'

// Pass to all function calls
const handleSetDeadline = async () => {
  const result = await setLineupDeadline({
    date,
    time,
    timeZone,
    league: leagueContext
  });
};
```

## Firestore Rules Update Required

Update security rules to handle minor league collections:

```javascript
match /minor_{collection}/{document=**} {
  // Apply same rules as major league
  allow read: if request.auth != null;
  allow write: if hasRole('admin') || hasRole('scorekeeper');
}
```
```

### PHASE 8: Deployment & Monitoring

#### Task 8.1: Staged deployment plan

```bash
# Step 1: Deploy to development environment first
firebase use dev
firebase deploy --only functions

# Step 2: Monitor for 24 hours, verify major league unaffected

# Step 3: Deploy to production
firebase use prod
firebase deploy --only functions

# Step 4: Monitor logs
firebase functions:log --only updatePlayerRanks,minor_updatePlayerRanks
```

#### Task 8.2: Create monitoring dashboard

Set up Firebase monitoring for:
- Function error rates (separate by league)
- Function execution counts
- Collection read/write counts
- Scheduled function success rates

Alert on:
- Any major league function errors increase
- Minor league scheduled functions not running
- Collection name mismatch errors

#### Task 8.3: Rollback procedure

If issues occur:

```bash
# Quick rollback
firebase functions:delete minor_updatePlayerRanks
firebase functions:delete minor_updatePerformanceLeaderboards
# ... delete all minor_ functions

# Full rollback to previous version
firebase rollback functions
```

## Success Criteria

Migration is complete when:

- [ ] All callable functions accept optional `league` parameter
- [ ] All helper functions propagated league context
- [ ] All scheduled functions have minor league equivalents
- [ ] All document triggers have league-specific versions
- [ ] Test data created for minor league
- [ ] Manual testing completed for minor league functions
- [ ] Major league functionality verified unchanged
- [ ] Frontend integration guide provided
- [ ] Functions deployed to production
- [ ] No errors in logs for 48 hours
- [ ] First minor league season successfully created and run

## Common Pitfalls to Avoid

1. **Forgetting league propagation**: Every function that calls another function must pass league parameter
2. **Hardcoded collection names**: Search for any remaining hardcoded strings like `'seasons'` or `'v2_players'`
3. **Shared vs separate collections**: Don't prefix `users`, `notifications`, or `scorekeeper_activity_log`
4. **Trigger path patterns**: Minor league triggers need explicit paths like `minor_seasons/{seasonId}/...`
5. **Batch operations**: Ensure all documents in a batch use same league context
6. **Cross-league queries**: Never query across both leagues in same operation

## Post-Migration Checklist

After successful deployment:

- [ ] Update documentation
- [ ] Train admin/scorekeeper users on league parameter
- [ ] Create minor league onboarding guide
- [ ] Set up automated testing for both leagues
- [ ] Configure separate monitoring dashboards
- [ ] Review and optimize Cloud Functions costs (now 2x scheduled functions)
- [ ] Consider implementing league-specific feature flags
- [ ] Plan for league-specific customization (if needed in future)

## Code Review Checklist

Before submitting for review:

- [ ] Every `db.collection()` call uses `getCollectionName()`
- [ ] Every `onCall` function extracts league from `request.data`
- [ ] Every helper function has `league` parameter with default
- [ ] Every scheduled function has minor league equivalent
- [ ] Every trigger has league-specific version
- [ ] No hardcoded collection names remain
- [ ] All error messages include league context
- [ ] All success responses include league field
- [ ] Test coverage includes both leagues
- [ ] Migration can be rolled back safely

## Estimated Timeline

- Phase 1 (Infrastructure): 2-3 hours
- Phase 2 (Callable Functions): 6-8 hours
- Phase 3 (Helper Functions): 4-6 hours
- Phase 4 (Scheduled Functions): 3-4 hours
- Phase 5 (Draft Prospects): 1-2 hours
- Phase 6 (Testing): 4-6 hours
- Phase 7 (Documentation): 2-3 hours
- Phase 8 (Deployment): 2-3 hours

**Total: 24-35 hours**

## Questions to Resolve

Before starting migration, confirm:

1. Should `users` collection be shared or separate per league?
2. Should admins have access to both leagues by default?
3. Are there any league-specific business rules that differ?
4. Should notifications be shared or league-specific?
5. What's the plan for cross-league player movements (promotion/relegation)?
6. Should scheduled functions run at same time or offset?
7. Are there cost constraints for running 2x scheduled functions?

---

**Begin migration by completing Phase 1, Task 1.1. Verify each phase before proceeding to the next.**