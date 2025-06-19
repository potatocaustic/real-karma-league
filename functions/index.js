const functions = require("firebase-functions");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

admin.initializeApp();
const db = admin.firestore();

// A simple CSV parser function to handle Google's gviz output
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

// Helper to ensure values from the sheet are stored as numbers
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

        const [playersRaw, draftPicksRaw, teamsRaw] = await Promise.all([
            fetchAndParseSheet("Players"),
            fetchAndParseSheet("Draft_Capital"),
            fetchAndParseSheet("Teams")
        ]);

        // 1. Sync Teams (no changes to this part)
        const excludedTeams = ["FREE_AGENT", "RETIRED", "EAST", "WEST", "EGM", "WGM", "RSE", "RSW"];
        const teamsBatch = db.batch();
        let syncedTeamCount = 0;
        teamsRaw.forEach(team => {
            if (team.team_id && !excludedTeams.includes(team.team_id.toUpperCase())) {
                const docRef = db.collection("teams").doc(team.team_id);
                const teamData = { /* ... team data ... */ };
                teamsBatch.set(docRef, teamData, { merge: true });
                syncedTeamCount++;
            }
        });
        await teamsBatch.commit();
        console.log(`Successfully synced ${syncedTeamCount} teams.`);
        
        // 2. Process and Sync Players (UPDATED LOGIC)
        // Step A: Get all player handles from the Google Sheet
        const sheetPlayerHandles = new Set(playersRaw.map(p => p.player_handle).filter(Boolean));

        // Step B: Get all player document IDs from Firestore to compare
        const firestorePlayersSnap = await db.collection("players").get();
        const firestorePlayerHandles = new Set(firestorePlayersSnap.docs.map(doc => doc.id));
        
        // Step C: Determine which players to delete (in Firestore but not in the Sheet)
        const playersToDelete = [...firestorePlayerHandles].filter(handle => !sheetPlayerHandles.has(handle));

        // Step D: Batch delete the orphaned players if any exist
        if (playersToDelete.length > 0) {
            const deleteBatch = db.batch();
            playersToDelete.forEach(handle => {
                const docRef = db.collection("players").doc(handle);
                deleteBatch.delete(docRef);
            });
            await deleteBatch.commit();
            console.log(`Successfully deleted ${playersToDelete.length} old player(s).`);
        } else {
            console.log("No old players found to delete.");
        }

        // Step E: Batch upsert current players from the sheet (your existing logic)
        const playersUpsertBatch = db.batch();
        playersRaw.forEach(player => {
            if (player.player_handle) {
                const docRef = db.collection("players").doc(player.player_handle);
                const playerData = {
                    current_team_id: player.current_team_id || '',
                    player_handle: player.player_handle || '',
                    games_played: parseNumber(player.games_played),
                    REL: parseNumber(player.rel_median),
                    WAR: parseNumber(player.WAR)
                };
                playersUpsertBatch.set(docRef, playerData, { merge: true });
            }
        });
        await playersUpsertBatch.commit();
        console.log(`Successfully synced (upserted) ${playersRaw.length} players.`);

        // 3. Process and Sync Draft Picks (no changes to this part)
        const picksBatch = db.batch();
        draftPicksRaw.forEach(pick => {
            if (pick.pick_id) {
                const docRef = db.collection("draftPicks").doc(pick.pick_id);
                const pickData = { ...pick };
                pickData.season = parseNumber(pick.season);
                pickData.round = parseNumber(pick.round);
                picksBatch.set(docRef, pickData, { merge: true });
            }
        });
        await picksBatch.commit();
        console.log(`Successfully synced ${draftPicksRaw.length} draft picks.`);

        res.status(200).send("Sync completed successfully, including deletion of old players!");

    } catch (error) {
        console.error("Error during sync:", error);
        res.status(500).send("Sync failed. Check function logs for details.");
    }
});


// --- Your other functions (clearAllTradeBlocks, etc.) remain the same ---
exports.clearAllTradeBlocks = functions.https.onCall(async (data, context) => {
    // ...
});

exports.reopenTradeBlocks = functions.https.onCall(async (data, context) => {
    // ...
});