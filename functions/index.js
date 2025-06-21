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
                const docRef = db.collection("transaction_log").doc(transaction.transaction_id); 
                transactionsBatch.set(docRef, transaction, { merge: true });
            }
        });
        await transactionsBatch.commit();
        console.log(`Successfully synced ${transactionsLogRaw.length} transaction log entries.`);

        console.log("Calculating transaction counts for all teams...");
        const allTeamsForCount = await db.collection("teams").get();
        const allTransactionsForCount = await db.collection("transaction_log").get();

        const transactionCountMap = new Map();
        allTransactionsForCount.docs.forEach(doc => {
            const t = doc.data();
            const notes = t.notes ? t.notes.toLowerCase() : '';
            // Skip irrelevant transactions
            if (notes.includes('pre-database') || notes.includes('preseason') || !t.transaction_id) {
                return;
            }

            const involvedTeams = new Set();
            if (t.from_team) involvedTeams.add(t.from_team);
            if (t.to_team) involvedTeams.add(t.to_team);

            involvedTeams.forEach(teamId => {
                if (!transactionCountMap.has(teamId)) {
                    transactionCountMap.set(teamId, new Set());
                }
                transactionCountMap.get(teamId).add(t.transaction_id);
            });
        });

        const teamUpdateBatch = db.batch();
        allTeamsForCount.docs.forEach(doc => {
            const teamId = doc.id;
            const count = transactionCountMap.has(teamId) ? transactionCountMap.get(teamId).size : 0;
            teamUpdateBatch.update(doc.ref, { calculated_total_transactions: count });
        });

        await teamUpdateBatch.commit();
        console.log(`Successfully updated transaction counts for ${allTeamsForCount.size} teams.`);        

        res.status(200).send("Firestore sync completed successfully!");

    } catch (error) {
        console.error("Error during sync:", error);
        res.status(500).send("Sync failed. Check function logs for details.");
    }
});


// --- NEW, EFFICIENT FUNCTION TO GET ALL DATA FOR THE TEAM PAGE ---
exports.getTeamPageData = functions.https.onCall(async (data, context) => {
    const teamId = data.teamId;
    if (!teamId) {
        throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a "teamId".');
    }

    try {
        // 1. Fetch the primary team data directly
        const teamDoc = await db.collection('teams').doc(teamId).get();
        if (!teamDoc.exists) {
            throw new functions.https.HttpsError('not-found', 'Team not found.');
        }
        const teamData = teamDoc.data();

        // 2. Fetch only the players on that team
        const playersSnapshot = await db.collection('players').where('current_team_id', '==', teamId).where('player_status', '==', 'ACTIVE').get();
        const roster = playersSnapshot.docs.map(doc => doc.data());

        // 3. Fetch only the schedule for that team
        const scheduleSnapshot = await db.collection('schedule').where('teams_in_game', 'array-contains', teamId).get();
        const schedule = scheduleSnapshot.docs.map(doc => doc.data());

        // 4. Fetch only the draft picks owned by that team
        const draftPicksSnapshot = await db.collection('draft_capital').where('current_owner', '==', teamId).get();
        const draftPicks = draftPicksSnapshot.docs.map(doc => doc.data());
        
        // 5. Fetch all teams and transaction log for context (names, records, stats)
        const allTeamsSnapshot = await db.collection('teams').get();
        const allTeams = allTeamsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // 6. Helper function to calculate rankings on the server
        const calculateTeamRankings = (currentTeam, allTeamsData) => {
            const rankings = {};
            const activeTeams = allTeamsData.filter(t => t.team_id && t.team_id.toUpperCase() !== 'RETIRED' && t.conference);
            
            // Conference Rank (Record)
            const conferenceTeams = activeTeams.filter(t => t.conference === currentTeam.conference)
              .sort((a, b) => {
                const winsA = parseInt(a.wins || 0);
                const winsB = parseInt(b.wins || 0);
                if (winsB !== winsA) return winsB - winsA;
                return parseFloat(b.pam || 0) - parseFloat(a.pam || 0);
              });
            rankings.record = conferenceTeams.findIndex(t => t.team_id === currentTeam.team_id) + 1;
            
            // Overall Rank (PAM)
            const pamTeams = [...activeTeams].sort((a, b) => parseFloat(b.pam || 0) - parseFloat(a.pam || 0));
            rankings.pam = pamTeams.findIndex(t => t.team_id === currentTeam.team_id) + 1;
            
            // Overall Rank (Median Starter Rank)
            const medRankTeams = activeTeams.filter(t => parseFloat(t.med_starter_rank || 0) > 0)
              .sort((a, b) => parseFloat(a.med_starter_rank || 999) - parseFloat(b.med_starter_rank || 999));
            const medRankIndex = medRankTeams.findIndex(t => t.team_id === currentTeam.team_id);
            rankings.medRank = medRankIndex !== -1 ? medRankIndex + 1 : 0;
            
            return rankings;
        };

        // 8. Perform calculations and add them to the data
        const rankings = calculateTeamRankings(teamData, allTeams);

        // 9. Assemble the final payload
        const payload = {
            teamData,
            roster,
            schedule,
            draftPicks,
            allTeams,
            rankings,
        };

        return payload;

    } catch (error) {
        console.error("Error fetching team page data:", error);
        throw new functions.https.HttpsError('internal', 'Could not fetch team page data.', error);
    }
});

// Add this new function to your functions/index.js file

exports.getGameDetails = functions.https.onCall(async (data, context) => {
    const { team1Id, team2Id, date } = data;
    if (!team1Id || !team2Id || !date) {
        throw new functions.https.HttpsError('invalid-argument', 'Missing required parameters.');
    }

    try {
        const lineupsSnapshot = await db.collection('lineups')
            .where('date', '==', date)
            .where('team_id', 'in', [team1Id, team2Id])
            .where('started', '==', 'TRUE')
            .get();

        const lineups = lineupsSnapshot.docs.map(doc => doc.data());

        // Also fetch player details to show all-star/rookie badges in the modal
        const playerHandles = lineups.map(l => l.player_handle);
        const players = {};
        if (playerHandles.length > 0) {
            const playersSnapshot = await db.collection('players').where('player_handle', 'in', playerHandles).get();
            playersSnapshot.forEach(doc => {
                players[doc.id] = doc.data();
            });
        }
        
        return { lineups, players };

    } catch (error) {
        console.error("Error fetching game details:", error);
        throw new functions.https.HttpsError('internal', 'Could not fetch game details.');
    }
});

// --- Your other functions for the trade block remain unchanged ---
exports.clearAllTradeBlocks = functions.https.onCall(async (data, context) => {
    // ... your existing implementation
    console.log("Clearing all trade blocks. (Placeholder)");
    return { status: "success", message: "All trade blocks cleared." };
});

exports.reopenTradeBlocks = functions.https.onCall(async (data, context) => {
    // ... your existing implementation
    console.log("Reopening trade blocks. (Placeholder)");
    return { status: "success", message: "Trade blocks reopened." };
});