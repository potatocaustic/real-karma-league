// functions/live-scoring/scoring-scheduler.js

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const { admin, db } = require('../utils/firebase-admin');
const { FieldValue } = require("firebase-admin/firestore");
const fetch = require("node-fetch");
const { getCollectionName, LEAGUES } = require('../utils/firebase-helpers');
const { performFullUpdate } = require('./live-status');

/**
 * Scheduled sampler for major league
 * Runs every minute and samples 3 random players to detect score changes
 * Triggers a full update if significant changes are detected
 */
exports.scheduledSampler = onSchedule("every 1 minutes", async (event) => {
    const statusRef = db.doc(getCollectionName('live_scoring_status') + '/status');
    const statusSnap = await statusRef.get();

    if (!statusSnap.exists || statusSnap.data().status !== 'active') {
        console.log(`Sampler is not active (current status: ${statusSnap.data().status || 'stopped'}). Exiting.`);
        return null;
    }

    const { interval_minutes, last_sample_completed_at } = statusSnap.data();
    const now = new Date();

    if (!last_sample_completed_at || now.getTime() >= last_sample_completed_at.toDate().getTime() + (interval_minutes * 60 * 1000)) {

        console.log(`Interval of ${interval_minutes} minutes has passed. Performing sample.`);
        const gameDate = statusSnap.data().active_game_date;

        const liveGamesSnap = await db.collection(getCollectionName('live_games')).get();
        if (liveGamesSnap.empty) {
            console.log("No live games to sample. Stopping.");
            return null;
        }

        const allStarters = liveGamesSnap.docs.flatMap(doc => [...doc.data().team1_lineup, ...doc.data().team2_lineup]);
        if (allStarters.length < 3) {
            console.log("Not enough players to sample (< 3).");
            return null;
        }

        const sampledPlayers = [];
        const usedIndices = new Set();
        while (sampledPlayers.length < 3 && usedIndices.size < allStarters.length) {
            const randomIndex = Math.floor(Math.random() * allStarters.length);
            if (!usedIndices.has(randomIndex)) {
                sampledPlayers.push(allStarters[randomIndex]);
                usedIndices.add(randomIndex);
            }
        }

        let karmaChangesDetected = 0;
        let rankChangesDetected = 0;
        let apiRequests = 0;
        const sampleResults = [];

        for (const player of sampledPlayers) {
            const workerUrl = `https://rkl-karma-proxy.caustic.workers.dev/?userId=${encodeURIComponent(player.player_id)}`;
            await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 1001) + 500));

            try {
                const response = await fetch(workerUrl);
                apiRequests++;
                const data = await response.json();

                const newRawScore = parseFloat(data?.stats?.karmaDelta || 0);
                const newGlobalRank = parseInt(data?.stats?.karmaDayRank || -1, 10);

                const oldRawScore = player.points_raw || 0;
                const oldGlobalRank = player.global_rank || -1;

                const karmaHasChanged = newRawScore !== oldRawScore;
                const rankHasChanged = newGlobalRank !== oldGlobalRank;

                if (karmaHasChanged) karmaChangesDetected++;
                if (rankHasChanged) rankChangesDetected++;

                sampleResults.push({
                    handle: player.player_handle,
                    oldScore: oldRawScore,
                    newScore: newRawScore,
                    karmaChanged: karmaHasChanged,
                    oldRank: oldGlobalRank,
                    newRank: newGlobalRank,
                    rankChanged: rankHasChanged
                });

            } catch (error) { console.error(`Sampler failed to fetch karma for ${player.player_id}`, error); }
        }

        await statusRef.set({
            last_sample_results: sampleResults,
            last_sample_completed_at: FieldValue.serverTimestamp()
        }, { merge: true });

        const usageRef = db.doc(`${getCollectionName('usage_stats')}/${gameDate}`);
        await usageRef.set({ api_requests_sample: FieldValue.increment(apiRequests) }, { merge: true });

        if (karmaChangesDetected >= 2 || rankChangesDetected >= 2) {
            console.log(`Sampler detected changes (Karma: ${karmaChangesDetected}, Rank: ${rankChangesDetected}). Triggering full update.`);
            await performFullUpdate();
        } else {
            console.log(`Sampler detected insufficient changes (Karma: ${karmaChangesDetected}, Rank: ${rankChangesDetected}). No update triggered.`);
        }
    } else {
        return null;
    }
    return null;
});

/**
 * Scheduled sampler for minor league
 * Runs every minute and samples 3 random players to detect score changes
 * Triggers a full update if significant changes are detected
 */
exports.minor_scheduledSampler = onSchedule("every 1 minutes", async (event) => {
    const statusRef = db.doc(getCollectionName('live_scoring_status', LEAGUES.MINOR) + '/status');
    const statusSnap = await statusRef.get();

    if (!statusSnap.exists || statusSnap.data().status !== 'active') {
        console.log(`Minor league sampler is not active (current status: ${statusSnap.data().status || 'stopped'}). Exiting.`);
        return null;
    }

    const { interval_minutes, last_sample_completed_at } = statusSnap.data();
    const now = new Date();

    if (!last_sample_completed_at || now.getTime() >= last_sample_completed_at.toDate().getTime() + (interval_minutes * 60 * 1000)) {

        console.log(`Minor league: Interval of ${interval_minutes} minutes has passed. Performing sample.`);
        const gameDate = statusSnap.data().active_game_date;

        const liveGamesSnap = await db.collection(getCollectionName('live_games', LEAGUES.MINOR)).get();
        if (liveGamesSnap.empty) {
            console.log("Minor league: No live games to sample. Stopping.");
            return null;
        }

        const allStarters = liveGamesSnap.docs.flatMap(doc => [...doc.data().team1_lineup, ...doc.data().team2_lineup]);
        if (allStarters.length < 3) {
            console.log("Minor league: Not enough players to sample (< 3).");
            return null;
        }

        const sampledPlayers = [];
        const usedIndices = new Set();
        while (sampledPlayers.length < 3 && usedIndices.size < allStarters.length) {
            const randomIndex = Math.floor(Math.random() * allStarters.length);
            if (!usedIndices.has(randomIndex)) {
                sampledPlayers.push(allStarters[randomIndex]);
                usedIndices.add(randomIndex);
            }
        }

        let karmaChangesDetected = 0;
        let rankChangesDetected = 0;
        let apiRequests = 0;
        const sampleResults = [];

        for (const player of sampledPlayers) {
            const workerUrl = `https://rkl-karma-proxy.caustic.workers.dev/?userId=${encodeURIComponent(player.player_id)}`;
            await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 1001) + 500));

            try {
                const response = await fetch(workerUrl);
                apiRequests++;
                const data = await response.json();

                const newRawScore = parseFloat(data?.stats?.karmaDelta || 0);
                const newGlobalRank = parseInt(data?.stats?.karmaDayRank || -1, 10);

                const oldRawScore = player.points_raw || 0;
                const oldGlobalRank = player.global_rank || -1;

                const karmaHasChanged = newRawScore !== oldRawScore;
                const rankHasChanged = newGlobalRank !== oldGlobalRank;

                if (karmaHasChanged) karmaChangesDetected++;
                if (rankHasChanged) rankChangesDetected++;

                sampleResults.push({
                    handle: player.player_handle,
                    oldScore: oldRawScore,
                    newScore: newRawScore,
                    karmaChanged: karmaHasChanged,
                    oldRank: oldGlobalRank,
                    newRank: newGlobalRank,
                    rankChanged: rankHasChanged
                });

            } catch (error) { console.error(`Minor league sampler failed to fetch karma for ${player.player_id}`, error); }
        }

        await statusRef.set({
            last_sample_results: sampleResults,
            last_sample_completed_at: FieldValue.serverTimestamp()
        }, { merge: true });

        const usageRef = db.doc(`${getCollectionName('usage_stats', LEAGUES.MINOR)}/${gameDate}`);
        await usageRef.set({ api_requests_sample: FieldValue.increment(apiRequests) }, { merge: true });

        if (karmaChangesDetected >= 2 || rankChangesDetected >= 2) {
            console.log(`Minor league sampler detected changes (Karma: ${karmaChangesDetected}, Rank: ${rankChangesDetected}). Triggering full update.`);
            await performFullUpdate(LEAGUES.MINOR);
        } else {
            console.log(`Minor league sampler detected insufficient changes (Karma: ${karmaChangesDetected}, Rank: ${rankChangesDetected}). No update triggered.`);
        }
    } else {
        return null;
    }
    return null;
});

/**
 * Scheduled live scoring start for major league
 * Triggered by Pub/Sub message to automatically start live scoring
 */
exports.scheduledLiveScoringStart = onMessagePublished("start-live-scoring-topic", async (event) => {
    console.log("Received trigger to automatically start live scoring.");

    const payload = event.data.message.data ? JSON.parse(Buffer.from(event.data.message.data, 'base64').toString()) : null;
    if (!payload || !payload.gameDate) {
        console.error("Pub/Sub message payload did not contain a 'gameDate'. Aborting auto-start.");
        return null;
    }
    const { gameDate } = payload;
    console.log(`Processing auto-start for game date: ${gameDate}`);

    const statusRef = db.doc(`${getCollectionName('live_scoring_status')}/status`);
    const statusSnap = await statusRef.get();

    if (statusSnap.exists && statusSnap.data().status === 'active') {
        console.log("Live scoring is already active. No action needed.");
        return null;
    }

    const liveGamesSnap = await db.collection(getCollectionName('live_games')).get();
    if (liveGamesSnap.empty) {
        console.log("No games have been activated in the 'live_games' collection. Aborting automatic start of live scoring.");
        return null;
    }

    try {
        const interval = statusSnap.exists ? statusSnap.data().interval_minutes || 5 : 5;

        console.log(`Setting live scoring status to 'active' for date ${gameDate} with a ${interval}-minute interval.`);
        await statusRef.set({
            status: 'active',
            updated_by: 'automated_startup',
            last_updated: FieldValue.serverTimestamp(),
            interval_minutes: interval,
            active_game_date: gameDate,
            last_sample_completed_at: FieldValue.serverTimestamp()
        }, { merge: true });

        const usageRef = db.doc(`${getCollectionName('usage_stats')}/${gameDate}`);
        await usageRef.set({ live_game_count: liveGamesSnap.size }, { merge: true });

        console.log("Status set to 'active'. Performing initial full score update.");
        await performFullUpdate();
        console.log("Automated live scoring start process completed successfully.");
        return null;
    } catch (error) {
        console.error("CRITICAL ERROR during automated start of live scoring:", error);
        await statusRef.set({ status: 'stopped', error: `Auto-start failed: ${error.message}` }, { merge: true });
        return null;
    }
});

/**
 * Scheduled live scoring start for minor league
 * Triggered by Pub/Sub message to automatically start live scoring
 */
exports.minor_scheduledLiveScoringStart = onMessagePublished("minor-start-live-scoring-topic", async (event) => {
    console.log("Received trigger to automatically start live scoring (Minor League).");

    const payload = event.data.message.data ? JSON.parse(Buffer.from(event.data.message.data, 'base64').toString()) : null;
    if (!payload || !payload.gameDate) {
        console.error("Minor League: Pub/Sub message payload did not contain a 'gameDate'. Aborting auto-start.");
        return null;
    }
    const { gameDate } = payload;
    console.log(`Minor League: Processing auto-start for game date: ${gameDate}`);

    const statusRef = db.doc(`${getCollectionName('live_scoring_status', LEAGUES.MINOR)}/status`);
    const statusSnap = await statusRef.get();

    if (statusSnap.exists && statusSnap.data().status === 'active') {
        console.log("Minor League: Live scoring is already active. No action needed.");
        return null;
    }

    const liveGamesSnap = await db.collection(getCollectionName('live_games', LEAGUES.MINOR)).get();
    if (liveGamesSnap.empty) {
        console.log("Minor League: No games have been activated in the 'live_games' collection. Aborting automatic start of live scoring.");
        return null;
    }

    try {
        const interval = statusSnap.exists ? statusSnap.data().interval_minutes || 5 : 5;

        console.log(`Minor League: Setting live scoring status to 'active' for date ${gameDate} with a ${interval}-minute interval.`);
        await statusRef.set({
            status: 'active',
            updated_by: 'automated_startup',
            last_updated: FieldValue.serverTimestamp(),
            interval_minutes: interval,
            active_game_date: gameDate,
            last_sample_completed_at: FieldValue.serverTimestamp()
        }, { merge: true });

        const usageRef = db.doc(`${getCollectionName('usage_stats', LEAGUES.MINOR)}/${gameDate}`);
        await usageRef.set({ live_game_count: liveGamesSnap.size }, { merge: true });

        console.log("Minor League: Status set to 'active'. Performing initial full score update.");
        await performFullUpdate(LEAGUES.MINOR);
        console.log("Minor League: Automated live scoring start process completed successfully.");
        return null;
    } catch (error) {
        console.error("Minor League: CRITICAL ERROR during automated start of live scoring:", error);
        await statusRef.set({ status: 'stopped', error: `Auto-start failed: ${error.message}` }, { merge: true });
        return null;
    }
});

/**
 * Scheduled live scoring shutdown for major league
 * Runs at 5:15 AM CST daily to stop live scoring
 */
exports.scheduledLiveScoringShutdown = onSchedule({
    schedule: "15 5 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    console.log("Running scheduled job to set live scoring status to 'stopped'.");

    try {
        const statusRef = db.doc(`${getCollectionName('live_scoring_status')}/status`);

        await statusRef.set({
            status: 'stopped',
            last_updated_by: 'automated_shutdown',
            last_updated: FieldValue.serverTimestamp()
        }, { merge: true });

        console.log("Successfully set live scoring status to 'stopped'.");

    } catch (error) {
        console.error("Error during scheduled shutdown of live scoring:", error);
    }

    return null;
});

/**
 * Scheduled live scoring shutdown for minor league
 * Runs at 5:15 AM CST daily to stop live scoring
 */
exports.minor_scheduledLiveScoringShutdown = onSchedule({
    schedule: "15 5 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    console.log("Running scheduled job to set live scoring status to 'stopped' (Minor League).");

    try {
        const statusRef = db.doc(`${getCollectionName('live_scoring_status', LEAGUES.MINOR)}/status`);

        await statusRef.set({
            status: 'stopped',
            last_updated_by: 'automated_shutdown',
            last_updated: FieldValue.serverTimestamp()
        }, { merge: true });

        console.log("Minor League: Successfully set live scoring status to 'stopped'.");

    } catch (error) {
        console.error("Minor League: Error during scheduled shutdown of live scoring:", error);
    }

    return null;
});

// Export Cloud Functions
module.exports.scheduledSampler = exports.scheduledSampler;
module.exports.minor_scheduledSampler = exports.minor_scheduledSampler;
module.exports.scheduledLiveScoringStart = exports.scheduledLiveScoringStart;
module.exports.minor_scheduledLiveScoringStart = exports.minor_scheduledLiveScoringStart;
module.exports.scheduledLiveScoringShutdown = exports.scheduledLiveScoringShutdown;
module.exports.minor_scheduledLiveScoringShutdown = exports.minor_scheduledLiveScoringShutdown;
