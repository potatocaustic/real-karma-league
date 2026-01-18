// Script to repair corrupted playoff series scores
// Recalculates team1_wins/team2_wins/series_winner from actual game winners
// Also creates missing Game 3 documents for series that need them
// Also fixes Conference Finals docs with incorrectly advanced teams

const admin = require('firebase-admin');
const serviceAccount = require('../functions/scripts/serviceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Set to false to actually apply changes
const DRY_RUN = true;

// Win conditions by round (best-of-N means need N wins)
const WIN_CONDITIONS = {
    'Play-In': null, // Single game, no series
    'Round 1': 2,    // Best of 3
    'Round 2': 2,    // Best of 3
    'Conf Finals': 3, // Best of 5
    'Finals': 4       // Best of 7
};

// Max games per round
const MAX_GAMES = {
    'Play-In': 1,
    'Round 1': 3,
    'Round 2': 3,
    'Conf Finals': 5,
    'Finals': 7
};

// Today's date for new games
const TODAY_DATE = '1/18/2026';

async function repairSeriesScores() {
    console.log(`=== Repair Series Scores ${DRY_RUN ? '(DRY RUN)' : '(LIVE)'} ===\n`);

    const seasonId = 'S9';
    const postGamesRef = db.collection('seasons').doc(seasonId).collection('post_games');

    // Get all post_games
    const postGamesSnap = await postGamesRef.get();
    console.log(`Total post_games documents: ${postGamesSnap.size}\n`);

    // Group by series_id
    const seriesMap = new Map();
    postGamesSnap.forEach(doc => {
        const game = doc.data();
        const seriesId = game.series_id;
        if (!seriesId) return; // Skip games without series_id

        if (!seriesMap.has(seriesId)) {
            seriesMap.set(seriesId, []);
        }
        seriesMap.get(seriesId).push({ ref: doc.ref, id: doc.id, ...game });
    });

    let totalFixed = 0;
    let totalCorrect = 0;
    let totalGamesCreated = 0;

    // Process each series
    for (const [seriesId, games] of seriesMap.entries()) {
        const firstGame = games[0];
        const team1Id = firstGame.team1_id;
        const team2Id = firstGame.team2_id;
        const week = firstGame.week;
        const winsNeeded = WIN_CONDITIONS[week];
        const maxGames = MAX_GAMES[week];

        // Count ACTUAL wins from completed games
        let actualTeam1Wins = 0;
        let actualTeam2Wins = 0;

        games.forEach(game => {
            if (game.completed === 'TRUE' && game.winner) {
                if (game.winner === team1Id) {
                    actualTeam1Wins++;
                } else if (game.winner === team2Id) {
                    actualTeam2Wins++;
                }
            }
        });

        // Determine actual series winner (if any)
        let actualSeriesWinner = '';
        if (winsNeeded) {
            if (actualTeam1Wins >= winsNeeded) {
                actualSeriesWinner = team1Id;
            } else if (actualTeam2Wins >= winsNeeded) {
                actualSeriesWinner = team2Id;
            }
        }

        // Get stored values from first game
        const storedTeam1Wins = firstGame.team1_wins || 0;
        const storedTeam2Wins = firstGame.team2_wins || 0;
        const storedSeriesWinner = firstGame.series_winner || '';

        // Check if repair is needed
        const needsRepair = (
            storedTeam1Wins !== actualTeam1Wins ||
            storedTeam2Wins !== actualTeam2Wins ||
            storedSeriesWinner !== actualSeriesWinner
        );

        // Check if we need to create a next game (series not won and next game doesn't exist)
        const totalGamesPlayed = actualTeam1Wins + actualTeam2Wins;
        const nextGameNumber = totalGamesPlayed + 1;
        const nextGameName = `${seriesId} Game ${nextGameNumber}`;
        const hasNextGame = games.some(g => g.series_name === nextGameName);
        const seriesOngoing = !actualSeriesWinner && nextGameNumber <= maxGames;
        const needsNewGame = seriesOngoing && !hasNextGame;

        if (needsRepair || needsNewGame) {
            console.log(`\n[${needsRepair ? 'FIX NEEDED' : 'GAME NEEDED'}] Series: ${seriesId} (${week})`);
            console.log(`  Teams: ${team1Id} vs ${team2Id}`);

            if (needsRepair) {
                console.log(`  Stored:  ${storedTeam1Wins}-${storedTeam2Wins}, winner: ${storedSeriesWinner || 'none'}`);
                console.log(`  Actual:  ${actualTeam1Wins}-${actualTeam2Wins}, winner: ${actualSeriesWinner || 'none'}`);
            }

            console.log(`  Games (${games.length} total):`);
            games.sort((a, b) => (a.series_name || '').localeCompare(b.series_name || ''));
            games.forEach(g => {
                const status = g.completed === 'TRUE' ? 'COMPLETE' : 'pending';
                console.log(`    - ${g.series_name || g.id}: winner=${g.winner || 'N/A'} (${status})`);
            });

            if (needsNewGame) {
                console.log(`  [MISSING] ${nextGameName} needs to be created!`);
            }

            if (!DRY_RUN) {
                const batch = db.batch();

                // Fix existing games if needed
                if (needsRepair) {
                    games.forEach(game => {
                        batch.update(game.ref, {
                            team1_wins: actualTeam1Wins,
                            team2_wins: actualTeam2Wins,
                            series_winner: actualSeriesWinner
                        });
                    });
                }

                // Create missing game if needed
                if (needsNewGame) {
                    const newGameRef = postGamesRef.doc();
                    const newGameData = {
                        series_id: seriesId,
                        series_name: nextGameName,
                        week: week,
                        date: TODAY_DATE,
                        team1_id: team1Id,
                        team2_id: team2Id,
                        team1_seed: firstGame.team1_seed || 0,
                        team2_seed: firstGame.team2_seed || 0,
                        team1_score: 0,
                        team2_score: 0,
                        team1_wins: actualTeam1Wins,
                        team2_wins: actualTeam2Wins,
                        winner: '',
                        series_winner: '',
                        completed: 'FALSE'
                    };
                    batch.set(newGameRef, newGameData);
                    console.log(`  --> Creating ${nextGameName} with ID: ${newGameRef.id}`);
                    totalGamesCreated++;
                }

                await batch.commit();
                console.log(`  --> FIXED!`);
            } else {
                if (needsRepair) {
                    console.log(`  --> Would fix scores (DRY RUN)`);
                }
                if (needsNewGame) {
                    console.log(`  --> Would create ${nextGameName} (DRY RUN)`);
                    totalGamesCreated++;
                }
            }

            if (needsRepair) totalFixed++;
        } else {
            totalCorrect++;
        }
    }

    // ========================================
    // PART 2: Fix Conference Finals bracket advancement
    // ========================================
    console.log(`\n=== Checking Conference Finals Bracket Advancement ===`);

    // Advancement rules: which Round 2 series feeds which Conference Finals slot
    const advancementRules = {
        'E-R2-T': { targetSeries: 'ECF', targetField: 'team1_id', targetSeedField: 'team1_seed' },
        'E-R2-B': { targetSeries: 'ECF', targetField: 'team2_id', targetSeedField: 'team2_seed' },
        'W-R2-T': { targetSeries: 'WCF', targetField: 'team1_id', targetSeedField: 'team1_seed' },
        'W-R2-B': { targetSeries: 'WCF', targetField: 'team2_id', targetSeedField: 'team2_seed' },
    };

    // Build map of actual Round 2 series winners (recalculated above)
    const round2Winners = new Map();
    for (const [seriesId, games] of seriesMap.entries()) {
        if (!seriesId.includes('-R2-')) continue; // Only Round 2 series

        const firstGame = games[0];
        const team1Id = firstGame.team1_id;
        const team2Id = firstGame.team2_id;

        // Count actual wins
        let team1Wins = 0, team2Wins = 0;
        games.forEach(game => {
            if (game.completed === 'TRUE' && game.winner) {
                if (game.winner === team1Id) team1Wins++;
                else if (game.winner === team2Id) team2Wins++;
            }
        });

        // Determine winner (need 2 wins for Round 2)
        let winner = null;
        let winnerSeed = null;
        if (team1Wins >= 2) {
            winner = team1Id;
            winnerSeed = firstGame.team1_seed;
        } else if (team2Wins >= 2) {
            winner = team2Id;
            winnerSeed = firstGame.team2_seed;
        }

        round2Winners.set(seriesId, { winner, winnerSeed, team1Wins, team2Wins });
        console.log(`  ${seriesId}: ${team1Wins}-${team2Wins} → winner: ${winner || 'none (series ongoing)'}`);
    }

    // Check and fix Conference Finals docs
    let bracketFixesNeeded = 0;

    for (const [sourceSeriesId, rule] of Object.entries(advancementRules)) {
        const r2Result = round2Winners.get(sourceSeriesId);
        if (!r2Result) continue;

        const targetGames = seriesMap.get(rule.targetSeries);
        if (!targetGames || targetGames.length === 0) continue;

        const expectedTeamId = r2Result.winner || 'TBD';
        const expectedSeed = r2Result.winnerSeed || '';
        const currentTeamId = targetGames[0][rule.targetField] || 'TBD';
        const currentSeed = targetGames[0][rule.targetSeedField] || '';

        if (currentTeamId !== expectedTeamId) {
            console.log(`\n[BRACKET FIX NEEDED] ${rule.targetSeries}.${rule.targetField}`);
            console.log(`  Source: ${sourceSeriesId} (${r2Result.team1Wins}-${r2Result.team2Wins})`);
            console.log(`  Current: ${currentTeamId} (seed: ${currentSeed})`);
            console.log(`  Expected: ${expectedTeamId} (seed: ${expectedSeed})`);

            if (!DRY_RUN) {
                const batch = db.batch();
                targetGames.forEach(game => {
                    batch.update(game.ref, {
                        [rule.targetField]: expectedTeamId,
                        [rule.targetSeedField]: expectedSeed
                    });
                });
                await batch.commit();
                console.log(`  --> FIXED! Updated ${targetGames.length} ${rule.targetSeries} game docs`);
            } else {
                console.log(`  --> Would fix ${targetGames.length} ${rule.targetSeries} game docs (DRY RUN)`);
            }
            bracketFixesNeeded++;
        }
    }

    if (bracketFixesNeeded === 0) {
        console.log(`  All Conference Finals bracket slots are correct.`);
    }

    // ========================================
    // Summary
    // ========================================
    console.log(`\n=== Summary ===`);
    console.log(`Series correct: ${totalCorrect}`);
    console.log(`Series ${DRY_RUN ? 'would be ' : ''}fixed: ${totalFixed}`);
    console.log(`Games ${DRY_RUN ? 'would be ' : ''}created: ${totalGamesCreated}`);
    console.log(`Bracket slots ${DRY_RUN ? 'would be ' : ''}fixed: ${bracketFixesNeeded}`);

    if (DRY_RUN && (totalFixed > 0 || totalGamesCreated > 0 || bracketFixesNeeded > 0)) {
        console.log(`\nTo apply fixes, set DRY_RUN = false and run again.`);
    }

    process.exit(0);
}

repairSeriesScores().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});
