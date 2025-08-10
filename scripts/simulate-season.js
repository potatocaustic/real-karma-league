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
        .filter(team => team.conference === 'Eastern' || team.conference === 'Western'); // <--- MODIFIED: Filter for valid conference teams

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
    let gameDate = new Date(); // Start from today
    gameDate.setDate(gameDate.getDate() - (gameDate.getDay() + 6) % 7); // Start on a Monday

    for (let week = 1; week <= 15; week++) {
        // Simple random matchups for simulation purposes
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
                completed: 'FALSE', // Initially not completed
                team1_score: 0,
                team2_score: 0,
                winner: ''
            });
        }
        // Advance to the next week
        gameDate.setDate(gameDate.getDate() + 7);
    }
    console.log(`Generated ${schedule.length} games.`);

    // 3. SIMULATE GAMES AND GENERATE LINEUP DATA
    console.log("Simulating games and generating lineup data...");
    const allLineups = [];
    for (const game of schedule) {
        // Simulate team scores
        game.team1_score = Math.floor(Math.random() * 500000) + 100000;
        game.team2_score = Math.floor(Math.random() * 500000) + 100000;
        game.winner = game.team1_score > game.team2_score ? game.team1_id : game.team2_id;
        game.completed = 'TRUE'; // Mark as completed for the final write

        // Simulate lineups for each team
        [game.team1_id, game.team2_id].forEach(teamId => {
            const teamPlayers = allPlayers.filter(p => p.current_team_id === teamId).slice(0, 6); // Assume 6 starters
            teamPlayers.forEach((player, index) => {
                // Simulate player scores
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
                    is_captain: index === 0 ? 'TRUE' : 'FALSE', // Designate first player as captain
                    points_adjusted,
                    global_rank,
                    raw_score: points_adjusted, // For simplicity, raw = adjusted
                });
            });
        });
    }

    // 4. WRITE ALL SIMULATED DATA TO FIRESTORE
    console.log("Writing simulated data to Firestore...");
    const batch = db.batch();
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

    const seasonRef = db.collection(getCollectionName("seasons")).doc(SEASON_ID);
    const gamesCollectionRef = seasonRef.collection(getCollectionName("games"));
    const lineupsCollectionRef = seasonRef.collection(getCollectionName("lineups"));

    for (const game of schedule) {
        batch.set(gamesCollectionRef.doc(game.id), game);
        writeCount++;
        await commitBatchIfNeeded();
    }

    for (const lineup of allLineups) {
        batch.set(lineupsCollectionRef.doc(lineup.id), lineup);
        writeCount++;
        await commitBatchIfNeeded();
    }

    // Commit any remaining writes
    if (writeCount > 0) {
        console.log(`Committing final batch of ${writeCount} writes...`);
        await batch.commit();
    }
    console.log("✅ All simulated game and lineup data has been written.");
    console.log("--> IMPORTANT: Firestore triggers will now process this data. This may take several minutes.");
    console.log("--> Monitor your functions logs to see the 'processCompletedGame' triggers firing.");
    console.log("--> Once the triggers are finished, your database will be populated with a full season of stats.");
}

// --- Run the Simulation Script ---
simulateSeason().catch(console.error);
