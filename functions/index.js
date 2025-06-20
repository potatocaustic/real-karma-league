const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

admin.initializeApp();
const db = admin.firestore();

// ... (parseCSV and parseNumber functions remain unchanged) ...
function parseCSV(csvText) {
    const lines = csvText.trim().split('\n');
    const headers = lines.shift().split(',').map(h => h.replace(/"/g, '').trim());
    const data = lines.map(line => {
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
            transactionsLogRaw // --- NEWLY ADDED ---
        ] = await Promise.all([
            fetchAndParseSheet("Players"),
            fetchAndParseSheet("Draft_Capital"),
            fetchAndParseSheet("Teams"),
            fetchAndParseSheet("Schedule"),
            fetchAndParseSheet("Lineups"),
            fetchAndParseSheet("Weekly_Averages"),
            fetchAndParseSheet("Transaction_Log") // --- NEWLY ADDED ---
        ]);
        console.log("All sheets fetched successfully.");

        // (Sections for syncing Teams, Players, and draftPicks are correct and remain unchanged)
        // ...

        // --- Sync Schedule collection (WITH CORRECTION) ---
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


        // --- Sync Lineups collection (WITH CORRECTION) ---
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


        // --- Sync Transaction_Log collection --- // --- NEWLY ADDED SECTION ---
        const transactionsBatch = db.batch();
        transactionsLogRaw.forEach(transaction => {
            // Since a single transaction can have multiple rows (one for each asset),
            // we let Firestore auto-generate a unique document ID for each row.
            // We only process rows that have a transaction_id.
            if (transaction.transaction_id) {
                const docRef = db.collection("transaction_log").doc(); // Auto-generates ID
                transactionsBatch.set(docRef, transaction);
            }
        });
        await transactionsBatch.commit();
        console.log(`Successfully synced ${transactionsLogRaw.length} transaction log entries.`);
        // --- END OF NEWLY ADDED SECTION ---


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