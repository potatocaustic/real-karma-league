const admin = require('firebase-admin');

// ==========================================================================================
// --- CONFIGURATION ---
// ==========================================================================================

// **ACTION REQUIRED**:
// 1. Download your service account key from Firebase Project Settings > Service accounts.
// 2. Save it in the same directory as this script.
// 3. Rename the file to 'serviceAccountKey.json' or update the path below.
const serviceAccount = require('./serviceAccountKey.json');

// Set to true to run against your _dev collections, false for production.
const USE_DEV_COLLECTIONS = false;

// Which league to backfill: 'major' or 'minor'
const LEAGUE = 'major';

// ==========================================================================================

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const getCollectionName = (baseName, league = LEAGUE) => {
    const suffix = USE_DEV_COLLECTIONS ? '_dev' : '';

    // Collections that are league-specific
    const leagueSpecificCollections = [
        'game_flow_snapshots',
        'live_games',
        'live_scoring_status',
        'daily_leaderboards',
        'usage_stats'
    ];

    if (leagueSpecificCollections.includes(baseName)) {
        return league === 'minor' ? `${baseName}_minor${suffix}` : `${baseName}${suffix}`;
    }

    return `${baseName}${suffix}`;
};

/**
 * Recalculates differential, lead changes, and biggest leads for all snapshots in a game
 * @param {Array} snapshots - Array of snapshot objects
 * @returns {Array} - Updated snapshots with calculated stats
 */
function recalculateSnapshots(snapshots) {
    if (!snapshots || snapshots.length === 0) {
        return snapshots;
    }

    // Sort snapshots by timestamp to ensure proper order
    snapshots.sort((a, b) => {
        const aTime = a.timestamp?.toMillis ? a.timestamp.toMillis() : 0;
        const bTime = b.timestamp?.toMillis ? b.timestamp.toMillis() : 0;
        return aTime - bTime;
    });

    let leadChanges = 0;
    let team1BiggestLead = 0;
    let team2BiggestLead = 0;
    let prevDifferential = null;

    const updatedSnapshots = snapshots.map((snapshot, index) => {
        // Calculate differential
        const differential = snapshot.team1_score - snapshot.team2_score;

        // Check for lead change
        if (prevDifferential !== null) {
            if ((prevDifferential > 0 && differential < 0) ||
                (prevDifferential < 0 && differential > 0) ||
                (prevDifferential === 0 && differential !== 0)) {
                leadChanges++;
            }
        }

        // Update biggest leads
        if (differential > team1BiggestLead) {
            team1BiggestLead = differential;
        }
        if (differential < 0 && Math.abs(differential) > team2BiggestLead) {
            team2BiggestLead = Math.abs(differential);
        }

        prevDifferential = differential;

        // Return updated snapshot with calculated fields
        return {
            ...snapshot,
            differential: differential,
            lead_changes: leadChanges,
            team1_biggest_lead: team1BiggestLead,
            team2_biggest_lead: team2BiggestLead
        };
    });

    return updatedSnapshots;
}

async function backfillGameFlowStats() {
    console.log('\n========================================');
    console.log('Game Flow Stats Backfill Script');
    console.log('========================================');
    console.log(`League: ${LEAGUE.toUpperCase()}`);
    console.log(`Environment: ${USE_DEV_COLLECTIONS ? 'DEVELOPMENT' : 'PRODUCTION'}`);
    console.log('========================================\n');

    const collectionName = getCollectionName('game_flow_snapshots');
    console.log(`Reading from collection: ${collectionName}\n`);

    const gameFlowRef = db.collection(collectionName);
    const snapshot = await gameFlowRef.get();

    if (snapshot.empty) {
        console.log('No game flow snapshots found. Exiting.');
        return;
    }

    console.log(`Found ${snapshot.size} games with flow data.\n`);

    let updatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    let batch = db.batch();
    let batchSize = 0;

    for (const doc of snapshot.docs) {
        const data = doc.data();
        const gameId = doc.id;

        if (!data.snapshots || data.snapshots.length === 0) {
            console.log(`[${gameId}] Skipping - no snapshots`);
            skippedCount++;
            continue;
        }

        try {
            console.log(`[${gameId}] Processing ${data.snapshots.length} snapshots...`);

            // Recalculate all stats
            const updatedSnapshots = recalculateSnapshots(data.snapshots);

            // Get final stats from last snapshot
            const finalSnapshot = updatedSnapshots[updatedSnapshots.length - 1];
            console.log(`  Lead changes: ${finalSnapshot.lead_changes}`);
            console.log(`  Team 1 biggest lead: ${finalSnapshot.team1_biggest_lead}`);
            console.log(`  Team 2 biggest lead: ${finalSnapshot.team2_biggest_lead}`);

            // Add update to batch
            batch.update(doc.ref, { snapshots: updatedSnapshots });
            updatedCount++;
            batchSize++;

            // Commit batch periodically to avoid exceeding limits
            if (batchSize >= 100) {
                console.log(`\nCommitting batch of ${batchSize} updates...`);
                await batch.commit();
                batch = db.batch();
                batchSize = 0;
                console.log('Batch committed successfully.\n');
            }
        } catch (error) {
            console.error(`[${gameId}] Error processing game:`, error.message);
            errorCount++;
        }
    }

    // Commit any remaining updates
    if (batchSize > 0) {
        console.log(`\nCommitting final batch of ${batchSize} updates...`);
        await batch.commit();
        console.log('Final batch committed successfully.\n');
    }

    console.log('\n========================================');
    console.log('Backfill Complete');
    console.log('========================================');
    console.log(`Games updated: ${updatedCount}`);
    console.log(`Games skipped: ${skippedCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log('========================================\n');
}

backfillGameFlowStats().catch((error) => {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
});
