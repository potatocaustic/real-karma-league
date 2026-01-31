// functions/seasons/week-management.js

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require("../utils/firebase-admin");
const { getCollectionName, getLeagueFromRequest, LEAGUES } = require('../utils/firebase-helpers');

/**
 * Helper function to perform week update logic for a specific league
 * @param {string} league - League context (major or minor)
 */
async function performWeekUpdate(league = LEAGUES.MAJOR) {
    console.log(`Running logic to update current week for ${league} league...`);
    try {
        const seasonsRef = db.collection(getCollectionName('seasons', league));
        const activeSeasonQuery = seasonsRef.where("status", "==", "active").limit(1);
        const activeSeasonSnap = await activeSeasonQuery.get();

        if (activeSeasonSnap.empty) {
            console.log(`No active season found for ${league} league. Exiting week update.`);
            return;
        }

        const activeSeasonDoc = activeSeasonSnap.docs[0];
        const seasonId = activeSeasonDoc.id;
        console.log(`Active season is ${seasonId} for ${league} league. Checking for next incomplete game.`);

        let nextGameWeek = null;

        const findEarliestGame = (snapshot) => {
            if (snapshot.empty) {
                return null;
            }
            let earliestGame = null;
            let earliestDate = null;

            snapshot.docs.forEach(doc => {
                const gameData = doc.data();
                const gameDate = new Date(gameData.date);
                if (!earliestDate || gameDate < earliestDate) {
                    earliestDate = gameDate;
                    earliestGame = gameData;
                }
            });
            return earliestGame;
        };

        const gamesRef = activeSeasonDoc.ref.collection(getCollectionName('games', league));
        const incompleteGamesQuery = gamesRef.where('completed', '==', 'FALSE');
        const incompleteGamesSnap = await incompleteGamesQuery.get();

        const earliestRegularSeasonGame = findEarliestGame(incompleteGamesSnap);

        if (earliestRegularSeasonGame) {
            nextGameWeek = earliestRegularSeasonGame.week;
        } else {
            console.log(`No incomplete regular season games found for ${league} league. Checking postseason...`);
            const postGamesRef = activeSeasonDoc.ref.collection(getCollectionName('post_games', league));
            const incompletePostGamesQuery = postGamesRef.where('completed', '==', 'FALSE');
            const incompletePostGamesSnap = await incompletePostGamesQuery.get();

            const earliestPostseasonGame = findEarliestGame(incompletePostGamesSnap);

            if (earliestPostseasonGame) {
                nextGameWeek = earliestPostseasonGame.week;
            }
        }

        if (nextGameWeek !== null) {
            console.log(`The next game is in week/round: '${nextGameWeek}' for ${league} league. Updating season document.`);
            await activeSeasonDoc.ref.set({
                current_week: String(nextGameWeek)
            }, { merge: true });
        } else {
            // No incomplete games found. Check if we're at the beginning of the season or the end.
            // Get all regular season games to determine the season state
            const allGamesSnap = await gamesRef.get();

            // Filter out placeholder/invalid documents (those without a valid completed field)
            const validGames = allGamesSnap.docs.filter(doc => {
                const completed = doc.data().completed;
                return completed === 'TRUE' || completed === 'FALSE';
            });

            console.log(`Found ${allGamesSnap.size} total documents, ${validGames.length} valid games for ${league} league.`);

            if (validGames.length === 0) {
                // No valid games scheduled at all - beginning of season
                console.log(`No valid games scheduled yet for ${league} league. Defaulting to Week 1.`);
                await activeSeasonDoc.ref.set({
                    current_week: "1"
                }, { merge: true });
            } else {
                // There are games. Check if they're all completed or if this is a data issue
                const allCompleted = validGames.every(doc => doc.data().completed === 'TRUE');
                // Check for week 1 games using both formats: 'Week 1' and '1'
                const hasWeek1Games = validGames.some(doc => {
                    const week = doc.data().week;
                    return week === 'Week 1' || week === '1';
                });

                console.log(`All games completed: ${allCompleted}, Has Week 1 games: ${hasWeek1Games}`);

                if (allCompleted && hasWeek1Games) {
                    // Regular season has been played, check postseason status
                    const postGamesRef = activeSeasonDoc.ref.collection(getCollectionName('post_games', league));
                    const allPostGamesSnap = await postGamesRef.limit(2).get();

                    if (allPostGamesSnap.size > 1) {
                        console.log("No incomplete games found anywhere. Postseason is complete. Setting current week to 'Season Complete'.");
                        await activeSeasonDoc.ref.set({
                            current_week: "Season Complete"
                        }, { merge: true });
                    } else {
                        console.log("Regular season complete. Awaiting postseason schedule generation.");
                        await activeSeasonDoc.ref.set({
                            current_week: "End of Regular Season"
                        }, { merge: true });
                    }
                } else if (!hasWeek1Games) {
                    // No Week 1 games exist yet - this is the beginning of the season
                    console.log(`No Week 1 games found. Season hasn't started yet. Defaulting to Week 1.`);
                    await activeSeasonDoc.ref.set({
                        current_week: "1"
                    }, { merge: true });
                } else {
                    // Has Week 1 games but some are not completed - something is wrong
                    // This shouldn't happen as we already checked for incomplete games above
                    console.log(`Unexpected state: Has Week 1 games but not all complete. Defaulting to Week 1.`);
                    await activeSeasonDoc.ref.set({
                        current_week: "1"
                    }, { merge: true });
                }
            }
        }
        console.log("Successfully updated the current week.");
    } catch (error) {
        console.error("Error updating current week:", error);
        throw error;
    }
}

/**
 * Scheduled function that runs daily at 5:15 AM Chicago time
 * Updates the current week for major league
 */
exports.updateCurrentWeek = onSchedule({
    schedule: "15 5 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    console.log("Running scheduled week update for major league...");
    await performWeekUpdate(LEAGUES.MAJOR);
    console.log("Major league week update completed.");
    return null;
});

/**
 * Scheduled function that runs daily at 5:15 AM Chicago time
 * Updates the current week for minor league
 */
exports.minor_updateCurrentWeek = onSchedule({
    schedule: "15 5 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    console.log("Running scheduled week update for minor league...");
    await performWeekUpdate(LEAGUES.MINOR);
    console.log("Minor league week update completed.");
    return null;
});

/**
 * Manually triggers a week update for a specific league
 * Admin-only function.
 */
exports.forceWeekUpdate = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    try {
        await performWeekUpdate(league);
        return { success: true, league, message: "Current week has been updated." };
    } catch (error) {
        console.error("Manual week update failed:", error);
        throw new HttpsError('internal', 'An error occurred during week update.');
    }
});

// Export helper function for use by other modules
module.exports.performWeekUpdate = performWeekUpdate;
