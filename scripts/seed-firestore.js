// /scripts/seed-firestore.js

const admin = require("firebase-admin");
const fetch = require("node-fetch");

// Initialize the Firebase Admin SDK.
admin.initializeApp({
    projectId: "real-karma-league",
});

const db = admin.firestore();

// --- CONFIGURATION ---
const SPREADSHEET_ID = "1D1YUw9931ikPLihip3tn7ynkoJGFUHxtogfrq_Hz3P0";
const BASE_URL = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=`;
const SEASON_ID = "S7";
const SEASON_NUM = "7";
const SEASON_STATUS = "active";
const USE_DEV_COLLECTIONS = false;

// --- Helper to switch between dev/prod collections ---
const getCollectionName = (baseName) => {
    return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
};


// --- Helper Functions from Cloud Functions ---
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

function parseNumber(value) {
    const num = parseFloat(String(value).replace(/,/g, ''));
    return isNaN(num) ? 0 : num;
}

// --- Ranking function from index.js ---
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


// --- Data Fetching and Parsing ---
async function fetchSheetData(sheetName) {
    try {
        console.log(`Fetching sheet: ${sheetName}...`);
        const response = await fetch(BASE_URL + encodeURIComponent(sheetName));
        if (!response.ok) throw new Error(`Failed to fetch sheet: ${sheetName}`);
        const csvText = await response.text();
        return parseCSV(csvText);
    } catch (error) {
        console.error(error);
        return [];
    }
}

function parseCSV(csvText) {
    const lines = csvText.trim().split('\n').filter(line => line.trim() !== '');
    if (lines.length === 0) return [];
    const headers = lines.shift().split(',').map(h => h.replace(/"/g, '').trim());
    return lines.map(line => {
        const values = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || [];
        const row = {};
        headers.forEach((header, i) => {
            if (header) row[header] = (values[i] || '').replace(/"/g, '').trim();
        });
        return row;
    });
}

// --- Main Seeding Function ---
async function seedDatabase() {
    console.log("Starting database seed process...");

    // 1. FETCH ALL RAW DATA
    const [
        playersData,
        teamsData,
        scheduleData,
        postScheduleData,
        lineupsData,
        postLineupsData,
        draftPicksData,
        transactionsData
    ] = await Promise.all([
        fetchSheetData("Players"),
        fetchSheetData("Teams"),
        fetchSheetData("Schedule"),
        fetchSheetData("Post_Schedule").then(data => data.filter(g => g.completed === 'TRUE')),
        fetchSheetData("Lineups"),
        fetchSheetData("Post_Lineups"),
        fetchSheetData("Draft_Capital"),
        fetchSheetData("Transaction_Log")
    ]);
    console.log("All raw data fetched.");

    const completedScheduleData = scheduleData.filter(g => g.completed === 'TRUE');

    [...lineupsData, ...postLineupsData].forEach(l => {
        l.points_adjusted = parseNumber(l.points_adjusted);
        l.global_rank = parseNumber(l.global_rank);
        l.raw_score = parseNumber(l.raw_score);
    });

    // --- 2. PRE-CALCULATIONS & DATA ENHANCEMENT ---
    const dailyAveragesMap = new Map();
    const postDailyAveragesMap = new Map();

    const processDailyData = (lineups, dailyAverages) => {
        const lineupsByDate = new Map();
        lineups.forEach(l => {
            if (l.started === 'TRUE') {
                if (!lineupsByDate.has(l.date)) lineupsByDate.set(l.date, []);
                lineupsByDate.get(l.date).push(l);
            }
        });

        for (const [date, dailyLineups] of lineupsByDate.entries()) {
            const scores = dailyLineups.map(l => l.points_adjusted);
            const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
            const median = calculateMedian(scores);
            const replacement = median * 0.9;
            const win = median * 0.92;

            const week = dailyLineups[0]?.week || '';
            dailyAverages.set(date, { date, week, total_players: scores.length, mean_score: mean, median_score: median, replacement_level: replacement, win });

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
    };
    console.log("Calculating daily averages and enhancing lineup data...");
    processDailyData(lineupsData, dailyAveragesMap);
    processDailyData(postLineupsData, postDailyAveragesMap);

    const dailyScores = [];
    const postDailyScores = [];
    const processTeamScores = (schedule, dailyScoresOutput) => {
        const gamesByDate = new Map();
        schedule.forEach(g => {
            if (!gamesByDate.has(g.date)) gamesByDate.set(g.date, []);
            gamesByDate.get(g.date).push(g);
        });

        for (const [date, games] of gamesByDate.entries()) {
            const teamScores = games.flatMap(g => [parseNumber(g.team1_score), parseNumber(g.team2_score)]);
            const teamMedian = calculateMedian(teamScores);

            games.forEach(g => {
                const gameId = `${g.date}-${g.team1_id}-${g.team2_id}`.replace(/\//g, "-");
                [{ id: g.team1_id, score: parseNumber(g.team1_score) }, { id: g.team2_id, score: parseNumber(g.team2_score) }].forEach(team => {
                    const pam = team.score - teamMedian;
                    dailyScoresOutput.push({
                        docId: `${team.id}-${gameId}`,
                        data: {
                            week: g.week, team_id: team.id, date: date, score: team.score, daily_median: teamMedian,
                            above_median: pam > 0 ? 1 : 0, points_above_median: pam, pct_above_median: teamMedian ? pam / teamMedian : 0
                        }
                    });
                });
            });
        }
    };
    console.log("Calculating daily team scores...");
    processTeamScores(completedScheduleData, dailyScores);
    processTeamScores(postScheduleData, postDailyScores);

    // --- 3. AGGREGATE SEASONAL STATS ---
    const playerSeasonalStats = new Map();
    const aggregatePlayerStats = (lineups, dailyAverages, isPostseason) => {
        const prefix = isPostseason ? 'post_' : '';
        const statKey = (key) => `${prefix}${key}`;

        lineups.forEach(l => {
            if (l.started !== 'TRUE') return;

            if (!playerSeasonalStats.has(l.player_id)) playerSeasonalStats.set(l.player_id, {});
            const stats = playerSeasonalStats.get(l.player_id);

            stats[statKey('games_played')] = (stats[statKey('games_played')] || 0) + 1;
            stats[statKey('total_points')] = (stats[statKey('total_points')] || 0) + l.points_adjusted;
            stats[statKey('WAR')] = (stats[statKey('WAR')] || 0) + l.SingleGameWar;
            stats[statKey('aag_mean')] = (stats[statKey('aag_mean')] || 0) + l.AboveAvg;
            stats[statKey('aag_median')] = (stats[statKey('aag_median')] || 0) + l.AboveMed;
            if (l.global_rank > 0) {
                if (!stats[statKey('ranks')]) stats[statKey('ranks')] = [];
                stats[statKey('ranks')].push(l.global_rank);
            }
            const dailyAvg = dailyAverages.get(l.date);
            if (dailyAvg) {
                stats[statKey('meansum')] = (stats[statKey('meansum')] || 0) + dailyAvg.mean_score;
                stats[statKey('medsum')] = (stats[statKey('medsum')] || 0) + dailyAvg.median_score;
            }
        });

        for (const stats of playerSeasonalStats.values()) {
            if (stats[statKey('games_played')]) {
                stats[statKey('aag_mean_pct')] = stats[statKey('aag_mean')] / stats[statKey('games_played')];
                stats[statKey('aag_median_pct')] = stats[statKey('aag_median')] / stats[statKey('games_played')];
                stats[statKey('rel_mean')] = stats[statKey('meansum')] > 0 ? stats[statKey('total_points')] / stats[statKey('meansum')] : 0;
                stats[statKey('rel_median')] = stats[statKey('medsum')] > 0 ? stats[statKey('total_points')] / stats[statKey('medsum')] : 0;
                stats[statKey('medrank')] = calculateMedian(stats[statKey('ranks')] || []);
                stats[statKey('meanrank')] = calculateMean(stats[statKey('ranks')] || []);
                stats[statKey('GEM')] = calculateGeometricMean(stats[statKey('ranks')] || []);
                stats[statKey('t100')] = (stats[statKey('ranks')] || []).filter(r => r > 0 && r <= 100).length;
                stats[statKey('t50')] = (stats[statKey('ranks')] || []).filter(r => r > 0 && r <= 50).length;
                stats[statKey('t100_pct')] = stats[statKey('t100')] / stats[statKey('games_played')];
                stats[statKey('t50_pct')] = stats[statKey('t50')] / stats[statKey('games_played')];
                delete stats[statKey('ranks')];
            }
        }
    };
    console.log("Aggregating player seasonal stats...");
    aggregatePlayerStats(lineupsData, dailyAveragesMap, false);
    aggregatePlayerStats(postLineupsData, postDailyAveragesMap, true);

    const teamSeasonalStats = new Map();
    const aggregateTeamStats = (schedule, dailyScores, lineups, isPostseason) => {
        const prefix = isPostseason ? 'post_' : '';
        const statKey = (key) => `${prefix}${key}`;

        teamsData.forEach(t => {
            if (!teamSeasonalStats.has(t.team_id)) teamSeasonalStats.set(t.team_id, { conference: t.conference });
        });

        schedule.forEach(g => {
            const winnerStats = teamSeasonalStats.get(g.winner);
            const loserId = g.team1_id === g.winner ? g.team2_id : g.team1_id;
            const loserStats = teamSeasonalStats.get(loserId);
            if (winnerStats) winnerStats[statKey('wins')] = (winnerStats[statKey('wins')] || 0) + 1;
            if (loserStats) loserStats[statKey('losses')] = (loserStats[statKey('losses')] || 0) + 1;
        });

        dailyScores.forEach(s => {
            const stats = teamSeasonalStats.get(s.data.team_id);
            if (stats) {
                stats[statKey('pam')] = (stats[statKey('pam')] || 0) + s.data.points_above_median;
                if (!isPostseason) {
                    stats.apPAM_total = (stats.apPAM_total || 0) + s.data.pct_above_median;
                    stats.apPAM_count = (stats.apPAM_count || 0) + 1;
                }
            }
        });

        lineups.forEach(l => {
            if (l.started === 'TRUE' && l.global_rank > 0) {
                const stats = teamSeasonalStats.get(l.team_id);
                if (stats) {
                    if (!stats[statKey('ranks')]) stats[statKey('ranks')] = [];
                    stats[statKey('ranks')].push(l.global_rank);
                }
            }
        });
        
        const teamRelDataMap = new Map();
        playersData.forEach(player => {
            const playerStats = playerSeasonalStats.get(player.player_id);
            const teamId = player.current_team_id;

            if (teamId && playerStats) {
                if (!teamRelDataMap.has(teamId)) {
                    teamRelDataMap.set(teamId, {
                        weightedSum: 0, totalGP: 0,
                        post_weightedSum: 0, post_totalGP: 0
                    });
                }
                const teamData = teamRelDataMap.get(teamId);
                if (playerStats.games_played > 0) {
                    teamData.weightedSum += (playerStats.rel_median || 0) * (playerStats.games_played || 0);
                    teamData.totalGP += playerStats.games_played || 0;
                }
                if (playerStats.post_games_played > 0) {
                    teamData.post_weightedSum += (playerStats.post_rel_median || 0) * (playerStats.post_games_played || 0);
                    teamData.post_totalGP += playerStats.post_games_played || 0;
                }
            }
        });

        for (const [teamId, stats] of teamSeasonalStats.entries()) {
            stats[statKey('med_starter_rank')] = calculateMedian(stats[statKey('ranks')] || []);
            delete stats[statKey('ranks')];
            
            const relData = teamRelDataMap.get(teamId);
            if (relData) {
                stats.tREL = relData.totalGP > 0 ? relData.weightedSum / relData.totalGP : 0;
                stats.post_tREL = relData.post_totalGP > 0 ? relData.post_weightedSum / relData.post_totalGP : 0;
            }

            if (!isPostseason) {
                const wins = stats.wins || 0;
                const losses = stats.losses || 0;
                stats.wpct = (wins + losses) > 0 ? wins / (wins + losses) : 0;
                stats.apPAM = stats.apPAM_count > 0 ? stats.apPAM_total / stats.apPAM_count : 0;
                stats.sortscore = stats.wpct + ((stats.pam || 0) * 0.00000001);
                stats.MaxPotWins = 15 - losses;
            }
        }
    };

    console.log("Aggregating team seasonal stats...");
    aggregateTeamStats(completedScheduleData, dailyScores, lineupsData, false);
    aggregateTeamStats(postScheduleData, postDailyScores, postLineupsData, true);

    const allTeamCalculatedStats = Array.from(teamSeasonalStats.entries()).map(([teamId, stats]) => ({ teamId, ...stats }));
    const rankAndSort = (teams, stat, ascending = true, rankKey) => {
        [...teams].sort((a, b) => ascending ? (a[stat] || 0) - (b[stat] || 0) : (b[stat] || 0) - (a[stat] || 0))
            .forEach((team, i) => team[rankKey] = i + 1);
    };

    rankAndSort(allTeamCalculatedStats, 'med_starter_rank', true, 'msr_rank');
    rankAndSort(allTeamCalculatedStats, 'pam', false, 'pam_rank');
    rankAndSort(allTeamCalculatedStats, 'post_med_starter_rank', true, 'post_msr_rank');
    rankAndSort(allTeamCalculatedStats, 'post_pam', false, 'post_pam_rank');

    const eastConf = allTeamCalculatedStats.filter(t => t.conference === 'Eastern');
    const westConf = allTeamCalculatedStats.filter(t => t.conference === 'Western');
    [eastConf, westConf].forEach(conf => {
        if (conf.length === 0) return;
        conf.sort((a, b) => (b.sortscore || 0) - (a.sortscore || 0)).forEach((t, i) => t.postseed = i + 1);
        const maxPotWinsSorted = [...conf].sort((a, b) => (b.MaxPotWins || 0) - (a.MaxPotWins || 0));
        const winsSorted = [...conf].sort((a, b) => (b.wins || 0) - (a.wins || 0));
        const playoffWinsThreshold = maxPotWinsSorted[6]?.MaxPotWins ?? 0;
        const playinWinsThreshold = maxPotWinsSorted[10]?.MaxPotWins ?? 0;
        const elimWinsThreshold = winsSorted[9]?.wins ?? 0;
        conf.forEach(t => {
            t.playoffs = (t.wins || 0) > playoffWinsThreshold ? 1 : 0;
            t.playin = (t.wins || 0) > playinWinsThreshold ? 1 : 0;
            t.elim = (t.MaxPotWins || 0) < elimWinsThreshold ? 1 : 0;
        });
    });

    allTeamCalculatedStats.forEach(t => teamSeasonalStats.set(t.teamId, t));

    // --- Calculate Player Ranks ---
    console.log("Calculating player stat rankings...");
    const allPlayerStatsWithId = Array.from(playerSeasonalStats.entries()).map(([player_id, stats]) => ({ player_id, ...stats }));
    const regSeasonGpMinimum = completedScheduleData.length >= 60 ? 3 : 0;
    const postSeasonGpMinimum = 0;
    const statsToExcludeZeroes = new Set(['total_points', 'rel_mean', 'rel_median', 'GEM', 'WAR', 'medrank', 'meanrank']);

    const leaderboards = {
        total_points: getRanks(allPlayerStatsWithId, 'total_points', null, false, 0, statsToExcludeZeroes.has('total_points')),
        rel_mean: getRanks(allPlayerStatsWithId, 'rel_mean', null, false, regSeasonGpMinimum, statsToExcludeZeroes.has('rel_mean')),
        rel_median: getRanks(allPlayerStatsWithId, 'rel_median', null, false, regSeasonGpMinimum, statsToExcludeZeroes.has('rel_median')),
        GEM: getRanks(allPlayerStatsWithId, 'GEM', null, true, regSeasonGpMinimum, statsToExcludeZeroes.has('GEM')),
        WAR: getRanks(allPlayerStatsWithId, 'WAR', null, false, 0, statsToExcludeZeroes.has('WAR')),
        medrank: getRanks(allPlayerStatsWithId, 'medrank', null, true, regSeasonGpMinimum, statsToExcludeZeroes.has('medrank')),
        meanrank: getRanks(allPlayerStatsWithId, 'meanrank', null, true, regSeasonGpMinimum, statsToExcludeZeroes.has('meanrank')),
        aag_mean: getRanks(allPlayerStatsWithId, 'aag_mean', 'aag_mean_pct'),
        aag_median: getRanks(allPlayerStatsWithId, 'aag_median', 'aag_median_pct'),
        t100: getRanks(allPlayerStatsWithId, 't100', 't100_pct'),
        t50: getRanks(allPlayerStatsWithId, 't50', 't50_pct'),
        post_total_points: getRanks(allPlayerStatsWithId, 'post_total_points', null, false, 0, statsToExcludeZeroes.has('total_points')),
        post_rel_mean: getRanks(allPlayerStatsWithId, 'post_rel_mean', null, false, postSeasonGpMinimum, statsToExcludeZeroes.has('rel_mean')),
        post_rel_median: getRanks(allPlayerStatsWithId, 'post_rel_median', null, false, postSeasonGpMinimum, statsToExcludeZeroes.has('rel_median')),
        post_GEM: getRanks(allPlayerStatsWithId, 'post_GEM', null, true, postSeasonGpMinimum, statsToExcludeZeroes.has('GEM')),
        post_WAR: getRanks(allPlayerStatsWithId, 'post_WAR', null, false, 0, statsToExcludeZeroes.has('WAR')),
        post_medrank: getRanks(allPlayerStatsWithId, 'post_medrank', null, true, postSeasonGpMinimum, statsToExcludeZeroes.has('medrank')),
        post_meanrank: getRanks(allPlayerStatsWithId, 'post_meanrank', null, true, postSeasonGpMinimum, statsToExcludeZeroes.has('meanrank')),
        post_aag_mean: getRanks(allPlayerStatsWithId, 'post_aag_mean', 'post_aag_mean_pct'),
        post_aag_median: getRanks(allPlayerStatsWithId, 'post_aag_median', 'post_aag_median_pct'),
        post_t100: getRanks(allPlayerStatsWithId, 'post_t100', 'post_t100_pct'),
        post_t50: getRanks(allPlayerStatsWithId, 'post_t50', 'post_t50_pct'),
    };

    for (const [playerId, stats] of playerSeasonalStats.entries()) {
        for (const key in leaderboards) {
            stats[`${key}_rank`] = leaderboards[key].get(playerId) || null;
        }
    }


    // --- 4. SEED DATABASE ---
    const BATCH_SIZE = 400;
    let batch = db.batch();
    let writeCount = 0;

    const commitBatchIfNeeded = async () => {
        if (writeCount >= BATCH_SIZE) {
            console.log(`Committing batch of ${writeCount} writes...`);
            await batch.commit();
            batch = db.batch();
            writeCount = 0;
        }
    };

    // =================================================================
    // START: MODIFIED BLOCK FOR TRANSACTION PROCESSING
    // =================================================================
    console.log("Grouping and transforming legacy transaction data...");

    // Create a placeholder document for the 'seasons' subcollection parent
    const transactionsCollectionName = getCollectionName("transactions");
    const seasonsDocRef = db.collection(transactionsCollectionName).doc('seasons');
    batch.set(seasonsDocRef, { description: "Parent document for seasonal transaction data." }, { merge: true });
    writeCount++;
    await commitBatchIfNeeded();
    console.log(`Placeholder document created at '${transactionsCollectionName}/seasons'.`);

    // Group rows by transaction_id
    const groupedTransactions = transactionsData.reduce((acc, row) => {
        const id = row.transaction_id;
        if (id) {
            if (!acc[id]) {
                acc[id] = [];
            }
            acc[id].push(row);
        }
        return acc;
    }, {});

    // Transform each group into the new format and add to batch
    for (const transactionId in groupedTransactions) {
        const rows = groupedTransactions[transactionId];
        const firstRow = rows[0];
        
        // Skip if the date is invalid to prevent crashes
        if (!firstRow.date || !firstRow.date.includes('/')) {
            console.warn(`Skipping transaction ${transactionId} due to invalid date: "${firstRow.date}"`);
            continue;
        }

        const involvedTeams = new Set();
        const involvedPlayers = [];
        const involvedPicks = [];

        rows.forEach(row => {
            // Add teams to a set to ensure uniqueness
            if (row.from_team) involvedTeams.add(row.from_team);
            if (row.to_team) involvedTeams.add(row.to_team);

            // Add player asset if it exists
            if (row.player_id) {
                involvedPlayers.push({
                    id: row.player_id,
                    from: row.from_team || null,
                    to: row.to_team || null,
                });
            }

            // Add draft pick asset if it exists
            if (row.draft_pick_id) {
                involvedPicks.push({
                    id: row.draft_pick_id,
                    from: row.from_team || null,
                    to: row.to_team || null,
                });
            }
        });
        
        const newTransaction = {
            // Firestore SDK can convert JS Date objects to Timestamps
            timestamp: admin.firestore.Timestamp.fromDate(new Date(firstRow.date)),
            type: firstRow.transaction_type.toUpperCase() || 'UNKNOWN',
            notes: firstRow.notes || '',
            involved_teams: Array.from(involvedTeams),
            involved_players: involvedPlayers,
            involved_picks: involvedPicks,
            legacy_id: transactionId, // For easy cross-referencing
            season: SEASON_ID, // Add the season field
        };

        // Write to the new nested collection structure
        const transactionDocRef = db.collection(transactionsCollectionName).doc('seasons').collection(SEASON_ID).doc(transactionId);
        batch.set(transactionDocRef, newTransaction);
        writeCount++;
        await commitBatchIfNeeded();
    }
    console.log(`Prepared ${Object.keys(groupedTransactions).length} transactions for seeding into '${transactionsCollectionName}/seasons/${SEASON_ID}'.`);
    // =================================================================
    // END: MODIFIED BLOCK FOR TRANSACTION PROCESSING
    // =================================================================


    // Seed Teams and Seasonal Records
    for (const team of teamsData) {
        const teamDocRef = db.collection(getCollectionName("v2_teams")).doc(team.team_id);
        // MODIFIED: Added gm_player_id to the static data for the team's root document
        const staticData = {
            team_id: team.team_id,
            conference: team.conference,
            current_gm_handle: team.current_gm_handle,
            gm_uid: team.gm_uid,
            gm_player_id: team.gm_player_id || null
        };
        batch.set(teamDocRef, staticData, { merge: true });
        writeCount++;

        const seasonalData = teamSeasonalStats.get(team.team_id) || {};
        seasonalData.team_name = team.team_name;
        seasonalData.team_id = team.team_id;
        // MODIFIED: Also add gm_player_id to the seasonal record for historical tracking
        seasonalData.gm_player_id = team.gm_player_id || null;
        seasonalData.season = SEASON_ID;
        delete seasonalData.teamId;

        const seasonRecordRef = teamDocRef.collection(getCollectionName("seasonal_records")).doc(SEASON_ID);
        batch.set(seasonRecordRef, seasonalData, { merge: true });
        writeCount++;
        await commitBatchIfNeeded();
    }
    console.log(`Prepared ${teamsData.length} teams and their seasonal stats for seeding.`);

    // Seed Players and Seasonal Stats (Now with Ranks)
    for (const player of playersData) {
        const playerDocRef = db.collection(getCollectionName("v2_players")).doc(player.player_id);
        const staticData = {
            player_handle: player.player_handle,
            player_status: player.player_status,
            current_team_id: player.current_team_id
        };
        batch.set(playerDocRef, staticData);
        writeCount++;

        if (playerSeasonalStats.has(player.player_id)) {
            const seasonalData = playerSeasonalStats.get(player.player_id);
            seasonalData.rookie = player.rookie || '0';
            seasonalData.all_star = player.all_star || '0';

            const seasonStatsRef = playerDocRef.collection(getCollectionName("seasonal_stats")).doc(SEASON_ID);
            batch.set(seasonStatsRef, seasonalData);
            writeCount++;
        }
        await commitBatchIfNeeded();
    }
    console.log(`Prepared ${playersData.length} players and their ranked seasonal stats for seeding.`);

    // Calculate and set Season Summary Data
    const seasonRef = db.collection(getCollectionName("seasons")).doc(SEASON_ID);
    const season_gs = scheduleData.length;
    const season_gp = completedScheduleData.length;
    const season_karma = allPlayerStatsWithId.reduce((sum, p) => sum + (p.total_points || 0) + (p.post_total_points || 0), 0);
    const season_trans = new Set(transactionsData.map(t => t.transaction_id).filter(Boolean)).size;

    batch.set(seasonRef, {
        season_name: `Season ${SEASON_NUM}`,
        status: SEASON_STATUS,
        gs: season_gs,
        gp: season_gp,
        season_karma: season_karma,
        season_trans: season_trans,
        current_week: "Season Complete"
    }, { merge: true });
    writeCount++;
    console.log(`Prepared parent document for season ${SEASON_ID} with summary stats.`);


    // Seed Games
    for (const game of [...scheduleData, ...postScheduleData]) {
        const gameId = `${game.date}-${game.team1_id}-${game.team2_id}`.replace(/\//g, "-");
        const collectionName = scheduleData.includes(game) ? getCollectionName("games") : getCollectionName("post_games");
        batch.set(seasonRef.collection(collectionName).doc(gameId), game);
        writeCount++;
        await commitBatchIfNeeded();
    }
    console.log(`Prepared ${scheduleData.length + postScheduleData.length} games for seeding.`);

    const scheduleMap = new Map();
    [...scheduleData, ...postScheduleData].forEach(game => {
        const date = game.date.replace(/\//g, "-");
        scheduleMap.set(`${date}|${game.team1_id}`, game.team2_id);
        scheduleMap.set(`${date}|${game.team2_id}`, game.team1_id);
    });

    // Seed Lineups
    for (const lineup of [...lineupsData, ...postLineupsData]) {
        const date = lineup.date.replace(/\//g, "-");
        const opponentId = scheduleMap.get(`${date}|${lineup.team_id}`);

        if (!opponentId) {
            console.warn(`Could not find opponent for team ${lineup.team_id} on ${date}. Skipping lineup for ${lineup.player_handle}.`);
            continue;
        }

        const teams = [lineup.team_id, opponentId].sort();
        const gameId = `${date}-${teams[0]}-${teams[1]}`;
        const lineupId = `${gameId}-${lineup.player_id}`;
        const collectionName = lineupsData.includes(lineup) ? getCollectionName("lineups") : getCollectionName("post_lineups");
        lineup.game_id = gameId;

        batch.set(seasonRef.collection(collectionName).doc(lineupId), lineup);
        writeCount++;
        await commitBatchIfNeeded();
    }
    console.log(`Prepared ${lineupsData.length + postLineupsData.length} enhanced lineups with corrected IDs for seeding.`);

    // Seed Draft Picks
    for (const pick of draftPicksData) {
        if (pick.pick_id) {
            batch.set(db.collection(getCollectionName("draftPicks")).doc(pick.pick_id), pick);
            writeCount++;
            await commitBatchIfNeeded();
        }
    }
    console.log(`Prepared ${draftPicksData.length} draft picks for seeding.`);

    // Create placeholder documents for intermediate collections FIRST
    console.log("Creating placeholder documents for intermediate collections...");
    const intermediateCollections = ['daily_averages', 'daily_scores', 'post_daily_averages', 'post_daily_scores'];
    for (const baseCollName of intermediateCollections) {
        const collName = getCollectionName(baseCollName);
        const docRef = db.doc(`${collName}/season_${SEASON_NUM}`);
        const description = `${baseCollName.replace(/_/g, ' ')} for Season ${SEASON_NUM}`;
        batch.set(docRef, { description: description });
        writeCount++;
        await commitBatchIfNeeded();
    }


    // Seed Intermediate Collections
    const seedIntermediate = async (map, baseCollName) => {
        const collName = getCollectionName(baseCollName);
        for (const [date, data] of map.entries()) {
            if (!date || typeof date !== 'string' || !date.includes('/')) {
                console.warn(`Skipping invalid or empty date key found in source data for collection: ${collName}`);
                continue;
            }
            const [month, day, year] = date.split('/');
            if (!year || !month || !day) {
                console.warn(`Skipping malformed date key: "${date}" in ${collName}.`);
                continue;
            }
            const yyyymmdd = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
            const docRef = db.doc(`${collName}/season_${SEASON_NUM}/${getCollectionName(`S${SEASON_NUM}_${baseCollName}`)}/${yyyymmdd}`);
            batch.set(docRef, data);
            writeCount++;
            await commitBatchIfNeeded();
        }
    };
    await seedIntermediate(dailyAveragesMap, 'daily_averages');
    await seedIntermediate(postDailyAveragesMap, 'post_daily_averages');
    console.log(`Prepared ${dailyAveragesMap.size + postDailyAveragesMap.size} daily average documents.`);

    const seedScores = async (scores, baseCollName) => {
        const collName = getCollectionName(baseCollName);
        for (const s of scores) {
            batch.set(db.doc(`${collName}/season_${SEASON_NUM}/${getCollectionName(`S${SEASON_NUM}_${baseCollName}`)}/${s.docId}`), s.data);
            writeCount++;
            await commitBatchIfNeeded();
        }
    };
    await seedScores(dailyScores, 'daily_scores');
    await seedScores(postDailyScores, 'post_daily_scores');
    console.log(`Prepared ${dailyScores.length + postDailyScores.length} daily team score documents.`);

    // Create placeholder documents for leaderboard collections
    console.log("Creating placeholder documents for leaderboard collections...");
    const leaderboardCollections = {
        'leaderboards': ['single_game_karma', 'single_game_rank'],
        'post_leaderboards': ['post_single_game_karma', 'post_single_game_rank']
    };

    for (const [baseColl, docs] of Object.entries(leaderboardCollections)) {
        for (const docId of docs) {
            const docRef = db.collection(getCollectionName(baseColl)).doc(docId);
            const description = `${docId.replace(/_/g, ' ')} leaderboard`;
            batch.set(docRef, { description: description });
            writeCount++;
            await commitBatchIfNeeded();
        }
    }


    // --- Seed Leaderboards and Awards ---
    console.log("Seeding leaderboards and awards...");

    const awardsParentDocRef = db.doc(`${getCollectionName('awards')}/season_${SEASON_NUM}`);
    batch.set(awardsParentDocRef, { description: `Awards for Season ${SEASON_NUM}` });
    writeCount++;
    await commitBatchIfNeeded();


    // Regular Season Leaderboards
    const karmaLeaderboard = [...lineupsData].sort((a, b) => (b.points_adjusted || 0) - (a.points_adjusted || 0)).slice(0, 250);
    const rankLeaderboard = [...lineupsData].filter(p => (p.global_rank || 0) > 0).sort((a, b) => (a.global_rank || 999) - (b.global_rank || 999)).slice(0, 250);
    const karmaRef = db.collection(getCollectionName('leaderboards')).doc('single_game_karma').collection(SEASON_ID).doc('data');
    const rankRef = db.collection(getCollectionName('leaderboards')).doc('single_game_rank').collection(SEASON_ID).doc('data');
    batch.set(karmaRef, { rankings: karmaLeaderboard });
    batch.set(rankRef, { rankings: rankLeaderboard });
    writeCount += 2;

    // Postseason Leaderboards
    const postKarmaLeaderboard = [...postLineupsData].sort((a, b) => (b.points_adjusted || 0) - (a.points_adjusted || 0)).slice(0, 250);
    const postRankLeaderboard = [...postLineupsData].filter(p => (p.global_rank || 0) > 0).sort((a, b) => (a.global_rank || 999) - (b.global_rank || 999)).slice(0, 250);
    const postKarmaRef = db.collection(getCollectionName('post_leaderboards')).doc('post_single_game_karma').collection(SEASON_ID).doc('data');
    const postRankRef = db.collection(getCollectionName('post_leaderboards')).doc('post_single_game_rank').collection(SEASON_ID).doc('data');
    batch.set(postKarmaRef, { rankings: postKarmaLeaderboard });
    batch.set(postRankRef, { rankings: postRankLeaderboard });
    writeCount += 2;

    // Awards
    const awardsCollectionRef = db.collection(getCollectionName('awards')).doc(`season_${SEASON_NUM}`).collection(getCollectionName(`S${SEASON_NUM}_awards`));
    const bestPlayerPerf = [...lineupsData, ...postLineupsData].sort((a, b) => (b.pct_above_median || 0) - (a.pct_above_median || 0))[0];
    if (bestPlayerPerf) {
        batch.set(awardsCollectionRef.doc('best_performance_player'), {
            award_name: "Best Performance (Player)", player_id: bestPlayerPerf.player_id, player_handle: bestPlayerPerf.player_handle,
            team_id: bestPlayerPerf.team_id, date: bestPlayerPerf.date, value: bestPlayerPerf.pct_above_median
        });
        writeCount++;
    }
    const allDailyScoresData = [...dailyScores, ...postDailyScores].map(s => s.data);
    const bestTeamPerf = allDailyScoresData.sort((a, b) => (b.pct_above_median || 0) - (a.pct_above_median || 0))[0];
    if (bestTeamPerf) {
        const teamName = teamsData.find(t => t.team_id === bestTeamPerf.team_id)?.team_name || 'Unknown';
        batch.set(awardsCollectionRef.doc('best_performance_team'), {
            award_name: "Best Performance (Team)", team_id: bestTeamPerf.team_id, team_name: teamName,
            date: bestTeamPerf.date, value: bestTeamPerf.pct_above_median
        });
        writeCount++;
    }
    await commitBatchIfNeeded();


    // Commit any remaining writes
    if (writeCount > 0) {
        console.log(`Committing final batch of ${writeCount} writes...`);
        await batch.commit();
    }

    console.log("✅ Database seeding and backfill complete!");
}

// --- Run the Seeding Script ---
seedDatabase().catch(console.error);
