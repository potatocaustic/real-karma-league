// /scripts/seed-firestore.js

const admin = require("firebase-admin");
const fetch = require("node-fetch");

// Initialize the Firebase Admin SDK.
admin.initializeApp({
    projectId: "real-karma-league",
});

const db = admin.firestore();

const SPREADSHEET_ID = "12EembQnztbdKx2-buv00--VDkEFSTuSXTRdOnTnRxq4";
const BASE_URL = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=`;

// --- Helper Functions ---
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
    if (lines.length < 2) return [];
    const headers = lines.shift().split(',').map(h => h.replace(/"/g, '').trim());
    return lines.map(line => {
        const values = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || [];
        const row = {};
        for (let i = 0; i < headers.length; i++) {
            if (headers[i]) {
                const value = (values[i] || '').replace(/"/g, '').trim();
                row[headers[i]] = value;
            }
        }
        return row;
    });
}

const parseNum = (val) => {
    const cleaned = String(val || '').replace(/,/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
};

const calculateMedian = (numbers) => {
    if (!numbers || numbers.length === 0) return 0;
    const sorted = [...numbers].sort((a, b) => a - b);
    const middleIndex = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ?
        (sorted[middleIndex - 1] + sorted[middleIndex]) / 2 :
        sorted[middleIndex];
};

const calculateGeometricMean = (numbers) => {
    if (!numbers || numbers.length === 0) return 0;
    const nonZero = numbers.filter(num => num > 0);
    if (nonZero.length === 0) return 0;
    const product = nonZero.reduce((prod, num) => prod * num, 1);
    return Math.pow(product, 1 / nonZero.length);
};


// --- Main Seeding Function ---
async function seedDatabase() {
    console.log("Starting database seed process...");
    const seasonId = "S7";
    const seasonNum = seasonId.replace('S', '');

    const [
        playersData,
        teamsData,
        scheduleData,
        draftPicksData,
        postScheduleData,
        lineupsData,
        postLineupsData
    ] = await Promise.all([
        fetchSheetData("Players"),
        fetchSheetData("Teams"),
        fetchSheetData("Schedule"),
        fetchSheetData("Draft_Capital"),
        fetchSheetData("Post_Schedule"),
        fetchSheetData("Lineups"),
        fetchSheetData("Post_Lineups")
    ]);

    // --- 1. Calculate and Write Daily Averages ---
    console.log("Calculating and writing daily player averages...");
    const dailyAveragesMap = new Map();
    const allLineups = [...lineupsData, ...postLineupsData];
    const allDates = [...new Set(allLineups.map(l => l.date))];
    const dailyAvgBatch = db.batch();

    for (const date of allDates) {
        const startedLineupsToday = allLineups.filter(l => l.date === date && l.started === 'TRUE');
        if (startedLineupsToday.length === 0) continue;

        const isPost = startedLineupsToday[0].game_type === 'postseason';
        const scores = startedLineupsToday.map(l => parseNum(l.points_adjusted));
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

    // --- 2. Calculate and Write Daily Team Scores ---
    console.log("Calculating and writing daily team scores...");
    const allGames = [...scheduleData.map(g => ({ ...g, isPost: false })), ...postScheduleData.map(g => ({ ...g, isPost: true }))]
        .filter(g => g.completed === 'TRUE');
    const gameDates = [...new Set(allGames.map(g => g.date))];
    const dailyScoresBatch = db.batch();
    const teamPamData = new Map(); // Store PAM data for later aggregation

    for (const date of gameDates) {
        const gamesToday = allGames.filter(g => g.date === date);
        const teamScoresToday = gamesToday.flatMap(g => [parseNum(g.team1_score), parseNum(g.team2_score)]);
        const teamMedian = calculateMedian(teamScoresToday);

        for (const game of gamesToday) {
            [{ id: game.team1_id, score: game.team1_score }, { id: game.team2_id, score: game.team2_score }].forEach(team => {
                const pam = team.score - teamMedian;
                const dailyScoreData = {
                    week: game.week,
                    team_id: team.id,
                    date: date,
                    score: team.score,
                    daily_median: teamMedian,
                    above_median: pam > 0 ? 1 : 0,
                    points_above_median: pam,
                    pct_above_median: teamMedian ? pam / teamMedian : 0
                };

                const scoresColl = game.isPost ? 'post_daily_scores' : 'daily_scores';
                const docRef = db.doc(`${scoresColl}/season_${seasonNum}/S${seasonNum}_${scoresColl}/${team.id}-${game.week}`);
                dailyScoresBatch.set(docRef, dailyScoreData, { merge: true });

                // Accumulate PAM for seasonal stats
                const pamKey = game.isPost ? 'post_pam' : 'pam';
                const currentPam = teamPamData.get(team.id) || {};
                currentPam[pamKey] = (currentPam[pamKey] || 0) + pam;
                teamPamData.set(team.id, currentPam);
            });
        }
    }
    await dailyScoresBatch.commit();
    console.log(`  -> Seeded daily score documents for ${gameDates.length} game days.`);

    // --- 3. Enhance Lineup Data with Advanced Stats ---
    console.log("Enhancing lineup data with single-game stats...");
    const enhanceLineup = (lineup) => {
        const dailyAvg = dailyAveragesMap.get(lineup.date);
        if (!dailyAvg || lineup.started !== 'TRUE') return lineup;
        const points = parseNum(lineup.points_adjusted);
        const aboveMean = points - dailyAvg.mean_score;
        const aboveMedian = points - dailyAvg.median_score;
        return {
            ...lineup,
            above_mean: aboveMean, AboveAvg: aboveMean > 0 ? 1 : 0,
            pct_above_mean: dailyAvg.mean_score ? aboveMean / dailyAvg.mean_score : 0,
            above_median: aboveMedian, AboveMed: aboveMedian > 0 ? 1 : 0,
            pct_above_median: dailyAvg.median_score ? aboveMedian / dailyAvg.median_score : 0,
            SingleGameWar: dailyAvg.win ? (points - dailyAvg.replacement_level) / dailyAvg.win : 0,
        };
    };
    const enhancedLineups = lineupsData.map(enhanceLineup);
    const enhancedPostLineups = postLineupsData.map(enhanceLineup);


    // --- 4. Aggregate Player & Team Seasonal Stats ---
    console.log("Aggregating seasonal stats for players and teams...");
    const playerStatsMap = new Map();
    playersData.forEach(p => playerStatsMap.set(p.player_id, {}));
    [...enhancedLineups, ...enhancedPostLineups].forEach(lineup => {
        if (lineup.started !== 'TRUE' || !playerStatsMap.has(lineup.player_id)) return;
        const pStats = playerStatsMap.get(lineup.player_id);
        const prefix = lineup.game_type === 'postseason' ? 'post_' : '';
        pStats[`${prefix}games_played`] = (pStats[`${prefix}games_played`] || 0) + 1;
        pStats[`${prefix}total_points`] = (pStats[`${prefix}total_points`] || 0) + parseNum(lineup.points_adjusted);
        pStats[`${prefix}WAR`] = (pStats[`${prefix}WAR`] || 0) + parseNum(lineup.SingleGameWar);
        pStats[`${prefix}aag_mean`] = (pStats[`${prefix}aag_mean`] || 0) + parseNum(lineup.AboveAvg);
        pStats[`${prefix}aag_median`] = (pStats[`${prefix}aag_median`] || 0) + parseNum(lineup.AboveMed);
        if (!pStats[`${prefix}ranks`]) pStats[`${prefix}ranks`] = [];
        if (parseNum(lineup.global_rank) > 0) pStats[`${prefix}ranks`].push(parseNum(lineup.global_rank));
        if (!pStats[`${prefix}dates`]) pStats[`${prefix}dates`] = new Set();
        pStats[`${prefix}dates`].add(lineup.date);
    });
    // Finalize player stats calculations
    playerStatsMap.forEach(stats => {
        ['', 'post_'].forEach(prefix => {
            if (!stats[`${prefix}games_played`]) return;
            let meansum = 0, medsum = 0;
            stats[`${prefix}dates`].forEach(date => {
                const dailyAvg = dailyAveragesMap.get(date);
                if (dailyAvg) {
                    meansum += dailyAvg.mean_score;
                    medsum += dailyAvg.median_score;
                }
            });
            stats[`${prefix}meansum`] = meansum;
            stats[`${prefix}medsum`] = medsum;
            stats[`${prefix}medrank`] = calculateMedian(stats[`${prefix}ranks`]);
            stats[`${prefix}GEM`] = calculateGeometricMean(stats[`${prefix}ranks`]);
            stats[`${prefix}rel_mean`] = meansum > 0 ? stats[`${prefix}total_points`] / meansum : 0;
            stats[`${prefix}rel_median`] = medsum > 0 ? stats[`${prefix}total_points`] / medsum : 0;
            delete stats[`${prefix}ranks`]; delete stats[`${prefix}dates`];
        });
    });

    // Aggregate team stats
    const teamStatsMap = new Map();
    teamsData.forEach(t => teamStatsMap.set(t.id, { wins: 0, losses: 0, post_wins: 0, post_losses: 0, conference: t.conference, ranks: [], post_ranks: [] }));
    allGames.forEach(game => {
        const winnerId = game.winner;
        const loserId = game.team1_id === winnerId ? game.team2_id : game.team1_id;
        const wKey = game.isPost ? 'post_wins' : 'wins';
        const lKey = game.isPost ? 'post_losses' : 'losses';
        if (teamStatsMap.has(winnerId)) teamStatsMap.get(winnerId)[wKey]++;
        if (teamStatsMap.has(loserId)) teamStatsMap.get(loserId)[lKey]++;
    });
    [...enhancedLineups, ...enhancedPostLineups].forEach(lineup => {
        if (lineup.started !== 'TRUE' || !teamStatsMap.has(lineup.team_id)) return;
        const rankKey = lineup.game_type === 'postseason' ? 'post_ranks' : 'ranks';
        teamStatsMap.get(lineup.team_id)[rankKey].push(parseNum(lineup.global_rank));
    });

    let calculatedTeamStats = [];
    teamStatsMap.forEach((stats, teamId) => {
        const pamInfo = teamPamData.get(teamId) || {};
        const wpct = (stats.wins + stats.losses) > 0 ? stats.wins / (stats.wins + stats.losses) : 0;
        calculatedTeamStats.push({
            ...stats, teamId, pam: pamInfo.pam || 0, post_pam: pamInfo.post_pam || 0,
            wpct, med_starter_rank: calculateMedian(stats.ranks), post_med_starter_rank: calculateMedian(stats.post_ranks),
            MaxPotWins: 15 - stats.losses, sortscore: wpct + ((pamInfo.pam || 0) * 0.00000001),
        });
    });

    // Finalize team rankings
    const ranker = (teams, key, asc, rankKey) => teams.sort((a, b) => asc ? a[key] - b[key] : b[key] - a[key]).forEach((t, i) => t[rankKey] = i + 1);
    ranker(calculatedTeamStats, 'med_starter_rank', true, 'msr_rank');
    ranker(calculatedTeamStats, 'pam', false, 'pam_rank');
    ranker(calculatedTeamStats, 'post_med_starter_rank', true, 'post_msr_rank');
    ranker(calculatedTeamStats, 'post_pam', false, 'post_pam_rank');
    ['Eastern', 'Western'].forEach(conf => {
        const confTeams = calculatedTeamStats.filter(t => t.conference === conf);
        ranker(confTeams, 'sortscore', false, 'postseed');
    });

    // --- 5. Batch Write Core and Aggregated Data to Firestore ---
    console.log("Preparing final batch writes to Firestore...");
    const finalBatch = db.batch();

    // Games
    const gameIdLookup = new Map();
    allGames.forEach(game => {
        const gameId = `${game.date}-${game.team1_id}-${game.team2_id}`.replace(/\//g, "-");
        const ref = db.collection("seasons").doc(seasonId).collection(game.isPost ? 'post_games' : 'games').doc(gameId);
        finalBatch.set(ref, game);
        gameIdLookup.set(`${game.date}-${game.team1_id}`, gameId);
        gameIdLookup.set(`${game.date}-${game.team2_id}`, gameId);
    });

    // Lineups
    [...enhancedLineups, ...enhancedPostLineups].forEach(lineup => {
        const gameId = gameIdLookup.get(`${lineup.date}-${lineup.team_id}`);
        if (!gameId || !lineup.player_id) return;
        const ref = db.collection("seasons").doc(seasonId).collection(lineup.game_type === 'postseason' ? 'post_lineups' : 'lineups').doc(`${gameId}-${lineup.player_id}`);
        finalBatch.set(ref, { ...lineup, game_id: gameId });
    });

    // Teams & Seasonal Records
    const finalTeamStatsMap = new Map(calculatedTeamStats.map(t => [t.teamId, t]));
    teamsData.forEach(team => {
        const teamDocRef = db.collection("v2_teams").doc(team.team_id);
        finalBatch.set(teamDocRef, { team_name: team.team_name, conference: team.conference, current_gm_handle: team.current_gm_handle, gm_uid: team.gm_uid });
        const seasonalData = finalTeamStatsMap.get(team.team_id) || {};
        const seasonRecordRef = teamDocRef.collection("seasonal_records").doc(seasonId);
        finalBatch.set(seasonRecordRef, {
            wins: seasonalData.wins || 0, losses: seasonalData.losses || 0, wpct: seasonalData.wpct || 0,
            pam: seasonalData.pam || 0, med_starter_rank: seasonalData.med_starter_rank || 0, msr_rank: seasonalData.msr_rank || 0,
            pam_rank: seasonalData.pam_rank || 0, sortscore: seasonalData.sortscore || 0, MaxPotWins: seasonalData.MaxPotWins || 0,
            postseed: seasonalData.postseed || 0, post_wins: seasonalData.post_wins || 0, post_losses: seasonalData.post_losses || 0,
            post_pam: seasonalData.post_pam || 0, post_med_starter_rank: seasonalData.post_med_starter_rank || 0,
            post_msr_rank: seasonalData.post_msr_rank || 0, post_pam_rank: seasonalData.post_pam_rank || 0,
        });
    });

    // Players & Seasonal Stats
    playersData.forEach(player => {
        const playerDocRef = db.collection("v2_players").doc(player.player_id);
        finalBatch.set(playerDocRef, { player_handle: player.player_handle, player_status: player.player_status, rookie: player.rookie, all_star: player.all_star, current_team_id: player.current_team_id });
        const seasonalData = playerStatsMap.get(player.player_id) || {};
        const seasonStatsRef = playerDocRef.collection("seasonal_stats").doc(seasonId);
        finalBatch.set(seasonStatsRef, seasonalData, { merge: true });
    });

    // Draft Picks
    draftPicksData.forEach(pick => { if (pick.pick_id) finalBatch.set(db.collection("draftPicks").doc(pick.pick_id), pick) });

    await finalBatch.commit();
    console.log("✅ Database seeding and backfilling complete!");
}

seedDatabase().catch(console.error);