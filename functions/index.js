// functions/index.js

const { onDocumentUpdated, onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const fetch = require("node-fetch");

admin.initializeApp();
const db = admin.firestore();

// ===================================================================
// DEVELOPMENT ENVIRONMENT CONFIGURATION
// ===================================================================
const USE_DEV_COLLECTIONS = true;

const getCollectionName = (baseName) => {
    if (baseName.includes('_daily_scores') || baseName.includes('_daily_averages') || baseName.includes('_lineups') || baseName.includes('_games') || baseName.includes('_draft_results') || baseName.includes('live_scoring_status') || baseName.includes('usage_stats')) {
        return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
    }
    return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
};

// ===================================================================
// LIVE SCORING REFACTOR FUNCTIONS
// ===================================================================

async function performFullUpdate() {
    const statusSnap = await db.doc(`${getCollectionName('live_scoring_status')}/status`).get();
    const gameDate = statusSnap.exists ? statusSnap.data().active_game_date : new Date().toISOString().split('T')[0];

    const liveGamesSnap = await db.collection(getCollectionName('live_games')).get();
    if (liveGamesSnap.empty) {
        console.log("performFullUpdate: No active games to update.");
        return { success: true, message: "No active games to update." };
    }

    const batch = db.batch();
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    let apiRequests = 0;

    for (const gameDoc of liveGamesSnap.docs) {
        const gameData = gameDoc.data();
        const allStarters = [...gameData.team1_lineup, ...gameData.team2_lineup];

        for (let i = 0; i < allStarters.length; i++) {
            const player = allStarters[i];
            const workerUrl = `https://rkl-karma-proxy.caustic.workers.dev/?userId=${encodeURIComponent(player.player_id)}`;
            try {
                const response = await fetch(workerUrl);
                apiRequests++;
                const data = await response.json();
                const rawScore = parseFloat(data?.stats?.karmaDelta || 0);
                const adjustedScore = rawScore - (player.deductions || 0);
                const finalScore = player.is_captain ? adjustedScore * 1.5 : adjustedScore;
                player.points_raw = rawScore;
                player.points_adjusted = adjustedScore;
                player.final_score = finalScore;
            } catch (error) {
                console.error(`performFullUpdate: Failed to fetch karma for ${player.player_id}`, error);
            }
            await delay(Math.floor(Math.random() * 201) + 100);
        }
        batch.update(gameDoc.ref, {
            team1_lineup: gameData.team1_lineup,
            team2_lineup: gameData.team2_lineup
        });
    }

    await batch.commit();

    const usageRef = db.doc(`${getCollectionName('usage_stats')}/${gameDate}`);
    await usageRef.set({
        api_requests_full_update: FieldValue.increment(apiRequests)
    }, { merge: true });

    const statusRef = db.doc(`${getCollectionName('live_scoring_status')}/status`);
    await statusRef.set({
        last_full_update_completed: FieldValue.serverTimestamp()
    }, { merge: true });

    return { success: true, message: `Updated scores for ${liveGamesSnap.size} games. Made ${apiRequests} API requests.` };
}



exports.updateAllLiveScores = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }
    return await performFullUpdate();
});

/**
 * Manages the state of the live scoring system. Can be set to 'active', 'paused', or 'stopped'.
 * Now also handles setting the active game date and logging the number of live games for usage stats.
 */
exports.setLiveScoringStatus = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth || !request.auth.uid) {
        throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to set live scoring status.');
    }

    const { status, interval, gameDate } = request.data;
    const validStatuses = ['active', 'paused', 'stopped'];
    if (!validStatuses.includes(status)) {
        throw new HttpsError('invalid-argument', 'Invalid payload. Expects { status: "active" | "paused" | "stopped" }');
    }

    const statusRef = db.doc(`${getCollectionName('live_scoring_status')}/status`);
    try {
        const updateData = {
            status: status,
            updated_by: request.auth.uid,
            last_updated: FieldValue.serverTimestamp()
        };
        if (interval && typeof interval === 'number') {
            updateData.interval_minutes = interval;
        }

        if (gameDate) {
            updateData.active_game_date = gameDate;
            const liveGamesSnap = await db.collection(getCollectionName('live_games')).get();
            const usageRef = db.doc(`${getCollectionName('usage_stats')}/${gameDate}`);
            await usageRef.set({ live_game_count: liveGamesSnap.size }, { merge: true });
        }

        await statusRef.set(updateData, { merge: true });

        return { success: true, message: `Live scoring status set to ${status}.` };
    } catch (error) {
        console.error("Error updating live scoring status:", error);
        throw new HttpsError('internal', 'Could not update live scoring status.');
    }
});


// This function now runs every minute to CHECK if it's time to sample.
exports.scheduledSampler = onSchedule("every 1 minutes", async (event) => {
    const statusRef = db.doc(getCollectionName('live_scoring_status') + '/status');
    const statusSnap = await statusRef.get();

    if (!statusSnap.exists || statusSnap.data().status !== 'active') {
        console.log(`Sampler is not active (current status: ${statusSnap.data().status || 'stopped'}). Exiting.`);
        return null;
    }

    const { interval_minutes, last_sample_completed_at } = statusSnap.data();
    const now = new Date();
    
    // If a sample has never been run, or if enough time has passed, run the sample.
    if (!last_sample_completed_at || now.getTime() >= last_sample_completed_at.toDate().getTime() + (interval_minutes * 60 * 1000)) {
        
        console.log(`Interval of ${interval_minutes} minutes has passed. Performing sample.`);
        const gameDate = statusSnap.data().active_game_date;

        const liveGamesSnap = await db.collection(getCollectionName('live_games')).get();
        if (liveGamesSnap.empty) {
            console.log("No live games to sample. Stopping.");
            return null;
        }

        const allStarters = liveGamesSnap.docs.flatMap(doc => [...doc.data().team1_lineup, ...doc.data().team2_lineup]);
        if (allStarters.length < 3) {
            console.log("Not enough players to sample (< 3).");
            return null;
        }

        // --- Sampling Logic (Unchanged, but now runs dynamically) ---
        const sampledPlayers = [];
        const usedIndices = new Set();
        while (sampledPlayers.length < 3 && usedIndices.size < allStarters.length) {
            const randomIndex = Math.floor(Math.random() * allStarters.length);
            if (!usedIndices.has(randomIndex)) {
                sampledPlayers.push(allStarters[randomIndex]);
                usedIndices.add(randomIndex);
            }
        }
        
        let changesDetected = 0;
        let apiRequests = 0;
        const sampleResults = [];
        for (const player of sampledPlayers) {
            const workerUrl = `https://rkl-karma-proxy.caustic.workers.dev/?userId=${encodeURIComponent(player.player_id)}`;
            await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 1001) + 500)); // Randomized delay
            try {
                const response = await fetch(workerUrl);
                apiRequests++;
                const data = await response.json();
                const newRawScore = parseFloat(data?.stats?.karmaDelta || 0);
                const oldRawScore = player.points_raw || 0;
                const hasChanged = newRawScore !== oldRawScore;
                if (hasChanged) changesDetected++;
                sampleResults.push({ handle: player.player_handle, oldScore: oldRawScore, newScore: newRawScore, changed: hasChanged });
            } catch (error) { console.error(`Sampler failed to fetch karma for ${player.player_id}`, error); }
        }

        // --- Update status doc with results and the NEW completion time ---
        await statusRef.set({ 
            last_sample_results: sampleResults,
            last_sample_completed_at: FieldValue.serverTimestamp()
        }, { merge: true });

        const usageRef = db.doc(`${getCollectionName('usage_stats')}/${gameDate}`);
        await usageRef.set({ api_requests_sample: FieldValue.increment(apiRequests) }, { merge: true });

        if (changesDetected >= 2) {
            console.log(`Sampler detected ${changesDetected} changes. Triggering full update.`);
            await performFullUpdate();
        } else {
            console.log(`Sampler detected only ${changesDetected} changes. No update triggered.`);
        }
    } else {
        // Not time to run yet, exit quietly.
        return null;
    }
    return null;
});


// ===================================================================
// V2 FUNCTIONS (EXISTING)
// ===================================================================

exports.getLiveKarma = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }

    const playerHandle = request.data.playerHandle;
    if (!playerHandle) {
        throw new HttpsError('invalid-argument', 'The function must be called with a "playerHandle" argument.');
    }

    const workerUrl = `https://rkl-karma-proxy.caustic.workers.dev/?userId=${encodeURIComponent(playerHandle)}`;

    try {
        const response = await fetch(workerUrl);

        if (!response.ok) {
            console.error(`Failed to fetch karma for ${playerHandle} via worker. Status: ${response.status}`);
            return { karmaDelta: 0, karmaDayRank: -1 };
        }
        const data = await response.json();

        const karmaDelta = parseFloat(data?.stats?.karmaDelta || 0);
        const karmaDayRank = parseInt(data?.stats?.karmaDayRank || -1, 10);

        return {
            karmaDelta: isNaN(karmaDelta) ? 0 : karmaDelta,
            karmaDayRank: isNaN(karmaDayRank) ? -1 : karmaDayRank,
        };

    } catch (error) {
        console.error(`Exception while fetching karma for ${playerHandle}:`, error);
        throw new HttpsError('internal', 'Failed to fetch live score data.');
    }
});


exports.activateLiveGame = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth || !request.auth.uid) {
        throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }

    const { gameId, seasonId, collectionName, team1_lineup, team2_lineup } = request.data;
    if (!gameId || !seasonId || !collectionName || !team1_lineup || !team2_lineup) {
        throw new HttpsError('invalid-argument', 'Missing required parameters for activating a live game.');
    }

    try {
        const liveGameRef = db.collection(getCollectionName('live_games')).doc(gameId);
        await liveGameRef.set({
            seasonId,
            collectionName,
            team1_lineup,
            team2_lineup,
            activatedAt: FieldValue.serverTimestamp()
        });
        return { success: true, message: "Game activated for live scoring." };
    } catch (error) {
        console.error(`Error activating live game ${gameId}:`, error);
        throw new HttpsError('internal', 'Could not activate live game.');
    }
});

exports.finalizeLiveGame = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth || !request.auth.uid) {
        throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }

    const { gameId } = request.data;
    if (!gameId) {
        throw new HttpsError('invalid-argument', 'A gameId must be provided.');
    }

    try {
        const liveGameRef = db.collection(getCollectionName('live_games')).doc(gameId);
        const liveGameSnap = await liveGameRef.get();

        if (!liveGameSnap.exists) {
            throw new HttpsError('not-found', 'The specified game is not currently live.');
        }

        await processAndFinalizeGame(liveGameSnap, false); // Manual finalization has no player delays

        return { success: true, message: `Game ${gameId} has been successfully finalized and scores have been written.` };

    } catch (error) {
        console.error(`Error finalizing game ${gameId}:`, error);
        if (error instanceof HttpsError) {
            throw error;
        }
        throw new HttpsError('internal', `An unexpected error occurred while finalizing the game: ${error.message}`);
    }
});


exports.autoFinalizeGames = onSchedule({
    schedule: "every day 03:00",
    timeZone: "America/Chicago", // Central Time
}, async (event) => {
    console.log("Running scheduled job to auto-finalize games.");
    const liveGamesSnap = await db.collection(getCollectionName('live_games')).get();

    if (liveGamesSnap.empty) {
        console.log("No live games found to auto-finalize.");
        return null;
    }

    console.log(`Found ${liveGamesSnap.size} games to auto-finalize.`);

    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    for (const gameDoc of liveGamesSnap.docs) {
        try {
            const randomGameDelay = Math.floor(Math.random() * 201) + 200;
            await delay(randomGameDelay);

            console.log(`Auto-finalizing game ${gameDoc.id} after a ${randomGameDelay}ms delay.`);
            await processAndFinalizeGame(gameDoc, true); // Auto-finalization uses player delays
            console.log(`Successfully auto-finalized game ${gameDoc.id}.`);

        } catch (error) {
            console.error(`Failed to auto-finalize game ${gameDoc.id}:`, error);
            await gameDoc.ref.update({ status: 'AUTO_FINALIZE_FAILED', error: error.message });
        }
    }

    console.log("Auto-finalization job completed.");
    return null;
});


async function processAndFinalizeGame(liveGameSnap, isAutoFinalize = false) {
    const gameId = liveGameSnap.id;
    const liveGameData = liveGameSnap.data();
    const { seasonId, collectionName, team1_lineup, team2_lineup } = liveGameData;

    const allPlayersInGame = [...team1_lineup, ...team2_lineup];
    const playerDocs = await db.collection(getCollectionName('v2_players')).get();
    const allPlayersMap = new Map(playerDocs.docs.map(doc => [doc.id, doc.data()]));

    const batch = db.batch();
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const finalScoresMap = new Map();
    for (const player of allPlayersInGame) {
        if (isAutoFinalize) {
            const randomPlayerDelay = Math.floor(Math.random() * 201) + 200;
            await delay(randomPlayerDelay);
        }

        const workerUrl = `https://rkl-karma-proxy.caustic.workers.dev/?userId=${encodeURIComponent(player.player_id)}`;
        try {
            const response = await fetch(workerUrl);
            const data = await response.json();
            finalScoresMap.set(player.player_id, {
                raw_score: parseFloat(data?.stats?.karmaDelta || 0),
                global_rank: parseInt(data?.stats?.karmaDayRank || -1, 10)
            });
        } catch (e) {
            console.error(`Failed to fetch final karma for ${player.player_id}, using 0.`);
            finalScoresMap.set(player.player_id, { raw_score: 0, global_rank: 0 });
        }
    }

    const gameRef = db.doc(`${getCollectionName('seasons')}/${seasonId}/${getCollectionName(collectionName)}/${gameId}`);
    const gameSnap = await gameRef.get();
    const gameData = gameSnap.data();
    let team1FinalScore = 0;
    let team2FinalScore = 0;

    const lineupsCollectionName = collectionName.replace('games', 'lineups');
    const lineupsCollectionRef = db.collection(getCollectionName('seasons')).doc(seasonId).collection(getCollectionName(lineupsCollectionName));

    for (const player of allPlayersInGame) {
        const finalScores = finalScoresMap.get(player.player_id);
        const raw_score = finalScores.raw_score;
        const adjustments = player.deductions || 0;
        const points_adjusted = raw_score - adjustments;
        let final_score = points_adjusted;
        if (player.is_captain) {
            final_score *= 1.5;
        }

        if (team1_lineup.some(p => p.player_id === player.player_id)) {
            team1FinalScore += final_score;
        } else {
            team2FinalScore += final_score;
        }

        const playerInfo = allPlayersMap.get(player.player_id);
        const lineupId = `${gameId}-${player.player_id}`;
        const lineupDocRef = lineupsCollectionRef.doc(lineupId);

        const lineupData = {
            player_id: player.player_id,
            player_handle: playerInfo?.player_handle || 'Unknown',
            team_id: gameData.team1_id,
            game_id: gameId,
            date: gameData.date,
            game_type: collectionName === 'post_games' ? 'postseason' : (collectionName === 'exhibition_games' ? 'exhibition' : 'regular'),
            started: 'TRUE',
            is_captain: player.is_captain ? 'TRUE' : 'FALSE',
            raw_score,
            adjustments,
            points_adjusted,
            final_score,
            global_rank: finalScores.global_rank
        };

        if (team1_lineup.some(p => p.player_id === player.player_id)) {
            lineupData.team_id = gameData.team1_id;
        } else {
            lineupData.team_id = gameData.team2_id;
        }

        batch.set(lineupDocRef, lineupData, { merge: true });
    }

    batch.update(gameRef, {
        team1_score: team1FinalScore,
        team2_score: team2FinalScore,
        completed: 'TRUE',
        winner: team1FinalScore > team2FinalScore ? gameData.team1_id : (team2FinalScore > team1FinalScore ? gameData.team2_id : '')
    });

    batch.delete(liveGameSnap.ref);

    await batch.commit();
}

exports.scheduledLiveScoringShutdown = onSchedule({
    schedule: "30 3 * * *", // Runs at 3:30 AM daily
    timeZone: "America/Chicago",
}, async (event) => {
    console.log("Running scheduled job to set live scoring status to 'stopped'.");

    try {
        const statusRef = db.doc(`${getCollectionName('live_scoring_status')}/status`);
        
        // Update the status to 'stopped'
        await statusRef.set({
            status: 'stopped',
            last_updated_by: 'automated_shutdown',
            last_updated: FieldValue.serverTimestamp()
        }, { merge: true }); // Use merge: true to avoid overwriting other fields

        console.log("Successfully set live scoring status to 'stopped'.");

    } catch (error) {
        console.error("Error during scheduled shutdown of live scoring:", error);
    }
    
    return null;
});

async function createSeasonStructure(seasonNum, batch, activeSeasonId) {
    const seasonId = `S${seasonNum}`;
    console.log(`Creating structure for season ${seasonId}`);

    batch.set(db.doc(`${getCollectionName('daily_averages')}/season_${seasonNum}`), { description: `Daily averages for Season ${seasonNum}` });
    batch.set(db.doc(`${getCollectionName('daily_averages')}/season_${seasonNum}/${getCollectionName(`S${seasonNum}_daily_averages`)}/placeholder`), {});
    batch.set(db.doc(`${getCollectionName('daily_scores')}/season_${seasonNum}`), { description: `Daily scores for Season ${seasonNum}` });
    batch.set(db.doc(`${getCollectionName('daily_scores')}/season_${seasonNum}/${getCollectionName(`S${seasonNum}_daily_scores`)}/placeholder`), {});

    batch.set(db.doc(`${getCollectionName('post_daily_averages')}/season_${seasonNum}`), { description: `Postseason daily averages for Season ${seasonNum}` });
    batch.set(db.doc(`${getCollectionName('post_daily_averages')}/season_${seasonNum}/${getCollectionName(`S${seasonNum}_post_daily_averages`)}/placeholder`), {});
    batch.set(db.doc(`${getCollectionName('post_daily_scores')}/season_${seasonNum}`), { description: `Postseason daily scores for Season ${seasonNum}` });
    batch.set(db.doc(`${getCollectionName('post_daily_scores')}/season_${seasonNum}/${getCollectionName(`S${seasonNum}_post_daily_scores`)}/placeholder`), {});


    const seasonRef = db.collection(getCollectionName("seasons")).doc(seasonId);
    batch.set(seasonRef.collection(getCollectionName("games")).doc("placeholder"), {});
    batch.set(seasonRef.collection(getCollectionName("lineups")).doc("placeholder"), {});
    batch.set(seasonRef.collection(getCollectionName("post_games")).doc("placeholder"), {});
    batch.set(seasonRef.collection(getCollectionName("post_lineups")).doc("placeholder"), {});
    batch.set(seasonRef.collection(getCollectionName("exhibition_games")).doc("placeholder"), {});
    batch.set(seasonRef.collection(getCollectionName("exhibition_lineups")).doc("placeholder"), {});

    const playersSnap = await db.collection(getCollectionName("v2_players")).get();
    playersSnap.forEach(playerDoc => {
        const statsRef = playerDoc.ref.collection(getCollectionName("seasonal_stats")).doc(seasonId);
        batch.set(statsRef, {
            aag_mean: 0, aag_mean_pct: 0, aag_median: 0, aag_median_pct: 0, games_played: 0, GEM: 0, meansum: 0, medrank: 0, meanrank: 0, medsum: 0,
            post_aag_mean: 0, post_aag_mean_pct: 0, post_aag_median: 0, post_aag_median_pct: 0, post_games_played: 0, post_GEM: 0, post_meansum: 0,
            post_medrank: 0, post_meanrank: 0, post_medsum: 0, post_rel_mean: 0, post_rel_median: 0, post_total_points: 0, post_WAR: 0, rel_mean: 0, rel_median: 0,
            WAR: 0, total_points: 0, t100: 0, t100_pct: 0, post_t100: 0, post_t100_pct: 0, t50: 0, t50_pct: 0, post_t50: 0, post_t50_pct: 0, rookie: '0', all_star: '0'
        });
    });
    console.log(`Prepared empty seasonal_stats for ${playersSnap.size} players.`);

    const teamsSnap = await db.collection(getCollectionName("v2_teams")).get();
    for (const teamDoc of teamsSnap.docs) {
        const recordRef = teamDoc.ref.collection(getCollectionName("seasonal_records")).doc(seasonId);

        const activeRecordRef = teamDoc.ref.collection(getCollectionName("seasonal_records")).doc(activeSeasonId);
        const activeRecordSnap = await activeRecordRef.get();
        const teamName = activeRecordSnap.exists ? activeRecordSnap.data().team_name : "Name Not Found";

        batch.set(recordRef, {
            apPAM: 0, apPAM_count: 0, apPAM_total: 0, elim: 0, losses: 0, MaxPotWins: 0, med_starter_rank: 0, msr_rank: 0, pam: 0, pam_rank: 0, playin: 0,
            playoffs: 0, post_losses: 0, post_med_starter_rank: 0, post_msr_rank: 0, post_pam: 0, post_pam_rank: 0, post_wins: 0, postseed: 0, sortscore: 0,
            wins: 0, wpct: 0, total_transactions: 0, team_name: teamName
        });
    }
    console.log(`Prepared empty seasonal_records for ${teamsSnap.size} teams.`);

    return seasonRef;
}

exports.createNewSeason = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth || !request.auth.uid) {
        throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }

    try {
        const activeSeasonQuery = db.collection(getCollectionName('seasons')).where('status', '==', 'active').limit(1);
        const activeSeasonSnap = await activeSeasonQuery.get();

        if (activeSeasonSnap.empty) {
            throw new HttpsError('failed-precondition', 'No active season found. Cannot advance to the next season.');
        }

        const activeSeasonDoc = activeSeasonSnap.docs[0];
        const activeSeasonId = activeSeasonDoc.id;
        const activeSeasonNum = parseInt(activeSeasonId.replace('S', ''), 10);

        const newSeasonNumber = activeSeasonNum + 1;
        const futureDraftSeasonNumber = newSeasonNumber + 5;

        console.log(`Advancing from active season ${activeSeasonId} to new season S${newSeasonNumber}.`);

        const batch = db.batch();

        const newSeasonRef = await createSeasonStructure(newSeasonNumber, batch, activeSeasonId);

        batch.set(newSeasonRef, {
            season_name: `Season ${newSeasonNumber}`,
            status: "active",
            gp: 0,
            gs: 0,
            season_trans: 0,
            season_karma: 0
        }, { merge: true });

        const oldSeasonRef = db.doc(`${getCollectionName('seasons')}/${activeSeasonId}`);
        batch.update(oldSeasonRef, { status: "completed" });


        const oldPicksQuery = db.collection(getCollectionName("draftPicks")).where("season", "==", String(newSeasonNumber));
        const oldPicksSnap = await oldPicksQuery.get();
        console.log(`Deleting ${oldPicksSnap.size} draft picks for season ${newSeasonNumber}.`);
        oldPicksSnap.forEach(doc => batch.delete(doc.ref));

        const teamsSnap = await db.collection(getCollectionName("v2_teams")).where("conference", "in", ["Eastern", "Western"]).get();
        const activeTeams = teamsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        console.log(`Creating future draft picks for S${futureDraftSeasonNumber} for ${activeTeams.length} teams.`);
        for (const team of activeTeams) {
            for (let round = 1; round <= 3; round++) {
                const pickId = `S${futureDraftSeasonNumber}_${team.id}_${round}`;
                const pickRef = db.collection(getCollectionName("draftPicks")).doc(pickId);
                const pickData = {
                    pick_id: pickId,
                    pick_description: `S${futureDraftSeasonNumber} ${team.id} ${round}${round === 1 ? 'st' : round === 2 ? 'nd' : 'rd'}`,
                    season: futureDraftSeasonNumber,
                    round: round,
                    original_team: team.id,
                    current_owner: team.id,
                    acquired_week: null,
                    base_owner: null,
                    notes: null,
                    trade_id: null
                };
                batch.set(pickRef, pickData);
            }
        }

        await batch.commit();
        return { success: true, message: `Successfully advanced from ${activeSeasonId} to Season ${newSeasonNumber} and generated draft picks for Season ${futureDraftSeasonNumber}.` };
    } catch (error) {
        console.error("Error creating new season:", error);
        throw new HttpsError('internal', `Failed to create new season: ${error.message}`);
    }
});


exports.createHistoricalSeason = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth || !request.auth.uid) {
        throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const { seasonNumber } = request.data;
    if (!seasonNumber) {
        throw new functions.https.HttpsError('invalid-argument', 'A seasonNumber must be provided.');
    }

    const activeSeasonQuery = db.collection(getCollectionName('seasons')).where('status', '==', 'active').limit(1);
    const activeSeasonSnap = await activeSeasonQuery.get();

    if (activeSeasonSnap.empty) {
        throw new HttpsError('failed-precondition', 'Could not determine the current active season. Aborting.');
    }

    const activeSeasonId = activeSeasonSnap.docs[0].id;
    const activeSeasonNum = parseInt(activeSeasonId.replace('S', ''), 10);

    if (seasonNumber >= activeSeasonNum) {
        throw new functions.https.HttpsError('failed-precondition', `Historical season (${seasonNumber}) must be less than the current active season (S${activeSeasonNum}).`);
    }

    const seasonDoc = await db.doc(`${getCollectionName('seasons')}/S${seasonNumber}`).get();
    if (seasonDoc.exists) {
        throw new functions.https.HttpsError('already-exists', `Season S${seasonNumber} already exists in the database.`);
    }

    try {
        const batch = db.batch();

        const historicalSeasonRef = await createSeasonStructure(seasonNumber, batch, activeSeasonId);

        batch.set(historicalSeasonRef, {
            season_name: `Season ${seasonNumber}`,
            status: "completed",
            gp: 0,
            gs: 0,
            season_trans: 0,
            season_karma: 0
        }, { merge: true });

        await batch.commit();
        return { success: true, message: `Successfully created historical data structure for Season ${seasonNumber}.` };
    } catch (error) {
        console.error("Error creating historical season:", error);
        throw new functions.https.HttpsError('internal', `Failed to create historical season: ${error.message}`);
    }
});


exports.updateGamesScheduledCount = onDocumentWritten(`${getCollectionName('seasons')}/{seasonId}/${getCollectionName('games')}/{gameId}`, (event) => {
    const { seasonId, gameId } = event.params;
    if (gameId === 'placeholder') {
        return null;
    }

    const seasonRef = db.collection(getCollectionName('seasons')).doc(seasonId);
    const beforeExists = event.data.before.exists;
    const afterExists = event.data.after.exists;

    if (!beforeExists && afterExists) {
        console.log(`Incrementing games scheduled for ${seasonId}.`);
        return seasonRef.update({ gs: FieldValue.increment(1) });
    } else if (beforeExists && !afterExists) {
        console.log(`Decrementing games scheduled for ${seasonId}.`);
        return seasonRef.update({ gs: FieldValue.increment(-1) });
    }

    return null;
});


exports.processCompletedExhibitionGame = onDocumentUpdated(`${getCollectionName('seasons')}/{seasonId}/${getCollectionName('exhibition_games')}/{gameId}`, async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    const { seasonId, gameId } = event.params;

    if (after.completed !== 'TRUE' || before.completed === 'TRUE') {
        return null;
    }

    console.log(`Logging completion of EXHIBITION game ${gameId} in season ${seasonId}. No stat aggregation will occur.`);

    return null;
});

exports.generatePostseasonSchedule = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth || !request.auth.uid) {
        throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const { seasonId, dates } = request.data;
    if (!seasonId || !dates) {
        throw new functions.https.HttpsError('invalid-argument', 'Missing seasonId or dates.');
    }

    console.log(`Generating postseason schedule for ${seasonId}`);

    try {
        const teamsRef = db.collection(getCollectionName('v2_teams'));
        const teamsSnap = await teamsRef.get();
        const allTeams = teamsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        const teamRecords = await Promise.all(allTeams.map(async (team) => {
            const recordRef = db.doc(`${getCollectionName('v2_teams')}/${team.id}/${getCollectionName('seasonal_records')}/${seasonId}`);
            const recordSnap = await recordRef.get();
            return { ...team, ...recordSnap.data() };
        }));

        const eastConf = teamRecords.filter(t => t.conference === 'Eastern' && t.postseed).sort((a, b) => a.postseed - b.postseed);
        const westConf = teamRecords.filter(t => t.conference === 'Western' && t.postseed).sort((a, b) => a.postseed - b.postseed);

        if (eastConf.length < 10 || westConf.length < 10) {
            throw new functions.https.HttpsError('failed-precondition', 'Not all teams have a final postseed. Ensure the regular season is complete.');
        }

        const batch = db.batch();
        const postGamesRef = db.collection(`${getCollectionName('seasons')}/${seasonId}/${getCollectionName('post_games')}`);

        const existingGamesSnap = await postGamesRef.get();
        existingGamesSnap.forEach(doc => batch.delete(doc.ref));
        console.log(`Cleared ${existingGamesSnap.size} existing postseason games.`);

        const TBD_TEAM = { id: 'TBD', team_name: 'TBD' };
        const dateValidators = {
            'Play-In': 2, 'Round 1': 3, 'Round 2': 3, 'Conf Finals': 5, 'Finals': 7
        };

        const createSeries = (week, seriesName, numGames, team1, team2, dateArray) => {
            if (!dateArray || dateArray.length < numGames) {
                throw new Error(`Not enough dates provided for ${week} (${seriesName}). Expected ${numGames}, got ${dateArray?.length || 0}.`);
            }
            for (let i = 0; i < numGames; i++) {
                const gameDate = dateArray[i];
                const gameData = {
                    week, series_name: `${seriesName} Game ${i + 1}`, date: gameDate,
                    team1_id: team1.id, team2_id: team2.id,
                    completed: 'FALSE', team1_score: 0, team2_score: 0, winner: ''
                };

                const formattedDateForId = gameDate.replace(/\//g, "-");
                const docRef = (team1.id === 'TBD' || team2.id === 'TBD')
                    ? postGamesRef.doc()
                    : postGamesRef.doc(`${formattedDateForId}-${team1.id}-${team2.id}`);
                batch.set(docRef, gameData);
            }
        };

        console.log("Generating Play-In games...");
        if (dates['Play-In'].length < dateValidators['Play-In']) throw new Error("Not enough dates for Play-In tournament.");

        createSeries('Play-In', 'E7vE8', 1, eastConf[6], eastConf[7], [dates['Play-In'][0]]);
        createSeries('Play-In', 'W7vW8', 1, westConf[6], westConf[7], [dates['Play-In'][0]]);
        createSeries('Play-In', 'E9vE10', 1, eastConf[8], eastConf[9], [dates['Play-In'][0]]);
        createSeries('Play-In', 'W9vW10', 1, westConf[8], westConf[9], [dates['Play-In'][0]]);
        createSeries('Play-In', 'E8thSeedGame', 1, TBD_TEAM, TBD_TEAM, [dates['Play-In'][1]]);
        createSeries('Play-In', 'W8thSeedGame', 1, TBD_TEAM, TBD_TEAM, [dates['Play-In'][1]]);

        console.log("Generating Round 1 schedule...");
        createSeries('Round 1', 'E1vE8', 3, eastConf[0], TBD_TEAM, dates['Round 1']);
        createSeries('Round 1', 'E4vE5', 3, eastConf[3], eastConf[4], dates['Round 1']);
        createSeries('Round 1', 'E3vE6', 3, eastConf[2], eastConf[5], dates['Round 1']);
        createSeries('Round 1', 'E2vE7', 3, eastConf[1], TBD_TEAM, dates['Round 1']);
        createSeries('Round 1', 'W1vW8', 3, westConf[0], TBD_TEAM, dates['Round 1']);
        createSeries('Round 1', 'W4vW5', 3, westConf[3], westConf[4], dates['Round 1']);
        createSeries('Round 1', 'W3vW6', 3, westConf[2], westConf[5], dates['Round 1']);
        createSeries('Round 1', 'W2vE7', 3, westConf[1], TBD_TEAM, dates['Round 1']);

        console.log("Generating Round 2 schedule...");
        createSeries('Round 2', 'E-Semi1', 3, TBD_TEAM, TBD_TEAM, dates['Round 2']);
        createSeries('Round 2', 'E-Semi2', 3, TBD_TEAM, TBD_TEAM, dates['Round 2']);
        createSeries('Round 2', 'W-Semi1', 3, TBD_TEAM, TBD_TEAM, dates['Round 2']);
        createSeries('Round 2', 'W-Semi2', 3, TBD_TEAM, TBD_TEAM, dates['Round 2']);

        console.log("Generating Conference Finals schedule...");
        createSeries('Conf Finals', 'ECF', 5, TBD_TEAM, TBD_TEAM, dates['Conf Finals']);
        createSeries('Conf Finals', 'WCF', 5, TBD_TEAM, TBD_TEAM, dates['Conf Finals']);

        console.log("Generating Finals schedule...");
        createSeries('Finals', 'Finals', 7, TBD_TEAM, TBD_TEAM, dates['Finals']);

        await batch.commit();
        return { message: "Postseason schedule generated successfully!" };

    } catch (error) {
        console.error("Error generating postseason schedule:", error);
        throw new functions.https.HttpsError('internal', `Failed to generate schedule: ${error.message}`);
    }
});


exports.calculatePerformanceAwards = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth || !request.auth.uid) {
        throw new functions.https.HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const { seasonId } = request.data;
    if (!seasonId) {
        throw new functions.https.HttpsError('invalid-argument', 'The function must be called with a "seasonId" argument.');
    }

    console.log(`Calculating performance awards for season: ${seasonId}`);
    const seasonNumber = seasonId.replace('S', '');

    try {
        const batch = db.batch();
        const awardsCollectionRef = db.collection(`${getCollectionName('awards')}/season_${seasonNumber}/${getCollectionName(`S${seasonNumber}_awards`)}`);

        const lineupsRef = db.collection(`${getCollectionName('seasons')}/${seasonId}/${getCollectionName('lineups')}`);
        const bestPlayerQuery = lineupsRef.orderBy('pct_above_median', 'desc').limit(1);
        const bestPlayerSnap = await bestPlayerQuery.get();

        if (!bestPlayerSnap.empty) {
            const bestPlayerPerf = bestPlayerSnap.docs[0].data();
            const awardData = {
                award_name: "Best Performance (Player)",
                player_id: bestPlayerPerf.player_id,
                player_handle: bestPlayerPerf.player_handle,
                team_id: bestPlayerPerf.team_id,
                date: bestPlayerPerf.date,
                value: bestPlayerPerf.pct_above_median
            };
            batch.set(awardsCollectionRef.doc('best_performance_player'), awardData);
        }

        const dailyScoresRef = db.collection(`${getCollectionName('daily_scores')}/season_${seasonNumber}/${getCollectionName(`S${seasonNumber}_daily_scores`)}`);
        const bestTeamQuery = dailyScoresRef.orderBy('pct_above_median', 'desc').limit(1);
        const bestTeamSnap = await bestTeamQuery.get();

        if (!bestTeamSnap.empty) {
            const bestTeamPerf = bestTeamSnap.docs[0].data();
            const teamRecordRef = db.doc(`${getCollectionName('v2_teams')}/${bestTeamPerf.team_id}/${getCollectionName('seasonal_records')}/${seasonId}`);
            const teamRecordSnap = await teamRecordRef.get();
            const awardData = {
                award_name: "Best Performance (Team)",
                team_id: bestTeamPerf.team_id,
                team_name: teamRecordSnap.exists ? teamRecordSnap.data().team_name : 'Unknown',
                date: bestTeamPerf.date,
                value: bestTeamPerf.pct_above_median
            };
            batch.set(awardsCollectionRef.doc('best_performance_team'), awardData);
        }

        await batch.commit();
        console.log("Successfully calculated and saved performance awards.");
        return { message: "Performance awards calculated and saved successfully!" };

    } catch (error) {
        console.error("Error calculating performance awards:", error);
        throw new HttpsError('internal', 'Failed to calculate performance awards.');
    }
});

exports.onDraftResultCreate = onDocumentCreated(`${getCollectionName('draft_results')}/{seasonDocId}/{resultsCollectionId}/{draftPickId}`, async (event) => {
    const { seasonDocId, resultsCollectionId } = event.params;
    const pickData = event.data.data();
    const { team_id, player_handle, forfeit, season: draftSeason, round, overall } = pickData;

    const API_ENDPOINT_TEMPLATE = process.env.REAL_API_ENDPOINT;

    if (!API_ENDPOINT_TEMPLATE) {
        console.error("FATAL ERROR: REAL_API_ENDPOINT environment variable not set. Aborting function.");
        return null;
    }

    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const seasonMatch = seasonDocId.match(/^season_(\d+)$/);
    const collectionMatch = resultsCollectionId.match(/^S(\d+)_draft_results_dev$/) || resultsCollectionId.match(/^S(\d+)_draft_results$/);
    if (!seasonMatch || !collectionMatch || seasonMatch[1] !== collectionMatch[1]) {
        console.log(`Function triggered on a non-draft path, exiting. Path: ${seasonDocId}/${resultsCollectionId}`);
        return null;
    }

    if (forfeit || !player_handle) {
        console.log(`Pick ${overall} was forfeited or had no player. No action taken.`);
        return null;
    }

    console.log(`Processing draft pick ${overall}: ${player_handle} to team ${team_id} in ${draftSeason} draft.`);

    try {
        const batch = db.batch();
        const activeSeasonQuery = db.collection(getCollectionName("seasons")).where("status", "==", "active").limit(1);
        const [activeSeasonSnap, teamRecordSnap] = await Promise.all([
            activeSeasonQuery.get(),
            db.doc(`${getCollectionName('v2_teams')}/${team_id}/${getCollectionName('seasonal_records')}/${draftSeason}`).get()
        ]);
        const activeSeasonId = activeSeasonSnap.empty ? null : activeSeasonSnap.docs[0].id;
        const teamName = teamRecordSnap.exists ? teamRecordSnap.data().team_name : team_id;

        const getOrdinal = (n) => {
            if (n > 3 && n < 21) return n + 'th';
            switch (n % 10) {
                case 1: return n + "st";
                case 2: return n + "nd";
                case 3: return n + "rd";
                default: return n + "th";
            }
        };
        const bio = `R${round} (${getOrdinal(overall)} overall) selection by ${teamName} in ${draftSeason} draft.`;
        const isCurrentDraft = draftSeason === activeSeasonId;

        const initialStats = {
            aag_mean: 0, aag_mean_pct: 0, aag_median: 0, aag_median_pct: 0, games_played: 0, GEM: 0, meansum: 0, medrank: 0, meanrank: 0, medsum: 0,
            post_aag_mean: 0, post_aag_mean_pct: 0, post_aag_median: 0, post_aag_median_pct: 0, post_games_played: 0, post_GEM: 0, post_meansum: 0,
            post_medrank: 0, post_meanrank: 0, post_medsum: 0, post_rel_mean: 0, post_rel_median: 0, post_total_points: 0, post_WAR: 0, rel_mean: 0, rel_median: 0,
            WAR: 0, t100: 0, t100_pct: 0, post_t100: 0, post_t100_pct: 0, t50: 0, t50_pct: 0, post_t50: 0, post_t50_pct: 0, total_points: 0, all_star: '0'
        };

        if (isCurrentDraft) {
            const randomDelay = Math.floor(Math.random() * 201) + 100;
            await delay(randomDelay);

            console.log(`Current draft (${draftSeason}). Fetching player ID for: ${player_handle}.`);
            let newPlayerId;

            try {
                const apiUrl = API_ENDPOINT_TEMPLATE.replace('{}', encodeURIComponent(player_handle));
                const response = await fetch(apiUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                        'Accept': 'application/json, text/plain, */*'
                    }
                });

                if (response.ok) {
                    const data = await response.json();
                    const userId = data?.user?.id;
                    if (userId) {
                        newPlayerId = userId;
                        console.log(`Successfully fetched ID for ${player_handle}: ${newPlayerId}`);
                    }
                } else {
                    console.warn(`API request failed for ${player_handle} with status: ${response.status}.`);
                }
            } catch (error) {
                console.error(`Error fetching user ID for ${player_handle}:`, error);
            }

            if (!newPlayerId) {
                const sanitizedHandle = player_handle.toLowerCase().replace(/[^a-z0-9]/g, '');
                newPlayerId = `${sanitizedHandle}${draftSeason.replace('S', '')}${overall}`;
                console.warn(`Using fallback generated ID for ${player_handle}: ${newPlayerId}`);
            }

            const playerRef = db.collection(getCollectionName('v2_players')).doc(newPlayerId);
            const existingPlayerSnap = await playerRef.get();

            if (existingPlayerSnap.exists) {
                console.error(`Error: A player with the fetched/generated ID '${newPlayerId}' already exists. Aborting creation for this pick.`);
                return null;
            }

            batch.set(playerRef, {
                player_handle: player_handle,
                current_team_id: team_id,
                player_status: 'ACTIVE',
                bio: bio
            });

            const seasonStatsRef = playerRef.collection(getCollectionName('seasonal_stats')).doc(draftSeason);
            batch.set(seasonStatsRef, { ...initialStats, rookie: '1' });

        } else {
            console.log(`Historical draft (${draftSeason}). Checking for existing player: ${player_handle}.`);
            const existingPlayerQuery = db.collection(getCollectionName('v2_players')).where('player_handle', '==', player_handle).limit(1);
            const existingPlayerSnap = await existingPlayerQuery.get();

            if (existingPlayerSnap.empty) {
                console.log(`Player not found. Creating new player for historical draft.`);
                const sanitizedHandle = player_handle.toLowerCase().replace(/[^a-z0-9]/g, '');
                const newPlayerId = `${sanitizedHandle}${draftSeason.replace('S', '')}${overall}`;
                const playerRef = db.collection(getCollectionName('v2_players')).doc(newPlayerId);

                batch.set(playerRef, {
                    player_handle: player_handle,
                    current_team_id: team_id,
                    player_status: 'ACTIVE',
                    bio: bio
                });

                const seasonStatsRef = playerRef.collection(getCollectionName('seasonal_stats')).doc(draftSeason);
                batch.set(seasonStatsRef, { ...initialStats, rookie: '1' });
            } else {
                console.log(`Existing player found. Updating bio only.`);
                const playerRef = existingPlayerSnap.docs[0].ref;
                batch.update(playerRef, { bio: bio });
                const seasonStatsRef = playerRef.collection(getCollectionName('seasonal_stats')).doc(draftSeason);
                batch.set(seasonStatsRef, { ...initialStats, rookie: '0' });
            }
        }

        await batch.commit();
        console.log(`Successfully processed draft pick for ${player_handle}.`);

    } catch (error) {
        console.error(`Error processing draft pick for ${player_handle}:`, error);
    }
    return null;
});



exports.onTransactionCreate_V2 = onDocumentCreated(`${getCollectionName('transactions')}/{transactionId}`, async (event) => {
    const transaction = event.data.data();
    if (transaction.schema !== 'v2') {
        console.log(`V2: Ignoring transaction ${event.params.transactionId} without v2 schema.`);
        return null;
    }
    const transactionId = event.params.transactionId;
    console.log(`V2: Processing transaction ${transactionId} for player/pick moves.`);

    const batch = db.batch();
    try {
        if (transaction.type === 'SIGN' || transaction.type === 'CUT') {
            const playerMove = transaction.involved_players[0];
            const playerRef = db.collection(getCollectionName('v2_players')).doc(playerMove.id);
            const newTeamId = (transaction.type === 'SIGN') ? playerMove.to : 'FREE_AGENT';
            batch.update(playerRef, { current_team_id: newTeamId });
        } else if (transaction.type === 'TRADE') {
            if (transaction.involved_players) {
                for (const playerMove of transaction.involved_players) {
                    const playerRef = db.collection(getCollectionName('v2_players')).doc(playerMove.id);
                    batch.update(playerRef, { current_team_id: playerMove.to });
                }
            }
            if (transaction.involved_picks) {
                for (const pickMove of transaction.involved_picks) {
                    const pickRef = db.collection(getCollectionName('draftPicks')).doc(pickMove.id);
                    batch.update(pickRef, { current_owner: pickMove.to });
                }
            }
        }
        await event.data.ref.update({ status: 'PROCESSED', processed_at: FieldValue.serverTimestamp() });
        await batch.commit();
        console.log(`V2 Transaction ${transactionId} processed successfully for player/pick moves.`);
    } catch (error) {
        console.error(`Error processing V2 transaction ${transactionId} for player/pick moves:`, error);
        await event.data.ref.update({ status: 'FAILED', error: error.message });
    }
    return null;
});


exports.onTransactionUpdate_V2 = onDocumentCreated(`${getCollectionName('transactions')}/{transactionId}`, async (event) => {
    const transaction = event.data.data();
    if (transaction.schema !== 'v2') {
        console.log(`V2: Ignoring transaction count update for ${event.params.transactionId} without v2 schema.`);
        return null;
    }

    const activeSeasonQuery = db.collection(getCollectionName("seasons")).where("status", "==", "active").limit(1);
    const activeSeasonSnap = await activeSeasonQuery.get();

    if (activeSeasonSnap.empty) {
        console.error("Could not find an active season. Cannot update transaction counts.");
        return null;
    }
    const seasonId = activeSeasonSnap.docs[0].id;

    console.log(`V2: Updating transaction counts for transaction ${event.params.transactionId} in season ${seasonId}`);

    const involvedTeams = new Set(transaction.involved_teams || []);
    if (involvedTeams.size === 0) return null;

    const batch = db.batch();
    const seasonRef = db.collection(getCollectionName('seasons')).doc(seasonId);

    for (const teamId of involvedTeams) {
        const teamStatsRef = db.collection(getCollectionName('v2_teams')).doc(teamId).collection(getCollectionName('seasonal_records')).doc(seasonId);
        batch.update(teamStatsRef, { total_transactions: FieldValue.increment(1) });
    }

    batch.update(seasonRef, { season_trans: FieldValue.increment(involvedTeams.size) });

    await batch.commit();
    console.log(`Successfully updated transaction counts for teams: ${[...involvedTeams].join(', ')}`);
});


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


// ===================================================================
// STAT CALCULATION REFACTOR
// ===================================================================

async function updatePlayerSeasonalStats(playerId, seasonId, isPostseason, batch, dailyAveragesMap, newPlayerLineups) {
    const lineupsCollectionName = isPostseason ? 'post_lineups' : 'lineups';
    const gameDate = newPlayerLineups[0].date;

    const playerLineupsQuery = db.collection(getCollectionName('seasons')).doc(seasonId).collection(getCollectionName(lineupsCollectionName))
        .where('player_id', '==', playerId)
        .where('started', '==', 'TRUE')
        .where('date', '!=', gameDate);

    const previousLineupsSnap = await playerLineupsQuery.get();
    const previousLineups = previousLineupsSnap.docs.map(doc => doc.data());

    const allLineups = [...previousLineups, ...newPlayerLineups];

    if (allLineups.length === 0) {
        console.log(`No lineups found for player ${playerId} in ${seasonId} (${getCollectionName(lineupsCollectionName)}). Skipping stats update.`);
        return null;
    }

    const games_played = allLineups.length;
    const total_points = allLineups.reduce((sum, l) => sum + (l.points_adjusted || 0), 0);
    const WAR = allLineups.reduce((sum, l) => sum + (l.SingleGameWar || 0), 0);
    const aag_mean = allLineups.reduce((sum, l) => sum + (l.AboveAvg || 0), 0);
    const aag_median = allLineups.reduce((sum, l) => sum + (l.AboveMed || 0), 0);

    const globalRanks = allLineups.map(l => l.global_rank || 0).filter(r => r > 0);
    const medrank = calculateMedian(globalRanks);
    const meanrank = calculateMean(globalRanks);
    const GEM = calculateGeometricMean(globalRanks);
    const t100 = allLineups.filter(l => l.global_rank > 0 && l.global_rank <= 100).length;
    const t50 = allLineups.filter(l => l.global_rank > 0 && l.global_rank <= 50).length;
    let meansum = 0;
    let medsum = 0;
    const uniqueDates = [...new Set(allLineups.map(l => l.date))];

    for (const date of uniqueDates) {
        const dailyAvgData = dailyAveragesMap.get(date);
        if (dailyAvgData) {
            meansum += dailyAvgData.mean_score || 0;
            medsum += dailyAvgData.median_score || 0;
        }
    }

    const statsUpdate = {};
    const prefix = isPostseason ? 'post_' : '';
    statsUpdate[`${prefix}games_played`] = games_played;
    statsUpdate[`${prefix}total_points`] = total_points;
    statsUpdate[`${prefix}medrank`] = medrank;
    statsUpdate[`${prefix}meanrank`] = meanrank;
    statsUpdate[`${prefix}aag_mean`] = aag_mean;
    statsUpdate[`${prefix}aag_mean_pct`] = games_played > 0 ? aag_mean / games_played : 0;
    statsUpdate[`${prefix}meansum`] = meansum;
    statsUpdate[`${prefix}rel_mean`] = meansum > 0 ? total_points / meansum : 0;
    statsUpdate[`${prefix}aag_median`] = aag_median;
    statsUpdate[`${prefix}aag_median_pct`] = games_played > 0 ? aag_median / games_played : 0;
    statsUpdate[`${prefix}medsum`] = medsum;
    statsUpdate[`${prefix}rel_median`] = medsum > 0 ? total_points / medsum : 0;
    statsUpdate[`${prefix}GEM`] = GEM;
    statsUpdate[`${prefix}WAR`] = WAR;
    statsUpdate[`${prefix}t100`] = t100;
    statsUpdate[`${prefix}t100_pct`] = games_played > 0 ? t100 / games_played : 0;
    statsUpdate[`${prefix}t50`] = t50;
    statsUpdate[`${prefix}t50_pct`] = games_played > 0 ? t50 / games_played : 0;
    const playerStatsRef = db.collection(getCollectionName('v2_players')).doc(playerId).collection(getCollectionName('seasonal_stats')).doc(seasonId);
    batch.set(playerStatsRef, statsUpdate, { merge: true });

    return statsUpdate;
}

async function updateAllTeamStats(seasonId, isPostseason, batch, newDailyScores) {
    const prefix = isPostseason ? 'post_' : '';
    const gamesCollection = isPostseason ? 'post_games' : 'games';
    const scoresCollection = isPostseason ? 'post_daily_scores' : 'daily_scores';
    const lineupsCollection = isPostseason ? 'post_lineups' : 'lineups';

    const [teamsSnap, gamesSnap, scoresSnap, lineupsSnap] = await Promise.all([
        db.collection(getCollectionName('v2_teams')).get(),
        db.collection(getCollectionName('seasons')).doc(seasonId).collection(getCollectionName(gamesCollection)).where('completed', '==', 'TRUE').get(),
        db.collection(getCollectionName(scoresCollection)).doc(`season_${seasonId.replace('S', '')}`).collection(getCollectionName(`S${seasonId.replace('S', '')}_${scoresCollection}`)).get(),
        db.collection(getCollectionName('seasons')).doc(seasonId).collection(getCollectionName(lineupsCollection)).where('started', '==', 'TRUE').get()
    ]);

    const allTeamData = teamsSnap.docs
        .filter(doc => doc.data().conference)
        .map(doc => ({ id: doc.id, ...doc.data() }));

    const teamStatsMap = new Map();
    allTeamData.forEach(t => teamStatsMap.set(t.id, {
        wins: 0, losses: 0, pam: 0, scores_count: 0, total_pct_above_median: 0, ranks: [], conference: t.conference
    }));

    gamesSnap.docs.forEach(doc => {
        const game = doc.data();
        if (teamStatsMap.has(game.winner)) {
            teamStatsMap.get(game.winner).wins++;
        }
        const loserId = game.team1_id === game.winner ? game.team2_id : game.team1_id;
        if (teamStatsMap.has(loserId)) {
            teamStatsMap.get(loserId).losses++;
        }
    });

    const historicalScores = scoresSnap.docs.map(doc => doc.data());
    const allScores = [...historicalScores, ...newDailyScores];

    allScores.forEach(score => {
        if (teamStatsMap.has(score.team_id)) {
            const teamData = teamStatsMap.get(score.team_id);
            teamData.pam += score.points_above_median || 0;
            teamData.total_pct_above_median += score.pct_above_median || 0;
            teamData.scores_count++;
        }
    });

    lineupsSnap.docs.forEach(doc => {
        const lineup = doc.data();
        if (teamStatsMap.has(lineup.team_id) && lineup.global_rank > 0) {
            teamStatsMap.get(lineup.team_id).ranks.push(lineup.global_rank);
        }
    });

    const calculatedStats = allTeamData.map(team => {
        const stats = teamStatsMap.get(team.id);
        const { wins, losses, pam, scores_count, total_pct_above_median, ranks, conference } = stats;

        const wpct = (wins + losses) > 0 ? wins / (wins + losses) : 0;
        const apPAM = scores_count > 0 ? total_pct_above_median / scores_count : 0;
        const med_starter_rank = calculateMedian(ranks);
        const MaxPotWins = 15 - losses;
        const sortscore = wpct + (pam * 0.00000001);

        return { teamId: team.id, conference, wins, losses, wpct, pam, apPAM, med_starter_rank, MaxPotWins, sortscore };
    });

    const rankAndSort = (teams, stat, ascending = true, rankKey) => {
        const sorted = [...teams].sort((a, b) => ascending ? a[stat] - b[stat] : b[stat] - a[stat]);
        sorted.forEach((team, i) => team[rankKey] = i + 1);
    };

    rankAndSort(calculatedStats, 'med_starter_rank', true, `${prefix}msr_rank`);
    rankAndSort(calculatedStats, 'pam', false, `${prefix}pam_rank`);

    if (!isPostseason) {
        const eastConf = calculatedStats.filter(t => t.conference === 'Eastern');
        const westConf = calculatedStats.filter(t => t.conference === 'Western');

        [eastConf, westConf].forEach(conf => {
            if (conf.length === 0) return;
            conf.sort((a, b) => b.sortscore - a.sortscore).forEach((t, i) => t.postseed = i + 1);

            const maxPotWinsSorted = [...conf].sort((a, b) => b.MaxPotWins - a.MaxPotWins);
            const winsSorted = [...conf].sort((a, b) => b.wins - a.wins);
            const playoffWinsThreshold = maxPotWinsSorted[6]?.MaxPotWins ?? 0;
            const playinWinsThreshold = maxPotWinsSorted[10]?.MaxPotWins ?? 0;
            const elimWinsThreshold = winsSorted[9]?.wins ?? 0;

            conf.forEach(t => {
                t.playoffs = t.wins > playoffWinsThreshold ? 1 : 0;
                t.playin = t.wins > playinWinsThreshold ? 1 : 0;
                t.elim = t.MaxPotWins < elimWinsThreshold ? 1 : 0;
            });
        });
    }

    for (const team of calculatedStats) {
        const { teamId, ...stats } = team;
        const finalUpdate = {
            [`${prefix}wins`]: stats.wins || 0,
            [`${prefix}losses`]: stats.losses || 0,
            [`${prefix}pam`]: stats.pam || 0,
            [`${prefix}med_starter_rank`]: stats.med_starter_rank || 0,
            [`${prefix}msr_rank`]: stats[`${prefix}msr_rank`] || 0,
            [`${prefix}pam_rank`]: stats[`${prefix}pam_rank`] || 0,
        };

        if (!isPostseason) {
            Object.assign(finalUpdate, {
                wpct: stats.wpct || 0,
                apPAM: stats.apPAM || 0,
                sortscore: stats.sortscore || 0,
                MaxPotWins: stats.MaxPotWins || 0,
                postseed: stats.postseed || null,
                playin: stats.playin || 0,
                playoffs: stats.playoffs || 0,
                elim: stats.elim || 0,
            });
        }

        const teamStatsRef = db.collection(getCollectionName('v2_teams')).doc(teamId).collection(getCollectionName('seasonal_records')).doc(seasonId);
        batch.set(teamStatsRef, finalUpdate, { merge: true });
    }
}


async function processCompletedGame(event) {
    const before = event.data.before.data();
    const after = event.data.after.data();
    const seasonId = event.params.seasonId;
    const gameId = event.params.gameId;

    if (after.completed !== 'TRUE' || before.completed === 'TRUE') {
        return null;
    }
    console.log(`V2: Processing completed game ${gameId} in season ${seasonId}`);

    const gameDate = after.date;

    // --- FIX #1: Robustly check for other incomplete games ---
    const regGamesQuery = db.collection(getCollectionName('seasons')).doc(seasonId).collection(getCollectionName('games')).where('date', '==', gameDate).get();
    const postGamesQuery = db.collection(getCollectionName('seasons')).doc(seasonId).collection(getCollectionName('post_games')).where('date', '==', gameDate).get();

    const [regGamesSnap, postGamesSnap] = await Promise.all([regGamesQuery, postGamesQuery]);
    
    // Combine results and store them in a variable for reuse
    const allGamesForDate = [...regGamesSnap.docs, ...postGamesSnap.docs];

    const incompleteGames = allGamesForDate.filter(doc => {
        return doc.id !== gameId && doc.data().completed !== 'TRUE';
    });
    
    if (incompleteGames.length > 0) {
        console.log(`Not all games for ${gameDate} are complete. Deferring calculations. Incomplete count: ${incompleteGames.length}`);
        return null;
    }
    
    console.log(`All games for ${gameDate} are complete. Proceeding with daily calculations.`);

    const batch = db.batch();
    const seasonRef = db.collection(getCollectionName('seasons')).doc(seasonId);
    const isPostseason = !/^\d+$/.test(after.week) && after.week !== "All-Star" && after.week !== "Relegation";
    const averagesColl = isPostseason ? 'post_daily_averages' : 'daily_averages';
    const scoresColl = isPostseason ? 'post_daily_scores' : 'daily_scores';
    const lineupsColl = isPostseason ? 'post_lineups' : 'lineups';

    if (!isPostseason) {
        const gamesCompletedToday = allGamesForDate.length;
        batch.update(seasonRef, { gp: FieldValue.increment(gamesCompletedToday) });
    }

    const lineupsSnap = await db.collection(getCollectionName('seasons')).doc(seasonId).collection(getCollectionName(lineupsColl)).where('date', '==', gameDate).where('started', '==', 'TRUE').get();
    if (lineupsSnap.empty) return null;

    const scores = lineupsSnap.docs.map(d => d.data().points_adjusted || 0);
    const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
    const median = calculateMedian(scores);
    const replacement = median * 0.9;
    const win = median * 0.92;

    const seasonNum = seasonId.replace('S', '');
    const [month, day, year] = gameDate.split('/');
    const yyyymmdd = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    const dailyAvgRef = db.doc(`${getCollectionName(averagesColl)}/season_${seasonNum}/${getCollectionName(`S${seasonNum}_${averagesColl}`)}/${yyyymmdd}`);
    const dailyAvgDataForMap = { date: gameDate, week: after.week, total_players: scores.length, mean_score: mean, median_score: median, replacement_level: replacement, win: win };
    batch.set(dailyAvgRef, dailyAvgDataForMap);

    const fullDailyAveragesMap = new Map();
    const averagesSnap = await db.collection(getCollectionName(averagesColl)).doc(`season_${seasonNum}`).collection(getCollectionName(`S${seasonNum}_${averagesColl}`)).get();
    averagesSnap.docs.forEach(doc => fullDailyAveragesMap.set(doc.data().date, doc.data()));
    fullDailyAveragesMap.set(gameDate, dailyAvgDataForMap);

    const enhancedLineups = [];
    const lineupsByPlayer = new Map();

    lineupsSnap.docs.forEach(doc => {
        const lineupData = doc.data();
        const points = lineupData.points_adjusted || 0;
        const aboveMean = points - mean;
        const aboveMedian = points - median;

        const enhancedData = {
            ...lineupData,
            above_mean: aboveMean,
            AboveAvg: aboveMean > 0 ? 1 : 0,
            pct_above_mean: mean ? aboveMean / mean : 0,
            above_median: aboveMedian,
            AboveMed: aboveMedian > 0 ? 1 : 0,
            pct_above_median: median ? aboveMedian / median : 0,
            SingleGameWar: win ? (points - replacement) / win : 0,
        };

        batch.update(doc.ref, {
            above_mean: enhancedData.above_mean,
            AboveAvg: enhancedData.AboveAvg,
            pct_above_mean: enhancedData.pct_above_mean,
            above_median: enhancedData.above_median,
            AboveMed: enhancedData.AboveMed,
            pct_above_median: enhancedData.pct_above_median,
            SingleGameWar: enhancedData.SingleGameWar,
        });

        enhancedLineups.push(enhancedData);
        if (!lineupsByPlayer.has(lineupData.player_id)) {
            lineupsByPlayer.set(lineupData.player_id, []);
        }
        lineupsByPlayer.get(lineupData.player_id).push(enhancedData);
    });

    // --- FIX #2: Remove re-declaration of variables. Use 'allGamesForDate' from above. ---
    const teamScores = allGamesForDate.flatMap(d => [d.data().team1_score, d.data().team2_score]);
    const teamMedian = calculateMedian(teamScores);

    const newDailyScores = [];
    allGamesForDate.forEach(doc => {
        const game = doc.data();
        const currentGameId = doc.id;
        [{ id: game.team1_id, score: game.team1_score }, { id: game.team2_id, score: game.team2_score }].forEach(team => {
            const scoreRef = db.doc(`${getCollectionName(scoresColl)}/season_${seasonNum}/${getCollectionName(`S${seasonNum}_${scoresColl}`)}/${team.id}-${currentGameId}`);
            const pam = team.score - teamMedian;
            const scoreData = {
                week: game.week, team_id: team.id, date: gameDate, score: team.score,
                daily_median: teamMedian, above_median: pam > 0 ? 1 : 0,
                points_above_median: pam, pct_above_median: teamMedian ? pam / teamMedian : 0
            };
            batch.set(scoreRef, scoreData, { merge: true });
            newDailyScores.push(scoreData);
        });
    });

    let totalKarmaChangeForGame = 0;

    for (const [pid, newPlayerLineups] of lineupsByPlayer.entries()) {
        const playerStatsRef = db.collection(getCollectionName('v2_players')).doc(pid).collection(getCollectionName('seasonal_stats')).doc(seasonId);

        const oldStatsSnap = await playerStatsRef.get();
        const oldStats = oldStatsSnap.exists ? oldStatsSnap.data() : {};

        const newStats = await updatePlayerSeasonalStats(pid, seasonId, isPostseason, batch, fullDailyAveragesMap, newPlayerLineups);

        if (newStats) {
            const oldPoints = (oldStats.total_points || 0) + (oldStats.post_total_points || 0);
            const newPoints = (newStats.total_points || 0) + (newStats.post_total_points || 0);
            const karmaChange = newPoints - oldPoints;
            totalKarmaChangeForGame += karmaChange;
        }
    }

    if (totalKarmaChangeForGame !== 0) {
        batch.update(seasonRef, { season_karma: FieldValue.increment(totalKarmaChangeForGame) });
    }

    await updateAllTeamStats(seasonId, isPostseason, batch, newDailyScores);

    await batch.commit();
    console.log(`Successfully saved all daily calculations and stats for ${gameDate}.`);
    return null;
}


exports.onRegularGameUpdate_V2 = onDocumentUpdated(`${getCollectionName('seasons')}/{seasonId}/${getCollectionName('games')}/{gameId}`, processCompletedGame);
exports.onPostGameUpdate_V2 = onDocumentUpdated(`${getCollectionName('seasons')}/{seasonId}/${getCollectionName('post_games')}/{gameId}`, processCompletedGame);

/**
 * Helper function to rank an array of players based on specified criteria.
 * @param {Array<Object>} players - The array of player stat objects.
 * @param {string} primaryStat - The main stat to sort by.
 * @param {string} tiebreakerStat - The secondary stat for tiebreaking.
 * @param {boolean} isAscending - True to sort ascending (lower is better), false for descending.
 * @param {number} gpMinimum - The minimum games played required to be ranked.
 * @param {boolean} excludeZeroes - NEW: If true, players with a value of 0 for the primaryStat will not be ranked.
 * @returns {Map<string, number>} A map of player IDs to their rank.
 */
function getRanks(players, primaryStat, tiebreakerStat = null, isAscending = false, gpMinimum = 0, excludeZeroes = false) {
    const rankedMap = new Map();

    // The primary filter is now a multi-stage process
    let eligiblePlayers = players.filter(p => {
        const gamesPlayedField = primaryStat.startsWith('post_') ? 'post_games_played' : 'games_played';
        return (p[gamesPlayedField] || 0) >= gpMinimum;
    });

    // NEW: Conditionally filter out players with a zero value for the stat being ranked.
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
            return bSecondary - aSecondary; // Tiebreakers are always descending
        }
        return 0;
    });

    eligiblePlayers.forEach((player, index) => {
        rankedMap.set(player.player_id, index + 1);
    });
    return rankedMap;
}


/**
 * Core logic to update player ranks for an entire season.
 */
async function performPlayerRankingUpdate() {
    console.log("Starting player ranking update...");
    const activeSeasonSnap = await db.collection(getCollectionName('seasons')).where('status', '==', 'active').limit(1).get();
    if (activeSeasonSnap.empty) {
        console.log("No active season found. Aborting player ranking update.");
        return;
    }

    const activeSeasonDoc = activeSeasonSnap.docs[0];
    const seasonId = activeSeasonDoc.id;
    const seasonGamesPlayed = activeSeasonDoc.data().gp || 0;
    const regSeasonGpMinimum = seasonGamesPlayed >= 60 ? 3 : 0;
    const postSeasonGpMinimum = 0; // No GP minimum for postseason

    const playersSnap = await db.collection(getCollectionName('v2_players')).get();
    const playerStatPromises = playersSnap.docs.map(playerDoc =>
        playerDoc.ref.collection(getCollectionName('seasonal_stats')).doc(seasonId).get()
    );
    const playerStatsDocs = await Promise.all(playerStatPromises);

    const allPlayerStats = playerStatsDocs
        .filter(doc => doc.exists)
        .map(doc => {
            const pathParts = doc.ref.path.split('/');
            return {
                player_id: pathParts[1],
                ...doc.data()
            };
        });

    // List of base stat names that should not rank zero values
    const statsToExcludeZeroes = new Set(['total_points', 'rel_mean', 'rel_median', 'GEM', 'WAR', 'medrank', 'meanrank']);

    const leaderboards = {
        // Regular Season Ranks
        total_points: getRanks(allPlayerStats, 'total_points', null, false, 0, statsToExcludeZeroes.has('total_points')),
        rel_mean: getRanks(allPlayerStats, 'rel_mean', null, false, regSeasonGpMinimum, statsToExcludeZeroes.has('rel_mean')),
        rel_median: getRanks(allPlayerStats, 'rel_median', null, false, regSeasonGpMinimum, statsToExcludeZeroes.has('rel_median')),
        GEM: getRanks(allPlayerStats, 'GEM', null, true, regSeasonGpMinimum, statsToExcludeZeroes.has('GEM')),
        WAR: getRanks(allPlayerStats, 'WAR', null, false, 0, statsToExcludeZeroes.has('WAR')),
        medrank: getRanks(allPlayerStats, 'medrank', null, true, regSeasonGpMinimum, statsToExcludeZeroes.has('medrank')),
        meanrank: getRanks(allPlayerStats, 'meanrank', null, true, regSeasonGpMinimum, statsToExcludeZeroes.has('meanrank')),
        aag_mean: getRanks(allPlayerStats, 'aag_mean', 'aag_mean_pct'),
        aag_median: getRanks(allPlayerStats, 'aag_median', 'aag_median_pct'),
        t100: getRanks(allPlayerStats, 't100', 't100_pct'),
        t50: getRanks(allPlayerStats, 't50', 't50_pct'),
        // Postseason Ranks
        post_total_points: getRanks(allPlayerStats, 'post_total_points', null, false, 0, statsToExcludeZeroes.has('total_points')),
        post_rel_mean: getRanks(allPlayerStats, 'post_rel_mean', null, false, postSeasonGpMinimum, statsToExcludeZeroes.has('rel_mean')),
        post_rel_median: getRanks(allPlayerStats, 'post_rel_median', null, false, postSeasonGpMinimum, statsToExcludeZeroes.has('rel_median')),
        post_GEM: getRanks(allPlayerStats, 'post_GEM', null, true, postSeasonGpMinimum, statsToExcludeZeroes.has('GEM')),
        post_WAR: getRanks(allPlayerStats, 'post_WAR', null, false, 0, statsToExcludeZeroes.has('WAR')),
        post_medrank: getRanks(allPlayerStats, 'post_medrank', null, true, postSeasonGpMinimum, statsToExcludeZeroes.has('medrank')),
        post_meanrank: getRanks(allPlayerStats, 'post_meanrank', null, true, postSeasonGpMinimum, statsToExcludeZeroes.has('meanrank')),
        post_aag_mean: getRanks(allPlayerStats, 'post_aag_mean', 'post_aag_mean_pct'),
        post_aag_median: getRanks(allPlayerStats, 'post_aag_median', 'post_aag_median_pct'),
        post_t100: getRanks(allPlayerStats, 'post_t100', 'post_t100_pct'),
        post_t50: getRanks(allPlayerStats, 'post_t50', 'post_t50_pct'),
    };

    const batch = db.batch();
    allPlayerStats.forEach(player => {
        const playerStatsRef = db.collection(getCollectionName('v2_players')).doc(player.player_id).collection(getCollectionName('seasonal_stats')).doc(seasonId);
        const ranksUpdate = {};
        for (const key in leaderboards) {
            ranksUpdate[`${key}_rank`] = leaderboards[key].get(player.player_id) || null;
        }
        batch.update(playerStatsRef, ranksUpdate);
    });

    await batch.commit();
    console.log(`Player ranking update complete for season ${seasonId}.`);
}

/**
 * Core logic to update single game performance leaderboards.
 */
async function performPerformanceRankingUpdate() {
    console.log("Starting single-performance leaderboard update...");
    const activeSeasonSnap = await db.collection(getCollectionName('seasons')).where('status', '==', 'active').limit(1).get();
    if (activeSeasonSnap.empty) {
        console.log("No active season found. Aborting performance leaderboard update.");
        return;
    }
    const seasonId = activeSeasonSnap.docs[0].id;

    // --- FIXED QUERY LOGIC ---
    // 1. Define the explicit paths to the season's subcollections.
    const lineupsRef = db.collection(getCollectionName('seasons')).doc(seasonId).collection(getCollectionName('lineups'));
    const postLineupsRef = db.collection(getCollectionName('seasons')).doc(seasonId).collection(getCollectionName('post_lineups'));

    // 2. Fetch from both collections simultaneously.
    const [lineupsSnap, postLineupsSnap] = await Promise.all([
        lineupsRef.get(),
        postLineupsRef.get()
    ]);

    // 3. Combine the results into a single array.
    const allPerformances = [...lineupsSnap.docs, ...postLineupsSnap.docs].map(d => d.data());
    // --- END OF FIX ---

    const karmaLeaderboard = [...allPerformances]
        .sort((a, b) => (b.points_adjusted || 0) - (a.points_adjusted || 0))
        .slice(0, 250);

    const rankLeaderboard = [...allPerformances]
        .filter(p => (p.global_rank || 0) > 0)
        .sort((a, b) => (a.global_rank || 999) - (b.global_rank || 999))
        .slice(0, 250);

    const batch = db.batch();
    const leaderboardsCollection = getCollectionName('leaderboards');

    batch.set(db.doc(`${leaderboardsCollection}/single_game_karma`), { seasonId, rankings: karmaLeaderboard });
    batch.set(db.doc(`${leaderboardsCollection}/single_game_rank`), { seasonId, rankings: rankLeaderboard });

    await batch.commit();
    console.log("Single-performance leaderboard update complete.");
}

/**
 * Scheduled function to update player ranks daily.
 */
exports.updatePlayerRanks = onSchedule({
    schedule: "30 3 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    await performPlayerRankingUpdate();
    return null;
});

/**
 * Scheduled function to update performance leaderboards daily.
 */
exports.updatePerformanceLeaderboards = onSchedule({
    schedule: "30 3 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    await performPerformanceRankingUpdate();
    return null;
});

exports.forceLeaderboardRecalculation = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    try {
        await performPlayerRankingUpdate();
        await performPerformanceRankingUpdate();
        return { success: true, message: "All leaderboards have been recalculated." };
    } catch (error) {
        console.error("Manual leaderboard recalculation failed:", error);
        throw new HttpsError('internal', 'An error occurred during leaderboard recalculation.');
    }
});

/**
 * Runs daily to determine the current week of the active season.
 * It finds the earliest incomplete game and writes its week/round name
 * to the active season document.
 */
exports.updateCurrentWeek = onSchedule({
    schedule: "every day 03:30",
    timeZone: "America/Chicago",
}, async (event) => {
    console.log("Running scheduled function to update current week...");

    try {
        const seasonsRef = db.collection(getCollectionName('seasons'));
        // CORRECTED: Chained .where() and .limit() instead of using query()
        const activeSeasonQuery = seasonsRef.where("status", "==", "active").limit(1);
        // CORRECTED: Used .get() to execute the query
        const activeSeasonSnap = await activeSeasonQuery.get();

        if (activeSeasonSnap.empty) {
            console.log("No active season found. Exiting function.");
            return null;
        }

        const activeSeasonDoc = activeSeasonSnap.docs[0];
        const seasonId = activeSeasonDoc.id;
        console.log(`Active season is ${seasonId}. Checking for next incomplete game.`);

        let nextGameWeek = null;

        // 1. Check for the next incomplete regular season game
        const gamesRef = activeSeasonDoc.ref.collection(getCollectionName('games'));
        // CORRECTED: Rewrote this query with chained methods
        const incompleteGamesQuery = gamesRef
            .where('completed', '!=', 'TRUE')
            .orderBy('date', 'asc')
            .limit(1);
        const incompleteGamesSnap = await incompleteGamesQuery.get();

        if (!incompleteGamesSnap.empty) {
            nextGameWeek = incompleteGamesSnap.docs[0].data().week;
        } else {
            // 2. If no regular season games are left, check the postseason
            console.log("No incomplete regular season games found. Checking postseason...");
            const postGamesRef = activeSeasonDoc.ref.collection(getCollectionName('post_games'));
             // CORRECTED: Rewrote this query with chained methods
            const incompletePostGamesQuery = postGamesRef
                .where('completed', '!=', 'TRUE')
                .orderBy('date', 'asc')
                .limit(1);
            const incompletePostGamesSnap = await incompletePostGamesQuery.get();

            if (!incompletePostGamesSnap.empty) {
                nextGameWeek = incompletePostGamesSnap.docs[0].data().week;
            }
        }

        if (nextGameWeek !== null) {
            console.log(`The next game is in week/round: '${nextGameWeek}'. Updating season document.`);
            await activeSeasonDoc.ref.set({
                current_week: String(nextGameWeek) // Ensure it's stored as a string
            }, { merge: true });
            console.log("Successfully updated the current week.");
        } else {
            // 3. If no incomplete games are found anywhere, the season is over.
            console.log("No incomplete games found in regular or postseason. Setting current week to 'Season Complete'.");
            await activeSeasonDoc.ref.set({
                current_week: "Season Complete"
            }, { merge: true });
        }

        return null;

    } catch (error) {
        console.error("Error updating current week:", error);
        // Throwing an error will cause the function to retry if configured,
        // but for a daily job, logging is often sufficient.
        return null;
    }
});

// ===================================================================
// LEGACY FUNCTIONS - DO NOT MODIFY
// ===================================================================

/**
 * Triggered when a transaction is created in the new admin portal.
 * Updates player and draft pick ownership based on the transaction type.
 */
exports.onTransactionCreate = onDocumentCreated("transactions/{transactionId}", async (event) => {
    const transaction = event.data.data();
    if (transaction.schema === 'v2') {
        console.log(`LEGACY: Ignoring transaction ${event.params.transactionId} with v2 schema.`);
        return null;
    }
    const transactionId = event.params.transactionId;
    console.log(`NEW: Processing transaction ${transactionId} of type: ${transaction.type}`);

    const batch = db.batch();

    try {
        if (transaction.type === 'SIGN') {
            const playerMove = transaction.involved_players[0];
            const playerRef = db.collection('new_players').doc(playerMove.id);
            batch.update(playerRef, { current_team_id: playerMove.to });
        } else if (transaction.type === 'CUT') {
            const playerMove = transaction.involved_players[0];
            const playerRef = db.collection('new_players').doc(playerMove.id);
            batch.update(playerRef, { current_team_id: 'FREE_AGENT' });
        } else if (transaction.type === 'TRADE') {
            if (transaction.involved_players) {
                for (const playerMove of transaction.involved_players) {
                    const playerRef = db.collection('new_players').doc(playerMove.id);
                    batch.update(playerRef, { current_team_id: playerMove.to });
                    console.log(`TRADE: Updating player ${playerMove.id} to team ${playerMove.to}`);
                }
            }
            if (transaction.involved_picks) {
                // Get the current date for the notes field
                const today = new Date();
                const dateString = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;

                for (const pickMove of transaction.involved_picks) {
                    const pickRef = db.collection('draftPicks').doc(pickMove.id);

                    // MODIFIED: Create the notes string and add the new fields to the update
                    const tradeNotes = `${pickMove.from}/${pickMove.to} ${dateString}`;
                    batch.update(pickRef, {
                        current_owner: pickMove.to,
                        trade_id: transactionId,
                        notes: tradeNotes
                    });
                    console.log(`TRADE: Updating pick ${pickMove.id} to owner ${pickMove.to} with notes and trade_id.`);
                }
            }
        }

        await batch.commit();
        console.log(`Transaction ${transactionId} processed successfully.`);

    } catch (error) {
        console.error(`Error processing transaction ${transactionId}:`, error);
        await event.data.ref.update({ status: 'FAILED', error: error.message });
    }
    return null;
});

exports.onLegacyGameUpdate = onDocumentUpdated("schedule/{gameId}", async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();

    if (before.completed === 'TRUE' || after.completed !== 'TRUE') {
        return null; // The game wasn't newly completed.
    }
    console.log(`LEGACY: Processing game: ${event.params.gameId}`);

    const winnerId = after.winner;
    const loserId = after.team1_id === winnerId ? after.team2_id : after.team1_id;

    if (!winnerId || !loserId) {
        console.error(`Could not determine winner/loser for game ${event.params.gameId}.`);
        return null;
    }

    const winnerRef = db.collection('teams').doc(winnerId);
    const loserRef = db.collection('teams').doc(loserId);

    try {
        // --- Step 1: Update Team Win/Loss Records (Existing Logic) ---
        await db.runTransaction(async (transaction) => {
            transaction.update(winnerRef, { wins: admin.firestore.FieldValue.increment(1) });
            transaction.update(loserRef, { losses: admin.firestore.FieldValue.increment(-1) });
        });
        console.log(`Successfully updated team records for game ${event.params.gameId}.`);

        // --- Step 2: NEW - Process Player Stats ---
        const gameDate = after.date;
        const teamIds = [after.team1_id, after.team2_id];

        // Fetch all lineup entries for the two teams on the game date.
        const lineupsQuery = db.collection('lineups').where('date', '==', gameDate).where('team_id', 'in', teamIds);
        const lineupsSnap = await lineupsQuery.get();

        // Filter for only players who started the game.
        const startingLineups = lineupsSnap.docs
            .map(doc => doc.data())
            .filter(lineup => lineup.started === 'TRUE');

        if (startingLineups.length === 0) {
            console.log("No starting lineups found for this game. No player stats to update.");
            return null;
        }

        // Use a batched write to update all players efficiently.
        const batch = db.batch();

        for (const lineup of startingLineups) {
            const playerRef = db.collection('players').doc(lineup.player_handle);

            // Increment basic counting stats.
            const statsUpdate = {
                games_played: admin.firestore.FieldValue.increment(1),
                total_points: admin.firestore.FieldValue.increment(Number(lineup.points_final) || 0)
            };

            // FUTURE ENHANCEMENT: This is where more complex stat calculations (REL, WAR, etc.)
            // would be performed by fetching weekly averages and adding to value-over-replacement tallies.

            batch.update(playerRef, statsUpdate);
        }

        // Commit all the player updates at once.
        await batch.commit();
        console.log(`Successfully updated stats for ${startingLineups.length} players.`);

    } catch (e) {
        console.error("An error occurred during game processing: ", e);
    }

    return null;
});

/**
 * Deletes a collection by batching deletes. This is used to clear collections
 * before a fresh sync to prevent data duplication or orphaned documents.
 * @param {admin.firestore.Firestore} db The Firestore database instance.
 * @param {string} collectionPath The path to the collection to delete.
 * @param {number} batchSize The number of documents to delete in each batch.
 */
async function deleteCollection(db, collectionPath, batchSize) {
    const collectionRef = db.collection(collectionPath);
    const query = collectionRef.orderBy('__name__').limit(batchSize);

    let snapshot = await query.get();

    // When there are no documents left, the snapshot will be empty.
    while (snapshot.size > 0) {
        const batch = db.batch();
        snapshot.docs.forEach((doc) => {
            batch.delete(doc.ref);
        });
        await batch.commit();

        // Get the next batch of documents
        snapshot = await query.get();
    }
}

/**
 * Parses a CSV string into an array of objects.
 * This version is enhanced to filter out empty or malformed rows.
 * @param {string} csvText The raw CSV text to parse.
 * @returns {Array<Object>} An array of objects representing the CSV rows.
 */
function parseCSV(csvText) {
    // Filter out any blank lines or lines that only contain commas and whitespace.
    const lines = csvText.trim().split('\n').filter(line => line.trim() !== '' && line.replace(/,/g, '').trim() !== '');
    if (lines.length === 0) {
        return [];
    }
    const headerLine = lines.shift();
    // Clean headers of any quotes and extra whitespace.
    const headers = headerLine.split(',').map(h => h.replace(/"/g, '').trim());
    const data = lines.map(line => {
        // Regex to handle values that might be wrapped in quotes.
        const values = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || [];
        const row = {};
        for (let i = 0; i < headers.length; i++) {
            // Ensure header exists before assigning
            if (headers[i]) {
                const value = (values[i] || '').replace(/"/g, '').trim();
                row[headers[i]] = value;
            }
        }
        return row;
    });
    return data;
}


/**
 * Safely parses a string into a number, returning 0 for invalid inputs.
 * @param {*} value The value to parse.
 * @returns {number} The parsed number or 0.
 */
function parseNumber(value) {
    if (value === null || typeof value === 'undefined' || String(value).trim() === '') return 0;
    const cleaned = String(value).replace(/,/g, '');
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
}

/**
 * Converts a MM/DD/YYYY date string to a YYYY-MM-DD string.
 * Returns null if the format is invalid.
 * @param {string} dateString The date string to convert.
 * @returns {string|null} The formatted date string or null.
 */
function getSafeDateString(dateString) {
    if (!dateString || typeof dateString !== 'string') return null;
    const parts = dateString.split('/');
    if (parts.length === 3) {
        const [month, day, year] = parts;
        return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    return null;
}


// UPDATED: Changed to V2 onRequest function
exports.syncSheetsToFirestore = onRequest({ region: "us-central1" }, async (req, res) => {
    try {
        const SPREADSHEET_ID = "12EembQnztbdKx2-buv00--VDkEFSTuSXTRdOnTnRxq4";

        // Helper to fetch and parse a single sheet from Google Sheets.
        const fetchAndParseSheet = async (sheetName) => {
            const gvizUrl = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
            const response = await fetch(gvizUrl);
            if (!response.ok) throw new Error(`Failed to fetch sheet: ${sheetName}`);
            const csvText = await response.text();
            return parseCSV(csvText);
        };

        console.log("Fetching all sheets...");
        const [
            playersRaw,
            draftPicksRaw,
            teamsRaw,
            scheduleRaw,
            lineupsRaw,
            weeklyAveragesRaw,
            transactionsLogRaw,
            postScheduleRaw,
            postLineupsRaw,
            postWeeklyAveragesRaw
        ] = await Promise.all([
            fetchAndParseSheet("Players"),
            fetchAndParseSheet("Draft_Capital"),
            fetchAndParseSheet("Teams"),
            fetchAndParseSheet("Schedule"),
            fetchAndParseSheet("Lineups"),
            fetchAndParseSheet("Weekly_Averages"),
            fetchAndParseSheet("Transaction_Log"),
            fetchAndParseSheet("Post_Schedule"),
            fetchAndParseSheet("Post_Lineups"),
            fetchAndParseSheet("Post_Weekly_Averages")
        ]);
        console.log("All sheets fetched successfully.");

        // --- Clear and Sync Players collection ---
        console.log("Clearing the 'players' collection...");
        await deleteCollection(db, 'players', 200);
        console.log("'players' collection cleared successfully.");

        const playersBatch = db.batch();
        playersRaw.forEach(player => {
            if (player.player_handle && player.player_handle.trim()) {
                const docRef = db.collection("players").doc(player.player_handle.trim());
                const playerData = { ...player };

                playerData.GEM = parseNumber(player.GEM);
                playerData.REL = parseNumber(player.REL);
                playerData.WAR = parseNumber(player.WAR);
                playerData.aag_mean = parseNumber(player.aag_mean);
                playerData.aag_median = parseNumber(player.aag_median);
                playerData.games_played = parseNumber(player.games_played);
                playerData.total_points = parseNumber(player.total_points);

                playersBatch.set(docRef, playerData);
            }
        });
        await playersBatch.commit();
        console.log(`Successfully synced ${playersRaw.length} players.`);

        // --- Clear and Sync 'draftPicks' collection ---
        console.log("Clearing the 'draftPicks' collection for a fresh sync...");
        await deleteCollection(db, 'draftPicks', 200);
        const draftPicksBatch = db.batch();
        draftPicksRaw.forEach(pick => {
            if (pick.pick_id && pick.pick_id.trim()) {
                const docRef = db.collection("draftPicks").doc(pick.pick_id.trim());
                const pickData = { ...pick };

                pickData.season = parseNumber(pick.season);
                pickData.round = parseNumber(pick.round);

                draftPicksBatch.set(docRef, pickData);
            }
        });
        await draftPicksBatch.commit();
        console.log(`Successfully synced ${draftPicksRaw.length} draft picks to the 'draftPicks' collection.`);

        // --- Clear and Sync Teams collection ---
        console.log("Clearing the 'teams' collection...");
        await deleteCollection(db, 'teams', 200);
        const teamsBatch = db.batch();
        teamsRaw.forEach(team => {
            if (team.team_id && team.team_id.trim()) {
                const docRef = db.collection("teams").doc(team.team_id.trim());
                teamsBatch.set(docRef, team);
            }
        });
        await teamsBatch.commit();
        console.log(`Successfully synced ${teamsRaw.length} teams.`);

        // --- Clear and Sync Schedule collection ---
        console.log("Clearing the 'schedule' collection...");
        await deleteCollection(db, 'schedule', 200);
        const scheduleBatch = db.batch();
        scheduleRaw.forEach(game => {
            const safeDate = getSafeDateString(game.date);
            if (safeDate && game.team1_id && game.team1_id.trim() && game.team2_id && game.team2_id.trim()) {
                const docId = `${safeDate}-${game.team1_id.trim()}-${game.team2_id.trim()}`;
                const docRef = db.collection("schedule").doc(docId);
                const gameData = { ...game };
                gameData.team1_score = parseNumber(game.team1_score);
                gameData.team2_score = parseNumber(game.team2_score);
                scheduleBatch.set(docRef, gameData);
            }
        });
        await scheduleBatch.commit();
        console.log(`Successfully synced ${scheduleRaw.length} schedule games.`);

        // --- Clear and Sync Lineups collection ---
        console.log("Clearing the 'lineups' collection...");
        await deleteCollection(db, 'lineups', 200);
        const lineupsBatch = db.batch();
        lineupsRaw.forEach(lineup => {
            const safeDate = getSafeDateString(lineup.date);
            if (safeDate && lineup.player_handle && lineup.player_handle.trim()) {
                const docId = `${safeDate}-${lineup.player_handle.trim()}`;
                const docRef = db.collection("lineups").doc(docId);
                const lineupData = { ...lineup };
                lineupData.points_final = parseNumber(lineup.points_final);
                lineupData.points_raw = parseNumber(lineup.points_raw);
                lineupData.global_rank = parseNumber(lineup.global_rank);
                lineupsBatch.set(docRef, lineupData);
            }
        });
        await lineupsBatch.commit();
        console.log(`Successfully synced ${lineupsRaw.length} lineup entries.`);

        // --- Clear and Sync Weekly Averages collection ---
        console.log("Clearing the 'weekly_averages' collection...");
        await deleteCollection(db, 'weekly_averages', 200);
        const weeklyAveragesBatch = db.batch();
        weeklyAveragesRaw.forEach(week => {
            const safeDate = getSafeDateString(week.date);
            if (safeDate) {
                const docRef = db.collection("weekly_averages").doc(safeDate);
                const weekData = { ...week };
                weekData.mean_score = parseNumber(week.mean_score);
                weekData.median_score = parseNumber(week.median_score);
                weeklyAveragesBatch.set(docRef, weekData);
            }
        });
        await weeklyAveragesBatch.commit();
        console.log(`Successfully synced ${weeklyAveragesRaw.length} weekly average entries.`);

        // --- ADDED: Clear and Sync Postseason Schedule collection ---
        console.log("Clearing the 'post_schedule' collection...");
        await deleteCollection(db, 'post_schedule', 200);
        const postScheduleBatch = db.batch();
        postScheduleRaw.forEach(game => {
            const safeDate = getSafeDateString(game.date);
            if (safeDate && game.team1_id && game.team1_id.trim() && game.team2_id && game.team2_id.trim()) {
                const docId = `${safeDate}-${game.team1_id.trim()}-${game.team2_id.trim()}`;
                const docRef = db.collection("post_schedule").doc(docId);
                const gameData = { ...game };
                gameData.team1_score = parseNumber(game.team1_score);
                gameData.team2_score = parseNumber(game.team2_score);
                postScheduleBatch.set(docRef, gameData);
            }
        });
        await postScheduleBatch.commit();
        console.log(`Successfully synced ${postScheduleRaw.length} postseason schedule games.`);

        // --- ADDED: Clear and Sync Postseason Lineups collection ---
        console.log("Clearing the 'post_lineups' collection...");
        await deleteCollection(db, 'post_lineups', 200);
        const postLineupsBatch = db.batch();
        postLineupsRaw.forEach(lineup => {
            const safeDate = getSafeDateString(lineup.date);
            if (safeDate && lineup.player_handle && lineup.player_handle.trim()) {
                const docId = `${safeDate}-${lineup.player_handle.trim()}`;
                const docRef = db.collection("post_lineups").doc(docId);
                const lineupData = { ...lineup };
                lineupData.points_final = parseNumber(lineup.points_final);
                lineupData.points_raw = parseNumber(lineup.points_raw);
                lineupData.global_rank = parseNumber(lineup.global_rank);
                postLineupsBatch.set(docRef, lineupData);
            }
        });
        await postLineupsBatch.commit();
        console.log(`Successfully synced ${postLineupsRaw.length} postseason lineup entries.`);

        // --- ADDED: Clear and Sync Postseason Weekly Averages collection ---
        console.log("Clearing the 'post_weekly_averages' collection...");
        await deleteCollection(db, 'post_weekly_averages', 200);
        const postWeeklyAveragesBatch = db.batch();
        postWeeklyAveragesRaw.forEach(week => {
            const safeDate = getSafeDateString(week.date);
            if (safeDate) {
                const docRef = db.collection("post_weekly_averages").doc(safeDate);
                const weekData = { ...week };
                weekData.mean_score = parseNumber(week.mean_score);
                weekData.median_score = parseNumber(week.median_score);
                postWeeklyAveragesBatch.set(docRef, weekData);
            }
        });
        await postWeeklyAveragesBatch.commit();
        console.log(`Successfully synced ${postWeeklyAveragesRaw.length} postseason weekly average entries.`);

        res.status(200).send("Firestore sync completed successfully!");

    } catch (error) {
        console.error("Error during sync:", error);
        res.status(500).send("Sync failed. Check function logs for details.");
    }
});


// UPDATED: Changed to V2 onCall function
exports.clearAllTradeBlocks = onCall({ region: "us-central1" }, async (request) => {
    // This function can remain as-is.
});

// UPDATED: Changed to V2 onCall function
exports.reopenTradeBlocks = onCall({ region: "us-central1" }, async (request) => {
    // This function can remain as-is.
});
