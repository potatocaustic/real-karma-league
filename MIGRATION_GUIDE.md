# Season ID Migration Guide

## Overview

This guide explains how to implement a one-time data migration to add `seasonId` fields to all seasonal documents in Firestore. This enables **true server-side filtering** in collection group queries, reducing Firestore reads by **40-50%**.

## Why This Migration is Needed

### The Problem

Currently, the codebase uses collection group queries that fetch **ALL** seasons' data, then filters on the client-side:

```javascript
// ❌ CURRENT: Fetches all seasons (S1, S2, S3... S9) - ~300+ documents
const recordsQuery = query(collectionGroup(db, 'seasonal_records'));
const recordsSnap = await getDocs(recordsQuery);

// Client-side filtering - wasteful!
recordsSnap.forEach(doc => {
    if (doc.id === 'S9') {  // Only use S9 data
        // Process document
    }
});
```

**Cost:** If you have 30 teams × 9 seasons = 270 document reads, but only need 30.

### The Solution

Add a `seasonId` field to each document so Firestore can filter server-side:

```javascript
// ✅ AFTER MIGRATION: Only fetches S9 documents - 30 documents
const recordsQuery = query(
    collectionGroup(db, 'seasonal_records'),
    where('seasonId', '==', 'S9')  // Server-side filter!
);
const recordsSnap = await getDocs(recordsQuery);
// All results are already S9 - no client filtering needed!
```

**Savings:** 270 reads → 30 reads = **88% reduction** in Firestore costs for this query.

## Migration Process

### Prerequisites

1. **Admin Access:** You must be logged in as an admin user
2. **Firebase Functions Deployed:** Deploy the migration functions first
3. **Backup:** While the migration is non-destructive (only adds fields), consider backing up your data

### Step-by-Step Instructions

#### 1. Deploy the Migration Functions

First, deploy the new Cloud Functions:

```bash
cd functions
npm install
firebase deploy --only functions:admin_migrateAddSeasonIds,functions:admin_verifySeasonIdMigration
```

#### 2. Access the Migration Tool

Navigate to the migration admin page:
```
https://yourdomain.com/admin/migrate-season-ids.html
```

#### 3. Verify Current Status

Click **"Verify Migration Status"** to see how many documents need migration.

Example output:
```json
{
  "seasonalRecords": {
    "total": 270,
    "withSeasonId": 0,
    "withoutSeasonId": 270
  },
  "seasonalStats": {
    "total": 450,
    "withSeasonId": 0,
    "withoutSeasonId": 450
  },
  "migrationComplete": false
}
```

#### 4. Run Dry Run

**ALWAYS run a dry run first!** This shows what will be changed without modifying the database.

Click **"Run Dry Run"** and review the results:

```json
{
  "teamsProcessed": 30,
  "playersProcessed": 50,
  "seasonalRecordsUpdated": 270,
  "seasonalStatsUpdated": 450,
  "errors": [],
  "dryRun": true
}
```

#### 5. Execute Migration

Once you've verified the dry run looks correct:

1. Click **"Execute Migration"**
2. Confirm the warning dialog
3. Wait for completion (may take 2-5 minutes)

```json
{
  "teamsProcessed": 30,
  "playersProcessed": 50,
  "seasonalRecordsUpdated": 270,
  "seasonalStatsUpdated": 450,
  "errors": [],
  "dryRun": false
}
```

#### 6. Verify Migration Success

Click **"Verify After Migration"** to confirm all documents were updated:

```json
{
  "seasonalRecords": {
    "total": 270,
    "withSeasonId": 270,
    "withoutSeasonId": 0
  },
  "seasonalStats": {
    "total": 450,
    "withSeasonId": 450,
    "withoutSeasonId": 0
  },
  "migrationComplete": true
}
```

## Updating Your Queries

After the migration is complete, update your queries to use server-side filtering.

### Example 1: Team Seasonal Records

**Before (client-side filtering):**
```javascript
const recordsQuery = query(collectionGroup(db, collectionNames.seasonalRecords));
const recordsSnap = await getDocs(recordsQuery);

const seasonalRecordsMap = new Map();
recordsSnap.forEach(doc => {
    // Client-side filtering by season ID
    if (doc.id === SEASON_ID) {
        const teamId = doc.ref.parent.parent.id;
        seasonalRecordsMap.set(teamId, doc.data());
    }
});
```

**After (server-side filtering):**
```javascript
const recordsQuery = query(
    collectionGroup(db, collectionNames.seasonalRecords),
    where('seasonId', '==', SEASON_ID)  // Server-side filter
);
const recordsSnap = await getDocs(recordsQuery);

const seasonalRecordsMap = new Map();
recordsSnap.forEach(doc => {
    // All results are already filtered - no if statement needed!
    const teamId = doc.ref.parent.parent.id;
    seasonalRecordsMap.set(teamId, doc.data());
});
```

### Example 2: Player Seasonal Stats

**Before:**
```javascript
const statsQuery = query(collectionGroup(db, collectionNames.seasonalStats));
const statsSnap = await getDocs(statsQuery);

const statsMap = new Map();
statsSnap.docs.forEach(statDoc => {
    if (statDoc.id === seasonId) {  // Client-side filter
        const playerId = statDoc.ref.parent.parent.id;
        statsMap.set(playerId, statDoc.data());
    }
});
```

**After:**
```javascript
const statsQuery = query(
    collectionGroup(db, collectionNames.seasonalStats),
    where('seasonId', '==', seasonId)  // Server-side filter
);
const statsSnap = await getDocs(statsQuery);

const statsMap = new Map();
statsSnap.docs.forEach(statDoc => {
    // No filtering needed - all results match!
    const playerId = statDoc.ref.parent.parent.id;
    statsMap.set(playerId, statDoc.data());
});
```

## Files That Need Query Updates

After migration, update these files to use \`where('seasonId', '==', ...)\`:

1. \`/js/teams.js\` (line 95-119)
2. \`/js/standings.js\` (line 42-56)
3. \`/js/leaderboards.js\` (line 197-211)
4. \`/js/RKL-S9.js\` (line 74-93)
5. \`/js/player.js\` (line 97-108)
6. \`/js/postseason-player.js\` (line 68-78)
7. \`/js/draft-capital.js\` (line 84-92)

## Testing After Migration

After updating queries, thoroughly test:

1. **Teams page** - Verify correct seasonal records display
2. **Standings** - Check that current season standings are accurate
3. **Leaderboards** - Ensure player stats match expected values
4. **Player pages** - Confirm seasonal stats show correctly
5. **Homepage (RKL-S9.js)** - Verify recent games and standings
6. **Draft capital** - Check team names display properly

## Monitoring Firestore Usage

Compare Firestore reads before and after:

1. Go to Firebase Console > Firestore > Usage
2. Compare daily read counts
3. Expected reduction: **40-50% fewer reads**

### Example Savings

**Before migration:**
- Teams page: 270 reads (all seasonal records)
- Leaderboards: 450 reads (all seasonal stats)
- **Total: 720 reads per page load**

**After migration:**
- Teams page: 30 reads (only S9 seasonal records)
- Leaderboards: 50 reads (only S9 seasonal stats)
- **Total: 80 reads per page load**

**Savings: 88% reduction (640 fewer reads per page load)**

## Rollback Plan

If you need to rollback:

1. The migration only **adds** a field, it doesn't remove anything
2. Simply revert your query code to use client-side filtering
3. The \`seasonId\` field will remain but won't be used
4. No data loss occurs

## Future Seasons

When creating new seasonal documents (S10, S11, etc.), **always include** the \`seasonId\` field:

```javascript
// When creating new seasonal records
await setDoc(doc(db, 'v2_teams', teamId, 'seasonal_records', 'S10'), {
    seasonId: 'S10',  // ← Always include this!
    team_name: 'Team Name',
    wins: 0,
    losses: 0,
    // ... other fields
});
```

Consider updating your Cloud Functions that create seasonal documents to automatically include this field.

## Troubleshooting

### "Permission denied" error
- Ensure you're logged in as an admin user
- Check that the user document has \`role: 'admin'\`

### Migration times out
- The function has a 9-minute timeout
- If you have many seasons/teams, you may need to increase the timeout
- Alternatively, run the migration separately for each league

### Some documents missing seasonId
- Run the verification function to identify which documents failed
- You can re-run the migration (it skips documents that already have the field)
- Check the error logs in Cloud Functions for specific failures

### Queries still slow after migration
- Verify you updated the query code to use \`where('seasonId', '==', ...)\`
- Check Firebase Console to confirm the queries are using the index
- Make sure you deployed the updated code

## Technical Details

### What the Migration Does

For each document in:
- \`v2_teams/{teamId}/seasonal_records/{seasonId}\`
- \`v2_players/{playerId}/seasonal_stats/{seasonId}\`

The migration adds:
```javascript
{
    seasonId: documentId,  // e.g., 'S9', 'S8', etc.
    // ... existing fields remain unchanged
}
```

### Firestore Indexes

Firestore automatically creates single-field indexes, so no manual index creation is needed for \`seasonId\`.

If you want to combine \`seasonId\` with other filters, you may need composite indexes:

```javascript
// Example: Filter by season AND team
query(
    collectionGroup(db, 'seasonal_records'),
    where('seasonId', '==', 'S9'),
    where('team_name', '==', 'Lakers')
)
// Firestore will prompt you to create a composite index
```

### Performance Characteristics

- **Migration time:** ~2-5 minutes for 500-1000 documents
- **Batching:** Uses 500-document batches (Firestore limit)
- **Memory:** Processes one team/player at a time to avoid memory issues
- **Idempotent:** Safe to run multiple times (skips already-migrated docs)

## Summary

1. ✅ Deploy migration functions
2. ✅ Access migration admin page
3. ✅ Verify current status
4. ✅ Run dry run
5. ✅ Execute migration
6. ✅ Verify success
7. ✅ Update query code
8. ✅ Deploy updated code
9. ✅ Test thoroughly
10. ✅ Monitor Firestore usage

Expected result: **40-50% reduction in Firestore reads** with no change in functionality.
