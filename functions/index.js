// functions/index.js

// v2 Imports
const { onDocumentUpdated, onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onRequest, onCall } = require("firebase-functions/v2/https");

// v1 Imports (for legacy functions)
const functions = require("firebase-functions");

const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const fetch = require("node-fetch");

admin.initializeApp();
const db = admin.firestore();

// ===================================================================
// V2 FUNCTIONS - NEW AND REFACTORED
// ===================================================================

// --- Helper Functions for V2 ---

/**
 * Calculates the median of an array of numbers.
 * @param {number[]} numbers An array of numbers.
 * @returns {number} The median value.
 */
function calculateMedian(numbers) {
    if (!numbers || numbers.length === 0) return 0;
    const sorted = [...numbers].sort((a, b) => a - b);
    const middleIndex = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[middleIndex - 1] + sorted[middleIndex]) / 2;
    }
    return sorted[middleIndex];
}

/**
 * Calculates the geometric mean of an array of numbers.
 * @param {number[]} numbers An array of numbers.
 * @returns {number} The geometric mean.
 */
function calculateGeometricMean(numbers) {
    if (!numbers || numbers.length === 0) return 0;
    const nonZeroNumbers = numbers.filter(num => num > 0);
    if (nonZeroNumbers.length === 0) return 0;
    const product = nonZeroNumbers.reduce((prod, num) => prod * num, 1);
    return Math.pow(product, 1 / nonZeroNumbers.length);
}

/**
 * Recalculates and updates the full seasonal stats for a single player.
 * @param {string} playerId The ID of the player to update.
 * @param {string} seasonId The season ID (e.g., "S7").
 * @param {admin.firestore.WriteBatch} batch The Firestore write batch.
 */
async function updatePlayerSeasonalStats(playerId, seasonId, batch) {
    const playerStatsRef = db.collection('v2_players').doc(playerId).collection('seasonal_stats').doc(seasonId);

    const statsUpdate = {};

    // Process both regular and postseason stats in one go
    for (const isPostseason of [false, true]) {
        const prefix = isPostseason ? 'post_' : '';
        const lineupsCollectionName = isPostseason ? 'post_lineups' : 'lineups';

        const playerLineupsQuery = db.collection('seasons').doc(seasonId).collection(lineupsCollectionName)
            .where('player_id', '==', playerId).where('started', '==', 'TRUE');
        const playerLineupsSnap = await playerLineupsQuery.get();
        const lineups = playerLineupsSnap.docs.map(doc => doc.data());

        if (lineups.length === 0) {
            // If no games, ensure stats are zeroed out
            statsUpdate[`${prefix}games_played`] = 0;
            statsUpdate[`${prefix}total_points`] = 0;
            statsUpdate[`${prefix}WAR`] = 0;
            statsUpdate[`${prefix}medrank`] = 0;
            statsUpdate[`${prefix}GEM`] = 0;
            continue;
        }

        const games_played = lineups.length;
        const total_points = lineups.reduce((sum, l) => sum + (l.final_score || 0), 0);
        const WAR = lineups.reduce((sum, l) => sum + (l.SingleGameWar || 0), 0);
        const globalRanks = lineups.map(l => l.global_rank || 0).filter(r => r > 0);
        const medrank = calculateMedian(globalRanks);
        const GEM = calculateGeometricMean(globalRanks);

        statsUpdate[`${prefix}games_played`] = games_played;
        statsUpdate[`${prefix}total_points`] = total_points;
        statsUpdate[`${prefix}medrank`] = medrank;
        statsUpdate[`${prefix}GEM`] = GEM;
        statsUpdate[`${prefix}WAR`] = WAR;
    }

    batch.set(playerStatsRef, statsUpdate, { merge: true });
}

/**
 * Recalculates and updates the full seasonal records for ALL teams in the league.
 * @param {string} seasonId The season ID (e.g., "S7").
 * @param {admin.firestore.WriteBatch} batch The Firestore write batch.
 */
async function updateAllTeamStats(seasonId, batch) {
    // 1. Fetch all necessary data upfront
    const [teamsSnap, regGamesSnap, postGamesSnap, regScoresSnap, postScoresSnap, regLineupsSnap, postLineupsSnap] = await Promise.all([
        db.collection('v2_teams').get(),
        db.collection('seasons').doc(seasonId).collection('games').where('completed', '==', 'TRUE').get(),
        db.collection('seasons').doc(seasonId).collection('post_games').where('completed', '==', 'TRUE').get(),
        db.collectionGroup('daily_scores').where('week', '!=', null).get(),
        db.collectionGroup('post_daily_scores').where('week', '!=', null).get(),
        db.collection('seasons').doc(seasonId).collection('lineups').where('started', '==', 'TRUE').get(),
        db.collection('seasons').doc(seasonId).collection('post_lineups').where('started', '==', 'TRUE').get()
    ]);

    // 2. Process data into a comprehensive map
    const teamStatsMap = new Map();
    teamsSnap.docs.forEach(doc => teamStatsMap.set(doc.id, {
        wins: 0, losses: 0, post_wins: 0, post_losses: 0, pam: 0, post_pam: 0,
        apPAM_total_pct: 0, apPAM_games: 0, ranks: [], post_ranks: [], conference: doc.data().conference
    }));

    regGamesSnap.docs.forEach(doc => {
        const game = doc.data();
        if (teamStatsMap.has(game.winner)) teamStatsMap.get(game.winner).wins++;
        const loserId = game.team1_id === game.winner ? game.team2_id : game.team1_id;
        if (teamStatsMap.has(loserId)) teamStatsMap.get(loserId).losses++;
    });
    postGamesSnap.docs.forEach(doc => {
        const game = doc.data();
        if (teamStatsMap.has(game.winner)) teamStatsMap.get(game.winner).post_wins++;
        const loserId = game.team1_id === game.winner ? game.team2_id : game.team1_id;
        if (teamStatsMap.has(loserId)) teamStatsMap.get(loserId).post_losses++;
    });

    regScoresSnap.docs.forEach(doc => {
        const score = doc.data();
        if (teamStatsMap.has(score.team_id)) {
            const teamData = teamStatsMap.get(score.team_id);
            teamData.pam += score.points_above_median || 0;
            teamData.apPAM_total_pct += score.pct_above_median || 0;
            teamData.apPAM_games++;
        }
    });
    postScoresSnap.docs.forEach(doc => {
        const score = doc.data();
        if (teamStatsMap.has(score.team_id)) {
            teamStatsMap.get(score.team_id).post_pam += score.points_above_median || 0;
        }
    });

    regLineupsSnap.docs.forEach(doc => {
        const lineup = doc.data();
        if (teamStatsMap.has(lineup.team_id) && lineup.global_rank > 0) {
            teamStatsMap.get(lineup.team_id).ranks.push(lineup.global_rank);
        }
    });
    postLineupsSnap.docs.forEach(doc => {
        const lineup = doc.data();
        if (teamStatsMap.has(lineup.team_id) && lineup.global_rank > 0) {
            teamStatsMap.get(lineup.team_id).post_ranks.push(lineup.global_rank);
        }
    });

    // 3. Calculate final stats for each team
    let calculatedStats = [];
    teamStatsMap.forEach((stats, teamId) => {
        const wpct = (stats.wins + stats.losses) > 0 ? stats.wins / (stats.wins + stats.losses) : 0;
        calculatedStats.push({
            ...stats, teamId,
            apPAM: stats.apPAM_games > 0 ? stats.apPAM_total_pct / stats.apPAM_games : 0,
            wpct,
            med_starter_rank: calculateMedian(stats.ranks),
            post_med_starter_rank: calculateMedian(stats.post_ranks),
            MaxPotWins: 15 - stats.losses,
            sortscore: wpct + (stats.pam * 0.00000001),
        });
    });

    // 4. Perform league-wide and conference-wide rankings
    const rankAndSort = (teams, stat, ascending, rankKey) => {
        const sorted = [...teams].sort((a, b) => ascending ? a[stat] - b[stat] : b[stat] - a[stat]);
        sorted.forEach((team, i) => team[rankKey] = i + 1);
        return sorted;
    };

    rankAndSort(calculatedStats, 'med_starter_rank', true, 'msr_rank');
    rankAndSort(calculatedStats, 'pam', false, 'pam_rank');
    rankAndSort(calculatedStats, 'post_med_starter_rank', true, 'post_msr_rank');
    rankAndSort(calculatedStats, 'post_pam', false, 'post_pam_rank');

    ['Eastern', 'Western'].forEach(conf => {
        const confTeams = calculatedStats.filter(t => t.conference === conf);
        if (confTeams.length === 0) return;
        rankAndSort(confTeams, 'sortscore', false, 'postseed');
        const maxPotWinsSorted = [...confTeams].sort((a, b) => b.MaxPotWins - a.MaxPotWins);
        const winsSorted = [...confTeams].sort((a, b) => b.wins - a.wins);
        const playoffWinsThreshold = maxPotWinsSorted[6]?.MaxPotWins ?? 0;
        const playinWinsThreshold = maxPotWinsSorted[10]?.MaxPotWins ?? 0;
        const elimWinsThreshold = winsSorted[9]?.wins ?? 0;
        confTeams.forEach(t => {
            t.playoffs = t.wins > playoffWinsThreshold ? 1 : 0;
            t.playin = t.wins > playinWinsThreshold ? 1 : 0;
            t.elim = t.MaxPotWins < elimWinsThreshold ? 1 : 0;
        });
    });

    // 5. Batch write final updates
    for (const team of calculatedStats) {
        const { teamId, ...stats } = team;
        const finalUpdate = {
            wins: stats.wins, losses: stats.losses, wpct: stats.wpct,
            pam: stats.pam, apPAM: stats.apPAM, med_starter_rank: stats.med_starter_rank,
            msr_rank: stats.msr_rank, pam_rank: stats.pam_rank, sortscore: stats.sortscore,
            MaxPotWins: stats.MaxPotWins, postseed: stats.postseed, playin: stats.playin,
            playoffs: stats.playoffs, elim: stats.elim,
            post_wins: stats.post_wins, post_losses: stats.post_losses, post_pam: stats.post_pam,
            post_med_starter_rank: stats.post_med_starter_rank,
            post_msr_rank: stats.post_msr_rank, post_pam_rank: stats.post_pam_rank,
        };
        const teamStatsRef = db.collection('v2_teams').doc(teamId).collection('seasonal_records').doc(seasonId);
        batch.set(teamStatsRef, finalUpdate, { merge: true });
    }
}

/**
 * Main V2 function to process a completed game and trigger all downstream calculations.
 */
async function processCompletedGame(event) {
    const before = event.data.before.data();
    const after = event.data.after.data();
    const seasonId = event.params.seasonId;
    const gameId = event.params.gameId;

    // Guard: Only run if the game was just marked as completed.
    if (after.completed !== 'TRUE' || before.completed === 'TRUE') {
        console.log(`Game ${gameId} update skipped: not newly completed.`);
        return null;
    }
    console.log(`V2: Processing completed game ${gameId} in season ${seasonId}`);

    const gameDate = after.date;
    const isPostseason = !/^\d+$/.test(after.week);

    // Guard: Check if all games on the same date are complete.
    const regIncompleteQuery = db.collection('seasons').doc(seasonId).collection('games').where('date', '==', gameDate).where('completed', '!=', 'TRUE').get();
    const postIncompleteQuery = db.collection('seasons').doc(seasonId).collection('post_games').where('date', '==', gameDate).where('completed', '!=', 'TRUE').get();
    const [regIncomplete, postIncomplete] = await Promise.all([regIncompleteQuery, postIncompleteQuery]);

    if (regIncomplete.size > 0 || postIncomplete.size > 0) {
        console.log(`Not all games for ${gameDate} are complete. Deferring calculations.`);
        return null;
    }
    console.log(`All games for ${gameDate} are complete. Proceeding with daily calculations.`);

    const batch = db.batch();
    const seasonNum = seasonId.replace('S', '');

    // --- Step 1: Calculate Daily Player Averages for the completed day ---
    const lineupsColl = isPostseason ? 'post_lineups' : 'lineups';
    const lineupsSnap = await db.collection('seasons').doc(seasonId).collection(lineupsColl).where('date', '==', gameDate).where('started', '==', 'TRUE').get();
    if (lineupsSnap.empty) {
        console.log(`No started lineups found for ${gameDate}. Aborting.`);
        return null;
    }

    const scores = lineupsSnap.docs.map(d => d.data().points_adjusted || 0); // Use points_adjusted for live function
    const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
    const median = calculateMedian(scores);
    const replacement = median * 0.9;
    const win = median * 0.92;

    const averagesColl = isPostseason ? 'post_daily_averages' : 'daily_averages';
    const [month, day, year] = gameDate.split('/');
    const yyyymmdd = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    const dailyAvgRef = db.doc(`${averagesColl}/season_${seasonNum}/S${seasonNum}_${averagesColl}/${yyyymmdd}`);
    batch.set(dailyAvgRef, { date: gameDate, week: after.week, total_players: scores.length, mean_score: mean, median_score: median, replacement_level: replacement, win: win });

    // --- Step 2: Update individual lineup documents with single-game stats ---
    const playerIdsToUpdate = new Set();
    lineupsSnap.docs.forEach(doc => {
        const lineupData = doc.data();
        playerIdsToUpdate.add(lineupData.player_id);
        const finalScore = lineupData.final_score || 0;
        batch.update(doc.ref, {
            SingleGameWar: win ? (finalScore - replacement) / win : 0,
        });
    });

    // --- Step 3: Calculate and write daily team scores ---
    const scoresColl = isPostseason ? 'post_daily_scores' : 'daily_scores';
    const regGamesSnap = await db.collection('seasons').doc(seasonId).collection('games').where('date', '==', gameDate).get();
    const postGamesSnap = await db.collection('seasons').doc(seasonId).collection('post_games').where('date', '==', gameDate).get();
    const allGamesForDate = [...regGamesSnap.docs, ...postGamesSnap.docs];
    const teamScores = allGamesForDate.flatMap(d => [d.data().team1_score, d.data().team2_score]);
    const teamMedian = calculateMedian(teamScores);

    allGamesForDate.forEach(doc => {
        const game = doc.data();
        [{ id: game.team1_id, score: game.team1_score }, { id: game.team2_id, score: game.team2_score }].forEach(team => {
            const scoreRefId = isPostseason ? `${team.id}-${gameDate.replace(/\//g, '-')}` : `${team.id}-${game.week}`;
            const scoreRef = db.doc(`${scoresColl}/season_${seasonNum}/S${seasonNum}_${scoresColl}/${scoreRefId}`);
            const pam = team.score - teamMedian;
            batch.set(scoreRef, { week: game.week, team_id: team.id, date: gameDate, score: team.score, daily_median: teamMedian, points_above_median: pam, pct_above_median: teamMedian ? pam / teamMedian : 0 }, { merge: true });
        });
    });

    // --- Step 4: Trigger full seasonal recalculations ---
    const playerStatPromises = [];
    for (const pid of playerIdsToUpdate) {
        playerStatPromises.push(updatePlayerSeasonalStats(pid, seasonId, batch));
    }
    await Promise.all(playerStatPromises);
    await updateAllTeamStats(seasonId, batch);

    // --- Step 5: Commit all updates ---
    await batch.commit();
    console.log(`Successfully saved all daily calculations and stats for ${gameDate}.`);
    return null;
}

// --- V2 Function Exports ---
exports.onRegularGameUpdate_V2 = onDocumentUpdated("seasons/{seasonId}/games/{gameId}", processCompletedGame);
exports.onPostGameUpdate_V2 = onDocumentUpdated("seasons/{seasonId}/post_games/{gameId}", processCompletedGame);

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


// ===================================================================
// LEGACY FUNCTIONS - DO NOT MODIFY
// ===================================================================

/**
 * Triggered when a transaction is created in the new admin portal.
 * Updates player and draft pick ownership based on the transaction type.
 */
exports.onTransactionCreate = functions.firestore.document("transactions/{transactionId}").onCreate(async (snap, context) => {
    const transaction = snap.data();
    const transactionId = context.params.transactionId;
    console.log(`LEGACY: Processing transaction ${transactionId} of type: ${transaction.type}`);

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
                    console.log(`LEGACY TRADE: Updating player ${playerMove.id} to team ${playerMove.to}`);
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
                    console.log(`LEGACY TRADE: Updating pick ${pickMove.id} to owner ${pickMove.to} with notes and trade_id.`);
                }
            }
        }

        await batch.commit();
        console.log(`Legacy Transaction ${transactionId} processed successfully.`);

    } catch (error) {
        console.error(`Error processing legacy transaction ${transactionId}:`, error);
        await snap.ref.update({ status: 'FAILED', error: error.message });
    }
    return null;
});

exports.onLegacyGameUpdate = functions.firestore.document("schedule/{gameId}").onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();

    if (before.completed === 'TRUE' || after.completed !== 'TRUE') {
        return null; // The game wasn't newly completed.
    }
    console.log(`LEGACY: Processing game: ${context.params.gameId}`);

    const winnerId = after.winner;
    const loserId = after.team1_id === winnerId ? after.team2_id : after.team1_id;

    if (!winnerId || !loserId) {
        console.error(`Could not determine winner/loser for legacy game ${context.params.gameId}.`);
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
        console.log(`Successfully updated legacy team records for game ${context.params.gameId}.`);

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
            console.log("No starting lineups found for this legacy game. No player stats to update.");
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

            batch.update(playerRef, statsUpdate);
        }

        // Commit all the player updates at once.
        await batch.commit();
        console.log(`Successfully updated legacy stats for ${startingLineups.length} players.`);

    } catch (e) {
        console.error("An error occurred during legacy game processing: ", e);
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


exports.syncSheetsToFirestore = functions.https.onRequest(async (req, res) => {
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

        console.log("LEGACY SYNC: Fetching all sheets...");
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
        console.log("LEGACY SYNC: All sheets fetched successfully.");

        // --- Clear and Sync Players collection ---
        console.log("LEGACY SYNC: Clearing the 'players' collection...");
        await deleteCollection(db, 'players', 200);
        console.log("LEGACY SYNC: 'players' collection cleared successfully.");

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
        console.log(`LEGACY SYNC: Successfully synced ${playersRaw.length} players.`);

        // --- Clear and Sync 'draftPicks' collection ---
        console.log("LEGACY SYNC: Clearing the 'draftPicks' collection for a fresh sync...");
        await deleteCollection(db, 'draftPicks', 200);
        console.log("LEGACY SYNC: 'draftPicks' collection cleared successfully.");

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
        console.log(`LEGACY SYNC: Successfully synced ${draftPicksRaw.length} draft picks to the 'draftPicks' collection.`);

        // --- Clear and Sync Teams collection ---
        console.log("LEGACY SYNC: Clearing the 'teams' collection...");
        await deleteCollection(db, 'teams', 200);
        const teamsBatch = db.batch();
        teamsRaw.forEach(team => {
            if (team.team_id && team.team_id.trim()) {
                const docRef = db.collection("teams").doc(team.team_id.trim());
                teamsBatch.set(docRef, team);
            }
        });
        await teamsBatch.commit();
        console.log(`LEGACY SYNC: Successfully synced ${teamsRaw.length} teams.`);

        // --- Clear and Sync Schedule collection ---
        console.log("LEGACY SYNC: Clearing the 'schedule' collection...");
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
        console.log(`LEGACY SYNC: Successfully synced ${scheduleRaw.length} schedule games.`);

        // --- Clear and Sync Lineups collection ---
        console.log("LEGACY SYNC: Clearing the 'lineups' collection...");
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
        console.log(`LEGACY SYNC: Successfully synced ${lineupsRaw.length} lineup entries.`);

        // --- Clear and Sync Weekly Averages collection ---
        console.log("LEGACY SYNC: Clearing the 'weekly_averages' collection...");
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
        console.log(`LEGACY SYNC: Successfully synced ${weeklyAveragesRaw.length} weekly average entries.`);

        // --- ADDED: Clear and Sync Postseason Schedule collection ---
        console.log("LEGACY SYNC: Clearing the 'post_schedule' collection...");
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
        console.log(`LEGACY SYNC: Successfully synced ${postScheduleRaw.length} postseason schedule games.`);

        // --- ADDED: Clear and Sync Postseason Lineups collection ---
        console.log("LEGACY SYNC: Clearing the 'post_lineups' collection...");
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
        console.log(`LEGACY SYNC: Successfully synced ${postLineupsRaw.length} postseason lineup entries.`);

        // --- ADDED: Clear and Sync Postseason Weekly Averages collection ---
        console.log("LEGACY SYNC: Clearing the 'post_weekly_averages' collection...");
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
        console.log(`LEGACY SYNC: Successfully synced ${postWeeklyAveragesRaw.length} postseason weekly average entries.`);

        res.status(200).send("Legacy Firestore sync completed successfully!");

    } catch (error) {
        console.error("Error during legacy sync:", error);
        res.status(500).send("Legacy sync failed. Check function logs for details.");
    }
});


exports.clearAllTradeBlocks = functions.https.onCall(async (data, context) => {
    // This function can remain as-is.
});

exports.reopenTradeBlocks = functions.https.onCall(async (data, context) => {
    // This function can remain as-is.
});
