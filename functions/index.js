const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

admin.initializeApp();
const db = admin.firestore();

/**
 * A simple CSV parser function to handle Google's gviz output.
 * It is designed to handle the specific quoted format from the Sheets API.
 * @param {string} csvText The raw CSV text to parse.
 * @returns {Array<Object>} An array of row objects.
 */
function parseCSV(csvText) {
    const lines = csvText.trim().split('\n');
    const headers = lines.shift().split(',').map(h => h.replace(/"/g, '').trim());
    const data = lines.map(line => {
        // This regex handles values that are quoted (and may contain commas) or unquoted.
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
 * Helper to ensure values from the sheet are stored as numbers in Firestore.
 * @param {*} value The value to parse.
 * @returns {number} The parsed number, or 0 if invalid.
 */
function parseNumber(value) {
    if (value === null || typeof value === 'undefined' || String(value).trim() === '') return 0;
    const cleaned = String(value).replace(/,/g, '');
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
}


/**
 * Cloud Function to sync all relevant data from Google Sheets to Firestore.
 * This should be run periodically or after major updates to the sheets.
 */
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

        // --- Step 1: Fetch all necessary sheets from Google Sheets ---
        console.log("Fetching all sheets...");
        const [
            playersRaw, 
            draftPicksRaw, 
            teamsRaw,
            scheduleRaw,
            lineupsRaw,
            weeklyAveragesRaw
        ] = await Promise.all([
            fetchAndParseSheet("Players"),
            fetchAndParseSheet("Draft_Capital"),
            fetchAndParseSheet("Teams"),
            fetchAndParseSheet("Schedule"),
            fetchAndParseSheet("Lineups"),
            fetchAndParseSheet("Weekly_Averages")
        ]);
        console.log("All sheets fetched successfully.");


        // --- Step 2: Sync Teams collection ---
        const excludedTeams = ["FREE_AGENT", "RETIRED", "EAST", "WEST", "EGM", "WGM", "RSE", "RSW"];
        const teamsBatch = db.batch();
        let syncedTeamCount = 0;
        teamsRaw.forEach(team => {
            if (team.team_id && !excludedTeams.includes(team.team_id.toUpperCase())) {
                const docRef = db.collection("teams").doc(team.team_id);
                teamsBatch.set(docRef, {
                    team_id: team.team_id,
                    team_name: team.team_name,
                    conference: team.conference,
                    current_gm_handle: team.current_gm_handle,
                    gm_uid: team.gm_uid,
                    wins: parseNumber(team.wins),
                    losses: parseNumber(team.losses),
                    pam: parseNumber(team.pam),
                    med_starter_rank: parseNumber(team.med_starter_rank)
                }, { merge: true });
                syncedTeamCount++;
            }
        });
        await teamsBatch.commit();
        console.log(`Successfully synced ${syncedTeamCount} teams.`);
        

        // --- Step 3: Sync Players collection (including deletion of old players) ---
        const sheetPlayerHandles = new Set(playersRaw.map(p => p.player_handle).filter(Boolean));
        const firestorePlayersSnap = await db.collection("players").get();
        const firestorePlayerHandles = new Set(firestorePlayersSnap.docs.map(doc => doc.id));
        const playersToDelete = [...firestorePlayerHandles].filter(handle => !sheetPlayerHandles.has(handle));

        if (playersToDelete.length > 0) {
            const deleteBatch = db.batch();
            playersToDelete.forEach(handle => {
                const docRef = db.collection("players").doc(handle);
                deleteBatch.delete(docRef);
            });
            await deleteBatch.commit();
            console.log(`Successfully deleted ${playersToDelete.length} old player(s).`);
        }

        const playersUpsertBatch = db.batch();
        playersRaw.forEach(player => {
            if (player.player_handle) {
                const docRef = db.collection("players").doc(player.player_handle);
                const playerData = {
                    player_handle: player.player_handle,
                    current_team_id: player.current_team_id,
                    player_status: player.player_status || 'ACTIVE',
                    games_played: parseNumber(player.games_played),
                    REL: parseNumber(player.rel_median),
                    WAR: parseNumber(player.WAR),
                    GEM: parseNumber(player.GEM),
                    rookie: player.rookie || '0',
                    all_star: player.all_star || '0',
                    total_points: parseNumber(player.total_points),
                    aag_mean: parseNumber(player.aag_mean),
                    aag_median: parseNumber(player.aag_median),
                };
                playersUpsertBatch.set(docRef, playerData, { merge: true });
            }
        });
        await playersUpsertBatch.commit();
        console.log(`Successfully synced (upserted) ${playersRaw.length} players.`);


        // --- Step 4: Sync draftPicks collection ---
        const picksBatch = db.batch();
        draftPicksRaw.forEach(pick => {
            if (pick.pick_id) {
                const docRef = db.collection("draftPicks").doc(pick.pick_id);
                // Convert all relevant fields
                const pickData = { ...pick };
                pickData.season = parseNumber(pick.season);
                pickData.round = parseNumber(pick.round);
                picksBatch.set(docRef, pickData, { merge: true });
            }
        });
        await picksBatch.commit();
        console.log(`Successfully synced ${draftPicksRaw.length} draft picks.`);


        // --- Step 5: Sync Schedule collection ---
        const scheduleBatch = db.batch();
        scheduleRaw.forEach(game => {
            if (game.date && game.team1_id && game.team2_id) {
                const gameId = `S${game.season}_W${game.week}_${game.team1_id}_vs_${game.team2_id}`;
                const docRef = db.collection("schedule").doc(gameId);
                const gameData = { ...game };
                // Add an array of teams for easier querying later
                gameData.teams_in_game = [game.team1_id, game.team2_id]; 
                gameData.week = parseNumber(game.week);
                gameData.season = parseNumber(game.season);
                gameData.team1_score = parseNumber(game.team1_score);
                gameData.team2_score = parseNumber(game.team2_score);
                scheduleBatch.set(docRef, gameData, { merge: true });
            }
        });
        await scheduleBatch.commit();
        console.log(`Successfully synced ${scheduleRaw.length} schedule games.`);


        // --- Step 6: Sync Lineups collection ---
        const lineupsBatch = db.batch();
        lineupsRaw.forEach(lineup => {
            if (lineup.date && lineup.player_handle && lineup.team_id) {
                const lineupId = `${lineup.date}_${lineup.team_id}_${lineup.player_handle}`;
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


        // --- Step 7: Sync Weekly Averages collection ---
        const weeklyAveragesBatch = db.batch();
        weeklyAveragesRaw.forEach(week => {
            if (week.date) {
                const docRef = db.collection("weeklyAverages").doc(week.date);
                const weekData = { ...week };
                weekData.week = parseNumber(week.week);
                weekData.mean_score = parseNumber(week.mean_score);
                weekData.median_score = parseNumber(week.median_score);
                weeklyAveragesBatch.set(docRef, weekData, { merge: true });
            }
        });
        await weeklyAveragesBatch.commit();
        console.log(`Successfully synced ${weeklyAveragesRaw.length} weekly averages.`);

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