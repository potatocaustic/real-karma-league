// functions/live-scoring/live-processor.js

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { admin, db } = require('../utils/firebase-admin');
const { FieldValue } = require("firebase-admin/firestore");
const { getCollectionName, LEAGUES } = require('../utils/firebase-helpers');
const { processAndFinalizeGame } = require('./live-games');

/**
 * Scheduled job to process pending live games for major league
 * Runs daily at 6:15 AM CST
 * Activates games where both teams have submitted lineups
 */
exports.processPendingLiveGames = onSchedule({
    schedule: "15 6 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    console.log("Running scheduled job to process pending live games.");

    const today = new Date();
    const dateString = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;

    const pendingGamesQuery = db.collection(getCollectionName('pending_lineups'))
        .where('gameDate', '==', dateString)
        .where('team1_submitted', '==', true)
        .where('team2_submitted', '==', true);

    try {
        const pendingGamesSnap = await pendingGamesQuery.get();
        if (pendingGamesSnap.empty) {
            console.log(`No pending games with both lineups submitted for ${dateString}.`);
            return null;
        }

        console.log(`Found ${pendingGamesSnap.size} games to activate for live scoring.`);
        const activationBatch = db.batch();

        for (const doc of pendingGamesSnap.docs) {
            const gameId = doc.id;
            const data = doc.data();

            const liveGameRef = db.collection(getCollectionName('live_games')).doc(gameId);
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
        console.log("Successfully activated and cleared pending games.");

    } catch (error) {
        console.error("Error during scheduled processing of pending games:", error);
    }
    return null;
});

/**
 * Scheduled job to process pending live games for minor league
 * Runs daily at 6:15 AM CST
 * Activates games where both teams have submitted lineups
 */
exports.minor_processPendingLiveGames = onSchedule({
    schedule: "15 6 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    console.log("Running scheduled job to process pending live games (Minor League).");

    const today = new Date();
    const dateString = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;

    const pendingGamesQuery = db.collection(getCollectionName('pending_lineups', LEAGUES.MINOR))
        .where('gameDate', '==', dateString)
        .where('team1_submitted', '==', true)
        .where('team2_submitted', '==', true);

    try {
        const pendingGamesSnap = await pendingGamesQuery.get();
        if (pendingGamesSnap.empty) {
            console.log(`Minor League: No pending games with both lineups submitted for ${dateString}.`);
            return null;
        }

        console.log(`Minor League: Found ${pendingGamesSnap.size} games to activate for live scoring.`);
        const activationBatch = db.batch();

        for (const doc of pendingGamesSnap.docs) {
            const gameId = doc.id;
            const data = doc.data();

            const liveGameRef = db.collection(getCollectionName('live_games', LEAGUES.MINOR)).doc(gameId);
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
        console.log("Minor League: Successfully activated and cleared pending games.");

    } catch (error) {
        console.error("Minor League: Error during scheduled processing of pending games:", error);
    }
    return null;
});

/**
 * Scheduled job to auto-finalize games
 * Runs daily at 5:00 AM CST for all leagues
 * Fetches final scores and writes them to season collections
 */
exports.autoFinalizeGames = onSchedule({
    schedule: "every day 05:00",
    timeZone: "America/Chicago",
}, async (event) => {
    console.log("Running scheduled job to auto-finalize games.");

    // Process games for both leagues
    for (const league of Object.values(LEAGUES)) {
        console.log(`Processing auto-finalization for ${league} league...`);
        const liveGamesSnap = await db.collection(getCollectionName('live_games', league)).get();

        if (liveGamesSnap.empty) {
            console.log(`No live games found to auto-finalize for ${league} league.`);
            continue;
        }

        console.log(`Found ${liveGamesSnap.size} games to auto-finalize for ${league} league.`);

        const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        for (const gameDoc of liveGamesSnap.docs) {
            try {
                const randomGameDelay = Math.floor(Math.random() * 201) + 200;
                await delay(randomGameDelay);

                console.log(`Auto-finalizing game ${gameDoc.id} for ${league} league after a ${randomGameDelay}ms delay.`);
                await processAndFinalizeGame(gameDoc, true, league);
                console.log(`Successfully auto-finalized game ${gameDoc.id} for ${league} league.`);

            } catch (error) {
                console.error(`Failed to auto-finalize game ${gameDoc.id} for ${league} league:`, error);
                await gameDoc.ref.update({ status: 'AUTO_FINALIZE_FAILED', error: error.message });
            }
        }
    }

    console.log("Auto-finalization job completed for all leagues.");
    return null;
});

/**
 * Scheduled job to auto-finalize games for minor league
 * Runs daily at 5:00 AM CST
 * Fetches final scores and writes them to season collections
 */
exports.minor_autoFinalizeGames = onSchedule({
    schedule: "every day 05:00",
    timeZone: "America/Chicago",
}, async (event) => {
    console.log("Running scheduled job to auto-finalize games (Minor League).");

    const league = LEAGUES.MINOR;
    console.log(`Processing auto-finalization for ${league} league...`);
    const liveGamesSnap = await db.collection(getCollectionName('live_games', league)).get();

    if (liveGamesSnap.empty) {
        console.log(`No live games found to auto-finalize for ${league} league.`);
        return null;
    }

    console.log(`Found ${liveGamesSnap.size} games to auto-finalize for ${league} league.`);

    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    for (const gameDoc of liveGamesSnap.docs) {
        try {
            const randomGameDelay = Math.floor(Math.random() * 201) + 200;
            await delay(randomGameDelay);

            console.log(`Auto-finalizing game ${gameDoc.id} for ${league} league after a ${randomGameDelay}ms delay.`);
            await processAndFinalizeGame(gameDoc, true, league);
            console.log(`Successfully auto-finalized game ${gameDoc.id} for ${league} league.`);

        } catch (error) {
            console.error(`Failed to auto-finalize game ${gameDoc.id} for ${league} league:`, error);
            await gameDoc.ref.update({ status: 'AUTO_FINALIZE_FAILED', error: error.message });
        }
    }

    console.log("Auto-finalization job completed for minor league.");
    return null;
});

// Export Cloud Functions
module.exports.processPendingLiveGames = exports.processPendingLiveGames;
module.exports.minor_processPendingLiveGames = exports.minor_processPendingLiveGames;
module.exports.autoFinalizeGames = exports.autoFinalizeGames;
module.exports.minor_autoFinalizeGames = exports.minor_autoFinalizeGames;
