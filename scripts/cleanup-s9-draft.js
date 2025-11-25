// Cleanup script for S9 Minor League draft submission
// This script deletes incorrect draft results and any created players

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function cleanupS9Draft() {
  console.log('Starting S9 Minor League draft cleanup...\n');

  const batch = db.batch();
  let draftDocsDeleted = 0;
  let playersDeleted = 0;

  try {
    // Step 1: Delete all draft result documents
    console.log('Step 1: Deleting draft result documents...');
    const draftResultsRef = db.collection('minor_draft_results/season_9/S9_draft_results');
    const draftSnapshot = await draftResultsRef.get();

    console.log(`Found ${draftSnapshot.size} draft result documents`);
    draftSnapshot.forEach(doc => {
      batch.delete(doc.ref);
      draftDocsDeleted++;
      console.log(`  - Queued for deletion: ${doc.id}`);
    });

    // Step 2: Find and delete newly created players from this draft
    console.log('\nStep 2: Finding players created from S9 draft...');
    const playersRef = db.collection('minor_v2_players');
    const playersSnapshot = await playersRef.where('bio', '>=', 'R').where('bio', '<=', 'R\uf8ff').get();

    console.log(`Checking ${playersSnapshot.size} players...`);
    playersSnapshot.forEach(doc => {
      const data = doc.data();
      // Check if bio mentions S9 draft
      if (data.bio && data.bio.includes('S9 draft')) {
        batch.delete(doc.ref);
        playersDeleted++;
        console.log(`  - Queued for deletion: ${doc.id} (${data.player_handle})`);
      }
    });

    // Step 3: Delete the parent document
    console.log('\nStep 3: Deleting parent document...');
    const parentDocRef = db.doc('minor_draft_results/season_9');
    batch.delete(parentDocRef);

    // Commit the batch
    console.log('\n' + '='.repeat(50));
    console.log('Summary:');
    console.log(`  Draft results to delete: ${draftDocsDeleted}`);
    console.log(`  Players to delete: ${playersDeleted}`);
    console.log('='.repeat(50));

    const confirm = await new Promise(resolve => {
      const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
      });
      readline.question('\nProceed with deletion? (yes/no): ', answer => {
        readline.close();
        resolve(answer.toLowerCase() === 'yes');
      });
    });

    if (!confirm) {
      console.log('\nCleanup cancelled.');
      return;
    }

    await batch.commit();
    console.log('\n✓ Cleanup completed successfully!');
    console.log(`  ${draftDocsDeleted} draft results deleted`);
    console.log(`  ${playersDeleted} players deleted`);

  } catch (error) {
    console.error('\n✗ Error during cleanup:', error);
    throw error;
  }
}

// Run the cleanup
cleanupS9Draft()
  .then(() => {
    console.log('\nDone!');
    process.exit(0);
  })
  .catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
