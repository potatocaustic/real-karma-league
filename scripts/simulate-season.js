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

function getRanks(items, idField, primaryStat, tiebreakerStat = null, isAscending = false, gpMinimum = 0, excludeZeroes = false) {
    const rankedMap = new Map();
    let eligibleItems = [...items]; 

    if (gpMinimum > 0) {
        eligibleItems = items.filter(p => {
            const gamesPlayedField = primaryStat.startsWith('post_') ? 'post_games_played' : 'games_played';
            return (p[gamesPlayedField] || 0) >= gpMinimum;
        });
    }


    if (excludeZeroes) {
        eligibleItems = eligibleItems.filter(p => (p[primaryStat] || 0) !== 0);
    }

    eligibleItems.sort((a, b) => {
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

    eligibleItems.forEach((item, index) => {
        rankedMap.set(item[idField], index + 1);
    });
    return rankedMap;
}

// --- Main Simulation Function ---
async function simulateSeason() {
    console.log(`Starting regular season simulation for ${SEASON_ID}...`);
    console.log("---");

    // 1. FETCH TEAMS AND PLAYERS
    process.stdout.write("[1/9] Fetching teams and players...");
    const teamsSnap = await db.collection(getCollectionName("v2_teams")).get();
    const allTeams = teamsSnap.docs
        .map(doc => ({ team_id: doc.id, ...doc.data() }))
        .filter(team => team.conference === 'Eastern' || team.conference === 'Western');

    const previousSeasonId = `S${parseInt(SEASON_NUM) - 1}`;
    for (const team of allTeams) {
        const prevRecordRef = db.doc(`${getCollectionName('v2_teams')}/${team.team_id}/${getCollectionName('seasonal_records')}/${previousSeasonId}`);
        const prevRecordSnap = await prevRecordRef.get();
        if (prevRecordSnap.exists) {
            team.team_name = prevRecordSnap.data().team_name;
        } else {
            team.team_name = "Unknown Team";
        }
    }

    const playersSnap = await db.collection(getCollectionName("v2_players")).get();
    const allPlayers = playersSnap.docs.map(doc => ({ player_id: doc.id, ...doc.data() }));

    if (allTeams.length < 2) {
        console.error("Not enough valid conference teams found to generate a schedule. Aborting.");
        return;
    }
    console.log(` Done. Found ${allTeams.length} teams and ${allPlayers.length} players.`);

    // 2. GENERATE SCHEDULE
    process.stdout.write("[2/9] Generating 15-week regular season schedule...");
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
            const gameId = `${formattedDate}-${team1.team_id}-${team2.team_id}`.replace(/\//g, "-");
            schedule.push({ id: gameId, week: String(week), date: formattedDate, team1_id: team1.team_id, team2_id: team2.team_id, completed: 'FALSE', team1_score: 0, team2_score: 0, winner: '' });
        }
        gameDate.setDate(gameDate.getDate() + 7);
    }
    console.log(` Done. Generated ${schedule.length} games.`);

    // 3. SIMULATE GAMES AND LINEUPS
    process.stdout.write("[3/9] Simulating game results and generating lineup data...");
    const allLineups = [];
    for (const game of schedule) {
        let team1_total_score = 0;
        let team2_total_score = 0;

        [game.team1_id, game.team2_id].forEach((teamId, teamIndex) => {
            const teamPlayers = allPlayers.filter(p => p.current_team_id === teamId).slice(0, 6);
            teamPlayers.forEach((player, index) => {
                const points_adjusted = Math.floor(Math.random() * 15000);
                const global_rank = Math.floor(Math.random() * 3000) + 1;
                const isCaptain = index === 0;
                
                const final_score = isCaptain ? points_adjusted * 1.5 : points_adjusted;

                if (teamIndex === 0) {
                    team1_total_score += final_score;
                } else {
                    team2_total_score += final_score;
                }

                allLineups.push({ 
                    id: `${game.id}-${player.player_id}`, 
                    game_id: game.id, 
                    player_id: player.player_id, 
                    player_handle: player.player_handle, 
                    team_id: teamId, 
                    date: game.date, 
                    week: game.week, 
                    started: 'TRUE', 
                    is_captain: isCaptain ? 'TRUE' : 'FALSE', 
                    points_adjusted, 
                    global_rank, 
                    raw_score: points_adjusted,
                    final_score
                });
            });
        });

        game.team1_score = team1_total_score;
        game.team2_score = team2_total_score;
        game.winner = game.team1_score > game.team2_score ? game.team1_id : game.team2_id;
        game.completed = 'TRUE';
    }
    console.log(" Done.");

    // 4. CALCULATE DAILY AVERAGES
    process.stdout.write("[4/9] Calculating daily averages and enhancing lineups...");
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
        dailyAveragesMap.set(date, { date, week: dailyLineups[0]?.week, total_players: scores.length, mean_score: mean, median_score: median, replacement_level: replacement, win });
        dailyLineups.forEach(l => {
            const points = l.points_adjusted;
            l.above_mean = points - mean;
            l.AboveAvg = l.above_mean > 0 ? 1 : 0;
            l.pct_above_mean = mean ? l.above_mean / mean : 0;
            l.above_median = points - median;
            l.AboveMed = l.above_median > 0 ? 1 : 0;
            l.pct_above_median = median ? l.above_median / median : 0;
            l.SingleGameWar = win ? (points - replacement) / win : 0;
        });
    }
    console.log(" Done.");

    // 5. CALCULATE DAILY TEAM SCORES
    process.stdout.write("[5/9] Calculating daily team scores...");
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
                dailyScores.push({ docId: `${team.id}-${g.id}`, data: { week: g.week, team_id: team.id, date: g.date, score: team.score, daily_median: teamMedian, above_median: pam > 0 ? 1 : 0, points_above_median: pam, pct_above_median: teamMedian ? pam / teamMedian : 0 } });
            });
        });
    }
    console.log(" Done.");

    // 6. AGGREGATE SEASONAL STATS
    process.stdout.write("[6/9] Aggregating seasonal stats for players and teams...");
    const playerSeasonalStats = new Map();
    allLineups.forEach(l => {
        if (!playerSeasonalStats.has(l.player_id)) {
            playerSeasonalStats.set(l.player_id, { rookie: '0', all_star: '0' });
        }
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
    allTeams.forEach(t => teamSeasonalStats.set(t.team_id, { 
        team_id: t.team_id, 
        season: SEASON_ID,
        team_name: t.team_name, 
        conference: t.conference, 
        wins: 0, losses: 0, pam: 0, 
        apPAM_total: 0, apPAM_count: 0, 
        ranks: [],
        total_transactions: 0,
        playin: 0, playoffs: 0, elim: 0,
        tREL: 0
    }));
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

    const teamRelDataMap = new Map();
    for (const [playerId, playerStats] of playerSeasonalStats.entries()) {
        const playerTeamId = allPlayers.find(p => p.player_id === playerId)?.current_team_id;
        if (playerTeamId && teamSeasonalStats.has(playerTeamId)) {
            if (!teamRelDataMap.has(playerTeamId)) {
                teamRelDataMap.set(playerTeamId, { weightedSum: 0, totalGP: 0 });
            }
            const teamData = teamRelDataMap.get(playerTeamId);
            const relMedian = playerStats.rel_median || 0;
            const gamesPlayed = playerStats.games_played || 0;
            if (gamesPlayed > 0) {
                teamData.weightedSum += relMedian * gamesPlayed;
                teamData.totalGP += gamesPlayed;
            }
        }
    }
    for (const [teamId, data] of teamRelDataMap.entries()) {
        const teamStats = teamSeasonalStats.get(teamId);
        if (teamStats) {
            teamStats.tREL = data.totalGP > 0 ? data.weightedSum / data.totalGP : 0;
        }
    }

    for (const stats of teamSeasonalStats.values()) {
        stats.med_starter_rank = calculateMedian(stats.ranks);
        delete stats.ranks;
        stats.wpct = (stats.wins + stats.losses) > 0 ? stats.wins / (stats.wins + stats.losses) : 0;
        stats.apPAM = stats.apPAM_count > 0 ? stats.apPAM_total / stats.apPAM_count : 0;
        stats.sortscore = stats.wpct + (stats.pam * 0.00000001);
        stats.MaxPotWins = 15 - stats.losses;
    }
    console.log(" Done.");

    // 7. CALCULATE RANKS AND POSTSEED
    process.stdout.write("[7/9] Calculating all player and team ranks...");
    const allPlayerStatsWithId = Array.from(playerSeasonalStats.entries()).map(([player_id, stats]) => ({ player_id, ...stats }));
    const allTeamCalculatedStats = Array.from(teamSeasonalStats.values());
    
    const playerRankings = {
        total_points: getRanks(allPlayerStatsWithId, 'player_id', 'total_points'),
        rel_mean: getRanks(allPlayerStatsWithId, 'player_id', 'rel_mean', null, false, 3),
        rel_median: getRanks(allPlayerStatsWithId, 'player_id', 'rel_median', null, false, 3),
        GEM: getRanks(allPlayerStatsWithId, 'player_id', 'GEM', null, true, 3),
        WAR: getRanks(allPlayerStatsWithId, 'player_id', 'WAR'),
        medrank: getRanks(allPlayerStatsWithId, 'player_id', 'medrank', null, true, 3),
        meanrank: getRanks(allPlayerStatsWithId, 'player_id', 'meanrank', null, true, 3),
        aag_mean: getRanks(allPlayerStatsWithId, 'player_id', 'aag_mean', 'aag_mean_pct'),
        aag_median: getRanks(allPlayerStatsWithId, 'player_id', 'aag_median', 'aag_median_pct'),
        t100: getRanks(allPlayerStatsWithId, 'player_id', 't100', 't100_pct'),
        t50: getRanks(allPlayerStatsWithId, 'player_id', 't50', 't50_pct'),
    };
    for (const [playerId, stats] of playerSeasonalStats.entries()) {
        for (const key in playerRankings) stats[`${key}_rank`] = playerRankings[key].get(playerId) || null;
    }
    
    const teamRankings = {
        msr_rank: getRanks(allTeamCalculatedStats, 'team_id', 'med_starter_rank', null, true),
        pam_rank: getRanks(allTeamCalculatedStats, 'team_id', 'pam', null, false)
    };
    for (const stats of teamSeasonalStats.values()) {
        stats.msr_rank = teamRankings.msr_rank.get(stats.team_id) || null;
        stats.pam_rank = teamRankings.pam_rank.get(stats.team_id) || null;
    }

    const eastConf = allTeamCalculatedStats.filter(t => t.conference === 'Eastern');
    const westConf = allTeamCalculatedStats.filter(t => t.conference === 'Western');
    [eastConf, westConf].forEach(conf => {
        if (conf.length === 0) return;
        
        conf.sort((a, b) => (b.sortscore || 0) - (a.sortscore || 0)).forEach((t, i) => {
            const teamStats = teamSeasonalStats.get(t.team_id);
            if (teamStats) teamStats.postseed = i + 1;
        });

        const maxPotWinsSorted = [...conf].sort((a, b) => b.MaxPotWins - a.MaxPotWins);
        const winsSorted = [...conf].sort((a, b) => b.wins - a.wins);
        const playoffWinsThreshold = maxPotWinsSorted[6]?.MaxPotWins ?? 0;
        const playinWinsThreshold = maxPotWinsSorted[10]?.MaxPotWins ?? 0;
        const elimWinsThreshold = winsSorted[9]?.wins ?? 0;

        conf.forEach(t => {
            const teamStats = teamSeasonalStats.get(t.team_id);
            if (teamStats) {
                teamStats.playoffs = t.wins > playoffWinsThreshold ? 1 : 0;
                teamStats.playin = t.wins > playinWinsThreshold ? 1 : 0;
                teamStats.elim = t.MaxPotWins < elimWinsThreshold ? 1 : 0;
            }
        });
    });

    console.log(" Done.");

    // 8. CALCULATE AWARDS
    process.stdout.write("[8/9] Calculating performance awards...");
    const bestPlayerPerf = [...allLineups].sort((a, b) => (b.pct_above_median || 0) - (a.pct_above_median || 0))[0];
    const allDailyScoresData = [...dailyScores].map(s => s.data);
    const bestTeamPerf = allDailyScoresData.sort((a, b) => (b.pct_above_median || 0) - (a.pct_above_median || 0))[0];
    console.log(" Done.");


    // 9. WRITE ALL DATA TO FIRESTORE
    process.stdout.write("[9/9] Writing all calculated data to Firestore...");
    let batch = db.batch();
    const BATCH_SIZE = 400;
    let writeCount = 0;
    const commitBatchIfNeeded = async () => {
        if (writeCount >= BATCH_SIZE) {
            await batch.commit();
            batch = db.batch();
            writeCount = 0;
            process.stdout.write('.');
        }
    };

    const seasonRef = db.collection(getCollectionName("seasons")).doc(SEASON_ID);
    for (const game of schedule) { batch.set(seasonRef.collection(getCollectionName("games")).doc(game.id), game); writeCount++; await commitBatchIfNeeded(); }
    for (const lineup of allLineups) { batch.set(seasonRef.collection(getCollectionName("lineups")).doc(lineup.id), lineup); writeCount++; await commitBatchIfNeeded(); }
    
    const intermediateCollections = ['daily_averages', 'daily_scores'];
    for (const baseCollName of intermediateCollections) {
        batch.set(db.doc(`${getCollectionName(baseCollName)}/season_${SEASON_NUM}`), { description: `Simulation data for ${baseCollName}` });
        writeCount++; await commitBatchIfNeeded();
    }
    for (const [date, data] of dailyAveragesMap.entries()) {
        const yyyymmdd = new Date(date).toISOString().split('T')[0];
        batch.set(db.doc(`${getCollectionName('daily_averages')}/season_${SEASON_NUM}/${getCollectionName(`S${SEASON_NUM}_daily_averages`)}/${yyyymmdd}`), data);
        writeCount++; await commitBatchIfNeeded();
    }
    for (const score of dailyScores) { batch.set(db.doc(`${getCollectionName('daily_scores')}/season_${SEASON_NUM}/${getCollectionName(`S${SEASON_NUM}_daily_scores`)}/${score.docId}`), score.data); writeCount++; await commitBatchIfNeeded(); }
    
    for (const [playerId, stats] of playerSeasonalStats.entries()) { batch.set(db.doc(`${getCollectionName('v2_players')}/${playerId}/${getCollectionName('seasonal_stats')}/${SEASON_ID}`), stats); writeCount++; await commitBatchIfNeeded(); }
    for (const [teamId, stats] of teamSeasonalStats.entries()) { batch.set(db.doc(`${getCollectionName('v2_teams')}/${teamId}/${getCollectionName('seasonal_records')}/${SEASON_ID}`), stats); writeCount++; await commitBatchIfNeeded(); }
    
    const leaderboardCollRef = db.collection(getCollectionName('leaderboards'));
    batch.set(leaderboardCollRef.doc('single_game_karma'), { description: "Regular season single game karma leaderboard." }, { merge: true });
    batch.set(leaderboardCollRef.doc('single_game_rank'), { description: "Regular season single game rank leaderboard." }, { merge: true });
    const karmaLeaderboard = [...allLineups].sort((a, b) => (b.points_adjusted || 0) - (a.points_adjusted || 0)).slice(0, 250);
    const rankLeaderboard = [...allLineups].filter(p => (p.global_rank || 0) > 0).sort((a, b) => (a.global_rank || 999) - (b.global_rank || 999)).slice(0, 250);
    batch.set(leaderboardCollRef.doc('single_game_karma').collection(SEASON_ID).doc('data'), { rankings: karmaLeaderboard });
    batch.set(leaderboardCollRef.doc('single_game_rank').collection(SEASON_ID).doc('data'), { rankings: rankLeaderboard });
    
    const awardsParentDocRef = db.doc(`${getCollectionName('awards')}/season_${SEASON_NUM}`);
    batch.set(awardsParentDocRef, { description: `Awards for Season ${SEASON_NUM}` });
    const awardsCollectionRef = awardsParentDocRef.collection(getCollectionName(`S${SEASON_NUM}_awards`));
    if (bestPlayerPerf) {
        batch.set(awardsCollectionRef.doc('best_performance_player'), { award_name: "Best Performance (Player)", player_id: bestPlayerPerf.player_id, player_handle: bestPlayerPerf.player_handle, team_id: bestPlayerPerf.team_id, date: bestPlayerPerf.date, value: bestPlayerPerf.pct_above_median });
    }
    if (bestTeamPerf) {
        const teamName = allTeams.find(t => t.team_id === bestTeamPerf.team_id)?.team_name || 'Unknown';
        batch.set(awardsCollectionRef.doc('best_performance_team'), { award_name: "Best Performance (Team)", team_id: bestTeamPerf.team_id, team_name: teamName, date: bestTeamPerf.date, value: bestTeamPerf.pct_above_median });
    }

    const season_karma = Array.from(playerSeasonalStats.values()).reduce((sum, p) => sum + (p.total_points || 0), 0);
    batch.set(seasonRef, {
        season_name: `Season ${SEASON_NUM}`,
        status: "active",
        gs: schedule.length,
        gp: schedule.length,
        season_karma: season_karma,
        season_trans: 0,
        current_week: "Season Complete"
    }, { merge: true });

    if (writeCount > 0) await batch.commit();
    console.log(" Done.");
    console.log("---");
    console.log("✅ Simulation and all calculations complete!");
}

// --- Run the Simulation Script ---
simulateSeason().catch(console.error);