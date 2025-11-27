// /scripts/migrate-minor-seasonal-stats.js
// Script to migrate seasonal_stats to minor_seasonal_stats for minor league players
// This ensures consistent naming convention: minor_v2_players/{playerId}/minor_seasonal_stats/{recordId}
//
// Usage:
//   Dry run (preview only): node scripts/migrate-minor-seasonal-stats.js --dry-run
//   Actual migration:       node scripts/migrate-minor-seasonal-stats.js --execute

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

// Initialize the Firebase Admin SDK
admin.initializeApp({
    projectId: "real-karma-league",
});

const db = admin.firestore();

// Configuration
const PLAYER_COLLECTION = "minor_v2_players";
const OLD_SUBCOLLECTION_STATS = "seasonal_stats";
const NEW_SUBCOLLECTION_STATS = "minor_seasonal_stats";
const OLD_SUBCOLLECTION_RECORDS = "seasonal_records";
const NEW_SUBCOLLECTION_RECORDS = "minor_seasonal_records";
const BATCH_SIZE = 500;

// Track migration results
const migrationLog = {
    timestamp: new Date().toISOString(),
    dryRun: true,
    playersProcessed: 0,
    playersWithOldStats: 0,
    playersWithOldRecords: 0,
    statsMigrated: 0,
    recordsMigrated: 0,
    errors: []
};

/**
 * Copy a subcollection from old name to new name
 */
async function migrateSubcollection(playerRef, playerId, oldName, newName, dryRun) {
    const oldSubcollectionRef = playerRef.collection(oldName);
    const newSubcollectionRef = playerRef.collection(newName);

    // Get all documents from old subcollection
    const oldSnapshot = await oldSubcollectionRef.get();

    if (oldSnapshot.empty) {
        return 0; // No documents to migrate
    }

    console.log(`  → Found ${oldSnapshot.size} document(s) in ${oldName}`);

    if (dryRun) {
        console.log(`  → [DRY RUN] Would copy ${oldSnapshot.size} document(s) to ${newName}`);
        return oldSnapshot.size;
    }

    let batch = db.batch();
    let operationCount = 0;
    let migratedCount = 0;

    for (const doc of oldSnapshot.docs) {
        // Copy to new subcollection
        const newDocRef = newSubcollectionRef.doc(doc.id);
        batch.set(newDocRef, doc.data());
        operationCount++;
        migratedCount++;

        // Commit batch if we hit the limit
        if (operationCount >= BATCH_SIZE) {
            await batch.commit();
            batch = db.batch();
            operationCount = 0;
        }
    }

    // Commit remaining operations
    if (operationCount > 0) {
        await batch.commit();
    }

    console.log(`  ✓ Copied ${migratedCount} document(s) to ${newName}`);

    // Now delete old subcollection
    batch = db.batch();
    operationCount = 0;

    for (const doc of oldSnapshot.docs) {
        batch.delete(doc.ref);
        operationCount++;

        if (operationCount >= BATCH_SIZE) {
            await batch.commit();
            batch = db.batch();
            operationCount = 0;
        }
    }

    if (operationCount > 0) {
        await batch.commit();
    }

    console.log(`  ✓ Deleted ${oldSnapshot.size} document(s) from ${oldName}`);

    return migratedCount;
}

/**
 * Process a single player
 */
async function processPlayer(playerRef, playerId, dryRun) {
    migrationLog.playersProcessed++;

    console.log(`\nProcessing player: ${playerId}`);

    let hasChanges = false;

    // Check if old seasonal_stats subcollection exists
    const oldStatsSnapshot = await playerRef.collection(OLD_SUBCOLLECTION_STATS).limit(1).get();
    if (!oldStatsSnapshot.empty) {
        migrationLog.playersWithOldStats++;
        hasChanges = true;
        const count = await migrateSubcollection(
            playerRef,
            playerId,
            OLD_SUBCOLLECTION_STATS,
            NEW_SUBCOLLECTION_STATS,
            dryRun
        );
        if (!dryRun) {
            migrationLog.statsMigrated += count;
        }
    }

    // Check if old seasonal_records subcollection exists
    const oldRecordsSnapshot = await playerRef.collection(OLD_SUBCOLLECTION_RECORDS).limit(1).get();
    if (!oldRecordsSnapshot.empty) {
        migrationLog.playersWithOldRecords++;
        hasChanges = true;
        const count = await migrateSubcollection(
            playerRef,
            playerId,
            OLD_SUBCOLLECTION_RECORDS,
            NEW_SUBCOLLECTION_RECORDS,
            dryRun
        );
        if (!dryRun) {
            migrationLog.recordsMigrated += count;
        }
    }

    if (!hasChanges) {
        console.log(`  → No migration needed (already using correct naming)`);
    }
}

/**
 * Main migration function
 */
async function migrateSeasonalStats(dryRun = true) {
    console.log("=".repeat(70));
    console.log("MIGRATE MINOR LEAGUE PLAYER SEASONAL STATS");
    console.log("=".repeat(70));
    console.log(`Collection: ${PLAYER_COLLECTION}`);
    console.log(`Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'EXECUTE (will modify database)'}`);
    console.log("=".repeat(70));

    migrationLog.dryRun = dryRun;

    try {
        // Get all players in the minor_v2_players collection
        console.log(`\nFetching all players from ${PLAYER_COLLECTION}...`);
        const playersSnapshot = await db.collection(PLAYER_COLLECTION).get();
        console.log(`✓ Found ${playersSnapshot.size} player(s)\n`);

        // Process each player
        for (const playerDoc of playersSnapshot.docs) {
            try {
                await processPlayer(playerDoc.ref, playerDoc.id, dryRun);
            } catch (error) {
                const errorMsg = `Error processing player ${playerDoc.id}: ${error.message}`;
                console.error(`  ❌ ${errorMsg}`);
                migrationLog.errors.push(errorMsg);
            }
        }

        // Print summary
        console.log("\n" + "=".repeat(70));
        console.log("MIGRATION SUMMARY");
        console.log("=".repeat(70));
        console.log(`Mode: ${dryRun ? 'DRY RUN' : 'EXECUTED'}`);
        console.log(`Total players processed: ${migrationLog.playersProcessed}`);
        console.log(`Players with old seasonal_stats: ${migrationLog.playersWithOldStats}`);
        console.log(`Players with old seasonal_records: ${migrationLog.playersWithOldRecords}`);

        if (!dryRun) {
            console.log(`Total seasonal_stats documents migrated: ${migrationLog.statsMigrated}`);
            console.log(`Total seasonal_records documents migrated: ${migrationLog.recordsMigrated}`);
        }

        if (migrationLog.errors.length > 0) {
            console.log(`\n⚠️  Errors encountered: ${migrationLog.errors.length}`);
            migrationLog.errors.forEach(err => console.log(`   - ${err}`));
        }
        console.log("=".repeat(70));

        if (dryRun) {
            console.log("\n💡 This was a DRY RUN. No changes were made to the database.");
            console.log("   To execute the migration, run:");
            console.log("   node scripts/migrate-minor-seasonal-stats.js --execute\n");
        } else {
            console.log("\n✓ Migration completed successfully!");

            // Save migration log
            const logDir = path.join(__dirname, 'migration-logs');
            if (!fs.existsSync(logDir)) {
                fs.mkdirSync(logDir, { recursive: true });
            }

            const logFile = path.join(logDir, `migration-${Date.now()}.json`);
            fs.writeFileSync(logFile, JSON.stringify(migrationLog, null, 2));
            console.log(`\n✓ Migration log saved to: ${logFile}\n`);
        }

    } catch (error) {
        console.error("\n❌ Migration failed:", error);
        console.error(error.stack);
        throw error;
    }
}

/**
 * Main execution
 */
async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        console.log("Usage:");
        console.log("  node scripts/migrate-minor-seasonal-stats.js --dry-run    # Preview changes");
        console.log("  node scripts/migrate-minor-seasonal-stats.js --execute    # Execute migration");
        console.log("\nThis script migrates:");
        console.log("  - seasonal_stats → minor_seasonal_stats");
        console.log("  - seasonal_records → minor_seasonal_records");
        console.log("\nFor all players in the minor_v2_players collection.");
        process.exit(0);
    }

    const isDryRun = args.includes('--dry-run');
    const isExecute = args.includes('--execute');

    if (!isDryRun && !isExecute) {
        console.error("❌ Error: You must specify either --dry-run or --execute");
        console.error("Run with --help for usage information");
        process.exit(1);
    }

    if (isDryRun && isExecute) {
        console.error("❌ Error: Cannot specify both --dry-run and --execute");
        process.exit(1);
    }

    if (isExecute) {
        console.log("\n⚠️  WARNING: This will modify your database!");
        console.log("Press Ctrl+C to cancel, or wait 5 seconds to continue...\n");
        await new Promise(resolve => setTimeout(resolve, 5000));
    }

    await migrateSeasonalStats(!isExecute);
}

// Run the script
main()
    .then(() => {
        console.log("Script completed");
        process.exit(0);
    })
    .catch((error) => {
        console.error("Script failed:", error);
        process.exit(1);
    });
