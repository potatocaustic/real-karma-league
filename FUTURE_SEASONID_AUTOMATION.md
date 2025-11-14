# Future seasonId Field Automation Guide

## Overview

This guide provides instructions for an LLM (or developer) to modify Cloud Functions and other backend processes to **automatically include the `seasonId` field** when creating new seasonal documents. This ensures that future seasons (S10, S11, etc.) will work seamlessly with the optimized server-side filtering queries.

## Background

After the seasonId migration, all seasonal documents now have a `seasonId` field that matches their document ID:
- Document path: `v2_teams/teamA/seasonal_records/S9`
- Document data: `{ seasonId: 'S9', team_name: '...', wins: 10, ... }`

This enables efficient server-side filtering:
```javascript
query(collectionGroup(db, 'seasonal_records'), where('seasonId', '==', 'S9'))
```

## Task Description

**Goal:** Modify all Cloud Functions and processes that create new seasonal documents to automatically include the `seasonId` field.

**Target Collections:**
1. `v2_teams/{teamId}/seasonal_records/{seasonId}` - Team seasonal records
2. `v2_players/{playerId}/seasonal_stats/{seasonId}` - Player seasonal stats

**Target Subcollections for Minor League:**
1. `minor_v2_teams/{teamId}/minor_seasonal_records/{seasonId}`
2. `minor_v2_players/{playerId}/minor_seasonal_stats/{seasonId}`

## Step-by-Step Implementation

### Step 1: Locate Functions That Create Seasonal Documents

Search the codebase for functions that create seasonal records or stats:

```bash
# Search for functions creating seasonal_records
grep -r "seasonal_records" functions/ --include="*.js"

# Search for functions creating seasonal_stats
grep -r "seasonal_stats" functions/ --include="*.js"

# Search for setDoc, updateDoc, batch.set
grep -r "setDoc\|updateDoc\|batch\.set" functions/ --include="*.js"
```

**Key files to check:**
- `functions/seasons/season-creation.js` - New season creation
- `functions/games/game-processing.js` - Game result processing
- `functions/stats-rankings/player-rankings.js` - Player stats updates
- `functions/admin/admin-players.js` - Admin player operations
- `functions/admin/admin-teams.js` - Admin team operations
- Any function that calls `recalculatePlayerStats` or similar

### Step 2: Identify Document Creation Patterns

Look for these patterns:

#### Pattern 1: Direct setDoc/updateDoc
```javascript
// ❌ BEFORE - Missing seasonId
await setDoc(doc(db, 'v2_teams', teamId, 'seasonal_records', seasonId), {
    team_name: teamName,
    wins: 0,
    losses: 0,
    // ... other fields
});
```

#### Pattern 2: Batch Writes
```javascript
// ❌ BEFORE - Missing seasonId
const batch = db.batch();
const recordRef = doc(db, 'v2_teams', teamId, 'seasonal_records', seasonId);
batch.set(recordRef, {
    team_name: teamName,
    wins: 0,
    losses: 0
});
```

#### Pattern 3: Update Operations
```javascript
// ❌ BEFORE - Missing seasonId
await updateDoc(doc(db, 'v2_players', playerId, 'seasonal_stats', seasonId), {
    games_played: newValue,
    points: newPoints
});
```

### Step 3: Add seasonId to All Writes

Modify each instance to include `seasonId`:

#### Pattern 1 Fix: Direct setDoc/updateDoc
```javascript
// ✅ AFTER - Include seasonId
await setDoc(doc(db, 'v2_teams', teamId, 'seasonal_records', seasonId), {
    seasonId: seasonId,  // ← ADD THIS LINE
    team_name: teamName,
    wins: 0,
    losses: 0,
    // ... other fields
});
```

#### Pattern 2 Fix: Batch Writes
```javascript
// ✅ AFTER - Include seasonId
const batch = db.batch();
const recordRef = doc(db, 'v2_teams', teamId, 'seasonal_records', seasonId);
batch.set(recordRef, {
    seasonId: seasonId,  // ← ADD THIS LINE
    team_name: teamName,
    wins: 0,
    losses: 0
});
```

#### Pattern 3 Fix: Update Operations
```javascript
// ✅ AFTER - Include seasonId (but only on first create, not every update)
// For updates, you typically don't need to re-set seasonId if it exists
// But if creating for the first time, include it:
await setDoc(doc(db, 'v2_players', playerId, 'seasonal_stats', seasonId), {
    seasonId: seasonId,  // ← ADD THIS LINE
    games_played: 0,
    points: 0
}, { merge: true });
```

**Important for updateDoc:**
- If the document already exists (from migration), `updateDoc` won't need to set `seasonId`
- If it's a **new document** (first write), use `setDoc` with `merge: true` to ensure `seasonId` is included
- Add a comment explaining this distinction

### Step 4: Specific Functions to Modify

Here are likely candidates based on common patterns:

#### A. Season Creation Functions

**File:** `functions/seasons/season-creation.js`

Look for:
- `createNewSeason` function
- Any code that initializes team seasonal records
- Any code that initializes player seasonal stats

**Example modification:**
```javascript
// In createNewSeason function
for (const team of teams) {
    const seasonalRecordRef = doc(db, 'v2_teams', team.id, 'seasonal_records', newSeasonId);
    batch.set(seasonalRecordRef, {
        seasonId: newSeasonId,  // ← ADD THIS
        team_name: team.name,
        wins: 0,
        losses: 0,
        // ... other default fields
    });
}
```

#### B. Game Processing Functions

**File:** `functions/games/game-processing.js`

Look for:
- Functions that update team records after games
- Functions that update player stats after games
- Any `updateDoc` calls that modify seasonal documents

**Example modification:**
```javascript
// When updating team records after a game
const teamRecordRef = doc(db, 'v2_teams', teamId, 'seasonal_records', seasonId);

// Use setDoc with merge to ensure seasonId exists
await setDoc(teamRecordRef, {
    seasonId: seasonId,  // ← Ensures field exists even if document is new
    wins: newWins,
    losses: newLosses
}, { merge: true });
```

#### C. Player Stats Recalculation

**File:** `functions/admin/admin-players.js`

Look for:
- `admin_recalculatePlayerStats` function
- Any function that rebuilds seasonal stats from scratch

**Example modification:**
```javascript
// When recalculating player stats
const statsRef = doc(db, 'v2_players', playerId, 'seasonal_stats', seasonId);
await setDoc(statsRef, {
    seasonId: seasonId,  // ← ADD THIS
    games_played: calculatedGames,
    points: calculatedPoints,
    // ... all other calculated stats
});
```

#### D. Draft Results Processing

**File:** `functions/draft/draft-results.js`

Look for:
- Code that creates initial player stats when drafted
- Code that assigns players to teams

**Example modification:**
```javascript
// When a player is drafted, initialize their seasonal stats
const statsRef = doc(db, 'v2_players', playerId, 'seasonal_stats', currentSeasonId);
await setDoc(statsRef, {
    seasonId: currentSeasonId,  // ← ADD THIS
    team_id: teamId,
    games_played: 0,
    // ... other initial fields
}, { merge: true });
```

### Step 5: Handle Minor League

Don't forget minor league collections! Apply the same changes to:
- `minor_v2_teams/{teamId}/minor_seasonal_records/{seasonId}`
- `minor_v2_players/{playerId}/minor_seasonal_stats/{seasonId}`

Look for functions with `minor_` prefix:
```javascript
// Example for minor league
const minorStatsRef = doc(db, 'minor_v2_players', playerId, 'minor_seasonal_stats', seasonId);
await setDoc(minorStatsRef, {
    seasonId: seasonId,  // ← ADD THIS for minor league too
    games_played: 0,
    // ... other fields
});
```

### Step 6: Create Helper Functions (Optional but Recommended)

To prevent forgetting `seasonId` in the future, create helper functions:

**File:** `functions/utils/firestore-helpers.js` (create if doesn't exist)

```javascript
/**
 * Creates or updates a team's seasonal record with automatic seasonId inclusion
 * @param {string} teamId - Team document ID
 * @param {string} seasonId - Season ID (e.g., 'S10')
 * @param {object} data - Record data (wins, losses, etc.)
 * @param {boolean} merge - Whether to merge with existing data
 */
async function setTeamSeasonalRecord(teamId, seasonId, data, merge = false) {
    const recordRef = doc(db, 'v2_teams', teamId, 'seasonal_records', seasonId);
    await setDoc(recordRef, {
        seasonId: seasonId,  // Automatically included
        ...data
    }, { merge });
}

/**
 * Creates or updates a player's seasonal stats with automatic seasonId inclusion
 * @param {string} playerId - Player document ID
 * @param {string} seasonId - Season ID (e.g., 'S10')
 * @param {object} data - Stats data
 * @param {boolean} merge - Whether to merge with existing data
 */
async function setPlayerSeasonalStats(playerId, seasonId, data, merge = false) {
    const statsRef = doc(db, 'v2_players', playerId, 'seasonal_stats', seasonId);
    await setDoc(statsRef, {
        seasonId: seasonId,  // Automatically included
        ...data
    }, { merge });
}

module.exports = {
    setTeamSeasonalRecord,
    setPlayerSeasonalStats
};
```

Then use these helpers throughout the codebase:
```javascript
const { setTeamSeasonalRecord, setPlayerSeasonalStats } = require('./utils/firestore-helpers');

// Instead of manual setDoc:
await setTeamSeasonalRecord(teamId, 'S10', {
    team_name: 'Team Name',
    wins: 10,
    losses: 5
});

// The helper automatically adds seasonId!
```

### Step 7: Update Season Creation Template

**File:** `functions/seasons/season-creation.js`

Ensure the season creation function has a clear template that includes `seasonId`:

```javascript
// Template for new team seasonal records
const TEAM_SEASONAL_RECORD_TEMPLATE = (seasonId, teamData) => ({
    seasonId: seasonId,           // ← REQUIRED
    team_name: teamData.name,
    wins: 0,
    losses: 0,
    ties: 0,
    points_for: 0,
    points_against: 0,
    // ... other default fields
});

// Template for new player seasonal stats
const PLAYER_SEASONAL_STATS_TEMPLATE = (seasonId, playerData) => ({
    seasonId: seasonId,           // ← REQUIRED
    player_name: playerData.name,
    games_played: 0,
    games_started: 0,
    points: 0,
    // ... other default fields
});

// Use these templates when creating new season
async function createNewSeason(seasonId) {
    const batch = db.batch();
    
    // Create team records
    const teams = await getTeams();
    for (const team of teams) {
        const recordRef = doc(db, 'v2_teams', team.id, 'seasonal_records', seasonId);
        batch.set(recordRef, TEAM_SEASONAL_RECORD_TEMPLATE(seasonId, team));
    }
    
    // Create player stats
    const players = await getPlayers();
    for (const player of players) {
        const statsRef = doc(db, 'v2_players', player.id, 'seasonal_stats', seasonId);
        batch.set(statsRef, PLAYER_SEASONAL_STATS_TEMPLATE(seasonId, player));
    }
    
    await batch.commit();
}
```

## Testing Your Changes

After making modifications:

### 1. Test in Development Environment

```javascript
// Create a test season
const testSeasonId = 'S10_TEST';

// Create a test team record
await setTeamSeasonalRecord('test_team', testSeasonId, {
    team_name: 'Test Team',
    wins: 0,
    losses: 0
});

// Verify seasonId field exists
const recordSnap = await getDoc(doc(db, 'v2_teams', 'test_team', 'seasonal_records', testSeasonId));
console.log('Has seasonId:', recordSnap.data().seasonId === testSeasonId);
```

### 2. Verify Query Works

```javascript
// Test that server-side filtering works
const query1 = query(
    collectionGroup(db, 'seasonal_records'),
    where('seasonId', '==', testSeasonId)
);
const snap = await getDocs(query1);
console.log('Found records:', snap.size);
```

### 3. Test Season Creation

Create a full test season and verify:
- All team seasonal_records have `seasonId`
- All player seasonal_stats have `seasonId`
- Queries work correctly

## Checklist

Use this checklist when implementing:

- [ ] Search all functions for seasonal_records writes
- [ ] Search all functions for seasonal_stats writes  
- [ ] Update season creation functions
- [ ] Update game processing functions
- [ ] Update player stats recalculation functions
- [ ] Update admin functions
- [ ] Update draft processing functions
- [ ] Update minor league equivalents
- [ ] Create helper functions (optional)
- [ ] Add templates with seasonId included
- [ ] Test in development environment
- [ ] Verify queries work with new documents
- [ ] Deploy to production
- [ ] Monitor first new season creation

## Common Pitfalls

### ❌ Pitfall 1: Forgetting Minor League
```javascript
// Don't forget minor league collections!
// Wrong: Only updating major league
await setDoc(doc(db, 'v2_teams', teamId, 'seasonal_records', seasonId), {...});

// Right: Update both
await setDoc(doc(db, 'v2_teams', teamId, 'seasonal_records', seasonId), {seasonId, ...});
await setDoc(doc(db, 'minor_v2_teams', teamId, 'minor_seasonal_records', seasonId), {seasonId, ...});
```

### ❌ Pitfall 2: Using updateDoc on New Documents
```javascript
// Wrong: updateDoc will fail if document doesn't exist
await updateDoc(statsRef, { seasonId, games_played: 5 });

// Right: Use setDoc with merge for new documents
await setDoc(statsRef, { seasonId, games_played: 5 }, { merge: true });
```

### ❌ Pitfall 3: Hardcoding Season ID
```javascript
// Wrong: Hardcoded season
const seasonId = 'S9';

// Right: Get current season dynamically
const seasonDoc = await getCurrentSeason();
const seasonId = seasonDoc.id;
```

### ❌ Pitfall 4: Missing in Batch Operations
```javascript
// Wrong: Forgot seasonId in batch
batch.set(recordRef, { wins: 0, losses: 0 });

// Right: Include seasonId in batch
batch.set(recordRef, { seasonId: seasonId, wins: 0, losses: 0 });
```

## Verification After Implementation

After deploying your changes, verify with this query in Firebase Console:

```javascript
// Check that all seasonal documents have seasonId
// Run this in Firestore console or a test script

const recordsWithoutSeasonId = [];
const statsWithoutSeasonId = [];

const recordsSnap = await getDocs(collectionGroup(db, 'seasonal_records'));
recordsSnap.forEach(doc => {
    if (!doc.data().seasonId) {
        recordsWithoutSeasonId.push(doc.ref.path);
    }
});

const statsSnap = await getDocs(collectionGroup(db, 'seasonal_stats'));
statsSnap.forEach(doc => {
    if (!doc.data().seasonId) {
        statsWithoutSeasonId.push(doc.ref.path);
    }
});

console.log('Records without seasonId:', recordsWithoutSeasonId.length);
console.log('Stats without seasonId:', statsWithoutSeasonId.length);

// Should be 0 for new seasons!
```

## Summary

**Key principle:** Every time you write to a seasonal document, **always include `seasonId`**.

**Quick rule:**
- If you see `seasonal_records` or `seasonal_stats` in your code
- And you're using `setDoc`, `batch.set`, or `updateDoc`
- **Make sure `seasonId` is in the data object**

This ensures that:
1. Future seasons work with optimized queries
2. Server-side filtering reduces Firestore costs
3. No manual migration needed for new seasons
4. Consistent data structure across all seasons
