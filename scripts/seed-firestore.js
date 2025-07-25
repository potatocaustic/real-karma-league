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

function parseCSV(csvText) {
    const lines = csvText.trim().split("\n");
    const headerLine = lines.shift();
    // Clean headers of any quotes and extra whitespace.
    const headers = headerLine.split(',').map(h => h.replace(/"/g, '').trim());
    return lines.map(line => {
        const values = line.split(',').map(v => v.replace(/"/g, '').trim());
        const row = {};
        headers.forEach((header, index) => {
            if (header) row[header] = values[index] || "";
        });
        return row;
    });
}

// --- Main Seeding Function ---
async function seedDatabase() {
    console.log("Starting database seed process...");

    // 1. Fetch all data from Google Sheets
    const [playersData, teamsData, scheduleData, draftPicksData] = await Promise.all([
        fetchSheetData("Players"),
        fetchSheetData("Teams"),
        fetchSheetData("Schedule"),
        fetchSheetData("Draft_Capital"), // ADDED
    ]);

    // 2. Seed 'seasons' collection and its 'games' subcollection
    console.log("Seeding 'seasons' collection and games subcollection for S7...");
    const seasonRef = db.collection("seasons").doc("S7");
    await seasonRef.set({
        season_name: "Season 7",
        status: "active",
    });

    const gamesBatch = db.batch();
    const gamesCollectionRef = seasonRef.collection("games");
    scheduleData.forEach(game => {
        // Create a unique ID for each game
        const gameId = `${game.date}-${game.team1_id}-${game.team2_id}`.replace(/\//g, "-");
        const gameDocRef = gamesCollectionRef.doc(gameId);
        gamesBatch.set(gameDocRef, game);
    });
    await gamesBatch.commit();
    console.log(`  -> Seeded ${scheduleData.length} games into /seasons/S7/games`);

    // 3. Seed 'new_teams' Collection
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

    // 4. Seed 'new_players' Collection
    console.log("Seeding 'new_players' collection...");
    const playersBatch = db.batch();
    playersData.forEach(player => {
        if (player.player_handle) {
            const playerDocRef = db.collection("new_players").doc(player.player_handle);
            playersBatch.set(playerDocRef, player);
        }
    });
    await playersBatch.commit();
    console.log(`  -> Seeded ${playersData.length} players into /new_players`);

    // 5. Seed 'draftPicks' Collection (NEWLY ADDED)
    console.log("Seeding 'draftPicks' collection...");
    const draftPicksBatch = db.batch();
    draftPicksData.forEach(pick => {
        if (pick.pick_id) { // Use pick_id as the document key
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