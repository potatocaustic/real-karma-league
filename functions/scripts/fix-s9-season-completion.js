/**
 * One-time data fix script to clean up orphaned incomplete Finals games
 * and set S9's current_week to "Season Complete"
 *
 * Background:
 * The S9 season has orphaned incomplete Finals games that prevent correct season completion display.
 * The advanceBracket function should have deleted these incomplete games when the series winner was set,
 * but this didn't run properly after the Finals concluded.
 *
 * This script:
 * 1. Deletes incomplete Finals games (completed == 'FALSE' and series_id == 'Finals')
 * 2. Sets S9's current_week to "Season Complete"
 *
 * Prerequisites:
 * Set GOOGLE_APPLICATION_CREDENTIALS environment variable to your service account key path.
 *
 * Usage:
 *   cd functions
 *
 *   # Dry run (default) - shows what would be changed
 *   node scripts/fix-s9-season-completion.js
 *
 *   # Execute the fix
 *   node scripts/fix-s9-season-completion.js --execute
 */

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

async function fix() {
  const dryRun = !process.argv.includes('--execute');

  console.log('========================================');
  console.log('S9 Season Completion Fix');
  console.log(`Mode: ${dryRun ? 'DRY RUN (use --execute to apply)' : 'EXECUTING'}`);
  console.log('========================================\n');

  // 1. Find incomplete Finals games
  console.log('=== Finding Incomplete Finals Games ===');
  const incompleteFinalsSnap = await db.collection('seasons').doc('S9')
    .collection('post_games')
    .where('series_id', '==', 'Finals')
    .where('completed', '==', 'FALSE')
    .get();

  console.log(`  Found: ${incompleteFinalsSnap.size} incomplete Finals games\n`);

  if (!incompleteFinalsSnap.empty) {
    incompleteFinalsSnap.forEach(doc => {
      const data = doc.data();
      console.log(`  - ${doc.id}`);
      console.log(`    Date: ${data.date || 'N/A'}`);
      console.log(`    Teams: ${data.team1_id} vs ${data.team2_id}`);
      console.log(`    Completed: ${data.completed}`);
      console.log('');
    });
  }

  // 2. Check current S9 season state
  console.log('=== Current S9 Season State ===');
  const seasonDoc = await db.collection('seasons').doc('S9').get();
  const seasonData = seasonDoc.data();
  console.log(`  current_week: ${seasonData.current_week || '(undefined)'}`);
  console.log(`  status: ${seasonData.status}`);
  console.log('');

  // 3. Verify there's a Finals winner already
  console.log('=== Verifying Finals Winner ===');
  const completedFinalsSnap = await db.collection('seasons').doc('S9')
    .collection('post_games')
    .where('series_id', '==', 'Finals')
    .where('completed', '==', 'TRUE')
    .limit(1)
    .get();

  if (completedFinalsSnap.empty) {
    console.log('  ERROR: No completed Finals game found!');
    console.log('  Cannot mark season as complete without a Finals winner.');
    process.exit(1);
  }

  const completedFinals = completedFinalsSnap.docs[0].data();
  console.log(`  Finals winner: ${completedFinals.series_winner || 'NOT SET'}`);

  if (!completedFinals.series_winner) {
    console.log('  ERROR: Completed Finals game has no series_winner!');
    console.log('  Please set series_winner before running this fix.');
    process.exit(1);
  }
  console.log('');

  // 4. Apply the fix
  if (dryRun) {
    console.log('=== DRY RUN - No changes made ===');
    console.log('  Would delete:');
    incompleteFinalsSnap.forEach(doc => console.log(`    - ${doc.id}`));
    console.log(`  Would set current_week: "Season Complete"`);
    console.log('\nRun with --execute to apply these changes.');
  } else {
    console.log('=== Applying Fix ===');
    const batch = db.batch();

    // Delete orphaned incomplete Finals games
    console.log(`  Deleting ${incompleteFinalsSnap.size} incomplete Finals games...`);
    incompleteFinalsSnap.forEach(doc => {
      console.log(`    - ${doc.id}`);
      batch.delete(doc.ref);
    });

    // Set current_week to Season Complete
    const seasonRef = db.collection('seasons').doc('S9');
    batch.update(seasonRef, { current_week: 'Season Complete' });
    console.log('  Setting current_week to "Season Complete"');

    await batch.commit();
    console.log('\nFix applied successfully!');
  }

  console.log('\n========================================');
  process.exit(0);
}

fix().catch(err => {
  console.error('Fix failed:', err);
  process.exit(1);
});
