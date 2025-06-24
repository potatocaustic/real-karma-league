const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

admin.initializeApp();
const db = admin.firestore();

/**
 * Deletes a collection by batching deletes. This is used to clear collections
 * before a fresh sync to prevent data duplication or orphaned documents.
 * @param {admin.firestore.Firestore} db The Firestore database instance.
 * @param {string} collectionPath The path to the collection to delete.
 * @param {number} batchSize The number of documents to delete in each batch.
 */
async function deleteCollection(db, collectionPath, batchSize) {
    const collectionRef = db.collection(collectionPath);
    const query = collectionRef.orderBy('__name__').limit(batchSize);

    let snapshot = await query.get();

    // When there are no documents left, the snapshot will be empty.
    while (snapshot.size > 0) {
        const batch = db.batch();
        snapshot.docs.forEach((doc) => {
            batch.delete(doc.ref);
        });
        await batch.commit();

        // Get the next batch of documents
        snapshot = await query.get();
    }
}

/**
 * Parses a CSV string into an array of objects.
 * @param {string} csvText The raw CSV text to parse.
 * @returns {Array<Object>} An array of objects representing the CSV rows.
 */
function parseCSV(csvText) {
    const lines = csvText.trim().split('\n');
    const headerLine = lines.shift();
    // Clean headers of any quotes and extra whitespace.
    const headers = headerLine.split(',').map(h => h.replace(/"/g, '').trim());
    const data = lines.map(line => {
        // Regex to handle values that might be wrapped in quotes.
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

/**
 * Safely parses a string into a number, returning 0 for invalid inputs.
 * @param {*} value The value to parse.
 * @returns {number} The parsed number or 0.
 */
function parseNumber(value) {
    if (value === null || typeof value === 'undefined' || String(value).trim() === '') return 0;
    const cleaned = String(value).replace(/,/g, '');
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
}


/**
 * Cloud Function to sync data from a Google Sheet to Firestore.
 * Triggered via an HTTP request.
 */
exports.syncSheetsToFirestore = functions.https.onRequest(async (req, res) => {
    try {
        const SPREADSHEET_ID = "12EembQnztbdKx2-buv00--VDkEFSTuSXTRdOnTnRxq4";
        
        // Helper to fetch and parse a single sheet from Google Sheets.
        const fetchAndParseSheet = async (sheetName) => {
            const gvizUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
            const response = await fetch(gvizUrl);
            if (!response.ok) throw new Error(`Failed to fetch sheet: ${sheetName}`);
            const csvText = await response.text();
            return parseCSV(csvText);
        };

        console.log("Fetching all sheets...");
        const [
            playersRaw, 
            draftPicksRaw,
            teamsRaw,
            scheduleRaw,
            lineupsRaw,
            weeklyAveragesRaw,
            transactionsLogRaw
        ] = await Promise.all([
            fetchAndParseSheet("Players"),
            fetchAndParseSheet("Draft_Capital"), // The name of the sheet for draft picks
            fetchAndParseSheet("Teams"),
            fetchAndParseSheet("Schedule"),
            fetchAndParseSheet("Lineups"),
            fetchAndParseSheet("Weekly_Averages"),
            fetchAndParseSheet("Transaction_Log")
        ]);
        console.log("All sheets fetched successfully.");

        // --- Clear and Sync Players collection ---
        console.log("Clearing the 'players' collection...");
        await deleteCollection(db, 'players', 200);
        console.log("'players' collection cleared successfully.");
        
        const playersBatch = db.batch();
        playersRaw.forEach(player => {
            if (player.player_handle) { 
                const docRef = db.collection("players").doc(player.player_handle);
                const playerData = { ...player };
                
                // Explicitly convert numeric fields for consistency.
                playerData.GEM = parseNumber(player.GEM);
                playerData.REL = parseNumber(player.REL);
                playerData.WAR = parseNumber(player.WAR);
                playerData.aag_mean = parseNumber(player.aag_mean);
                playerData.aag_median = parseNumber(player.aag_median);
                playerData.games_played = parseNumber(player.games_played);
                playerData.total_points = parseNumber(player.total_points);
                
                playersBatch.set(docRef, playerData);
            }
        });
        await playersBatch.commit();
        console.log(`Successfully synced ${playersRaw.length} players.`);

        // --- NEW: Clear and Sync 'draftPicks' collection ---
        console.log("Clearing the 'draftPicks' collection for a fresh sync...");
        await deleteCollection(db, 'draftPicks', 200);
        console.log("'draftPicks' collection cleared successfully.");

        const draftPicksBatch = db.batch();
        draftPicksRaw.forEach(pick => {
            // Use 'pick_id' from the sheet as the unique document ID.
            if (pick.pick_id) {
                const docRef = db.collection("draftPicks").doc(pick.pick_id);
                const pickData = { ...pick };

                // Ensure 'season' and 'round' are stored as numbers for proper sorting.
                pickData.season = parseNumber(pick.season);
                pickData.round = parseNumber(pick.round);

                draftPicksBatch.set(docRef, pickData);
            }
        });
        await draftPicksBatch.commit();
        console.log(`Successfully synced ${draftPicksRaw.length} draft picks to the 'draftPicks' collection.`);

        console.log("Clearing the 'teams' collection...");
        await deleteCollection(db, 'teams', 200);
        const teamsBatch = db.batch();
        teamsRaw.forEach(team => {
            if(team.team_id) {
                const docRef = db.collection("teams").doc(team.team_id);
                teamsBatch.set(docRef, team);
            }
        });
        await teamsBatch.commit();
        console.log(`Successfully synced ${teamsRaw.length} teams.`);
        
                // --- Clear and Sync 'schedule' collection ---
        console.log("Clearing the 'schedule' collection...");
        await deleteCollection(db, 'schedule', 200);
        console.log("'schedule' collection cleared successfully.");

        const scheduleBatch = db.batch();
        scheduleRaw.forEach(game => {
            // A unique ID is required for each document. 
            // Create a composite ID if no single unique 'game_id' column exists.
            if (game.team1_id && game.team2_id && game.date) {
                const gameId = `${game.date}-${game.team1_id}-vs-${game.team2_id}`;
                const docRef = db.collection("schedule").doc(gameId);
                scheduleBatch.set(docRef, game);
            }
        });
        await scheduleBatch.commit();
        console.log(`Successfully synced ${scheduleRaw.length} schedule games.`);

        res.status(200).send("Firestore sync completed successfully!");

        console.log("Clearing the 'lineups' collection...");
        await deleteCollection(db, 'lineups', 200);
        console.log("'lineups' collection cleared successfully.");

        const lineupsBatch = db.batch();
        lineupsRaw.forEach(lineup => {
            // Create a unique document ID for each lineup entry. 
            // This assumes a player can only have one lineup entry per date.
            if (lineup.date && lineup.player_handle) {
                const lineupId = `${lineup.date}-${lineup.player_handle}`;
                const docRef = db.collection("lineups").doc(lineupId);

                // Convert numeric fields to numbers for consistency
                const lineupData = { ...lineup };
                lineupData.points_raw = parseNumber(lineup.points_raw);
                lineupData.points_final = parseNumber(lineup.points_final);
                lineupData.global_rank = parseNumber(lineup.global_rank);
                
                lineupsBatch.set(docRef, lineupData);
            }
        });
        await lineupsBatch.commit();
        console.log(`Successfully synced ${lineupsRaw.length} lineup entries.`);

        // --- Clear and Sync 'weekly_averages' collection ---
        console.log("Clearing the 'weekly_averages' collection...");
        await deleteCollection(db, 'weekly_averages', 200);
        console.log("'weekly_averages' collection cleared successfully.");

        const weeklyAveragesBatch = db.batch();
        weeklyAveragesRaw.forEach(average => {
            // The date of the weekly average serves as a natural unique ID.
            if (average.date) {
                const docRef = db.collection("weekly_averages").doc(average.date);
                
                // Ensure numeric fields are stored as numbers for calculations.
                const averageData = { ...average };
                averageData.mean_score = parseNumber(average.mean_score);
                averageData.median_score = parseNumber(average.median_score);

                weeklyAveragesBatch.set(docRef, averageData);
            }
        });
        await weeklyAveragesBatch.commit();
        console.log(`Successfully synced ${weeklyAveragesRaw.length} weekly average entries.`);


        // --- Clear and Sync 'transaction_log' collection ---
        console.log("Clearing the 'transaction_log' collection...");
        await deleteCollection(db, 'transaction_log', 200);
        console.log("'transaction_log' collection cleared successfully.");

        const transactionsBatch = db.batch();
        transactionsLogRaw.forEach(transaction => {
            // The 'transaction_id' from your sheet is the unique identifier.
            if (transaction.transaction_id) {
                const docRef = db.collection("transaction_log").doc(transaction.transaction_id);
                transactionsBatch.set(docRef, transaction);
            }
        });
        await transactionsBatch.commit();
        console.log(`Successfully synced ${transactionsLogRaw.length} transaction log entries.`);

    } catch (error) {
        console.error("Error during sync:", error);
        res.status(500).send("Sync failed. Check function logs for details.");
    }
});

// --- Your other functions for the trade block remain unchanged ---
exports.clearAllTradeBlocks = functions.https.onCall(async (data, context) => {
    // This function can remain as-is.
});

exports.reopenTradeBlocks = functions.https.onCall(async (data, context) => {
    // This function can remain as-is.
});
