// functions/free-agents.js

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const axios = require("axios");
const { LEAGUES } = require('./league-helpers');

if (admin.apps.length === 0) {
    admin.initializeApp();
}
const db = admin.firestore();

const USE_DEV_COLLECTIONS = false;

/**
 * Returns the appropriate collection name with league prefix
 * @param {string} baseName - Base collection name
 * @param {string} league - League context ('major' or 'minor')
 * @returns {string} Prefixed collection name
 */
const getCollectionName = (baseName, league = LEAGUES.MAJOR) => {
    const sharedCollections = ['users', 'notifications'];
    const devSuffix = USE_DEV_COLLECTIONS ? '_dev' : '';

    if (sharedCollections.includes(baseName)) {
        return `${baseName}${devSuffix}`;
    }

    const leaguePrefix = league === LEAGUES.MINOR ? 'minor_' : '';
    return `${leaguePrefix}${baseName}${devSuffix}`;
};

const API_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
};

/**
 * Attempts to resolve a player's current handle by querying their cards.
 * Uses the cards API which returns user info including the current username.
 * @param {string} playerId The player's ID.
 * @returns {Promise<string|null>} The resolved player handle or null if resolution failed.
 */
const resolvePlayerHandle = async (playerId) => {
    try {
        const cardsResponse = await axios.get(
            `https://api.real.vg/collectingcards/nba/season/2026/entity/play/user/${playerId}/cards?rarity=1&view=rating`,
            { headers: API_HEADERS }
        );

        const cards = cardsResponse.data?.cards;
        if (cards && cards.length > 0 && cards[0].user?.userName) {
            return cards[0].user.userName;
        }
        return null;
    } catch (error) {
        console.error(`Failed to resolve handle for player ID ${playerId}:`, error.message);
        return null;
    }
};

/**
 * Fetches user data from the Real.vg API for a given player handle.
 * @param {string} playerHandle The player's username.
 * @returns {Promise<object|null>} The processed free agent data or null if failed.
 */
const fetchFreeAgentData = async (playerHandle) => {
    try {
        const userResponse = await axios.get(`https://api.real.vg/user/${playerHandle}`, { headers: API_HEADERS });
        const userData = userResponse.data?.user;

        if (!userData || !userData.id) {
            console.error(`Could not find user or user ID for handle: ${playerHandle}`);
            return null;
        }

        const playerId = userData.id;
        const freeAgentData = {
            player_handle: playerHandle,
            player_id: playerId,
            karma: userData.karma || 0,
            ranked_days: userData.daysTopHundred || 0,
            monthly_rank: null
        };

        const karmaFeedResponse = await axios.get(`https://api.real.vg/user/${playerId}/karmafeed`, { headers: API_HEADERS });
        const karmaMonthRank = karmaFeedResponse.data?.stats?.karmaMonthRank;

        if (karmaMonthRank !== undefined) {
            freeAgentData.monthly_rank = karmaMonthRank;
        }

        return freeAgentData;

    } catch (error) {
        console.error(`Error fetching data for free agent ${playerHandle}:`, error.message);
        return null;
    }
};

/**
 * Cloud Function (v2) to initialize the free_agents subcollection
 * Populates from v2_players where current_team_id = 'FREE_AGENT' and player_status = 'ACTIVE'
 */
exports.initializeFreeAgents = onCall(async (request) => {
    const league = request.data?.league || LEAGUES.MAJOR;

    // Auth Check
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'You must be logged in to perform this action.');
    }
    const userDoc = await db.collection('users').doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'You must be an admin to initialize free agents.');
    }

    // Find active season
    const activeSeasonQuery = await db.collection(getCollectionName('seasons', league)).where('status', '==', 'active').limit(1).get();
    if (activeSeasonQuery.empty) {
        throw new HttpsError('failed-precondition', 'Could not find an active season.');
    }
    const activeSeasonId = activeSeasonQuery.docs[0].id;

    // Get all free agent players from v2_players
    const playersQuery = await db.collection(getCollectionName('v2_players', league))
        .where('current_team_id', '==', 'FREE_AGENT')
        .where('player_status', '==', 'ACTIVE')
        .get();

    if (playersQuery.empty) {
        return { success: true, league, message: 'No free agents found to initialize.' };
    }

    const freeAgentsCollectionRef = db.collection(getCollectionName('seasons', league)).doc(activeSeasonId).collection('free_agents');

    let successCount = 0;
    let failedHandles = [];

    const processingPromises = playersQuery.docs.map(async (playerDoc) => {
        const playerData = playerDoc.data();
        const playerHandle = playerData.player_handle;

        if (!playerHandle) {
            failedHandles.push(playerDoc.id);
            return;
        }

        const freeAgentData = await fetchFreeAgentData(playerHandle);
        if (freeAgentData) {
            try {
                await freeAgentsCollectionRef.doc(freeAgentData.player_id).set(freeAgentData);
                successCount++;
            } catch (error) {
                console.error(`Failed to write free agent ${playerHandle} to Firestore:`, error);
                failedHandles.push(playerHandle);
            }
        } else {
            failedHandles.push(playerHandle);
        }
    });

    await Promise.all(processingPromises);

    let message = `${successCount} of ${playersQuery.size} free agents were successfully initialized.`;
    if (failedHandles.length > 0) {
        message += ` Failed handles: ${failedHandles.join(', ')}.`;
    }

    return { success: true, league, message };
});

/**
 * Cloud Function (v2) to manually add free agents by handle.
 */
exports.addFreeAgents = onCall(async (request) => {
    const league = request.data?.league || LEAGUES.MAJOR;

    // Auth Check
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'You must be logged in to perform this action.');
    }
    const userDoc = await db.collection('users').doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'You must be an admin to add free agents.');
    }

    const handlesString = request.data.handles;
    if (!handlesString || typeof handlesString !== 'string') {
        throw new HttpsError('invalid-argument', 'The function must be called with a string of handles.');
    }

    const activeSeasonQuery = await db.collection(getCollectionName('seasons', league)).where('status', '==', 'active').limit(1).get();
    if (activeSeasonQuery.empty) {
        throw new HttpsError('failed-precondition', 'Could not find an active season.');
    }
    const activeSeasonId = activeSeasonQuery.docs[0].id;

    const handles = handlesString.split(',').map(h => h.trim()).filter(Boolean);
    const freeAgentsCollectionRef = db.collection(getCollectionName('seasons', league)).doc(activeSeasonId).collection('free_agents');

    let successCount = 0;
    let failedHandles = [];

    let playersCreated = 0;

    const processingPromises = handles.map(async (handle) => {
        const freeAgentData = await fetchFreeAgentData(handle);
        if (freeAgentData) {
            try {
                // Ensure player exists in v2_players collection
                const playerRef = db.collection(getCollectionName('v2_players', league)).doc(freeAgentData.player_id);
                const playerDoc = await playerRef.get();

                if (!playerDoc.exists) {
                    await playerRef.set({
                        player_handle: freeAgentData.player_handle,
                        current_team_id: 'FREE_AGENT',
                        player_status: 'ACTIVE'
                    });
                    playersCreated++;
                    console.log(`Created new v2_players document for ${handle} (${freeAgentData.player_id}).`);
                }

                // Add to free_agents collection
                await freeAgentsCollectionRef.doc(freeAgentData.player_id).set(freeAgentData);
                successCount++;
            } catch (error) {
                console.error(`Failed to write free agent ${handle} to Firestore:`, error);
                failedHandles.push(handle);
            }
        } else {
            failedHandles.push(handle);
        }
    });

    await Promise.all(processingPromises);

    let message = `${successCount} of ${handles.length} free agents were successfully added.`;
    if (playersCreated > 0) {
        message += ` ${playersCreated} new player(s) created in v2_players.`;
    }
    if (failedHandles.length > 0) {
        message += ` Failed handles: ${failedHandles.join(', ')}.`;
    }

    return { success: true, league, message };
});

/**
 * Adds a single player to the free_agents subcollection.
 * Called internally by transaction handlers when a player is cut.
 * @param {string} playerId - The player's ID
 * @param {string} playerHandle - The player's handle
 * @param {string} league - The league context ('major' or 'minor')
 */
const addFreeAgentInternal = async (playerId, playerHandle, league = LEAGUES.MAJOR) => {
    try {
        const activeSeasonQuery = await db.collection(getCollectionName('seasons', league)).where('status', '==', 'active').limit(1).get();
        if (activeSeasonQuery.empty) {
            console.error('Cannot add free agent: No active season found.');
            return false;
        }
        const activeSeasonId = activeSeasonQuery.docs[0].id;

        // Fetch fresh data from Real.vg API
        const freeAgentData = await fetchFreeAgentData(playerHandle);
        if (!freeAgentData) {
            // Fall back to basic data if API fails
            console.warn(`Could not fetch API data for ${playerHandle}, using basic data.`);
            const basicData = {
                player_handle: playerHandle,
                player_id: playerId,
                karma: null,
                ranked_days: null,
                monthly_rank: null
            };
            await db.collection(getCollectionName('seasons', league))
                .doc(activeSeasonId)
                .collection('free_agents')
                .doc(playerId)
                .set(basicData);
            return true;
        }

        await db.collection(getCollectionName('seasons', league))
            .doc(activeSeasonId)
            .collection('free_agents')
            .doc(freeAgentData.player_id)
            .set(freeAgentData);

        console.log(`Successfully added ${playerHandle} to free_agents collection.`);
        return true;
    } catch (error) {
        console.error(`Error adding free agent ${playerHandle}:`, error);
        return false;
    }
};

/**
 * Removes a single player from the free_agents subcollection.
 * Called internally by transaction handlers when a player is signed.
 * @param {string} playerId - The player's ID
 * @param {string} league - The league context ('major' or 'minor')
 */
const removeFreeAgentInternal = async (playerId, league = LEAGUES.MAJOR) => {
    try {
        const activeSeasonQuery = await db.collection(getCollectionName('seasons', league)).where('status', '==', 'active').limit(1).get();
        if (activeSeasonQuery.empty) {
            console.error('Cannot remove free agent: No active season found.');
            return false;
        }
        const activeSeasonId = activeSeasonQuery.docs[0].id;

        await db.collection(getCollectionName('seasons', league))
            .doc(activeSeasonId)
            .collection('free_agents')
            .doc(playerId)
            .delete();

        console.log(`Successfully removed player ${playerId} from free_agents collection.`);
        return true;
    } catch (error) {
        console.error(`Error removing free agent ${playerId}:`, error);
        return false;
    }
};

// Export internal functions for use by transaction handlers
exports.addFreeAgentInternal = addFreeAgentInternal;
exports.removeFreeAgentInternal = removeFreeAgentInternal;

/**
 * Scheduled Cloud Function (v2) to update stats daily for MAJOR league free agents.
 */
exports.updateAllFreeAgentsScheduled = onSchedule({
    schedule: "35 6 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    console.log('Running daily free agent update job for MAJOR league...');

    const activeSeasonQuery = await db.collection(getCollectionName('seasons', LEAGUES.MAJOR)).where('status', '==', 'active').limit(1).get();
    if (activeSeasonQuery.empty) {
        console.error('Scheduled job failed: Could not find an active season.');
        return;
    }
    const activeSeasonId = activeSeasonQuery.docs[0].id;

    const freeAgentsCollectionRef = db.collection(getCollectionName('seasons', LEAGUES.MAJOR)).doc(activeSeasonId).collection('free_agents');
    const freeAgentsSnap = await freeAgentsCollectionRef.get();

    if (freeAgentsSnap.empty) {
        console.log('No free agents to update.');
        return;
    }

    const updatePromises = freeAgentsSnap.docs.map(async (doc) => {
        const freeAgent = doc.data();
        const docRef = doc.ref;

        try {
            // 1. Perform reliable karmafeed request first using player_id
            const karmaFeedResponse = await axios.get(`https://api.real.vg/user/${freeAgent.player_id}/karmafeed`, { headers: API_HEADERS });
            const newKarma = karmaFeedResponse.data?.stats?.karma;
            const newMonthlyRank = karmaFeedResponse.data?.stats?.karmaMonthRank;

            const updates = {};
            if (newKarma !== undefined) updates.karma = newKarma;
            if (newMonthlyRank !== undefined) updates.monthly_rank = newMonthlyRank;

            // 2. Perform potentially unreliable handle request
            const handleResponse = await axios.get(`https://api.real.vg/user/${freeAgent.player_handle}`, { headers: API_HEADERS });
            const handleData = handleResponse.data?.user;

            // 3. Verify that the ID from the handle lookup matches the stored ID
            if (handleData && handleData.id === freeAgent.player_id) {
                updates.ranked_days = handleData.daysTopHundred || 0;
            } else {
                // MISMATCH FOUND! Try to resolve the handle using cards API first.
                const resolvedHandle = await resolvePlayerHandle(freeAgent.player_id);

                if (resolvedHandle) {
                    console.log(`Auto-resolved handle mismatch: '${freeAgent.player_handle}' -> '${resolvedHandle}' (ID: ${freeAgent.player_id})`);
                    updates.player_handle = resolvedHandle;

                    try {
                        const resolvedHandleResponse = await axios.get(`https://api.real.vg/user/${resolvedHandle}`, { headers: API_HEADERS });
                        const resolvedHandleData = resolvedHandleResponse.data?.user;
                        if (resolvedHandleData && resolvedHandleData.id === freeAgent.player_id) {
                            updates.ranked_days = resolvedHandleData.daysTopHundred || 0;
                        } else {
                            updates.ranked_days = null;
                        }
                    } catch {
                        updates.ranked_days = null;
                    }
                } else {
                    updates.ranked_days = null;

                    const notification = {
                        type: 'HANDLE_ID_MISMATCH',
                        message: `Handle/ID mismatch for free agent '${freeAgent.player_handle}'. The handle may have changed.`,
                        player_handle: freeAgent.player_handle,
                        player_id: freeAgent.player_id,
                        status: 'unread',
                        module: 'manage-players',
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    };
                    await db.collection('notifications').add(notification);
                    console.warn(`Mismatch detected for handle: ${freeAgent.player_handle} (ID: ${freeAgent.player_id}). Notification created.`);
                }
            }

            if (Object.keys(updates).length > 0) {
                await docRef.update(updates);
            }

        } catch (error) {
            console.error(`Failed to process free agent ${freeAgent.player_handle} (ID: ${freeAgent.player_id}):`, error.message);
        }
    });

    await Promise.all(updatePromises);
    console.log(`Free agent update job complete. Processed ${freeAgentsSnap.size} free agents.`);
    return;
});

/**
 * Scheduled Cloud Function (v2) to update stats daily for MINOR league free agents.
 */
exports.minor_updateAllFreeAgentsScheduled = onSchedule({
    schedule: "35 6 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    console.log('Running daily free agent update job for MINOR league...');

    const activeSeasonQuery = await db.collection(getCollectionName('seasons', LEAGUES.MINOR)).where('status', '==', 'active').limit(1).get();
    if (activeSeasonQuery.empty) {
        console.error('Scheduled job failed: Could not find an active season for minor league.');
        return;
    }
    const activeSeasonId = activeSeasonQuery.docs[0].id;

    const freeAgentsCollectionRef = db.collection(getCollectionName('seasons', LEAGUES.MINOR)).doc(activeSeasonId).collection('free_agents');
    const freeAgentsSnap = await freeAgentsCollectionRef.get();

    if (freeAgentsSnap.empty) {
        console.log('No free agents to update in minor league.');
        return;
    }

    const updatePromises = freeAgentsSnap.docs.map(async (doc) => {
        const freeAgent = doc.data();
        const docRef = doc.ref;

        try {
            const karmaFeedResponse = await axios.get(`https://api.real.vg/user/${freeAgent.player_id}/karmafeed`, { headers: API_HEADERS });
            const newKarma = karmaFeedResponse.data?.stats?.karma;
            const newMonthlyRank = karmaFeedResponse.data?.stats?.karmaMonthRank;

            const updates = {};
            if (newKarma !== undefined) updates.karma = newKarma;
            if (newMonthlyRank !== undefined) updates.monthly_rank = newMonthlyRank;

            const handleResponse = await axios.get(`https://api.real.vg/user/${freeAgent.player_handle}`, { headers: API_HEADERS });
            const handleData = handleResponse.data?.user;

            if (handleData && handleData.id === freeAgent.player_id) {
                updates.ranked_days = handleData.daysTopHundred || 0;
            } else {
                const resolvedHandle = await resolvePlayerHandle(freeAgent.player_id);

                if (resolvedHandle) {
                    console.log(`[Minor] Auto-resolved handle mismatch: '${freeAgent.player_handle}' -> '${resolvedHandle}' (ID: ${freeAgent.player_id})`);
                    updates.player_handle = resolvedHandle;

                    try {
                        const resolvedHandleResponse = await axios.get(`https://api.real.vg/user/${resolvedHandle}`, { headers: API_HEADERS });
                        const resolvedHandleData = resolvedHandleResponse.data?.user;
                        if (resolvedHandleData && resolvedHandleData.id === freeAgent.player_id) {
                            updates.ranked_days = resolvedHandleData.daysTopHundred || 0;
                        } else {
                            updates.ranked_days = null;
                        }
                    } catch {
                        updates.ranked_days = null;
                    }
                } else {
                    updates.ranked_days = null;

                    const notification = {
                        type: 'HANDLE_ID_MISMATCH',
                        message: `[Minor League] Handle/ID mismatch for free agent '${freeAgent.player_handle}'. The handle may have changed.`,
                        player_handle: freeAgent.player_handle,
                        player_id: freeAgent.player_id,
                        status: 'unread',
                        module: 'manage-players',
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    };
                    await db.collection('notifications').add(notification);
                    console.warn(`Mismatch detected for handle: ${freeAgent.player_handle} (ID: ${freeAgent.player_id}). Notification created.`);
                }
            }

            if (Object.keys(updates).length > 0) {
                await docRef.update(updates);
            }

        } catch (error) {
            console.error(`Failed to process free agent ${freeAgent.player_handle} (ID: ${freeAgent.player_id}):`, error.message);
        }
    });

    await Promise.all(updatePromises);
    console.log(`Minor league free agent update job complete. Processed ${freeAgentsSnap.size} free agents.`);
    return;
});

/**
 * Cloud Function (v2) to remove a free agent by player ID.
 */
exports.removeFreeAgent = onCall(async (request) => {
    const league = request.data?.league || LEAGUES.MAJOR;

    // Auth Check
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'You must be logged in to perform this action.');
    }
    const userDoc = await db.collection('users').doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'You must be an admin to remove free agents.');
    }

    const playerId = request.data.playerId;
    if (!playerId || typeof playerId !== 'string') {
        throw new HttpsError('invalid-argument', 'The function must be called with a player ID.');
    }

    const success = await removeFreeAgentInternal(playerId, league);

    if (success) {
        return { success: true, league, message: `Successfully removed player ${playerId} from free agents.` };
    } else {
        throw new HttpsError('internal', 'Failed to remove free agent.');
    }
});
