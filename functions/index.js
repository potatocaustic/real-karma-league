// index.js

const { onDocumentUpdated, onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onRequest, onCall } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore"); // Import FieldValue directly
const fetch = require("node-fetch");

admin.initializeApp();
const db = admin.firestore();

// ===================================================================
// V2 FUNCTIONS - DO NOT MODIFY LEGACY FUNCTIONS BELOW
// ===================================================================

/**
 * V2 Function: Triggered when a transaction is created for the new data structure.
 * Updates player team assignments.
 */
exports.onTransactionCreate_V2 = onDocumentCreated("transactions/{transactionId}", async (event) => {
    const transaction = event.data.data();
    const transactionId = event.params.transactionId;
    console.log(`V2: Processing transaction ${transactionId} for player/pick moves.`);

    const batch = db.batch();
    try {
        if (transaction.type === 'SIGN' || transaction.type === 'CUT') {
            const playerMove = transaction.involved_players[0];
            const playerRef = db.collection('v2_players').doc(playerMove.id);
            const newTeamId = (transaction.type === 'SIGN') ? playerMove.to : 'FREE_AGENT';
            batch.update(playerRef, { current_team_id: newTeamId });
        } else if (transaction.type === 'TRADE') {
            if (transaction.involved_players) {
                for (const playerMove of transaction.involved_players) {
                    const playerRef = db.collection('v2_players').doc(playerMove.id);
                    batch.update(playerRef, { current_team_id: playerMove.to });
                }
            }
            if (transaction.involved_picks) {
                for (const pickMove of transaction.involved_picks) {
                    const pickRef = db.collection('draftPicks').doc(pickMove.id);
                    batch.update(pickRef, { current_owner: pickMove.to });
                }
            }
        }
        await event.data.ref.update({ status: 'PROCESSED', processed_at: FieldValue.serverTimestamp() });
        await batch.commit();
        console.log(`V2 Transaction ${transactionId} processed successfully for player/pick moves.`);
    } catch (error) {
        console.error(`Error processing V2 transaction ${transactionId} for player/pick moves:`, error);
        await event.data.ref.update({ status: 'FAILED', error: error.message });
    }
    return null;
});

/**
 * V2 Function: Triggered when a transaction is created to update team stats.
 */
exports.onTransactionUpdate_V2 = onDocumentCreated("transactions/{transactionId}", async (event) => {
    const transaction = event.data.data();
    const seasonId = "S7"; // Hardcoded for now
    console.log(`V2: Updating transaction counts for transaction ${event.params.transactionId}`);

    const involvedTeams = new Set(transaction.involved_teams || []);
    if (involvedTeams.size === 0) return null;

    const batch = db.batch();
    for (const teamId of involvedTeams) {
        const teamStatsRef = db.collection('v2_teams').doc(teamId).collection('seasonal_records').doc(seasonId);
        batch.update(teamStatsRef, { total_transactions: FieldValue.increment(1) });
    }
    await batch.commit();
    console.log(`Successfully updated transaction counts for teams: ${[...involvedTeams].join(', ')}`);
});

function calculateMedian(numbers) {
    if (numbers.length === 0) return 0;
    const sorted = [...numbers].sort((a, b) => a - b);
    const middleIndex = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[middleIndex - 1] + sorted[middleIndex]) / 2;
    }
    return sorted[middleIndex];
}

function calculateGeometricMean(numbers) {
    if (numbers.length === 0) return 0;
    const nonZeroNumbers = numbers.filter(num => num > 0);
    if (nonZeroNumbers.length === 0) return 0;
    const product = nonZeroNumbers.reduce((prod, num) => prod * num, 1);
    return Math.pow(product, 1 / nonZeroNumbers.length);
}

async function updatePlayerSeasonalStats(playerId, seasonId, isPostseason, batch) {
    const lineupsCollectionName = isPostseason ? 'post_lineups' : 'lineups';
    const dailyAveragesCollectionName = isPostseason ? 'post_daily_averages' : 'daily_averages';

    const playerLineupsQuery = db.collection('seasons').doc(seasonId).collection(lineupsCollectionName)
        .where('player_id', '==', playerId).where('started', '==', 'TRUE');
    const playerLineupsSnap = await playerLineupsQuery.get();
    const lineups = playerLineupsSnap.docs.map(doc => doc.data());

    if (lineups.length === 0) return;

    const games_played = lineups.length;
    const total_points = lineups.reduce((sum, l) => sum + (l.points_adjusted || 0), 0);
    const WAR = lineups.reduce((sum, l) => sum + (l.SingleGameWar || 0), 0);
    const aag_mean = lineups.reduce((sum, l) => sum + (l.AboveAvg || 0), 0);
    const aag_median = lineups.reduce((sum, l) => sum + (l.AboveMed || 0), 0);

    const globalRanks = lineups.map(l => l.global_rank || 0).filter(r => r > 0);
    const medrank = calculateMedian(globalRanks);
    const GEM = calculateGeometricMean(globalRanks);

    const uniqueDates = [...new Set(lineups.map(l => l.date))];
    let meansum = 0, medsum = 0;
    for (const date of uniqueDates) {
        const [month, day, year] = date.split('/');
        const yyyymmdd = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        const seasonNum = seasonId.replace('S', '');
        const dailyAvgDoc = await db.doc(`${dailyAveragesCollectionName}/season_${seasonNum}/S${seasonNum}_${dailyAveragesCollectionName}/${yyyymmdd}`).get();
        if (dailyAvgDoc.exists) {
            const avgData = dailyAvgDoc.data();
            meansum += avgData.mean_score || 0;
            medsum += avgData.median_score || 0;
        }
    }

    const statsUpdate = {};
    const prefix = isPostseason ? 'post_' : '';
    statsUpdate[`${prefix}games_played`] = games_played;
    statsUpdate[`${prefix}total_points`] = total_points;
    statsUpdate[`${prefix}medrank`] = medrank;
    statsUpdate[`${prefix}aag_mean`] = aag_mean;
    statsUpdate[`${prefix}aag_mean_pct`] = games_played > 0 ? aag_mean / games_played : 0;
    statsUpdate[`${prefix}meansum`] = meansum;
    statsUpdate[`${prefix}rel_mean`] = meansum > 0 ? total_points / meansum : 0;
    statsUpdate[`${prefix}aag_median`] = aag_median;
    statsUpdate[`${prefix}aag_median_pct`] = games_played > 0 ? aag_median / games_played : 0;
    statsUpdate[`${prefix}medsum`] = medsum;
    statsUpdate[`${prefix}rel_median`] = medsum > 0 ? total_points / medsum : 0;
    statsUpdate[`${prefix}GEM`] = GEM;
    statsUpdate[`${prefix}WAR`] = WAR;

    const playerStatsRef = db.collection('v2_players').doc(playerId).collection('seasonal_stats').doc(seasonId);
    batch.set(playerStatsRef, statsUpdate, { merge: true });
}

async function updateAllTeamStats(seasonId, isPostseason, batch) {
    const teamsSnap = await db.collection('v2_teams').get();
    const allTeamData = teamsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const teamStatsPromises = allTeamData.map(async team => {
        const teamId = team.id;
        let wins = 0, losses = 0, pam = 0, apPAM = 0, med_starter_rank = 0;

        const gamesCollection = isPostseason ? 'post_games' : 'games';
        const scoresCollection = isPostseason ? 'post_daily_scores' : 'daily_scores';
        const lineupsCollection = isPostseason ? 'post_lineups' : 'lineups';

        const teamGames1 = await db.collection('seasons').doc(seasonId).collection(gamesCollection).where('team1_id', '==', teamId).where('completed', '==', 'TRUE').get();
        const teamGames2 = await db.collection('seasons').doc(seasonId).collection(gamesCollection).where('team2_id', '==', teamId).where('completed', '==', 'TRUE').get();

        [...teamGames1.docs, ...teamGames2.docs].forEach(doc => {
            const game = doc.data();
            if (game.winner === teamId) wins++; else losses++;
        });

        const scoresSnap = await db.collection(scoresCollection).doc(`season_${seasonId.replace('S', '')}`).collection(`S${seasonId.replace('S', '')}_${scoresCollection}`).where('team_id', '==', teamId).get();
        const scoresDocs = scoresSnap.docs.map(d => d.data());
        pam = scoresDocs.reduce((sum, s) => sum + (s.points_above_median || 0), 0);
        apPAM = scoresDocs.length > 0 ? scoresDocs.reduce((sum, s) => sum + (s.pct_above_median || 0), 0) / scoresDocs.length : 0;

        const lineupsSnap = await db.collection('seasons').doc(seasonId).collection(lineupsCollection).where('team_id', '==', teamId).where('started', '==', 'TRUE').get();
        const ranks = lineupsSnap.docs.map(d => d.data().global_rank || 0).filter(r => r > 0);
        med_starter_rank = calculateMedian(ranks);

        const wpct = (wins + losses) > 0 ? wins / (wins + losses) : 0;
        return { teamId, conference: team.conference, wins, losses, wpct, pam, apPAM, med_starter_rank, sortscore: wpct + (pam * 0.00000001), MaxPotWins: 15 - losses };
    });

    const calculatedStats = await Promise.all(teamStatsPromises);
    const eastConf = calculatedStats.filter(t => t.conference === 'Eastern');
    const westConf = calculatedStats.filter(t => t.conference === 'Western');

    const rankAndSort = (teams, stat, ascending = true) => {
        const sorted = [...teams].sort((a, b) => ascending ? a[stat] - b[stat] : b[stat] - a[stat]);
        sorted.forEach((team, i) => team[`${stat}_rank`] = i + 1);
    };
    rankAndSort(calculatedStats, 'med_starter_rank');
    rankAndSort(calculatedStats, 'pam', false);

    [eastConf, westConf].forEach(conf => {
        conf.sort((a, b) => b.sortscore - a.sortscore).forEach((t, i) => t.postseed = i + 1);
        const maxPotWinsSorted = [...conf].sort((a, b) => b.MaxPotWins - a.MaxPotWins);
        const winsSorted = [...conf].sort((a, b) => b.wins - a.wins);
        conf.forEach(t => {
            t.playin = t.wins > (maxPotWinsSorted[10]?.MaxPotWins || 0) ? 1 : 0;
            t.playoffs = t.wins > (maxPotWinsSorted[6]?.MaxPotWins || 0) ? 1 : 0;
            t.elim = t.MaxPotWins < (winsSorted[9]?.wins || 0) ? 1 : 0;
        });
    });

    for (const team of calculatedStats) {
        const { teamId, ...stats } = team;
        const prefix = isPostseason ? 'post_' : '';
        const finalUpdate = {};
        for (const [key, value] of Object.entries(stats)) {
            if (['wins', 'losses', 'med_starter_rank', 'pam'].includes(key)) {
                finalUpdate[`${prefix}${key}`] = value;
            } else if (!['conference', 'sortscore', 'MaxPotWins'].includes(key)) {
                finalUpdate[key] = value;
            }
        }
        if (!isPostseason) {
            finalUpdate.sortscore = stats.sortscore;
            finalUpdate.MaxPotWins = stats.MaxPotWins;
        }
        const teamStatsRef = db.collection('v2_teams').doc(teamId).collection('seasonal_records').doc(seasonId);
        batch.set(teamStatsRef, finalUpdate, { merge: true });
    }
}

async function processCompletedGame(event) {
    const before = event.data.before.data();
    const after = event.data.after.data();
    const seasonId = event.params.seasonId;

    if (after.completed !== 'TRUE') return null;
    console.log(`V2: Processing completed game ${event.params.gameId} in season ${seasonId}`);

    if (before.completed !== 'TRUE' && after.completed === 'TRUE') {
        const { winner, team1_id, team2_id } = after;
        const loserId = team1_id === winner ? team2_id : team1_id;
        if (winner && loserId) {
            const batch = db.batch();
            batch.update(db.collection('v2_teams').doc(winner).collection('seasonal_records').doc(seasonId), { wins: FieldValue.increment(1) });
            batch.update(db.collection('v2_teams').doc(loserId).collection('seasonal_records').doc(seasonId), { losses: FieldValue.increment(1) });
            await batch.commit();
        }
    }

    const gameDate = after.date;
    const regIncomplete = await db.collection('seasons').doc(seasonId).collection('games').where('date', '==', gameDate).where('completed', '!=', 'TRUE').get();
    const postIncomplete = await db.collection('seasons').doc(seasonId).collection('post_games').where('date', '==', gameDate).where('completed', '!=', 'TRUE').get();

    if (regIncomplete.size > 0 || postIncomplete.size > 0) return null;
    console.log(`All games for ${gameDate} are complete. Proceeding with daily calculations.`);

    const batch = db.batch();
    const isPostseason = !/^\d+$/.test(after.week);
    const averagesColl = isPostseason ? 'post_daily_averages' : 'daily_averages';
    const scoresColl = isPostseason ? 'post_daily_scores' : 'daily_scores';
    const lineupsColl = isPostseason ? 'post_lineups' : 'lineups';

    const lineupsSnap = await db.collection('seasons').doc(seasonId).collection(lineupsColl).where('date', '==', gameDate).where('started', '==', 'TRUE').get();
    if (lineupsSnap.empty) return null;

    const scores = lineupsSnap.docs.map(d => d.data().points_adjusted || 0);
    const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
    const median = calculateMedian(scores);
    const replacement = median * 0.9;
    const win = median * 0.92;

    const seasonNum = seasonId.replace('S', '');
    const [month, day, year] = gameDate.split('/');
    const yyyymmdd = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    const dailyAvgRef = db.doc(`${averagesColl}/season_${seasonNum}/S${seasonNum}_${averagesColl}/${yyyymmdd}`);
    batch.set(dailyAvgRef, { date: gameDate, week: after.week, total_players: scores.length, mean_score: mean, median_score: median, replacement_level: replacement, win: win });

    const playerIds = new Set();
    lineupsSnap.docs.forEach(doc => {
        playerIds.add(doc.data().player_id);
        const points = doc.data().points_adjusted || 0;
        const aboveMean = points - mean;
        const aboveMedian = points - median;
        batch.update(doc.ref, {
            above_mean: aboveMean, AboveAvg: aboveMean > 0 ? 1 : 0, pct_above_mean: mean ? aboveMean / mean : 0,
            above_median: aboveMedian, AboveMed: aboveMedian > 0 ? 1 : 0, pct_above_median: median ? aboveMedian / median : 0,
            SingleGameWar: win ? (points - replacement) / win : 0,
        });
    });

    const regGames = await db.collection('seasons').doc(seasonId).collection('games').where('date', '==', gameDate).get();
    const postGames = await db.collection('seasons').doc(seasonId).collection('post_games').where('date', '==', gameDate).get();
    const teamScores = [...regGames.docs, ...postGames.docs].flatMap(d => [d.data().team1_score, d.data().team2_score]);
    const teamMedian = calculateMedian(teamScores);

    [...regGames.docs, ...postGames.docs].forEach(doc => {
        const game = doc.data();
        [{ id: game.team1_id, score: game.team1_score }, { id: game.team2_id, score: game.team2_score }].forEach(team => {
            const scoreRef = db.doc(`${scoresColl}/season_${seasonNum}/S${seasonNum}_${scoresColl}/${team.id}-${game.week}`);
            const pam = team.score - teamMedian;
            batch.set(scoreRef, { week: game.week, team_id: team.id, date: gameDate, score: team.score, daily_median: teamMedian, above_median: pam > 0 ? 1 : 0, points_above_median: pam, pct_above_median: teamMedian ? pam / teamMedian : 0 }, { merge: true });
        });
    });

    for (const pid of playerIds) {
        await updatePlayerSeasonalStats(pid, seasonId, isPostseason, batch);
    }

    await updateAllTeamStats(seasonId, isPostseason, batch);

    await batch.commit();
    console.log(`Successfully saved all daily calculations and stats for ${gameDate}.`);
    return null;
}

exports.onRegularGameUpdate_V2 = onDocumentUpdated("seasons/{seasonId}/games/{gameId}", processCompletedGame);
exports.onPostGameUpdate_V2 = onDocumentUpdated("seasons/{seasonId}/post_games/{gameId}", processCompletedGame);

// ===================================================================
// LEGACY FUNCTIONS - DO NOT MODIFY
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
            transaction.update(winnerRef, { wins: admin.firestore.FieldValue.increment(1) });
            transaction.update(loserRef, { losses: admin.firestore.FieldValue.increment(1) });
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
                games_played: admin.firestore.FieldValue.increment(1),
                total_points: admin.firestore.FieldValue.increment(Number(lineup.points_final) || 0)
            };

            // FUTURE ENHANCEMENT: This is where more complex stat calculations (REL, WAR, etc.)
            // would be performed by fetching weekly averages and adding to value-over-replacement tallies.

            batch.update(playerRef, statsUpdate);
        }

        // Commit all the player updates at once.
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
 * @returns {Array<Object>} An array of objects representing the CSV rows.
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
