// /scripts/simulate-postseason.js

const admin = require("firebase-admin");
const readline = require('readline');

// Initialize Firebase Admin SDK
admin.initializeApp({
    projectId: "real-karma-league",
});
const db = admin.firestore();

// --- CONFIGURATION ---
const SEASON_ID = "S8";
const USE_DEV_COLLECTIONS = true;
const SEASON_NUM = SEASON_ID.replace('S', '');

// --- HELPER FUNCTIONS ---
const getCollectionName = (baseName) => USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
const calculateMedian = (numbers) => {
    if (numbers.length === 0) return 0;
    const sorted = [...numbers].sort((a, b) => a - b);
    const middleIndex = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middleIndex - 1] + sorted[middleIndex]) / 2 : sorted[middleIndex];
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const askQuestion = (query) => new Promise(resolve => rl.question(query, ans => resolve(ans)));

/**
 * Core logic for advancing teams in the playoff bracket.
 */
async function advanceBracket(gamesToProcess, postGamesRef, batch) {
    const advancementRules = {
        "W7vW8": { winnerTo: "W2vW7", winnerField: "team2_id", loserTo: "W8thSeedGame", loserField: "team1_id" },
        "E7vE8": { winnerTo: "E2vE7", winnerField: "team2_id", loserTo: "E8thSeedGame", loserField: "team1_id" },
        "W9vW10": { winnerTo: "W8thSeedGame", winnerField: "team2_id" },
        "E9vE10": { winnerTo: "E8thSeedGame", winnerField: "team2_id" },
        "W8thSeedGame": { winnerTo: "W1vW8", winnerField: "team2_id" },
        "E8thSeedGame": { winnerTo: "E1vE8", winnerField: "team2_id" },
        "E1vE8": { winnerTo: "E-R2-T", winnerField: "team1_id" },
        "W1vW8": { winnerTo: "W-R2-T", winnerField: "team1_id" },
        "E4vE5": { winnerTo: "E-R2-T", winnerField: "team2_id" },
        "W4vW5": { winnerTo: "W-R2-T", winnerField: "team2_id" },
        "E2vE7": { winnerTo: "E-R2-B", winnerField: "team2_id" },
        "W2vW7": { winnerTo: "W-R2-B", winnerField: "team2_id" },
        "E3vE6": { winnerTo: "E-R2-B", winnerField: "team1_id" },
        "W3vW6": { winnerTo: "W-R2-B", winnerField: "team1_id" },
        "E-R2-T": { winnerTo: "ECF", winnerField: "team1_id" },
        "W-R2-T": { winnerTo: "WCF", winnerField: "team1_id" },
        "E-R2-B": { winnerTo: "ECF", winnerField: "team2_id" },
        "W-R2-B": { winnerTo: "WCF", winnerField: "team2_id" },
        "ECF": { winnerTo: "Finals", winnerField: "team2_id" },
        "WCF": { winnerTo: "Finals", winnerField: "team1_id" },
    };

    for (const game of gamesToProcess) {
        const rule = advancementRules[game.series_id];
        if (!rule) continue;

        const winnerId = game.winner;
        const loserId = game.team1_id === winnerId ? game.team2_id : game.team1_id;

        if (rule.winnerTo && winnerId) {
            let winnerSeed = winnerId === game.team1_id ? game.team1_seed : game.team2_seed;
            if (game.series_id === "E7vE8" || game.series_id === "W7vW8") winnerSeed = '7';
            else if (game.series_id.includes('8thSeedGame')) winnerSeed = '8';

            const winnerSeedField = rule.winnerField.replace('_id', '_seed');
            const winnerNextSeriesSnap = await postGamesRef.where('series_id', '==', rule.winnerTo).get();
            winnerNextSeriesSnap.forEach(doc => {
                batch.update(doc.ref, { [rule.winnerField]: winnerId, [winnerSeedField]: winnerSeed || '' });
            });
        }

        if (rule.loserTo && loserId) {
            const loserSeed = loserId === game.team1_id ? game.team1_seed : game.team2_seed;
            const loserSeedField = rule.loserField.replace('_id', '_seed');
            const loserNextSeriesSnap = await postGamesRef.where('series_id', '==', rule.loserTo).get();
            loserNextSeriesSnap.forEach(doc => {
                batch.update(doc.ref, { [rule.loserField]: loserId, [loserSeedField]: loserSeed || '' });
            });
        }
    }
}


/**
 * The main workhorse function that simulates all games for a given day.
 */
async function simulateDay(gamesForDay, allPlayers) {
    const gameDate = gamesForDay[0].date;
    console.log(`\n🔥 Simulating ${gamesForDay.length} games for ${gameDate}...`);
    const batch = db.batch();
    const postGamesRef = db.collection(getCollectionName('seasons')).doc(SEASON_ID).collection(getCollectionName('post_games'));

    // 1. Simulate Lineups & Scores
    let newCompletedGames = [];
    const newCompletedLineups = [];

    for (const game of gamesForDay) {
        let team1_total_score = 0;
        let team2_total_score = 0;
        let team1_wins = game.team1_wins || 0;
        let team2_wins = game.team2_wins || 0;

        for (const teamId of [game.team1_id, game.team2_id]) {
            const teamPlayers = allPlayers.filter(p => p.current_team_id === teamId).slice(0, 6);
            teamPlayers.forEach((player, index) => {
                const points_adjusted = Math.floor(Math.random() * 15000);
                const global_rank = Math.floor(Math.random() * 3000) + 1;
                const isCaptain = index === 0;
                const final_score = isCaptain ? points_adjusted * 1.5 : points_adjusted;

                if (teamId === game.team1_id) team1_total_score += final_score;
                else team2_total_score += final_score;

                newCompletedLineups.push({
                    id: `${game.id}-${player.player_id}`, game_id: game.id, player_id: player.player_id, player_handle: player.player_handle,
                    team_id: teamId, date: game.date, week: game.week, started: 'TRUE', is_captain: isCaptain ? 'TRUE' : 'FALSE',
                    points_adjusted, global_rank, raw_score: points_adjusted, final_score
                });
            });
        }
        
        const winner = team1_total_score > team2_total_score ? game.team1_id : game.team2_id;
        if (winner === game.team1_id) team1_wins++;
        else team2_wins++;
        
        const updatedGame = { ...game, team1_score: team1_total_score, team2_score: team2_total_score, winner: winner, completed: 'TRUE', team1_wins, team2_wins };
        newCompletedGames.push(updatedGame);
    }
    process.stdout.write("  -> Scores & lineups generated.\n");

    // 2. Propagate Series Scores & Determine Series Winner
    let seriesWinners = new Map();
    for(const game of newCompletedGames) {
        if (game.week !== 'Play-In') {
            const winConditions = { 'Round 1': 2, 'Round 2': 2, 'Conf Finals': 3, 'Finals': 4 };
            const winsNeeded = winConditions[game.week] || 99;
            let series_winner = '';
            if (game.team1_wins === winsNeeded) series_winner = game.team1_id;
            else if (game.team2_wins === winsNeeded) series_winner = game.team2_id;
            
            if (series_winner) {
                seriesWinners.set(game.series_id, series_winner);
            }
        }
        const seriesGamesSnap = await postGamesRef.where('series_id', '==', game.series_id).get();
        seriesGamesSnap.forEach(doc => {
            batch.update(doc.ref, { team1_wins: game.team1_wins, team2_wins: game.team2_wins });
        });
    }
    
    newCompletedGames = newCompletedGames.map(g => ({ ...g, series_winner: seriesWinners.get(g.series_id) || g.series_winner || '' }));
    
    for(const [seriesId, winnerId] of seriesWinners.entries()) {
        const seriesGamesSnap = await postGamesRef.where('series_id', '==', seriesId).get();
        seriesGamesSnap.forEach(doc => {
            batch.update(doc.ref, { series_winner: winnerId });
        });
    }
    process.stdout.write("  -> Series scores propagated.\n");


    // 3. Process game day calculations
    const scores = newCompletedLineups.map(l => l.points_adjusted);
    const mean = calculateMedian(scores);
    const median = calculateMedian(scores);
    const replacement = median * 0.9;
    const win = median * 0.92;

    const dailyAvgData = { date: gameDate, week: gamesForDay[0].week, total_players: scores.length, mean_score: mean, median_score: median, replacement_level: replacement, win: win };
    const dailyAvgRef = db.doc(`${getCollectionName('post_daily_averages')}/season_${SEASON_NUM}/${getCollectionName(`S${SEASON_NUM}_post_daily_averages`)}/${gameDate}`);
    batch.set(dailyAvgRef, dailyAvgData);

    newCompletedLineups.forEach(l => {
        const points = l.points_adjusted;
        l.above_median = points - median;
        l.AboveMed = l.above_median > 0 ? 1 : 0;
        l.pct_above_median = median ? l.above_median / median : 0;
        l.SingleGameWar = win ? (points - replacement) / win : 0;
    });

    const teamScoresToday = newCompletedGames.flatMap(g => [g.team1_score, g.team2_score]);
    const teamMedianToday = calculateMedian(teamScoresToday);
    newCompletedGames.forEach(g => {
        [{ id: g.team1_id, score: g.team1_score }, { id: g.team2_id, score: g.team2_score }].forEach(team => {
            const pam = team.score - teamMedianToday;
            const dailyScoreData = { week: g.week, team_id: team.id, date: g.date, score: team.score, daily_median: teamMedianToday, above_median: pam > 0 ? 1 : 0, points_above_median: pam, pct_above_median: teamMedianToday ? pam / teamMedianToday : 0 };
            const dailyScoreRef = db.doc(`${getCollectionName('post_daily_scores')}/season_${SEASON_NUM}/${getCollectionName(`S${SEASON_NUM}_post_daily_scores`)}/${team.id}-${g.id}`);
            batch.set(dailyScoreRef, dailyScoreData);
        });
    });
    process.stdout.write("  -> Daily averages & scores calculated.\n");

    // 4. Update ALL seasonal stats
    const playersInvolved = [...new Set(newCompletedLineups.map(l => l.player_id))];
    for (const playerId of playersInvolved) {
        const prevLineupsSnap = await postGamesRef.collection('lineups').where('player_id', '==', playerId).get();
        const prevLineups = prevLineupsSnap.docs.map(d => d.data());
        const todaysLineups = newCompletedLineups.filter(l => l.player_id === playerId);
        const allPostLineups = [...prevLineups, ...todaysLineups];

        const playerStatsUpdate = { 
            post_games_played: allPostLineups.length,
            post_total_points: allPostLineups.reduce((sum, l) => sum + l.points_adjusted, 0),
            post_WAR: allPostLineups.reduce((sum, l) => sum + l.SingleGameWar, 0)
        };
        const playerStatsRef = db.doc(`${getCollectionName('v2_players')}/${playerId}/${getCollectionName('seasonal_stats')}/${SEASON_ID}`);
        batch.set(playerStatsRef, playerStatsUpdate, { merge: true });
    }
    
    const allTeamsSnap = await db.collection(getCollectionName("v2_teams")).get();
    const allTeams = allTeamsSnap.docs.map(d => ({id: d.id, ...d.data()}));
    const allCompletedGamesSnap = await postGamesRef.where('completed', '==', 'TRUE').get();
    const allCompletedGames = [...allCompletedGamesSnap.docs.map(d => d.data()), ...newCompletedGames.filter(g => g.id !== allCompletedGamesSnap.docs.find(doc => doc.id === g.id)?.id)];

    for(const team of allTeams) {
        const wins = allCompletedGames.filter(g => g.winner === team.id).length;
        const losses = allCompletedGames.filter(g => (g.team1_id === team.id || g.team2_id === team.id) && g.winner !== team.id && g.winner !== '').length;
        const teamStatsUpdate = { post_wins: wins, post_losses: losses };
        const teamRecordRef = db.doc(`${getCollectionName('v2_teams')}/${team.id}/${getCollectionName('seasonal_records')}/${SEASON_ID}`);
        batch.set(teamRecordRef, teamStatsUpdate, { merge: true });
    }
    process.stdout.write("  -> Player & Team seasonal stats updated.\n");

    // 5. Update the bracket
    process.stdout.write("  -> Advancing postseason bracket...");
    await advanceBracket(newCompletedGames, postGamesRef, batch);
    process.stdout.write(" Done.\n");


    // 6. Add final writes to the batch
    newCompletedGames.forEach(g => batch.set(postGamesRef.doc(g.id), g, { merge: true }));
    newCompletedLineups.forEach(l => batch.set(db.doc(`${getCollectionName('seasons')}/${SEASON_ID}/${getCollectionName('post_lineups')}/${l.id}`), l));
    
    await batch.commit();
    console.log(`✅ Day ${gameDate} successfully simulated and written to Firestore.`);
}

/**
 * The main interactive loop for the simulator.
 */
async function runSimulator() {
    console.log("--- RKL Postseason Simulator ---");
    const allPlayersSnap = await db.collection(getCollectionName("v2_players")).get();
    const allPlayers = allPlayersSnap.docs.map(doc => ({ player_id: doc.id, ...doc.data() }));

    while (true) {
        const gamesCollectionRef = db.collection(getCollectionName('seasons')).doc(SEASON_ID).collection(getCollectionName('post_games'));
        const nextGameQuery = gamesCollectionRef.where('completed', '==', 'FALSE').orderBy('date', 'asc').limit(1);
        const nextGameSnap = await nextGameQuery.get();

        if (nextGameSnap.empty) {
            console.log("\n🎉 Postseason simulation complete. No more games to simulate.");
            break;
        }

        const nextDate = nextGameSnap.docs[0].data().date;
        const gamesForDaySnap = await gamesCollectionRef.where('date', '==', nextDate).where('completed', '==', 'FALSE').get();
        const gamesForDay = gamesForDaySnap.docs.map(doc => ({id: doc.id, ...doc.data()}));
        
        if (gamesForDay.length === 0) {
            console.log("\n🎉 Postseason simulation complete. Found a date with no incomplete games.");
            break;
        }
        
        console.log(`\n--------------------------------\nNext simulatable day: ${nextDate}`);
        console.log("Scheduled Games:");
        gamesForDay.forEach(game => console.log(`  - ${game.series_name || 'Game'}: ${game.team1_id} vs ${game.team2_id}`));
        
        const answer = await askQuestion("\nSimulate this day? (y/n): ");
        if (answer.toLowerCase() === 'y') {
            await simulateDay(gamesForDay, allPlayers);
        } else {
            console.log("Exiting simulator.");
            break;
        }
    }
    rl.close();
}


// --- RUN THE SCRIPT ---
runSimulator().catch(err => {
    console.error("\nAn error occurred:", err);
    rl.close();
});