// functions/playoffs/bracket.js

const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const { getCollectionName, LEAGUES } = require('../utils/firebase-helpers');
const { advanceBracket } = require('./bracket-advancement');

// Ensure admin is initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

const db = admin.firestore();

/**
 * Performs the playoff bracket update logic for a specific league and game date
 * @param {string} gameDateStr - The game date in M/D/YYYY format
 * @param {string} league - League context (major or minor)
 */
async function performBracketUpdate(gameDateStr, league = LEAGUES.MAJOR) {
    console.log(`Running logic to update playoff bracket for ${league} league on ${gameDateStr}...`);
    const activeSeasonSnap = await db.collection(getCollectionName('seasons', league)).where('status', '==', 'active').limit(1).get();
    if (activeSeasonSnap.empty) {
        console.log(`No active season found for ${league} league. Exiting bracket update.`);
        return;
    }
    const seasonId = activeSeasonSnap.docs[0].id;
    const postGamesRef = db.collection(`${getCollectionName('seasons', league)}/${seasonId}/${getCollectionName('post_games', league)}`);

    const gamesPlayedSnap = await postGamesRef.where('date', '==', gameDateStr).where('completed', '==', 'TRUE').get();
    if (gamesPlayedSnap.empty) {
        console.log(`No completed postseason games were played on ${gameDateStr} for ${league} league. Exiting bracket update.`);
        return;
    }
    console.log(`Processing ${gamesPlayedSnap.size} games from ${gameDateStr} for ${league} league bracket advancement.`);
    await advanceBracket(gamesPlayedSnap.docs, postGamesRef, league);
}

/**
 * Scheduled function to update playoff brackets for all leagues
 * Processes games from yesterday
 * Runs daily at 5:15 AM CT
 */
exports.updatePlayoffBracket = onSchedule({
    schedule: "15 5 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    console.log("Running daily job to update playoff bracket for all leagues...");
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = `${yesterday.getMonth() + 1}/${yesterday.getDate()}/${yesterday.getFullYear()}`;

    // Process playoff bracket updates for both leagues
    for (const league of Object.values(LEAGUES)) {
        console.log(`Processing playoff bracket for ${league} league...`);
        await performBracketUpdate(yesterdayStr, league);
    }

    console.log("Playoff bracket update job finished for all leagues.");
    return null;
});

/**
 * Scheduled function to update playoff bracket for minor league only
 * Processes games from yesterday
 * Runs daily at 5:15 AM CT
 */
exports.minor_updatePlayoffBracket = onSchedule({
    schedule: "15 5 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    console.log("Running daily job to update playoff bracket for minor league...");
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = `${yesterday.getMonth() + 1}/${yesterday.getDate()}/${yesterday.getFullYear()}`;

    console.log(`Processing playoff bracket for minor league...`);
    await performBracketUpdate(yesterdayStr, LEAGUES.MINOR);

    console.log("Minor league playoff bracket update job finished.");
    return null;
});

module.exports = {
    ...exports,
    performBracketUpdate
};
