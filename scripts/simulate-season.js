// /scripts/simulate-season.js

const admin = require("firebase-admin");

// Initialize the Firebase Admin SDK.
admin.initializeApp({
    projectId: "real-karma-league",
});

const db = admin.firestore();

// --- CONFIGURATION ---
const SEASON_ID = "S8";
const USE_DEV_COLLECTIONS = true; // Ensure this is true for testing
const SEASON_NUM = SEASON_ID.replace('S', '');

// --- Helper to switch between dev/prod collections ---
const getCollectionName = (baseName) => {
    return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
};

// --- Helper Functions for Calculations ---
function calculateMedian(numbers) {
    if (numbers.length === 0) return 0;
    const sorted = [...numbers].sort((a, b) => a - b);
    const middleIndex = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[middleIndex - 1] + sorted[middleIndex]) / 2;
    }
    return sorted[middleIndex];
}

function calculateMean(numbers) {
    if (!numbers || numbers.length === 0) return 0;
    const sum = numbers.reduce((acc, val) => acc + val, 0);
    return sum / numbers.length;
}


function calculateGeometricMean(numbers) {
    if (numbers.length === 0) return 0;
    const nonZeroNumbers = numbers.filter(num => num > 0);
    if (nonZeroNumbers.length === 0) return 0;
    const product = nonZeroNumbers.reduce((prod, num) => prod * num, 1);
    return Math.pow(product, 1 / nonZeroNumbers.length);
}

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

// --- Main Simulation Function ---
async function simulateSeason() {
    console.log(`Starting regular season simulation for ${SEASON_ID}...`);

    // 1. FETCH TEAMS AND PLAYERS FOR THE NEW SEASON
    const teamsSnap = await db.collection(getCollectionName("v2_teams")).get();
    const allTeams = teamsSnap.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(team => team.conference === 'Eastern' || team.conference === 'Western');

    const playersSnap = await db.collection(getCollectionName("v2_players")).get();
    const allPlayers = playersSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    if (allTeams.length < 2) {
        console.error("Not enough valid conference teams found to generate a schedule. Aborting.");
        return;
    }
    console.log(`Found ${allTeams.length} valid conference teams and ${allPlayers.length} players.`);

    // 2. GENERATE A 15-WEEK SCHEDULE
    console.log("Generating 15-week regular season schedule...");
    const schedule = [];
    let gameDate = new Date();
    gameDate.setDate(gameDate.getDate() - (gameDate.getDay() + 6) % 7);

    for (let week = 1; week <= 15; week++) {
        let teamsToSchedule = [...allTeams];
        while (teamsToSchedule.length >= 2) {
            const team1Index = Math.floor(Math.random() * teamsToSchedule.length);
            const [team1] = teamsToSchedule.splice(team1Index, 1);

            const team2Index = Math.floor(Math.random() * teamsToSchedule.length);
            const [team2] = teamsToSchedule.splice(team2Index, 1);

            const formattedDate = `${gameDate.getMonth() + 1}/${gameDate.getDate()}/${gameDate.getFullYear()}`;
            const gameId = `${formattedDate}-${team1.id}-${team2.id}`.replace(/\//g, "-");

            schedule.push({
                id: gameId,
                week: String(week),
                date: formattedDate,
                team1_id: team1.id,
                team2_id: team2.id,
                completed: 'FALSE',
                team1_score: 0,
                team2_score: 0,
                winner: ''
            });
        }
        gameDate.setDate(gameDate.getDate() + 7);
    }
    console.log(`Generated ${schedule.length} games.`);

    // 3. SIMULATE GAMES AND GENERATE LINEUP DATA
    console.log("Simulating games and generating lineup data...");
    const allLineups = [];
    for (const game of schedule) {
        game.team1_score = Math.floor(Math.random() * 500000) + 100000;
        game.team2_score = Math.floor(Math.random() * 500000) + 100000;
        game.winner = game.team1_score > game.team2_score ? game.team1_id : game.team2_id;
        game.completed = 'TRUE';

        [game.team1_id, game.team2_id].forEach(teamId => {
            const teamPlayers = allPlayers.filter(p => p.current_team_id === teamId).slice(0, 5);
            teamPlayers.forEach((player, index) => {
                const points_adjusted = Math.floor(Math.random() * 150000);
                const global_rank = Math.floor(Math.random() * 3000) + 1;
                const lineupId = `${game.id}-${player.id}`;

                allLineups.push({
                    id: lineupId,
                    game_id: game.id,
                    player_id: player.id,
                    player_handle: player.player_handle,
                    team_id: teamId,
                    date: game.date,
                    week: game.week,
                    started: 'TRUE',
                    is_captain: index === 0 ? 'TRUE' : 'FALSE',
                    points_adjusted,
                    global_rank,
                    raw_score: points_adjusted,
                });
            });
        });
    }

    // --- NEW: START OF CALCULATION CASCADE ---
    console.log("--- Starting manual calculation cascade ---");

    // 4. CALCULATE DAILY AVERAGES AND ENHANCE LINEUPS
    const dailyAveragesMap = new Map();
    const lineupsByDate = new Map();
    allLineups.forEach(l => {
        if (!lineupsByDate.has(l.date)) lineupsByDate.set(l.date, []);
        lineupsByDate.get(l.date).push(l);
    });

    for (const [date, dailyLineups] of lineupsByDate.entries()) {
        const scores = dailyLineups.map(l => l.points_adjusted);
        const mean = calculateMean(scores);
        const median = calculateMedian(scores);
        const replacement = median * 0.9;
        const win = median * 0.92;
        const week = dailyLineups[0]?.week || '';
        dailyAveragesMap.set(date, { date, week, total_players: scores.length, mean_score: mean, median_score: median, replacement_level: replacement, win });

        dailyLineups.forEach(l => {
            const points = l.points_adjusted;
            const aboveMean = points - mean;
            const aboveMedian = points - median;
            l.above_mean = aboveMean;
            l.AboveAvg = aboveMean > 0 ? 1 : 0;
            l.pct_above_mean = mean ? aboveMean / mean : 0;
            l.above_median = aboveMedian;
            l.AboveMed = aboveMedian > 0 ? 1 : 0;
            l.pct_above_median = median ? aboveMedian / median : 0;
            l.SingleGameWar = win ? (points - replacement) / win : 0;
        });
    }
    console.log("Step 4: Calculated daily averages and enhanced lineup data.");

    // 5. CALCULATE DAILY TEAM SCORES
    const dailyScores = [];
    const gamesByDate = new Map();
    schedule.forEach(g => {
        if (!gamesByDate.has(g.date)) gamesByDate.set(g.date, []);
        gamesByDate.get(g.date).push(g);
    });

    for (const [date, games] of gamesByDate.entries()) {
        const teamScores = games.flatMap(g => [g.team1_score, g.team2_score]);
        const teamMedian = calculateMedian(teamScores);
        games.forEach(g => {
            [{ id: g.team1_id, score: g.team1_score }, { id: g.team2_id, score: g.team2_score }].forEach(team => {
                const pam = team.score - teamMedian;
                dailyScores.push({
                    docId: `${team.id}-${g.id}`,
                    data: { week: g.week, team_id: team.id, date: g.date, score: team.score, daily_median: teamMedian, above_median: pam > 0 ? 1 : 0, points_above_median: pam, pct_above_median: teamMedian ? pam / teamMedian : 0 }
                });
            });
        });
    }
    console.log("Step 5: Calculated daily team scores.");

    // 6. AGGREGATE SEASONAL STATS FOR PLAYERS AND TEAMS
    const playerSeasonalStats = new Map();
    allLineups.forEach(l => {
        if (!playerSeasonalStats.has(l.player_id)) playerSeasonalStats.set(l.player_id, {});
        const stats = playerSeasonalStats.get(l.player_id);
        stats.games_played = (stats.games_played || 0) + 1;
        stats.total_points = (stats.total_points || 0) + l.points_adjusted;
        stats.WAR = (stats.WAR || 0) + l.SingleGameWar;
        stats.aag_mean = (stats.aag_mean || 0) + l.AboveAvg;
        stats.aag_median = (stats.aag_median || 0) + l.AboveMed;
        if (l.global_rank > 0) {
            if (!stats.ranks) stats.ranks = [];
            stats.ranks.push(l.global_rank);
        }
        const dailyAvg = dailyAveragesMap.get(l.date);
        if (dailyAvg) {
            stats.meansum = (stats.meansum || 0) + dailyAvg.mean_score;
            stats.medsum = (stats.medsum || 0) + dailyAvg.median_score;
        }
    });

    for (const stats of playerSeasonalStats.values()) {
        if (stats.games_played) {
            stats.aag_mean_pct = stats.aag_mean / stats.games_played;
            stats.aag_median_pct = stats.aag_median / stats.games_played;
            stats.rel_mean = stats.meansum > 0 ? stats.total_points / stats.meansum : 0;
            stats.rel_median = stats.medsum > 0 ? stats.total_points / stats.medsum : 0;
            stats.medrank = calculateMedian(stats.ranks || []);
            stats.meanrank = calculateMean(stats.ranks || []);
            stats.GEM = calculateGeometricMean(stats.ranks || []);
            stats.t100 = (stats.ranks || []).filter(r => r > 0 && r <= 100).length;
            stats.t50 = (stats.ranks || []).filter(r => r > 0 && r <= 50).length;
            stats.t100_pct = stats.t100 / stats.games_played;
            stats.t50_pct = stats.t50 / stats.games_played;
            delete stats.ranks;
        }
    }

    const teamSeasonalStats = new Map();
    allTeams.forEach(t => teamSeasonalStats.set(t.id, { conference: t.conference, wins: 0, losses: 0, pam: 0, apPAM_total: 0, apPAM_count: 0, ranks: [] }));
    schedule.forEach(g => {
        teamSeasonalStats.get(g.winner).wins++;
        const loserId = g.team1_id === g.winner ? g.team2_id : g.team1_id;
        teamSeasonalStats.get(loserId).losses++;
    });
    dailyScores.forEach(s => {
        const stats = teamSeasonalStats.get(s.data.team_id);
        stats.pam += s.data.points_above_median;
        stats.apPAM_total += s.data.pct_above_median;
        stats.apPAM_count++;
    });
    allLineups.forEach(l => {
        if (l.global_rank > 0) teamSeasonalStats.get(l.team_id).ranks.push(l.global_rank);
    });

    for (const stats of teamSeasonalStats.values()) {
        stats.med_starter_rank = calculateMedian(stats.ranks);
        delete stats.ranks;
        stats.wpct = (stats.wins + stats.losses) > 0 ? stats.wins / (stats.wins + stats.losses) : 0;
        stats.apPAM = stats.apPAM_count > 0 ? stats.apPAM_total / stats.apPAM_count : 0;
        stats.sortscore = stats.wpct + (stats.pam * 0.00000001);
        stats.MaxPotWins = 15 - stats.losses;
    }
    console.log("Step 6: Aggregated seasonal stats for players and teams.");

    // 7. CALCULATE RANKS
    const allPlayerStatsWithId = Array.from(playerSeasonalStats.entries()).map(([player_id, stats]) => ({ player_id, ...stats }));
    const allTeamCalculatedStats = Array.from(teamSeasonalStats.entries()).map(([teamId, stats]) => ({ teamId, ...stats }));
    
    // Player Ranks
    const playerRankings = {
        total_points: getRanks(allPlayerStatsWithId, 'total_points'),
        rel_mean: getRanks(allPlayerStatsWithId, 'rel_mean', null, false, 3),
        rel_median: getRanks(allPlayerStatsWithId, 'rel_median', null, false, 3),
        GEM: getRanks(allPlayerStatsWithId, 'GEM', null, true, 3),
        WAR: getRanks(allPlayerStatsWithId, 'WAR'),
        medrank: getRanks(allPlayerStatsWithId, 'medrank', null, true, 3),
        meanrank: getRanks(allPlayerStatsWithId, 'meanrank', null, true, 3),
        aag_mean: getRanks(allPlayerStatsWithId, 'aag_mean', 'aag_mean_pct'),
        aag_median: getRanks(allPlayerStatsWithId, 'aag_median', 'aag_median_pct'),
        t100: getRanks(allPlayerStatsWithId, 't100', 't100_pct'),
        t50: getRanks(allPlayerStatsWithId, 't50', 't50_pct'),
    };
    for (const [playerId, stats] of playerSeasonalStats.entries()) {
        for (const key in playerRankings) {
            stats[`${key}_rank`] = playerRankings[key].get(playerId) || null;
        }
    }

    // Team Ranks
    const teamRankings = {
        msr_rank: getRanks(allTeamCalculatedStats, 'med_starter_rank', null, true),
        pam_rank: getRanks(allTeamCalculatedStats, 'pam', null, false)
    };
    for (const stats of teamSeasonalStats.values()) {
        stats.msr_rank = teamRankings.msr_rank.get(stats.id);
        stats.pam_rank = teamRankings.pam_rank.get(stats.id);
    }
    console.log("Step 7: Calculated all player and team ranks.");

    // 8. WRITE ALL CALCULATED DATA TO FIRESTORE
    console.log("--- Writing all calculated data to Firestore ---");
    let batch = db.batch();
    const BATCH_SIZE = 400;
    let writeCount = 0;

    const commitBatchIfNeeded = async () => {
        if (writeCount >= BATCH_SIZE) {
            console.log(`Committing batch of ${writeCount} writes...`);
            await batch.commit();
            batch = db.batch();
            writeCount = 0;
        }
    };

    // Write Games, Lineups, Daily Averages, Daily Scores
    const seasonRef = db.collection(getCollectionName("seasons")).doc(SEASON_ID);
    for (const game of schedule) batch.set(seasonRef.collection(getCollectionName("games")).doc(game.id), game);
    for (const lineup of allLineups) batch.set(seasonRef.collection(getCollectionName("lineups")).doc(lineup.id), lineup);
    for (const [date, data] of dailyAveragesMap.entries()) {
        const yyyymmdd = new Date(date).toISOString().split('T')[0];
        batch.set(db.doc(`${getCollectionName('daily_averages')}/season_${SEASON_NUM}/${getCollectionName(`S${SEASON_NUM}_daily_averages`)}/${yyyymmdd}`), data);
    }
    for (const score of dailyScores) batch.set(db.doc(`${getCollectionName('daily_scores')}/season_${SEASON_NUM}/${getCollectionName(`S${SEASON_NUM}_daily_scores`)}/${score.docId}`), score.data);

    // Write Seasonal Stats
    for (const [playerId, stats] of playerSeasonalStats.entries()) batch.set(db.doc(`${getCollectionName('v2_players')}/${playerId}/${getCollectionName('seasonal_stats')}/${SEASON_ID}`), stats);
    for (const [teamId, stats] of teamSeasonalStats.entries()) batch.set(db.doc(`${getCollectionName('v2_teams')}/${teamId}/${getCollectionName('seasonal_records')}/${SEASON_ID}`), stats);
    
    // Write Leaderboards
    const karmaLeaderboard = [...allLineups].sort((a, b) => (b.points_adjusted || 0) - (a.points_adjusted || 0)).slice(0, 250);
    const rankLeaderboard = [...allLineups].filter(p => (p.global_rank || 0) > 0).sort((a, b) => (a.global_rank || 999) - (b.global_rank || 999)).slice(0, 250);
    batch.set(db.doc(`${getCollectionName('leaderboards')}/single_game_karma/${SEASON_ID}/data`), { rankings: karmaLeaderboard });
    batch.set(db.doc(`${getCollectionName('leaderboards')}/single_game_rank/${SEASON_ID}/data`), { rankings: rankLeaderboard });
    
    // Write Season Summary
    const season_karma = Array.from(playerSeasonalStats.values()).reduce((sum, p) => sum + (p.total_points || 0), 0);
    batch.set(seasonRef, {
        season_name: `Season ${SEASON_NUM}`, status: "completed", gs: schedule.length, gp: schedule.length,
        season_karma: season_karma, season_trans: 0, current_week: "Season Complete"
    }, { merge: true });

    // Commit all writes
    await batch.commit();
    console.log("✅ Simulation and all calculations complete!");
}

// --- Run the Simulation Script ---
simulateSeason().catch(console.error);
