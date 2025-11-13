// functions/games/game-processing.js

const { admin, db } = require('../utils/firebase-admin');
const { FieldValue } = require("firebase-admin/firestore");
const { getCollectionName, LEAGUES } = require('../utils/firebase-helpers');
const { calculateMedian } = require('../utils/calculations');
const { updatePlayerSeasonalStats, updateAllTeamStats } = require('../utils/stats-helpers');

/**
 * Processes a completed game and updates all related statistics
 * @param {Object} event - Firestore document event
 * @param {string} league - League context (major or minor)
 */
async function processCompletedGame(event, league = LEAGUES.MAJOR) {
    const before = event.data.before.data();
    const after = event.data.after.data();
    const seasonId = event.params.seasonId;
    const gameId = event.params.gameId;

    // Exit if this isn't a game completion event
    if (after.completed !== 'TRUE' || before.completed === 'TRUE') {
        return null;
    }
    console.log(`V2: Processing completed game ${gameId} in season ${seasonId} for ${league} league`);

    const gameDate = after.date;
    const batch = db.batch();
    const isPostseason = !/^\d+$/.test(after.week) && after.week !== "All-Star" && after.week !== "Relegation";

    // Update postseason series win counts if applicable
    if (isPostseason) {
        const winnerId = after.winner;
        if (winnerId) {
            let newTeam1Wins = after.team1_wins || 0;
            let newTeam2Wins = after.team2_wins || 0;
            let seriesWinner = after.series_winner || '';

            if (winnerId === after.team1_id) {
                newTeam1Wins++;
            } else if (winnerId === after.team2_id) {
                newTeam2Wins++;
            }

            if (after.week !== 'Play-In') {
                const winConditions = { 'Round 1': 2, 'Round 2': 2, 'Conf Finals': 3, 'Finals': 4 };
                const winsNeeded = winConditions[after.week];

                if (newTeam1Wins === winsNeeded) {
                    seriesWinner = after.team1_id;
                } else if (newTeam2Wins === winsNeeded) {
                    seriesWinner = after.team2_id;
                }
            }

            const seriesGamesQuery = db.collection(getCollectionName('seasons', league)).doc(seasonId).collection(getCollectionName('post_games', league)).where('series_id', '==', after.series_id);
            const seriesGamesSnap = await seriesGamesQuery.get();

            seriesGamesSnap.forEach(doc => {
                batch.update(doc.ref, {
                    team1_wins: newTeam1Wins,
                    team2_wins: newTeam2Wins,
                    series_winner: seriesWinner
                });
            });
        }
    }

    // --- BUG FIX LOGIC START ---
    // 1. Fetch ALL games scheduled for the same date as the completed game.
    const regGamesQuery = db.collection(getCollectionName('seasons', league)).doc(seasonId).collection(getCollectionName('games', league)).where('date', '==', gameDate).get();
    const postGamesQuery = db.collection(getCollectionName('seasons', league)).doc(seasonId).collection(getCollectionName('post_games', league)).where('date', '==', gameDate).get();

    const [regGamesSnap, postGamesSnap] = await Promise.all([regGamesQuery, postGamesQuery]);
    const allGamesForDate = [...regGamesSnap.docs, ...postGamesSnap.docs];

    // 2. Check if any other games from that date are still incomplete.
    const incompleteGames = allGamesForDate.filter(doc => {
        // This check is critical. It includes the currently triggering game, ensuring it's seen as complete.
        const gameData = doc.id === gameId ? after : doc.data();
        return gameData.completed !== 'TRUE';
    });

    // 3. If any games are still pending, exit. This function will run again when the next game is completed.
    // This prevents the race condition by ensuring calculations only happen once, on the final completion of the day.
    if (incompleteGames.length > 0) {
        console.log(`Not all games for ${gameDate} are complete. Deferring calculations. Incomplete count: ${incompleteGames.length}`);
        await batch.commit(); // Commit any series win updates and exit
        return null;
    }
    // --- BUG FIX LOGIC END ---

    console.log(`All games for ${gameDate} are complete. Proceeding with daily calculations.`);

    const seasonRef = db.collection(getCollectionName('seasons', league)).doc(seasonId);
    const averagesColl = isPostseason ? 'post_daily_averages' : 'daily_averages';
    const scoresColl = isPostseason ? 'post_daily_scores' : 'daily_scores';
    const lineupsColl = isPostseason ? 'post_lineups' : 'lineups';

    if (!isPostseason) {
        const gamesCompletedToday = allGamesForDate.length;
        batch.update(seasonRef, { gp: FieldValue.increment(gamesCompletedToday) });
    }

    const lineupsSnap = await db.collection(getCollectionName('seasons', league)).doc(seasonId).collection(getCollectionName(lineupsColl, league)).where('date', '==', gameDate).where('started', '==', 'TRUE').get();
    if (lineupsSnap.empty) {
        await batch.commit();
        return null;
    }

    // Player stat calculations (mean, median, etc.)
    const scores = lineupsSnap.docs.map(d => d.data().points_adjusted || 0);
    const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
    const median = calculateMedian(scores);
    const replacement = median * 0.9;
    const win = median * 0.92;

    const seasonNum = seasonId.replace('S', '');
    const [month, day, year] = gameDate.split('/');
    const yyyymmdd = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    const dailyAvgRef = db.doc(`${getCollectionName(averagesColl, league)}/season_${seasonNum}/${getCollectionName(`S${seasonNum}_${averagesColl}`, league)}/${yyyymmdd}`);
    const dailyAvgDataForMap = { date: gameDate, week: after.week, total_players: scores.length, mean_score: mean, median_score: median, replacement_level: replacement, win: win };
    batch.set(dailyAvgRef, dailyAvgDataForMap);

    const fullDailyAveragesMap = new Map();
    const averagesSnap = await db.collection(getCollectionName(averagesColl, league)).doc(`season_${seasonNum}`).collection(getCollectionName(`S${seasonNum}_${averagesColl}`, league)).get();
    averagesSnap.docs.forEach(doc => fullDailyAveragesMap.set(doc.data().date, doc.data()));
    fullDailyAveragesMap.set(gameDate, dailyAvgDataForMap);

    // Update individual lineup documents with advanced stats
    const enhancedLineups = [];
    const lineupsByPlayer = new Map();
    lineupsSnap.docs.forEach(doc => {
        const lineupData = doc.data();
        const points = lineupData.points_adjusted || 0;
        const aboveMean = points - mean;
        const aboveMedian = points - median;
        const enhancedData = {
            ...lineupData,
            above_mean: aboveMean,
            AboveAvg: aboveMean > 0 ? 1 : 0,
            pct_above_mean: mean ? aboveMean / mean : 0,
            above_median: aboveMedian,
            AboveMed: aboveMedian > 0 ? 1 : 0,
            pct_above_median: median ? aboveMedian / median : 0,
            SingleGameWar: win ? (points - replacement) / win : 0,
        };
        batch.update(doc.ref, {
            above_mean: enhancedData.above_mean,
            AboveAvg: enhancedData.AboveAvg,
            pct_above_mean: enhancedData.pct_above_mean,
            above_median: enhancedData.above_median,
            AboveMed: enhancedData.AboveMed,
            pct_above_median: enhancedData.pct_above_median,
            SingleGameWar: enhancedData.SingleGameWar,
        });
        enhancedLineups.push(enhancedData);
        if (!lineupsByPlayer.has(lineupData.player_id)) {
            lineupsByPlayer.set(lineupData.player_id, []);
        }
        lineupsByPlayer.get(lineupData.player_id).push(enhancedData);
    });

    // 4. Calculate the SINGLE, CORRECT median based on ALL team scores from the day.
    const teamScores = allGamesForDate.flatMap(d => {
        const gameData = d.id === gameId ? after : d.data();
        return [gameData.team1_score, gameData.team2_score];
    });
    const teamMedian = calculateMedian(teamScores);

    // 5. Loop through ALL teams that played today and create/overwrite their daily_scores document.
    // This ensures every team from the day uses the same, correct teamMedian.
    const newDailyScores = [];
    allGamesForDate.forEach(doc => {
        const game = doc.id === gameId ? after : doc.data();
        const currentGameId = doc.id;
        [{ id: game.team1_id, score: game.team1_score }, { id: game.team2_id, score: game.team2_score }].forEach(team => {
            const scoreRef = db.doc(`${getCollectionName(scoresColl, league)}/season_${seasonNum}/${getCollectionName(`S${seasonNum}_${scoresColl}`, league)}/${team.id}-${currentGameId}`);
            const pam = team.score - teamMedian;
            const scoreData = {
                week: game.week, team_id: team.id, date: gameDate, score: team.score,
                daily_median: teamMedian, above_median: pam > 0 ? 1 : 0,
                points_above_median: pam, pct_above_median: teamMedian ? pam / teamMedian : 0
            };
            batch.set(scoreRef, scoreData, { merge: true });
            newDailyScores.push(scoreData);
        });
    });

    // Cascade updates to player and team seasonal stats
    let totalKarmaChangeForGame = 0;
    for (const [pid, newPlayerLineups] of lineupsByPlayer.entries()) {
        await updatePlayerSeasonalStats(pid, seasonId, isPostseason, batch, fullDailyAveragesMap, newPlayerLineups, league);
        const pointsFromThisUpdate = newPlayerLineups.reduce((sum, lineup) => sum + (lineup.points_adjusted || 0), 0);
        totalKarmaChangeForGame += pointsFromThisUpdate;
    }

    if (totalKarmaChangeForGame !== 0) {
        batch.update(seasonRef, { season_karma: FieldValue.increment(totalKarmaChangeForGame) });
    }

    await updateAllTeamStats(seasonId, isPostseason, batch, newDailyScores, league);

    await batch.commit();
    console.log(`Successfully saved all daily calculations and stats for ${gameDate}.`);
    return null;
}

module.exports = {
    processCompletedGame
};
