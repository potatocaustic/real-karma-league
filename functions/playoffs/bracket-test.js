// functions/playoffs/bracket-test.js

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require("../utils/firebase-admin");
const { getCollectionName, getLeagueFromRequest, LEAGUES } = require('../utils/firebase-helpers');
const { advanceBracket } = require('./bracket-advancement');
const { processAndFinalizeGame } = require('../live-scoring/live-games');

/**
 * Test function to manually trigger playoff bracket updates
 * Admin-only callable function
 * Processes the most recent completed postseason games for bracket advancement
 */
exports.test_updatePlayoffBracket = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    console.log("Running ON-DEMAND job to update playoff bracket for testing.");

    const activeSeasonSnap = await db.collection(getCollectionName('seasons', league)).where('status', '==', 'active').limit(1).get();
    if (activeSeasonSnap.empty) {
        throw new HttpsError('failed-precondition', 'No active season found.');
    }
    const seasonId = activeSeasonSnap.docs[0].id;
    const postGamesRef = db.collection(`${getCollectionName('seasons', league)}/${seasonId}/${getCollectionName('post_games', league)}`);

    const mostRecentGameQuery = postGamesRef.where('completed', '==', 'TRUE').orderBy(admin.firestore.FieldPath.documentId(), 'desc').limit(1);

    const mostRecentGameSnap = await mostRecentGameQuery.get();

    if (mostRecentGameSnap.empty) {
        return { success: true, league, message: "No completed postseason games found to process." };
    }
    const mostRecentDate = mostRecentGameSnap.docs[0].data().date;
    console.log(`Found most recent completed game date: ${mostRecentDate}`);

    const gamesToProcessSnap = await postGamesRef.where('date', '==', mostRecentDate).where('completed', '==', 'TRUE').get();

    console.log(`Processing ${gamesToProcessSnap.size} games from ${mostRecentDate} for bracket advancement.`);
    await advanceBracket(gamesToProcessSnap.docs, postGamesRef, league);

    console.log("On-demand playoff bracket update job finished.");
    return { success: true, league, message: `Processed ${gamesToProcessSnap.size} games from ${mostRecentDate}.` };
});

/**
 * Test function to manually trigger auto-finalization of all live games
 * Admin-only callable function
 * Finalizes all games currently in the live_games collection
 */
exports.test_autoFinalizeGames = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    console.log(`Manual trigger received for auto-finalization by admin: ${request.auth.uid}`);
    try {
        const liveGamesSnap = await db.collection(getCollectionName('live_games', league)).get();

        if (liveGamesSnap.empty) {
            console.log("No live games found to auto-finalize.");
            return { success: true, league, message: "No live games found to auto-finalize." };
        }

        console.log(`Found ${liveGamesSnap.size} games to auto-finalize.`);
        const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        for (const gameDoc of liveGamesSnap.docs) {
            try {
                const randomGameDelay = Math.floor(Math.random() * 201) + 200;
                await delay(randomGameDelay);

                console.log(`Manually auto-finalizing game ${gameDoc.id} after a ${randomGameDelay}ms delay.`);
                await processAndFinalizeGame(gameDoc, true, league);
                console.log(`Successfully auto-finalized game ${gameDoc.id}.`);

            } catch (error) {
                console.error(`Failed to auto-finalize game ${gameDoc.id}:`, error);
            }
        }

        console.log("Manual auto-finalization job completed.");
        return { success: true, league, message: `Successfully processed ${liveGamesSnap.size} games.` };

    } catch (error) {
        console.error("Error during manual auto-finalization test:", error);
        throw new HttpsError('internal', `An unexpected error occurred: ${error.message}`);
    }
});
