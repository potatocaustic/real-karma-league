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
        lineupsData,
        postLineupsData
    ] = await Promise.all([
        fetchSheetData("Players"),
        fetchSheetData("Teams"),
        fetchSheetData("Schedule"),
        fetchSheetData("Draft_Capital"),
        fetchSheetData("Post_Schedule"),
        fetchSheetData("Lineups"),
        fetchSheetData("Post_Lineups")
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


    // Seed 'seasons' and 'games' (Regular Season)
    console.log("Seeding regular season games...");
    const seasonRef = db.collection("seasons").doc("S7");
    await seasonRef.set({ season_name: "Season 7", status: "active" });
    const gamesBatch = db.batch();
    const gamesCollectionRef = seasonRef.collection("games");
    scheduleData.forEach(game => {
        const gameId = `${game.date}-${game.team1_id}-${game.team2_id}`.replace(/\//g, "-");
        gamesBatch.set(gamesCollectionRef.doc(gameId), game);
    });
    await gamesBatch.commit();
    console.log(`  -> Seeded ${scheduleData.length} regular season games.`);

    // Seed Postseason Games
    console.log("Seeding postseason games...");
    const postGamesBatch = db.batch();
    const postGamesCollectionRef = seasonRef.collection("post_games");
    postScheduleData.forEach(game => {
        const gameId = `${game.date}-${game.team1_id}-${game.team2_id}`.replace(/\//g, "-");
        postGamesBatch.set(postGamesCollectionRef.doc(gameId), game);
    });
    await postGamesBatch.commit();
    console.log(`  -> Seeded ${postScheduleData.length} postseason games.`);


    // --- MODIFIED: Seed Lineups ---
    console.log("Seeding lineups...");
    const lineupsBatch = db.batch();
    const lineupsCollectionRef = db.collection("lineups");
    lineupsData.forEach(lineup => {
        const lookupKey = `${lineup.date}-${lineup.team_id}`;
        const gameId = gameIdLookup.get(lookupKey);

        if (gameId && lineup.player_id) {
            lineup.game_id = gameId;
            const lineupId = `${gameId}-${lineup.player_id}`;
            lineupsBatch.set(lineupsCollectionRef.doc(lineupId), lineup);
        }
    });
    await lineupsBatch.commit();
    console.log(`  -> Seeded ${lineupsData.length} regular season lineups.`);

    // --- MODIFIED: Seed Postseason Lineups ---
    console.log("Seeding postseason lineups...");
    const postLineupsBatch = db.batch();
    const postLineupsCollectionRef = db.collection("post_lineups");
    postLineupsData.forEach(lineup => {
        const lookupKey = `${lineup.date}-${lineup.team_id}`;
        const gameId = gameIdLookup.get(lookupKey);

        if (gameId && lineup.player_id) {
            lineup.game_id = gameId;
            const lineupId = `${gameId}-${lineup.player_id}`;
            postLineupsBatch.set(postLineupsCollectionRef.doc(lineupId), lineup);
        }
    });
    await postLineupsBatch.commit();
    console.log(`  -> Seeded ${postLineupsData.length} postseason lineups.`);

    // Seed 'new_teams' Collection
    console.log("Seeding 'new_teams' collection...");
    const teamsBatch = db.batch();
    teamsData.forEach(team => {
        if (team.team_id) {
            const teamDocRef = db.collection("new_teams").doc(team.team_id);
            teamsBatch.set(teamDocRef, team);
        }
    });
    await teamsBatch.commit();
    console.log(`  -> Seeded ${teamsData.length} teams into /new_teams`);

    // Seed 'new_players' Collection
    console.log("Seeding 'new_players' collection...");
    const playersBatch = db.batch();
    playersData.forEach(player => {
        if (player.player_id) {
            const playerDocRef = db.collection("new_players").doc(player.player_id);
            playersBatch.set(playerDocRef, player);
        }
    });
    await playersBatch.commit();
    console.log(`  -> Seeded ${playersData.length} players into /new_players`);


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