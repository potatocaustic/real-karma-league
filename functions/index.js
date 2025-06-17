const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fetch = require("node-fetch"); // Use node-fetch for making HTTP requests

admin.initializeApp();
const db = admin.firestore();

// A simple CSV parser function
function parseCSV(csvText) {
    const lines = csvText.trim().split('\n');
    const headers = lines.shift().split(',').map(h => h.replace(/"/g, '').trim());
    const data = lines.map(line => {
        // This simple regex handles values that may or may not be quoted
        const values = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || [];
        const row = {};
        for (let i = 0; i < headers.length; i++) {
            const value = (values[i] || '').replace(/"/g, '').trim();
            row[headers[i]] = value;
        }
        return row;
    });
    return data;
}

// Helper to ensure values from the sheet are stored as numbers
function parseNumber(value) {
    if (value === null || typeof value === 'undefined' || String(value).trim() === '') return 0;
    const cleaned = String(value).replace(/,/g, '');
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
}

exports.syncSheetsToFirestore = functions.https.onRequest(async (req, res) => {
    try {
        const SPREADSHEET_ID = "12EembQnztbdKx2-buv00--VDkEFSTuSXTRdOnTnRxq4";
        
        const fetchAndParseSheet = async (sheetName) => {
            const gvizUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
            const response = await fetch(gvizUrl);
            if (!response.ok) throw new Error(`Failed to fetch sheet: ${sheetName}`);
            const csvText = await response.text();
            return parseCSV(csvText);
        };

        // --- Fetch both sheets in parallel ---
        const [playersRaw, draftPicksRaw] = await Promise.all([
            fetchAndParseSheet("Players"),
            fetchAndParseSheet("Draft_Capital")
        ]);

        // --- Process and Sync Players ---
        console.log("Processing player stats...");
        const playersBatch = db.batch();
        playersRaw.forEach(player => {
            if (player.player_handle) {
                const docRef = db.collection("players").doc(player.player_handle);
                // Create a clean object with only the data we need
                const playerData = {
                    current_team_id: player.current_team_id,
                    player_handle: player.player_handle,
                    // Pulling directly from the columns you specified
                    games_played: parseNumber(player.games_played),
                    REL: parseNumber(player.rel_median),
                    WAR: parseNumber(player.WAR)
                };
                playersBatch.set(docRef, playerData, { merge: true });
            }
        });
        await playersBatch.commit();
        console.log(`Successfully synced ${playersRaw.length} players.`);

        // --- Process and Sync Draft Picks ---
        const picksBatch = db.batch();
        draftPicksRaw.forEach(pick => {
            if (pick.pick_id) {
                const docRef = db.collection("draftPicks").doc(pick.pick_id);
                // The { merge: true } option ensures we just update/add, not overwrite other fields if they exist
                picksBatch.set(docRef, pick, { merge: true });
            }
        });
        await picksBatch.commit();
        console.log(`Successfully synced ${draftPicksRaw.length} draft picks.`);

        res.status(200).send("Sync completed successfully using direct sheet values!");

    } catch (error) {
        console.error("Error during sync:", error);
        res.status(500).send("Sync failed. Check function logs.");
    }
});