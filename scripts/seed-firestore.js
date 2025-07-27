// /scripts/seed-firestore.js

const admin = require("firebase-admin");
const fetch = require("node-fetch");

// Initialize the Firebase Admin SDK. It will automatically connect to running emulators.
admin.initializeApp({
    projectId: "real-karma-league",
});

const db = admin.firestore();

const SPREADSHEET_ID = "12EembQnztbdKx2-buv00--VDkEFSTuSXTRdOnTnRxq4";
const BASE_URL = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=`;

// --- Helper Functions to get data from Google Sheets ---
async function fetchSheetData(sheetName) {
    try {
        console.log(`Fetching sheet: ${sheetName}...`);
        const response = await fetch(BASE_URL + encodeURIComponent(sheetName));
        if (!response.ok) throw new Error(`Failed to fetch sheet: ${sheetName}`);
        const csvText = await response.text();
        return parseCSV(csvText);
    } catch (error) {
        console.error(error);
        return [];
    }
}

/**
 * Parses a CSV string into an array of objects.
 * This version is enhanced to handle quoted values containing commas.
 * @param {string} csvText The raw CSV text to parse.
 * @returns {Array<Object>} An array of objects representing the CSV rows.
 */
function parseCSV(csvText) {
    // Filter out any blank lines.
    const lines = csvText.trim().split('\n').filter(line => line.trim() !== '');
    if (lines.length === 0) {
        return [];
    }
    const headerLine = lines.shift();
    // Clean headers of any quotes and extra whitespace.
    const headers = headerLine.split(',').map(h => h.replace(/"/g, '').trim());
    const data = lines.map(line => {
        // This regex correctly handles values that might be wrapped in quotes.
        const values = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || [];
        const row = {};
        for (let i = 0; i < headers.length; i++) {
            if (headers[i]) {
                // Clean the value of surrounding quotes and whitespace.
                const value = (values[i] || '').replace(/"/g, '').trim();
                row[headers[i]] = value;
            }
        }
        return row;
    });
    return data;
}


// --- Main Seeding Function ---
async function seedDatabase() {
    console.log("Starting database seed process...");

    const [
        playersData,
        teamsData,
        scheduleData,
        draftPicksData,
        postScheduleData,
        lineupsData, // Regular Season
        postLineupsData // Postseason
    ] = await Promise.all([
        fetchSheetData("Players"),
        fetchSheetData("Teams"),
        fetchSheetData("Schedule"),
        fetchSheetData("Draft_Capital"),
        fetchSheetData("Post_Schedule"),
        fetchSheetData("Lineups"),
        fetchSheetData("Post_Lineups"),
    ]);

    // --- Create a Game ID Lookup Map ---
    console.log("Creating game ID lookup map...");
    const gameIdLookup = new Map();
    const allScheduleData = [...scheduleData, ...postScheduleData];

    allScheduleData.forEach(game => {
        if (game.date && game.team1_id && game.team2_id) {
            const gameId = `${game.date}-${game.team1_id}-${game.team2_id}`.replace(/\//g, "-");
            const key1 = `${game.date}-${game.team1_id}`;
            const key2 = `${game.date}-${game.team2_id}`;
            gameIdLookup.set(key1, gameId);
            gameIdLookup.set(key2, gameId);
        }
    });
    console.log(`  -> Game ID lookup map created with ${gameIdLookup.size} entries.`);

    // --- Seed 'seasons' collection with games and lineups ---
    const seasonRef = db.collection("seasons").doc("S7");
    await seasonRef.set({ season_name: "Season 7", status: "active" });
    console.log("Seeding games into /seasons/S7...");

    const gamesBatch = db.batch();
    const gamesCollectionRef = seasonRef.collection("games");
    scheduleData.forEach(game => {
        const gameId = `${game.date}-${game.team1_id}-${game.team2_id}`.replace(/\//g, "-");
        gamesBatch.set(gamesCollectionRef.doc(gameId), game);
    });
    const postGamesCollectionRef = seasonRef.collection("post_games");
    postScheduleData.forEach(game => {
        const gameId = `${game.date}-${game.team1_id}-${game.team2_id}`.replace(/\//g, "-");
        gamesBatch.set(postGamesCollectionRef.doc(gameId), game);
    });
    await gamesBatch.commit();
    console.log(`  -> Seeded ${scheduleData.length} regular season and ${postScheduleData.length} postseason games.`);

    console.log("Seeding lineups into /seasons/S7/lineups...");
    const lineupsBatch = db.batch();
    const lineupsCollectionRef = seasonRef.collection("lineups");
    lineupsData.forEach(lineup => {
        const lookupKey = `${lineup.date}-${lineup.team_id}`;
        const gameId = gameIdLookup.get(lookupKey);

        if (gameId && lineup.player_id) {
            lineup.game_id = gameId;
            lineup.game_type = "regular"; // Add game_type field
            const lineupId = `${gameId}-${lineup.player_id}`;
            lineupsBatch.set(lineupsCollectionRef.doc(lineupId), lineup);
        }
    });
    postLineupsData.forEach(lineup => {
        const lookupKey = `${lineup.date}-${lineup.team_id}`;
        const gameId = gameIdLookup.get(lookupKey);

        if (gameId && lineup.player_id) {
            lineup.game_id = gameId;
            lineup.game_type = "postseason"; // Add game_type field
            const lineupId = `${gameId}-${lineup.player_id}`;
            lineupsBatch.set(lineupsCollectionRef.doc(lineupId), lineup);
        }
    });
    await lineupsBatch.commit();
    console.log(`  -> Seeded ${lineupsData.length + postLineupsData.length} total lineups.`);


    // Seed 'v2_teams' Collection with subcollections
    console.log("Seeding 'v2_teams' collection with seasonal subcollections...");
    const teamsBatch = db.batch();
    teamsData.forEach(team => {
        if (team.team_id) {
            const teamDocRef = db.collection("v2_teams").doc(team.team_id);
            const staticData = {
                team_name: team.team_name,
                conference: team.conference,
                current_gm_handle: team.current_gm_handle,
                gm_uid: team.gm_uid
            };
            teamsBatch.set(teamDocRef, staticData);

            // Create the seasonal record subcollection
            const seasonRecordRef = teamDocRef.collection("seasonal_records").doc("S7");
            const seasonalData = {
                wins: parseInt(team.wins) || 0,
                losses: parseInt(team.losses) || 0,
                ties: 0 // Assuming ties start at 0
            };
            teamsBatch.set(seasonRecordRef, seasonalData);
        }
    });
    await teamsBatch.commit();
    console.log(`  -> Seeded ${teamsData.length} teams into /v2_teams`);

    // Seed 'v2_players' Collection with subcollections
    console.log("Seeding 'v2_players' collection with seasonal subcollections...");
    const playersBatch = db.batch();
    playersData.forEach(player => {
        if (player.player_id) {
            const playerDocRef = db.collection("v2_players").doc(player.player_id);
            // Static data from your Google Doc
            const staticData = {
                player_handle: player.player_handle,
                player_status: player.player_status,
                rookie: player.rookie,
                all_star: player.all_star,
                current_team_id: player.current_team_id // Still useful at the top level
            };
            playersBatch.set(playerDocRef, staticData);

            // Seasonal stats subcollection
            const seasonStatsRef = playerDocRef.collection("seasonal_stats").doc("S7");
            const seasonalData = {
                games_played: parseInt(player.games_played) || 0,
                total_points: parseFloat(player.total_points) || 0,
                aag_mean: parseFloat(player.aag_mean) || 0,
                aag_median: parseFloat(player.aag_median) || 0,
                GEM: parseFloat(player.GEM) || 0,
                REL: parseFloat(player.REL) || 0,
                WAR: parseFloat(player.WAR) || 0
            };
            playersBatch.set(seasonStatsRef, seasonalData);
        }
    });
    await playersBatch.commit();
    console.log(`  -> Seeded ${playersData.length} players into /v2_players`);


    // Seed 'draftPicks' Collection
    console.log("Seeding 'draftPicks' collection...");
    const draftPicksBatch = db.batch();
    draftPicksData.forEach(pick => {
        if (pick.pick_id) {
            const pickDocRef = db.collection("draftPicks").doc(pick.pick_id);
            draftPicksBatch.set(pickDocRef, pick);
        }
    });
    await draftPicksBatch.commit();
    console.log(`  -> Seeded ${draftPicksData.length} draft picks into /draftPicks`);


    console.log("✅ Database seeding complete!");
}

// --- Run the Seeding Script ---
seedDatabase().catch(console.error);