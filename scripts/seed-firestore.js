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

    const [
        playersData,
        teamsData,
        scheduleData,
        draftPicksData,
        postScheduleData, // ADDED
        lineupsData,      // ADDED
        postLineupsData   // ADDED
    ] = await Promise.all([
        fetchSheetData("Players"),
        fetchSheetData("Teams"),
        fetchSheetData("Schedule"),
        fetchSheetData("Draft_Capital"),
        fetchSheetData("Post_Schedule"), // ADDED
        fetchSheetData("Lineups"),       // ADDED
        fetchSheetData("Post_Lineups")   // ADDED
    ]);

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

    // ADDED: Seed Postseason Games
    console.log("Seeding postseason games...");
    const postGamesBatch = db.batch();
    const postGamesCollectionRef = seasonRef.collection("post_games"); // New subcollection
    postScheduleData.forEach(game => {
        const gameId = `${game.date}-${game.team1_id}-${game.team2_id}`.replace(/\//g, "-");
        postGamesBatch.set(postGamesCollectionRef.doc(gameId), game);
    });
    await postGamesBatch.commit();
    console.log(`  -> Seeded ${postScheduleData.length} postseason games.`);

    // ADDED: Seed Lineups
    console.log("Seeding lineups...");
    const lineupsBatch = db.batch();
    const lineupsCollectionRef = db.collection("lineups"); // New top-level collection
    lineupsData.forEach(lineup => {
        const lineupId = `${lineup.date}-${lineup.player_handle}`.replace(/\//g, "-");
        lineupsBatch.set(lineupsCollectionRef.doc(lineupId), lineup);
    });
    await lineupsBatch.commit();
    console.log(`  -> Seeded ${lineupsData.length} regular season lineups.`);

    // ADDED: Seed Postseason Lineups
    console.log("Seeding postseason lineups...");
    const postLineupsBatch = db.batch();
    const postLineupsCollectionRef = db.collection("post_lineups"); // New top-level collection
    postLineupsData.forEach(lineup => {
        const lineupId = `${lineup.date}-${lineup.player_handle}`.replace(/\//g, "-");
        postLineupsBatch.set(postLineupsCollectionRef.doc(lineupId), lineup);
    });
    await postLineupsBatch.commit();
    console.log(`  -> Seeded ${postLineupsData.length} postseason lineups.`);

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

    // 4. Seed 'new_players' Collection (### THIS IS THE UPDATED LOGIC ###)
    console.log("Seeding 'new_players' collection...");
    const playersBatch = db.batch();
    playersData.forEach(player => {
        // Use the stable 'player_id' as the document ID
        if (player.player_id) {
            const playerDocRef = db.collection("new_players").doc(player.player_id);
            // The player_handle is now just a field within the document
            playersBatch.set(playerDocRef, player);
        }
    });
    await playersBatch.commit();
    console.log(`  -> Seeded ${playersData.length} players into /new_players`);


    // 5. Seed 'draftPicks' Collection
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