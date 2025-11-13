// functions/stats-rankings/performance-rankings.js

const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const { getCollectionName, LEAGUES } = require('../utils/firebase-helpers');

// Ensure admin is initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

const db = admin.firestore();

/**
 * Performs a single-performance leaderboard update for a given league
 * Updates both regular season and postseason single-game leaderboards
 * @param {string} league - League context (major or minor)
 */
async function performPerformanceRankingUpdate(league = LEAGUES.MAJOR) {
    console.log(`Starting single-performance leaderboard update for ${league} league...`);
    const activeSeasonSnap = await db.collection(getCollectionName('seasons', league)).where('status', '==', 'active').limit(1).get();
    if (activeSeasonSnap.empty) {
        console.log(`No active season found for ${league} league. Aborting performance leaderboard update.`);
        return;
    }
    const seasonId = activeSeasonSnap.docs[0].id;

    const lineupsRef = db.collection(getCollectionName('seasons', league)).doc(seasonId).collection(getCollectionName('lineups', league));
    const postLineupsRef = db.collection(getCollectionName('seasons', league)).doc(seasonId).collection(getCollectionName('post_lineups', league));

    const [lineupsSnap, postLineupsSnap] = await Promise.all([
        lineupsRef.get(),
        postLineupsRef.get()
    ]);

    const batch = db.batch();

    if (!lineupsSnap.empty) {
        const regularSeasonPerformances = lineupsSnap.docs.map(d => d.data());

        const karmaLeaderboard = [...regularSeasonPerformances]
            .sort((a, b) => (b.points_adjusted || 0) - (a.points_adjusted || 0))
            .slice(0, 250);

        const rankLeaderboard = [...regularSeasonPerformances]
            .filter(p => (p.global_rank || 0) > 0)
            .sort((a, b) => (a.global_rank || 999) - (b.global_rank || 999))
            .slice(0, 250);

        const leaderboardsCollection = getCollectionName('leaderboards', league);

        const karmaDocRef = db.collection(leaderboardsCollection).doc('single_game_karma');
        const rankDocRef = db.collection(leaderboardsCollection).doc('single_game_rank');
        batch.set(karmaDocRef, { description: "Regular season single game karma leaderboard." }, { merge: true });
        batch.set(rankDocRef, { description: "Regular season single game rank leaderboard." }, { merge: true });


        const karmaLeaderboardRef = karmaDocRef.collection(seasonId).doc('data');
        const rankLeaderboardRef = rankDocRef.collection(seasonId).doc('data');

        batch.set(karmaLeaderboardRef, { rankings: karmaLeaderboard });
        batch.set(rankLeaderboardRef, { rankings: rankLeaderboard });

        console.log(`Regular season single-performance leaderboards updated for ${league} league, season ${seasonId}.`);
    } else {
        console.log(`No regular season performances found for season ${seasonId}. Skipping regular season leaderboard update.`);
    }

    if (!postLineupsSnap.empty) {
        const postseasonPerformances = postLineupsSnap.docs.map(d => d.data());

        const postKarmaLeaderboard = [...postseasonPerformances]
            .sort((a, b) => (b.points_adjusted || 0) - (a.points_adjusted || 0))
            .slice(0, 250);

        const postRankLeaderboard = [...postseasonPerformances]
            .filter(p => (p.global_rank || 0) > 0)
            .sort((a, b) => (a.global_rank || 999) - (b.global_rank || 999))
            .slice(0, 250);

        const postLeaderboardsCollection = getCollectionName('post_leaderboards', league);

        const postKarmaDocRef = db.collection(postLeaderboardsCollection).doc('post_single_game_karma');
        const postRankDocRef = db.collection(postLeaderboardsCollection).doc('post_single_game_rank');
        batch.set(postKarmaDocRef, { description: "Postseason single game karma leaderboard." }, { merge: true });
        batch.set(postRankDocRef, { description: "Postseason single game rank leaderboard." }, { merge: true });

        const postKarmaLeaderboardRef = postKarmaDocRef.collection(seasonId).doc('data');
        const postRankLeaderboardRef = postRankDocRef.collection(seasonId).doc('data');

        batch.set(postKarmaLeaderboardRef, { rankings: postKarmaLeaderboard });
        batch.set(postRankLeaderboardRef, { rankings: postRankLeaderboard });

        console.log(`Postseason single-performance leaderboards updated for ${league} league, season ${seasonId}.`);
    } else {
        console.log(`No postseason performances found for season ${seasonId}. Skipping postseason leaderboard update.`);
    }

    await batch.commit();
    console.log("Single-performance leaderboard update process complete.");
}

/**
 * Scheduled function to update performance leaderboards for all leagues
 * Runs daily at 5:15 AM CT
 */
exports.updatePerformanceLeaderboards = onSchedule({
    schedule: "15 5 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    console.log("Running scheduled performance leaderboard update for all leagues...");
    // Process leaderboard updates for both leagues
    for (const league of Object.values(LEAGUES)) {
        await performPerformanceRankingUpdate(league);
    }
    console.log("Performance leaderboard update completed for all leagues.");
    return null;
});

/**
 * Scheduled function to update performance leaderboards for minor league only
 * Runs daily at 5:15 AM CT
 */
exports.minor_updatePerformanceLeaderboards = onSchedule({
    schedule: "15 5 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    console.log("Running scheduled performance leaderboard update for minor league...");
    await performPerformanceRankingUpdate(LEAGUES.MINOR);
    console.log("Minor league performance leaderboard update completed.");
    return null;
});

module.exports = {
    ...exports,
    performPerformanceRankingUpdate
};
