const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

admin.initializeApp();
const db = admin.firestore();

// REPLACE your existing parseCSV function with this debug version

function parseCSV(csvText) {
    const lines = csvText.trim().split('\n');
    const headerLine = lines.shift();
    const headers = headerLine.split(',').map(h => h.replace(/"/g, '').trim());

    // --- DEBUG LOG 1: Inspect the parsed headers ---
    console.log("PARSED HEADERS:", JSON.stringify(headers));
    const relMedianIndex = headers.indexOf('rel_median');
    console.log("Index of 'rel_median':", relMedianIndex);
    // -------------------------------------------------

    const data = lines.map((line, lineIndex) => {
        const values = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || [];
        const row = {};

        // --- DEBUG LOG 2: For the first data row, inspect the values ---
        if (lineIndex === 0) {
             console.log("VALUES ARRAY FOR FIRST ROW:", JSON.stringify(values));
             if (relMedianIndex !== -1) {
                console.log("Value being read for rel_median in first row:", values[relMedianIndex]);
             }
        }
        // ------------------------------------------------------------

        for (let i = 0; i < headers.length; i++) {
            const value = (values[i] || '').replace(/"/g, '').trim();
            row[headers[i]] = value;
        }
        return row;
    });
    return data;
}

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
            fetchAndParseSheet("Draft_Capital"),
            fetchAndParseSheet("Teams"),
            fetchAndParseSheet("Schedule"),
            fetchAndParseSheet("Lineups"),
            fetchAndParseSheet("Weekly_Averages"),
            fetchAndParseSheet("Transaction_Log")
        ]);
        console.log("All sheets fetched successfully.");
        
        // --- Sync Players collection ---
        const playersBatch = db.batch();
        playersRaw.forEach(player => {
            // Use the player's unique handle as the document ID
            if (player.player_handle) { 
                const docRef = db.collection("players").doc(player.player_handle);
                
                // Create a new object with all data from the sheet
                const playerData = { ...player };
                
                // --- IMPORTANT ---
                // Explicitly convert all numeric fields from the sheet (which may be strings)
                // into proper numbers to match your desired Firestore structure.
                playerData.GEM = parseNumber(player.GEM);
                playerData.REL = parseNumber(player.REL);
                playerData.WAR = parseNumber(player.WAR);
                playerData.aag_mean = parseNumber(player.aag_mean);
                playerData.aag_median = parseNumber(player.aag_median);
                playerData.games_played = parseNumber(player.games_played);
                playerData.total_points = parseNumber(player.total_points);

                // Fields like 'all_star', 'rookie', and 'current_team_id' will remain 
                // as strings from the CSV, which matches your example.
                
                // Set the data in the batch, using { merge: true } to update existing players
                playersBatch.set(docRef, playerData, { merge: true });
            }
        });
        await playersBatch.commit();
        console.log(`Successfully synced ${playersRaw.length} players.`);

        // (Sections for syncing Teams, Players are correct and remain unchanged)
        // ...

        // --- Sync Draft Capital collection ---
        const draftPicksBatch = db.batch();
        draftPicksRaw.forEach(pick => {
            if (pick.pick_id) {
                const docRef = db.collection("draft_capital").doc(pick.pick_id);
                const pickData = { ...pick };
                pickData.season = parseNumber(pick.season);
                pickData.round = parseNumber(pick.round);
                pickData.acquired_week = parseNumber(pick.acquired_week); // --- ADDED THIS LINE ---
                draftPicksBatch.set(docRef, pickData, { merge: true });
            }
        });
        await draftPicksBatch.commit();
        console.log(`Successfully synced ${draftPicksRaw.length} draft picks.`);

        // --- Sync Schedule collection ---
        const scheduleBatch = db.batch();
        scheduleRaw.forEach(game => {
            if (game.date && game.team1_id && game.team2_id) {
                const season = game.season || '7'; 
                const gameId = `S${season}_W${game.week}_${game.team1_id}_vs_${game.team2_id}`;

                const docRef = db.collection("schedule").doc(gameId);
                const gameData = { ...game };
                gameData.teams_in_game = [game.team1_id, game.team2_id]; 
                gameData.week = parseNumber(game.week);
                gameData.season = parseNumber(season); 
                gameData.team1_score = parseNumber(game.team1_score);
                gameData.team2_score = parseNumber(game.team2_score);
                scheduleBatch.set(docRef, gameData, { merge: true });
            }
        });
        await scheduleBatch.commit();
        console.log(`Successfully synced ${scheduleRaw.length} schedule games.`);


        // --- Sync Lineups collection ---
        const lineupsBatch = db.batch();
        lineupsRaw.forEach(lineup => {
            if (lineup.date && lineup.player_handle && lineup.team_id) {
                const lineupId = `${lineup.date.replace(/\//g, "-")}_${lineup.team_id}_${lineup.player_handle}`;

                const docRef = db.collection("lineups").doc(lineupId);
                const lineupData = { ...lineup };
                lineupData.week = parseNumber(lineup.week);
                lineupData.points_raw = parseNumber(lineup.points_raw);
                lineupData.points_final = parseNumber(lineup.points_final);
                lineupData.global_rank = parseNumber(lineup.global_rank);
                lineupsBatch.set(docRef, lineupData, { merge: true });
            }
        });
        await lineupsBatch.commit();
        console.log(`Successfully synced ${lineupsRaw.length} lineup entries.`);


        // --- Sync Transaction_Log collection ---
        const transactionsBatch = db.batch();
        transactionsLogRaw.forEach(transaction => {
            if (transaction.transaction_id) {
                const docRef = db.collection("transaction_log").doc(); 
                transactionsBatch.set(docRef, transaction);
            }
        });
        await transactionsBatch.commit();
        console.log(`Successfully synced ${transactionsLogRaw.length} transaction log entries.`);
        
        // (Section for syncing weeklyAverages is correct and remains unchanged)
        // ...

        res.status(200).send("Firestore sync completed successfully!");

    } catch (error) {
        console.error("Error during sync:", error);
        res.status(500).send("Sync failed. Check function logs for details.");
    }
});

// --- Your other functions for the trade block remain unchanged ---
exports.clearAllTradeBlocks = functions.https.onCall(async (data, context) => {
    // ... your existing implementation
});

exports.reopenTradeBlocks = functions.https.onCall(async (data, context) => {
    // ... your existing implementation
});