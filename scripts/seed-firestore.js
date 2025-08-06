// /scripts/seed-firestore.js

const admin = require("firebase-admin");
const fetch = require("node-fetch");

// Initialize the Firebase Admin SDK.
admin.initializeApp({
    projectId: "real-karma-league",
});

const db = admin.firestore();

const SPREADSHEET_ID = "1D1YUw9931ikPLihip3tn7ynkoJGFUHxtogfrq_Hz3P0";
const BASE_URL = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=`;
const SEASON_ID = "S7";
const SEASON_NUM = "7";

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
        draftPicksData
    ] = await Promise.all([
        fetchSheetData("Players"),
        fetchSheetData("Teams"),
        fetchSheetData("Schedule").then(data => data.filter(g => g.completed === 'TRUE')),
        fetchSheetData("Post_Schedule").then(data => data.filter(g => g.completed === 'TRUE')),
        fetchSheetData("Lineups"),
        fetchSheetData("Post_Lineups"),
        fetchSheetData("Draft_Capital")
    ]);
    console.log("All raw data fetched.");

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
    processTeamScores(scheduleData, dailyScores);
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

        for (const [teamId, stats] of teamSeasonalStats.entries()) {
            stats[statKey('med_starter_rank')] = calculateMedian(stats[statKey('ranks')] || []);
            delete stats[statKey('ranks')];
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
    aggregateTeamStats(scheduleData, dailyScores, lineupsData, false);
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

    // --- 4. SEED DATABASE ---

    // NEW: Batching helper function
    const BATCH_SIZE = 400; // Keep well under the 500 limit
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

    // Seed Teams and Seasonal Records
    for (const team of teamsData) {
        const teamDocRef = db.collection("v2_teams_dev").doc(team.team_id);
        const staticData = {
            team_id: team.team_id,
            conference: team.conference,
            current_gm_handle: team.current_gm_handle,
            gm_uid: team.gm_uid
        };
        batch.set(teamDocRef, staticData);
        writeCount++;

        const seasonalData = teamSeasonalStats.get(team.team_id) || {};
        seasonalData.team_name = team.team_name;
        delete seasonalData.teamId;

        const seasonRecordRef = teamDocRef.collection("seasonal_records_dev").doc(SEASON_ID);
        batch.set(seasonRecordRef, seasonalData, { merge: true });
        writeCount++;
        await commitBatchIfNeeded();
    }
    console.log(`Prepared ${teamsData.length} teams and their seasonal stats for seeding.`);

    // Seed Players and Seasonal Stats
    for (const player of playersData) {
        const playerDocRef = db.collection("v2_players_dev").doc(player.player_id);
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

            const seasonStatsRef = playerDocRef.collection("seasonal_stats_dev").doc(SEASON_ID);
            batch.set(seasonStatsRef, seasonalData);
            writeCount++;
        }
        await commitBatchIfNeeded();
    }
    console.log(`Prepared ${playersData.length} players and their seasonal stats for seeding.`);

    const seasonRef = db.collection("seasons_dev").doc(SEASON_ID);
    batch.set(seasonRef, { season_name: `Season ${SEASON_NUM}`, status: "active" });
    writeCount++;
    console.log(`Prepared parent document for season ${SEASON_ID}.`);

    // Seed Games
    for (const game of [...scheduleData, ...postScheduleData]) {
        const gameId = `${game.date}-${game.team1_id}-${game.team2_id}`.replace(/\//g, "-");
        const collectionName = scheduleData.includes(game) ? "games_dev" : "post_games_dev";
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
        const collectionName = lineupsData.includes(lineup) ? "lineups_dev" : "post_lineups_dev";
        lineup.game_id = gameId;

        batch.set(seasonRef.collection(collectionName).doc(lineupId), lineup);
        writeCount++;
        await commitBatchIfNeeded();
    }
    console.log(`Prepared ${lineupsData.length + postLineupsData.length} enhanced lineups with corrected IDs for seeding.`);

    // Seed Draft Picks
    for (const pick of draftPicksData) {
        if (pick.pick_id) {
            batch.set(db.collection("draftPicks_dev").doc(pick.pick_id), pick);
            writeCount++;
            await commitBatchIfNeeded();
        }
    }
    console.log(`Prepared ${draftPicksData.length} draft picks for seeding.`);

    // Seed Intermediate Collections
    const seedIntermediate = async (map, collName) => {
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
            const docRef = db.doc(`${collName}_dev/season_${SEASON_NUM}/S${SEASON_NUM}_${collName}_dev/${yyyymmdd}`);
            batch.set(docRef, data);
            writeCount++;
            await commitBatchIfNeeded();
        }
    };
    await seedIntermediate(dailyAveragesMap, 'daily_averages');
    await seedIntermediate(postDailyAveragesMap, 'post_daily_averages');
    console.log(`Prepared ${dailyAveragesMap.size + postDailyAveragesMap.size} daily average documents.`);

    for (const s of dailyScores) {
        batch.set(db.doc(`daily_scores_dev/season_${SEASON_NUM}/S${SEASON_NUM}_daily_scores_dev/${s.docId}`), s.data);
        writeCount++;
        await commitBatchIfNeeded();
    }
    for (const s of postDailyScores) {
        batch.set(db.doc(`post_daily_scores_dev/season_${SEASON_NUM}/S${SEASON_NUM}_post_daily_scores_dev/${s.docId}`), s.data);
        writeCount++;
        await commitBatchIfNeeded();
    }
    console.log(`Prepared ${dailyScores.length + postDailyScores.length} daily team score documents.`);

    // Commit any remaining writes
    if (writeCount > 0) {
        console.log(`Committing final batch of ${writeCount} writes...`);
        await batch.commit();
    }

    console.log("✅ Database seeding and backfill complete!");
}

// --- Run the Seeding Script ---
seedDatabase().catch(console.error);