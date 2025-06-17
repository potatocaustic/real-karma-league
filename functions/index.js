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

        // 1. Process and Sync Teams
        const teamsBatch = db.batch();
        teamsRaw.forEach(team => {
            if (team.team_id) {
                const docRef = db.collection("teams").doc(team.team_id);
                const teamData = {
                    team_id: team.team_id || '',
                    team_name: team.team_name || '',
                    gm_uid: team.gm_uid || '',
                    gm_handle: team.gm_handle || '',
                    wins: parseNumber(team.wins),
                    losses: parseNumber(team.losses)
                };
                teamsBatch.set(docRef, teamData, { merge: true });
            }
        });
        await teamsBatch.commit();
        console.log(`Successfully synced ${teamsRaw.length} teams.`);
        
        // 2. Process and Sync Players
        const playersBatch = db.batch();
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
                playersBatch.set(docRef, playerData, { merge: true });
            }
        });
        await playersBatch.commit();
        console.log(`Successfully synced ${playersRaw.length} players.`);

        // 3. Process and Sync Draft Picks
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

        res.status(200).send("Sync completed successfully for teams, players, and picks!");

    } catch (error) {
        console.error("Error during sync:", error);
        res.status(500).send("Sync failed. Check function logs for details.");
    }
});


// --- NEW: Callable Function to clear all trade blocks ---
exports.clearAllTradeBlocks = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const adminDoc = await db.collection('admins').doc(context.auth.uid).get();
    if (!adminDoc.exists) {
        throw new functions.https.HttpsError('permission-denied', 'Only an admin can perform this action.');
    }

    const tradeBlocksSnap = await db.collection('tradeblocks').get();
    const settingsRef = db.collection('settings').doc('tradeBlock');
    
    // Set the deadline status to "closed"
    await settingsRef.set({ status: 'closed' });

    if (tradeBlocksSnap.empty) {
        return { message: 'Trade blocks were already empty. Deadline is now active.' };
    }

    const batch = db.batch();
    tradeBlocksSnap.docs.forEach(doc => {
        batch.delete(doc.ref);
    });
    
    await batch.commit();
    return { message: `Successfully deleted ${tradeBlocksSnap.size} trade blocks and activated deadline.` };
});

// --- NEW: Callable Function to re-open the trade block ---
exports.reopenTradeBlocks = functions.https.onCall(async (data, context) => {
    if (!context.auth || !(await db.collection('admins').doc(context.auth.uid).get()).exists) {
        throw new functions.https.HttpsError('permission-denied', 'Only an admin can perform this action.');
    }
    
    await db.collection('settings').doc('tradeBlock').set({ status: 'open' });
    return { message: 'Trade blocks have been re-opened.' };
});