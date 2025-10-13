// functions/index.js

const { onDocumentUpdated, onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const fetch = require("node-fetch");
const { CloudSchedulerClient } = require("@google-cloud/scheduler");
const schedulerClient = new CloudSchedulerClient();
const { GoogleGenerativeAI } = require("@google/generative-ai");

admin.initializeApp();
const db = admin.firestore();

const USE_DEV_COLLECTIONS = false;
/**
 * Sets or updates a lineup submission deadline for a specific date.
 * Admin-only function.
 * @param {object} data - The data object from the client.
 * @param {string} data.date - The date for the deadline in 'M/D/YYYY' format.
 * @param {string} data.time - The time for the deadline in 'HH:MM' 24-hour format.
 * @param {string} data.timeZone - The IANA time zone name (e.g., 'America/Chicago').
 */
exports.setLineupDeadline = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    const { date, time, timeZone } = request.data;
    if (!date || !time || !timeZone) {
        throw new HttpsError('invalid-argument', 'A valid date, time, and timezone are required.');
    }

    try {
        const [month, day, year] = date.split('/');
        const [hour, minute] = time.split(':');

        const intendedWallTimeAsUTC = new Date(Date.UTC(year, month - 1, day, hour, minute));

        const chicagoTimeString = intendedWallTimeAsUTC.toLocaleString("en-US", { timeZone: timeZone });

        const chicagoTimeAsUTC = new Date(chicagoTimeString);

        const offset = intendedWallTimeAsUTC.getTime() - chicagoTimeAsUTC.getTime();

        const deadlineDate = new Date(intendedWallTimeAsUTC.getTime() + offset);
        
        const deadlineId = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const deadlineRef = db.collection(getCollectionName('lineup_deadlines')).doc(deadlineId);

        await deadlineRef.set({
            deadline: admin.firestore.Timestamp.fromDate(deadlineDate),
            timeZone: timeZone,
            setBy: request.auth.uid,
            lastUpdated: FieldValue.serverTimestamp()
        });

        return { success: true, message: `Deadline for ${date} set to ${time} ${timeZone}.` };

    } catch (error) {
        console.error("Error setting lineup deadline:", error);
        throw new HttpsError('internal', 'An unexpected error occurred while setting the deadline.');
    }
});

exports.getScheduledJobTimes = onCall({ region: "us-central1" }, async (request) => {
    // 1. Security Check
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    const projectId = process.env.GCLOUD_PROJECT;
    const location = 'us-central1';

    const parseCronSchedule = (schedule) => {
        if (!schedule) return null;
        const parts = schedule.split(' ');
        const minute = String(parts[0]).padStart(2, '0');
        const hour = String(parts[1]).padStart(2, '0');
        return `${hour}:${minute}`;
    };

    // Helper to try fetching a job, resilient to naming convention differences
    const getJobSchedule = async (baseName) => {
        try {
            // First, try the name as provided (e.g., camelCase)
            const jobName = `firebase-schedule-${baseName}-${location}`;
            const jobPath = schedulerClient.jobPath(projectId, location, jobName);
            const [jobResponse] = await schedulerClient.getJob({ name: jobPath });
            return parseCronSchedule(jobResponse.schedule);
        } catch (e) {
            // If not found (error code 5), try an all-lowercase version as a fallback
            if (e.code === 5) {
                console.log(`Job with name '${baseName}' not found, trying lowercase fallback.`);
                try {
                    const lowercaseJobName = `firebase-schedule-${baseName.toLowerCase()}-${location}`;
                    const lowercaseJobPath = schedulerClient.jobPath(projectId, location, lowercaseJobName);
                    const [jobResponse] = await schedulerClient.getJob({ name: lowercaseJobPath });
                    return parseCronSchedule(jobResponse.schedule);
                } catch (e2) {
                     console.error(`Could not fetch job for '${baseName}' with either camelCase or lowercase name.`, e2);
                     return null;
                }
            } else {
                 console.error(`An unexpected error occurred fetching job for '${baseName}'.`, e);
                 return null;
            }
        }
    };
    
    try {
        const autoFinalizeTime = await getJobSchedule('autoFinalizeGames');
        const statUpdateTime = await getJobSchedule('updatePlayerRanks');

        return { success: true, autoFinalizeTime, statUpdateTime };

    } catch (error) {
        console.error("A critical error occurred while fetching Cloud Scheduler job times:", error);
        throw new HttpsError('internal', `Failed to fetch schedule times: ${error.message}`);
    }
});

exports.admin_recalculatePlayerStats = onCall({ region: "us-central1" }, async (request) => {
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
        const regLineupsSnap = await db.collection(getCollectionName('seasons')).doc(seasonId).collection(getCollectionName('lineups'))
            .where('player_id', '==', playerId).where('started', '==', 'TRUE').get();
        
        const postLineupsSnap = await db.collection(getCollectionName('seasons')).doc(seasonId).collection(getCollectionName('post_lineups'))
            .where('player_id', '==', playerId).where('started', '==', 'TRUE').get();

        const regAveragesSnap = await db.collection(getCollectionName('daily_averages')).doc(`season_${seasonNum}`).collection(getCollectionName(`S${seasonNum}_daily_averages`)).get();
        const postAveragesSnap = await db.collection(getCollectionName('post_daily_averages')).doc(`season_${seasonNum}`).collection(getCollectionName(`S${seasonNum}_post_daily_averages`)).get();
        
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
        const playerStatsRef = db.collection(getCollectionName('v2_players')).doc(playerId).collection(getCollectionName('seasonal_stats')).doc(seasonId);
        batch.set(playerStatsRef, statsUpdate, { merge: true });
        await batch.commit();
        console.log(`Recalculation complete for player ${playerId}. Wrote updated stats.`);

        // 5. Trigger a full ranking update to ensure ranks are correct
        console.log("Triggering leaderboard rank update to reflect changes...");
        await performPlayerRankingUpdate();
        console.log("Leaderboard rank update complete.");

        return { success: true, message: `Successfully recalculated all seasonal stats for player ${playerId}.` };

    } catch (error) {
        console.error(`CRITICAL ERROR during stats recalculation for player ${playerId}:`, error);
        throw new HttpsError('internal', `Recalculation failed: ${error.message}`);
    }
});

exports.admin_updatePlayerId = onCall({ region: "us-central1" }, async (request) => {
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

    const oldPlayerRef = db.collection(getCollectionName('v2_players')).doc(oldPlayerId);
    const newPlayerRef = db.collection(getCollectionName('v2_players')).doc(newPlayerId);

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

        const statsSnap = await oldPlayerRef.collection(getCollectionName('seasonal_stats')).get();
        statsSnap.forEach(doc => {
            const newStatRef = newPlayerRef.collection(getCollectionName('seasonal_stats')).doc(doc.id);
            primaryBatch.set(newStatRef, doc.data());
        });
        await primaryBatch.commit();
        console.log(`Successfully created new player doc ${newPlayerId} and copied stats.`);

        // Step 4: Update All References (WITH BATCHING LOGIC)
        // ======================= MODIFICATION START =======================
        let referenceUpdateBatch = db.batch();
        let operationCount = 0;
        const BATCH_LIMIT = 490; // Keep it safely under 500
        let totalLineupsMigrated = 0;
        // ======================= MODIFICATION END =======================

        const seasonsSnap = await db.collection(getCollectionName('seasons')).get();

        for (const seasonDoc of seasonsSnap.docs) {
            const collectionTypes = ['lineups', 'post_lineups', 'exhibition_lineups'];

            for (const type of collectionTypes) {
                const lineupsRef = seasonDoc.ref.collection(getCollectionName(type));
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
                    
                    // ======================= MODIFICATION START =======================
                    operationCount += 2; // 1 set + 1 delete

                    if (operationCount >= BATCH_LIMIT) {
                        console.log(`Committing batch of ${operationCount} operations...`);
                        await referenceUpdateBatch.commit();
                        referenceUpdateBatch = db.batch();
                        operationCount = 0;
                    }
                    // ======================= MODIFICATION END =======================
                }
            }
        }
        console.log(`Total lineups to migrate: ${totalLineupsMigrated}`);
        
        // Update draft results and GM references (these are low volume and can be in the same batch)
        const draftResultsQuery = db.collectionGroup(getCollectionName('draft_results')).where('player_id', '==', oldPlayerId);
        const draftResultsSnap = await draftResultsQuery.get();
        draftResultsSnap.forEach(doc => {
            referenceUpdateBatch.update(doc.ref, { player_id: newPlayerId });
            operationCount++;
        });

        const gmTeamsQuery = db.collection(getCollectionName('v2_teams')).where('gm_player_id', '==', oldPlayerId);
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
            deletionBatch.delete(oldPlayerRef.collection(getCollectionName('seasonal_stats')).doc(doc.id));
        });
        deletionBatch.delete(oldPlayerRef);
        await deletionBatch.commit();
        console.log(`Successfully deleted old player document ${oldPlayerId}.`);

        // Step 6: Log the action and return success
        // ... (rest of the function is the same)
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

        return { success: true, message: `Player ${playerData.player_handle} successfully migrated from ${oldPlayerId} to ${newPlayerId}.` };

    } catch (error) {
        console.error("CRITICAL ERROR during player ID migration:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError('internal', `Migration failed: ${error.message}`);
    }
});

// New helper function to check for admin or scorekeeper roles
async function isScorekeeperOrAdmin(auth) {
    if (!auth) return false;
    const userDoc = await db.collection(getCollectionName('users')).doc(auth.uid).get();
    if (!userDoc.exists) return false;
    const role = userDoc.data().role;
    return role === 'admin' || role === 'scorekeeper';
}

// New helper function to get user role
async function getUserRole(auth) {
    if (!auth) return null;
    const userDoc = await db.collection(getCollectionName('users')).doc(auth.uid).get();
    return userDoc.exists ? userDoc.data().role : null;
}

exports.logScorekeeperActivity = onCall({ region: "us-central1" }, async (request) => {
    if (!(await isScorekeeperOrAdmin(request.auth))) {
        throw new HttpsError('permission-denied', 'Must be an admin or scorekeeper to log an action.');
    }

    const { action, details } = request.data;
    if (!action) {
        throw new HttpsError('invalid-argument', 'An "action" must be provided.');
    }

    const userId = request.auth.uid;
    const userEmail = request.auth.token.email || null; 

    try {
        const logRef = db.collection(getCollectionName('scorekeeper_activity_log')).doc();
        await logRef.set({
            action: action,
            userId: userId,
            userEmail: userEmail,
            userRole: await getUserRole(request.auth),
            timestamp: FieldValue.serverTimestamp(),
            details: details || null
        });
        return { success: true, message: "Activity logged successfully." };

    } catch (error) {
        console.error("Error logging scorekeeper activity:", error);
        throw new HttpsError('internal', 'Could not log activity.');
    }
});

exports.updateScheduledJobTimes = onCall({ region: "us-central1" }, async (request) => {
    // 1. Security: Ensure the user is an admin
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    // 2. Get and validate the times from the frontend
    const { autoFinalizeTime, statUpdateTime } = request.data;
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/; // Validates HH:MM format
    if (!autoFinalizeTime || !statUpdateTime || !timeRegex.test(autoFinalizeTime) || !timeRegex.test(statUpdateTime)) {
        throw new HttpsError('invalid-argument', 'Please provide valid times in HH:MM format.');
    }

    // 3. Define the jobs to be updated
    const projectId = process.env.GCLOUD_PROJECT;
    const location = 'us-central1';
    const timeZone = 'America/Chicago';

    const jobsToUpdate = {
        autoFinalize: {
            name: 'autoFinalizeGames',
            time: autoFinalizeTime
        },
        statUpdates: {
            names: [
                'scheduledLiveScoringShutdown',
                'updatePlayerRanks',
                'updatePerformanceLeaderboards',
                'updateCurrentWeek',
                'updatePlayoffBracket'
            ],
            time: statUpdateTime
        }
    };

    try {
        const updatePromises = [];

        const getCronSchedule = (time) => {
            const [hour, minute] = time.split(':');
            return `${parseInt(minute)} ${parseInt(hour)} * * *`;
        };

        const autoFinalizeJobName = `firebase-schedule-${jobsToUpdate.autoFinalize.name}-${location}`;
        const autoFinalizeJobPath = schedulerClient.jobPath(projectId, location, autoFinalizeJobName);
        updatePromises.push(schedulerClient.updateJob({
            job: {
                name: autoFinalizeJobPath,
                schedule: getCronSchedule(jobsToUpdate.autoFinalize.time),
                timeZone: timeZone,
            },
            updateMask: { paths: ['schedule', 'time_zone'] }
        }));

        jobsToUpdate.statUpdates.names.forEach(name => {
            const jobName = `firebase-schedule-${name}-${location}`;
            const jobPath = schedulerClient.jobPath(projectId, location, jobName);
            updatePromises.push(schedulerClient.updateJob({
                job: {
                    name: jobPath,
                    schedule: getCronSchedule(jobsToUpdate.statUpdates.time),
                    timeZone: timeZone,
                },
                updateMask: { paths: ['schedule', 'time_zone'] }
            }));
        });

        await Promise.all(updatePromises);

        console.log(`Successfully updated schedules. Finalize: ${autoFinalizeTime}, Stats: ${statUpdateTime}`);
        return { success: true, message: "Scheduled job times have been successfully updated!" };

    } catch (error) {
        console.error("Error updating Cloud Scheduler jobs:", error);
        throw new HttpsError('internal', `Failed to update schedules: ${error.message}`);
    }
});

const getCollectionName = (baseName) => {
    if (baseName.includes('_daily_scores') || baseName.includes('_daily_averages') || baseName.includes('_lineups') || baseName.includes('_games') || baseName.includes('_draft_results') || baseName.includes('live_scoring_status') || baseName.includes('usage_stats') || baseName.includes('archived_live_games') || baseName.includes('scorekeeper_activity_log') || baseName.includes('pending_lineups') || baseName.includes('pending_transactions')) {
        return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
    }
    return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
};

exports.rebrandTeam = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    const { oldTeamId, newTeamId, newTeamName } = request.data;
    if (!oldTeamId || !newTeamId || !newTeamName) {
        throw new HttpsError('invalid-argument', 'Missing required parameters for rebranding.');
    }

    console.log(`Starting rebrand for ${oldTeamId} to ${newTeamId} (${newTeamName})`);

    try {
        const batch = db.batch();

        const activeSeasonSnap = await db.collection(getCollectionName('seasons')).where('status', '==', 'active').limit(1).get();
        if (activeSeasonSnap.empty) {
            throw new HttpsError('failed-precondition', 'No active season found.');
        }
        const activeSeasonId = activeSeasonSnap.docs[0].id;

        const oldTeamRef = db.collection(getCollectionName('v2_teams')).doc(oldTeamId);
        const oldTeamDoc = await oldTeamRef.get();
        if (!oldTeamDoc.exists) {
            throw new HttpsError('not-found', `Old team with ID ${oldTeamId} not found.`);
        }

        const newTeamRef = db.collection(getCollectionName('v2_teams')).doc(newTeamId);
        const newTeamData = { ...oldTeamDoc.data(), team_id: newTeamId, gm_player_id: oldTeamDoc.data().gm_player_id || null };
        batch.set(newTeamRef, newTeamData);

        const oldRecordsSnap = await oldTeamRef.collection(getCollectionName('seasonal_records')).get();
        oldRecordsSnap.forEach(doc => {
            const newRecordRef = newTeamRef.collection(getCollectionName('seasonal_records')).doc(doc.id);
            let recordData = doc.data();
            if (doc.id === activeSeasonId) {
                recordData.team_id = newTeamId;
                recordData.team_name = newTeamName;
            }
            batch.set(newRecordRef, recordData);
        });
        
        const playersQuery = db.collection(getCollectionName('v2_players')).where('current_team_id', '==', oldTeamId);
        const playersSnap = await playersQuery.get();
        playersSnap.forEach(doc => {
            batch.update(doc.ref, { current_team_id: newTeamId });
        });
        console.log(`Found and updated ${playersSnap.size} players.`);

        const picksOwnerQuery = db.collection(getCollectionName('draftPicks')).where('current_owner', '==', oldTeamId);
        const picksOriginalQuery = db.collection(getCollectionName('draftPicks')).where('original_team', '==', oldTeamId);

        const [ownerPicksSnap, originalPicksSnap] = await Promise.all([picksOwnerQuery.get(), picksOriginalQuery.get()]);
        
        const allPicksToUpdate = new Map();
        ownerPicksSnap.forEach(doc => allPicksToUpdate.set(doc.id, doc.data()));
        originalPicksSnap.forEach(doc => allPicksToUpdate.set(doc.id, doc.data()));

        for (const [pickId, pickData] of allPicksToUpdate.entries()) {
            const oldPickRef = db.collection(getCollectionName('draftPicks')).doc(pickId);
            
            if (pickData.pick_description && pickData.pick_description.includes(oldTeamId)) {
                pickData.pick_description = pickData.pick_description.replace(oldTeamId, newTeamId);
            }

            if (pickId.includes(oldTeamId)) {
                const newPickId = pickId.replace(oldTeamId, newTeamId);
                const newPickRef = db.collection(getCollectionName('draftPicks')).doc(newPickId);
                const newPickData = { ...pickData, pick_id: newPickId };
                if (newPickData.current_owner === oldTeamId) newPickData.current_owner = newTeamId;
                if (newPickData.original_team === oldTeamId) newPickData.original_team = newTeamId;
                if (newPickData.base_owner === oldTeamId) newPickData.base_owner = newTeamId;
                batch.set(newPickRef, newPickData);
                batch.delete(oldPickRef);
            } else {
                const updateData = {};
                if (pickData.current_owner === oldTeamId) updateData.current_owner = newTeamId;
                if (pickData.original_team === oldTeamId) updateData.original_team = newTeamId;
                if (pickData.base_owner === oldTeamId) updateData.base_owner = newTeamId;
                if (pickData.pick_description) {
                    updateData.pick_description = pickData.pick_description;
                }
                batch.update(oldPickRef, updateData);
            }
        }
        console.log(`Found and updated ${allPicksToUpdate.size} draft picks.`);

        await batch.commit();

        const deleteBatch = db.batch();
        const oldTeamRecordsToDeleteSnap = await oldTeamRef.collection(getCollectionName('seasonal_records')).get();
        oldTeamRecordsToDeleteSnap.forEach(doc => {
            deleteBatch.delete(doc.ref);
        });
        deleteBatch.delete(oldTeamRef);
        await deleteBatch.commit();

        console.log(`Rebrand complete. Old team ${oldTeamId} deleted.`);
        return { success: true, message: `Team ${oldTeamId} successfully rebranded to ${newTeamId}.` };

    } catch (error) {
        console.error("Error rebranding team:", error);
        throw new HttpsError('internal', `Failed to rebrand team: ${error.message}`);
    }
});



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
                
                const globalRank = parseInt(data?.stats?.karmaDayRank || -1, 10);
                
                const adjustedScore = rawScore - (player.deductions || 0);
                const finalScore = player.is_captain ? adjustedScore * 1.5 : adjustedScore;
                
                player.points_raw = rawScore;
                player.points_adjusted = adjustedScore;
                player.final_score = finalScore;
                
                player.global_rank = globalRank;

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
    if (!(await isScorekeeperOrAdmin(request.auth))) {
        throw new HttpsError('permission-denied', 'Must be an admin or scorekeeper to run this function.');
    }
    return await performFullUpdate();
});


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

        if (status === 'active') {
            updateData.last_sample_completed_at = FieldValue.serverTimestamp();
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


exports.scheduledSampler = onSchedule("every 1 minutes", async (event) => {
    const statusRef = db.doc(getCollectionName('live_scoring_status') + '/status');
    const statusSnap = await statusRef.get();

    if (!statusSnap.exists || statusSnap.data().status !== 'active') {
        console.log(`Sampler is not active (current status: ${statusSnap.data().status || 'stopped'}). Exiting.`);
        return null;
    }

    const { interval_minutes, last_sample_completed_at } = statusSnap.data();
    const now = new Date();
    
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

        const sampledPlayers = [];
        const usedIndices = new Set();
        while (sampledPlayers.length < 3 && usedIndices.size < allStarters.length) {
            const randomIndex = Math.floor(Math.random() * allStarters.length);
            if (!usedIndices.has(randomIndex)) {
                sampledPlayers.push(allStarters[randomIndex]);
                usedIndices.add(randomIndex);
            }
        }
        
        let karmaChangesDetected = 0;
        let rankChangesDetected = 0;
        let apiRequests = 0;
        const sampleResults = [];

        for (const player of sampledPlayers) {
            const workerUrl = `https://rkl-karma-proxy.caustic.workers.dev/?userId=${encodeURIComponent(player.player_id)}`;
            await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 1001) + 500)); 
            
            try {
                const response = await fetch(workerUrl);
                apiRequests++;
                const data = await response.json();

                const newRawScore = parseFloat(data?.stats?.karmaDelta || 0);
                const newGlobalRank = parseInt(data?.stats?.karmaDayRank || -1, 10);

                const oldRawScore = player.points_raw || 0;
                const oldGlobalRank = player.global_rank || -1;

                const karmaHasChanged = newRawScore !== oldRawScore;
                const rankHasChanged = newGlobalRank !== oldGlobalRank;

                if (karmaHasChanged) karmaChangesDetected++;
                if (rankHasChanged) rankChangesDetected++;
                
                sampleResults.push({ 
                    handle: player.player_handle, 
                    oldScore: oldRawScore, 
                    newScore: newRawScore, 
                    karmaChanged: karmaHasChanged,
                    oldRank: oldGlobalRank,
                    newRank: newGlobalRank,
                    rankChanged: rankHasChanged
                });

            } catch (error) { console.error(`Sampler failed to fetch karma for ${player.player_id}`, error); }
        }

        await statusRef.set({ 
            last_sample_results: sampleResults,
            last_sample_completed_at: FieldValue.serverTimestamp()
        }, { merge: true });

        const usageRef = db.doc(`${getCollectionName('usage_stats')}/${gameDate}`);
        await usageRef.set({ api_requests_sample: FieldValue.increment(apiRequests) }, { merge: true });

        if (karmaChangesDetected >= 2 || rankChangesDetected >= 2) {
            console.log(`Sampler detected changes (Karma: ${karmaChangesDetected}, Rank: ${rankChangesDetected}). Triggering full update.`);
            await performFullUpdate();
        } else {
            console.log(`Sampler detected insufficient changes (Karma: ${karmaChangesDetected}, Rank: ${rankChangesDetected}). No update triggered.`);
        }
    } else {
        return null;
    }
    return null;
});

// functions/index.js

exports.admin_updatePlayerDetails = onCall({ region: "us-central1" }, async (request) => {
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
        const playerRef = db.collection(getCollectionName('v2_players')).doc(playerId);
        
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
        const seasonStatsRef = playerRef.collection(getCollectionName('seasonal_stats')).doc(seasonId);
        mainBatch.set(seasonStatsRef, {
            rookie: isRookie ? '1' : '0',
            all_star: isAllStar ? '1' : '0'
        }, { merge: true });

        await mainBatch.commit();
        console.log(`Updated core doc and accolades for ${playerId}.`);

        // 4. Propagate handle change to all historical lineups
        console.log(`Propagating handle change to lineup documents...`);
        const seasonsSnap = await db.collection(getCollectionName('seasons')).get();
        for (const seasonDoc of seasonsSnap.docs) {
            const lineupTypes = ['lineups', 'post_lineups', 'exhibition_lineups'];
            for (const type of lineupTypes) {
                const lineupsRef = seasonDoc.ref.collection(getCollectionName(type));
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
            const collectionRef = db.collection(getCollectionName(collName));
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
        
        const transactionSeasonsRef = db.collection(getCollectionName('transactions')).doc('seasons');
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
        const draftResultsParentSnap = await db.collection(getCollectionName('draft_results')).get();
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
        const awardsParentSnap = await db.collection(getCollectionName('awards')).get();
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


        return { success: true, message: `Successfully updated player ${newPlayerHandle} and all associated records.` };

    } catch (error) {
        console.error(`CRITICAL ERROR during player handle update for ${playerId}:`, error);
        throw new HttpsError('internal', `Player update failed: ${error.message}`);
    }
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


exports.stageLiveLineups = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth) {
        throw new HttpsError('permission-denied', 'You must be logged in to submit a lineup.');
    }

    const { gameId, seasonId, collectionName, gameDate, team1_lineup, team2_lineup, submittingTeamId } = request.data;
    const isGmSubmission = !!submittingTeamId;

    if (!gameId || !seasonId || !collectionName || !gameDate) {
        throw new HttpsError('invalid-argument', 'Missing required game parameters.');
    }
    if (!team1_lineup && !team2_lineup) {
        throw new HttpsError('invalid-argument', 'At least one team lineup must be provided.');
    }

    const logBatch = db.batch();
    const submissionLogRef = db.collection(getCollectionName('lineup_submission_logs')).doc();
    const isTeam1Submitting = team1_lineup && team1_lineup.length === 6;
    const isTeam2Submitting = team2_lineup && team2_lineup.length === 6;

    logBatch.set(submissionLogRef, {
        gameId,
        gameDate,
        userId: request.auth.uid,
        submittingTeamId: submittingTeamId || 'admin_submission',
        submittedLineup: isTeam1Submitting ? team1_lineup : (isTeam2Submitting ? team2_lineup : null),
        timestamp: FieldValue.serverTimestamp(),
        status: 'initiated'
    });
    await logBatch.commit();

    try {
        if (isGmSubmission) {
            const [month, day, year] = gameDate.split('/');
            const deadlineId = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const deadlineRef = db.collection(getCollectionName('lineup_deadlines')).doc(deadlineId);
            const deadlineDoc = await deadlineRef.get();

            if (!deadlineDoc.exists) {
                await submissionLogRef.update({ status: 'failure', reason: 'No deadline set for this game date.' });
                throw new HttpsError('failed-precondition', 'Lineup submissions are not yet open for this game date.');
            }

            const deadline = deadlineDoc.data().deadline.toDate();
            const now = new Date();
            const gracePeriodEnd = new Date(deadline.getTime() + 150 * 60 * 1000);
            const lateNoCaptainEnd = new Date(deadline.getTime() + 10 * 60 * 1000);

            if (now > gracePeriodEnd) {
                await submissionLogRef.update({ status: 'failure', reason: 'Submission window closed.' });
                throw new HttpsError('deadline-exceeded', 'The lineup submission window has closed for this game.');
            }

            const submittingLineup = isTeam1Submitting ? team1_lineup : team2_lineup;
            const hasCaptain = submittingLineup.some(p => p.is_captain);

            if (hasCaptain && now > lateNoCaptainEnd) {
                await submissionLogRef.update({ status: 'failure', reason: 'Late submission with captain.' });
                throw new HttpsError('invalid-argument', 'Your submission is late. You must remove your captain selection to submit.');
            }

            if (!hasCaptain && now <= lateNoCaptainEnd) {
                await submissionLogRef.update({ status: 'failure', reason: 'On-time submission missing captain.' });
                throw new HttpsError('invalid-argument', 'You must select a captain for your lineup.');
            }
        }

        const liveGameRef = db.collection(getCollectionName('live_games')).doc(gameId);
        const liveGameSnap = await liveGameRef.get();

        if (liveGameSnap.exists) {
            console.log(`Game ${gameId} is already live. Updating existing document.`);
            const liveGameData = liveGameSnap.data();
            const updateData = {};
            const oldPlayerScores = new Map();
            [...(liveGameData.team1_lineup || []), ...(liveGameData.team2_lineup || [])].forEach(p => {
                oldPlayerScores.set(p.player_id, {
                    points_raw: p.points_raw || 0,
                    points_adjusted: p.points_adjusted || 0,
                    final_score: p.final_score || 0,
                    global_rank: p.global_rank || 0
                });
            });

            if (team1_lineup && team1_lineup.length === 6) {
                updateData.team1_lineup = team1_lineup.map(p => ({ ...(oldPlayerScores.get(p.player_id) || {}), ...p }));
            }
            if (team2_lineup && team2_lineup.length === 6) {
                updateData.team2_lineup = team2_lineup.map(p => ({ ...(oldPlayerScores.get(p.player_id) || {}), ...p }));
            }

            if (Object.keys(updateData).length > 0) {
                await liveGameRef.update(updateData);
            }
            
            await submissionLogRef.update({ status: 'success', details: 'Updated live game document.' });
            return { success: true, message: "Live game lineup has been successfully updated." };
        }

        const pendingRef = db.collection(getCollectionName('pending_lineups')).doc(gameId);
        const dataToSet = {
            seasonId,
            collectionName,
            gameDate,
            lastUpdatedBy: request.auth.uid,
            lastUpdated: FieldValue.serverTimestamp()
        };

        if (isTeam1Submitting) {
            dataToSet.team1_lineup = team1_lineup;
            dataToSet.team1_submitted = true;
        }
        if (isTeam2Submitting) {
            dataToSet.team2_lineup = team2_lineup;
            dataToSet.team2_submitted = true;
        }

        await pendingRef.set(dataToSet, { merge: true });

        const updatedPendingDoc = await pendingRef.get();
        if (updatedPendingDoc.exists) {
            const data = updatedPendingDoc.data();
            
            const nowInChicago = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
            let gamedayInChicago = new Date(nowInChicago);

            if (gamedayInChicago.getHours() < 6) {
                gamedayInChicago.setDate(gamedayInChicago.getDate() - 1);
            }

            const todayStr = `${gamedayInChicago.getMonth() + 1}/${gamedayInChicago.getDate()}/${gamedayInChicago.getFullYear()}`;
            
            if (data.gameDate === todayStr && data.team1_submitted === true && data.team2_submitted === true) {
                console.log(`Game ${gameId} is ready for immediate activation.`);
                const batch = db.batch();
                batch.set(liveGameRef, {
                    seasonId: data.seasonId,
                    collectionName: data.collectionName,
                    team1_lineup: data.team1_lineup,
                    team2_lineup: data.team2_lineup,
                    activatedAt: FieldValue.serverTimestamp()
                });
                batch.delete(pendingRef);
                await batch.commit();
                console.log(`Game ${gameId} successfully activated and moved to live_games.`);
            }
        }
        
        await submissionLogRef.update({ status: 'success' });
        return { success: true, message: "Lineup has been successfully submitted." };

    } catch (error) {
        if (!(error instanceof HttpsError)) {
             console.error(`Error staging lineups for game ${gameId}:`, error);
             await submissionLogRef.update({ status: 'failure', reason: `Internal error: ${error.message}` });
             throw new HttpsError('internal', `Could not stage lineups: ${error.message}`);
        } else {
            throw error;
        }
    }
});

exports.processPendingLiveGames = onSchedule({
    schedule: "15 6 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    console.log("Running scheduled job to process pending live games.");

    const today = new Date();
    const dateString = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;

    const pendingGamesQuery = db.collection(getCollectionName('pending_lineups'))
        .where('gameDate', '==', dateString)
        .where('team1_submitted', '==', true)
        .where('team2_submitted', '==', true);

    try {
        const pendingGamesSnap = await pendingGamesQuery.get();
        if (pendingGamesSnap.empty) {
            console.log(`No pending games with both lineups submitted for ${dateString}.`);
            return null;
        }

        console.log(`Found ${pendingGamesSnap.size} games to activate for live scoring.`);
        const activationBatch = db.batch();

        for (const doc of pendingGamesSnap.docs) {
            const gameId = doc.id;
            const data = doc.data();

            const liveGameRef = db.collection(getCollectionName('live_games')).doc(gameId);
            activationBatch.set(liveGameRef, {
                seasonId: data.seasonId,
                collectionName: data.collectionName,
                team1_lineup: data.team1_lineup,
                team2_lineup: data.team2_lineup,
                activatedAt: FieldValue.serverTimestamp()
            });


            activationBatch.delete(doc.ref);
        }

        await activationBatch.commit();
        console.log("Successfully activated and cleared pending games.");

    } catch (error) {
        console.error("Error during scheduled processing of pending games:", error);
    }
    return null;
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
        // Use a batch to perform an atomic write and delete
        const batch = db.batch();

        // Set the new document in the live_games collection
        const liveGameRef = db.collection(getCollectionName('live_games')).doc(gameId);
        batch.set(liveGameRef, {
            seasonId,
            collectionName,
            team1_lineup,
            team2_lineup,
            activatedAt: FieldValue.serverTimestamp()
        });

        // Delete the now-obsolete document from the pending_lineups collection
        const pendingGameRef = db.collection(getCollectionName('pending_lineups')).doc(gameId);
        batch.delete(pendingGameRef);

        // Commit both operations
        await batch.commit();

        return { success: true, message: "Game activated for live scoring and pending entry was cleared." };
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

        await processAndFinalizeGame(liveGameSnap, false); 

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
    schedule: "every day 05:00",
    timeZone: "America/Chicago", 
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
            week: gameData.week,
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
    schedule: "15 5 * * *", 
    timeZone: "America/Chicago",
}, async (event) => {
    console.log("Running scheduled job to set live scoring status to 'stopped'.");

    try {
        const statusRef = db.doc(`${getCollectionName('live_scoring_status')}/status`);
        
        await statusRef.set({
            status: 'stopped',
            last_updated_by: 'automated_shutdown',
            last_updated: FieldValue.serverTimestamp()
        }, { merge: true }); 

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
        const teamRootData = teamDoc.data(); 

        const activeRecordRef = teamDoc.ref.collection(getCollectionName("seasonal_records")).doc(activeSeasonId);
        const activeRecordSnap = await activeRecordRef.get();
        const teamName = activeRecordSnap.exists ? activeRecordSnap.data().team_name : "Name Not Found";

        batch.set(recordRef, {
            season: seasonId,
            team_id: teamDoc.id,
            apPAM: 0, apPAM_count: 0, apPAM_total: 0, elim: 0, losses: 0, MaxPotWins: 0, med_starter_rank: 0, msr_rank: 0, pam: 0, pam_rank: 0, playin: 0,
            playoffs: 0, post_losses: 0, post_med_starter_rank: 0, post_msr_rank: 0, post_pam: 0, post_pam_rank: 0, post_wins: 0, postseed: 0, sortscore: 0,
            wins: 0, wpct: 0, total_transactions: 0,
            tREL: 0,
            post_tREL: 0,
            team_name: teamName,
            gm_player_id: teamRootData.gm_player_id || null 
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
            current_week: "1",
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
        throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const { seasonNumber } = request.data;
    if (!seasonNumber) {
        throw new HttpsError('invalid-argument', 'A seasonNumber must be provided.');
    }

    const activeSeasonQuery = db.collection(getCollectionName('seasons')).where('status', '==', 'active').limit(1);
    const activeSeasonSnap = await activeSeasonQuery.get();

    if (activeSeasonSnap.empty) {
        throw new HttpsError('failed-precondition', 'Could not determine the current active season. Aborting.');
    }

    const activeSeasonId = activeSeasonSnap.docs[0].id;
    const activeSeasonNum = parseInt(activeSeasonId.replace('S', ''), 10);

    if (seasonNumber >= activeSeasonNum) {
        throw new HttpsError('failed-precondition', `Historical season (${seasonNumber}) must be less than the current active season (S${activeSeasonNum}).`);
    }

    const seasonDoc = await db.doc(`${getCollectionName('seasons')}/S${seasonNumber}`).get();
    if (seasonDoc.exists) {
        throw new HttpsError('already-exists', `Season S${seasonNumber} already exists in the database.`);
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
        throw new HttpsError('internal', `Failed to create historical season: ${error.message}`);
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
        throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const { seasonId, dates } = request.data;
    if (!seasonId || !dates) {
        throw new HttpsError('invalid-argument', 'Missing seasonId or dates.');
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
            throw new HttpsError('failed-precondition', 'Not all teams have a final postseed. Ensure the regular season is complete.');
        }

        const batch = db.batch();
        const postGamesRef = db.collection(`${getCollectionName('seasons')}/${seasonId}/${getCollectionName('post_games')}`);

        const existingGamesSnap = await postGamesRef.get();
        existingGamesSnap.forEach(doc => batch.delete(doc.ref));
        console.log(`Cleared ${existingGamesSnap.size} existing postseason games.`);

        const TBD_TEAM = { id: 'TBD', team_name: 'TBD', postseed: '' };

        const createSeries = (week, seriesName, numGames, team1, team2, dateArray) => {
            if (!dateArray || dateArray.length < numGames) {
                throw new Error(`Not enough dates provided for ${week} (${seriesName}). Expected ${numGames}, got ${dateArray?.length || 0}.`);
            }
            const series_id = seriesName;

            for (let i = 0; i < numGames; i++) {
                const gameDate = dateArray[i];
                const gameData = {
                    week, 
                    series_name: `${seriesName} Game ${i + 1}`, 
                    date: gameDate,
                    team1_id: team1.id, 
                    team2_id: team2.id,
                    team1_seed: team1.postseed || '',
                    team2_seed: team2.postseed || '',
                    completed: 'FALSE', 
                    team1_score: 0, 
                    team2_score: 0, 
                    winner: '',
                    series_id: series_id,
                    team1_wins: 0,
                    team2_wins: 0,
                    series_winner: ''
                };

                const formattedDateForId = gameDate.replace(/\//g, "-");
                const docRef = (team1.id === 'TBD' || team2.id === 'TBD')
                    ? postGamesRef.doc()
                    : postGamesRef.doc(`${formattedDateForId}-${team1.id}-${team2.id}`);
                batch.set(docRef, gameData);
            }
        };

        console.log("Generating Play-In games...");
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
        createSeries('Round 1', 'W2vW7', 3, westConf[1], TBD_TEAM, dates['Round 1']);

        console.log("Generating Round 2 schedule...");
        createSeries('Round 2', 'E-R2-T', 3, TBD_TEAM, TBD_TEAM, dates['Round 2']);
        createSeries('Round 2', 'E-R2-B', 3, TBD_TEAM, TBD_TEAM, dates['Round 2']);
        createSeries('Round 2', 'W-R2-T', 3, TBD_TEAM, TBD_TEAM, dates['Round 2']);
        createSeries('Round 2', 'W-R2-B', 3, TBD_TEAM, TBD_TEAM, dates['Round 2']);

        console.log("Generating Conference Finals schedule...");
        createSeries('Conf Finals', 'ECF', 5, TBD_TEAM, TBD_TEAM, dates['Conf Finals']);
        createSeries('Conf Finals', 'WCF', 5, TBD_TEAM, TBD_TEAM, dates['Conf Finals']);

        console.log("Generating Finals schedule...");
        createSeries('Finals', 'Finals', 7, TBD_TEAM, TBD_TEAM, dates['Finals']);

        await batch.commit();
        return { message: "Postseason schedule generated successfully!" };

    } catch (error) {
        console.error("Error generating postseason schedule:", error);
        throw new HttpsError('internal', `Failed to generate schedule: ${error.message}`);
    }
});


exports.calculatePerformanceAwards = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth || !request.auth.uid) {
        throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const { seasonId } = request.data;
    if (!seasonId) {
        throw new HttpsError('invalid-argument', 'The function must be called with a "seasonId" argument.');
    }

    console.log(`Calculating performance awards for season: ${seasonId}`);
    const seasonNumber = seasonId.replace('S', '');

    try {
        const batch = db.batch();

        const awardsParentDocRef = db.doc(`${getCollectionName('awards')}/season_${seasonNumber}`);
        batch.set(awardsParentDocRef, { description: `Awards for Season ${seasonNumber}` }, { merge: true });

        const awardsCollectionRef = awardsParentDocRef.collection(getCollectionName(`S${seasonNumber}_awards`));

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
        let playerIdToWrite = null; // This will hold the player's ID to write back to the draft doc

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
            
            playerIdToWrite = newPlayerId; // Set the ID to be written back

            const playerRef = db.collection(getCollectionName('v2_players')).doc(newPlayerId);
            const existingPlayerSnap = await playerRef.get();

            if (existingPlayerSnap.exists) {
                console.log(`Player with ID '${newPlayerId}' already exists. Updating their bio and current team.`);
                batch.update(playerRef, {
                    bio: bio,
                    current_team_id: team_id
                });
            } else {
                batch.set(playerRef, {
                    player_handle: player_handle,
                    current_team_id: team_id,
                    player_status: 'ACTIVE',
                    bio: bio
                });

                const seasonStatsRef = playerRef.collection(getCollectionName('seasonal_stats')).doc(draftSeason);
                batch.set(seasonStatsRef, { ...initialStats, rookie: '1' });
            }

        } else { // Historical draft
            console.log(`Historical draft (${draftSeason}). Checking for existing player: ${player_handle}.`);
            const existingPlayerQuery = db.collection(getCollectionName('v2_players')).where('player_handle', '==', player_handle).limit(1);
            const existingPlayerSnap = await existingPlayerQuery.get();

            if (existingPlayerSnap.empty) {
                console.log(`Player not found. Creating new player for historical draft.`);
                const sanitizedHandle = player_handle.toLowerCase().replace(/[^a-z0-9]/g, '');
                const newPlayerId = `${sanitizedHandle}${draftSeason.replace('S', '')}${overall}`;
                playerIdToWrite = newPlayerId; // Set the ID to be written back
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
                const playerDoc = existingPlayerSnap.docs[0];
                playerIdToWrite = playerDoc.id; // Set the ID to be written back
                const playerRef = playerDoc.ref;
                batch.update(playerRef, { bio: bio });
                const seasonStatsRef = playerRef.collection(getCollectionName('seasonal_stats')).doc(draftSeason);
                batch.set(seasonStatsRef, { ...initialStats, rookie: '0' });
            }
        }

        // **NEW**: Write the determined player_id back to the draft result document
        if (playerIdToWrite) {
            console.log(`Updating draft result for pick ${overall} with player_id: ${playerIdToWrite}`);
            batch.update(event.data.ref, { player_id: playerIdToWrite });
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
    const transactionId = event.params.transactionId;

    if (transaction.schema !== 'v2') {
        console.log(`V2: Ignoring transaction ${transactionId} without v2 schema.`);
        return null;
    }

    console.log(`V2: Processing transaction ${transactionId} of type ${transaction.type}.`);

    try {
        const batch = db.batch();

        const activeSeasonQuery = db.collection(getCollectionName('seasons')).where('status', '==', 'active').limit(1);
        const activeSeasonSnap = await activeSeasonQuery.get();

        if (activeSeasonSnap.empty) {
            throw new Error('No active season found. Cannot process transaction.');
        }

        const activeSeasonDoc = activeSeasonSnap.docs[0];
        const activeSeasonId = activeSeasonDoc.id;
        const currentWeek = activeSeasonDoc.data().current_week || null;

        const involvedPlayers = transaction.involved_players || [];
        const involvedPicks = transaction.involved_picks || [];
        const involvedTeams = transaction.involved_teams || [];

        const playerIds = involvedPlayers.map(p => p.id);
        const teamIds = involvedTeams;

        const playerDocsPromises = playerIds.map(id => db.collection(getCollectionName('v2_players')).doc(id).get());
        const teamRecordDocsPromises = teamIds.map(id => {
            if (id === 'RETIRED' || id === 'FREE_AGENT') return Promise.resolve(null);
            return db.collection(getCollectionName('v2_teams')).doc(id).collection(getCollectionName('seasonal_records')).doc(activeSeasonId).get()
        });
        

        const [playerDocsSnap, teamRecordsDocsSnap] = await Promise.all([
            Promise.all(playerDocsPromises),
            Promise.all(teamRecordDocsPromises),
        ]);

        const playerHandlesMap = new Map(playerDocsSnap.map(doc => [doc.id, doc.data()?.player_handle]));
        const teamNamesMap = new Map(teamRecordsDocsSnap.filter(Boolean).map(doc => [doc.ref.parent.parent.id, doc.data()?.team_name]));


        for (const playerMove of involvedPlayers) {
            const playerRef = db.collection(getCollectionName('v2_players')).doc(playerMove.id);
            const newTeamId = playerMove.to;
            let updateData = {};

            switch (transaction.type) {
                case 'RETIREMENT':
                    updateData = {
                        current_team_id: 'RETIRED',
                        player_status: 'RETIRED'
                    };
                    break;
                case 'UNRETIREMENT':
                    updateData = {
                        current_team_id: newTeamId,
                        player_status: 'ACTIVE'
                    };
                    break;
                default: 
                    updateData = {
                        current_team_id: newTeamId
                    };
                    break;
            }
            
            batch.update(playerRef, updateData);
        }

        for (const pickMove of involvedPicks) {
            const pickRef = db.collection(getCollectionName('draftPicks')).doc(pickMove.id);
            const newOwnerId = pickMove.to;
            batch.update(pickRef, { current_owner: newOwnerId });
        }

        const enhancedInvolvedPlayers = involvedPlayers.map(p => ({
            ...p,
            player_handle: playerHandlesMap.get(p.id) || 'Unknown'
        }));
        const enhancedInvolvedTeams = involvedTeams.map(id => ({
            id: id,
            team_name: teamNamesMap.get(id) || 'Unknown'
        }));

        const newTransactionData = {
            ...transaction,
            involved_players: enhancedInvolvedPlayers,
            involved_teams: enhancedInvolvedTeams,
            season: activeSeasonId,
            week: currentWeek, 
            status: 'PROCESSED',
            processed_at: FieldValue.serverTimestamp()
        };

        const seasonTransactionsRef = db.collection(getCollectionName('transactions')).doc('seasons').collection(activeSeasonId);
        const newTransactionRef = seasonTransactionsRef.doc(transactionId);
        batch.set(newTransactionRef, newTransactionData);

        const originalTransactionRef = event.data.ref;
        batch.delete(originalTransactionRef);

        await batch.commit();

        console.log(`V2 Transaction ${transactionId} processed successfully and moved to season ${activeSeasonId}.`);

    } catch (error) {
        console.error(`Error processing V2 transaction ${transactionId}:`, error);
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

    const transactionId = event.params.transactionId;

    const activeSeasonQuery = db.collection(getCollectionName("seasons")).where("status", "==", "active").limit(1);
    const activeSeasonSnap = await activeSeasonQuery.get();

    if (activeSeasonSnap.empty) {
        console.error("Could not find an active season. Cannot update transaction counts.");
        return null;
    }
    const seasonId = activeSeasonSnap.docs[0].id;

    console.log(`V2: Updating transaction counts for transaction ${transactionId} in season ${seasonId}`);
    
    const involvedTeams = new Set(transaction.involved_teams || []);
    if (involvedTeams.size === 0) {
        console.log("No teams involved. Skipping transaction count update.");
        return null;
    }

    const batch = db.batch();
    const seasonRef = db.collection(getCollectionName('seasons')).doc(seasonId);

    batch.update(seasonRef, { season_trans: FieldValue.increment(1) });
    
    for (const teamId of involvedTeams) {
        const teamStatsRef = db.collection(getCollectionName('v2_teams')).doc(teamId).collection(getCollectionName('seasonal_records')).doc(seasonId);
        batch.update(teamStatsRef, { total_transactions: FieldValue.increment(1) });
    }

    await batch.commit();
    console.log(`Successfully updated transaction counts for teams: ${[...involvedTeams].join(', ')}`);

    return null;
});

exports.admin_processTransaction = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth || !request.auth.uid) {
        throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to process transactions.');
    }

    const transactionData = request.data;
    const involvedPlayerIds = (transactionData.involved_players || []).map(p => p.id);

    if (involvedPlayerIds.length === 0) {
        // Not a player transaction (e.g., draft pick only trade), process immediately
        await db.collection(getCollectionName("transactions")).add({ ...transactionData, date: FieldValue.serverTimestamp() });
        return { success: true, message: "Transaction logged successfully and will be processed immediately." };
    }

    try {
        const liveGamesSnap = await db.collection(getCollectionName('live_games')).get();
        const livePlayerIds = new Set();
        liveGamesSnap.forEach(doc => {
            const gameData = doc.data();
            [...(gameData.team1_lineup || []), ...(gameData.team2_lineup || [])].forEach(player => {
                livePlayerIds.add(player.player_id);
            });
        });

        const isPlayerInLiveGame = involvedPlayerIds.some(id => livePlayerIds.has(id));

        if (isPlayerInLiveGame) {
            // Player is in a live game, so hold the transaction
            await db.collection(getCollectionName('pending_transactions')).add({ ...transactionData, date: FieldValue.serverTimestamp() });
            return { success: true, message: "A player in this transaction is in a live game. The transaction is now pending and will be processed overnight." };
        } else {
            // No live players, process immediately
            await db.collection(getCollectionName('transactions')).add({ ...transactionData, date: FieldValue.serverTimestamp() });
            return { success: true, message: "Transaction logged successfully and will be processed immediately." };
        }

    } catch (error) {
        console.error("Error processing transaction:", error);
        throw new HttpsError('internal', 'An unexpected error occurred while processing the transaction.');
    }
});

/**
 * NEW SCHEDULED FUNCTION
 * Runs daily at 6:20 AM Central Time to process pending transactions.
 */
exports.releasePendingTransactions = onSchedule({
    schedule: "20 6 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    console.log("Running scheduled job to release pending transactions.");
    const pendingTransSnap = await db.collection(getCollectionName('pending_transactions')).get();

    if (pendingTransSnap.empty) {
        console.log("No pending transactions to release.");
        return null;
    }

    console.log(`Found ${pendingTransSnap.size} pending transactions to release.`);
    const batch = db.batch();

    for (const doc of pendingTransSnap.docs) {
        const transactionData = doc.data();
        
        // Create a new document in the main transactions collection
        const newTransactionRef = db.collection(getCollectionName('transactions')).doc();
        batch.set(newTransactionRef, transactionData);

        // Delete the old document from the pending collection
        batch.delete(doc.ref);
    }

    try {
        await batch.commit();
        console.log("Successfully released all pending transactions.");
    } catch (error) {
        console.error("Error releasing pending transactions:", error);
    }
    
    return null;
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

function calculateMean(numbers) {
    if (!numbers || numbers.length === 0) return 0;
    const sum = numbers.reduce((acc, val) => acc + val, 0);
    return sum / numbers.length;
}

function calculateGeometricMean(numbers) {
    if (numbers.length === 0) return 0;
    const nonZeroNumbers = numbers.filter(num => num > 0);
    if (nonZeroNumbers.length === 0) return 0;
    const product = nonZeroNumbers.reduce((prod, num) => prod * num, 1);
    return Math.pow(product, 1 / nonZeroNumbers.length);
}

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

    const playersCollectionRef = db.collection(getCollectionName('v2_players'));
    const allPlayersSnap = await playersCollectionRef.get();
    const playerStatsForTeams = new Map();
    const playerStatPromises = allPlayersSnap.docs.map(playerDoc => 
        playerDoc.ref.collection(getCollectionName('seasonal_stats')).doc(seasonId).get()
    );
    const seasonalStatsSnapForTeams = await Promise.all(playerStatPromises);

    seasonalStatsSnapForTeams.forEach(docSnap => {
        if (docSnap.exists) {
            const pathParts = docSnap.ref.path.split('/');
            const playerId = pathParts[pathParts.length - 3];
            playerStatsForTeams.set(playerId, docSnap.data());
        }
    });

    const teamRelDataMap = new Map();
    allPlayersSnap.forEach(playerDoc => {
        const playerData = playerDoc.data();
        const playerStats = playerStatsForTeams.get(playerDoc.id);
        const teamId = playerData.current_team_id;

        if (teamId && playerStats) {
            if (!teamRelDataMap.has(teamId)) {
                teamRelDataMap.set(teamId, {
                    weightedSum: 0,
                    totalGP: 0,
                    post_weightedSum: 0,
                    post_totalGP: 0
                });
            }

            const teamData = teamRelDataMap.get(teamId);

            const relMedian = playerStats.rel_median || 0;
            const gamesPlayed = playerStats.games_played || 0;
            if (gamesPlayed > 0) {
                teamData.weightedSum += relMedian * gamesPlayed;
                teamData.totalGP += gamesPlayed;
            }

            const postRelMedian = playerStats.post_rel_median || 0;
            const postGamesPlayed = playerStats.post_games_played || 0;
            if (postGamesPlayed > 0) {
                teamData.post_weightedSum += postRelMedian * postGamesPlayed;
                teamData.post_totalGP += postGamesPlayed;
            }
        }
    });
    
    const finalTRelMap = new Map();
    for (const [teamId, data] of teamRelDataMap.entries()) {
        const tREL = data.totalGP > 0 ? data.weightedSum / data.totalGP : 0;
        const post_tREL = data.post_totalGP > 0 ? data.post_weightedSum / data.post_totalGP : 0;
        finalTRelMap.set(teamId, { tREL, post_tREL });
    }

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
        const incompleteGamesSnap = await db.collection(getCollectionName('seasons')).doc(seasonId).collection(getCollectionName('games')).where('completed', '!=', 'TRUE').limit(1).get();
        const isRegularSeasonComplete = incompleteGamesSnap.empty;

        const eastConf = calculatedStats.filter(t => t.conference === 'Eastern');
        const westConf = calculatedStats.filter(t => t.conference === 'Western');

        [eastConf, westConf].forEach(conf => {
            if (conf.length === 0) return;
            
            conf.sort((a, b) => b.sortscore - a.sortscore).forEach((t, i) => t.postseed = i + 1);

            if (isRegularSeasonComplete) {
                console.log(`Regular season for ${conf[0].conference} conference is complete. Using sortscore for clinching.`);
                conf.forEach((team, index) => {
                    const rank = index + 1; 
                    if (rank <= 6) {
                        team.playoffs = 1;
                        team.playin = 0;
                        team.elim = 0;
                    } else if (rank >= 7 && rank <= 10) {
                        team.playoffs = 0;
                        team.playin = 1;
                        team.elim = 0;
                    } else {
                        team.playoffs = 0;
                        team.playin = 0;
                        team.elim = 1;
                    }
                });
            } else {
                console.log(`Regular season for ${conf[0].conference} conference is ongoing. Using win thresholds for clinching.`);
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
            }
        });
    }

    for (const team of calculatedStats) {
        const { teamId, ...stats } = team;
        const relValues = finalTRelMap.get(teamId) || { tREL: 0, post_tREL: 0 };

        const finalUpdate = {
            [`${prefix}wins`]: stats.wins || 0,
            [`${prefix}losses`]: stats.losses || 0,
            [`${prefix}pam`]: stats.pam || 0,
            [`${prefix}med_starter_rank`]: stats.med_starter_rank || 0,
            [`${prefix}msr_rank`]: stats[`${prefix}msr_rank`] || 0,
            [`${prefix}pam_rank`]: stats[`${prefix}pam_rank`] || 0,
            [`${prefix}tREL`]: relValues[`${prefix}tREL`] || 0,
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

    // Exit if this isn't a game completion event
    if (after.completed !== 'TRUE' || before.completed === 'TRUE') {
        return null;
    }
    console.log(`V2: Processing completed game ${gameId} in season ${seasonId}`);

    const gameDate = after.date;
    const batch = db.batch();
    const isPostseason = !/^\d+$/.test(after.week) && after.week !== "All-Star" && after.week !== "Relegation";

    // Update postseason series win counts if applicable
    if (isPostseason) {
        const winnerId = after.winner;
        if (winnerId) {
            let newTeam1Wins = after.team1_wins || 0;
            let newTeam2Wins = after.team2_wins || 0;
            let seriesWinner = after.series_winner || '';

            if (winnerId === after.team1_id) {
                newTeam1Wins++;
            } else if (winnerId === after.team2_id) {
                newTeam2Wins++;
            }
            
            if (after.week !== 'Play-In') {
                const winConditions = { 'Round 1': 2, 'Round 2': 2, 'Conf Finals': 3, 'Finals': 4 };
                const winsNeeded = winConditions[after.week];

                if (newTeam1Wins === winsNeeded) {
                    seriesWinner = after.team1_id;
                } else if (newTeam2Wins === winsNeeded) {
                    seriesWinner = after.team2_id;
                }
            }

            const seriesGamesQuery = db.collection(getCollectionName('seasons')).doc(seasonId).collection(getCollectionName('post_games')).where('series_id', '==', after.series_id);
            const seriesGamesSnap = await seriesGamesQuery.get();
            
            seriesGamesSnap.forEach(doc => {
                batch.update(doc.ref, {
                    team1_wins: newTeam1Wins,
                    team2_wins: newTeam2Wins,
                    series_winner: seriesWinner
                });
            });
        }
    }

    // --- BUG FIX LOGIC START ---
    // 1. Fetch ALL games scheduled for the same date as the completed game.
    const regGamesQuery = db.collection(getCollectionName('seasons')).doc(seasonId).collection(getCollectionName('games')).where('date', '==', gameDate).get();
    const postGamesQuery = db.collection(getCollectionName('seasons')).doc(seasonId).collection(getCollectionName('post_games')).where('date', '==', gameDate).get();

    const [regGamesSnap, postGamesSnap] = await Promise.all([regGamesQuery, postGamesQuery]);
    const allGamesForDate = [...regGamesSnap.docs, ...postGamesSnap.docs];

    // 2. Check if any other games from that date are still incomplete.
    const incompleteGames = allGamesForDate.filter(doc => {
        // This check is critical. It includes the currently triggering game, ensuring it's seen as complete.
        const gameData = doc.id === gameId ? after : doc.data();
        return gameData.completed !== 'TRUE';
    });
    
    // 3. If any games are still pending, exit. This function will run again when the next game is completed.
    // This prevents the race condition by ensuring calculations only happen once, on the final completion of the day.
    if (incompleteGames.length > 0) {
        console.log(`Not all games for ${gameDate} are complete. Deferring calculations. Incomplete count: ${incompleteGames.length}`);
        await batch.commit(); // Commit any series win updates and exit
        return null;
    }
    // --- BUG FIX LOGIC END ---
    
    console.log(`All games for ${gameDate} are complete. Proceeding with daily calculations.`);

    const seasonRef = db.collection(getCollectionName('seasons')).doc(seasonId);
    const averagesColl = isPostseason ? 'post_daily_averages' : 'daily_averages';
    const scoresColl = isPostseason ? 'post_daily_scores' : 'daily_scores';
    const lineupsColl = isPostseason ? 'post_lineups' : 'lineups';

    if (!isPostseason) {
        const gamesCompletedToday = allGamesForDate.length;
        batch.update(seasonRef, { gp: FieldValue.increment(gamesCompletedToday) });
    }

    const lineupsSnap = await db.collection(getCollectionName('seasons')).doc(seasonId).collection(getCollectionName(lineupsColl)).where('date', '==', gameDate).where('started', '==', 'TRUE').get();
    if (lineupsSnap.empty) {
        await batch.commit();
        return null;
    }

    // Player stat calculations (mean, median, etc.)
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

    // Update individual lineup documents with advanced stats
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

    // 4. Calculate the SINGLE, CORRECT median based on ALL team scores from the day.
    const teamScores = allGamesForDate.flatMap(d => {
        const gameData = d.id === gameId ? after : d.data();
        return [gameData.team1_score, gameData.team2_score];
    });
    const teamMedian = calculateMedian(teamScores);

    // 5. Loop through ALL teams that played today and create/overwrite their daily_scores document.
    // This ensures every team from the day uses the same, correct teamMedian.
    const newDailyScores = [];
    allGamesForDate.forEach(doc => {
        const game = doc.id === gameId ? after : doc.data();
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

    // Cascade updates to player and team seasonal stats
    let totalKarmaChangeForGame = 0;
    for (const [pid, newPlayerLineups] of lineupsByPlayer.entries()) {
        await updatePlayerSeasonalStats(pid, seasonId, isPostseason, batch, fullDailyAveragesMap, newPlayerLineups);
        const pointsFromThisUpdate = newPlayerLineups.reduce((sum, lineup) => sum + (lineup.points_adjusted || 0), 0);
        totalKarmaChangeForGame += pointsFromThisUpdate;
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
    const postSeasonGpMinimum = 0; 
    const playersSnap = await db.collection(getCollectionName('v2_players')).get();
    const statPromises = playersSnap.docs.map(playerDoc => 
        playerDoc.ref.collection(getCollectionName('seasonal_stats')).doc(seasonId).get()
    );
    const statDocs = await Promise.all(statPromises);

    const allPlayerStats = [];
    statDocs.forEach(doc => {
        if (doc.exists) {
            const pathParts = doc.ref.path.split('/');
            const playerId = pathParts[pathParts.length - 3];
            allPlayerStats.push({
                player_id: playerId,
                ...doc.data()
            });
        }
    });
    
    if (allPlayerStats.length === 0) {
        console.log(`No player stats found for active season ${seasonId}. Aborting ranking update.`);
        return;
    }

    const statsToExcludeZeroes = new Set(['total_points', 'rel_mean', 'rel_median', 'GEM', 'WAR', 'medrank', 'meanrank']);

    const leaderboards = {

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

async function performPerformanceRankingUpdate() {
    console.log("Starting single-performance leaderboard update...");
    const activeSeasonSnap = await db.collection(getCollectionName('seasons')).where('status', '==', 'active').limit(1).get();
    if (activeSeasonSnap.empty) {
        console.log("No active season found. Aborting performance leaderboard update.");
        return;
    }
    const seasonId = activeSeasonSnap.docs[0].id;

    const lineupsRef = db.collection(getCollectionName('seasons')).doc(seasonId).collection(getCollectionName('lineups'));
    const postLineupsRef = db.collection(getCollectionName('seasons')).doc(seasonId).collection(getCollectionName('post_lineups'));

    const [lineupsSnap, postLineupsSnap] = await Promise.all([
        lineupsRef.get(),
        postLineupsRef.get()
    ]);

    const batch = db.batch();

    if (!lineupsSnap.empty) {
        const regularSeasonPerformances = lineupsSnap.docs.map(d => d.data());

        const karmaLeaderboard = [...regularSeasonPerformances]
            .sort((a, b) => (b.points_adjusted || 0) - (a.points_adjusted || 0))
            .slice(0, 250);

        const rankLeaderboard = [...regularSeasonPerformances]
            .filter(p => (p.global_rank || 0) > 0)
            .sort((a, b) => (a.global_rank || 999) - (b.global_rank || 999))
            .slice(0, 250);

        const leaderboardsCollection = getCollectionName('leaderboards');

        const karmaDocRef = db.collection(leaderboardsCollection).doc('single_game_karma');
        const rankDocRef = db.collection(leaderboardsCollection).doc('single_game_rank');
        batch.set(karmaDocRef, { description: "Regular season single game karma leaderboard." }, { merge: true });
        batch.set(rankDocRef, { description: "Regular season single game rank leaderboard." }, { merge: true });


        const karmaLeaderboardRef = karmaDocRef.collection(seasonId).doc('data');
        const rankLeaderboardRef = rankDocRef.collection(seasonId).doc('data');

        batch.set(karmaLeaderboardRef, { rankings: karmaLeaderboard });
        batch.set(rankLeaderboardRef, { rankings: rankLeaderboard });

        console.log(`Regular season single-performance leaderboards updated for season ${seasonId}.`);
    } else {
        console.log(`No regular season performances found for season ${seasonId}. Skipping regular season leaderboard update.`);
    }

    if (!postLineupsSnap.empty) {
        const postseasonPerformances = postLineupsSnap.docs.map(d => d.data());

        const postKarmaLeaderboard = [...postseasonPerformances]
            .sort((a, b) => (b.points_adjusted || 0) - (a.points_adjusted || 0))
            .slice(0, 250);

        const postRankLeaderboard = [...postseasonPerformances]
            .filter(p => (p.global_rank || 0) > 0)
            .sort((a, b) => (a.global_rank || 999) - (b.global_rank || 999))
            .slice(0, 250);

        const postLeaderboardsCollection = getCollectionName('post_leaderboards');

        const postKarmaDocRef = db.collection(postLeaderboardsCollection).doc('post_single_game_karma');
        const postRankDocRef = db.collection(postLeaderboardsCollection).doc('post_single_game_rank');
        batch.set(postKarmaDocRef, { description: "Postseason single game karma leaderboard." }, { merge: true });
        batch.set(postRankDocRef, { description: "Postseason single game rank leaderboard." }, { merge: true });

        const postKarmaLeaderboardRef = postKarmaDocRef.collection(seasonId).doc('data');
        const postRankLeaderboardRef = postRankDocRef.collection(seasonId).doc('data');

        batch.set(postKarmaLeaderboardRef, { rankings: postKarmaLeaderboard });
        batch.set(postRankLeaderboardRef, { rankings: postRankLeaderboard });

        console.log(`Postseason single-performance leaderboards updated for season ${seasonId}.`);
    } else {
        console.log(`No postseason performances found for season ${seasonId}. Skipping postseason leaderboard update.`);
    }

    await batch.commit();
    console.log("Single-performance leaderboard update process complete.");
}

exports.updatePlayerRanks = onSchedule({
    schedule: "15 5 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    await performPlayerRankingUpdate();
    return null;
});

exports.updatePerformanceLeaderboards = onSchedule({
    schedule: "15 5 * * *",
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

async function performWeekUpdate() {
    console.log("Running logic to update current week...");
    try {
        const seasonsRef = db.collection(getCollectionName('seasons'));
        const activeSeasonQuery = seasonsRef.where("status", "==", "active").limit(1);
        const activeSeasonSnap = await activeSeasonQuery.get();

        if (activeSeasonSnap.empty) {
            console.log("No active season found. Exiting week update.");
            return;
        }

        const activeSeasonDoc = activeSeasonSnap.docs[0];
        const seasonId = activeSeasonDoc.id;
        console.log(`Active season is ${seasonId}. Checking for next incomplete game.`);

        let nextGameWeek = null;

        // --- BUG FIX START ---
        // Helper function to find the earliest game from a snapshot
        const findEarliestGame = (snapshot) => {
            if (snapshot.empty) {
                return null;
            }
            let earliestGame = null;
            let earliestDate = null;

            snapshot.docs.forEach(doc => {
                const gameData = doc.data();
                const gameDate = new Date(gameData.date);
                if (!earliestDate || gameDate < earliestDate) {
                    earliestDate = gameDate;
                    earliestGame = gameData;
                }
            });
            return earliestGame;
        };

        const gamesRef = activeSeasonDoc.ref.collection(getCollectionName('games'));
        const incompleteGamesQuery = gamesRef.where('completed', '==', 'FALSE');
        const incompleteGamesSnap = await incompleteGamesQuery.get();

        const earliestRegularSeasonGame = findEarliestGame(incompleteGamesSnap);

        if (earliestRegularSeasonGame) {
            nextGameWeek = earliestRegularSeasonGame.week;
        } else {
            console.log("No incomplete regular season games found. Checking postseason...");
            const postGamesRef = activeSeasonDoc.ref.collection(getCollectionName('post_games'));
            const incompletePostGamesQuery = postGamesRef.where('completed', '==', 'FALSE');
            const incompletePostGamesSnap = await incompletePostGamesQuery.get();
            
            const earliestPostseasonGame = findEarliestGame(incompletePostGamesSnap);
            
            if (earliestPostseasonGame) {
                nextGameWeek = earliestPostseasonGame.week;
            }
        }
        // --- BUG FIX END ---

        if (nextGameWeek !== null) {
            console.log(`The next game is in week/round: '${nextGameWeek}'. Updating season document.`);
            await activeSeasonDoc.ref.set({
                current_week: String(nextGameWeek)
            }, { merge: true });
        } else {
            const postGamesRef = activeSeasonDoc.ref.collection(getCollectionName('post_games'));
            const allPostGamesSnap = await postGamesRef.limit(2).get(); 

            if (allPostGamesSnap.size > 1) {
                console.log("No incomplete games found anywhere. Postseason is complete. Setting current week to 'Season Complete'.");
                await activeSeasonDoc.ref.set({
                    current_week: "Season Complete"
                }, { merge: true });
            } else {
                console.log("Regular season complete. Awaiting postseason schedule generation.");
                await activeSeasonDoc.ref.set({
                    current_week: "End of Regular Season"
                }, { merge: true });
            }
        }
        console.log("Successfully updated the current week.");
    } catch (error) {
        console.error("Error updating current week:", error);
    }
}

exports.updateCurrentWeek = onSchedule({
    schedule: "15 5 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    await performWeekUpdate();
    return null;
});

exports.test_autoFinalizeGames = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    console.log(`Manual trigger received for auto-finalization by admin: ${request.auth.uid}`);
    try {
        const liveGamesSnap = await db.collection(getCollectionName('live_games')).get();

        if (liveGamesSnap.empty) {
            console.log("No live games found to auto-finalize.");
            return { success: true, message: "No live games found to auto-finalize." };
        }

        console.log(`Found ${liveGamesSnap.size} games to auto-finalize.`);
        const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        for (const gameDoc of liveGamesSnap.docs) {
            try {
                const randomGameDelay = Math.floor(Math.random() * 201) + 200;
                await delay(randomGameDelay);

                console.log(`Manually auto-finalizing game ${gameDoc.id} after a ${randomGameDelay}ms delay.`);
                await processAndFinalizeGame(gameDoc, true);
                console.log(`Successfully auto-finalized game ${gameDoc.id}.`);

            } catch (error) {
                console.error(`Failed to auto-finalize game ${gameDoc.id}:`, error);
            }
        }

        console.log("Manual auto-finalization job completed.");
        return { success: true, message: `Successfully processed ${liveGamesSnap.size} games.` };

    } catch (error) {
        console.error("Error during manual auto-finalization test:", error);
        throw new HttpsError('internal', `An unexpected error occurred: ${error.message}`);
    }
});

/**
 * Core logic for advancing teams in the playoff bracket.
 * This function is now shared between the scheduled job and the on-demand test function.
 * @param {Array<admin.firestore.QueryDocumentSnapshot>} gamesToProcess - An array of game document snapshots to process for advancement.
 * @param {admin.firestore.CollectionReference} postGamesRef - A reference to the postseason games collection.
 */
async function advanceBracket(gamesToProcess, postGamesRef) {
    if (gamesToProcess.length === 0) {
        console.log("advanceBracket: No games to process.");
        return;
    }

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

    for (const gameDoc of gamesToProcess) {
        const game = gameDoc.data();
        const rule = advancementRules[game.series_id];
        
        if (!rule) continue;

        const batch = db.batch();
        let shouldCommit = false;

        const winnerId = game.winner;
        const loserId = game.team1_id === winnerId ? game.team2_id : game.team1_id;

        if (rule.winnerTo && winnerId) {
            let winnerSeed = winnerId === game.team1_id ? game.team1_seed : game.team2_seed;

            if (game.series_id === "E7vE8" || game.series_id === "W7vW8") {
                winnerSeed = '7'; 
            } else if (game.series_id.includes('8thSeedGame')) {
                winnerSeed = '8'; 
            }

            const winnerSeedField = rule.winnerField.replace('_id', '_seed');
            const winnerNextSeriesSnap = await postGamesRef.where('series_id', '==', rule.winnerTo).get();
            
            winnerNextSeriesSnap.forEach(doc => {
                batch.update(doc.ref, { 
                    [rule.winnerField]: winnerId,
                    [winnerSeedField]: winnerSeed || ''
                });
            });
            console.log(`Advancing winner ${winnerId} (seed ${winnerSeed}) from ${game.series_id} to ${rule.winnerTo}.`);
            shouldCommit = true;
        }

        if (rule.loserTo && loserId) {
            const loserSeed = loserId === game.team1_id ? game.team1_seed : game.team2_seed;
            const loserSeedField = rule.loserField.replace('_id', '_seed');
            const loserNextSeriesSnap = await postGamesRef.where('series_id', '==', rule.loserTo).get();
            
            loserNextSeriesSnap.forEach(doc => {
                batch.update(doc.ref, { 
                    [rule.loserField]: loserId,
                    [loserSeedField]: loserSeed || ''
                });
            });
            console.log(`Moving loser ${loserId} (seed ${loserSeed}) from ${game.series_id} to ${rule.loserTo}.`);
            shouldCommit = true;
        }

        if (game.week !== 'Play-In' && game.series_winner) {
            const incompleteGamesSnap = await postGamesRef.where('series_id', '==', game.series_id).where('completed', '==', 'FALSE').get();
            if (!incompleteGamesSnap.empty) {
                console.log(`Series ${game.series_id} won by ${game.series_winner}. Deleting ${incompleteGamesSnap.size} incomplete games.`);
                incompleteGamesSnap.forEach(doc => batch.delete(doc.ref));
                shouldCommit = true;
            }
        }

        if (shouldCommit) {
            await batch.commit();
        }
    }
}

async function performBracketUpdate(gameDateStr) {
    console.log(`Running logic to update playoff bracket for games on ${gameDateStr}...`);
    const activeSeasonSnap = await db.collection(getCollectionName('seasons')).where('status', '==', 'active').limit(1).get();
    if (activeSeasonSnap.empty) {
        console.log("No active season found. Exiting bracket update.");
        return;
    }
    const seasonId = activeSeasonSnap.docs[0].id;
    const postGamesRef = db.collection(`${getCollectionName('seasons')}/${seasonId}/${getCollectionName('post_games')}`);

    const gamesPlayedSnap = await postGamesRef.where('date', '==', gameDateStr).where('completed', '==', 'TRUE').get();
    if (gamesPlayedSnap.empty) {
        console.log(`No completed postseason games were played on ${gameDateStr}. Exiting bracket update.`);
        return;
    }
    console.log(`Processing ${gamesPlayedSnap.size} games from ${gameDateStr} for bracket advancement.`);
    await advanceBracket(gamesPlayedSnap.docs, postGamesRef);
}


exports.updatePlayoffBracket = onSchedule({
    schedule: "15 5 * * *", 
    timeZone: "America/Chicago",
}, async (event) => {
    console.log("Running daily job to update playoff bracket...");
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = `${yesterday.getMonth() + 1}/${yesterday.getDate()}/${yesterday.getFullYear()}`;
    await performBracketUpdate(yesterdayStr);
    console.log("Playoff bracket update job finished.");
    return null;
});

exports.test_updatePlayoffBracket = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    console.log("Running ON-DEMAND job to update playoff bracket for testing.");

    const activeSeasonSnap = await db.collection(getCollectionName('seasons')).where('status', '==', 'active').limit(1).get();
    if (activeSeasonSnap.empty) {
        throw new HttpsError('failed-precondition', 'No active season found.');
    }
    const seasonId = activeSeasonSnap.docs[0].id;
    const postGamesRef = db.collection(`${getCollectionName('seasons')}/${seasonId}/${getCollectionName('post_games')}`);

    const mostRecentGameQuery = postGamesRef.where('completed', '==', 'TRUE').orderBy(admin.firestore.FieldPath.documentId(), 'desc').limit(1);
    
    const mostRecentGameSnap = await mostRecentGameQuery.get();

    if (mostRecentGameSnap.empty) {
        return { success: true, message: "No completed postseason games found to process." };
    }
    const mostRecentDate = mostRecentGameSnap.docs[0].data().date;
    console.log(`Found most recent completed game date: ${mostRecentDate}`);

    const gamesToProcessSnap = await postGamesRef.where('date', '==', mostRecentDate).where('completed', '==', 'TRUE').get();

    console.log(`Processing ${gamesToProcessSnap.size} games from ${mostRecentDate} for bracket advancement.`);
    await advanceBracket(gamesToProcessSnap.docs, postGamesRef);

    console.log("On-demand playoff bracket update job finished.");
    return { success: true, message: `Processed ${gamesToProcessSnap.size} games from ${mostRecentDate}.` };
});


// ===================================================================
// NEW SCOREKEEPER & WRITEUP FUNCTIONS
// ===================================================================

// functions/index.js

// functions/index.js

exports.generateGameWriteup = onCall({ region: "us-central1" }, async (request) => {
    if (!(await isScorekeeperOrAdmin(request.auth))) {
        throw new HttpsError('permission-denied', 'Must be an admin or scorekeeper to run this function.');
    }
    
    const { gameId, seasonId, collectionName, isLive } = request.data;
    if (!gameId || !seasonId || !collectionName) {
        throw new HttpsError('invalid-argument', 'Missing required parameters.');
    }

    try {
        let gameData, lineupsData, calculatedTeam1Score, calculatedTeam2Score, determinedWinner, team1Id, team2Id;

        if (isLive) {
            const liveGameRef = db.doc(`${getCollectionName('live_games')}/${gameId}`);
            const liveGameSnap = await liveGameRef.get();
            if (!liveGameSnap.exists) throw new HttpsError('not-found', 'Live game not found.');
            
            const liveGameData = liveGameSnap.data();
            const fullLineupFromLiveGame = [...liveGameData.team1_lineup, ...liveGameData.team2_lineup];

            const originalGameRef = db.doc(`${getCollectionName('seasons')}/${seasonId}/${getCollectionName(liveGameData.collectionName)}/${gameId}`);
            const originalGameSnap = await originalGameRef.get();
            if (!originalGameSnap.exists) throw new HttpsError('not-found', 'Original game data not found for the live game.');
            gameData = originalGameSnap.data();
            team1Id = gameData.team1_id;
            team2Id = gameData.team2_id;

            const playerIds = fullLineupFromLiveGame.map(p => p.player_id);
            const playerDocs = await db.collection(getCollectionName('v2_players')).where(admin.firestore.FieldPath.documentId(), 'in', playerIds).get();
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
            const gameRef = db.doc(`${getCollectionName('seasons')}/${seasonId}/${getCollectionName(collectionName)}/${gameId}`);
            const gameSnap = await gameRef.get();
            if (!gameSnap.exists) throw new HttpsError('not-found', 'Completed game not found.');
            gameData = gameSnap.data();
            team1Id = gameData.team1_id;
            team2Id = gameData.team2_id;

            const lineupsCollection = getCollectionName(collectionName.replace('games', 'lineups'));
            const lineupsQuery = db.collection(`${getCollectionName('seasons')}/${seasonId}/${lineupsCollection}`).where('game_id', '==', gameId);
            const lineupsSnap = await lineupsQuery.get();
            lineupsData = lineupsSnap.docs.map(doc => doc.data());
            
            calculatedTeam1Score = gameData.team1_score;
            calculatedTeam2Score = gameData.team2_score;
            determinedWinner = gameData.winner;
        }

        const team1RecordRef = db.doc(`${getCollectionName('v2_teams')}/${team1Id}/${getCollectionName('seasonal_records')}/${seasonId}`);
        const team2RecordRef = db.doc(`${getCollectionName('v2_teams')}/${team2Id}/${getCollectionName('seasonal_records')}/${seasonId}`);
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
        
        return { success: true, promptData, systemPrompt, team1Summary, team2Summary };

    } catch (error) {
        console.error("CRITICAL ERROR in generateGameWriteup:", error);
        throw new HttpsError('internal', `An unexpected error occurred. Check the function logs. Error: ${error.message}`);
    }
});




exports.scorekeeperFinalizeAndProcess = onCall({ region: "us-central1" }, async (request) => {
    // 1. Security Check
    if (!(await isScorekeeperOrAdmin(request.auth))) {
        throw new HttpsError('permission-denied', 'Must be an admin or scorekeeper to run this function.');
    }

    const userId = request.auth.uid;
    console.log(`Manual finalization process initiated by user: ${userId}`);

    try {
        // 2. Database Backup (Simulated) & Archive
        console.log("Step 1: Backing up and archiving live games...");
        const liveGamesSnap = await db.collection(getCollectionName('live_games')).get();
        if (liveGamesSnap.empty) {
            return { success: true, message: "No live games were active. Process complete." };
        }

        const archiveBatch = db.batch();
        const backupTimestamp = new Date().toISOString();
        liveGamesSnap.docs.forEach(doc => {
            const archiveRef = db.collection(getCollectionName('archived_live_games')).doc(`${backupTimestamp}-${doc.id}`);
            archiveBatch.set(archiveRef, { ...doc.data(), archivedAt: FieldValue.serverTimestamp(), archivedBy: userId });
        });
        await archiveBatch.commit();
        console.log(`Archived ${liveGamesSnap.size} games successfully.`);

        // 3. Process and Finalize Games
        console.log("Step 2: Processing and finalizing games...");
        for (const gameDoc of liveGamesSnap.docs) {
            await processAndFinalizeGame(gameDoc, true); // Use the existing robust finalization logic
        }
        console.log("All live games have been finalized.");

        // 4. Run the full cascade of overnight processes
        console.log("Step 3: Triggering stat recalculation cascade...");
        await performPlayerRankingUpdate();
        await performPerformanceRankingUpdate();
        await performWeekUpdate();
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = `${yesterday.getMonth() + 1}/${yesterday.getDate()}/${yesterday.getFullYear()}`;
        await performBracketUpdate(yesterdayStr);
        console.log("Stat recalculation cascade complete.");

        // 5. Log the activity
        console.log("Step 4: Logging scorekeeper activity...");
        const logRef = db.collection(getCollectionName('scorekeeper_activity_log')).doc();
        await logRef.set({
            action: 'finalizeAndProcess',
            userId: userId,
            userRole: await getUserRole(request.auth),
            timestamp: FieldValue.serverTimestamp(),
            details: `Processed and finalized ${liveGamesSnap.size} live games.`
        });
        console.log("Activity logged successfully.");

        return { success: true, message: `Successfully finalized ${liveGamesSnap.size} games and updated all stats.` };

    } catch (error) {
        console.error("Error during scorekeeper finalization process:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError('internal', 'An unexpected error occurred during the finalization process.');
    }
});

exports.getAiWriteup = onCall({ secrets: ["GOOGLE_AI_KEY"] }, async (request) => {
    // 1. Security: Ensure the user is authenticated and is a scorekeeper or admin
    if (!(await isScorekeeperOrAdmin(request.auth))) {
        throw new HttpsError('permission-denied', 'Must be an admin or scorekeeper to run this function.');
    }
    
    const { systemPrompt, promptData } = request.data;
    if (!systemPrompt || !promptData) {
        throw new HttpsError('invalid-argument', 'The function must be called with prompt data.');
    }

    try {
        // 2. Access the secret API key and initialize the AI client
        const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_KEY);
        
        // --- THIS IS THE CORRECTED LINE ---
        // Changed "gemini-pro" to the current, recommended model "gemini-1.5-flash-latest"
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

        const fullPrompt = `${systemPrompt}\n\n${promptData}`;

        // 3. Call the AI and get the result
        const result = await model.generateContent(fullPrompt);
        const response = await result.response;
        const writeup = response.text();

        // 4. Return the finished writeup to the client
        return { success: true, writeup: writeup };

    } catch (error) {
        console.error("Error calling Google AI:", error);
        throw new HttpsError('internal', 'Failed to generate writeup from AI model.');
    }
});

exports.getReportData = onCall({ region: "us-central1" }, async (request) => {
    if (!(await isScorekeeperOrAdmin(request.auth))) {
        throw new HttpsError('permission-denied', 'Must be an admin or scorekeeper to access reports.');
    }

    const { reportType, seasonId, date } = request.data;
    if (!reportType || !seasonId) {
        throw new HttpsError('invalid-argument', 'Missing reportType or seasonId.');
    }

    try {
        const teamRecordsQuery = db.collectionGroup(getCollectionName('seasonal_records')).where('season', '==', seasonId);
        const teamRecordsSnap = await teamRecordsQuery.get();
        const teamDataMap = new Map();
        teamRecordsSnap.forEach(doc => {
            const data = doc.data();
            teamDataMap.set(data.team_id, {
                name: data.team_name,
                record: `${data.wins || 0}-${data.losses || 0}`
            });
        });
        
        if (reportType === 'deadline' || reportType === 'voteGOTD') {
            if (!date) throw new HttpsError('invalid-argument', 'A date is required for this report.');
            
            const seasonRef = db.collection(getCollectionName('seasons')).doc(seasonId);

            // Create queries for all three game types
            const regGamesQuery = seasonRef.collection(getCollectionName('games')).where('date', '==', date);
            const postGamesQuery = seasonRef.collection(getCollectionName('post_games')).where('date', '==', date);
            const exGamesQuery = seasonRef.collection(getCollectionName('exhibition_games')).where('date', '==', date);

            // Fetch all games concurrently
            const [regGamesSnap, postGamesSnap, exGamesSnap] = await Promise.all([
                regGamesQuery.get(),
                postGamesQuery.get(),
                exGamesQuery.get()
            ]);

            // Combine the results from all snapshots
            const allGamesDocs = [...regGamesSnap.docs, ...postGamesSnap.docs, ...exGamesSnap.docs];

            const games = allGamesDocs.map(doc => {
                const game = doc.data();
                const team1 = teamDataMap.get(game.team1_id) || { name: game.team1_id, record: '?-?' };
                const team2 = teamDataMap.get(game.team2_id) || { name: game.team2_id, record: '?-?' };
                return {
                    team1_name: team1.name,
                    team2_name: team2.name,
                    team1_record: team1.record,
                    team2_record: team2.record,
                };
            });
            return { success: true, games };
        }

        if (reportType === 'lineups_prepare') {
            const liveGamesSnap = await db.collection(getCollectionName('live_games')).get();
            if (liveGamesSnap.empty) {
                return { success: true, games: [] };
            }
            const gamesPromises = liveGamesSnap.docs.map(async (doc) => {
                const liveGame = doc.data();
                const originalGameRef = db.doc(`${getCollectionName('seasons')}/${seasonId}/${getCollectionName(liveGame.collectionName)}/${doc.id}`);
                const originalGameSnap = await originalGameRef.get();

                let team1_id, team2_id;
                if (originalGameSnap.exists) { 
                    const originalGameData = originalGameSnap.data();
                    team1_id = originalGameData.team1_id;
                    team2_id = originalGameData.team2_id;
                } else {
                    console.warn(`Could not find original game doc for live game ${doc.id}`);
                    return null; 
                }

                const team1 = teamDataMap.get(team1_id) || { name: `Team ${team1_id}`, record: '?-?' };
                const team2 = teamDataMap.get(team2_id) || { name: `Team ${team2_id}`, record: '?-?' };

                return {
                    gameId: doc.id,
                    team1_name: team1.name,
                    team2_name: team2.name,
                    team1_record: team1.record,
                    team2_record: team2.record,
                    team1_lineup: liveGame.team1_lineup,
                    team2_lineup: liveGame.team2_lineup
                };
            });

            const games = (await Promise.all(gamesPromises)).filter(g => g !== null);
            return { success: true, games };
        }

        throw new HttpsError('invalid-argument', 'Unknown report type specified.');

    } catch (error) {
        console.error(`Error generating report '${reportType}':`, error);
        throw new HttpsError('internal', `Failed to generate report: ${error.message}`);
    }
});

// ===================================================================
// LEGACY FUNCTIONS - DO NOT MODIFY
// ===================================================================

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
                const today = new Date();
                const dateString = `${today.getMonth() + 1}/${today.getDate()}/${today.getFullYear()}`;

                for (const pickMove of transaction.involved_picks) {
                    const pickRef = db.collection('draftPicks').doc(pickMove.id);

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
        return null; 
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
        await db.runTransaction(async (transaction) => {
            transaction.update(winnerRef, { wins: admin.firestore.FieldValue.increment(1) });
            transaction.update(loserRef, { losses: admin.firestore.FieldValue.increment(-1) });
        });
        console.log(`Successfully updated team records for game ${event.params.gameId}.`);

        const gameDate = after.date;
        const teamIds = [after.team1_id, after.team2_id];

        const lineupsQuery = db.collection('lineups').where('date', '==', gameDate).where('team_id', 'in', teamIds);
        const lineupsSnap = await lineupsQuery.get();

        const startingLineups = lineupsSnap.docs
            .map(doc => doc.data())
            .filter(lineup => lineup.started === 'TRUE');

        if (startingLineups.length === 0) {
            console.log("No starting lineups found for this game. No player stats to update.");
            return null;
        }

        const batch = db.batch();

        for (const lineup of startingLineups) {
            const playerRef = db.collection('players').doc(lineup.player_handle);

            const statsUpdate = {
                games_played: admin.firestore.FieldValue.increment(1),
                total_points: admin.firestore.FieldValue.increment(Number(lineup.points_final) || 0)
            };

            batch.update(playerRef, statsUpdate);
        }

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

    while (snapshot.size > 0) {
        const batch = db.batch();
        snapshot.docs.forEach((doc) => {
            batch.delete(doc.ref);
        });
        await batch.commit();

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
    const lines = csvText.trim().split('\n').filter(line => line.trim() !== '' && line.replace(/,/g, '').trim() !== '');
    if (lines.length === 0) {
        return [];
    }
    const headerLine = lines.shift();
    const headers = headerLine.split(',').map(h => h.replace(/"/g, '').trim());
    const data = lines.map(line => {
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


exports.syncSheetsToFirestore = onRequest({ region: "us-central1" }, async (req, res) => {
    try {
        const SPREADSHEET_ID = "12EembQnztbdKx2-buv00--VDkEFSTuSXTRdOnTnRxq4";

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


exports.clearAllTradeBlocks = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDocRef = db.collection(getCollectionName('users')).doc(request.auth.uid);
    const userDoc = await userDocRef.get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    try {
        const tradeBlocksRef = db.collection('tradeblocks');
        const tradeBlocksSnap = await tradeBlocksRef.get();
        
        const batch = db.batch();
        tradeBlocksSnap.docs.forEach(doc => {
            batch.delete(doc.ref);
        });

        const settingsRef = db.doc('settings/tradeBlock');
        batch.set(settingsRef, { status: 'closed' }, { merge: true });

        await batch.commit();
        return { message: "All trade blocks have been cleared and the deadline is now active." };

    } catch (error) {
        console.error("Error clearing trade blocks:", error);
        throw new HttpsError('internal', 'An error occurred while clearing trade blocks.');
    }
});

exports.reopenTradeBlocks = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDocRef = db.collection(getCollectionName('users')).doc(request.auth.uid);
    const userDoc = await userDocRef.get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    try {
        const settingsRef = db.doc('settings/tradeBlock');
        await settingsRef.set({ status: 'open' }, { merge: true });

        return { message: "Trading has been successfully re-opened." };

    } catch (error) {
        console.error("Error reopening trade blocks:", error);
        throw new HttpsError('internal', 'An error occurred while reopening trade blocks.');
    }
});

module.exports = { ...module.exports, ...require('./draft-prospects') };
