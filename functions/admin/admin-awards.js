// functions/admin/admin-awards.js

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require("../utils/firebase-admin");
const { getCollectionName, getLeagueFromRequest } = require('../utils/firebase-helpers');

/**
 * Calculates and saves performance awards for a given season.
 * Identifies best individual player performance and best team performance based on % above median.
 * Admin-only function.
 */
exports.calculatePerformanceAwards = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
    if (!request.auth || !request.auth.uid) {
        throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const { seasonId } = request.data;
    if (!seasonId) {
        throw new HttpsError('invalid-argument', 'The function must be called with a "seasonId" argument.');
    }

    console.log(`Calculating performance awards for season: ${seasonId}`);
    const seasonNumber = seasonId.replace('S', '');

    try {
        const batch = db.batch();

        const awardsParentDocRef = db.doc(`${getCollectionName('awards', league)}/season_${seasonNumber}`);
        batch.set(awardsParentDocRef, { description: `Awards for Season ${seasonNumber}` }, { merge: true });

        const awardsCollectionRef = awardsParentDocRef.collection(getCollectionName(`S${seasonNumber}_awards`, league));

        const lineupsRef = db.collection(`${getCollectionName('seasons', league)}/${seasonId}/${getCollectionName('lineups', league)}`);
        const bestPlayerQuery = lineupsRef.orderBy('pct_above_median', 'desc').limit(1);
        const bestPlayerSnap = await bestPlayerQuery.get();

        if (!bestPlayerSnap.empty) {
            const bestPlayerPerf = bestPlayerSnap.docs[0].data();
            const awardData = {
                award_name: "Best Performance (Player)",
                player_id: bestPlayerPerf.player_id,
                player_handle: bestPlayerPerf.player_handle,
                team_id: bestPlayerPerf.team_id,
                date: bestPlayerPerf.date,
                value: bestPlayerPerf.pct_above_median
            };
            batch.set(awardsCollectionRef.doc('best_performance_player'), awardData);
        }

        const dailyScoresRef = db.collection(`${getCollectionName('daily_scores', league)}/season_${seasonNumber}/${getCollectionName(`S${seasonNumber}_daily_scores`, league)}`);
        const bestTeamQuery = dailyScoresRef.orderBy('pct_above_median', 'desc').limit(1);
        const bestTeamSnap = await bestTeamQuery.get();

        if (!bestTeamSnap.empty) {
            const bestTeamPerf = bestTeamSnap.docs[0].data();
            const teamRecordRef = db.doc(`${getCollectionName('v2_teams', league)}/${bestTeamPerf.team_id}/${getCollectionName('seasonal_records', league)}/${seasonId}`);
            const teamRecordSnap = await teamRecordRef.get();
            const awardData = {
                award_name: "Best Performance (Team)",
                team_id: bestTeamPerf.team_id,
                team_name: teamRecordSnap.exists ? teamRecordSnap.data().team_name : 'Unknown',
                date: bestTeamPerf.date,
                value: bestTeamPerf.pct_above_median
            };
            batch.set(awardsCollectionRef.doc('best_performance_team'), awardData);
        }

        await batch.commit();
        console.log("Successfully calculated and saved performance awards.");
        return { success: true, league, message: "Performance awards calculated and saved successfully!" };

    } catch (error) {
        console.error("Error calculating performance awards:", error);
        throw new HttpsError('internal', 'Failed to calculate performance awards.');
    }
});
