#!/usr/bin/env node

/**
 * Migration script to move minor league game flow snapshots from game_flow_snapshots
 * to minor_game_flow_snapshots collection.
 *
 * This script:
 * 1. Finds all minor league game IDs from the minor_seasons collection
 * 2. Identifies snapshot documents in game_flow_snapshots that match those game IDs
 * 3. Copies them to minor_game_flow_snapshots
 * 4. Optionally deletes them from game_flow_snapshots (use --delete flag)
 *
 * Usage:
 *   node scripts/migrate-minor-league-snapshots.js [--delete] [--dry-run]
 *
 * Options:
 *   --delete   Delete snapshots from game_flow_snapshots after copying (default: false)
 *   --dry-run  Show what would be migrated without making changes (default: false)
 */

const { admin, db } = require('../utils/firebase-admin');
const { getCollectionName, LEAGUES } = require('../utils/firebase-helpers');

// Parse command line arguments
const args = process.argv.slice(2);
const shouldDelete = args.includes('--delete');
const dryRun = args.includes('--dry-run');

async function collectMinorLeagueGameIds() {
    console.log('Step 1: Collecting minor league game IDs...');
    const minorGameIds = new Set();

    // Get all minor league seasons
    const minorSeasonsSnap = await db.collection(getCollectionName('seasons', LEAGUES.MINOR)).get();
    console.log(`Found ${minorSeasonsSnap.size} minor league seasons`);

    // For each season, get all game IDs
    for (const seasonDoc of minorSeasonsSnap.docs) {
        const seasonId = seasonDoc.id;
        console.log(`  Checking season: ${seasonId}`);

        // Get games from the games subcollection
        const gamesSnap = await seasonDoc.ref.collection('games').get();
        console.log(`    Found ${gamesSnap.size} games`);

        gamesSnap.docs.forEach(gameDoc => {
            minorGameIds.add(gameDoc.id);
        });

        // Also check post_games subcollection (playoff games)
        const postGamesSnap = await seasonDoc.ref.collection('post_games').get();
        if (postGamesSnap.size > 0) {
            console.log(`    Found ${postGamesSnap.size} playoff games`);
            postGamesSnap.docs.forEach(gameDoc => {
                minorGameIds.add(gameDoc.id);
            });
        }
    }

    // Also check currently live minor league games
    const liveGamesSnap = await db.collection(getCollectionName('live_games', LEAGUES.MINOR)).get();
    if (liveGamesSnap.size > 0) {
        console.log(`Found ${liveGamesSnap.size} currently live minor league games`);
        liveGamesSnap.docs.forEach(gameDoc => {
            minorGameIds.add(gameDoc.id);
        });
    }

    console.log(`Total unique minor league game IDs: ${minorGameIds.size}`);
    return minorGameIds;
}

async function migrateSnapshots(minorGameIds) {
    console.log('\nStep 2: Migrating snapshots...');

    // Get all documents from game_flow_snapshots
    const majorSnapshotsCollection = getCollectionName('game_flow_snapshots', LEAGUES.MAJOR);
    const snapshotsSnap = await db.collection(majorSnapshotsCollection).get();
    console.log(`Found ${snapshotsSnap.size} total snapshot documents in ${majorSnapshotsCollection}`);

    const toMigrate = [];

    // Filter for minor league game IDs
    for (const snapshotDoc of snapshotsSnap.docs) {
        const gameId = snapshotDoc.id;
        if (minorGameIds.has(gameId)) {
            toMigrate.push(snapshotDoc);
        }
    }

    console.log(`Found ${toMigrate.length} snapshot documents to migrate`);

    if (toMigrate.length === 0) {
        console.log('No snapshots to migrate. Exiting.');
        return { migrated: 0, deleted: 0 };
    }

    if (dryRun) {
        console.log('\n=== DRY RUN MODE ===');
        console.log('Would migrate the following game snapshots:');
        toMigrate.forEach(doc => {
            const data = doc.data();
            const snapshotCount = data.snapshots ? data.snapshots.length : 0;
            console.log(`  - Game ID: ${doc.id} (${snapshotCount} snapshots)`);
        });
        console.log(`\nTotal: ${toMigrate.length} documents with snapshots`);
        if (shouldDelete) {
            console.log('Would delete these documents from game_flow_snapshots after copying');
        }
        return { migrated: 0, deleted: 0 };
    }

    console.log('\nMigrating snapshots...');
    const minorSnapshotsCollection = getCollectionName('game_flow_snapshots', LEAGUES.MINOR);

    let migratedCount = 0;
    let deletedCount = 0;

    // Use batched writes (Firestore has a limit of 500 operations per batch)
    const BATCH_SIZE = 500;

    for (let i = 0; i < toMigrate.length; i += BATCH_SIZE) {
        const batch = db.batch();
        const batchDocs = toMigrate.slice(i, i + BATCH_SIZE);

        console.log(`Processing batch ${Math.floor(i / BATCH_SIZE) + 1} (${batchDocs.length} documents)...`);

        for (const snapshotDoc of batchDocs) {
            const gameId = snapshotDoc.id;
            const snapshotData = snapshotDoc.data();

            // Copy to minor league collection
            const minorSnapshotRef = db.collection(minorSnapshotsCollection).doc(gameId);
            batch.set(minorSnapshotRef, snapshotData);
            migratedCount++;

            // Delete from major league collection if requested
            if (shouldDelete) {
                batch.delete(snapshotDoc.ref);
                deletedCount++;
            }
        }

        await batch.commit();
        console.log(`  Batch committed successfully`);
    }

    return { migrated: migratedCount, deleted: deletedCount };
}

async function main() {
    console.log('=== Minor League Snapshot Migration ===\n');
    console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
    console.log(`Delete after migration: ${shouldDelete ? 'YES' : 'NO'}\n`);

    try {
        // Step 1: Collect all minor league game IDs
        const minorGameIds = await collectMinorLeagueGameIds();

        if (minorGameIds.size === 0) {
            console.log('\nNo minor league games found. Nothing to migrate.');
            process.exit(0);
        }

        // Step 2: Migrate snapshots
        const { migrated, deleted } = await migrateSnapshots(minorGameIds);

        console.log('\n=== Migration Complete ===');
        if (!dryRun) {
            console.log(`✓ Migrated ${migrated} snapshot documents to minor_game_flow_snapshots`);
            if (shouldDelete) {
                console.log(`✓ Deleted ${deleted} snapshot documents from game_flow_snapshots`);
            } else {
                console.log(`ℹ Original documents kept in game_flow_snapshots (use --delete to remove)`);
            }
        }

        process.exit(0);
    } catch (error) {
        console.error('\n❌ Migration failed:', error);
        process.exit(1);
    }
}

// Run the migration
main();
