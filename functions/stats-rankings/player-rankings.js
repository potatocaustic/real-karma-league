// functions/stats-rankings/player-rankings.js

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { performPlayerRankingUpdate } = require('../utils/ranking-helpers');
const { LEAGUES } = require('../utils/firebase-helpers');

/**
 * Scheduled function to update player rankings for all leagues
 * Runs daily at 5:15 AM CT
 */
exports.updatePlayerRanks = onSchedule({
    schedule: "15 5 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    console.log("Running scheduled player ranking update for all leagues...");
    // Process ranking updates for both leagues
    for (const league of Object.values(LEAGUES)) {
        await performPlayerRankingUpdate(league);
    }
    console.log("Player ranking update completed for all leagues.");
    return null;
});

/**
 * Scheduled function to update player rankings for minor league only
 * Runs daily at 5:15 AM CT
 */
exports.minor_updatePlayerRanks = onSchedule({
    schedule: "15 5 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    console.log("Running scheduled player ranking update for minor league...");
    await performPlayerRankingUpdate(LEAGUES.MINOR);
    console.log("Minor league player ranking update completed.");
    return null;
});
