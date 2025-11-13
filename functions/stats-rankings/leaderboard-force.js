// functions/stats-rankings/leaderboard-force.js

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require("../utils/firebase-admin");
const { getCollectionName, getLeagueFromRequest } = require('../utils/firebase-helpers');
const { performPlayerRankingUpdate } = require('../utils/ranking-helpers');
const { performPerformanceRankingUpdate } = require('./performance-rankings');

/**
 * Admin-only callable function to force recalculation of all leaderboards
 * Recalculates both player rankings and performance leaderboards
 */
exports.forceLeaderboardRecalculation = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    try {
        await performPlayerRankingUpdate(league);
        await performPerformanceRankingUpdate(league);
        return { success: true, league, message: "All leaderboards have been recalculated." };
    } catch (error) {
        console.error("Manual leaderboard recalculation failed:", error);
        throw new HttpsError('internal', 'An error occurred during leaderboard recalculation.');
    }
});
