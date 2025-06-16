// functions/index.js

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const { google } = require("googleapis");

admin.initializeApp();
const db = admin.firestore();

// This is an HTTP-triggered function. We will call its URL to run it.
exports.syncSheetsToFirestore = functions.https.onRequest(async (req, res) => {
  try {
    // --- Configuration ---
    const SPREADSHEET_ID = "12EembQnztbdKx2-buv00--VDkEFSTuSXTRdOnTnRxq4"; // Your Google Sheet ID

    // --- Step 1: Authenticate with Google Sheets ---
    const auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const sheets = google.sheets({ version: "v4", auth });

    // --- Step 2: Sync the "Players" Sheet ---
    const playersResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "Players!A:Z", // Fetches all columns from the Players sheet
    });

    const playersRows = playersResponse.data.values;
    if (playersRows && playersRows.length > 0) {
      const playersHeader = playersRows.shift(); // Remove header row
      const playersBatch = db.batch();

      playersRows.forEach(row => {
        const playerObj = {};
        playersHeader.forEach((header, index) => {
          playerObj[header] = row[index];
        });

        const docId = playerObj.player_handle;
        if (docId) {
          const docRef = db.collection("players").doc(docId);
          playersBatch.set(docRef, playerObj, { merge: true });
        }
      });
      await playersBatch.commit();
      console.log("Successfully synced Players sheet.");
    }

    // --- Step 3: Sync the "Draft_Capital" Sheet ---
    const picksResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: "Draft_Capital!A:Z", // Fetches all columns from the Draft_Capital sheet
    });

    const picksRows = picksResponse.data.values;
    if(picksRows && picksRows.length > 0) {
        const picksHeader = picksRows.shift();
        const picksBatch = db.batch();

        picksRows.forEach(row => {
            const pickObj = {};
            picksHeader.forEach((header, index) => {
                pickObj[header] = row[index];
            });

            const docId = pickObj.pick_id;
            if(docId) {
                const docRef = db.collection("draftPicks").doc(docId);
                picksBatch.set(docRef, pickObj, { merge: true });
            }
        });
        await picksBatch.commit();
        console.log("Successfully synced Draft_Capital sheet.");
    }

    res.status(200).send("Sync completed successfully!");

  } catch (error) {
    console.error("Error during sync:", error);
    res.status(500).send("Sync failed. Check function logs.");
  }
});