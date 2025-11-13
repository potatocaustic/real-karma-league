// functions/live-scoring/live-games.js

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require('../utils/firebase-admin');
const { FieldValue } = require("firebase-admin/firestore");
const fetch = require("node-fetch");
const { getCollectionName, getLeagueFromRequest, LEAGUES } = require('../utils/firebase-helpers');

/**
 * Helper function to process and finalize a game
 * @param {object} liveGameSnap - Firestore document snapshot of the live game
 * @param {boolean} isAutoFinalize - Whether this is an automated finalization
 * @param {string} league - League context ('major' or 'minor')
 */
async function processAndFinalizeGame(liveGameSnap, isAutoFinalize = false, league = LEAGUES.MAJOR) {
    const gameId = liveGameSnap.id;
    const liveGameData = liveGameSnap.data();
    const { seasonId, collectionName, team1_lineup, team2_lineup } = liveGameData;

    console.log(`Processing and finalizing game ${gameId} for ${league} league...`);

    const allPlayersInGame = [...team1_lineup, ...team2_lineup];
    const playerDocs = await db.collection(getCollectionName('v2_players', league)).get();
    const allPlayersMap = new Map(playerDocs.docs.map(doc => [doc.id, doc.data()]));

    const batch = db.batch();
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const finalScoresMap = new Map();
    for (const player of allPlayersInGame) {
        if (isAutoFinalize) {
            const randomPlayerDelay = Math.floor(Math.random() * 201) + 200;
            await delay(randomPlayerDelay);
        }

        const workerUrl = `https://rkl-karma-proxy.caustic.workers.dev/?userId=${encodeURIComponent(player.player_id)}`;
        try {
            const response = await fetch(workerUrl);
            const data = await response.json();
            finalScoresMap.set(player.player_id, {
                raw_score: parseFloat(data?.stats?.karmaDelta || 0),
                global_rank: parseInt(data?.stats?.karmaDayRank || -1, 10)
            });
        } catch (e) {
            console.error(`Failed to fetch final karma for ${player.player_id}, using 0.`);
            finalScoresMap.set(player.player_id, { raw_score: 0, global_rank: 0 });
        }
    }

    const gameRef = db.doc(`${getCollectionName('seasons', league)}/${seasonId}/${getCollectionName(collectionName, league)}/${gameId}`);
    const gameSnap = await gameRef.get();
    const gameData = gameSnap.data();
    let team1FinalScore = 0;
    let team2FinalScore = 0;

    const lineupsCollectionName = collectionName.replace('games', 'lineups');
    const lineupsCollectionRef = db.collection(getCollectionName('seasons', league)).doc(seasonId).collection(getCollectionName(lineupsCollectionName, league));

    for (const player of allPlayersInGame) {
        const finalScores = finalScoresMap.get(player.player_id);
        const raw_score = finalScores.raw_score;
        const adjustments = player.deductions || 0;
        const points_adjusted = raw_score - adjustments;
        let final_score = points_adjusted;
        if (player.is_captain) {
            final_score *= 1.5;
        }

        if (team1_lineup.some(p => p.player_id === player.player_id)) {
            team1FinalScore += final_score;
        } else {
            team2FinalScore += final_score;
        }

        const playerInfo = allPlayersMap.get(player.player_id);
        const lineupId = `${gameId}-${player.player_id}`;
        const lineupDocRef = lineupsCollectionRef.doc(lineupId);

        const lineupData = {
            player_id: player.player_id,
            player_handle: playerInfo?.player_handle || 'Unknown',
            team_id: gameData.team1_id,
            game_id: gameId,
            date: gameData.date,
            week: gameData.week,
            game_type: collectionName === 'post_games' ? 'postseason' : (collectionName === 'exhibition_games' ? 'exhibition' : 'regular'),
            started: 'TRUE',
            is_captain: player.is_captain ? 'TRUE' : 'FALSE',
            raw_score,
            adjustments,
            points_adjusted,
            final_score,
            global_rank: finalScores.global_rank
        };

        if (team1_lineup.some(p => p.player_id === player.player_id)) {
            lineupData.team_id = gameData.team1_id;
        } else {
            lineupData.team_id = gameData.team2_id;
        }

        batch.set(lineupDocRef, lineupData, { merge: true });
    }

    batch.update(gameRef, {
        team1_score: team1FinalScore,
        team2_score: team2FinalScore,
        completed: 'TRUE',
        winner: team1FinalScore > team2FinalScore ? gameData.team1_id : (team2FinalScore > team1FinalScore ? gameData.team2_id : '')
    });

    batch.delete(liveGameSnap.ref);

    await batch.commit();
}

/**
 * Activates a game for live scoring
 * Moves a game from pending_lineups to live_games
 */
exports.activateLiveGame = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
    if (!request.auth || !request.auth.uid) {
        throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }

    const { gameId, seasonId, collectionName, team1_lineup, team2_lineup } = request.data;
    if (!gameId || !seasonId || !collectionName || !team1_lineup || !team2_lineup) {
        throw new HttpsError('invalid-argument', 'Missing required parameters for activating a live game.');
    }

    try {
        // Use a batch to perform an atomic write and delete
        const batch = db.batch();

        // Set the new document in the live_games collection
        const liveGameRef = db.collection(getCollectionName('live_games', league)).doc(gameId);
        batch.set(liveGameRef, {
            seasonId,
            collectionName,
            team1_lineup,
            team2_lineup,
            activatedAt: FieldValue.serverTimestamp()
        });

        // Delete the now-obsolete document from the pending_lineups collection
        const pendingGameRef = db.collection(getCollectionName('pending_lineups', league)).doc(gameId);
        batch.delete(pendingGameRef);

        // Commit both operations
        await batch.commit();

        return { success: true, league, message: "Game activated for live scoring and pending entry was cleared." };
    } catch (error) {
        console.error(`Error activating live game ${gameId}:`, error);
        throw new HttpsError('internal', 'Could not activate live game.');
    }
});

/**
 * Finalizes a live game
 * Fetches final scores and writes them to the appropriate season collections
 */
exports.finalizeLiveGame = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
    if (!request.auth || !request.auth.uid) {
        throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }

    const { gameId } = request.data;
    if (!gameId) {
        throw new HttpsError('invalid-argument', 'A gameId must be provided.');
    }

    try {
        const liveGameRef = db.collection(getCollectionName('live_games', league)).doc(gameId);
        const liveGameSnap = await liveGameRef.get();

        if (!liveGameSnap.exists) {
            throw new HttpsError('not-found', 'The specified game is not currently live.');
        }

        await processAndFinalizeGame(liveGameSnap, false, league);

        return { success: true, league, message: `Game ${gameId} has been successfully finalized and scores have been written.` };

    } catch (error) {
        console.error(`Error finalizing game ${gameId}:`, error);
        if (error instanceof HttpsError) {
            throw error;
        }
        throw new HttpsError('internal', `An unexpected error occurred while finalizing the game: ${error.message}`);
    }
});

/**
 * Gets live karma score for a player
 * Fetches current karma delta and rank from the proxy worker
 */
exports.getLiveKarma = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }

    const playerHandle = request.data.playerHandle;
    if (!playerHandle) {
        throw new HttpsError('invalid-argument', 'The function must be called with a "playerHandle" argument.');
    }

    const workerUrl = `https://rkl-karma-proxy.caustic.workers.dev/?userId=${encodeURIComponent(playerHandle)}`;

    try {
        const response = await fetch(workerUrl);

        if (!response.ok) {
            console.error(`Failed to fetch karma for ${playerHandle} via worker. Status: ${response.status}`);
            return { karmaDelta: 0, karmaDayRank: -1 };
        }
        const data = await response.json();

        const karmaDelta = parseFloat(data?.stats?.karmaDelta || 0);
        const karmaDayRank = parseInt(data?.stats?.karmaDayRank || -1, 10);

        return {
            league,
            karmaDelta: isNaN(karmaDelta) ? 0 : karmaDelta,
            karmaDayRank: isNaN(karmaDayRank) ? -1 : karmaDayRank,
        };

    } catch (error) {
        console.error(`Exception while fetching karma for ${playerHandle}:`, error);
        throw new HttpsError('internal', 'Failed to fetch live score data.');
    }
});

// Export helper function for use by other modules
module.exports = {
    activateLiveGame: exports.activateLiveGame,
    finalizeLiveGame: exports.finalizeLiveGame,
    getLiveKarma: exports.getLiveKarma,
    processAndFinalizeGame
};
