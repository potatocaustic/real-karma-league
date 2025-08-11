// cleanupPostseasonGames.js

const admin = require('firebase-admin');

// --- IMPORTANT ---
// You must initialize the app with your service account credentials.
// See "How to Run the Script" section below.
// Ensure your GOOGLE_APPLICATION_CREDENTIALS environment variable is set.
admin.initializeApp(); 

const db = admin.firestore();

// --- Configuration ---
// Set the path to the subcollection you want to clear.
const collectionPath = 'seasons_dev/S8/post_games_dev';
const documentToKeep = 'placeholder'; // This script will not delete a document with this ID.

/**
 * Deletes all documents in a specified Firestore subcollection, except for a defined placeholder.
 */
async function cleanupCollection() {
  console.log(`Starting cleanup of subcollection: ${collectionPath}`);
  console.log(`All documents will be deleted EXCEPT for '${documentToKeep}'.`);

  try {
    const collectionRef = db.collection(collectionPath);
    const snapshot = await collectionRef.get();

    if (snapshot.empty) {
      console.log('Subcollection is already empty. No action needed.');
      return;
    }

    // Create a batch to delete documents efficiently.
    const batch = db.batch();
    let deleteCount = 0;

    snapshot.docs.forEach(doc => {
      if (doc.id !== documentToKeep) {
        batch.delete(doc.ref);
        deleteCount++;
      }
    });

    if (deleteCount === 0) {
        console.log(`Only the '${documentToKeep}' document was found. No other documents to delete.`);
        return;
    }

    // Commit the batch to delete all targeted documents at once.
    await batch.commit();
    console.log(`✅ Success! Deleted ${deleteCount} documents from ${collectionPath}.`);

  } catch (error) {
    console.error('❌ Error during cleanup:', error);
    process.exit(1); // Exit with an error code
  }
}

// Run the cleanup function
cleanupCollection();