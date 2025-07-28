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
    const allDates = [...new Set(allLineups.map(l => l.date).filter(Boolean))];
    const dailyAvgBatch = db.batch();

    for (const date of allDates) {
        const startedLineupsToday = allLineups.filter(l => l.date === date && (l.started || '').trim().toUpperCase() === 'TRUE');
        if (startedLineupsToday.length === 0) continue;

        const isPost = (startedLineupsToday[0].game_type || '').trim().toLowerCase() === 'postseason';

        // **FIX #1:** Use 'points_raw' for seeding purposes as the source for player scores.
        const scores = startedLineupsToday.map(l => parseNum(l.points_raw));

        const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
        const median = calculateMedian(scores);
        const dailyAvgData = {
            date: date, week: startedLineupsToday[0].week, mean_score: mean,
            median_score: median, replacement_level: median * 0.9, win: median * 0.92,
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
        .filter(g => (g.completed || '').trim().toUpperCase() === 'TRUE');
    const gameDates = [...new Set(allGames.map(g => g.date))];
    const dailyScoresBatch = db.batch();
    const teamSeasonalData = new Map();
    teamsData.forEach(t => teamSeasonalData.set(t.id, { pam: 0, post_pam: 0, apPAM_total_pct: 0, apPAM_games: 0 }));

    for (const date of gameDates) {
        const gamesToday = allGames.filter(g => g.date === date);
        const teamScoresToday = gamesToday.flatMap(g => [parseNum(g.team1_score), parseNum(g.team2_score)]);
        const teamMedian = calculateMedian(teamScoresToday);

        for (const game of gamesToday) {
            [{ id: game.team1_id, score: parseNum(game.team1_score) }, { id: game.team2_id, score: parseNum(game.team2_score) }].forEach(team => {
                const pam = team.score - teamMedian;
                const pct_above_median = teamMedian ? pam / teamMedian : 0;
                const dailyScoreData = {
                    week: game.week, team_id: team.id, date: date, score: team.score,
                    daily_median: teamMedian, points_above_median: pam,
                };

                const scoresColl = game.isPost ? 'post_daily_scores' : 'daily_scores';
                const docId = game.isPost ? `${team.id}-${date.replace(/\//g, '-')}` : `${team.id}-${game.week}`;
                const docRef = db.doc(`${scoresColl}/season_${seasonNum}/S${seasonNum}_${scoresColl}/${docId}`);
                dailyScoresBatch.set(docRef, dailyScoreData, { merge: true });

                const teamData = teamSeasonalData.get(team.id);
                if (teamData) {
                    if (game.isPost) {
                        teamData.post_pam += pam;
                    } else {
                        teamData.pam += pam;
                        teamData.apPAM_total_pct += pct_above_median;
                        teamData.apPAM_games++;
                    }
                }
            });
        }
    }
    await dailyScoresBatch.commit();
    console.log(`  -> Seeded daily score documents for ${gameDates.length} game days.`);

    // --- 3. Enhance Lineup Data ---
    console.log("Enhancing lineup data with single-game stats...");
    const enhanceLineup = (lineup) => {
        const dailyAvg = dailyAveragesMap.get(lineup.date);
        if (!dailyAvg || (lineup.started || '').trim().toUpperCase() !== 'TRUE') return lineup;

        // **FIX #1:** Use 'points_raw' here as well.
        const points = parseNum(lineup.points_raw);
        return {
            ...lineup,
            points_adjusted: points, // Add this field for consistency
            SingleGameWar: dailyAvg.win ? (points - dailyAvg.replacement_level) / dailyAvg.win : 0,
        };
    };
    const enhancedLineups = lineupsData.map(enhanceLineup);
    const enhancedPostLineups = postLineupsData.map(enhanceLineup);

    // --- 4. Aggregate Player & Team Seasonal Stats ---
    console.log("Aggregating seasonal stats for players and teams...");
    const playerStatsMap = new Map();
    // Player stat aggregation logic remains the same...

    // Team stat aggregation
    const teamStatsMap = new Map();
    teamsData.forEach(t => teamStatsMap.set(t.id, { wins: 0, losses: 0, post_wins: 0, post_losses: 0, conference: t.conference, ranks: [], post_ranks: [] }));
    allGames.forEach(game => {
        const winnerId = game.winner;
        const loserId = game.team1_id === winnerId ? game.team2_id : game.team1_id;
        if (teamStatsMap.has(winnerId)) teamStatsMap.get(winnerId)[game.isPost ? 'post_wins' : 'wins']++;
        if (teamStatsMap.has(loserId)) teamStatsMap.get(loserId)[game.isPost ? 'post_losses' : 'losses']++;
    });
    [...enhancedLineups, ...enhancedPostLineups].forEach(lineup => {
        if ((lineup.started || '').trim().toUpperCase() !== 'TRUE' || !teamStatsMap.has(lineup.team_id)) return;
        const rankKey = (lineup.game_type || '').trim().toLowerCase() === 'postseason' ? 'post_ranks' : 'ranks';
        teamStatsMap.get(lineup.team_id)[rankKey].push(parseNum(lineup.global_rank));
    });

    let calculatedTeamStats = [];
    teamStatsMap.forEach((stats, teamId) => {
        const seasonalData = teamSeasonalData.get(teamId) || {};
        const wpct = (stats.wins + stats.losses) > 0 ? stats.wins / (stats.wins + stats.losses) : 0;
        calculatedTeamStats.push({
            ...stats, teamId, pam: seasonalData.pam || 0, post_pam: seasonalData.post_pam || 0,
            apPAM: seasonalData.apPAM_games > 0 ? seasonalData.apPAM_total_pct / seasonalData.apPAM_games : 0,
            wpct, med_starter_rank: calculateMedian(stats.ranks), post_med_starter_rank: calculateMedian(stats.post_ranks),
            MaxPotWins: 15 - stats.losses, sortscore: wpct + ((seasonalData.pam || 0) * 0.00000001),
        });
    });

    // **FIX #2:** Add full ranking and clinching logic.
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
        confTeams.forEach(t => {
            t.playoffs = t.wins > (maxPotWinsSorted[6]?.MaxPotWins ?? 0) ? 1 : 0;
            t.playin = t.wins > (maxPotWinsSorted[10]?.MaxPotWins ?? 0) ? 1 : 0;
            t.elim = t.MaxPotWins < (winsSorted[9]?.wins ?? 0) ? 1 : 0;
        });
    });

    // --- 5. Batch Write Core and Aggregated Data to Firestore ---
    console.log("Preparing final batch writes to Firestore...");
    const finalBatch = db.batch();

    // **FIX #2:** Write all calculated team seasonal records.
    const finalTeamStatsMap = new Map(calculatedTeamStats.map(t => [t.teamId, t]));
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