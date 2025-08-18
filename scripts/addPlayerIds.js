// addPlayerIds.js
const admin = require('firebase-admin');

// IMPORTANT: Replace with the path to your service account key file
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const playersCollectionRef = db.collection('v2_players');

async function addPlayerIds() {
  console.log("Fetching all players from the 'v2_players' collection...");

  try {
    const snapshot = await playersCollectionRef.get();

    if (snapshot.empty) {
      console.log("No documents found in the 'v2_players' collection. Exiting.");
      return;
    }

    // A batch can handle up to 500 operations. If you have more than 500
    // players, this script would need to be adjusted to handle multiple batches.
    const batch = db.batch();
    let count = 0;

    snapshot.forEach(doc => {
      console.log(`Preparing update for player: ${doc.id}`);
      const playerRef = playersCollectionRef.doc(doc.id);
      // Here we set the 'player_id' field with the value of the document's ID
      batch.update(playerRef, { player_id: doc.id });
      count++;
    });

    console.log(`\nCommitting batch update for ${count} players...`);
    await batch.commit();
    console.log('✅ Success! All players have been updated with a player_id field.');

  } catch (error) {
    console.error("❌ Error updating players:", error);
    console.log("The operation failed. No data was changed.");
  }
}

addPlayerIds();