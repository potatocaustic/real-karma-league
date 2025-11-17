// functions/admin/admin-players.js

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require('../utils/firebase-admin');
const { FieldValue } = require("firebase-admin/firestore");
const { getCollectionName, getLeagueFromRequest } = require('../utils/firebase-helpers');
const { calculateMedian, calculateMean, calculateGeometricMean } = require('../utils/calculations');
const { performPlayerRankingUpdate } = require('../utils/ranking-helpers');

/**
 * Recalculates all seasonal stats for a specific player in a specific season.
 * Admin-only function that rebuilds stats from lineup data and triggers a full ranking update.
 */
exports.admin_recalculatePlayerStats = onCall({ region: "us-central1" }, async (request) => {
    // Add league context extraction
    const league = getLeagueFromRequest(request.data);

    // 1. Security Check
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    const { playerId, seasonId } = request.data;
    if (!playerId || !seasonId) {
        throw new HttpsError('invalid-argument', 'Missing playerId or seasonId.');
    }

    console.log(`RECALCULATION: Starting stats recalculation for player ${playerId} in season ${seasonId}.`);

    try {
        const seasonNum = seasonId.replace('S', '');
        const batch = db.batch();

        // 2. Fetch all necessary data (lineups and daily averages for the season)
        const regLineupsSnap = await db.collection(getCollectionName('seasons', league)).doc(seasonId).collection(getCollectionName('lineups', league))
            .where('player_id', '==', playerId).where('started', '==', 'TRUE').get();

        const postLineupsSnap = await db.collection(getCollectionName('seasons', league)).doc(seasonId).collection(getCollectionName('post_lineups', league))
            .where('player_id', '==', playerId).where('started', '==', 'TRUE').get();

        const regAveragesSnap = await db.collection(getCollectionName('daily_averages', league)).doc(`season_${seasonNum}`).collection(getCollectionName(`S${seasonNum}_daily_averages`, league)).get();
        const postAveragesSnap = await db.collection(getCollectionName('post_daily_averages', league)).doc(`season_${seasonNum}`).collection(getCollectionName(`S${seasonNum}_post_daily_averages`, league)).get();

        const dailyAveragesMap = new Map();
        regAveragesSnap.forEach(doc => dailyAveragesMap.set(doc.data().date, doc.data()));
        postAveragesSnap.forEach(doc => dailyAveragesMap.set(doc.data().date, doc.data()));

        const allLineups = {
            regular: regLineupsSnap.docs.map(doc => doc.data()),
            postseason: postLineupsSnap.docs.map(doc => doc.data())
        };

        const statsUpdate = {};

        // 3. Process both regular and postseason stats
        for (const [seasonType, lineups] of Object.entries(allLineups)) {
            if (lineups.length === 0) continue; // Skip if no games played

            const isPostseason = (seasonType === 'postseason');
            const prefix = isPostseason ? 'post_' : '';

            const games_played = lineups.length;
            const total_points = lineups.reduce((sum, l) => sum + (l.points_adjusted || 0), 0);
            const WAR = lineups.reduce((sum, l) => sum + (l.SingleGameWar || 0), 0);
            const aag_mean = lineups.reduce((sum, l) => sum + (l.AboveAvg || 0), 0);
            const aag_median = lineups.reduce((sum, l) => sum + (l.AboveMed || 0), 0);
            const globalRanks = lineups.map(l => l.global_rank || 0).filter(r => r > 0);
            const medrank = calculateMedian(globalRanks);
            const meanrank = calculateMean(globalRanks);
            const GEM = calculateGeometricMean(globalRanks);
            const t100 = lineups.filter(l => l.global_rank > 0 && l.global_rank <= 100).length;
            const t50 = lineups.filter(l => l.global_rank > 0 && l.global_rank <= 50).length;

            let meansum = 0;
            let medsum = 0;
            const uniqueDates = [...new Set(lineups.map(l => l.date))];
            uniqueDates.forEach(date => {
                const dailyAvgData = dailyAveragesMap.get(date);
                if (dailyAvgData) {
                    meansum += dailyAvgData.mean_score || 0;
                    medsum += dailyAvgData.median_score || 0;
                }
            });

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
        }

        // 4. Write the updated stats to the database
        const playerStatsRef = db.collection(getCollectionName('v2_players', league)).doc(playerId).collection(getCollectionName('seasonal_stats', league)).doc(seasonId);
        batch.set(playerStatsRef, statsUpdate, { merge: true });
        await batch.commit();
        console.log(`Recalculation complete for player ${playerId}. Wrote updated stats.`);

        // 5. Trigger a full ranking update to ensure ranks are correct
        console.log("Triggering leaderboard rank update to reflect changes...");
        await performPlayerRankingUpdate(league);
        console.log("Leaderboard rank update complete.");

        return { success: true, league, message: `Successfully recalculated all seasonal stats for player ${playerId}.` };

    } catch (error) {
        console.error(`CRITICAL ERROR during stats recalculation for player ${playerId}:`, error);
        throw new HttpsError('internal', `Recalculation failed: ${error.message}`);
    }
});

/**
 * Migrates a player from one ID to another, updating all references throughout the database.
 * Admin-only function that handles player documents, seasonal stats, lineups, draft results, and team references.
 */
exports.admin_updatePlayerId = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
    // Step 1: Security and Validation
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    const { oldPlayerId, newPlayerId } = request.data;
    if (!oldPlayerId || !newPlayerId) {
        throw new HttpsError('invalid-argument', 'Missing oldPlayerId or newPlayerId.');
    }
    if (oldPlayerId === newPlayerId) {
        throw new HttpsError('invalid-argument', 'Old and new IDs cannot be the same.');
    }

    console.log(`ADMIN ACTION: User ${request.auth.uid} initiated player ID migration from ${oldPlayerId} to ${newPlayerId}.`);

    const oldPlayerRef = db.collection(getCollectionName('v2_players', league)).doc(oldPlayerId);
    const newPlayerRef = db.collection(getCollectionName('v2_players', league)).doc(newPlayerId);

    try {
        // Step 2: Pre-flight Checks
        const oldPlayerDoc = await oldPlayerRef.get();
        if (!oldPlayerDoc.exists) {
            throw new HttpsError('not-found', `Player to migrate (ID: ${oldPlayerId}) does not exist.`);
        }
        const newPlayerDoc = await newPlayerRef.get();
        if (newPlayerDoc.exists) {
            throw new HttpsError('already-exists', `A player with the new ID (${newPlayerId}) already exists. Aborting.`);
        }

        const playerData = oldPlayerDoc.data();

        // Step 3: Migrate Player Document and Subcollections
        const primaryBatch = db.batch();
        primaryBatch.set(newPlayerRef, playerData);

        const statsSnap = await oldPlayerRef.collection(getCollectionName('seasonal_stats', league)).get();
        statsSnap.forEach(doc => {
            const newStatRef = newPlayerRef.collection(getCollectionName('seasonal_stats', league)).doc(doc.id);
            primaryBatch.set(newStatRef, doc.data());
        });
        await primaryBatch.commit();
        console.log(`Successfully created new player doc ${newPlayerId} and copied stats.`);

        // Step 4: Update All References (WITH BATCHING LOGIC)
        let referenceUpdateBatch = db.batch();
        let operationCount = 0;
        const BATCH_LIMIT = 490; // Keep it safely under 500
        let totalLineupsMigrated = 0;

        const seasonsSnap = await db.collection(getCollectionName('seasons', league)).get();

        for (const seasonDoc of seasonsSnap.docs) {
            const collectionTypes = ['lineups', 'post_lineups', 'exhibition_lineups'];

            for (const type of collectionTypes) {
                const lineupsRef = seasonDoc.ref.collection(getCollectionName(type, league));
                const lineupsQuery = lineupsRef.where('player_id', '==', oldPlayerId);
                const lineupsSnap = await lineupsQuery.get();

                for (const doc of lineupsSnap.docs) {
                    const lineupData = doc.data();
                    lineupData.player_id = newPlayerId;
                    const newDocId = doc.id.replace(oldPlayerId, newPlayerId);

                    const newDocRef = lineupsRef.doc(newDocId);

                    referenceUpdateBatch.set(newDocRef, lineupData);
                    referenceUpdateBatch.delete(doc.ref);
                    totalLineupsMigrated++;

                    operationCount += 2; // 1 set + 1 delete

                    if (operationCount >= BATCH_LIMIT) {
                        console.log(`Committing batch of ${operationCount} operations...`);
                        await referenceUpdateBatch.commit();
                        referenceUpdateBatch = db.batch();
                        operationCount = 0;
                    }
                }
            }
        }
        console.log(`Total lineups to migrate: ${totalLineupsMigrated}`);

        // Update draft results and GM references (these are low volume and can be in the same batch)
        const draftResultsQuery = db.collectionGroup(getCollectionName('draft_results', league)).where('player_id', '==', oldPlayerId);
        const draftResultsSnap = await draftResultsQuery.get();
        draftResultsSnap.forEach(doc => {
            referenceUpdateBatch.update(doc.ref, { player_id: newPlayerId });
            operationCount++;
        });

        const gmTeamsQuery = db.collection(getCollectionName('v2_teams', league)).where('gm_player_id', '==', oldPlayerId);
        const gmTeamsSnap = await gmTeamsQuery.get();
        gmTeamsSnap.forEach(doc => {
            referenceUpdateBatch.update(doc.ref, { gm_player_id: newPlayerId });
            operationCount++;
        });

        if (operationCount > 0) {
            console.log(`Committing final batch of ${operationCount} operations.`);
            await referenceUpdateBatch.commit();
        }

        console.log('Successfully updated all lineup, draft, and GM references.');

        // Step 5: Final Deletion of Old Player Document
        const deletionBatch = db.batch();
        statsSnap.forEach(doc => {
            deletionBatch.delete(oldPlayerRef.collection(getCollectionName('seasonal_stats', league)).doc(doc.id));
        });
        deletionBatch.delete(oldPlayerRef);
        await deletionBatch.commit();
        console.log(`Successfully deleted old player document ${oldPlayerId}.`);

        // Step 6: Log the action and return success
        // 'scorekeeper_activity_log' is a shared collection, so no league parameter needed
        const logRef = db.collection(getCollectionName('scorekeeper_activity_log')).doc();
        await logRef.set({
            action: 'admin_migrate_player_id',
            userId: request.auth.uid,
            userRole: userDoc.data().role,
            timestamp: FieldValue.serverTimestamp(),
            details: {
                oldPlayerId: oldPlayerId,
                newPlayerId: newPlayerId,
                playerHandle: playerData.player_handle
            }
        });

        return { success: true, league, message: `Player ${playerData.player_handle} successfully migrated from ${oldPlayerId} to ${newPlayerId}.` };

    } catch (error) {
        console.error("CRITICAL ERROR during player ID migration:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError('internal', `Migration failed: ${error.message}`);
    }
});

/**
 * Updates player handle from the GM portal.
 * Propagates handle changes throughout all historical records and adds old handle to aliases.
 * GM-only function - GMs can only update players on their own team.
 */
exports.gm_updatePlayerHandle = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);

    // 1. Security Check & Validation
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || (userDoc.data().role !== 'gm' && userDoc.data().role !== 'admin')) {
        throw new HttpsError('permission-denied', 'Must be a GM or admin to run this function.');
    }

    const { playerId, newPlayerHandle } = request.data;
    if (!playerId || !newPlayerHandle) {
        throw new HttpsError('invalid-argument', 'Missing required player data for update.');
    }

    const gmTeamId = userDoc.data().team_id;
    if (!gmTeamId && userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'GM team not assigned.');
    }

    console.log(`GM ACTION: User ${request.auth.uid} updating handle for player ${playerId} to: ${newPlayerHandle}`);

    try {
        const playerRef = db.collection(getCollectionName('v2_players', league)).doc(playerId);

        // Fetch the existing player data to get the old handle and verify team ownership
        const playerDoc = await playerRef.get();
        if (!playerDoc.exists) {
            throw new HttpsError('not-found', `Player with ID ${playerId} could not be found.`);
        }

        const playerData = playerDoc.data();
        const oldPlayerHandle = playerData.player_handle;

        // Verify GM manages this player (unless they're an admin)
        if (userDoc.data().role !== 'admin' && playerData.current_team_id !== gmTeamId) {
            throw new HttpsError('permission-denied', 'You can only update players on your own team.');
        }

        // If handle hasn't changed, no need to do anything
        if (oldPlayerHandle === newPlayerHandle) {
            return { success: true, league, message: `Player handle is already ${newPlayerHandle}.` };
        }

        const mainBatch = db.batch();

        // 2. Prepare the main player document update
        const playerUpdateData = {
            player_handle: newPlayerHandle
        };

        // Add the old handle to the aliases array
        if (oldPlayerHandle && oldPlayerHandle !== newPlayerHandle) {
            console.log(`Adding alias '${oldPlayerHandle}' for player ${playerId}.`);
            playerUpdateData.aliases = FieldValue.arrayUnion(oldPlayerHandle);
        }

        mainBatch.update(playerRef, playerUpdateData);
        await mainBatch.commit();
        console.log(`Updated player handle for ${playerId} from '${oldPlayerHandle}' to '${newPlayerHandle}'.`);

        // 3. Propagate handle change to all historical lineups
        console.log(`Propagating handle change to lineup documents...`);
        const seasonsSnap = await db.collection(getCollectionName('seasons', league)).get();
        for (const seasonDoc of seasonsSnap.docs) {
            const lineupTypes = ['lineups', 'post_lineups', 'exhibition_lineups'];
            for (const type of lineupTypes) {
                const lineupsRef = seasonDoc.ref.collection(getCollectionName(type, league));
                const lineupsQuery = lineupsRef.where('player_id', '==', playerId);
                const lineupsSnap = await lineupsQuery.get();

                if (!lineupsSnap.empty) {
                    const batch = db.batch();
                    lineupsSnap.forEach(doc => {
                        batch.update(doc.ref, { player_handle: newPlayerHandle });
                    });
                    await batch.commit();
                }
            }
        }

        // 4. Propagate handle change to collections with handles in arrays
        console.log(`Propagating handle change to live games, pending lineups, and transactions...`);
        const arrayCollectionsToUpdate = ['live_games', 'pending_lineups'];
        for (const collName of arrayCollectionsToUpdate) {
            const collectionRef = db.collection(getCollectionName(collName, league));
            const snap = await collectionRef.get();
            if (snap.empty) continue;

            const batch = db.batch();
            snap.forEach(doc => {
                const data = doc.data();
                let wasModified = false;

                ['team1_lineup', 'team2_lineup'].forEach(lineupKey => {
                    if (data[lineupKey] && Array.isArray(data[lineupKey])) {
                        data[lineupKey].forEach(player => {
                            if (player.player_id === playerId && player.player_handle !== newPlayerHandle) {
                                player.player_handle = newPlayerHandle;
                                wasModified = true;
                            }
                        });
                    }
                });

                if (wasModified) {
                    batch.update(doc.ref, data);
                }
            });
            await batch.commit();
        }

        const transactionSeasonsRef = db.collection(getCollectionName('transactions', league)).doc('seasons');
        const transactionSeasonsSnap = await transactionSeasonsRef.listCollections();
        for (const collectionRef of transactionSeasonsSnap) {
            const snap = await collectionRef.get();
            if(snap.empty) continue;

            const batch = db.batch();
            snap.forEach(doc => {
                const data = doc.data();
                let wasModified = false;
                if (data.involved_players && Array.isArray(data.involved_players)) {
                    data.involved_players.forEach(player => {
                        if (player.id === playerId && player.player_handle !== newPlayerHandle) {
                            player.player_handle = newPlayerHandle;
                            wasModified = true;
                        }
                    });
                }
                if(wasModified) {
                    batch.update(doc.ref, { involved_players: data.involved_players });
                }
            });
            await batch.commit();
        }

        // 5. Propagate handle change to draft results
        console.log(`Propagating handle change to draft results...`);
        const draftResultsParentSnap = await db.collection(getCollectionName('draft_results', league)).get();
        for (const doc of draftResultsParentSnap.docs) {
            const collections = await doc.ref.listCollections();
            for (const collectionRef of collections) {
                const draftPicksQuery = collectionRef.where('player_id', '==', playerId);
                const draftPicksSnap = await draftPicksQuery.get();
                if (!draftPicksSnap.empty) {
                    const batch = db.batch();
                    draftPicksSnap.forEach(pickDoc => {
                        batch.update(pickDoc.ref, { player_handle: newPlayerHandle });
                    });
                    await batch.commit();
                }
            }
        }

        // 6. Propagate handle change to award documents
        console.log(`Propagating handle change to award documents...`);
        const awardsParentSnap = await db.collection(getCollectionName('awards', league)).get();
        for (const doc of awardsParentSnap.docs) {
            const collections = await doc.ref.listCollections();
            for (const collectionRef of collections) {
                const awardsSnap = await collectionRef.get();
                if (awardsSnap.empty) continue;

                const batch = db.batch();
                awardsSnap.forEach(awardDoc => {
                    const data = awardDoc.data();
                    let wasModified = false;

                    // Case 1: Award has a top-level player_id
                    if (data.player_id === playerId && data.player_handle !== newPlayerHandle) {
                        data.player_handle = newPlayerHandle;
                        wasModified = true;
                    }

                    // Case 2: Award has a 'players' array
                    if (data.players && Array.isArray(data.players)) {
                        data.players.forEach(player => {
                            if (player.player_id === playerId && player.player_handle !== newPlayerHandle) {
                                player.player_handle = newPlayerHandle;
                                wasModified = true;
                            }
                        });
                    }

                    if (wasModified) {
                        batch.update(awardDoc.ref, data);
                    }
                });
                await batch.commit();
            }
        }

        return { success: true, league, message: `Successfully updated player handle from '${oldPlayerHandle}' to '${newPlayerHandle}' and all associated records.` };

    } catch (error) {
        console.error(`CRITICAL ERROR during GM player handle update for ${playerId}:`, error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError('internal', `Player update failed: ${error.message}`);
    }
});

/**
 * Updates player details including handle, team, status, and accolades.
 * Propagates handle changes throughout all historical records.
 * Admin-only function.
 */
exports.admin_updatePlayerDetails = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
    // 1. Security Check & Validation
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    const { playerId, newPlayerHandle, newTeamId, newStatus, isRookie, isAllStar, seasonId } = request.data;
    if (!playerId || !newPlayerHandle || !newTeamId || !newStatus || !seasonId) {
        throw new HttpsError('invalid-argument', 'Missing required player data for update.');
    }

    console.log(`ADMIN ACTION: Updating details for player ${playerId} to handle: ${newPlayerHandle}`);

    try {
        const playerRef = db.collection(getCollectionName('v2_players', league)).doc(playerId);

        // Fetch the existing player data to get the old handle
        const playerDoc = await playerRef.get();
        if (!playerDoc.exists) {
            throw new HttpsError('not-found', `Player with ID ${playerId} could not be found.`);
        }
        const oldPlayerHandle = playerDoc.data().player_handle;

        const mainBatch = db.batch();

        // 2. Prepare the main player document update
        const playerUpdateData = {
            player_handle: newPlayerHandle,
            current_team_id: newTeamId,
            player_status: newStatus
        };

        // If the handle has changed, add the old one to the aliases array
        if (oldPlayerHandle && oldPlayerHandle !== newPlayerHandle) {
            console.log(`Adding alias '${oldPlayerHandle}' for player ${playerId}.`);
            playerUpdateData.aliases = FieldValue.arrayUnion(oldPlayerHandle);
        }

        mainBatch.update(playerRef, playerUpdateData);


        // 3. Update seasonal accolades (rookie/all-star status)
        const seasonStatsRef = playerRef.collection(getCollectionName('seasonal_stats', league)).doc(seasonId);
        mainBatch.set(seasonStatsRef, {
            rookie: isRookie ? '1' : '0',
            all_star: isAllStar ? '1' : '0'
        }, { merge: true });

        await mainBatch.commit();
        console.log(`Updated core doc and accolades for ${playerId}.`);

        // 4. Propagate handle change to all historical lineups
        console.log(`Propagating handle change to lineup documents...`);
        const seasonsSnap = await db.collection(getCollectionName('seasons', league)).get();
        for (const seasonDoc of seasonsSnap.docs) {
            const lineupTypes = ['lineups', 'post_lineups', 'exhibition_lineups'];
            for (const type of lineupTypes) {
                const lineupsRef = seasonDoc.ref.collection(getCollectionName(type, league));
                const lineupsQuery = lineupsRef.where('player_id', '==', playerId);
                const lineupsSnap = await lineupsQuery.get();

                if (!lineupsSnap.empty) {
                    const batch = db.batch();
                    lineupsSnap.forEach(doc => {
                        batch.update(doc.ref, { player_handle: newPlayerHandle });
                    });
                    await batch.commit();
                }
            }
        }

        // 5. Propagate handle change to collections with handles in arrays
        console.log(`Propagating handle change to live games, pending lineups, and transactions...`);
        const arrayCollectionsToUpdate = ['live_games', 'pending_lineups'];
        for (const collName of arrayCollectionsToUpdate) {
            const collectionRef = db.collection(getCollectionName(collName, league));
            const snap = await collectionRef.get();
            if (snap.empty) continue;

            const batch = db.batch();
            snap.forEach(doc => {
                const data = doc.data();
                let wasModified = false;

                ['team1_lineup', 'team2_lineup'].forEach(lineupKey => {
                    if (data[lineupKey] && Array.isArray(data[lineupKey])) {
                        data[lineupKey].forEach(player => {
                            if (player.player_id === playerId && player.player_handle !== newPlayerHandle) {
                                player.player_handle = newPlayerHandle;
                                wasModified = true;
                            }
                        });
                    }
                });

                if (wasModified) {
                    batch.update(doc.ref, data);
                }
            });
            await batch.commit();
        }

        const transactionSeasonsRef = db.collection(getCollectionName('transactions', league)).doc('seasons');
        const transactionSeasonsSnap = await transactionSeasonsRef.listCollections();
        for (const collectionRef of transactionSeasonsSnap) {
            const snap = await collectionRef.get();
            if(snap.empty) continue;

            const batch = db.batch();
            snap.forEach(doc => {
                const data = doc.data();
                let wasModified = false;
                if (data.involved_players && Array.isArray(data.involved_players)) {
                    data.involved_players.forEach(player => {
                        if (player.id === playerId && player.player_handle !== newPlayerHandle) {
                            player.player_handle = newPlayerHandle;
                            wasModified = true;
                        }
                    });
                }
                if(wasModified) {
                    batch.update(doc.ref, { involved_players: data.involved_players });
                }
            });
            await batch.commit();
        }


        // 6. Propagate handle change to draft results
        console.log(`Propagating handle change to draft results...`);
        const draftResultsParentSnap = await db.collection(getCollectionName('draft_results', league)).get();
        for (const doc of draftResultsParentSnap.docs) {
            const collections = await doc.ref.listCollections();
            for (const collectionRef of collections) {
                const draftPicksQuery = collectionRef.where('player_id', '==', playerId);
                const draftPicksSnap = await draftPicksQuery.get();
                if (!draftPicksSnap.empty) {
                    const batch = db.batch();
                    draftPicksSnap.forEach(pickDoc => {
                        batch.update(pickDoc.ref, { player_handle: newPlayerHandle });
                    });
                    await batch.commit();
                }
            }
        }

        // 7. NEW: Propagate handle change to award documents
        console.log(`Propagating handle change to award documents...`);
        const awardsParentSnap = await db.collection(getCollectionName('awards', league)).get();
        for (const doc of awardsParentSnap.docs) {
            const collections = await doc.ref.listCollections();
            for (const collectionRef of collections) {
                const awardsSnap = await collectionRef.get();
                if (awardsSnap.empty) continue;

                const batch = db.batch();
                awardsSnap.forEach(awardDoc => {
                    const data = awardDoc.data();
                    let wasModified = false;

                    // Case 1: Award has a top-level player_id
                    if (data.player_id === playerId && data.player_handle !== newPlayerHandle) {
                        data.player_handle = newPlayerHandle;
                        wasModified = true;
                    }

                    // Case 2: Award has a 'players' array
                    if (data.players && Array.isArray(data.players)) {
                        data.players.forEach(player => {
                            if (player.player_id === playerId && player.player_handle !== newPlayerHandle) {
                                player.player_handle = newPlayerHandle;
                                wasModified = true;
                            }
                        });
                    }

                    if (wasModified) {
                        batch.update(awardDoc.ref, data);
                    }
                });
                await batch.commit();
            }
        }


        return { success: true, league, message: `Successfully updated player ${newPlayerHandle} and all associated records.` };

    } catch (error) {
        console.error(`CRITICAL ERROR during player handle update for ${playerId}:`, error);
        throw new HttpsError('internal', `Player update failed: ${error.message}`);
    }
});
