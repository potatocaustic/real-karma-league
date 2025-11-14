// functions/admin/migrate-add-season-ids.js
// One-time migration script to add seasonId fields to seasonal_records and seasonal_stats
// This enables server-side filtering in collection group queries

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require('../utils/firebase-admin');
const { getCollectionName } = require('../utils/firebase-helpers');

/**
 * Migration script to add seasonId field to all seasonal documents
 *
 * This function:
 * 1. Scans all teams and their seasonal_records subcollections
 * 2. Scans all players and their seasonal_stats subcollections
 * 3. Adds a 'seasonId' field to each document (value = document ID)
 * 4. Uses batched writes for efficiency
 *
 * Usage: Call this function once from an admin interface or Firebase console
 */
exports.admin_migrateAddSeasonIds = onCall({
    region: "us-central1",
    timeoutSeconds: 540, // 9 minutes - this may take a while
    memory: "1GiB"
}, async (request) => {
    // Security Check - Admin only
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this migration.');
    }

    const { dryRun = true, league = 'major' } = request.data;

    console.log(`Starting migration (dryRun: ${dryRun}, league: ${league})...`);

    const results = {
        teamsProcessed: 0,
        playersProcessed: 0,
        seasonalRecordsUpdated: 0,
        seasonalStatsUpdated: 0,
        errors: [],
        dryRun: dryRun
    };

    try {
        // Get collection names based on league
        const teamsCollection = league === 'major' ? 'v2_teams' : `${league}_v2_teams`;
        const playersCollection = league === 'major' ? 'v2_players' : `${league}_v2_players`;
        const seasonalRecordsSubcollection = league === 'major' ? 'seasonal_records' : `${league}_seasonal_records`;
        const seasonalStatsSubcollection = league === 'major' ? 'seasonal_stats' : `${league}_seasonal_stats`;

        // ==========================================
        // PART 1: Migrate seasonal_records (teams)
        // ==========================================
        console.log('Starting seasonal_records migration...');
        const teamsSnapshot = await db.collection(teamsCollection).get();

        let batch = db.batch();
        let batchCount = 0;
        const BATCH_SIZE = 500; // Firestore limit

        for (const teamDoc of teamsSnapshot.docs) {
            results.teamsProcessed++;

            // Get all seasonal_records for this team
            const seasonalRecordsSnapshot = await teamDoc.ref
                .collection(seasonalRecordsSubcollection)
                .get();

            for (const recordDoc of seasonalRecordsSnapshot.docs) {
                const seasonId = recordDoc.id; // e.g., 'S9', 'S8', etc.
                const data = recordDoc.data();

                // Check if seasonId field already exists
                if (data.seasonId) {
                    console.log(`Team ${teamDoc.id} record ${seasonId} already has seasonId field`);
                    continue;
                }

                if (!dryRun) {
                    // Add seasonId field to document
                    batch.update(recordDoc.ref, { seasonId: seasonId });
                    batchCount++;

                    // Commit batch if we hit the limit
                    if (batchCount >= BATCH_SIZE) {
                        await batch.commit();
                        console.log(`Committed batch of ${batchCount} seasonal_records updates`);
                        batch = db.batch();
                        batchCount = 0;
                    }
                }

                results.seasonalRecordsUpdated++;
                console.log(`${dryRun ? '[DRY RUN] Would update' : 'Updated'} team ${teamDoc.id} record ${seasonId}`);
            }
        }

        // Commit any remaining writes
        if (!dryRun && batchCount > 0) {
            await batch.commit();
            console.log(`Committed final batch of ${batchCount} seasonal_records updates`);
        }

        // ==========================================
        // PART 2: Migrate seasonal_stats (players)
        // ==========================================
        console.log('Starting seasonal_stats migration...');
        const playersSnapshot = await db.collection(playersCollection).get();

        batch = db.batch();
        batchCount = 0;

        for (const playerDoc of playersSnapshot.docs) {
            results.playersProcessed++;

            // Get all seasonal_stats for this player
            const seasonalStatsSnapshot = await playerDoc.ref
                .collection(seasonalStatsSubcollection)
                .get();

            for (const statDoc of seasonalStatsSnapshot.docs) {
                const seasonId = statDoc.id; // e.g., 'S9', 'S8', etc.
                const data = statDoc.data();

                // Check if seasonId field already exists
                if (data.seasonId) {
                    console.log(`Player ${playerDoc.id} stats ${seasonId} already has seasonId field`);
                    continue;
                }

                if (!dryRun) {
                    // Add seasonId field to document
                    batch.update(statDoc.ref, { seasonId: seasonId });
                    batchCount++;

                    // Commit batch if we hit the limit
                    if (batchCount >= BATCH_SIZE) {
                        await batch.commit();
                        console.log(`Committed batch of ${batchCount} seasonal_stats updates`);
                        batch = db.batch();
                        batchCount = 0;
                    }
                }

                results.seasonalStatsUpdated++;
                console.log(`${dryRun ? '[DRY RUN] Would update' : 'Updated'} player ${playerDoc.id} stats ${seasonId}`);
            }
        }

        // Commit any remaining writes
        if (!dryRun && batchCount > 0) {
            await batch.commit();
            console.log(`Committed final batch of ${batchCount} seasonal_stats updates`);
        }

        console.log('Migration complete!', results);
        return results;

    } catch (error) {
        console.error('Migration error:', error);
        results.errors.push(error.message);
        throw new HttpsError('internal', `Migration failed: ${error.message}`, results);
    }
});

/**
 * Verification function to check migration status
 * Returns counts of documents with/without seasonId field
 */
exports.admin_verifySeasonIdMigration = onCall({
    region: "us-central1",
    timeoutSeconds: 300
}, async (request) => {
    // Security Check - Admin only
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to verify migration.');
    }

    const { league = 'major' } = request.data;

    const teamsCollection = league === 'major' ? 'v2_teams' : `${league}_v2_teams`;
    const playersCollection = league === 'major' ? 'v2_players' : `${league}_v2_players`;
    const seasonalRecordsSubcollection = league === 'major' ? 'seasonal_records' : `${league}_seasonal_records`;
    const seasonalStatsSubcollection = league === 'major' ? 'seasonal_stats' : `${league}_seasonal_stats`;

    const stats = {
        seasonalRecords: {
            total: 0,
            withSeasonId: 0,
            withoutSeasonId: 0,
            samples: []
        },
        seasonalStats: {
            total: 0,
            withSeasonId: 0,
            withoutSeasonId: 0,
            samples: []
        }
    };

    // Check seasonal_records
    const teamsSnapshot = await db.collection(teamsCollection).limit(10).get();
    for (const teamDoc of teamsSnapshot.docs) {
        const recordsSnapshot = await teamDoc.ref.collection(seasonalRecordsSubcollection).get();
        for (const recordDoc of recordsSnapshot.docs) {
            stats.seasonalRecords.total++;
            const data = recordDoc.data();
            if (data.seasonId) {
                stats.seasonalRecords.withSeasonId++;
            } else {
                stats.seasonalRecords.withoutSeasonId++;
                if (stats.seasonalRecords.samples.length < 5) {
                    stats.seasonalRecords.samples.push({
                        teamId: teamDoc.id,
                        docId: recordDoc.id,
                        path: recordDoc.ref.path
                    });
                }
            }
        }
    }

    // Check seasonal_stats
    const playersSnapshot = await db.collection(playersCollection).limit(10).get();
    for (const playerDoc of playersSnapshot.docs) {
        const statsSnapshot = await playerDoc.ref.collection(seasonalStatsSubcollection).get();
        for (const statDoc of statsSnapshot.docs) {
            stats.seasonalStats.total++;
            const data = statDoc.data();
            if (data.seasonId) {
                stats.seasonalStats.withSeasonId++;
            } else {
                stats.seasonalStats.withoutSeasonId++;
                if (stats.seasonalStats.samples.length < 5) {
                    stats.seasonalStats.samples.push({
                        playerId: playerDoc.id,
                        docId: statDoc.id,
                        path: statDoc.ref.path
                    });
                }
            }
        }
    }

    stats.migrationComplete =
        stats.seasonalRecords.withoutSeasonId === 0 &&
        stats.seasonalStats.withoutSeasonId === 0 &&
        stats.seasonalRecords.total > 0 &&
        stats.seasonalStats.total > 0;

    return stats;
});
