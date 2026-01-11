// functions/utils/ranking-helpers.js

const { admin, db } = require('./firebase-admin');
const { getCollectionName, LEAGUES } = require('./firebase-helpers');

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

    // Define all ranking configurations for batch processing
    const rankingConfigs = [
        // Regular season stats
        { key: 'total_points', stat: 'total_points', tiebreaker: null, ascending: false, gpMin: 0, excludeZeroes: true },
        { key: 'rel_mean', stat: 'rel_mean', tiebreaker: null, ascending: false, gpMin: regSeasonGpMinimum, excludeZeroes: true },
        { key: 'rel_median', stat: 'rel_median', tiebreaker: null, ascending: false, gpMin: regSeasonGpMinimum, excludeZeroes: true },
        { key: 'GEM', stat: 'GEM', tiebreaker: null, ascending: true, gpMin: regSeasonGpMinimum, excludeZeroes: true },
        { key: 'WAR', stat: 'WAR', tiebreaker: null, ascending: false, gpMin: 0, excludeZeroes: true },
        { key: 'medrank', stat: 'medrank', tiebreaker: null, ascending: true, gpMin: regSeasonGpMinimum, excludeZeroes: true },
        { key: 'meanrank', stat: 'meanrank', tiebreaker: null, ascending: true, gpMin: regSeasonGpMinimum, excludeZeroes: true },
        { key: 'aag_mean', stat: 'aag_mean', tiebreaker: 'aag_mean_pct', ascending: false, gpMin: 0, excludeZeroes: false },
        { key: 'aag_median', stat: 'aag_median', tiebreaker: 'aag_median_pct', ascending: false, gpMin: 0, excludeZeroes: false },
        { key: 't100', stat: 't100', tiebreaker: 't100_pct', ascending: false, gpMin: 0, excludeZeroes: false },
        { key: 't50', stat: 't50', tiebreaker: 't50_pct', ascending: false, gpMin: 0, excludeZeroes: false },
        // Postseason stats
        { key: 'post_total_points', stat: 'post_total_points', tiebreaker: null, ascending: false, gpMin: 0, excludeZeroes: true, gpField: 'post_games_played' },
        { key: 'post_rel_mean', stat: 'post_rel_mean', tiebreaker: null, ascending: false, gpMin: postSeasonGpMinimum, excludeZeroes: true, gpField: 'post_games_played' },
        { key: 'post_rel_median', stat: 'post_rel_median', tiebreaker: null, ascending: false, gpMin: postSeasonGpMinimum, excludeZeroes: true, gpField: 'post_games_played' },
        { key: 'post_GEM', stat: 'post_GEM', tiebreaker: null, ascending: true, gpMin: postSeasonGpMinimum, excludeZeroes: true, gpField: 'post_games_played' },
        { key: 'post_WAR', stat: 'post_WAR', tiebreaker: null, ascending: false, gpMin: 0, excludeZeroes: true, gpField: 'post_games_played' },
        { key: 'post_medrank', stat: 'post_medrank', tiebreaker: null, ascending: true, gpMin: postSeasonGpMinimum, excludeZeroes: true, gpField: 'post_games_played' },
        { key: 'post_meanrank', stat: 'post_meanrank', tiebreaker: null, ascending: true, gpMin: postSeasonGpMinimum, excludeZeroes: true, gpField: 'post_games_played' },
        { key: 'post_aag_mean', stat: 'post_aag_mean', tiebreaker: 'post_aag_mean_pct', ascending: false, gpMin: 0, excludeZeroes: false, gpField: 'post_games_played' },
        { key: 'post_aag_median', stat: 'post_aag_median', tiebreaker: 'post_aag_median_pct', ascending: false, gpMin: 0, excludeZeroes: false, gpField: 'post_games_played' },
        { key: 'post_t100', stat: 'post_t100', tiebreaker: 'post_t100_pct', ascending: false, gpMin: 0, excludeZeroes: false, gpField: 'post_games_played' },
        { key: 'post_t50', stat: 'post_t50', tiebreaker: 'post_t50_pct', ascending: false, gpMin: 0, excludeZeroes: false, gpField: 'post_games_played' },
    ];

    // Process all rankings in a single pass through the configs
    const leaderboards = {};
    for (const config of rankingConfigs) {
        leaderboards[config.key] = getRanks(
            allPlayerStats,
            config.stat,
            config.tiebreaker,
            config.ascending,
            config.gpMin,
            config.excludeZeroes
        );
    }

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
