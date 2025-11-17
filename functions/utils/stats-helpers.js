// functions/utils/stats-helpers.js

const { admin, db } = require("./firebase-admin");
const { getCollectionName } = require('./firebase-helpers');
const { calculateMedian, calculateMean, calculateGeometricMean } = require('./calculations');

/**
 * Updates player seasonal statistics based on their lineups
 * @param {string} playerId - Player ID
 * @param {string} seasonId - Season ID
 * @param {boolean} isPostseason - Whether this is postseason data
 * @param {FirebaseFirestore.WriteBatch} batch - Firestore batch
 * @param {Map} dailyAveragesMap - Map of daily averages by date
 * @param {Array} newPlayerLineups - New lineup data for this player
 * @param {string} league - League context
 */
async function updatePlayerSeasonalStats(playerId, seasonId, isPostseason, batch, dailyAveragesMap, newPlayerLineups, league = 'major') {
    const lineupsCollectionName = isPostseason ? 'post_lineups' : 'lineups';
    const gameDate = newPlayerLineups[0].date;

    console.log(`Updating seasonal stats for player ${playerId} in ${league} league...`);

    const playerLineupsQuery = db.collection(getCollectionName('seasons', league)).doc(seasonId).collection(getCollectionName(lineupsCollectionName, league))
        .where('player_id', '==', playerId)
        .where('started', '==', 'TRUE')
        .where('date', '!=', gameDate);

    const previousLineupsSnap = await playerLineupsQuery.get();
    const previousLineups = previousLineupsSnap.docs.map(doc => doc.data());

    const allLineups = [...previousLineups, ...newPlayerLineups];

    if (allLineups.length === 0) {
        console.log(`No lineups found for player ${playerId} in ${seasonId} for ${league} league (${getCollectionName(lineupsCollectionName, league)}). Skipping stats update.`);
        return null;
    }

    const games_played = allLineups.length;
    const total_points = allLineups.reduce((sum, l) => sum + (l.points_adjusted || 0), 0);
    const WAR = allLineups.reduce((sum, l) => sum + (l.SingleGameWar || 0), 0);
    const aag_mean = allLineups.reduce((sum, l) => sum + (l.AboveAvg || 0), 0);
    const aag_median = allLineups.reduce((sum, l) => sum + (l.AboveMed || 0), 0);

    const globalRanks = allLineups.map(l => l.global_rank || 0).filter(r => r > 0);
    const medrank = calculateMedian(globalRanks);
    const meanrank = calculateMean(globalRanks);
    const GEM = calculateGeometricMean(globalRanks);
    const t100 = allLineups.filter(l => l.global_rank > 0 && l.global_rank <= 100).length;
    const t50 = allLineups.filter(l => l.global_rank > 0 && l.global_rank <= 50).length;
    let meansum = 0;
    let medsum = 0;
    const uniqueDates = [...new Set(allLineups.map(l => l.date))];

    for (const date of uniqueDates) {
        const dailyAvgData = dailyAveragesMap.get(date);
        if (dailyAvgData) {
            meansum += dailyAvgData.mean_score || 0;
            medsum += dailyAvgData.median_score || 0;
        }
    }

    const statsUpdate = {};
    const prefix = isPostseason ? 'post_' : '';
    statsUpdate[`${prefix}games_played`] = games_played;
    statsUpdate[`${prefix}total_points`] = total_points;
    statsUpdate[`${prefix}medrank`] = medrank;
    statsUpdate[`${prefix}meanrank`] = meanrank;
    statsUpdate[`${prefix}aag_mean`] = aag_mean;
    statsUpdate[`${prefix}aag_mean_pct`] = games_played > 0 ? aag_mean / games_played : 0;
    statsUpdate[`${prefix}meansum`] = meansum;
    statsUpdate[`${prefix}rel_mean`] = meansum > 0 ? total_points / meansum : 0;
    statsUpdate[`${prefix}aag_median`] = aag_median;
    statsUpdate[`${prefix}aag_median_pct`] = games_played > 0 ? aag_median / games_played : 0;
    statsUpdate[`${prefix}medsum`] = medsum;
    statsUpdate[`${prefix}rel_median`] = medsum > 0 ? total_points / medsum : 0;
    statsUpdate[`${prefix}GEM`] = GEM;
    statsUpdate[`${prefix}WAR`] = WAR;
    statsUpdate[`${prefix}t100`] = t100;
    statsUpdate[`${prefix}t100_pct`] = games_played > 0 ? t100 / games_played : 0;
    statsUpdate[`${prefix}t50`] = t50;
    statsUpdate[`${prefix}t50_pct`] = games_played > 0 ? t50 / games_played : 0;
    const playerStatsRef = db.collection(getCollectionName('v2_players', league)).doc(playerId).collection(getCollectionName('seasonal_stats', league)).doc(seasonId);
    batch.set(playerStatsRef, statsUpdate, { merge: true });

    return statsUpdate;
}

/**
 * Updates all team statistics for a season
 * @param {string} seasonId - Season ID
 * @param {boolean} isPostseason - Whether this is postseason data
 * @param {FirebaseFirestore.WriteBatch} batch - Firestore batch
 * @param {Array} newDailyScores - New daily score data
 * @param {string} league - League context
 */
async function updateAllTeamStats(seasonId, isPostseason, batch, newDailyScores, league = 'major') {
    console.log(`Updating all team stats for ${league} league...`);
    const prefix = isPostseason ? 'post_' : '';
    const gamesCollection = isPostseason ? 'post_games' : 'games';
    const scoresCollection = isPostseason ? 'post_daily_scores' : 'daily_scores';
    const lineupsCollection = isPostseason ? 'post_lineups' : 'lineups';

    const [teamsSnap, gamesSnap, scoresSnap, lineupsSnap] = await Promise.all([
        db.collection(getCollectionName('v2_teams', league)).get(),
        db.collection(getCollectionName('seasons', league)).doc(seasonId).collection(getCollectionName(gamesCollection, league)).where('completed', '==', 'TRUE').get(),
        db.collection(getCollectionName(scoresCollection, league)).doc(`season_${seasonId.replace('S', '')}`).collection(getCollectionName(`S${seasonId.replace('S', '')}_${scoresCollection}`, league)).get(),
        db.collection(getCollectionName('seasons', league)).doc(seasonId).collection(getCollectionName(lineupsCollection, league)).where('started', '==', 'TRUE').get()
    ]);

    const playersCollectionRef = db.collection(getCollectionName('v2_players', league));
    const allPlayersSnap = await playersCollectionRef.get();
    const playerStatsForTeams = new Map();
    const playerStatPromises = allPlayersSnap.docs.map(playerDoc =>
        playerDoc.ref.collection(getCollectionName('seasonal_stats', league)).doc(seasonId).get()
    );
    const seasonalStatsSnapForTeams = await Promise.all(playerStatPromises);

    seasonalStatsSnapForTeams.forEach(docSnap => {
        if (docSnap.exists) {
            const pathParts = docSnap.ref.path.split('/');
            const playerId = pathParts[pathParts.length - 3];
            playerStatsForTeams.set(playerId, docSnap.data());
        }
    });

    const teamRelDataMap = new Map();
    allPlayersSnap.forEach(playerDoc => {
        const playerData = playerDoc.data();
        const playerStats = playerStatsForTeams.get(playerDoc.id);
        const teamId = playerData.current_team_id;

        if (teamId && playerStats) {
            if (!teamRelDataMap.has(teamId)) {
                teamRelDataMap.set(teamId, {
                    weightedSum: 0,
                    totalGP: 0,
                    post_weightedSum: 0,
                    post_totalGP: 0
                });
            }

            const teamData = teamRelDataMap.get(teamId);

            const relMedian = playerStats.rel_median || 0;
            const gamesPlayed = playerStats.games_played || 0;
            if (gamesPlayed > 0) {
                teamData.weightedSum += relMedian * gamesPlayed;
                teamData.totalGP += gamesPlayed;
            }

            const postRelMedian = playerStats.post_rel_median || 0;
            const postGamesPlayed = playerStats.post_games_played || 0;
            if (postGamesPlayed > 0) {
                teamData.post_weightedSum += postRelMedian * postGamesPlayed;
                teamData.post_totalGP += postGamesPlayed;
            }
        }
    });

    const finalTRelMap = new Map();
    for (const [teamId, data] of teamRelDataMap.entries()) {
        const tREL = data.totalGP > 0 ? data.weightedSum / data.totalGP : 0;
        const post_tREL = data.post_totalGP > 0 ? data.post_weightedSum / data.post_totalGP : 0;
        finalTRelMap.set(teamId, { tREL, post_tREL });
    }

    const allTeamData = teamsSnap.docs
        .filter(doc => doc.data().conference)
        .map(doc => ({ id: doc.id, ...doc.data() }));

    const teamStatsMap = new Map();
    allTeamData.forEach(t => teamStatsMap.set(t.id, {
        wins: 0, losses: 0, pam: 0, scores_count: 0, total_pct_above_median: 0, ranks: [], conference: t.conference
    }));

    gamesSnap.docs.forEach(doc => {
        const game = doc.data();
        if (teamStatsMap.has(game.winner)) {
            teamStatsMap.get(game.winner).wins++;
        }
        const loserId = game.team1_id === game.winner ? game.team2_id : game.team1_id;
        if (teamStatsMap.has(loserId)) {
            teamStatsMap.get(loserId).losses++;
        }
    });

    const historicalScores = scoresSnap.docs.map(doc => doc.data());
    const allScores = [...historicalScores, ...newDailyScores];

    allScores.forEach(score => {
        if (teamStatsMap.has(score.team_id)) {
            const teamData = teamStatsMap.get(score.team_id);
            teamData.pam += score.points_above_median || 0;
            teamData.total_pct_above_median += score.pct_above_median || 0;
            teamData.scores_count++;
        }
    });

    lineupsSnap.docs.forEach(doc => {
        const lineup = doc.data();
        if (teamStatsMap.has(lineup.team_id) && lineup.global_rank > 0) {
            teamStatsMap.get(lineup.team_id).ranks.push(lineup.global_rank);
        }
    });

    const calculatedStats = allTeamData.map(team => {
        const stats = teamStatsMap.get(team.id);
        const { wins, losses, pam, scores_count, total_pct_above_median, ranks, conference } = stats;

        const wpct = (wins + losses) > 0 ? wins / (wins + losses) : 0;
        const apPAM = scores_count > 0 ? total_pct_above_median / scores_count : 0;
        const med_starter_rank = calculateMedian(ranks);
        const MaxPotWins = 15 - losses;
        const sortscore = wpct - (losses * 0.001) + (pam * 0.00000001);

        return { teamId: team.id, conference, wins, losses, wpct, pam, apPAM, med_starter_rank, MaxPotWins, sortscore };
    });

    const rankAndSort = (teams, stat, ascending = true, rankKey) => {
        const sorted = [...teams].sort((a, b) => ascending ? a[stat] - b[stat] : b[stat] - a[stat]);
        sorted.forEach((team, i) => team[rankKey] = i + 1);
    };

    rankAndSort(calculatedStats, 'med_starter_rank', true, `${prefix}msr_rank`);
    rankAndSort(calculatedStats, 'pam', false, `${prefix}pam_rank`);

    if (!isPostseason) {
        const incompleteGamesSnap = await db.collection(getCollectionName('seasons', league)).doc(seasonId).collection(getCollectionName('games', league)).where('completed', '!=', 'TRUE').limit(1).get();
        const isRegularSeasonComplete = incompleteGamesSnap.empty;

        const eastConf = calculatedStats.filter(t => t.conference === 'Eastern');
        const westConf = calculatedStats.filter(t => t.conference === 'Western');

        [eastConf, westConf].forEach(conf => {
            if (conf.length === 0) return;

            conf.sort((a, b) => b.sortscore - a.sortscore).forEach((t, i) => t.postseed = i + 1);

            if (isRegularSeasonComplete) {
                console.log(`Regular season for ${conf[0].conference} conference is complete. Using sortscore for clinching.`);
                conf.forEach((team, index) => {
                    const rank = index + 1;
                    if (rank <= 6) {
                        team.playoffs = 1;
                        team.playin = 0;
                        team.elim = 0;
                    } else if (rank >= 7 && rank <= 10) {
                        team.playoffs = 0;
                        team.playin = 1;
                        team.elim = 0;
                    } else {
                        team.playoffs = 0;
                        team.playin = 0;
                        team.elim = 1;
                    }
                });
            } else {
                console.log(`Regular season for ${conf[0].conference} conference is ongoing. Using win thresholds for clinching.`);
                const maxPotWinsSorted = [...conf].sort((a, b) => b.MaxPotWins - a.MaxPotWins);
                const winsSorted = [...conf].sort((a, b) => b.wins - a.wins);
                const playoffWinsThreshold = maxPotWinsSorted[6]?.MaxPotWins ?? 0;
                const playinWinsThreshold = maxPotWinsSorted[10]?.MaxPotWins ?? 0;
                const elimWinsThreshold = winsSorted[9]?.wins ?? 0;

                conf.forEach(t => {
                    t.playoffs = t.wins > playoffWinsThreshold ? 1 : 0;
                    t.playin = t.wins > playinWinsThreshold ? 1 : 0;
                    t.elim = t.MaxPotWins < elimWinsThreshold ? 1 : 0;
                });
            }
        });
    }

    for (const team of calculatedStats) {
        const { teamId, ...stats } = team;
        const relValues = finalTRelMap.get(teamId) || { tREL: 0, post_tREL: 0 };

        const finalUpdate = {
            [`${prefix}wins`]: stats.wins || 0,
            [`${prefix}losses`]: stats.losses || 0,
            [`${prefix}pam`]: stats.pam || 0,
            [`${prefix}med_starter_rank`]: stats.med_starter_rank || 0,
            [`${prefix}msr_rank`]: stats[`${prefix}msr_rank`] || 0,
            [`${prefix}pam_rank`]: stats[`${prefix}pam_rank`] || 0,
            [`${prefix}tREL`]: relValues[`${prefix}tREL`] || 0,
        };

        if (!isPostseason) {
            Object.assign(finalUpdate, {
                wpct: stats.wpct || 0,
                apPAM: stats.apPAM || 0,
                sortscore: stats.sortscore || 0,
                MaxPotWins: stats.MaxPotWins || 0,
                postseed: stats.postseed || null,
                playin: stats.playin || 0,
                playoffs: stats.playoffs || 0,
                elim: stats.elim || 0,
            });
        }

        const teamStatsRef = db.collection(getCollectionName('v2_teams', league)).doc(teamId).collection(getCollectionName('seasonal_records', league)).doc(seasonId);
        batch.set(teamStatsRef, finalUpdate, { merge: true });
    }
}

/**
 * Updates single-performance leaderboards for a given league
 * Creates rankings for best single-game performances in karma and rank
 * @param {string} league - League context ('major' or 'minor')
 */
async function performPerformanceRankingUpdate(league = 'major') {
    console.log(`Starting single-performance leaderboard update for ${league} league...`);
    const activeSeasonSnap = await db.collection(getCollectionName('seasons', league)).where('status', '==', 'active').limit(1).get();
    if (activeSeasonSnap.empty) {
        console.log(`No active season found for ${league} league. Aborting performance leaderboard update.`);
        return;
    }
    const seasonId = activeSeasonSnap.docs[0].id;

    const lineupsRef = db.collection(getCollectionName('seasons', league)).doc(seasonId).collection(getCollectionName('lineups', league));
    const postLineupsRef = db.collection(getCollectionName('seasons', league)).doc(seasonId).collection(getCollectionName('post_lineups', league));

    const [lineupsSnap, postLineupsSnap] = await Promise.all([
        lineupsRef.get(),
        postLineupsRef.get()
    ]);

    const batch = db.batch();

    if (!lineupsSnap.empty) {
        const regularSeasonPerformances = lineupsSnap.docs.map(d => d.data());

        const karmaLeaderboard = [...regularSeasonPerformances]
            .sort((a, b) => (b.points_adjusted || 0) - (a.points_adjusted || 0))
            .slice(0, 250);

        const rankLeaderboard = [...regularSeasonPerformances]
            .filter(p => (p.global_rank || 0) > 0)
            .sort((a, b) => (a.global_rank || 999) - (b.global_rank || 999))
            .slice(0, 250);

        const leaderboardsCollection = getCollectionName('leaderboards', league);

        const karmaDocRef = db.collection(leaderboardsCollection).doc('single_game_karma');
        const rankDocRef = db.collection(leaderboardsCollection).doc('single_game_rank');
        batch.set(karmaDocRef, { description: "Regular season single game karma leaderboard." }, { merge: true });
        batch.set(rankDocRef, { description: "Regular season single game rank leaderboard." }, { merge: true });


        const karmaLeaderboardRef = karmaDocRef.collection(seasonId).doc('data');
        const rankLeaderboardRef = rankDocRef.collection(seasonId).doc('data');

        batch.set(karmaLeaderboardRef, { rankings: karmaLeaderboard });
        batch.set(rankLeaderboardRef, { rankings: rankLeaderboard });

        console.log(`Regular season single-performance leaderboards updated for ${league} league, season ${seasonId}.`);
    } else {
        console.log(`No regular season performances found for season ${seasonId}. Skipping regular season leaderboard update.`);
    }

    if (!postLineupsSnap.empty) {
        const postseasonPerformances = postLineupsSnap.docs.map(d => d.data());

        const postKarmaLeaderboard = [...postseasonPerformances]
            .sort((a, b) => (b.points_adjusted || 0) - (a.points_adjusted || 0))
            .slice(0, 250);

        const postRankLeaderboard = [...postseasonPerformances]
            .filter(p => (p.global_rank || 0) > 0)
            .sort((a, b) => (a.global_rank || 999) - (b.global_rank || 999))
            .slice(0, 250);

        const postLeaderboardsCollection = getCollectionName('post_leaderboards', league);

        const postKarmaDocRef = db.collection(postLeaderboardsCollection).doc('post_single_game_karma');
        const postRankDocRef = db.collection(postLeaderboardsCollection).doc('post_single_game_rank');
        batch.set(postKarmaDocRef, { description: "Postseason single game karma leaderboard." }, { merge: true });
        batch.set(postRankDocRef, { description: "Postseason single game rank leaderboard." }, { merge: true });

        const postKarmaLeaderboardRef = postKarmaDocRef.collection(seasonId).doc('data');
        const postRankLeaderboardRef = postRankDocRef.collection(seasonId).doc('data');

        batch.set(postKarmaLeaderboardRef, { rankings: postKarmaLeaderboard });
        batch.set(postRankLeaderboardRef, { rankings: postRankLeaderboard });

        console.log(`Postseason single-performance leaderboards updated for ${league} league, season ${seasonId}.`);
    } else {
        console.log(`No postseason performances found for season ${seasonId}. Skipping postseason leaderboard update.`);
    }

    await batch.commit();
    console.log("Single-performance leaderboard update process complete.");
}

module.exports = {
    updatePlayerSeasonalStats,
    updateAllTeamStats,
    performPerformanceRankingUpdate
};
