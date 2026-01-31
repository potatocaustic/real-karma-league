// functions/relegation/execution.js

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require('../utils/firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const { getCollectionName, LEAGUES } = require('../utils/firebase-helpers');

/**
 * Executes the promotion/relegation after admin confirmation.
 *
 * This function:
 * 1. Copies promoted team to Major league
 * 2. Copies relegated team to Minor league
 * 3. Moves players between leagues
 * 4. Swaps draft capital for future seasons
 * 5. Creates audit trail in promotion_history
 *
 * Admin-only function with strict preconditions.
 */
exports.executePromotion = onCall({ region: "us-central1", timeoutSeconds: 300 }, async (request) => {
    if (!request.auth || !request.auth.uid) {
        throw new HttpsError('unauthenticated', 'Must be authenticated.');
    }

    // Verify admin role
    const userRef = db.collection('users').doc(request.auth.uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists || userSnap.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Only admins can execute promotions.');
    }

    const { seasonId } = request.data;

    if (!seasonId) {
        throw new HttpsError('invalid-argument', 'seasonId is required.');
    }

    try {
        // Get and validate relegation document
        const relegationRef = db.collection('relegation_games').doc(seasonId);
        const relegationSnap = await relegationRef.get();

        if (!relegationSnap.exists) {
            throw new HttpsError('not-found', `Relegation document for ${seasonId} not found.`);
        }

        const relegationData = relegationSnap.data();

        // Precondition checks
        if (relegationData.status !== 'completed') {
            throw new HttpsError('failed-precondition',
                `Relegation game status must be 'completed'. Current status: ${relegationData.status}`);
        }

        if (relegationData.promotion_required !== true) {
            throw new HttpsError('failed-precondition',
                'Promotion is not required. The Major team won the relegation game.');
        }

        if (relegationData.executed_at !== null) {
            throw new HttpsError('failed-precondition',
                `Promotion already executed on ${relegationData.executed_at?.toDate?.() || relegationData.executed_at}`);
        }

        const majorTeamId = relegationData.major_team.team_id;
        const minorTeamId = relegationData.minor_champion.team_id;

        console.log(`Executing promotion: ${minorTeamId} (Minor) ↔ ${majorTeamId} (Major)`);

        // Calculate next season for draft pick swaps
        const seasonNumber = relegationData.season_number;
        const nextSeasonNumber = seasonNumber + 1;

        // Execute all operations
        const result = await executeSwap(majorTeamId, minorTeamId, seasonId, nextSeasonNumber);

        // Update relegation document
        await relegationRef.update({
            status: 'executed',
            executed_at: FieldValue.serverTimestamp(),
            executed_by: request.auth.uid,
            updated_at: FieldValue.serverTimestamp()
        });

        // Create promotion_history record
        const historyRef = db.collection('promotion_history').doc(seasonId);
        await historyRef.set({
            season: seasonId,
            executed_at: FieldValue.serverTimestamp(),
            executed_by: request.auth.uid,
            promoted_team: {
                team_id: minorTeamId,
                team_name: relegationData.minor_champion.team_name,
                gm_player_id: result.minorTeamGm,
                players_moved: result.promotedPlayers
            },
            relegated_team: {
                team_id: majorTeamId,
                team_name: relegationData.major_team.team_name,
                gm_player_id: result.majorTeamGm,
                players_moved: result.relegatedPlayers
            },
            draft_picks_swapped: result.swappedPicks
        });

        return {
            success: true,
            message: `Successfully executed promotion/relegation for ${seasonId}`,
            promotedTeam: minorTeamId,
            relegatedTeam: majorTeamId,
            playersPromoted: result.promotedPlayers.length,
            playersRelegated: result.relegatedPlayers.length,
            picksSwapped: result.swappedPicks.length
        };

    } catch (error) {
        console.error("Error executing promotion:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError('internal', `Failed to execute promotion: ${error.message}`);
    }
});

/**
 * Executes the actual swap between leagues.
 * Returns tracking data for the promotion_history record.
 */
async function executeSwap(majorTeamId, minorTeamId, seasonId, nextSeasonNumber) {
    const result = {
        majorTeamGm: null,
        minorTeamGm: null,
        promotedPlayers: [],
        relegatedPlayers: [],
        swappedPicks: []
    };

    // Use batched writes with multiple batches if needed (500 op limit per batch)
    let currentBatch = db.batch();
    let operationCount = 0;
    const MAX_BATCH_SIZE = 450; // Leave room for safety

    async function commitIfNeeded() {
        if (operationCount >= MAX_BATCH_SIZE) {
            await currentBatch.commit();
            currentBatch = db.batch();
            operationCount = 0;
        }
    }

    // ========================================================================
    // STEP 1: Copy promoted team (Minor → Major)
    // ========================================================================
    console.log(`Step 1: Copying promoted team ${minorTeamId} to Major league`);

    const minorTeamRef = db.collection(getCollectionName('v2_teams', LEAGUES.MINOR)).doc(minorTeamId);
    const minorTeamSnap = await minorTeamRef.get();

    if (!minorTeamSnap.exists) {
        throw new HttpsError('not-found', `Minor team ${minorTeamId} not found.`);
    }

    const minorTeamData = minorTeamSnap.data();
    result.minorTeamGm = minorTeamData.gm_player_id || null;

    // Write team to Major collection
    const majorTeamDestRef = db.collection(getCollectionName('v2_teams', LEAGUES.MAJOR)).doc(minorTeamId);
    currentBatch.set(majorTeamDestRef, {
        ...minorTeamData,
        promoted_from_minor: seasonId,
        promoted_at: FieldValue.serverTimestamp()
    });
    operationCount++;

    // Copy seasonal records (note: minor uses minor_seasonal_records subcollection)
    const minorSeasonalRecordsSnap = await minorTeamRef
        .collection('minor_seasonal_records')
        .get();

    for (const recordDoc of minorSeasonalRecordsSnap.docs) {
        await commitIfNeeded();
        const destRecordRef = majorTeamDestRef.collection('seasonal_records').doc(recordDoc.id);
        currentBatch.set(destRecordRef, recordDoc.data());
        operationCount++;
    }

    // ========================================================================
    // STEP 2: Copy relegated team (Major → Minor)
    // ========================================================================
    console.log(`Step 2: Copying relegated team ${majorTeamId} to Minor league`);

    const majorTeamRef = db.collection(getCollectionName('v2_teams', LEAGUES.MAJOR)).doc(majorTeamId);
    const majorTeamSnap = await majorTeamRef.get();

    if (!majorTeamSnap.exists) {
        throw new HttpsError('not-found', `Major team ${majorTeamId} not found.`);
    }

    const majorTeamData = majorTeamSnap.data();
    result.majorTeamGm = majorTeamData.gm_player_id || null;

    // Write team to Minor collection
    const minorTeamDestRef = db.collection(getCollectionName('v2_teams', LEAGUES.MINOR)).doc(majorTeamId);
    currentBatch.set(minorTeamDestRef, {
        ...majorTeamData,
        relegated_from_major: seasonId,
        relegated_at: FieldValue.serverTimestamp()
    });
    operationCount++;

    // Copy seasonal records (Major uses seasonal_records, Minor uses minor_seasonal_records)
    const majorSeasonalRecordsSnap = await majorTeamRef
        .collection('seasonal_records')
        .get();

    for (const recordDoc of majorSeasonalRecordsSnap.docs) {
        await commitIfNeeded();
        const destRecordRef = minorTeamDestRef.collection('minor_seasonal_records').doc(recordDoc.id);
        currentBatch.set(destRecordRef, recordDoc.data());
        operationCount++;
    }

    // Commit team operations before player operations
    await currentBatch.commit();
    currentBatch = db.batch();
    operationCount = 0;

    // ========================================================================
    // STEP 3: Move promoted team's players (Minor → Major)
    // ========================================================================
    console.log(`Step 3: Moving promoted team's players to Major league`);

    const minorPlayersQuery = db.collection(getCollectionName('v2_players', LEAGUES.MINOR))
        .where('current_team_id', '==', minorTeamId);
    const minorPlayersSnap = await minorPlayersQuery.get();

    for (const playerDoc of minorPlayersSnap.docs) {
        await commitIfNeeded();

        const playerId = playerDoc.id;
        const playerData = playerDoc.data();

        result.promotedPlayers.push(playerId);

        // Write to Major players collection
        const majorPlayerRef = db.collection(getCollectionName('v2_players', LEAGUES.MAJOR)).doc(playerId);
        currentBatch.set(majorPlayerRef, {
            ...playerData,
            promoted_from_minor: seasonId,
            promoted_at: FieldValue.serverTimestamp()
        });
        operationCount++;

        // Copy seasonal stats (minor uses minor_seasonal_stats)
        const minorStatsSnap = await playerDoc.ref.collection('minor_seasonal_stats').get();
        for (const statDoc of minorStatsSnap.docs) {
            await commitIfNeeded();
            const destStatRef = majorPlayerRef.collection('seasonal_stats').doc(statDoc.id);
            currentBatch.set(destStatRef, statDoc.data());
            operationCount++;
        }

        // Mark source document as transferred (don't delete - keep for audit)
        await commitIfNeeded();
        currentBatch.update(playerDoc.ref, {
            transferred_to_league: 'major',
            transferred_season: seasonId,
            transferred_at: FieldValue.serverTimestamp()
        });
        operationCount++;
    }

    // ========================================================================
    // STEP 4: Move relegated team's players (Major → Minor)
    // ========================================================================
    console.log(`Step 4: Moving relegated team's players to Minor league`);

    const majorPlayersQuery = db.collection(getCollectionName('v2_players', LEAGUES.MAJOR))
        .where('current_team_id', '==', majorTeamId);
    const majorPlayersSnap = await majorPlayersQuery.get();

    for (const playerDoc of majorPlayersSnap.docs) {
        await commitIfNeeded();

        const playerId = playerDoc.id;
        const playerData = playerDoc.data();

        result.relegatedPlayers.push(playerId);

        // Write to Minor players collection
        const minorPlayerRef = db.collection(getCollectionName('v2_players', LEAGUES.MINOR)).doc(playerId);
        currentBatch.set(minorPlayerRef, {
            ...playerData,
            relegated_from_major: seasonId,
            relegated_at: FieldValue.serverTimestamp()
        });
        operationCount++;

        // Copy seasonal stats (Major uses seasonal_stats, Minor uses minor_seasonal_stats)
        const majorStatsSnap = await playerDoc.ref.collection('seasonal_stats').get();
        for (const statDoc of majorStatsSnap.docs) {
            await commitIfNeeded();
            const destStatRef = minorPlayerRef.collection('minor_seasonal_stats').doc(statDoc.id);
            currentBatch.set(destStatRef, statDoc.data());
            operationCount++;
        }

        // Mark source document as transferred
        await commitIfNeeded();
        currentBatch.update(playerDoc.ref, {
            transferred_to_league: 'minor',
            transferred_season: seasonId,
            transferred_at: FieldValue.serverTimestamp()
        });
        operationCount++;
    }

    // Commit player operations before draft pick operations
    await currentBatch.commit();
    currentBatch = db.batch();
    operationCount = 0;

    // ========================================================================
    // STEP 5: Swap draft capital for future seasons
    // ========================================================================
    console.log(`Step 5: Swapping draft capital for seasons >= ${nextSeasonNumber}`);

    // Get Major team's draft picks that need to move to Minor
    const majorPicksQuery = db.collection(getCollectionName('draftPicks', LEAGUES.MAJOR))
        .where('current_owner', '==', majorTeamId)
        .where('season', '>=', nextSeasonNumber);
    const majorPicksSnap = await majorPicksQuery.get();

    for (const pickDoc of majorPicksSnap.docs) {
        await commitIfNeeded();

        const pickData = pickDoc.data();
        result.swappedPicks.push({
            pick_id: pickDoc.id,
            from_league: 'major',
            to_league: 'minor',
            from_owner: majorTeamId,
            to_owner: majorTeamId // Same team, different league
        });

        // Write to Minor draftPicks
        const minorPickRef = db.collection(getCollectionName('draftPicks', LEAGUES.MINOR)).doc(pickDoc.id);
        currentBatch.set(minorPickRef, {
            ...pickData,
            transferred_from_major: seasonId
        });
        operationCount++;

        // Delete from Major draftPicks
        currentBatch.delete(pickDoc.ref);
        operationCount++;
    }

    // Get Minor team's draft picks that need to move to Major
    const minorPicksQuery = db.collection(getCollectionName('draftPicks', LEAGUES.MINOR))
        .where('current_owner', '==', minorTeamId)
        .where('season', '>=', nextSeasonNumber);
    const minorPicksSnap = await minorPicksQuery.get();

    for (const pickDoc of minorPicksSnap.docs) {
        await commitIfNeeded();

        const pickData = pickDoc.data();
        result.swappedPicks.push({
            pick_id: pickDoc.id,
            from_league: 'minor',
            to_league: 'major',
            from_owner: minorTeamId,
            to_owner: minorTeamId // Same team, different league
        });

        // Write to Major draftPicks
        const majorPickRef = db.collection(getCollectionName('draftPicks', LEAGUES.MAJOR)).doc(pickDoc.id);
        currentBatch.set(majorPickRef, {
            ...pickData,
            transferred_from_minor: seasonId
        });
        operationCount++;

        // Delete from Minor draftPicks
        currentBatch.delete(pickDoc.ref);
        operationCount++;
    }

    // Final commit
    if (operationCount > 0) {
        await currentBatch.commit();
    }

    console.log(`Swap complete: ${result.promotedPlayers.length} players promoted, ` +
        `${result.relegatedPlayers.length} players relegated, ${result.swappedPicks.length} picks swapped`);

    return result;
}
