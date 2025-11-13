// functions/seasons/schedules.js

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getCollectionName, getLeagueFromRequest } = require('../utils/firebase-helpers');

// Ensure admin is initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

const db = admin.firestore();

/**
 * Generates the complete postseason schedule for a season
 * Creates all Play-In, Round 1, Round 2, Conference Finals, and Finals games
 * Admin-only function.
 */
exports.generatePostseasonSchedule = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
    if (!request.auth || !request.auth.uid) {
        throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const { seasonId, dates } = request.data;
    if (!seasonId || !dates) {
        throw new HttpsError('invalid-argument', 'Missing seasonId or dates.');
    }

    console.log(`Generating postseason schedule for ${seasonId}`);

    try {
        const teamsRef = db.collection(getCollectionName('v2_teams', league));
        const teamsSnap = await teamsRef.get();
        const allTeams = teamsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        const teamRecords = await Promise.all(allTeams.map(async (team) => {
            const recordRef = db.doc(`${getCollectionName('v2_teams', league)}/${team.id}/${getCollectionName('seasonal_records', league)}/${seasonId}`);
            const recordSnap = await recordRef.get();
            return { ...team, ...recordSnap.data() };
        }));

        const eastConf = teamRecords.filter(t => t.conference === 'Eastern' && t.postseed).sort((a, b) => a.postseed - b.postseed);
        const westConf = teamRecords.filter(t => t.conference === 'Western' && t.postseed).sort((a, b) => a.postseed - b.postseed);

        if (eastConf.length < 10 || westConf.length < 10) {
            throw new HttpsError('failed-precondition', 'Not all teams have a final postseed. Ensure the regular season is complete.');
        }

        const batch = db.batch();
        const postGamesRef = db.collection(`${getCollectionName('seasons', league)}/${seasonId}/${getCollectionName('post_games', league)}`);

        const existingGamesSnap = await postGamesRef.get();
        existingGamesSnap.forEach(doc => batch.delete(doc.ref));
        console.log(`Cleared ${existingGamesSnap.size} existing postseason games.`);

        const TBD_TEAM = { id: 'TBD', team_name: 'TBD', postseed: '' };

        const createSeries = (week, seriesName, numGames, team1, team2, dateArray) => {
            if (!dateArray || dateArray.length < numGames) {
                throw new Error(`Not enough dates provided for ${week} (${seriesName}). Expected ${numGames}, got ${dateArray?.length || 0}.`);
            }
            const series_id = seriesName;

            for (let i = 0; i < numGames; i++) {
                const gameDate = dateArray[i];
                const gameData = {
                    week,
                    series_name: `${seriesName} Game ${i + 1}`,
                    date: gameDate,
                    team1_id: team1.id,
                    team2_id: team2.id,
                    team1_seed: team1.postseed || '',
                    team2_seed: team2.postseed || '',
                    completed: 'FALSE',
                    team1_score: 0,
                    team2_score: 0,
                    winner: '',
                    series_id: series_id,
                    team1_wins: 0,
                    team2_wins: 0,
                    series_winner: ''
                };

                const formattedDateForId = gameDate.replace(/\//g, "-");
                const docRef = (team1.id === 'TBD' || team2.id === 'TBD')
                    ? postGamesRef.doc()
                    : postGamesRef.doc(`${formattedDateForId}-${team1.id}-${team2.id}`);
                batch.set(docRef, gameData);
            }
        };

        console.log("Generating Play-In games...");
        createSeries('Play-In', 'E7vE8', 1, eastConf[6], eastConf[7], [dates['Play-In'][0]]);
        createSeries('Play-In', 'W7vW8', 1, westConf[6], westConf[7], [dates['Play-In'][0]]);
        createSeries('Play-In', 'E9vE10', 1, eastConf[8], eastConf[9], [dates['Play-In'][0]]);
        createSeries('Play-In', 'W9vW10', 1, westConf[8], westConf[9], [dates['Play-In'][0]]);
        createSeries('Play-In', 'E8thSeedGame', 1, TBD_TEAM, TBD_TEAM, [dates['Play-In'][1]]);
        createSeries('Play-In', 'W8thSeedGame', 1, TBD_TEAM, TBD_TEAM, [dates['Play-In'][1]]);

        console.log("Generating Round 1 schedule...");
        createSeries('Round 1', 'E1vE8', 3, eastConf[0], TBD_TEAM, dates['Round 1']);
        createSeries('Round 1', 'E4vE5', 3, eastConf[3], eastConf[4], dates['Round 1']);
        createSeries('Round 1', 'E3vE6', 3, eastConf[2], eastConf[5], dates['Round 1']);
        createSeries('Round 1', 'E2vE7', 3, eastConf[1], TBD_TEAM, dates['Round 1']);
        createSeries('Round 1', 'W1vW8', 3, westConf[0], TBD_TEAM, dates['Round 1']);
        createSeries('Round 1', 'W4vW5', 3, westConf[3], westConf[4], dates['Round 1']);
        createSeries('Round 1', 'W3vW6', 3, westConf[2], westConf[5], dates['Round 1']);
        createSeries('Round 1', 'W2vW7', 3, westConf[1], TBD_TEAM, dates['Round 1']);

        console.log("Generating Round 2 schedule...");
        createSeries('Round 2', 'E-R2-T', 3, TBD_TEAM, TBD_TEAM, dates['Round 2']);
        createSeries('Round 2', 'E-R2-B', 3, TBD_TEAM, TBD_TEAM, dates['Round 2']);
        createSeries('Round 2', 'W-R2-T', 3, TBD_TEAM, TBD_TEAM, dates['Round 2']);
        createSeries('Round 2', 'W-R2-B', 3, TBD_TEAM, TBD_TEAM, dates['Round 2']);

        console.log("Generating Conference Finals schedule...");
        createSeries('Conf Finals', 'ECF', 5, TBD_TEAM, TBD_TEAM, dates['Conf Finals']);
        createSeries('Conf Finals', 'WCF', 5, TBD_TEAM, TBD_TEAM, dates['Conf Finals']);

        console.log("Generating Finals schedule...");
        createSeries('Finals', 'Finals', 7, TBD_TEAM, TBD_TEAM, dates['Finals']);

        await batch.commit();
        return { success: true, league, message: "Postseason schedule generated successfully!" };

    } catch (error) {
        console.error("Error generating postseason schedule:", error);
        throw new HttpsError('internal', `Failed to generate schedule: ${error.message}`);
    }
});
