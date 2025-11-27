#!/usr/bin/env node

/**
 * Migration Script: Fix Minor League Subcollection Names
 *
 * This script migrates data from incorrectly named subcollections with the 'minor_' prefix
 * to correctly named subcollections without the prefix.
 *
 * BEFORE (incorrect):
 *   minor_seasons/S9/minor_games/{gameId}
 *   minor_seasons/S9/minor_post_games/{gameId}
 *   minor_seasons/S9/minor_lineups/{lineupId}
 *   minor_seasons/S9/minor_post_lineups/{lineupId}
 *   minor_seasons/S9/minor_exhibition_games/{gameId}
 *   minor_seasons/S9/minor_exhibition_lineups/{lineupId}
 *
 * AFTER (correct):
 *   minor_seasons/S9/games/{gameId}
 *   minor_seasons/S9/post_games/{gameId}
 *   minor_seasons/S9/lineups/{lineupId}
 *   minor_seasons/S9/post_lineups/{lineupId}
 *   minor_seasons/S9/exhibition_games/{gameId}
 *   minor_seasons/S9/exhibition_lineups/{lineupId}
 *
 * Usage:
 *   node scripts/migrate-minor-league-subcollections.js S9
 *   node scripts/migrate-minor-league-subcollections.js S9 --dry-run
 */

const admin = require('firebase-admin');
const serviceAccount = require('../real-karma-league-firebase-adminsdk-service-account.json');

// Initialize Firebase Admin
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

// Define the subcollections to migrate
const SUBCOLLECTIONS_TO_MIGRATE = [
    { from: 'minor_games', to: 'games' },
    { from: 'minor_post_games', to: 'post_games' },
    { from: 'minor_lineups', to: 'lineups' },
    { from: 'minor_post_lineups', to: 'post_lineups' },
    { from: 'minor_exhibition_games', to: 'exhibition_games' },
    { from: 'minor_exhibition_lineups', to: 'exhibition_lineups' }
];

/**
 * Migrates documents from one subcollection to another
 */
async function migrateSubcollection(seasonId, fromCollection, toCollection, isDryRun = false) {
    const seasonPath = `minor_seasons/${seasonId}`;
    const fromRef = db.collection(seasonPath).doc(seasonId).collection(fromCollection);
    const toRef = db.collection(seasonPath).doc(seasonId).collection(toCollection);

    console.log(`\n${'='.repeat(80)}`);
    console.log(`Migrating: ${seasonPath}/${fromCollection} -> ${seasonPath}/${toCollection}`);
    console.log(`${'='.repeat(80)}`);

    try {
        // Get all documents from the source collection
        const snapshot = await fromRef.get();

        if (snapshot.empty) {
            console.log(`✓ No documents found in ${fromCollection} (collection may not exist or is already empty)`);
            return { migrated: 0, errors: 0 };
        }

        console.log(`Found ${snapshot.size} documents to migrate`);

        let migratedCount = 0;
        let errorCount = 0;
        const batchSize = 500;

        // Process documents in batches
        for (let i = 0; i < snapshot.docs.length; i += batchSize) {
            const batchDocs = snapshot.docs.slice(i, i + batchSize);
            const batch = db.batch();

            for (const doc of batchDocs) {
                const docId = doc.id;
                const docData = doc.data();

                if (isDryRun) {
                    console.log(`  [DRY RUN] Would migrate document: ${docId}`);
                } else {
                    try {
                        // Write to new location
                        const newDocRef = toRef.doc(docId);
                        batch.set(newDocRef, docData);

                        // Delete from old location
                        batch.delete(doc.ref);

                        console.log(`  ✓ Queued migration for document: ${docId}`);
                    } catch (error) {
                        console.error(`  ✗ Error queuing document ${docId}:`, error.message);
                        errorCount++;
                    }
                }
            }

            if (!isDryRun && batchDocs.length > 0) {
                try {
                    await batch.commit();
                    migratedCount += batchDocs.length - errorCount;
                    console.log(`  ✓ Batch committed: ${batchDocs.length} documents`);
                } catch (error) {
                    console.error(`  ✗ Error committing batch:`, error.message);
                    errorCount += batchDocs.length;
                }
            }
        }

        if (isDryRun) {
            console.log(`\n[DRY RUN] Would migrate ${snapshot.size} documents`);
        } else {
            console.log(`\n✓ Migration complete: ${migratedCount} documents migrated, ${errorCount} errors`);
        }

        return { migrated: isDryRun ? 0 : migratedCount, errors: errorCount };

    } catch (error) {
        console.error(`✗ Error migrating ${fromCollection}:`, error.message);
        return { migrated: 0, errors: 1 };
    }
}

/**
 * Verifies that the migration was successful
 */
async function verifyMigration(seasonId, fromCollection, toCollection) {
    const seasonPath = `minor_seasons/${seasonId}`;
    const fromRef = db.collection(seasonPath).doc(seasonId).collection(fromCollection);
    const toRef = db.collection(seasonPath).doc(seasonId).collection(toCollection);

    try {
        const [fromSnap, toSnap] = await Promise.all([
            fromRef.limit(1).get(),
            toRef.limit(1).get()
        ]);

        const fromCount = fromSnap.size;
        const toCount = toSnap.size;

        if (fromCount === 0 && toCount > 0) {
            console.log(`  ✓ ${fromCollection} -> ${toCollection}: Migration verified (source empty, destination has data)`);
            return true;
        } else if (fromCount === 0 && toCount === 0) {
            console.log(`  ⚠ ${fromCollection} -> ${toCollection}: Both collections empty (may not have existed)`);
            return true;
        } else if (fromCount > 0) {
            console.log(`  ✗ ${fromCollection} -> ${toCollection}: Source collection still has documents!`);
            return false;
        } else {
            console.log(`  ⚠ ${fromCollection} -> ${toCollection}: Unexpected state`);
            return false;
        }
    } catch (error) {
        console.error(`  ✗ Error verifying ${fromCollection}:`, error.message);
        return false;
    }
}

/**
 * Main migration function
 */
async function runMigration(seasonId, isDryRun = false) {
    console.log('\n' + '='.repeat(80));
    console.log(`MINOR LEAGUE SUBCOLLECTION MIGRATION ${isDryRun ? '(DRY RUN)' : ''}`);
    console.log('='.repeat(80));
    console.log(`Season: ${seasonId}`);
    console.log(`Time: ${new Date().toISOString()}`);
    console.log('='.repeat(80));

    if (isDryRun) {
        console.log('\n⚠️  DRY RUN MODE - No changes will be made to the database');
    } else {
        console.log('\n⚠️  LIVE MODE - Changes will be written to the database!');
    }

    let totalMigrated = 0;
    let totalErrors = 0;

    // Migrate each subcollection
    for (const { from, to } of SUBCOLLECTIONS_TO_MIGRATE) {
        const result = await migrateSubcollection(seasonId, from, to, isDryRun);
        totalMigrated += result.migrated;
        totalErrors += result.errors;
    }

    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('MIGRATION SUMMARY');
    console.log('='.repeat(80));

    if (isDryRun) {
        console.log('Mode: DRY RUN (no changes made)');
    } else {
        console.log(`Total documents migrated: ${totalMigrated}`);
        console.log(`Total errors: ${totalErrors}`);

        if (totalErrors === 0 && totalMigrated > 0) {
            console.log('\n✓ Migration completed successfully!');

            // Verify migration
            console.log('\n' + '='.repeat(80));
            console.log('VERIFICATION');
            console.log('='.repeat(80));

            for (const { from, to } of SUBCOLLECTIONS_TO_MIGRATE) {
                await verifyMigration(seasonId, from, to);
            }
        } else if (totalMigrated === 0) {
            console.log('\n⚠ No documents were migrated (collections may already be migrated or empty)');
        } else {
            console.log(`\n⚠ Migration completed with ${totalErrors} errors`);
        }
    }

    console.log('='.repeat(80) + '\n');
}

// Parse command line arguments
const args = process.argv.slice(2);
const seasonId = args[0];
const isDryRun = args.includes('--dry-run');

if (!seasonId) {
    console.error('Error: Season ID is required');
    console.log('\nUsage:');
    console.log('  node scripts/migrate-minor-league-subcollections.js <seasonId> [--dry-run]');
    console.log('\nExamples:');
    console.log('  node scripts/migrate-minor-league-subcollections.js S9 --dry-run');
    console.log('  node scripts/migrate-minor-league-subcollections.js S9');
    process.exit(1);
}

// Run the migration
runMigration(seasonId, isDryRun)
    .then(() => {
        console.log('Migration script completed');
        process.exit(0);
    })
    .catch((error) => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
