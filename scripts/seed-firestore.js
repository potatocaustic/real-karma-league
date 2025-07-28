// /scripts/seed-firestore.js

const admin = require("firebase-admin");
const fetch = require("node-fetch");

// Initialize the Firebase Admin SDK.
// Ensure your environment is authenticated (e.g., using GOOGLE_APPLICATION_CREDENTIALS)
admin.initializeApp({
    projectId: "real-karma-league",
});

const db = admin.firestore();

const SPREADSHEET_ID = "12EembQnztbdKx2-buv00--VDkEFSTuSXTRdOnTnRxq4";
const BASE_URL = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=`;

// --- Helper Functions ---

/**
 * Fetches data from a specified Google Sheet tab.
 * @param {string} sheetName The name of the sheet tab.
 * @returns {Promise<Array<Object>>} A promise that resolves to an array of objects representing the rows.
 */
async function fetchSheetData(sheetName) {
    try {
        console.log(`Fetching sheet: ${sheetName}...`);
        const response = await fetch(BASE_URL + encodeURIComponent(sheetName));
        if (!response.ok) throw new Error(`Failed to fetch sheet: ${sheetName} - ${response.statusText}`);
        const csvText = await response.text();
        return parseCSV(csvText);
    } catch (error) {
        console.error(`Error fetching sheet ${sheetName}:`, error);
        return [];
    }
}

/**
 * Parses a CSV string into an array of objects.
 * @param {string} csvText The raw CSV text.
 * @returns {Array<Object>} An array of objects.
 */
function parseCSV(csvText) {
    const lines = csvText.trim().split('\n').filter(line => line.trim() !== '');
    if (lines.length < 2) return [];
    const headers = lines.shift().split(',').map(h => h.replace(/"/g, '').trim());
    return lines.map(line => {
        const values = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || [];
        const row = {};
        headers.forEach((header, i) => {
            if (header) {
                const value = (values[i] || '').replace(/"/g, '').trim();
                row[header] = value;
            }
        });
        return row;
    });
}

/**
 * Safely parses a value into a number, returning 0 if invalid.
 * @param {*} val The value to parse.
 * @returns {number} The parsed number or 0.
 */
const parseNum = (val) => {
    if (val === null || typeof val === 'undefined') return 0;
    const cleaned = String(val).replace(/,/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
};

/**
 * Calculates the median of an array of numbers.
 * @param {Array<number>} numbers The array of numbers.
 * @returns {number} The median value.
 */
const calculateMedian = (numbers) => {
    if (!numbers || numbers.length === 0) return 0;
    const sorted = [...numbers].sort((a, b) => a - b);
    const middleIndex = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ?
        (sorted[middleIndex - 1] + sorted[middleIndex]) / 2 :
        sorted[middleIndex];
};

/**
 * Calculates the geometric mean of an array of numbers.
 * @param {Array<number>} numbers The array of numbers.
 * @returns {number} The geometric mean.
 */
const calculateGeometricMean = (numbers) => {
    if (!numbers || numbers.length === 0) return 0;
    const nonZero = numbers.filter(num => num > 0);
    if (nonZero.length === 0) return 0;
    const product = nonZero.reduce((prod, num) => prod * num, 1);
    return Math.pow(product, 1 / nonZero.length);
};

// --- Main Seeding Function ---

async function seedDatabase() {
    console.log("Starting database seed process for S7...");
    const seasonId = "S7";
    const seasonNum = seasonId.replace('S', '');

    // --- Step 1: Fetch All Required Data from Google Sheets ---
    const [
        playersData,
        teamsData,
        scheduleData,
        postScheduleData,
        lineupsData,
        postLineupsData,
        draftPicksData,
    ] = await Promise.all([
        fetchSheetData("Players"),
        fetchSheetData("Teams"),
        fetchSheetData("Schedule"),
        fetchSheetData("Post_Schedule"),
        fetchSheetData("Lineups"),
        fetchSheetData("Post_Lineups"),
        fetchSheetData("Draft_Capital"),
    ]);

    console.log(`Fetched ${playersData.length} players, ${teamsData.length} teams, ${lineupsData.length + postLineupsData.length} total lineup entries.`);

    // --- Step 2: Calculate and Write Daily Player Averages ---
    console.log("Calculating and writing daily player averages...");
    const dailyAveragesMap = new Map();
    const allLineupsForAverages = [...lineupsData, ...postLineupsData];
    const allDates = [...new Set(allLineupsForAverages.map(l => l.date).filter(Boolean))];
    const dailyAvgBatch = db.batch();

    for (const date of allDates) {
        const startedLineupsToday = allLineupsForAverages.filter(l => l.date === date && (l.started || '').trim().toUpperCase() === 'TRUE');
        if (startedLineupsToday.length === 0) continue;

        const isPost = (startedLineupsToday[0].game_type || '').trim().toLowerCase() === 'postseason';
        const scores = startedLineupsToday.map(l => parseNum(l.points_raw)); // Use points_raw for seeder
        const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
        const median = calculateMedian(scores);

        const dailyAvgData = {
            date: date,
            week: startedLineupsToday[0].week,
            mean_score: mean,
            median_score: median,
            replacement_level: median * 0.9,
            win: median * 0.92,
        };
        dailyAveragesMap.set(date, dailyAvgData);

        const averagesColl = isPost ? 'post_daily_averages' : 'daily_averages';
        const [month, day, year] = date.split('/');
        const yyyymmdd = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        const docRef = db.doc(`${averagesColl}/season_${seasonNum}/S${seasonNum}_${averagesColl}/${yyyymmdd}`);
        dailyAvgBatch.set(docRef, dailyAvgData);
    }
    await dailyAvgBatch.commit();
    console.log(`  -> Seeded ${dailyAveragesMap.size} daily average documents.`);

    // --- Step 3: Calculate and Write Daily Team Scores ---
    console.log("Calculating and writing daily team scores...");
    const allGames = [...scheduleData.map(g => ({ ...g, isPost: false })), ...postScheduleData.map(g => ({ ...g, isPost: true }))]
        .filter(g => (g.completed || '').trim().toUpperCase() === 'TRUE');
    const gameDates = [...new Set(allGames.map(g => g.date))];
    const dailyScoresBatch = db.batch();

    for (const date of gameDates) {
        const gamesToday = allGames.filter(g => g.date === date);
        const teamScoresToday = gamesToday.flatMap(g => [parseNum(g.team1_score), parseNum(g.team2_score)]);
        const teamMedian = calculateMedian(teamScoresToday);

        for (const game of gamesToday) {
            [{ id: game.team1_id, score: parseNum(g.team1_score) }, { id: game.team2_id, score: parseNum(g.team2_score) }].forEach(team => {
                const pam = team.score - teamMedian;
                const dailyScoreData = {
                    week: game.week,
                    team_id: team.id,
                    date: date,
                    score: team.score,
                    daily_median: teamMedian,
                    points_above_median: pam,
                    pct_above_median: teamMedian ? pam / teamMedian : 0,
                };

                const scoresColl = game.isPost ? 'post_daily_scores' : 'daily_scores';
                // CRITICAL: Use a date-based ID for postseason to ensure uniqueness per game.
                const docId = game.isPost ? `${team.id}-${date.replace(/\//g, '-')}` : `${team.id}-${game.week}`;
                const docRef = db.doc(`${scoresColl}/season_${seasonNum}/S${seasonNum}_${scoresColl}/${docId}`);
                dailyScoresBatch.set(docRef, dailyScoreData, { merge: true });
            });
        }
    }
    await dailyScoresBatch.commit();
    console.log(`  -> Seeded daily score documents for ${gameDates.length} game days.`);

    // --- Step 4: Enhance Lineup Data with Calculated Single-Game Stats ---
    console.log("Enhancing lineup data with single-game stats...");
    const enhanceLineup = (lineup) => {
        const dailyAvg = dailyAveragesMap.get(lineup.date);
        if (!dailyAvg || (lineup.started || '').trim().toUpperCase() !== 'TRUE') return lineup;

        const points = parseNum(lineup.points_raw);
        return {
            ...lineup,
            points_adjusted: points, // Add this field for consistency. For seeder, it's same as raw.
            SingleGameWar: dailyAvg.win ? (points - dailyAvg.replacement_level) / dailyAvg.win : 0,
        };
    };
    const enhancedLineups = lineupsData.map(enhanceLineup);
    const enhancedPostLineups = postLineupsData.map(enhanceLineup);

    // --- Step 5: Aggregate Player & Team Seasonal Stats ---
    console.log("Aggregating seasonal stats for players and teams...");

    // Player Stats Aggregation
    const playerStatsMap = new Map();
    playersData.forEach(p => playerStatsMap.set(p.player_id, {}));
    [...enhancedLineups, ...enhancedPostLineups].forEach(lineup => {
        if ((lineup.started || '').trim().toUpperCase() !== 'TRUE' || !playerStatsMap.has(lineup.player_id)) return;
        const pStats = playerStatsMap.get(lineup.player_id);
        const prefix = (lineup.game_type || '').trim().toLowerCase() === 'postseason' ? 'post_' : '';

        pStats[`${prefix}games_played`] = (pStats[`${prefix}games_played`] || 0) + 1;
        pStats[`${prefix}total_points`] = (pStats[`${prefix}total_points`] || 0) + parseNum(lineup.points_adjusted);
        pStats[`${prefix}WAR`] = (pStats[`${prefix}WAR`] || 0) + parseNum(lineup.SingleGameWar);

        if (!pStats[`${prefix}ranks`]) pStats[`${prefix}ranks`] = [];
        if (parseNum(lineup.global_rank) > 0) pStats[`${prefix}ranks`].push(parseNum(lineup.global_rank));
    });
    playerStatsMap.forEach(stats => {
        ['', 'post_'].forEach(prefix => {
            if (!stats[`${prefix}games_played`]) return;
            stats[`${prefix}medrank`] = calculateMedian(stats[`${prefix}ranks`]);
            stats[`${prefix}GEM`] = calculateGeometricMean(stats[`${prefix}ranks`]);
            delete stats[`${prefix}ranks`]; // Clean up temp array
        });
    });

    // Team Stats Aggregation
    const teamAggregates = new Map();
    teamsData.forEach(t => teamAggregates.set(t.team_id, {
        wins: 0, losses: 0, post_wins: 0, post_losses: 0,
        pam: 0, post_pam: 0, apPAM_total_pct: 0, apPAM_games: 0,
        conference: t.conference, ranks: [], post_ranks: []
    }));

    allGames.forEach(game => {
        const winnerId = game.winner;
        const loserId = game.team1_id === winnerId ? game.team2_id : game.team1_id;
        const winnerAgg = teamAggregates.get(winnerId);
        const loserAgg = teamAggregates.get(loserId);
        if (winnerAgg) winnerAgg[game.isPost ? 'post_wins' : 'wins']++;
        if (loserAgg) loserAgg[game.isPost ? 'post_losses' : 'losses']++;
    });

    const allDailyScores = await db.collectionGroup('daily_scores').get();
    allDailyScores.docs.forEach(doc => {
        const data = doc.data();
        const teamAgg = teamAggregates.get(data.team_id);
        if (teamAgg) {
            teamAgg.pam += data.points_above_median || 0;
            teamAgg.apPAM_total_pct += data.pct_above_median || 0;
            teamAgg.apPAM_games++;
        }
    });

    const allPostDailyScores = await db.collectionGroup('post_daily_scores').get();
    allPostDailyScores.docs.forEach(doc => {
        const data = doc.data();
        const teamAgg = teamAggregates.get(data.team_id);
        if (teamAgg) {
            teamAgg.post_pam += data.points_above_median || 0;
        }
    });

    [...enhancedLineups, ...enhancedPostLineups].forEach(lineup => {
        if ((lineup.started || '').trim().toUpperCase() !== 'TRUE' || !teamAggregates.has(lineup.team_id)) return;
        const isPost = (lineup.game_type || '').trim().toLowerCase() === 'postseason';
        const rankKey = isPost ? 'post_ranks' : 'ranks';
        if (parseNum(lineup.global_rank) > 0) {
            teamAggregates.get(lineup.team_id)[rankKey].push(parseNum(lineup.global_rank));
        }
    });

    // --- Step 6: Final Calculations (Ranks, Clinching) ---
    let calculatedTeamStats = [];
    teamAggregates.forEach((stats, teamId) => {
        const wpct = (stats.wins + stats.losses) > 0 ? stats.wins / (stats.wins + stats.losses) : 0;
        calculatedTeamStats.push({
            ...stats, teamId,
            apPAM: stats.apPAM_games > 0 ? stats.apPAM_total_pct / stats.apPAM_games : 0,
            wpct,
            med_starter_rank: calculateMedian(stats.ranks),
            post_med_starter_rank: calculateMedian(stats.post_ranks),
            MaxPotWins: 15 - stats.losses,
            sortscore: wpct + (stats.pam * 0.00000001),
        });
    });

    const ranker = (teams, key, asc, rankKey) => teams.sort((a, b) => asc ? a[key] - b[key] : b[key] - a[key]).forEach((t, i) => t[rankKey] = i + 1);
    ranker(calculatedTeamStats, 'med_starter_rank', true, 'msr_rank');
    ranker(calculatedTeamStats, 'pam', false, 'pam_rank');
    ranker(calculatedTeamStats, 'post_med_starter_rank', true, 'post_msr_rank');
    ranker(calculatedTeamStats, 'post_pam', false, 'post_pam_rank');

    ['Eastern', 'Western'].forEach(conf => {
        const confTeams = calculatedTeamStats.filter(t => t.conference === conf);
        if (confTeams.length === 0) return;
        ranker(confTeams, 'sortscore', false, 'postseed');
        const maxPotWinsSorted = [...confTeams].sort((a, b) => b.MaxPotWins - a.MaxPotWins);
        const winsSorted = [...confTeams].sort((a, b) => b.wins - a.wins);
        const playoffWinsThreshold = maxPotWinsSorted[6]?.MaxPotWins ?? 0;
        const playinWinsThreshold = maxPotWinsSorted[10]?.MaxPotWins ?? 0;
        const elimWinsThreshold = winsSorted[9]?.wins ?? 0;
        confTeams.forEach(t => {
            t.playoffs = t.wins > playoffWinsThreshold ? 1 : 0;
            t.playin = t.wins > playinWinsThreshold ? 1 : 0;
            t.elim = t.MaxPotWins < elimWinsThreshold ? 1 : 0;
        });
    });

    // --- Step 7: Batch Write All Data to Firestore ---
    console.log("Preparing final batch writes to Firestore...");
    const finalBatch = db.batch();
    const finalTeamStatsMap = new Map(calculatedTeamStats.map(t => [t.teamId, t]));

    // Write Teams & Seasonal Records
    teamsData.forEach(team => {
        const teamDocRef = db.collection("v2_teams").doc(team.team_id);
        finalBatch.set(teamDocRef, { team_name: team.team_name, conference: team.conference, current_gm_handle: team.current_gm_handle, gm_uid: team.gm_uid });
        const seasonalData = finalTeamStatsMap.get(team.team_id) || {};
        const seasonRecordRef = teamDocRef.collection("seasonal_records").doc(seasonId);
        finalBatch.set(seasonRecordRef, {
            wins: seasonalData.wins || 0, losses: seasonalData.losses || 0, wpct: seasonalData.wpct || 0,
            pam: seasonalData.pam || 0, apPAM: seasonalData.apPAM || 0, med_starter_rank: seasonalData.med_starter_rank || 0,
            msr_rank: seasonalData.msr_rank || 0, pam_rank: seasonalData.pam_rank || 0,
            sortscore: seasonalData.sortscore || 0, MaxPotWins: seasonalData.MaxPotWins || 0,
            postseed: seasonalData.postseed || 0, playin: seasonalData.playin || 0,
            playoffs: seasonalData.playoffs || 0, elim: seasonalData.elim || 0,
            post_wins: seasonalData.post_wins || 0, post_losses: seasonalData.post_losses || 0,
            post_pam: seasonalData.post_pam || 0, post_med_starter_rank: seasonalData.post_med_starter_rank || 0,
            post_msr_rank: seasonalData.post_msr_rank || 0, post_pam_rank: seasonalData.post_pam_rank || 0,
        });
    });

    // Write Players & Seasonal Stats
    playersData.forEach(player => {
        const playerDocRef = db.collection("v2_players").doc(player.player_id);
        finalBatch.set(playerDocRef, { player_handle: player.player_handle, player_status: player.player_status, rookie: player.rookie, all_star: player.all_star, current_team_id: player.current_team_id });
        const seasonalData = playerStatsMap.get(player.player_id) || {};
        const seasonStatsRef = playerDocRef.collection("seasonal_stats").doc(seasonId);
        finalBatch.set(seasonStatsRef, seasonalData, { merge: true });
    });

    // Write Games, Lineups, and Draft Picks
    const gameIdLookup = new Map();
    allGames.forEach(game => {
        const gameId = `${game.date}-${game.team1_id}-${game.team2_id}`.replace(/\//g, "-");
        const ref = db.collection("seasons").doc(seasonId).collection(game.isPost ? 'post_games' : 'games').doc(gameId);
        finalBatch.set(ref, { ...game, completed: String(game.completed).toUpperCase() });
        gameIdLookup.set(`${game.date}-${game.team1_id}`, gameId);
        gameIdLookup.set(`${game.date}-${game.team2_id}`, gameId);
    });

    [...enhancedLineups, ...enhancedPostLineups].forEach(lineup => {
        const gameId = gameIdLookup.get(`${lineup.date}-${lineup.team_id}`);
        if (!gameId || !lineup.player_id) return;
        const isPost = (lineup.game_type || '').trim().toLowerCase() === 'postseason';
        const docId = `${gameId}-${lineup.player_id}`;
        const ref = db.collection("seasons").doc(seasonId).collection(isPost ? 'post_lineups' : 'lineups').doc(docId);
        finalBatch.set(ref, { ...lineup, game_id: gameId, started: String(lineup.started).toUpperCase() });
    });

    draftPicksData.forEach(pick => { if (pick.pick_id) finalBatch.set(db.collection("draftPicks").doc(pick.pick_id), pick) });

    await finalBatch.commit();
    console.log("✅ Database seeding and backfilling complete!");
}

seedDatabase().catch(err => {
    console.error("A fatal error occurred during the seed process:", err);
    process.exit(1);
});
