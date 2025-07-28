// index.js

const { onDocumentUpdated, onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onRequest, onCall } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore"); // Import FieldValue directly
const fetch = require("node-fetch");

admin.initializeApp();
const db = admin.firestore();

// ===================================================================
// NEW: Functions for the Admin Portal (Feature Branch)
// These functions operate ONLY on the new data structures.
// ===================================================================

/**
 * Triggered when a transaction is created in the new admin portal.
 * Updates player and draft pick ownership based on the transaction type.
 */
exports.onTransactionCreate = onDocumentCreated("transactions/{transactionId}", async (event) => {
    const transaction = event.data.data();
    const transactionId = event.params.transactionId;
    console.log(`NEW: Processing transaction ${transactionId} of type: ${transaction.type}`);

    const batch = db.batch();

    try {
        if (transaction.type === 'SIGN') {
            const playerMove = transaction.involved_players[0];
            const playerRef = db.collection('new_players').doc(playerMove.id);
            batch.update(playerRef, { current_team_id: playerMove.to });
        } else if (transaction.type === 'CUT') {
            const playerMove = transaction.involved_players[0];
            const playerRef = db.collection('new_players').doc(playerMove.id);
            batch.update(playerRef, { current_team_id: 'FREE_AGENT' });
        } else if (transaction.type === 'TRADE') {
            if (transaction.involved_players) {
                for (const playerMove of transaction.involved_players) {
                    const playerRef = db.collection('new_players').doc(playerMove.id);
                    batch.update(playerRef, { current_team_id: playerMove.to });
                    console.log(`TRADE: Updating player ${playerMove.id} to team ${playerMove.to}`);
                }
            }
            if (transaction.involved_picks) {
                // Get the current date for the notes field
                const today = new Date();
                const dateString = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;

                for (const pickMove of transaction.involved_picks) {
                    const pickRef = db.collection('draftPicks').doc(pickMove.id);

                    // MODIFIED: Create the notes string and add the new fields to the update
                    const tradeNotes = `${pickMove.from}/${pickMove.to} ${dateString}`;
                    batch.update(pickRef, {
                        current_owner: pickMove.to,
                        trade_id: transactionId,
                        notes: tradeNotes
                    });
                    console.log(`TRADE: Updating pick ${pickMove.id} to owner ${pickMove.to} with notes and trade_id.`);
                }
            }
        }

        await batch.commit();
        console.log(`Transaction ${transactionId} processed successfully.`);

    } catch (error) {
        console.error(`Error processing transaction ${transactionId}:`, error);
        await event.data.ref.update({ status: 'FAILED', error: error.message });
    }
    return null;
});


/**
 * V2 Function: Triggered when a transaction is created.
 * Operates on the NEW multi-season data architecture.
 * Updates player and team subcollections.
 */
exports.onTransactionCreate_V2 = onDocumentCreated("transactions/{transactionId}", async (event) => {
    const transaction = event.data.data();
    const transactionId = event.params.transactionId;
    // TODO: Make this dynamic, perhaps from a global config document
    const currentSeason = "S7";
    console.log(`V2: Processing transaction ${transactionId} for season ${currentSeason}`);

    const batch = db.batch();

    try {
        if (transaction.type === 'SIGN' || transaction.type === 'CUT') {
            const playerMove = transaction.involved_players[0];
            const playerRef = db.collection('v2_players').doc(playerMove.id);
            const newTeamId = (transaction.type === 'SIGN') ? playerMove.to : 'FREE_AGENT';
            batch.update(playerRef, { current_team_id: newTeamId });
        } else if (transaction.type === 'TRADE') {
            // Update player team affiliations
            if (transaction.involved_players) {
                for (const playerMove of transaction.involved_players) {
                    const playerRef = db.collection('v2_players').doc(playerMove.id);
                    batch.update(playerRef, { current_team_id: playerMove.to });
                    console.log(`V2 TRADE: Player ${playerMove.id} -> ${playerMove.to}`);
                }
            }
            // Update draft pick ownership
            if (transaction.involved_picks) {
                for (const pickMove of transaction.involved_picks) {
                    const pickRef = db.collection('draftPicks').doc(pickMove.id);
                    batch.update(pickRef, { current_owner: pickMove.to });
                    console.log(`V2 TRADE: Pick ${pickMove.id} -> ${pickMove.to}`);
                }
            }
        }

        // Mark the transaction as complete in a separate operation
        await event.data.ref.update({ status: 'PROCESSED', processed_at: FieldValue.serverTimestamp() });
        await batch.commit();
        console.log(`V2 Transaction ${transactionId} processed successfully.`);

    } catch (error) {
        console.error(`Error processing V2 transaction ${transactionId}:`, error);
        await event.data.ref.update({ status: 'FAILED', error: error.message });
    }
    return null;
});

// ===================================================================
// NEW: Automated Statistics Calculation (Phase 1)
// ===================================================================

/**
 * Helper function to calculate the median of an array of numbers.
 * @param {number[]} numbers - An array of numbers.
 * @returns {number} The median value.
 */
function calculateMedian(numbers) {
    if (numbers.length === 0) return 0;
    const sorted = [...numbers].sort((a, b) => a - b);
    const middleIndex = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[middleIndex - 1] + sorted[middleIndex]) / 2;
    } else {
        return sorted[middleIndex];
    }
}

/**
 * Core logic to process a completed game, check if the day's games are finished,
 * and then calculate and save daily statistics.
 * @param {object} event - The Firestore event object from the trigger.
 */
async function processCompletedGame(event) {
    const before = event.data.before.data();
    const after = event.data.after.data();
    const seasonId = event.params.seasonId;

    // 1. Only run if the game is marked as completed. This allows re-calculation on edits.
    if (after.completed !== 'TRUE') {
        console.log(`Game ${event.params.gameId} is not completed. Exiting.`);
        return null;
    }
    console.log(`V2: Processing completed game ${event.params.gameId} in season ${seasonId}`);

    // 2. Update team win/loss records ONLY if the game was just now marked as completed.
    if (before.completed !== 'TRUE' && after.completed === 'TRUE') {
        const winnerId = after.winner;
        const loserId = after.team1_id === winnerId ? after.team2_id : after.team1_id;

        if (winnerId && loserId) {
            const winLossBatch = db.batch();
            const winnerRef = db.collection('v2_teams').doc(winnerId).collection('seasonal_records').doc(seasonId);
            const loserRef = db.collection('v2_teams').doc(loserId).collection('seasonal_records').doc(seasonId);
            winLossBatch.update(winnerRef, { wins: FieldValue.increment(1) });
            winLossBatch.update(loserRef, { losses: FieldValue.increment(1) });
            await winLossBatch.commit();
            console.log(`Successfully updated win/loss records for game ${event.params.gameId}.`);
        } else {
            console.error(`Could not determine winner/loser for game ${event.params.gameId}.`);
        }
    }

    // 3. Check if all games for the day are complete
    const gameDate = after.date;
    const regularGamesQuery = db.collection('seasons').doc(seasonId).collection('games').where('date', '==', gameDate).where('completed', '!=', 'TRUE').get();
    const postGamesQuery = db.collection('seasons').doc(seasonId).collection('post_games').where('date', '==', gameDate).where('completed', '!=', 'TRUE').get();

    const [regularIncomplete, postIncomplete] = await Promise.all([regularGamesQuery, postGamesQuery]);

    if (regularIncomplete.size > 0 || postIncomplete.size > 0) {
        console.log(`Not all games for ${gameDate} are complete. Deferring daily calculations.`);
        return null;
    }
    console.log(`All games for ${gameDate} are complete. Proceeding with daily calculations.`);

    // --- All games for the day are done, proceed with calculations ---
    const dailyCalculationsBatch = db.batch();

    // 4. Determine if it's regular season or postseason
    const isPostseason = !/^\d+$/.test(after.week);
    const averagesCollectionName = isPostseason ? 'post_daily_averages' : 'daily_averages';
    const scoresCollectionName = isPostseason ? 'post_daily_scores' : 'daily_scores';
    console.log(`Season Type: ${isPostseason ? 'Postseason' : 'Regular Season'}. Using collections: ${averagesCollectionName}, ${scoresCollectionName}`);

    // 5. Calculate and Save daily_averages
    const lineupsQuery = db.collection('seasons').doc(seasonId).collection('lineups')
        .where('date', '==', gameDate)
        .where('started', '==', 'TRUE');
    const lineupsSnap = await lineupsQuery.get();

    if (lineupsSnap.empty) {
        console.log(`No starting lineups found for ${gameDate}. Cannot calculate daily averages.`);
        return null;
    }

    const adjustedScores = lineupsSnap.docs.map(doc => doc.data().points_adjusted || 0);
    const totalPlayers = adjustedScores.length;
    const sumOfScores = adjustedScores.reduce((sum, score) => sum + score, 0);
    const meanScore = totalPlayers > 0 ? sumOfScores / totalPlayers : 0;
    const medianScore = calculateMedian(adjustedScores); // This is the PLAYER median
    const replacementLevel = medianScore * 0.9;
    const winLevel = medianScore * 0.92;

    const seasonNum = seasonId.replace('S', '');
    const [month, day, year] = gameDate.split('/');
    const yyyymmdd = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;

    const dailyAveragesRef = db.doc(`${averagesCollectionName}/season_${seasonNum}/S${seasonNum}_${averagesCollectionName}/${yyyymmdd}`);
    const dailyAveragesData = {
        date: gameDate,
        week: after.week,
        total_players: totalPlayers,
        mean_score: meanScore,
        median_score: medianScore,
        replacement_level: replacementLevel,
        win: winLevel
    };
    dailyCalculationsBatch.set(dailyAveragesRef, dailyAveragesData);
    console.log(`Calculated ${averagesCollectionName} for ${gameDate}:`, dailyAveragesData);

    // 6. Calculate and Save daily_scores for all teams that played today
    const allGamesForDateRegular = await db.collection('seasons').doc(seasonId).collection('games').where('date', '==', gameDate).get();
    const allGamesForDatePost = await db.collection('seasons').doc(seasonId).collection('post_games').where('date', '==', gameDate).get();
    const allGamesToday = [...allGamesForDateRegular.docs, ...allGamesForDatePost.docs];

    const allTeamScoresToday = allGamesToday.flatMap(gameDoc => [gameDoc.data().team1_score || 0, gameDoc.data().team2_score || 0]);
    const teamMedianScore = calculateMedian(allTeamScoresToday);
    console.log(`Calculated TEAM median score for ${gameDate}: ${teamMedianScore}`);

    for (const gameDoc of allGamesToday) {
        const gameData = gameDoc.data();
        const teams = [
            { id: gameData.team1_id, score: gameData.team1_score },
            { id: gameData.team2_id, score: gameData.team2_score }
        ];

        for (const team of teams) {
            const dailyScoresRef = db.doc(`${scoresCollectionName}/season_${seasonNum}/S${seasonNum}_${scoresCollectionName}/${team.id}-${gameData.week}`);
            const teamScore = team.score || 0;
            const pointsAboveMedian = teamScore - teamMedianScore;
            const dailyScoresData = {
                week: gameData.week,
                team_id: team.id,
                date: gameDate,
                score: teamScore,
                daily_median: teamMedianScore,
                above_median: teamScore > teamMedianScore ? 1 : 0,
                points_above_median: pointsAboveMedian,
                pct_above_median: teamMedianScore > 0 ? (teamScore / teamMedianScore) - 1 : 0
            };
            dailyCalculationsBatch.set(dailyScoresRef, dailyScoresData, { merge: true });
            console.log(`Calculated ${scoresCollectionName} for team ${team.id} for week ${gameData.week}:`, dailyScoresData);
        }
    }

    // 7. Commit all daily calculations
    await dailyCalculationsBatch.commit();
    console.log(`Successfully saved ${averagesCollectionName} and ${scoresCollectionName} for ${gameDate}.`);

    return null;
}


/**
 * V2 Function: Triggers when a REGULAR season game is updated.
 * This function calls the core processing logic.
 */
exports.onRegularGameUpdate_V2 = onDocumentUpdated("seasons/{seasonId}/games/{gameId}", processCompletedGame);

/**
 * V2 Function: Triggers when a POSTSEASON game is updated.
 * This function calls the core processing logic.
 */
exports.onPostGameUpdate_V2 = onDocumentUpdated("seasons/{seasonId}/post_games/{gameId}", processCompletedGame);


exports.onLegacyGameUpdate = onDocumentUpdated("schedule/{gameId}", async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();

    if (before.completed === 'TRUE' || after.completed !== 'TRUE') {
        return null; // The game wasn't newly completed.
    }
    console.log(`LEGACY: Processing game: ${event.params.gameId}`);

    const winnerId = after.winner;
    const loserId = after.team1_id === winnerId ? after.team2_id : after.team1_id;

    if (!winnerId || !loserId) {
        console.error(`Could not determine winner/loser for game ${event.params.gameId}.`);
        return null;
    }

    const winnerRef = db.collection('teams').doc(winnerId);
    const loserRef = db.collection('teams').doc(loserId);

    try {
        // --- Step 1: Update Team Win/Loss Records (Existing Logic) ---
        await db.runTransaction(async (transaction) => {
            transaction.update(winnerRef, { wins: FieldValue.increment(1) });
            transaction.update(loserRef, { losses: FieldValue.increment(1) });
        });
        console.log(`Successfully updated team records for game ${event.params.gameId}.`);

        // --- Step 2: NEW - Process Player Stats ---
        const gameDate = after.date;
        const teamIds = [after.team1_id, after.team2_id];

        // Fetch all lineup entries for the two teams on the game date.
        const lineupsQuery = db.collection('lineups').where('date', '==', gameDate).where('team_id', 'in', teamIds);
        const lineupsSnap = await lineupsQuery.get();

        // Filter for only players who started the game.
        const startingLineups = lineupsSnap.docs
            .map(doc => doc.data())
            .filter(lineup => lineup.started === 'TRUE');

        if (startingLineups.length === 0) {
            console.log("No starting lineups found for this game. No player stats to update.");
            return null;
        }

        // Use a batched write to update all players efficiently.
        const batch = db.batch();

        for (const lineup of startingLineups) {
            const playerRef = db.collection('players').doc(lineup.player_handle);

            // Increment basic counting stats.
            const statsUpdate = {
                games_played: FieldValue.increment(1),
                total_points: FieldValue.increment(Number(lineup.points_final) || 0)
            };

            batch.update(playerRef, statsUpdate);
        }

        await batch.commit();
        console.log(`Successfully updated stats for ${startingLineups.length} players.`);

    } catch (e) {
        console.error("An error occurred during game processing: ", e);
    }

    return null;
});

/**
 * Deletes a collection by batching deletes. This is used to clear collections
 * before a fresh sync to prevent data duplication or orphaned documents.
 * @param {admin.firestore.Firestore} db The Firestore database instance.
 * @param {string} collectionPath The path to the collection to delete.
 * @param {number} batchSize The number of documents to delete in each batch.
 */
async function deleteCollection(db, collectionPath, batchSize) {
    const collectionRef = db.collection(collectionPath);
    const query = collectionRef.orderBy('__name__').limit(batchSize);

    let snapshot = await query.get();

    // When there are no documents left, the snapshot will be empty.
    while (snapshot.size > 0) {
        const batch = db.batch();
        snapshot.docs.forEach((doc) => {
            batch.delete(doc.ref);
        });
        await batch.commit();

        // Get the next batch of documents
        snapshot = await query.get();
    }
}

/**
 * Parses a CSV string into an array of objects.
 * This version is enhanced to filter out empty or malformed rows.
 * @param {string} csvText The raw CSV text to parse.
 * @returns {Array<object>} An array of objects representing the CSV rows.
 */
function parseCSV(csvText) {
    // Filter out any blank lines or lines that only contain commas and whitespace.
    const lines = csvText.trim().split('\n').filter(line => line.trim() !== '' && line.replace(/,/g, '').trim() !== '');
    if (lines.length === 0) {
        return [];
    }
    const headerLine = lines.shift();
    // Clean headers of any quotes and extra whitespace.
    const headers = headerLine.split(',').map(h => h.replace(/"/g, '').trim());
    const data = lines.map(line => {
        // Regex to handle values that might be wrapped in quotes.
        const values = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || [];
        const row = {};
        for (let i = 0; i < headers.length; i++) {
            // Ensure header exists before assigning
            if (headers[i]) {
                const value = (values[i] || '').replace(/"/g, '').trim();
                row[headers[i]] = value;
            }
        }
        return row;
    });
    return data;
}


/**
 * Safely parses a string into a number, returning 0 for invalid inputs.
 * @param {*} value The value to parse.
 * @returns {number} The parsed number or 0.
 */
function parseNumber(value) {
    if (value === null || typeof value === 'undefined' || String(value).trim() === '') return 0;
    const cleaned = String(value).replace(/,/g, '');
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
}

/**
 * Converts a MM/DD/YYYY date string to a YYYY-MM-DD string.
 * Returns null if the format is invalid.
 * @param {string} dateString The date string to convert.
 * @returns {string|null} The formatted date string or null.
 */
function getSafeDateString(dateString) {
    if (!dateString || typeof dateString !== 'string') return null;
    const parts = dateString.split('/');
    if (parts.length === 3) {
        const [month, day, year] = parts;
        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    return null;
}


// UPDATED: Changed to V2 onRequest function
exports.syncSheetsToFirestore = onRequest({ region: "us-central1" }, async (req, res) => {
    try {
        const SPREADSHEET_ID = "12EembQnztbdKx2-buv00--VDkEFSTuSXTRdOnTnRxq4";

        // Helper to fetch and parse a single sheet from Google Sheets.
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
            transactionsLogRaw,
            postScheduleRaw,
            postLineupsRaw,
            postWeeklyAveragesRaw
        ] = await Promise.all([
            fetchAndParseSheet("Players"),
            fetchAndParseSheet("Draft_Capital"),
            fetchAndParseSheet("Teams"),
            fetchAndParseSheet("Schedule"),
            fetchAndParseSheet("Lineups"),
            fetchAndParseSheet("Weekly_Averages"),
            fetchAndParseSheet("Transaction_Log"),
            fetchAndParseSheet("Post_Schedule"),
            fetchAndParseSheet("Post_Lineups"),
            fetchAndParseSheet("Post_Weekly_Averages")
        ]);
        console.log("All sheets fetched successfully.");

        // --- Clear and Sync Players collection ---
        console.log("Clearing the 'players' collection...");
        await deleteCollection(db, 'players', 200);
        console.log("'players' collection cleared successfully.");

        const playersBatch = db.batch();
        playersRaw.forEach(player => {
            if (player.player_handle && player.player_handle.trim()) {
                const docRef = db.collection("players").doc(player.player_handle.trim());
                const playerData = { ...player };

                playerData.GEM = parseNumber(player.GEM);
                playerData.REL = parseNumber(player.REL);
                playerData.WAR = parseNumber(player.WAR);
                playerData.aag_mean = parseNumber(player.aag_mean);
                playerData.aag_median = parseNumber(player.aag_median);
                playerData.games_played = parseNumber(player.games_played);
                playerData.total_points = parseNumber(player.total_points);

                playersBatch.set(docRef, playerData);
            }
        });
        await playersBatch.commit();
        console.log(`Successfully synced ${playersRaw.length} players.`);

        // --- Clear and Sync 'draftPicks' collection ---
        console.log("Clearing the 'draftPicks' collection for a fresh sync...");
        await deleteCollection(db, 'draftPicks', 200);
        console.log("'draftPicks' collection cleared successfully.");

        const draftPicksBatch = db.batch();
        draftPicksRaw.forEach(pick => {
            if (pick.pick_id && pick.pick_id.trim()) {
                const docRef = db.collection("draftPicks").doc(pick.pick_id.trim());
                const pickData = { ...pick };

                pickData.season = parseNumber(pick.season);
                pickData.round = parseNumber(pick.round);

                draftPicksBatch.set(docRef, pickData);
            }
        });
        await draftPicksBatch.commit();
        console.log(`Successfully synced ${draftPicksRaw.length} draft picks to the 'draftPicks' collection.`);

        // --- Clear and Sync Teams collection ---
        console.log("Clearing the 'teams' collection...");
        await deleteCollection(db, 'teams', 200);
        const teamsBatch = db.batch();
        teamsRaw.forEach(team => {
            if (team.team_id && team.team_id.trim()) {
                const docRef = db.collection("teams").doc(team.team_id.trim());
                teamsBatch.set(docRef, team);
            }
        });
        await teamsBatch.commit();
        console.log(`Successfully synced ${teamsRaw.length} teams.`);

        // --- Clear and Sync Schedule collection ---
        console.log("Clearing the 'schedule' collection...");
        await deleteCollection(db, 'schedule', 200);
        const scheduleBatch = db.batch();
        scheduleRaw.forEach(game => {
            const safeDate = getSafeDateString(game.date);
            if (safeDate && game.team1_id && game.team1_id.trim() && game.team2_id && game.team2_id.trim()) {
                const docId = `${safeDate}-${game.team1_id.trim()}-${game.team2_id.trim()}`;
                const docRef = db.collection("schedule").doc(docId);
                const gameData = { ...game };
                gameData.team1_score = parseNumber(game.team1_score);
                gameData.team2_score = parseNumber(game.team2_score);
                scheduleBatch.set(docRef, gameData);
            }
        });
        await scheduleBatch.commit();
        console.log(`Successfully synced ${scheduleRaw.length} schedule games.`);

        // --- Clear and Sync Lineups collection ---
        console.log("Clearing the 'lineups' collection...");
        await deleteCollection(db, 'lineups', 200);
        const lineupsBatch = db.batch();
        lineupsRaw.forEach(lineup => {
            const safeDate = getSafeDateString(lineup.date);
            if (safeDate && lineup.player_handle && lineup.player_handle.trim()) {
                const docId = `${safeDate}-${lineup.player_handle.trim()}`;
                const docRef = db.collection("lineups").doc(docId);
                const lineupData = { ...lineup };
                lineupData.points_final = parseNumber(lineup.points_final);
                lineupData.points_raw = parseNumber(lineup.points_raw);
                lineupData.global_rank = parseNumber(lineup.global_rank);
                lineupsBatch.set(docRef, lineupData);
            }
        });
        await lineupsBatch.commit();
        console.log(`Successfully synced ${lineupsRaw.length} lineup entries.`);

        // --- Clear and Sync Weekly Averages collection ---
        console.log("Clearing the 'weekly_averages' collection...");
        await deleteCollection(db, 'weekly_averages', 200);
        const weeklyAveragesBatch = db.batch();
        weeklyAveragesRaw.forEach(week => {
            const safeDate = getSafeDateString(week.date);
            if (safeDate) {
                const docRef = db.collection("weekly_averages").doc(safeDate);
                const weekData = { ...week };
                weekData.mean_score = parseNumber(week.mean_score);
                weekData.median_score = parseNumber(week.median_score);
                weeklyAveragesBatch.set(docRef, weekData);
            }
        });
        await weeklyAveragesBatch.commit();
        console.log(`Successfully synced ${weeklyAveragesRaw.length} weekly average entries.`);

        // --- ADDED: Clear and Sync Postseason Schedule collection ---
        console.log("Clearing the 'post_schedule' collection...");
        await deleteCollection(db, 'post_schedule', 200);
        const postScheduleBatch = db.batch();
        postScheduleRaw.forEach(game => {
            const safeDate = getSafeDateString(game.date);
            if (safeDate && game.team1_id && game.team1_id.trim() && game.team2_id && game.team2_id.trim()) {
                const docId = `${safeDate}-${game.team1_id.trim()}-${game.team2_id.trim()}`;
                const docRef = db.collection("post_schedule").doc(docId);
                const gameData = { ...game };
                gameData.team1_score = parseNumber(game.team1_score);
                gameData.team2_score = parseNumber(game.team2_score);
                postScheduleBatch.set(docRef, gameData);
            }
        });
        await postScheduleBatch.commit();
        console.log(`Successfully synced ${postScheduleRaw.length} postseason schedule games.`);

        // --- ADDED: Clear and Sync Postseason Lineups collection ---
        console.log("Clearing the 'post_lineups' collection...");
        await deleteCollection(db, 'post_lineups', 200);
        const postLineupsBatch = db.batch();
        postLineupsRaw.forEach(lineup => {
            const safeDate = getSafeDateString(lineup.date);
            if (safeDate && lineup.player_handle && lineup.player_handle.trim()) {
                const docId = `${safeDate}-${lineup.player_handle.trim()}`;
                const docRef = db.collection("post_lineups").doc(docId);
                const lineupData = { ...lineup };
                lineupData.points_final = parseNumber(lineup.points_final);
                lineupData.points_raw = parseNumber(lineup.points_raw);
                lineupData.global_rank = parseNumber(lineup.global_rank);
                postLineupsBatch.set(docRef, lineupData);
            }
        });
        await postLineupsBatch.commit();
        console.log(`Successfully synced ${postLineupsRaw.length} postseason lineup entries.`);

        // --- ADDED: Clear and Sync Postseason Weekly Averages collection ---
        console.log("Clearing the 'post_weekly_averages' collection...");
        await deleteCollection(db, 'post_weekly_averages', 200);
        const postWeeklyAveragesBatch = db.batch();
        postWeeklyAveragesRaw.forEach(week => {
            const safeDate = getSafeDateString(week.date);
            if (safeDate) {
                const docRef = db.collection("post_weekly_averages").doc(safeDate);
                const weekData = { ...week };
                weekData.mean_score = parseNumber(week.mean_score);
                weekData.median_score = parseNumber(week.median_score);
                postWeeklyAveragesBatch.set(docRef, weekData);
            }
        });
        await postWeeklyAveragesBatch.commit();
        console.log(`Successfully synced ${postWeeklyAveragesRaw.length} postseason weekly average entries.`);

        res.status(200).send("Firestore sync completed successfully!");

    } catch (error) {
        console.error("Error during sync:", error);
        res.status(500).send("Sync failed. Check function logs for details.");
    }
});


// UPDATED: Changed to V2 onCall function
exports.clearAllTradeBlocks = onCall({ region: "us-central1" }, async (request) => {
    // This function can remain as-is.
});

// UPDATED: Changed to V2 onCall function
exports.reopenTradeBlocks = onCall({ region: "us-central1" }, async (request) => {
    // This function can remain as-is.
});
