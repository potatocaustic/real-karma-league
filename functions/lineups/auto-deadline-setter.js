// functions/lineups/auto-deadline-setter.js

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require('../utils/firebase-admin');
const { FieldValue } = require("firebase-admin/firestore");
const { getCollectionName, getLeagueFromRequest } = require('../utils/firebase-helpers');
const fetch = require("node-fetch");

const API_BASE = 'https://schedule.tommyek67.workers.dev/';
const POLL_CHECK_API = 'https://has-polls.tomfconreal.workers.dev/';
const SPORTS = ['mlb', 'nfl', 'wnba', 'ufc', 'soccer', 'ncaaf', 'nhl', 'nba', 'ncaam'];

/**
 * Fetches the schedule for a specific sport and date
 */
async function fetchSportSchedule(sport, date) {
    const url = `${API_BASE}?sport=${sport}&day=${date}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${sport}: ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
}

/**
 * Extracts games from API data
 */
function getGamesFromData(data, sport) {
    if (!data) return [];
    if (data.content?.games) return data.content.games;
    if (Array.isArray(data.games)) return data.games;

    if (sport === 'soccer') {
        const gamesArray = data.matches || data.events || data.content?.content?.games || [];
        return gamesArray.map(match => ({
            ...match,
            dateTime: match.dateTime || match.kickOffTime || match.start_time || match.startTime,
            homeTeam: match.homeTeam || { name: match.homeTeamName || 'Home' },
            awayTeam: match.awayTeam || { name: match.awayTeamName || 'Away' }
        }));
    }
    return [];
}

/**
 * Checks if CBB games have polls
 */
async function checkCBBPolls(cbbGames) {
    if (!cbbGames || !cbbGames.length) return [];

    console.log('Checking polls for CBB games...');

    const pollPromises = cbbGames.map(async (game) => {
        const gameId = game.id || game.gameId;
        if (!gameId) return { ...game, hasPolls: false };

        try {
            const url = `${POLL_CHECK_API}?game_id=${gameId}`;
            const res = await fetch(url);
            if (!res.ok) return { ...game, hasPolls: false };
            const hasPolls = await res.json();
            console.log(`Game ${gameId}: ${hasPolls ? 'HAS' : 'NO'} polls`);
            return { ...game, hasPolls };
        } catch (err) {
            console.warn(`Failed to check polls for game ${gameId}:`, err);
            return { ...game, hasPolls: false };
        }
    });

    return await Promise.all(pollPromises);
}

/**
 * Fetches all games for a specific date and finds the earliest game time
 * Excludes CBB games that don't have polls
 */
async function getEarliestGameTime(dateString) {
    console.log(`Fetching game schedules for ${dateString}...`);

    try {
        // Fetch all sports schedules in parallel
        const promises = SPORTS.map(sport => fetchSportSchedule(sport, dateString));
        const results = await Promise.allSettled(promises);

        const sportsData = {};
        results.forEach((result, index) => {
            const sport = SPORTS[index];
            if (result.status === 'fulfilled' && result.value) {
                sportsData[sport] = result.value;
            } else {
                console.warn(`Failed to fetch ${sport}:`, result.reason);
                sportsData[sport] = { content: { games: [] } };
            }
        });

        // Check for polls in CBB games
        if (sportsData.ncaam) {
            const cbbGames = getGamesFromData(sportsData.ncaam, 'ncaam');
            if (cbbGames.length > 0) {
                const gamesWithPollStatus = await checkCBBPolls(cbbGames);
                sportsData.ncaam = { content: { games: gamesWithPollStatus } };
            }
        }

        // Collect all games across all sports
        const allGames = [];
        Object.entries(sportsData).forEach(([sport, data]) => {
            const games = getGamesFromData(data, sport);
            games.forEach(game => {
                // Skip CBB games without polls
                if (sport === 'ncaam' && !game.hasPolls) {
                    console.log(`Skipping CBB game ${game.id || 'unknown'} - no polls`);
                    return;
                }

                const dateTime = game.dateTime || game.kickOffTime || game.startTime;
                if (dateTime) {
                    allGames.push({
                        sport,
                        dateTime,
                        gameId: game.id || game.gameId,
                        hasPolls: game.hasPolls
                    });
                }
            });
        });

        if (allGames.length === 0) {
            console.log(`No games found for ${dateString}`);
            return null;
        }

        // Find the earliest game
        let earliestGame = null;
        let earliestTime = null;

        allGames.forEach(game => {
            const gameTime = new Date(game.dateTime);
            if (!earliestTime || gameTime < earliestTime) {
                earliestTime = gameTime;
                earliestGame = game;
            }
        });

        console.log(`Found ${allGames.length} games for ${dateString}`);
        console.log(`Earliest game: ${earliestGame.sport} at ${earliestTime.toISOString()}`);

        return earliestTime;

    } catch (error) {
        console.error(`Error fetching game schedules for ${dateString}:`, error);
        throw error;
    }
}

/**
 * Sets the lineup deadline for a specific date based on the earliest game time
 */
async function setDeadlineForDate(dateString, league = 'major') {
    const earliestGameTime = await getEarliestGameTime(dateString);

    if (!earliestGameTime) {
        console.log(`No games found for ${dateString}, skipping deadline setting`);
        return { success: false, message: `No games found for ${dateString}` };
    }

    // Convert the earliest game time to Central Time
    const gameTimeInCentral = new Date(earliestGameTime.toLocaleString("en-US", { timeZone: "America/Chicago" }));

    // Format the time as HH:MM
    const hours = String(gameTimeInCentral.getHours()).padStart(2, '0');
    const minutes = String(gameTimeInCentral.getMinutes()).padStart(2, '0');
    const timeString = `${hours}:${minutes}`;

    // Parse the date string to get M/D/YYYY format
    const [year, month, day] = dateString.split('-');
    const dateForFunction = `${parseInt(month, 10)}/${parseInt(day, 10)}/${year}`;

    console.log(`Setting deadline for ${dateForFunction} at ${timeString} Central Time`);

    // Build the deadline date using the same logic as setLineupDeadline
    const [hour, minute] = timeString.split(':');
    const intendedWallTimeAsUTC = new Date(Date.UTC(year, month - 1, day, hour, minute));
    const chicagoTimeString = intendedWallTimeAsUTC.toLocaleString("en-US", { timeZone: 'America/Chicago' });
    const chicagoTimeAsUTC = new Date(chicagoTimeString);
    const offset = intendedWallTimeAsUTC.getTime() - chicagoTimeAsUTC.getTime();
    const deadlineDate = new Date(intendedWallTimeAsUTC.getTime() + offset);

    const deadlineRef = db.collection(getCollectionName('lineup_deadlines', league)).doc(dateString);

    await deadlineRef.set({
        deadline: admin.firestore.Timestamp.fromDate(deadlineDate),
        timeZone: 'America/Chicago',
        setBy: 'auto-deadline-setter',
        lastUpdated: FieldValue.serverTimestamp(),
        earliestGameTime: admin.firestore.Timestamp.fromDate(earliestGameTime)
    });

    console.log(`Successfully set deadline for ${dateString} to ${timeString} CT`);

    return {
        success: true,
        message: `Deadline for ${dateForFunction} set to ${timeString} America/Chicago`,
        deadlineTime: timeString,
        gameDate: dateForFunction
    };
}

/**
 * Scheduled function that runs at 8:30 AM ET (7:30 AM CT) daily
 * Automatically sets the lineup deadline for t+2 days
 */
exports.autoSetLineupDeadline = onSchedule({
    schedule: "30 7 * * *", // 7:30 AM CT = 8:30 AM ET
    timeZone: "America/Chicago",
}, async (event) => {
    console.log("Running scheduled auto-deadline setter at 8:30 AM ET / 7:30 AM CT");

    try {
        // Calculate t+2 date in Central Time
        const nowInCentral = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
        const today = new Date(nowInCentral);
        const targetDate = new Date(today);
        targetDate.setDate(targetDate.getDate() + 2);

        const year = targetDate.getFullYear();
        const month = String(targetDate.getMonth() + 1).padStart(2, '0');
        const day = String(targetDate.getDate()).padStart(2, '0');
        const dateString = `${year}-${month}-${day}`;

        console.log(`Today: ${today.toDateString()}`);
        console.log(`Target date (t+2): ${targetDate.toDateString()} (${dateString})`);

        // Set deadline for major league
        const result = await setDeadlineForDate(dateString, 'major');
        console.log('Major league result:', result);

        return result;

    } catch (error) {
        console.error("Error in auto-deadline setter:", error);
        return { success: false, error: error.message };
    }
});

/**
 * Scheduled function for minor league
 * Runs at 8:30 AM ET (7:30 AM CT) daily
 */
exports.minor_autoSetLineupDeadline = onSchedule({
    schedule: "30 7 * * *", // 7:30 AM CT = 8:30 AM ET
    timeZone: "America/Chicago",
}, async (event) => {
    console.log("Running scheduled auto-deadline setter for MINOR LEAGUE at 8:30 AM ET / 7:30 AM CT");

    try {
        // Calculate t+2 date in Central Time
        const nowInCentral = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
        const today = new Date(nowInCentral);
        const targetDate = new Date(today);
        targetDate.setDate(targetDate.getDate() + 2);

        const year = targetDate.getFullYear();
        const month = String(targetDate.getMonth() + 1).padStart(2, '0');
        const day = String(targetDate.getDate()).padStart(2, '0');
        const dateString = `${year}-${month}-${day}`;

        console.log(`Minor League - Today: ${today.toDateString()}`);
        console.log(`Minor League - Target date (t+2): ${targetDate.toDateString()} (${dateString})`);

        // Set deadline for minor league
        const result = await setDeadlineForDate(dateString, 'minor');
        console.log('Minor league result:', result);

        return result;

    } catch (error) {
        console.error("Minor League - Error in auto-deadline setter:", error);
        return { success: false, error: error.message };
    }
});

/**
 * Callable function for testing the auto-deadline setter
 * Can specify a custom date or use default t+2
 */
exports.testAutoSetLineupDeadline = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);

    // Security check
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    try {
        let dateString;

        // Allow custom date for testing, or calculate t+2
        if (request.data.targetDate) {
            // Expected format: YYYY-MM-DD
            dateString = request.data.targetDate;
        } else {
            // Calculate t+2 in Central Time
            const nowInCentral = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
            const today = new Date(nowInCentral);
            const targetDate = new Date(today);
            targetDate.setDate(targetDate.getDate() + 2);

            const year = targetDate.getFullYear();
            const month = String(targetDate.getMonth() + 1).padStart(2, '0');
            const day = String(targetDate.getDate()).padStart(2, '0');
            dateString = `${year}-${month}-${day}`;
        }

        console.log(`Test run: Setting deadline for ${dateString} (league: ${league})`);

        const result = await setDeadlineForDate(dateString, league);

        return {
            success: true,
            league,
            ...result
        };

    } catch (error) {
        console.error("Error in test auto-deadline setter:", error);
        throw new HttpsError('internal', `Failed to set deadline: ${error.message}`);
    }
});

module.exports = {
    autoSetLineupDeadline: exports.autoSetLineupDeadline,
    minor_autoSetLineupDeadline: exports.minor_autoSetLineupDeadline,
    testAutoSetLineupDeadline: exports.testAutoSetLineupDeadline
};
