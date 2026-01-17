// functions/live-scoring/live-status.js

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require('../utils/firebase-admin');
const { FieldValue } = require("firebase-admin/firestore");
const fetch = require("node-fetch");
const { getCollectionName, getLeagueFromRequest, LEAGUES } = require('../utils/firebase-helpers');
const { isScorekeeperOrAdmin } = require('../utils/auth-helpers');

/**
 * Fetches karma data for a player with exponential backoff retry logic
 * @param {string} playerId - The player's ID
 * @param {number} maxRetries - Maximum number of retry attempts (default: 3)
 * @returns {Object} - The karma data or null on complete failure
 */
async function fetchPlayerKarmaWithRetry(playerId, maxRetries = 3) {
    const workerUrl = `https://rkl-karma-proxy.caustic.workers.dev/?userId=${encodeURIComponent(playerId)}`;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(workerUrl);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            const data = await response.json();

            // Validate we got actual data (not empty response)
            if (data && (data.stats || data.user)) {
                return data;
            }

            // Empty response - treat as retriable error
            throw new Error('Empty or invalid response from karma API');
        } catch (error) {
            if (attempt < maxRetries) {
                // Exponential backoff: 1s, 2s, 4s
                const backoffMs = Math.pow(2, attempt) * 1000;
                console.warn(`Retry ${attempt + 1}/${maxRetries} for player ${playerId} after ${backoffMs}ms: ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
            } else {
                console.error(`All retries exhausted for player ${playerId}: ${error.message}`);
                return null;
            }
        }
    }
    return null;
}

/**
 * Processes karma fetches in controlled concurrent batches
 * @param {Array} players - Array of player objects to process
 * @param {number} concurrency - Number of concurrent requests (default: 3)
 * @returns {Object} - Map of player_id to karma data
 */
async function batchFetchPlayerKarma(players, concurrency = 3) {
    const results = new Map();
    let apiRequests = 0;

    // Process in chunks of 'concurrency' size
    for (let i = 0; i < players.length; i += concurrency) {
        const batch = players.slice(i, i + concurrency);

        // Fetch all players in this batch concurrently
        const batchPromises = batch.map(async (player) => {
            const data = await fetchPlayerKarmaWithRetry(player.player_id);
            apiRequests++;
            return { playerId: player.player_id, data };
        });

        const batchResults = await Promise.all(batchPromises);

        // Store results
        for (const { playerId, data } of batchResults) {
            results.set(playerId, data);
        }

        // Small delay between batches to avoid overwhelming the API
        if (i + concurrency < players.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    return { results, apiRequests };
}

/**
 * Helper function to perform a full update of all live game scores
 * @param {string} league - League context ('major' or 'minor')
 */
async function performFullUpdate(league = LEAGUES.MAJOR) {
    console.log(`=== Starting full update for ${league} league ===`);
    const statusSnap = await db.doc(`${getCollectionName('live_scoring_status', league)}/status`).get();
    const gameDate = statusSnap.exists ? statusSnap.data().active_game_date : new Date().toISOString().split('T')[0];

    console.log(`[performFullUpdate] Game date: ${gameDate}`);
    console.log(`[performFullUpdate] Status doc exists: ${statusSnap.exists}`);
    if (statusSnap.exists) {
        console.log(`[performFullUpdate] active_game_date from status: ${statusSnap.data().active_game_date}`);
    }

    const liveGamesSnap = await db.collection(getCollectionName('live_games', league)).get();
    if (liveGamesSnap.empty) {
        console.log(`performFullUpdate: No active games to update for ${league} league.`);
        return { success: true, message: "No active games to update." };
    }

    console.log(`[performFullUpdate] Found ${liveGamesSnap.size} live games to process`);

    // Collect all players from all games
    const allPlayers = [];
    const gamePlayerMap = new Map(); // Track which players belong to which game/lineup

    for (const gameDoc of liveGamesSnap.docs) {
        const gameData = gameDoc.data();
        const team1Lineup = gameData.team1_lineup || [];
        const team2Lineup = gameData.team2_lineup || [];

        team1Lineup.forEach((player, idx) => {
            allPlayers.push(player);
            gamePlayerMap.set(player.player_id, { gameId: gameDoc.id, team: 'team1', index: idx });
        });
        team2Lineup.forEach((player, idx) => {
            allPlayers.push(player);
            gamePlayerMap.set(player.player_id, { gameId: gameDoc.id, team: 'team2', index: idx });
        });
    }

    console.log(`[performFullUpdate] Fetching karma for ${allPlayers.length} players (3 concurrent)`);

    // Fetch all karma data with controlled concurrency
    const { results: karmaResults, apiRequests } = await batchFetchPlayerKarma(allPlayers, 3);

    // Update player scores with fetched data
    const batch = db.batch();
    const updatedGameData = new Map(); // Store updated game data for later calculations

    for (const gameDoc of liveGamesSnap.docs) {
        const gameData = gameDoc.data();
        const team1Lineup = gameData.team1_lineup || [];
        const team2Lineup = gameData.team2_lineup || [];

        // Update team1 lineup
        for (const player of team1Lineup) {
            const data = karmaResults.get(player.player_id);
            if (data) {
                const rawScore = parseFloat(data?.stats?.karmaDelta || 0);
                const globalRank = parseInt(data?.stats?.karmaDayRank || -1, 10);
                const adjustedScore = rawScore - (player.deductions || 0);
                const finalScore = player.is_captain ? adjustedScore * 1.5 : adjustedScore;

                player.points_raw = rawScore;
                player.points_adjusted = adjustedScore;
                player.final_score = finalScore;
                player.global_rank = globalRank;
            }
        }

        // Update team2 lineup
        for (const player of team2Lineup) {
            const data = karmaResults.get(player.player_id);
            if (data) {
                const rawScore = parseFloat(data?.stats?.karmaDelta || 0);
                const globalRank = parseInt(data?.stats?.karmaDayRank || -1, 10);
                const adjustedScore = rawScore - (player.deductions || 0);
                const finalScore = player.is_captain ? adjustedScore * 1.5 : adjustedScore;

                player.points_raw = rawScore;
                player.points_adjusted = adjustedScore;
                player.final_score = finalScore;
                player.global_rank = globalRank;
            }
        }

        batch.update(gameDoc.ref, {
            team1_lineup: team1Lineup,
            team2_lineup: team2Lineup
        });

        // Store updated game data for game flow and leaderboard calculations
        updatedGameData.set(gameDoc.id, {
            ...gameData,
            team1_lineup: team1Lineup,
            team2_lineup: team2Lineup
        });
    }

    await batch.commit();

    // Use updatedGameData Map for game flow and leaderboard calculations (avoids stale snapshot data)
    const updatedLiveGamesSnap = liveGamesSnap;
    console.log(`[performFullUpdate] Processing ${updatedLiveGamesSnap.size} games with updated scores`);

    // === FEATURE 1: Record Game Flow Snapshots ===
    const timestamp = admin.firestore.Timestamp.now();
    const snapshotBatch = db.batch();

    for (const gameDoc of updatedLiveGamesSnap.docs) {
        const gameData = updatedGameData.get(gameDoc.id);
        const team1_total = (gameData.team1_lineup || []).reduce((sum, p) => sum + (p.final_score || 0), 0);
        const team2_total = (gameData.team2_lineup || []).reduce((sum, p) => sum + (p.final_score || 0), 0);

        const snapshotRef = db.collection(getCollectionName('game_flow_snapshots', league)).doc(gameDoc.id);

        // Fetch existing snapshots to calculate lead changes and biggest leads
        const existingDoc = await snapshotRef.get();
        const existingSnapshots = existingDoc.exists ? (existingDoc.data().snapshots || []) : [];

        // Calculate differential
        const differential = team1_total - team2_total;

        // Initialize or get current stats
        let leadChanges = 0;
        let team1BiggestLead = 0;
        let team2BiggestLead = 0;

        if (existingSnapshots.length > 0) {
            // Get the previous snapshot
            const prevSnapshot = existingSnapshots[existingSnapshots.length - 1];
            const prevDifferential = prevSnapshot.differential || (prevSnapshot.team1_score - prevSnapshot.team2_score);

            // Start with existing lead change count
            leadChanges = prevSnapshot.lead_changes || 0;
            team1BiggestLead = prevSnapshot.team1_biggest_lead || 0;
            team2BiggestLead = prevSnapshot.team2_biggest_lead || 0;

            // Check if lead changed (sign change in differential, including transitions through 0)
            if ((prevDifferential > 0 && differential < 0) ||
                (prevDifferential < 0 && differential > 0) ||
                (prevDifferential === 0 && differential !== 0)) {
                leadChanges++;
            }
        }

        // Update biggest leads
        if (differential > team1BiggestLead) {
            team1BiggestLead = differential;
        }
        if (differential < 0 && Math.abs(differential) > team2BiggestLead) {
            team2BiggestLead = Math.abs(differential);
        }

        snapshotBatch.set(snapshotRef, {
            snapshots: FieldValue.arrayUnion({
                timestamp: timestamp,
                team1_score: team1_total,
                team2_score: team2_total,
                differential: differential,
                lead_changes: leadChanges,
                team1_biggest_lead: team1BiggestLead,
                team2_biggest_lead: team2BiggestLead
            })
        }, { merge: true });
    }

    await snapshotBatch.commit();
    console.log(`Game flow snapshots recorded for ${updatedLiveGamesSnap.size} games.`);

    // === FEATURE 2: Calculate Daily Leaderboard ===
    try {
        console.log(`[Daily Leaderboard] Starting calculation for ${gameDate} (${league} league)...`);
        const allPlayers = [];
        const playerGameCount = new Map(); // Track how many games each player is in

        console.log(`[Daily Leaderboard] Processing ${updatedLiveGamesSnap.size} live games...`);
        for (const gameDoc of updatedLiveGamesSnap.docs) {
            const gameData = updatedGameData.get(gameDoc.id);
            const allStarters = [...(gameData.team1_lineup || []), ...(gameData.team2_lineup || [])];
            console.log(`[Daily Leaderboard] Game ${gameDoc.id}: ${allStarters.length} starters`);

            for (const player of allStarters) {
                const playerId = player.player_id;

                // For preseason: only count each player once
                if (!playerGameCount.has(playerId)) {
                    allPlayers.push({
                        player_id: playerId,
                        player_handle: player.player_handle,
                        team_id: player.team_id,
                        score: player.points_adjusted || 0,
                        global_rank: player.global_rank || -1
                    });
                    playerGameCount.set(playerId, 1);
                    console.log(`[Daily Leaderboard] Added player ${player.player_handle} with score ${player.points_adjusted}`);
                }
            }
        }

        console.log(`[Daily Leaderboard] Total unique players: ${allPlayers.length}`);

        if (allPlayers.length > 0) {
            // Sort by score descending
            allPlayers.sort((a, b) => b.score - a.score);

            // Assign ranks
            for (let i = 0; i < allPlayers.length; i++) {
                allPlayers[i].rank = i + 1;
            }

            // Calculate median score
            const medianScore = allPlayers.length > 0
                ? (allPlayers.length % 2 === 0
                    ? (allPlayers[Math.floor(allPlayers.length / 2) - 1].score + allPlayers[Math.floor(allPlayers.length / 2)].score) / 2
                    : allPlayers[Math.floor(allPlayers.length / 2)].score)
                : 0;

            // Fetch team names for all unique team IDs - batched query instead of N+1
            const uniqueTeamIds = [...new Set(allPlayers.map(p => p.team_id))];
            const teamNames = new Map();

            // Get the season ID from the first live game
            const seasonId = updatedLiveGamesSnap.docs[0]?.data().seasonId;

            if (!seasonId) {
                console.warn(`[Daily Leaderboard] No seasonId found in live games, cannot fetch team names`);
                // Set all team names to 'Unknown' as fallback
                uniqueTeamIds.forEach(teamId => teamNames.set(teamId, 'Unknown'));
            } else {
                console.log(`[Daily Leaderboard] Fetching team names for ${uniqueTeamIds.length} teams from season ${seasonId}...`);
                // Batch fetch all team records in parallel instead of sequential loop
                const teamFetchPromises = uniqueTeamIds.map(async (teamId) => {
                    try {
                        const seasonalRecordDoc = await db.collection(getCollectionName('v2_teams', league))
                            .doc(teamId)
                            .collection(getCollectionName('seasonal_records', league))
                            .doc(seasonId)
                            .get();
                        return { teamId, doc: seasonalRecordDoc };
                    } catch (err) {
                        console.error(`[Daily Leaderboard] Error fetching team ${teamId}:`, err);
                        return { teamId, doc: null, error: err };
                    }
                });

                const teamResults = await Promise.all(teamFetchPromises);

                for (const { teamId, doc, error } of teamResults) {
                    if (error || !doc) {
                        teamNames.set(teamId, 'Unknown');
                    } else if (doc.exists) {
                        const teamName = doc.data().team_name;
                        teamNames.set(teamId, teamName || 'Unknown');
                    } else {
                        console.warn(`[Daily Leaderboard] No seasonal record found for team ${teamId} in season ${seasonId}`);
                        teamNames.set(teamId, 'Unknown');
                    }
                }
                console.log(`[Daily Leaderboard] Fetched ${teamResults.length} team names in parallel`);
            }

            // Enrich players with team names and calculate percent_vs_median
            allPlayers.forEach(player => {
                player.team_name = teamNames.get(player.team_id) || 'Unknown';
                player.handle = player.player_handle; // Add handle field for frontend compatibility
                player.percent_vs_median = medianScore !== 0
                    ? ((player.score - medianScore) / Math.abs(medianScore)) * 100
                    : 0;
            });

            // Prepare top 3 and bottom 3
            const top_3 = allPlayers.slice(0, 3);
            const bottom_3 = allPlayers.slice(-3).reverse();

            // Store in Firestore with new format
            const leaderboardRef = db.collection(getCollectionName('daily_leaderboards', league)).doc(gameDate);
            await leaderboardRef.set({
                date: gameDate,
                all_players: allPlayers,
                top_3: top_3,
                bottom_3: bottom_3,
                median_score: medianScore,
                last_updated: FieldValue.serverTimestamp()
            });

            console.log(`[Daily Leaderboard] Successfully stored ${allPlayers.length} players for ${gameDate} (median: ${medianScore})`);
        } else {
            console.log(`[Daily Leaderboard] No players to store for ${gameDate}`);
        }
    } catch (error) {
        console.error(`[Daily Leaderboard] Error calculating daily leaderboard:`, error);
    }

    // === FEATURE 3: Update API Request Counter ===
    const usageRef = db.doc(`${getCollectionName('usage_stats', league)}/${gameDate}`);
    await usageRef.set({ api_requests_full_update: FieldValue.increment(apiRequests) }, { merge: true });

    // === Update last_full_update_completed timestamp ===
    const statusRef = db.doc(`${getCollectionName('live_scoring_status', league)}/status`);
    await statusRef.set({ last_full_update_completed: FieldValue.serverTimestamp() }, { merge: true });

    console.log(`Full update completed. ${apiRequests} API requests made.`);
    return { success: true, message: `Updated all live games. ${apiRequests} API requests made.` };
}

/**
 * Manually triggers a full update of all live game scores
 * Admin or scorekeeper only
 */
exports.updateAllLiveScores = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
    if (!(await isScorekeeperOrAdmin(request.auth, league))) {
        throw new HttpsError('permission-denied', 'Must be an admin or scorekeeper to run this function.');
    }
    return await performFullUpdate(league);
});

/**
 * Sets the live scoring status
 * Admin only - can set status to 'active', 'paused', or 'stopped'
 */
exports.setLiveScoringStatus = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
    if (!request.auth || !request.auth.uid) {
        throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to set live scoring status.');
    }

    const { status, interval, gameDate } = request.data;
    const validStatuses = ['active', 'paused', 'stopped'];
    if (!validStatuses.includes(status)) {
        throw new HttpsError('invalid-argument', 'Invalid payload. Expects { status: "active" | "paused" | "stopped" }');
    }

    const statusRef = db.doc(`${getCollectionName('live_scoring_status', league)}/status`);
    try {
        const updateData = {
            status: status,
            updated_by: request.auth.uid,
            last_updated: FieldValue.serverTimestamp()
        };
        if (interval && typeof interval === 'number') {
            updateData.interval_minutes = interval;
        }

        if (status === 'active') {
            updateData.last_sample_completed_at = FieldValue.serverTimestamp();
        }

        if (gameDate) {
            updateData.active_game_date = gameDate;
            const liveGamesSnap = await db.collection(getCollectionName('live_games', league)).get();
            const usageRef = db.doc(`${getCollectionName('usage_stats', league)}/${gameDate}`);
            await usageRef.set({ live_game_count: liveGamesSnap.size }, { merge: true });
        }

        await statusRef.set(updateData, { merge: true });

        return { success: true, league, message: `Live scoring status set to ${status}.` };
    } catch (error) {
        console.error("Error updating live scoring status:", error);
        throw new HttpsError('internal', 'Could not update live scoring status.');
    }
});

// Export Cloud Functions
module.exports.updateAllLiveScores = exports.updateAllLiveScores;
module.exports.setLiveScoringStatus = exports.setLiveScoringStatus;
// Export helper functions for use by other modules
module.exports.performFullUpdate = performFullUpdate;
module.exports.fetchPlayerKarmaWithRetry = fetchPlayerKarmaWithRetry;
