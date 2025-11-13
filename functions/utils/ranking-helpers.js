// functions/utils/ranking-helpers.js

const admin = require("firebase-admin");
const { getCollectionName, LEAGUES } = require('./firebase-helpers');

// Ensure admin is initialized (will use existing instance if already initialized)
if (!admin.apps.length) {
    admin.initializeApp();
}
const db = admin.firestore();

/**
 * Generates a ranked map of players based on a primary stat and optional tiebreaker
 * @param {Array} players - Array of player objects
 * @param {string} primaryStat - The main stat to rank by
 * @param {string} tiebreakerStat - Optional tiebreaker stat
 * @param {boolean} isAscending - Whether to sort ascending (lower is better)
 * @param {number} gpMinimum - Minimum games played requirement
 * @param {boolean} excludeZeroes - Whether to exclude zero values
 * @returns {Map} Map of player_id to rank
 */
function getRanks(players, primaryStat, tiebreakerStat = null, isAscending = false, gpMinimum = 0, excludeZeroes = false) {
    const rankedMap = new Map();

    let eligiblePlayers = players.filter(p => {
        const gamesPlayedField = primaryStat.startsWith('post_') ? 'post_games_played' : 'games_played';
        return (p[gamesPlayedField] || 0) >= gpMinimum;
    });

    if (excludeZeroes) {
        eligiblePlayers = eligiblePlayers.filter(p => (p[primaryStat] || 0) !== 0);
    }

    eligiblePlayers.sort((a, b) => {
        const aPrimary = a[primaryStat] || 0;
        const bPrimary = b[primaryStat] || 0;
        const primaryCompare = isAscending ? aPrimary - bPrimary : bPrimary - aPrimary;
        if (primaryCompare !== 0) return primaryCompare;

        if (tiebreakerStat) {
            const aSecondary = a[tiebreakerStat] || 0;
            const bSecondary = b[tiebreakerStat] || 0;
            return bSecondary - aSecondary;
        }
        return 0;
    });

    eligiblePlayers.forEach((player, index) => {
        rankedMap.set(player.player_id, index + 1);
    });
    return rankedMap;
}

/**
 * Performs a comprehensive player ranking update for a given league
 * @param {string} league - League context ('major' or 'minor')
 */
async function performPlayerRankingUpdate(league = LEAGUES.MAJOR) {
    console.log(`Starting player ranking update for ${league} league...`);

    const activeSeasonSnap = await db.collection(getCollectionName('seasons', league)).where('status', '==', 'active').limit(1).get();
    if (activeSeasonSnap.empty) {
        console.log(`No active season found for ${league} league. Aborting player ranking update.`);
        return;
    }

    const activeSeasonDoc = activeSeasonSnap.docs[0];
    const seasonId = activeSeasonDoc.id;
    const seasonGamesPlayed = activeSeasonDoc.data().gp || 0;
    const regSeasonGpMinimum = seasonGamesPlayed >= 60 ? 3 : 0;
    const postSeasonGpMinimum = 0;
    const playersSnap = await db.collection(getCollectionName('v2_players', league)).get();
    const statPromises = playersSnap.docs.map(playerDoc =>
        playerDoc.ref.collection(getCollectionName('seasonal_stats', league)).doc(seasonId).get()
    );
    const statDocs = await Promise.all(statPromises);

    const allPlayerStats = [];
    statDocs.forEach(doc => {
        if (doc.exists) {
            const pathParts = doc.ref.path.split('/');
            const playerId = pathParts[pathParts.length - 3];
            allPlayerStats.push({
                player_id: playerId,
                ...doc.data()
            });
        }
    });

    if (allPlayerStats.length === 0) {
        console.log(`No player stats found for active season ${seasonId}. Aborting ranking update.`);
        return;
    }

    const statsToExcludeZeroes = new Set(['total_points', 'rel_mean', 'rel_median', 'GEM', 'WAR', 'medrank', 'meanrank']);

    const leaderboards = {

        total_points: getRanks(allPlayerStats, 'total_points', null, false, 0, statsToExcludeZeroes.has('total_points')),
        rel_mean: getRanks(allPlayerStats, 'rel_mean', null, false, regSeasonGpMinimum, statsToExcludeZeroes.has('rel_mean')),
        rel_median: getRanks(allPlayerStats, 'rel_median', null, false, regSeasonGpMinimum, statsToExcludeZeroes.has('rel_median')),
        GEM: getRanks(allPlayerStats, 'GEM', null, true, regSeasonGpMinimum, statsToExcludeZeroes.has('GEM')),
        WAR: getRanks(allPlayerStats, 'WAR', null, false, 0, statsToExcludeZeroes.has('WAR')),
        medrank: getRanks(allPlayerStats, 'medrank', null, true, regSeasonGpMinimum, statsToExcludeZeroes.has('medrank')),
        meanrank: getRanks(allPlayerStats, 'meanrank', null, true, regSeasonGpMinimum, statsToExcludeZeroes.has('meanrank')),
        aag_mean: getRanks(allPlayerStats, 'aag_mean', 'aag_mean_pct'),
        aag_median: getRanks(allPlayerStats, 'aag_median', 'aag_median_pct'),
        t100: getRanks(allPlayerStats, 't100', 't100_pct'),
        t50: getRanks(allPlayerStats, 't50', 't50_pct'),

        post_total_points: getRanks(allPlayerStats, 'post_total_points', null, false, 0, statsToExcludeZeroes.has('total_points')),
        post_rel_mean: getRanks(allPlayerStats, 'post_rel_mean', null, false, postSeasonGpMinimum, statsToExcludeZeroes.has('rel_mean')),
        post_rel_median: getRanks(allPlayerStats, 'post_rel_median', null, false, postSeasonGpMinimum, statsToExcludeZeroes.has('rel_median')),
        post_GEM: getRanks(allPlayerStats, 'post_GEM', null, true, postSeasonGpMinimum, statsToExcludeZeroes.has('GEM')),
        post_WAR: getRanks(allPlayerStats, 'post_WAR', null, false, 0, statsToExcludeZeroes.has('WAR')),
        post_medrank: getRanks(allPlayerStats, 'post_medrank', null, true, postSeasonGpMinimum, statsToExcludeZeroes.has('medrank')),
        post_meanrank: getRanks(allPlayerStats, 'post_meanrank', null, true, postSeasonGpMinimum, statsToExcludeZeroes.has('meanrank')),
        post_aag_mean: getRanks(allPlayerStats, 'post_aag_mean', 'post_aag_mean_pct'),
        post_aag_median: getRanks(allPlayerStats, 'post_aag_median', 'post_aag_median_pct'),
        post_t100: getRanks(allPlayerStats, 'post_t100', 'post_t100_pct'),
        post_t50: getRanks(allPlayerStats, 'post_t50', 'post_t50_pct'),
    };

    const batch = db.batch();
    allPlayerStats.forEach(player => {
        const playerStatsRef = db.collection(getCollectionName('v2_players', league)).doc(player.player_id).collection(getCollectionName('seasonal_stats', league)).doc(seasonId);
        const ranksUpdate = {};
        for (const key in leaderboards) {
            ranksUpdate[`${key}_rank`] = leaderboards[key].get(player.player_id) || null;
        }
        batch.update(playerStatsRef, ranksUpdate);
    });

    await batch.commit();
    console.log(`Player ranking update complete for ${league} league, season ${seasonId}.`);
}

module.exports = {
    getRanks,
    performPlayerRankingUpdate
};
