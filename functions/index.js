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
 * Converts a MM/DD/YYYY date string to a YYYY-MM-DD string.
 * Returns null if the format is invalid.
 * @param {string} dateString The date string to convert.
 * @returns {string|null} The formatted date string or null.
 */
function getSafeDateString(dateString) {
    if (!dateString || typeof dateString !== 'string') return null;
    const parts = dateString.split('/');
    if (parts.length === 3) {
        const [month, day, year] = parts;
        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    return null;
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
            transactionsLogRaw,
            // --- ADDED: Postseason data tabs ---
            postScheduleRaw,
            postLineupsRaw,
            postWeeklyAveragesRaw
        ] = await Promise.all([
            fetchAndParseSheet("Players"),
            fetchAndParseSheet("Draft_Capital"),
            fetchAndParseSheet("Teams"),
            fetchAndParseSheet("Schedule"),
            fetchAndParseSheet("Lineups"),
            fetchAndParseSheet("Weekly_Averages"),
            fetchAndParseSheet("Transaction_Log"),
            // --- ADDED: Postseason data tabs ---
            fetchAndParseSheet("post_schedule"),
            fetchAndParseSheet("post_lineups"),
            fetchAndParseSheet("post_weekly_averages")
        ]);
        console.log("All sheets fetched successfully.");

        // --- Clear and Sync Players collection ---
        console.log("Clearing the 'players' collection...");
        await deleteCollection(db, 'players', 200);
        console.log("'players' collection cleared successfully.");
        
        const playersBatch = db.batch();
        playersRaw.forEach(player => {
            if (player.player_handle && player.player_handle.trim()) { 
                const docRef = db.collection("players").doc(player.player_handle.trim());
                const playerData = { ...player };
                
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

        // --- Clear and Sync 'draftPicks' collection ---
        console.log("Clearing the 'draftPicks' collection for a fresh sync...");
        await deleteCollection(db, 'draftPicks', 200);
        console.log("'draftPicks' collection cleared successfully.");

        const draftPicksBatch = db.batch();
        draftPicksRaw.forEach(pick => {
            if (pick.pick_id && pick.pick_id.trim()) {
                const docRef = db.collection("draftPicks").doc(pick.pick_id.trim());
                const pickData = { ...pick };

                pickData.season = parseNumber(pick.season);
                pickData.round = parseNumber(pick.round);

                draftPicksBatch.set(docRef, pickData);
            }
        });
        await draftPicksBatch.commit();
        console.log(`Successfully synced ${draftPicksRaw.length} draft picks to the 'draftPicks' collection.`);

        // --- Clear and Sync Teams collection ---
        console.log("Clearing the 'teams' collection...");
        await deleteCollection(db, 'teams', 200);
        const teamsBatch = db.batch();
        teamsRaw.forEach(team => {
            if(team.team_id && team.team_id.trim()) {
                const docRef = db.collection("teams").doc(team.team_id.trim());
                teamsBatch.set(docRef, team);
            }
        });
        await teamsBatch.commit();
        console.log(`Successfully synced ${teamsRaw.length} teams.`);
        
        // --- Clear and Sync Schedule collection ---
        console.log("Clearing the 'schedule' collection...");
        await deleteCollection(db, 'schedule', 200);
        const scheduleBatch = db.batch();
        scheduleRaw.forEach(game => {
            const safeDate = getSafeDateString(game.date);
            if (safeDate && game.team1_id && game.team1_id.trim() && game.team2_id && game.team2_id.trim()) {
                const docId = `${safeDate}-${game.team1_id.trim()}-${game.team2_id.trim()}`;
                const docRef = db.collection("schedule").doc(docId);
                const gameData = { ...game };
                gameData.team1_score = parseNumber(game.team1_score);
                gameData.team2_score = parseNumber(game.team2_score);
                scheduleBatch.set(docRef, gameData);
            }
        });
        await scheduleBatch.commit();
        console.log(`Successfully synced ${scheduleRaw.length} schedule games.`);

        // --- Clear and Sync Lineups collection ---
        console.log("Clearing the 'lineups' collection...");
        await deleteCollection(db, 'lineups', 200);
        const lineupsBatch = db.batch();
        lineupsRaw.forEach(lineup => {
            const safeDate = getSafeDateString(lineup.date);
            if (safeDate && lineup.player_handle && lineup.player_handle.trim()) {
                const docId = `${safeDate}-${lineup.player_handle.trim()}`;
                const docRef = db.collection("lineups").doc(docId);
                const lineupData = { ...lineup };
                lineupData.points_final = parseNumber(lineup.points_final);
                lineupData.points_raw = parseNumber(lineup.points_raw);
                lineupData.global_rank = parseNumber(lineup.global_rank);
                lineupsBatch.set(docRef, lineupData);
            }
        });
        await lineupsBatch.commit();
        console.log(`Successfully synced ${lineupsRaw.length} lineup entries.`);

        // --- Clear and Sync Weekly Averages collection ---
        console.log("Clearing the 'weekly_averages' collection...");
        await deleteCollection(db, 'weekly_averages', 200);
        const weeklyAveragesBatch = db.batch();
        weeklyAveragesRaw.forEach(week => {
            const safeDate = getSafeDateString(week.date);
            if (safeDate) {
                const docRef = db.collection("weekly_averages").doc(safeDate);
                const weekData = { ...week };
                weekData.mean_score = parseNumber(week.mean_score);
                weekData.median_score = parseNumber(week.median_score);
                weeklyAveragesBatch.set(docRef, weekData);
            }
        });
        await weeklyAveragesBatch.commit();
        console.log(`Successfully synced ${weeklyAveragesRaw.length} weekly average entries.`);

        // --- ADDED: Clear and Sync Postseason Schedule collection ---
        console.log("Clearing the 'post_schedule' collection...");
        await deleteCollection(db, 'post_schedule', 200);
        const postScheduleBatch = db.batch();
        postScheduleRaw.forEach(game => {
            const safeDate = getSafeDateString(game.date);
            if (safeDate && game.team1_id && game.team1_id.trim() && game.team2_id && game.team2_id.trim()) {
                const docId = `${safeDate}-${game.team1_id.trim()}-${game.team2_id.trim()}`;
                const docRef = db.collection("post_schedule").doc(docId);
                const gameData = { ...game };
                gameData.team1_score = parseNumber(game.team1_score);
                gameData.team2_score = parseNumber(game.team2_score);
                postScheduleBatch.set(docRef, gameData);
            }
        });
        await postScheduleBatch.commit();
        console.log(`Successfully synced ${postScheduleRaw.length} postseason schedule games.`);

        // --- ADDED: Clear and Sync Postseason Lineups collection ---
        console.log("Clearing the 'post_lineups' collection...");
        await deleteCollection(db, 'post_lineups', 200);
        const postLineupsBatch = db.batch();
        postLineupsRaw.forEach(lineup => {
            const safeDate = getSafeDateString(lineup.date);
            if (safeDate && lineup.player_handle && lineup.player_handle.trim()) {
                const docId = `${safeDate}-${lineup.player_handle.trim()}`;
                const docRef = db.collection("post_lineups").doc(docId);
                const lineupData = { ...lineup };
                lineupData.points_final = parseNumber(lineup.points_final);
                lineupData.points_raw = parseNumber(lineup.points_raw);
                lineupData.global_rank = parseNumber(lineup.global_rank);
                postLineupsBatch.set(docRef, lineupData);
            }
        });
        await postLineupsBatch.commit();
        console.log(`Successfully synced ${postLineupsRaw.length} postseason lineup entries.`);

        // --- ADDED: Clear and Sync Postseason Weekly Averages collection ---
        console.log("Clearing the 'post_weekly_averages' collection...");
        await deleteCollection(db, 'post_weekly_averages', 200);
        const postWeeklyAveragesBatch = db.batch();
        postWeeklyAveragesRaw.forEach(week => {
            const safeDate = getSafeDateString(week.date);
            if (safeDate) {
                const docRef = db.collection("post_weekly_averages").doc(safeDate);
                const weekData = { ...week };
                weekData.mean_score = parseNumber(week.mean_score);
                weekData.median_score = parseNumber(week.median_score);
                postWeeklyAveragesBatch.set(docRef, weekData);
            }
        });
        await postWeeklyAveragesBatch.commit();
        console.log(`Successfully synced ${postWeeklyAveragesRaw.length} postseason weekly average entries.`);

        res.status(200).send("Firestore sync completed successfully!");

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
