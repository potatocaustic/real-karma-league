// /scripts/cleanup-dev-data.js

const admin = require("firebase-admin");

// Initialize the Firebase Admin SDK.
// Ensure your GOOGLE_APPLICATION_CREDENTIALS environment variable is set.
admin.initializeApp({
    projectId: "real-karma-league",
});

const db = admin.firestore();

/**
 * Recursively deletes documents and subcollections in batches, updating progress.
 * @param {admin.firestore.Firestore} db The Firestore database instance.
 * @param {string} collectionPath The path of the collection to delete.
 * @param {number} batchSize The number of documents per batch.
 * @param {object} progress An object to track deleted count vs. total.
 * @param {string} progressLineHeader The header text for the progress line.
 */
async function deleteCollectionRecursive(db, collectionPath, batchSize, progress, progressLineHeader) {
    const collectionRef = db.collection(collectionPath);
    const query = collectionRef.orderBy('__name__').limit(batchSize);

    const snapshot = await query.get();

    // When there are no documents left, the recursion stops.
    if (snapshot.empty) {
        return;
    }

    const batch = db.batch();
    for (const doc of snapshot.docs) {
        // Recursively delete subcollections first.
        const subcollections = await doc.ref.listCollections();
        for (const subcollection of subcollections) {
            // Note: Progress for subcollections is part of the parent's total.
            // This avoids overly complex and nested progress bars.
            await deleteCollectionRecursive(db, `${doc.ref.path}/${subcollection.id}`, batchSize, null, null);
        }
        batch.delete(doc.ref);
    }
    await batch.commit();

    // Update and display progress only for top-level collections.
    if (progress) {
        progress.deleted += snapshot.size;
        const percentage = progress.total === 0 ? 100 : Math.round((progress.deleted / progress.total) * 100);
        // Use carriage return '\r' to overwrite the line, creating a dynamic progress bar.
        process.stdout.write(`\r${progressLineHeader}${percentage}%`);
    }

    // Recurse on the same collection to process the next batch.
    await deleteCollectionRecursive(db, collectionPath, batchSize, progress, progressLineHeader);
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

    const totalToDelete = collectionsToDelete.length;
    for (let i = 0; i < totalToDelete; i++) {
        const collectionId = collectionsToDelete[i];
        try {
            const collectionRef = db.collection(collectionId);
            const countSnapshot = await collectionRef.count().get();
            const totalDocs = countSnapshot.data().count;
            const progressLineHeader = `[${i + 1}/${totalToDelete}] Deleting '${collectionId}'... `;

            if (totalDocs === 0) {
                console.log(`${progressLineHeader}100% (empty)`);
                console.log(`✅ Successfully deleted collection: '${collectionId}'`);
                continue;
            }
            
            const progress = { deleted: 0, total: totalDocs };
            
            // Initial print for the progress bar
            process.stdout.write(`${progressLineHeader}0%`);

            await deleteCollectionRecursive(db, collectionId, 500, progress, progressLineHeader);
            
            // Clear the progress line and print the final success message
            process.stdout.write(`\r${' '.repeat(progressLineHeader.length + 5)}\r`); // Clear the line
            console.log(`${progressLineHeader}100%`);
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
