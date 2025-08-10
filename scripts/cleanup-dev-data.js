// /scripts/cleanup-dev-data.js

const admin = require("firebase-admin");

// Initialize the Firebase Admin SDK.
// Ensure your GOOGLE_APPLICATION_CREDENTIALS environment variable is set.
admin.initializeApp({
    projectId: "real-karma-league",
});

const db = admin.firestore();

/**
 * Recursively counts all documents in a collection and its subcollections.
 * @param {string} collectionPath The path of the collection to count.
 * @returns {Promise<number>} The total number of documents.
 */
async function countDocsRecursive(collectionPath) {
    let count = 0;
    const collectionRef = db.collection(collectionPath);
    const snapshot = await collectionRef.get();
    count += snapshot.size;

    for (const doc of snapshot.docs) {
        const subcollections = await doc.ref.listCollections();
        for (const subcollection of subcollections) {
            count += await countDocsRecursive(subcollection.path);
        }
    }
    return count;
}


/**
 * Deletes a collection and all its subcollections, updating a shared progress object.
 * @param {string} collectionPath The path of the collection to delete.
 * @param {object} progress A shared object to track { deleted, total }.
 * @param {string} progressLineHeader The header text for the progress line.
 */
async function deleteCollectionWithProgress(collectionPath, progress, progressLineHeader) {
    const collectionRef = db.collection(collectionPath);
    const query = collectionRef.orderBy('__name__').limit(500);

    while (true) {
        const snapshot = await query.get();
        if (snapshot.empty) {
            break; // No more documents in this collection
        }

        // Recursively delete subcollections of documents in the current batch
        for (const doc of snapshot.docs) {
            const subcollections = await doc.ref.listCollections();
            for (const subcollection of subcollections) {
                await deleteCollectionWithProgress(subcollection.path, progress, progressLineHeader);
            }
        }

        // Delete the documents in the current batch
        const batch = db.batch();
        snapshot.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();

        // Update progress
        progress.deleted += snapshot.size;
        const percentage = Math.min(100, progress.total === 0 ? 100 : Math.round((progress.deleted / progress.total) * 100));
        process.stdout.write(`\r${progressLineHeader}${percentage}%`);
    }
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
            const progressLineHeader = `[${i + 1}/${totalToDelete}] Deleting '${collectionId}'... `;

            // 1. Get total count first
            process.stdout.write(`\r${progressLineHeader}Calculating total documents...`);
            const totalDocs = await countDocsRecursive(collectionId);
            // Clear the "calculating" line
            process.stdout.write(`\r${' '.repeat(progressLineHeader.length + 30)}\r`);

            if (totalDocs === 0) {
                console.log(`${progressLineHeader}100% (empty)`);
                console.log(`✅ Successfully deleted collection: '${collectionId}'`);
                continue;
            }
            
            const progress = { deleted: 0, total: totalDocs };
            
            // Initial print for the progress bar
            process.stdout.write(`${progressLineHeader}0%`);

            // 2. Start deletion
            await deleteCollectionWithProgress(collectionId, progress, progressLineHeader);
            
            // Final print
            process.stdout.write(`\r${progressLineHeader}100%\n`);
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
