// /scripts/rollback-minor-players.js
// Script to rollback/delete players created by seed-minor-players.js
// Usage: node scripts/rollback-minor-players.js <rollback-file.json>

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

// Initialize the Firebase Admin SDK
admin.initializeApp({
    projectId: "real-karma-league",
});

const db = admin.firestore();

const BATCH_SIZE = 500; // Firestore batch limit

/**
 * Load rollback data from file
 */
function loadRollbackData(filename) {
    let filepath;

    // Check if filename includes path or is just the filename
    if (path.isAbsolute(filename) || filename.includes(path.sep)) {
        filepath = filename;
    } else {
        // Look in the rollback directory
        filepath = path.join(__dirname, 'rollback', filename);
    }

    if (!fs.existsSync(filepath)) {
        throw new Error(`Rollback file not found: ${filepath}`);
    }

    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    return data;
}

/**
 * Delete players and their subcollections
 */
async function deletePlayersWithSubcollections(collectionName, players) {
    console.log(`\nDeleting ${players.length} players from ${collectionName}...`);

    let totalDeleted = 0;

    // Process in batches
    for (let i = 0; i < players.length; i += BATCH_SIZE) {
        const batch = db.batch();
        const batchPlayers = players.slice(i, i + BATCH_SIZE);

        for (const player of batchPlayers) {
            const playerId = player.player_id;
            const playerRef = db.collection(collectionName).doc(playerId);

            // Delete the minor_seasonal_stats subcollection documents first
            const seasonalStatsRef = playerRef.collection('minor_seasonal_stats');
            const statsSnapshot = await seasonalStatsRef.get();

            statsSnapshot.forEach(doc => {
                batch.delete(doc.ref);
            });

            // Delete the player document
            batch.delete(playerRef);
            totalDeleted++;
        }

        await batch.commit();
        console.log(`✓ Deleted ${totalDeleted} of ${players.length} players`);
    }

    return totalDeleted;
}

/**
 * Main execution function
 */
async function main() {
    // Get rollback file from command line arguments
    const rollbackFile = process.argv[2];

    if (!rollbackFile) {
        console.error("Usage: node scripts/rollback-minor-players.js <rollback-file.json>");
        console.error("\nExample:");
        console.error("  node scripts/rollback-minor-players.js minor-players-S9-1234567890.json");
        console.error("  node scripts/rollback-minor-players.js scripts/rollback/minor-players-S9-1234567890.json");
        process.exit(1);
    }

    console.log("=".repeat(60));
    console.log("ROLLBACK MINOR LEAGUE PLAYERS");
    console.log("=".repeat(60));

    try {
        // Load rollback data
        const rollbackData = loadRollbackData(rollbackFile);

        console.log(`Rollback file: ${rollbackFile}`);
        console.log(`Timestamp: ${rollbackData.timestamp}`);
        console.log(`Collection: ${rollbackData.collectionName}`);
        console.log(`Season: ${rollbackData.seasonId}`);
        console.log(`Players to delete: ${rollbackData.createdPlayers.length}`);
        console.log("=".repeat(60));

        // Confirm before proceeding
        console.log("\n⚠️  WARNING: This will DELETE player documents from Firestore.");
        console.log("This action cannot be undone!");
        console.log("Press Ctrl+C to cancel, or wait 5 seconds to continue...\n");
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Delete players
        const deleted = await deletePlayersWithSubcollections(
            rollbackData.collectionName,
            rollbackData.createdPlayers
        );

        console.log("\n" + "=".repeat(60));
        console.log("✓ ROLLBACK COMPLETE");
        console.log("=".repeat(60));
        console.log(`Total players deleted: ${deleted}`);
        console.log("=".repeat(60));

        // Optionally archive the rollback file
        const archiveDir = path.join(path.dirname(rollbackFile), 'archived');
        if (!fs.existsSync(archiveDir)) {
            fs.mkdirSync(archiveDir, { recursive: true });
        }

        const archivePath = path.join(archiveDir, path.basename(rollbackFile));
        fs.copyFileSync(rollbackFile, archivePath);
        console.log(`\n✓ Rollback file archived to: ${archivePath}`);

    } catch (error) {
        console.error("\n❌ Error during rollback:", error);
        console.error(error.stack);
        process.exit(1);
    }
}

// Run the script
main().then(() => {
    console.log("\n✓ Rollback completed successfully");
    process.exit(0);
}).catch((error) => {
    console.error("\n❌ Rollback failed:", error);
    process.exit(1);
});
