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

// The season number to backfill, e.g., '8' for S8.
const SEASON_TO_BACKFILL = '8'; 

// ==========================================================================================

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const getCollectionName = (baseName) => {
    // This helper should match the one in your cloud functions
    if (baseName.includes('_draft_results') || baseName.includes('v2_players')) {
         return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
    }
    return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
};

async function backfillPlayerIds() {
    console.log(`\nStarting backfill for S${SEASON_TO_BACKFILL} draft results...`);
    console.log(`Using ${USE_DEV_COLLECTIONS ? 'DEVELOPMENT' : 'PRODUCTION'} collections.`);

    const draftResultsPath = `${getCollectionName('draft_results')}/season_${SEASON_TO_BACKFILL}/${getCollectionName(`S${SEASON_TO_BACKFILL}_draft_results`)}`;
    const playersCollection = getCollectionName('v2_players');

    const draftResultsRef = db.collection(draftResultsPath);
    const snapshot = await draftResultsRef.get();

    if (snapshot.empty) {
        console.log('No draft results found for this season. Exiting.');
        return;
    }

    let updatedCount = 0;
    let notFoundCount = 0;
    let batch = db.batch();
    let batchSize = 0;

    console.log(`Found ${snapshot.size} total draft picks. Checking for missing player_ids...`);

    for (const doc of snapshot.docs) {
        const data = doc.data();

        // Skip if player_id already exists, if it's a forfeit, or has no handle
        if (data.player_id || data.forfeit || !data.player_handle) {
            continue;
        }

        console.log(`Processing pick #${data.overall}: ${data.player_handle}`);

        const playerQuery = db.collection(playersCollection).where('player_handle', '==', data.player_handle).limit(1);
        const playerSnapshot = await playerQuery.get();

        if (!playerSnapshot.empty) {
            const playerDoc = playerSnapshot.docs[0];
            const playerId = playerDoc.id;
            console.log(`  -> Found player_id: ${playerId}. Adding to batch.`);
            batch.update(doc.ref, { player_id: playerId });
            updatedCount++;
            batchSize++;
        } else {
            console.log(`  -> WARNING: Player not found for handle "${data.player_handle}".`);
            notFoundCount++;
        }

        // Commit batch periodically to avoid exceeding limits (Firestore allows 500 ops/batch)
        if (batchSize >= 400) {
            console.log('Committing batch of 400 updates...');
            await batch.commit();
            batch = db.batch(); // Re-initialize batch
            batchSize = 0;
        }
    }

    // Commit any remaining updates in the last batch
    if (batchSize > 0) {
        console.log(`Committing final batch of ${batchSize} updates...`);
        await batch.commit();
    }

    console.log('\n--- Backfill Complete ---');
    console.log(`Total picks updated: ${updatedCount}`);
    console.log(`Players not found: ${notFoundCount}`);
    console.log('-------------------------\n');
}

backfillPlayerIds().catch(console.error);
