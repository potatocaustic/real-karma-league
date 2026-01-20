// functions/seasons/schedules.js

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require("../utils/firebase-admin");
const { getCollectionName, getLeagueFromRequest } = require('../utils/firebase-helpers');

/**
 * Validates the postseason dates structure
 * @param {Object} dates - The dates object to validate
 * @returns {Object} - { valid: boolean, error?: string }
 */
function validatePostseasonDates(dates) {
    const requiredRounds = {
        'Play-In': 2,
        'Round 1': 3,
        'Round 2': 3,
        'Conf Finals': 5,
        'Finals': 7
    };

    for (const [round, requiredCount] of Object.entries(requiredRounds)) {
        if (!dates[round] || !Array.isArray(dates[round])) {
            return { valid: false, error: `Missing dates for ${round}` };
        }
        if (dates[round].length < requiredCount) {
            return { valid: false, error: `${round} requires ${requiredCount} dates, got ${dates[round].length}` };
        }
    }
    return { valid: true };
}

/**
 * Saves postseason dates configuration to be used for automatic schedule generation
 * Admin-only function.
 */
exports.savePostseasonDates = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
    if (!request.auth || !request.auth.uid) {
        throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }

    const { seasonId, dates, autoGenerateEnabled } = request.data;
    if (!seasonId || !dates) {
        throw new HttpsError('invalid-argument', 'Missing seasonId or dates.');
    }

    // Validate dates structure
    const validation = validatePostseasonDates(dates);
    if (!validation.valid) {
        throw new HttpsError('invalid-argument', validation.error);
    }

    console.log(`Saving postseason dates for ${seasonId} (${league} league)`);

    try {
        const seasonRef = db.collection(getCollectionName('seasons', league)).doc(seasonId);
        const seasonDoc = await seasonRef.get();

        if (!seasonDoc.exists) {
            throw new HttpsError('not-found', `Season ${seasonId} not found.`);
        }

        // Get existing config to preserve scheduleGenerated status
        const existingConfig = seasonDoc.data().postseasonConfig || {};

        const postseasonConfig = {
            dates,
            autoGenerateEnabled: autoGenerateEnabled !== false, // Default to true
            savedAt: admin.firestore.FieldValue.serverTimestamp(),
            savedBy: request.auth.uid,
            scheduleGenerated: existingConfig.scheduleGenerated || false,
            scheduleGeneratedAt: existingConfig.scheduleGeneratedAt || null,
            lastAutoGenerateError: existingConfig.lastAutoGenerateError || null
        };

        await seasonRef.update({ postseasonConfig });

        console.log(`Postseason dates saved for ${seasonId}`);
        return { success: true, league, message: "Postseason dates saved successfully!" };

    } catch (error) {
        console.error("Error saving postseason dates:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError('internal', `Failed to save dates: ${error.message}`);
    }
});

/**
 * Core logic for generating postseason games
 * Used by both manual generation and auto-generation
 * @param {string} seasonId - Season ID
 * @param {Object} dates - Dates configuration
 * @param {string} league - League context ('major' or 'minor')
 * @param {Array} [preCalculatedTeamStats] - Optional pre-calculated team stats with postseeds (used to avoid race conditions)
 * @returns {Object} - { success: boolean, message?: string, error?: string }
 */
async function generatePostseasonGamesCore(seasonId, dates, league, preCalculatedTeamStats = null) {
    console.log(`[Core] Generating postseason schedule for ${seasonId} (${league} league)`);

    let teamRecords;

    if (preCalculatedTeamStats && preCalculatedTeamStats.length > 0) {
        // Use pre-calculated stats passed from the caller (avoids race condition with batch commit)
        console.log(`[Core] Using ${preCalculatedTeamStats.length} pre-calculated team stats`);

        // Fetch team base data to merge with pre-calculated stats
        const teamsRef = db.collection(getCollectionName('v2_teams', league));
        const teamsSnap = await teamsRef.get();
        const teamBaseData = new Map(teamsSnap.docs.map(doc => [doc.id, { id: doc.id, ...doc.data() }]));

        // Merge base team data with pre-calculated stats
        teamRecords = preCalculatedTeamStats.map(stats => ({
            ...teamBaseData.get(stats.teamId),
            ...stats,
            id: stats.teamId  // Ensure id is set
        }));
    } else {
        // Read from database (for manual generation or when no pre-calculated data provided)
        const teamsRef = db.collection(getCollectionName('v2_teams', league));
        const teamsSnap = await teamsRef.get();
        const allTeams = teamsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        teamRecords = await Promise.all(allTeams.map(async (team) => {
            const recordRef = db.doc(`${getCollectionName('v2_teams', league)}/${team.id}/${getCollectionName('seasonal_records', league)}/${seasonId}`);
            const recordSnap = await recordRef.get();
            return { ...team, ...recordSnap.data() };
        }));
    }

    // Use league-specific conference names
    const conferences = league === 'minor'
        ? { primary: 'Northern', secondary: 'Southern' }
        : { primary: 'Eastern', secondary: 'Western' };

    const eastConf = teamRecords.filter(t => t.conference === conferences.primary && t.postseed).sort((a, b) => a.postseed - b.postseed);
    const westConf = teamRecords.filter(t => t.conference === conferences.secondary && t.postseed).sort((a, b) => a.postseed - b.postseed);

    if (eastConf.length < 10 || westConf.length < 10) {
        return { success: false, error: 'Not all teams have a final postseed. Ensure the regular season is complete.' };
    }

    const batch = db.batch();
    const postGamesRef = db.collection(`${getCollectionName('seasons', league)}/${seasonId}/${getCollectionName('post_games', league)}`);

    const existingGamesSnap = await postGamesRef.get();
    existingGamesSnap.forEach(doc => batch.delete(doc.ref));
    console.log(`[Core] Cleared ${existingGamesSnap.size} existing postseason games.`);

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

    console.log("[Core] Generating Play-In games...");
    createSeries('Play-In', 'E7vE8', 1, eastConf[6], eastConf[7], [dates['Play-In'][0]]);
    createSeries('Play-In', 'W7vW8', 1, westConf[6], westConf[7], [dates['Play-In'][0]]);
    createSeries('Play-In', 'E9vE10', 1, eastConf[8], eastConf[9], [dates['Play-In'][0]]);
    createSeries('Play-In', 'W9vW10', 1, westConf[8], westConf[9], [dates['Play-In'][0]]);
    createSeries('Play-In', 'E8thSeedGame', 1, TBD_TEAM, TBD_TEAM, [dates['Play-In'][1]]);
    createSeries('Play-In', 'W8thSeedGame', 1, TBD_TEAM, TBD_TEAM, [dates['Play-In'][1]]);

    console.log("[Core] Generating Round 1 schedule...");
    createSeries('Round 1', 'E1vE8', 3, eastConf[0], TBD_TEAM, dates['Round 1']);
    createSeries('Round 1', 'E4vE5', 3, eastConf[3], eastConf[4], dates['Round 1']);
    createSeries('Round 1', 'E3vE6', 3, eastConf[2], eastConf[5], dates['Round 1']);
    createSeries('Round 1', 'E2vE7', 3, eastConf[1], TBD_TEAM, dates['Round 1']);
    createSeries('Round 1', 'W1vW8', 3, westConf[0], TBD_TEAM, dates['Round 1']);
    createSeries('Round 1', 'W4vW5', 3, westConf[3], westConf[4], dates['Round 1']);
    createSeries('Round 1', 'W3vW6', 3, westConf[2], westConf[5], dates['Round 1']);
    createSeries('Round 1', 'W2vW7', 3, westConf[1], TBD_TEAM, dates['Round 1']);

    console.log("[Core] Generating Round 2 schedule...");
    createSeries('Round 2', 'E-R2-T', 3, TBD_TEAM, TBD_TEAM, dates['Round 2']);
    createSeries('Round 2', 'E-R2-B', 3, TBD_TEAM, TBD_TEAM, dates['Round 2']);
    createSeries('Round 2', 'W-R2-T', 3, TBD_TEAM, TBD_TEAM, dates['Round 2']);
    createSeries('Round 2', 'W-R2-B', 3, TBD_TEAM, TBD_TEAM, dates['Round 2']);

    console.log("[Core] Generating Conference Finals schedule...");
    createSeries('Conf Finals', 'ECF', 5, TBD_TEAM, TBD_TEAM, dates['Conf Finals']);
    createSeries('Conf Finals', 'WCF', 5, TBD_TEAM, TBD_TEAM, dates['Conf Finals']);

    console.log("[Core] Generating Finals schedule...");
    createSeries('Finals', 'Finals', 7, TBD_TEAM, TBD_TEAM, dates['Finals']);

    await batch.commit();
    return { success: true, message: "Postseason schedule generated successfully!" };
}

/**
 * Auto-generates the postseason schedule when the regular season completes
 * Called internally from stats-helpers when isRegularSeasonComplete is detected
 * @param {string} seasonId - Season ID
 * @param {string} league - League context ('major' or 'minor')
 * @param {Array} [preCalculatedTeamStats] - Optional pre-calculated team stats with postseeds (avoids race condition)
 */
async function autoGeneratePostseasonSchedule(seasonId, league, preCalculatedTeamStats = null) {
    console.log(`[Auto] Checking postseason auto-generation for ${seasonId} (${league} league)`);

    const seasonRef = db.collection(getCollectionName('seasons', league)).doc(seasonId);
    const seasonDoc = await seasonRef.get();

    if (!seasonDoc.exists) {
        console.log(`[Auto] Season ${seasonId} not found. Skipping auto-generation.`);
        return { success: false, error: 'Season not found' };
    }

    const postseasonConfig = seasonDoc.data().postseasonConfig;

    // Check if config exists
    if (!postseasonConfig || !postseasonConfig.dates) {
        console.log(`[Auto] No postseason dates configured for ${seasonId}. Skipping auto-generation.`);
        return { success: false, error: 'No postseason dates configured' };
    }

    // Check if auto-generation is enabled
    if (postseasonConfig.autoGenerateEnabled === false) {
        console.log(`[Auto] Auto-generation disabled for ${seasonId}. Skipping.`);
        return { success: false, error: 'Auto-generation disabled' };
    }

    // Check if already generated
    if (postseasonConfig.scheduleGenerated) {
        console.log(`[Auto] Schedule already generated for ${seasonId}. Skipping.`);
        return { success: false, error: 'Schedule already generated' };
    }

    console.log(`[Auto] Triggering automatic postseason schedule generation for ${seasonId}`);
    if (preCalculatedTeamStats) {
        console.log(`[Auto] Using ${preCalculatedTeamStats.length} pre-calculated team stats to avoid race condition`);
    }

    try {
        const result = await generatePostseasonGamesCore(seasonId, postseasonConfig.dates, league, preCalculatedTeamStats);

        if (result.success) {
            // Update the config to mark as generated
            await seasonRef.update({
                'postseasonConfig.scheduleGenerated': true,
                'postseasonConfig.scheduleGeneratedAt': admin.firestore.FieldValue.serverTimestamp(),
                'postseasonConfig.lastAutoGenerateError': null
            });
            console.log(`[Auto] Postseason schedule auto-generated successfully for ${seasonId}`);
        } else {
            // Store the error
            await seasonRef.update({
                'postseasonConfig.lastAutoGenerateError': result.error
            });
            console.error(`[Auto] Failed to auto-generate schedule: ${result.error}`);
        }

        return result;

    } catch (error) {
        console.error(`[Auto] Error during auto-generation for ${seasonId}:`, error);
        await seasonRef.update({
            'postseasonConfig.lastAutoGenerateError': error.message
        });
        return { success: false, error: error.message };
    }
}

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
        const result = await generatePostseasonGamesCore(seasonId, dates, league);

        if (!result.success) {
            throw new HttpsError('failed-precondition', result.error);
        }

        // Mark as generated in the config if it exists
        const seasonRef = db.collection(getCollectionName('seasons', league)).doc(seasonId);
        const seasonDoc = await seasonRef.get();
        if (seasonDoc.exists && seasonDoc.data().postseasonConfig) {
            await seasonRef.update({
                'postseasonConfig.scheduleGenerated': true,
                'postseasonConfig.scheduleGeneratedAt': admin.firestore.FieldValue.serverTimestamp(),
                'postseasonConfig.lastAutoGenerateError': null
            });
        }

        return { success: true, league, message: result.message };

    } catch (error) {
        console.error("Error generating postseason schedule:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError('internal', `Failed to generate schedule: ${error.message}`);
    }
});

// Export internal function for use by stats-helpers
exports.autoGeneratePostseasonSchedule = autoGeneratePostseasonSchedule;
