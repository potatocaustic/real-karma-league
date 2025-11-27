// functions/reporting/writeups.js

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require("../utils/firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { getCollectionName, getLeagueFromRequest, LEAGUES } = require('../utils/firebase-helpers');
const { isScorekeeperOrAdmin, getUserRole } = require('../utils/auth-helpers');
const { processAndFinalizeGame } = require('../live-scoring/live-games');
const { performPlayerRankingUpdate } = require('../utils/ranking-helpers');

/**
 * Generates game writeup data for AI processing
 * Collects team and player information for a game to be written up
 */
exports.generateGameWriteup = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
    if (!(await isScorekeeperOrAdmin(request.auth, league))) {
        throw new HttpsError('permission-denied', 'Must be an admin or scorekeeper to run this function.');
    }

    const { gameId, seasonId, collectionName, isLive } = request.data;
    if (!gameId || !seasonId || !collectionName) {
        throw new HttpsError('invalid-argument', 'Missing required parameters.');
    }

    try {
        let gameData, lineupsData, calculatedTeam1Score, calculatedTeam2Score, determinedWinner, team1Id, team2Id;

        if (isLive) {
            const liveGameRef = db.doc(`${getCollectionName('live_games', league)}/${gameId}`);
            const liveGameSnap = await liveGameRef.get();
            if (!liveGameSnap.exists) throw new HttpsError('not-found', 'Live game not found.');

            const liveGameData = liveGameSnap.data();
            const fullLineupFromLiveGame = [...liveGameData.team1_lineup, ...liveGameData.team2_lineup];

            const originalGameRef = db.doc(`${getCollectionName('seasons', league)}/${seasonId}/${liveGameData.collectionName}/${gameId}`);
            const originalGameSnap = await originalGameRef.get();
            if (!originalGameSnap.exists) throw new HttpsError('not-found', 'Original game data not found for the live game.');
            gameData = originalGameSnap.data();
            team1Id = gameData.team1_id;
            team2Id = gameData.team2_id;

            const playerIds = fullLineupFromLiveGame.map(p => p.player_id);
            const playerDocs = await db.collection(getCollectionName('v2_players', league)).where(admin.firestore.FieldPath.documentId(), 'in', playerIds).get();
            const teamIdMap = new Map();
            playerDocs.forEach(doc => {
                teamIdMap.set(doc.id, doc.data().current_team_id);
            });

            lineupsData = fullLineupFromLiveGame.map(player => ({
                ...player,
                team_id: teamIdMap.get(player.player_id)
            }));

            calculatedTeam1Score = liveGameData.team1_lineup.reduce((sum, p) => sum + (p.final_score || 0), 0);
            calculatedTeam2Score = liveGameData.team2_lineup.reduce((sum, p) => sum + (p.final_score || 0), 0);
            determinedWinner = calculatedTeam1Score > calculatedTeam2Score ? team1Id : (calculatedTeam2Score > calculatedTeam1Score ? team2Id : '');

        } else {
            const gameRef = db.doc(`${getCollectionName('seasons', league)}/${seasonId}/${collectionName}/${gameId}`);
            const gameSnap = await gameRef.get();
            if (!gameSnap.exists) throw new HttpsError('not-found', 'Completed game not found.');
            gameData = gameSnap.data();
            team1Id = gameData.team1_id;
            team2Id = gameData.team2_id;

            const lineupsCollection = collectionName.replace('games', 'lineups');
            const lineupsQuery = db.collection(`${getCollectionName('seasons', league)}/${seasonId}/${lineupsCollection}`).where('game_id', '==', gameId);
            const lineupsSnap = await lineupsQuery.get();
            lineupsData = lineupsSnap.docs.map(doc => doc.data());

            calculatedTeam1Score = gameData.team1_score;
            calculatedTeam2Score = gameData.team2_score;
            determinedWinner = gameData.winner;
        }

        const team1RecordRef = db.doc(`${getCollectionName('v2_teams', league)}/${team1Id}/${getCollectionName('seasonal_records', league)}/${seasonId}`);
        const team2RecordRef = db.doc(`${getCollectionName('v2_teams', league)}/${team2Id}/${getCollectionName('seasonal_records', league)}/${seasonId}`);
        const [team1RecordSnap, team2RecordSnap] = await Promise.all([team1RecordRef.get(), team2RecordRef.get()]);

        const team1Data = team1RecordSnap.data();
        const team2Data = team2RecordSnap.data();
        const formatScore = (score) => (typeof score === 'number' && isFinite(score) ? score.toFixed(0) : '0');

        const team1Name = team1Data?.team_name ?? team1Id;
        let team1Wins = team1Data?.wins ?? 0;
        let team1Losses = team1Data?.losses ?? 0;

        const team2Name = team2Data?.team_name ?? team2Id;
        let team2Wins = team2Data?.wins ?? 0;
        let team2Losses = team2Data?.losses ?? 0;

        if (isLive && determinedWinner) {
            if (determinedWinner === team1Id) {
                team1Wins++;
                team2Losses++;
            } else if (determinedWinner === team2Id) {
                team2Wins++;
                team1Losses++;
            }
        }

        const team1Score = formatScore(calculatedTeam1Score);
        const team2Score = formatScore(calculatedTeam2Score);

        const team1Summary = `${team1Name} (${team1Wins}-${team1Losses}) - ${team1Score} ${determinedWinner === team1Id ? '✅' : '❌'}`;
        const team2Summary = `${team2Name} (${team2Wins}-${team2Losses}) - ${team2Score} ${determinedWinner === team2Id ? '✅' : '❌'}`;

        const top100Performers = lineupsData
            .filter(p => p && typeof p === 'object' && p.global_rank > 0 && p.global_rank <= 100)
            .sort((a, b) => (a.global_rank || 999) - (b.global_rank || 999));

        const formatPlayerString = p => `@${p.player_handle || 'unknown'} (${p.global_rank}${p.is_captain === 'TRUE' ? ', captain' : ''})`;

        const team1PerformersString = top100Performers
            .filter(p => p.team_id === team1Id)
            .map(formatPlayerString)
            .join(', ');

        const team2PerformersString = top100Performers
            .filter(p => p.team_id === team2Id)
            .map(formatPlayerString)
            .join(', ');

        // Create the new, more structured prompt data
        const promptData = `
Matchup: ${team1Summary} vs ${team2Summary}
${team1Name} Top 100 Performers: ${team1PerformersString || 'None'}
${team2Name} Top 100 Performers: ${team2PerformersString || 'None'}
`;

        const systemPrompt = `You are a sports writer for a fantasy league called the Real Karma League. You write short, engaging game summaries to an audience of mostly 18-25 year olds. Voice should err on the side of dry rather than animated, but try not to be repetitive or banal. You MUST mention every player from the 'Top 100 Performers' list, putting an '@' symbol before their handle. Note: do not mention "best on the week" as a week's games are spread out across multiple days. Avoid the term "edge" as this has sexual connotations.

Here are some examples of the required style:
Example 1: Aces take a blowout win here against the Gravediggers who forgot to submit a lineup on time leading to the absence of a captain. Aces had multiple top 100s in @corbin (3rd) who exploded to a top 3 performance in the win along with @kenny_wya (17th) doing very well at captain, @flem2tuff (70th), and @jamie (94th). Gravediggers had @cry (97th) sneak into the top 100 but even with the handsome @grizzy with a top 5 on the bench the Aces take a nice win here.
Example 2: Amigos take a nice win here over the struggling Piggies on the back of lone top 100 of the match @devonta (34th). Piggies overall had better placements, but 2 unranked players and no top 100s leads to the Amigos win here to get them above .500.
Example 3: Hounds grab a close win over the KOCK in a great game, which sends the latter to 0-3. Hounds had 4 t100s, including @tiger (24th), @neev (25th), captain @poolepartyjp3 (30th) and @jay.p (97th). KOCK also had 4 t100s with @goated14 (23rd), captain @chazwick (30th), @ederick2442 (63rd) and @top (66th), but @cinemax cost them dearly.
Example 4: Outlaws pick up their first win against the lowly Kings who are just straight ass. Outlaws had @jobro (21st), @cs_derrick13 (73rd), captain @gaston (79th) and @clarke (97th). Kings had the pair of @snivy and @juan69 finish 66th and 67th.
Example 5: Aces get a blowout win thanks to heavyweight days from @flem2tuff (11th) and @kenny_wya (12th). They backed that up with big performances from @maliknabers69 (33th) and @jamie (72nd). KOCK had a nice day from their captain @chazwick (48th) in the loss.
Example 6: Stars comfortably win this match led by juggernaut days from @raiola (7th) and @willi3 (11th), followed by top 100s from @hoodispida (60th), @devinbooker (64th), and @juan.soto22 (85th). Jammers had a solid day with @swouse (28th) providing a captain advantage along with 3 more top 100s from @caustic (37th), @mccasual (78th), and @dortch (79th), but suffered from a lack of depth.

Now, write a new summary based on the following data:`;

        return { success: true, league, promptData, systemPrompt, team1Summary, team2Summary };

    } catch (error) {
        console.error("CRITICAL ERROR in generateGameWriteup:", error);
        throw new HttpsError('internal', `An unexpected error occurred. Check the function logs. Error: ${error.message}`);
    }
});

/**
 * Calls Google AI to generate a writeup based on prompt data
 * Uses Gemini to create game summaries
 */
exports.getAiWriteup = onCall({ secrets: ["GOOGLE_AI_KEY"] }, async (request) => {
    const league = getLeagueFromRequest(request.data);
    // 1. Security: Ensure the user is authenticated and is a scorekeeper or admin
    if (!(await isScorekeeperOrAdmin(request.auth, league))) {
        throw new HttpsError('permission-denied', 'Must be an admin or scorekeeper to run this function.');
    }

    const { systemPrompt, promptData } = request.data;
    if (!systemPrompt || !promptData) {
        throw new HttpsError('invalid-argument', 'The function must be called with prompt data.');
    }

    try {
        // 2. Access the secret API key and initialize the AI client
        const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_KEY);

        // Changed "gemini-pro" to the current, recommended model "gemini-1.5-flash-latest"
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

        const fullPrompt = `${systemPrompt}\n\n${promptData}`;

        // 3. Call the AI and get the result
        const result = await model.generateContent(fullPrompt);
        const response = await result.response;
        const writeup = response.text();

        // 4. Return the finished writeup to the client
        return { success: true, league, writeup: writeup };

    } catch (error) {
        console.error("Error calling Google AI:", error);
        throw new HttpsError('internal', 'Failed to generate writeup from AI model.');
    }
});

/**
 * Scorekeeper function to finalize all live games and trigger stat updates
 * Archives live games, finalizes them, and runs the full stat recalculation cascade
 */
exports.scorekeeperFinalizeAndProcess = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
    // 1. Security Check
    if (!(await isScorekeeperOrAdmin(request.auth, league))) {
        throw new HttpsError('permission-denied', 'Must be an admin or scorekeeper to run this function.');
    }

    const userId = request.auth.uid;
    console.log(`Manual finalization process initiated by user: ${userId}`);

    try {
        // 2. Database Backup (Simulated) & Archive
        console.log("Step 1: Backing up and archiving live games...");
        const liveGamesSnap = await db.collection(getCollectionName('live_games', league)).get();
        if (liveGamesSnap.empty) {
            return { success: true, league, message: "No live games were active. Process complete." };
        }

        const archiveBatch = db.batch();
        const backupTimestamp = new Date().toISOString();
        liveGamesSnap.docs.forEach(doc => {
            const archiveRef = db.collection(getCollectionName('archived_live_games', league)).doc(`${backupTimestamp}-${doc.id}`);
            archiveBatch.set(archiveRef, { ...doc.data(), archivedAt: FieldValue.serverTimestamp(), archivedBy: userId });
        });
        await archiveBatch.commit();
        console.log(`Archived ${liveGamesSnap.size} games successfully.`);

        // 3. Process and Finalize Games
        console.log("Step 2: Processing and finalizing games...");
        for (const gameDoc of liveGamesSnap.docs) {
            await processAndFinalizeGame(gameDoc, true, league); // Use the existing robust finalization logic
        }
        console.log("All live games have been finalized.");

        // 4. Run the full cascade of overnight processes
        console.log("Step 3: Triggering stat recalculation cascade...");
        await performPlayerRankingUpdate(league);

        // Import these functions dynamically to avoid circular dependencies
        const { performPerformanceRankingUpdate } = require('../utils/stats-helpers');
        const { performWeekUpdate } = require('../seasons/week-management');
        const { performBracketUpdate } = require('../playoffs/bracket');

        await performPerformanceRankingUpdate(league);
        await performWeekUpdate(league);
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = `${yesterday.getMonth() + 1}/${yesterday.getDate()}/${yesterday.getFullYear()}`;
        await performBracketUpdate(yesterdayStr, league);
        console.log("Stat recalculation cascade complete.");

        // 5. Log the activity
        console.log("Step 4: Logging scorekeeper activity...");
        // 'scorekeeper_activity_log' is a shared collection, so no league parameter needed
        const logRef = db.collection(getCollectionName('scorekeeper_activity_log')).doc();
        await logRef.set({
            action: 'finalizeAndProcess',
            userId: userId,
            userRole: await getUserRole(request.auth, league),
            timestamp: FieldValue.serverTimestamp(),
            details: `Processed and finalized ${liveGamesSnap.size} live games for ${league} league.`
        });
        console.log("Activity logged successfully.");

        return { success: true, league, message: `Successfully finalized ${liveGamesSnap.size} games and updated all stats.` };

    } catch (error) {
        console.error("Error during scorekeeper finalization process:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError('internal', 'An unexpected error occurred during the finalization process.');
    }
});

// Export Cloud Functions
module.exports.generateGameWriteup = exports.generateGameWriteup;
module.exports.getAiWriteup = exports.getAiWriteup;
module.exports.scorekeeperFinalizeAndProcess = exports.scorekeeperFinalizeAndProcess;
