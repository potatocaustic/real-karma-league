// /scripts/seed-firestore.js

const admin = require("firebase-admin");
const fetch = require("node-fetch");

// Initialize the Firebase Admin SDK.
admin.initializeApp({
    projectId: "real-karma-league",
});

const db = admin.firestore();

const SPREADSHEET_ID = "12EembQnztbdKx2-buv00--VDkEFSTuSXTRdOnTnRxq4";
const BASE_URL = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=`;

// --- Helper Functions ---

/**
 * Fetches data from a Google Sheet.
 * @param {string} sheetName The name of the sheet to fetch.
 * @returns {Promise<Array<Object>>} A promise that resolves to an array of row objects.
 */
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
 * A robust CSV parser that correctly handles quoted fields containing commas.
 * @param {string} csvText The raw CSV text to parse.
 * @returns {Array<Object>} An array of objects representing the rows.
 */
function parseCSV(csvText) {
    const lines = csvText.trim().replace(/\r/g, "").split("\n");
    const headerLine = lines.shift();
    // Clean headers of any quotes and extra whitespace.
    const headers = headerLine.split(',').map(h => h.replace(/"/g, '').trim());

    // This regex matches comma-separated values, including quoted strings.
    const csvRegex = /("([^"]*)"|([^,]*)),?/g;

    return lines.map(line => {
        const row = {};
        let match;
        let i = 0;
        // Use the regex to pull out each value correctly.
        while ((match = csvRegex.exec(line))) {
            // The value is either in the 2nd capture group (for quoted) or 3rd (for unquoted).
            const value = (match[2] !== undefined ? match[2] : match[3] || "").trim();
            if (headers[i]) {
                row[headers[i]] = value;
            }
            i++;
        }
        return row;
    });
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

    // Create a Game ID Lookup Map
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


    // --- MODIFIED & FIXED: Seed Lineups ---
    console.log("Seeding and cleaning lineups...");
    const lineupsBatch = db.batch();
    const lineupsCollectionRef = db.collection("lineups");
    let seededLineupsCount = 0;
    lineupsData.forEach(lineup => {
        const lookupKey = `${lineup.date}-${lineup.team_id}`;
        const gameId = gameIdLookup.get(lookupKey);

        if (gameId && lineup.player_id) {
            lineup.game_id = gameId;
            const lineupId = `${gameId}-${lineup.player_id}`;

            // Clean and transform the data before setting it
            const cleanedLineup = {
                ...lineup,
                raw_score: parseFloat(String(lineup.points_raw || '0').replace(/,/g, '')) || 0,
                global_rank: parseInt(String(lineup.global_rank || '0').replace(/,/g, ''), 10) || 0,
                adjustments: 0, // Old data doesn't have this, so default to 0
                started: lineup.started === 'TRUE' ? 'TRUE' : 'FALSE',
                is_captain: lineup.is_captain === 'TRUE' ? 'TRUE' : 'FALSE'
            };
            // Remove the old, unneeded field
            delete cleanedLineup.points_raw;

            lineupsBatch.set(lineupsCollectionRef.doc(lineupId), cleanedLineup);
            seededLineupsCount++;
        }
    });
    await lineupsBatch.commit();
    console.log(`  -> Seeded and cleaned ${seededLineupsCount} regular season lineups.`);

    // --- MODIFIED & FIXED: Seed Postseason Lineups ---
    console.log("Seeding and cleaning postseason lineups...");
    const postLineupsBatch = db.batch();
    const postLineupsCollectionRef = db.collection("post_lineups");
    let seededPostLineupsCount = 0;
    postLineupsData.forEach(lineup => {
        const lookupKey = `${lineup.date}-${lineup.team_id}`;
        const gameId = gameIdLookup.get(lookupKey);

        if (gameId && lineup.player_id) {
            lineup.game_id = gameId;
            const lineupId = `${gameId}-${lineup.player_id}`;

            // Clean and transform the data
            const cleanedLineup = {
                ...lineup,
                raw_score: parseFloat(String(lineup.points_raw || '0').replace(/,/g, '')) || 0,
                global_rank: parseInt(String(lineup.global_rank || '0').replace(/,/g, ''), 10) || 0,
                adjustments: 0,
                started: lineup.started === 'TRUE' ? 'TRUE' : 'FALSE',
                is_captain: lineup.is_captain === 'TRUE' ? 'TRUE' : 'FALSE'
            };
            delete cleanedLineup.points_raw;

            postLineupsBatch.set(postLineupsCollectionRef.doc(lineupId), cleanedLineup);
            seededPostLineupsCount++;
        }
    });
    await postLineupsBatch.commit();
    console.log(`  -> Seeded and cleaned ${seededPostLineupsCount} postseason lineups.`);

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