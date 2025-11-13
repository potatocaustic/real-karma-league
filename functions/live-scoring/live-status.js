// functions/live-scoring/live-status.js

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const fetch = require("node-fetch");
const { getCollectionName, getLeagueFromRequest, LEAGUES } = require('../utils/firebase-helpers');
const { isScorekeeperOrAdmin } = require('../utils/auth-helpers');

// Ensure admin is initialized (will use existing instance if already initialized)
if (!admin.apps.length) {
    admin.initializeApp();
}
const db = admin.firestore();

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

    const batch = db.batch();
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    let apiRequests = 0;

    for (const gameDoc of liveGamesSnap.docs) {
        const gameData = gameDoc.data();
        const allStarters = [...gameData.team1_lineup, ...gameData.team2_lineup];

        for (let i = 0; i < allStarters.length; i++) {
            const player = allStarters[i];
            const workerUrl = `https://rkl-karma-proxy.caustic.workers.dev/?userId=${encodeURIComponent(player.player_id)}`;
            try {
                const response = await fetch(workerUrl);
                apiRequests++;
                const data = await response.json();
                const rawScore = parseFloat(data?.stats?.karmaDelta || 0);

                const globalRank = parseInt(data?.stats?.karmaDayRank || -1, 10);

                const adjustedScore = rawScore - (player.deductions || 0);
                const finalScore = player.is_captain ? adjustedScore * 1.5 : adjustedScore;

                player.points_raw = rawScore;
                player.points_adjusted = adjustedScore;
                player.final_score = finalScore;

                player.global_rank = globalRank;

            } catch (error) {
                console.error(`performFullUpdate: Failed to fetch karma for ${player.player_id}`, error);
            }
            await delay(Math.floor(Math.random() * 201) + 100);
        }
        batch.update(gameDoc.ref, {
            team1_lineup: gameData.team1_lineup,
            team2_lineup: gameData.team2_lineup
        });
    }

    await batch.commit();

    // === FEATURE 1: Record Game Flow Snapshots ===
    const timestamp = admin.firestore.Timestamp.now();
    const snapshotBatch = db.batch();

    for (const gameDoc of liveGamesSnap.docs) {
        const gameData = gameDoc.data();
        const team1_total = gameData.team1_lineup.reduce((sum, p) => sum + (p.final_score || 0), 0);
        const team2_total = gameData.team2_lineup.reduce((sum, p) => sum + (p.final_score || 0), 0);

        const snapshotRef = db.collection(getCollectionName('game_flow_snapshots', league)).doc(gameDoc.id);
        snapshotBatch.set(snapshotRef, {
            snapshots: FieldValue.arrayUnion({
                timestamp: timestamp,
                team1_score: team1_total,
                team2_score: team2_total
            })
        }, { merge: true });
    }

    await snapshotBatch.commit();
    console.log(`Game flow snapshots recorded for ${liveGamesSnap.size} games.`);

    // === FEATURE 2: Calculate Daily Leaderboard ===
    try {
        console.log(`[Daily Leaderboard] Starting calculation for ${gameDate} (${league} league)...`);
        const allPlayers = [];
        const playerGameCount = new Map(); // Track how many games each player is in

        console.log(`[Daily Leaderboard] Processing ${liveGamesSnap.size} live games...`);
        for (const gameDoc of liveGamesSnap.docs) {
            const gameData = gameDoc.data();
            const allStarters = [...gameData.team1_lineup, ...gameData.team2_lineup];
            console.log(`[Daily Leaderboard] Game ${gameDoc.id}: ${allStarters.length} starters`);

            for (const player of allStarters) {
                const playerId = player.player_id;

                // For preseason: only count each player once
                if (!playerGameCount.has(playerId)) {
                    allPlayers.push({
                        player_id: playerId,
                        player_handle: player.player_handle,
                        team_id: player.team_id,
                        final_score: player.final_score || 0,
                        global_rank: player.global_rank || -1
                    });
                    playerGameCount.set(playerId, 1);
                    console.log(`[Daily Leaderboard] Added player ${player.player_handle} with score ${player.final_score}`);
                }
            }
        }

        console.log(`[Daily Leaderboard] Total unique players: ${allPlayers.length}`);

        if (allPlayers.length > 0) {
            // Sort by final score descending
            allPlayers.sort((a, b) => b.final_score - a.final_score);

            // Assign ranks
            for (let i = 0; i < allPlayers.length; i++) {
                allPlayers[i].rank = i + 1;
            }

            // Store in Firestore
            const leaderboardRef = db.collection(getCollectionName('daily_leaderboards', league)).doc(gameDate);
            await leaderboardRef.set({
                date: gameDate,
                players: allPlayers,
                last_updated: FieldValue.serverTimestamp()
            });

            console.log(`[Daily Leaderboard] Successfully stored ${allPlayers.length} players for ${gameDate}`);
        } else {
            console.log(`[Daily Leaderboard] No players to store for ${gameDate}`);
        }
    } catch (error) {
        console.error(`[Daily Leaderboard] Error calculating daily leaderboard:`, error);
    }

    // === FEATURE 3: Update API Request Counter ===
    const usageRef = db.doc(`${getCollectionName('usage_stats', league)}/${gameDate}`);
    await usageRef.set({ api_requests_full: FieldValue.increment(apiRequests) }, { merge: true });

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

// Export helper function for use by other modules
module.exports = {
    updateAllLiveScores: exports.updateAllLiveScores,
    setLiveScoringStatus: exports.setLiveScoringStatus,
    performFullUpdate
};
