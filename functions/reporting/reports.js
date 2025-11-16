// functions/reporting/reports.js

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require("../utils/firebase-admin");
const { getCollectionName, getLeagueFromRequest, LEAGUES } = require('../utils/firebase-helpers');
const { isScorekeeperOrAdmin } = require('../utils/auth-helpers');

/**
 * Gets report data for scorekeepers
 * Supports different report types: deadline, voteGOTD, lineups_prepare
 */
exports.getReportData = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
    if (!(await isScorekeeperOrAdmin(request.auth, league))) {
        throw new HttpsError('permission-denied', 'Must be an admin or scorekeeper to access reports.');
    }

    const { reportType, seasonId, date } = request.data;
    if (!reportType || !seasonId) {
        throw new HttpsError('invalid-argument', 'Missing reportType or seasonId.');
    }

    try {
        const teamRecordsQuery = db.collectionGroup(getCollectionName('seasonal_records', league)).where('season', '==', seasonId);
        const teamRecordsSnap = await teamRecordsQuery.get();
        const teamDataMap = new Map();
        teamRecordsSnap.forEach(doc => {
            const data = doc.data();
            teamDataMap.set(data.team_id, {
                name: data.team_name,
                record: `${data.wins || 0}-${data.losses || 0}`
            });
        });

        if (reportType === 'deadline' || reportType === 'voteGOTD') {
            if (!date) throw new HttpsError('invalid-argument', 'A date is required for this report.');

            const seasonRef = db.collection(getCollectionName('seasons', league)).doc(seasonId);

            // Create queries for all three game types
            const regGamesQuery = seasonRef.collection(getCollectionName('games', league)).where('date', '==', date);
            const postGamesQuery = seasonRef.collection(getCollectionName('post_games', league)).where('date', '==', date);
            const exGamesQuery = seasonRef.collection(getCollectionName('exhibition_games', league)).where('date', '==', date);

            // Fetch all games concurrently
            const [regGamesSnap, postGamesSnap, exGamesSnap] = await Promise.all([
                regGamesQuery.get(),
                postGamesQuery.get(),
                exGamesQuery.get()
            ]);

            // Combine the results from all snapshots
            const allGamesDocs = [...regGamesSnap.docs, ...postGamesSnap.docs, ...exGamesSnap.docs];

            const games = allGamesDocs.map(doc => {
                const game = doc.data();
                const team1 = teamDataMap.get(game.team1_id) || { name: game.team1_id, record: '?-?' };
                const team2 = teamDataMap.get(game.team2_id) || { name: game.team2_id, record: '?-?' };
                return {
                    team1_name: team1.name,
                    team2_name: team2.name,
                    team1_record: team1.record,
                    team2_record: team2.record,
                };
            });
            return { success: true, league, games };
        }

        if (reportType === 'lineups_prepare') {
            const liveGamesSnap = await db.collection(getCollectionName('live_games', league)).get();
            if (liveGamesSnap.empty) {
                return { success: true, league, games: [] };
            }
            const gamesPromises = liveGamesSnap.docs.map(async (doc) => {
                const liveGame = doc.data();
                const originalGameRef = db.doc(`${getCollectionName('seasons', league)}/${seasonId}/${getCollectionName(liveGame.collectionName, league)}/${doc.id}`);
                const originalGameSnap = await originalGameRef.get();

                let team1_id, team2_id, originalGameData;
                if (originalGameSnap.exists) {
                    originalGameData = originalGameSnap.data();
                    team1_id = originalGameData.team1_id;
                    team2_id = originalGameData.team2_id;
                } else {
                    console.warn(`Could not find original game doc for live game ${doc.id}`);
                    return null;
                }

                const team1 = teamDataMap.get(team1_id) || { name: `Team ${team1_id}`, record: '?-?' };
                const team2 = teamDataMap.get(team2_id) || { name: `Team ${team2_id}`, record: '?-?' };

                return {
                    gameId: doc.id,
                    collectionName: getCollectionName(liveGame.collectionName, league),
                    team1_name: team1.name,
                    team2_name: team2.name,
                    team1_record: team1.record,
                    team2_record: team2.record,
                    team1_lineup: liveGame.team1_lineup,
                    team2_lineup: liveGame.team2_lineup,
                    // Include postseason-specific fields if available
                    series_name: originalGameData.series_name || null,
                    team1_seed: originalGameData.team1_seed || null,
                    team2_seed: originalGameData.team2_seed || null,
                    team1_wins: originalGameData.team1_wins || null,
                    team2_wins: originalGameData.team2_wins || null
                };
            });

            const games = (await Promise.all(gamesPromises)).filter(g => g !== null);
            return { success: true, league, games };
        }

        throw new HttpsError('invalid-argument', 'Unknown report type specified.');

    } catch (error) {
        console.error(`Error generating report '${reportType}':`, error);
        throw new HttpsError('internal', `Failed to generate report: ${error.message}`);
    }
});

// Export Cloud Function
module.exports.getReportData = exports.getReportData;
