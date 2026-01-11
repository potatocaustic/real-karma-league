// functions/live-scoring/live-processor.js

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { admin, db } = require('../utils/firebase-admin');
const { FieldValue } = require("firebase-admin/firestore");
const { getCollectionName, LEAGUES } = require('../utils/firebase-helpers');
const { processAndFinalizeGame } = require('./live-games');

/**
 * Core logic to process pending live games - shared between major and minor leagues
 * Activates games where both teams have submitted lineups
 * @param {string} league - League context ('major' or 'minor')
 */
async function runProcessPendingLiveGames(league) {
    const leagueLabel = league === LEAGUES.MINOR ? 'Minor League' : 'Major League';
    console.log(`${leagueLabel}: Running scheduled job to process pending live games.`);

    const today = new Date();
    const dateString = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;

    const pendingGamesQuery = db.collection(getCollectionName('pending_lineups', league))
        .where('gameDate', '==', dateString)
        .where('team1_submitted', '==', true)
        .where('team2_submitted', '==', true);

    try {
        const pendingGamesSnap = await pendingGamesQuery.get();
        if (pendingGamesSnap.empty) {
            console.log(`${leagueLabel}: No pending games with both lineups submitted for ${dateString}.`);
            return null;
        }

        console.log(`${leagueLabel}: Found ${pendingGamesSnap.size} games to activate for live scoring.`);
        const activationBatch = db.batch();

        for (const doc of pendingGamesSnap.docs) {
            const gameId = doc.id;
            const data = doc.data();

            const liveGameRef = db.collection(getCollectionName('live_games', league)).doc(gameId);
            activationBatch.set(liveGameRef, {
                seasonId: data.seasonId,
                collectionName: data.collectionName,
                team1_lineup: data.team1_lineup,
                team2_lineup: data.team2_lineup,
                activatedAt: FieldValue.serverTimestamp()
            });

            activationBatch.delete(doc.ref);
        }

        await activationBatch.commit();
        console.log(`${leagueLabel}: Successfully activated and cleared pending games.`);

    } catch (error) {
        console.error(`${leagueLabel}: Error during scheduled processing of pending games:`, error);
    }
    return null;
}

/**
 * Core logic to auto-finalize games - shared between major and minor leagues
 * Fetches final scores and writes them to season collections
 * @param {string} league - League context ('major' or 'minor')
 */
async function runAutoFinalizeGames(league) {
    const leagueLabel = league === LEAGUES.MINOR ? 'Minor League' : 'Major League';
    console.log(`${leagueLabel}: Running scheduled job to auto-finalize games.`);

    const liveGamesSnap = await db.collection(getCollectionName('live_games', league)).get();

    if (liveGamesSnap.empty) {
        console.log(`${leagueLabel}: No live games found to auto-finalize.`);
        return null;
    }

    console.log(`${leagueLabel}: Found ${liveGamesSnap.size} games to auto-finalize.`);

    // Process games with controlled concurrency (2 at a time) instead of sequential with delays
    const CONCURRENCY = 2;
    const games = liveGamesSnap.docs;

    for (let i = 0; i < games.length; i += CONCURRENCY) {
        const batch = games.slice(i, i + CONCURRENCY);

        const batchPromises = batch.map(async (gameDoc) => {
            try {
                console.log(`${leagueLabel}: Auto-finalizing game ${gameDoc.id}.`);
                await processAndFinalizeGame(gameDoc, true, league);
                console.log(`${leagueLabel}: Successfully auto-finalized game ${gameDoc.id}.`);
                return { success: true, gameId: gameDoc.id };
            } catch (error) {
                console.error(`${leagueLabel}: Failed to auto-finalize game ${gameDoc.id}:`, error);
                await gameDoc.ref.update({ status: 'AUTO_FINALIZE_FAILED', error: error.message });
                return { success: false, gameId: gameDoc.id, error };
            }
        });

        await Promise.all(batchPromises);

        // Small delay between batches
        if (i + CONCURRENCY < games.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    console.log(`${leagueLabel}: Auto-finalization job completed.`);
    return null;
}

// ============================================================================
// MAJOR LEAGUE EXPORTS
// ============================================================================

/**
 * Scheduled job to process pending live games for major league
 * Runs daily at 6:15 AM CST
 */
exports.processPendingLiveGames = onSchedule({
    schedule: "15 6 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    return await runProcessPendingLiveGames(LEAGUES.MAJOR);
});

/**
 * Scheduled job to auto-finalize games for major league
 * Runs daily at 5:00 AM CST
 */
exports.autoFinalizeGames = onSchedule({
    schedule: "every day 05:00",
    timeZone: "America/Chicago",
}, async (event) => {
    return await runAutoFinalizeGames(LEAGUES.MAJOR);
});

// ============================================================================
// MINOR LEAGUE EXPORTS
// ============================================================================

/**
 * Scheduled job to process pending live games for minor league
 * Runs daily at 6:15 AM CST
 */
exports.minor_processPendingLiveGames = onSchedule({
    schedule: "15 6 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    return await runProcessPendingLiveGames(LEAGUES.MINOR);
});

/**
 * Scheduled job to auto-finalize games for minor league
 * Runs daily at 5:00 AM CST
 */
exports.minor_autoFinalizeGames = onSchedule({
    schedule: "every day 05:00",
    timeZone: "America/Chicago",
}, async (event) => {
    return await runAutoFinalizeGames(LEAGUES.MINOR);
});

// Export Cloud Functions
module.exports.processPendingLiveGames = exports.processPendingLiveGames;
module.exports.minor_processPendingLiveGames = exports.minor_processPendingLiveGames;
module.exports.autoFinalizeGames = exports.autoFinalizeGames;
module.exports.minor_autoFinalizeGames = exports.minor_autoFinalizeGames;
