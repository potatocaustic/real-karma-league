// /scripts/cleanup-dev-data.js

const admin = require("firebase-admin");

// Initialize the Firebase Admin SDK.
// Ensure your GOOGLE_APPLICATION_CREDENTIALS environment variable is set.
admin.initializeApp({
    projectId: "real-karma-league",
});

const db = admin.firestore();

/**
 * Deletes a collection by recursively deleting its documents and subcollections.
 * @param {admin.firestore.Firestore} db The Firestore database instance.
 * @param {string} collectionPath The path to the collection to delete.
 * @param {number} batchSize The number of documents to delete in each batch.
 */
async function deleteCollection(db, collectionPath, batchSize) {
    const collectionRef = db.collection(collectionPath);
    const query = collectionRef.orderBy('__name__').limit(batchSize);

    return new Promise((resolve, reject) => {
        deleteQueryBatch(db, query, resolve).catch(reject);
    });
}

/**
 * Helper function to delete a batch of documents and recursively call itself.
 * @param {admin.firestore.Firestore} db The Firestore database instance.
 * @param {admin.firestore.Query} query The query for the batch of documents to delete.
 * @param {Function} resolve The promise resolve function.
 */
async function deleteQueryBatch(db, query, resolve) {
    const snapshot = await query.get();

    if (snapshot.size === 0) {
        // When there are no documents left, we are done
        resolve();
        return;
    }

    // Delete documents in a batch
    const batch = db.batch();
    for (const doc of snapshot.docs) {
        // It's important to recursively delete subcollections *before* deleting the document
        const subcollections = await doc.ref.listCollections();
        for (const subcollection of subcollections) {
            await deleteCollection(db, `${doc.ref.path}/${subcollection.id}`, 500);
        }
        batch.delete(doc.ref);
    }
    await batch.commit();

    // MODIFIED: Add a dot to show progress for each deleted batch.
    process.stdout.write('.');

    // Recurse on the next process tick, to avoid hitting stack limits for large collections
    process.nextTick(() => {
        deleteQueryBatch(db, query, resolve);
    });
}


/**
 * Main function to identify and delete all _dev collections except for a protected list.
 */
async function cleanupDevEnvironment() {
    console.log("Starting development environment cleanup...");

    const collectionsToKeep = [
        'live_scoring_status_dev',
        'usage_stats_dev',
        'users_dev'
    ];

    console.log("Protected collections (will not be deleted):", collectionsToKeep);

    const collections = await db.listCollections();
    const collectionsToDelete = [];

    for (const collection of collections) {
        const collectionId = collection.id;
        if (collectionId.endsWith('_dev') && !collectionsToKeep.includes(collectionId)) {
            collectionsToDelete.push(collectionId);
        }
    }

    if (collectionsToDelete.length === 0) {
        console.log("No development collections found to delete.");
        return;
    }

    console.log("---");

    // MODIFIED: Add a loop with a counter for progress tracking.
    const totalToDelete = collectionsToDelete.length;
    for (let i = 0; i < totalToDelete; i++) {
        const collectionId = collectionsToDelete[i];
        try {
            // Print which collection is being deleted.
            process.stdout.write(`[${i + 1}/${totalToDelete}] Deleting '${collectionId}'... `);
            await deleteCollection(db, collectionId, 500);
            // Print a new line after all the dots from the batch deletions.
            process.stdout.write('\n');
            console.log(`✅ Successfully deleted collection: '${collectionId}'`);
        } catch (error) {
            process.stdout.write('\n'); // Ensure error message is on a new line
            console.error(`❌ Error deleting collection '${collectionId}':`, error);
        }
    }

    console.log("---");
    console.log("Development environment cleanup complete.");
}

// --- Run the Cleanup Script ---
cleanupDevEnvironment().catch(console.error);
