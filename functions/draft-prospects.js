const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const axios = require("axios");

// Initialize admin if not already done in index.js
if (admin.apps.length === 0) {
    admin.initializeApp();
}

const db = admin.firestore();

// Headers to mimic a real browser request
const API_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
};

/**
 * Fetches user data from the Real.vg API for a given player handle.
 * @param {string} playerHandle The player's username.
 * @returns {Promise<object|null>} The processed prospect data or null if failed.
 */
const fetchProspectData = async (playerHandle) => {
    try {
        const userResponse = await axios.get(`https://api.real.vg/user/${playerHandle}`, { headers: API_HEADERS });
        const userData = userResponse.data?.user;

        if (!userData || !userData.id) {
            console.error(`Could not find user or user ID for handle: ${playerHandle}`);
            return null;
        }

        const playerId = userData.id;
        const prospectData = {
            player_handle: playerHandle,
            player_id: playerId,
            karma: userData.karma || 0,
            ranked_days: userData.daysTopHundred || 0,
            monthly_rank: null
        };

        const karmaFeedResponse = await axios.get(`https://api.real.vg/user/${playerId}/karmafeed`, { headers: API_HEADERS });
        const karmaMonthRank = karmaFeedResponse.data?.stats?.karmaMonthRank;

        if (karmaMonthRank !== undefined) {
            prospectData.monthly_rank = karmaMonthRank;
        }

        return prospectData;

    } catch (error) {
        console.error(`Error fetching data for prospect ${playerHandle}:`, error.message);
        return null;
    }
};

/**
 * Cloud Function (v2) to add new draft prospects.
 */
exports.addDraftProspects = onCall(async (request) => {
    // v2 Auth Check
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'You must be logged in to perform this action.');
    }
    const userDoc = await db.collection('users').doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'You must be an admin to add prospects.');
    }

    // v2 Data Access
    const handlesString = request.data.handles;
    if (!handlesString || typeof handlesString !== 'string') {
        throw new HttpsError('invalid-argument', 'The function must be called with a string of handles.');
    }

    const activeSeasonQuery = await db.collection('seasons').where('status', '==', 'active').limit(1).get();
    if (activeSeasonQuery.empty) {
        throw new HttpsError('failed-precondition', 'Could not find an active season.');
    }
    const activeSeasonId = activeSeasonQuery.docs[0].id;

    const handles = handlesString.split(',').map(h => h.trim()).filter(Boolean);
    const prospectsCollectionRef = db.collection('seasons').doc(activeSeasonId).collection('draft_prospects');

    let successCount = 0;
    let failedHandles = [];

    const processingPromises = handles.map(async (handle) => {
        const prospectData = await fetchProspectData(handle);
        if (prospectData) {
            try {
                await prospectsCollectionRef.doc(prospectData.player_id).set(prospectData);
                successCount++;
            } catch (error) {
                console.error(`Failed to write prospect ${handle} to Firestore:`, error);
                failedHandles.push(handle);
            }
        } else {
            failedHandles.push(handle);
        }
    });

    await Promise.all(processingPromises);

    let message = `${successCount} of ${handles.length} prospects were successfully added.`;
    if (failedHandles.length > 0) {
        message += ` Failed handles: ${failedHandles.join(', ')}.`;
    }

    return { success: true, message };
});

/**
 * Scheduled Cloud Function (v2) to update stats daily.
 */
exports.updateAllProspectsScheduled = onSchedule({
    schedule: "30 6 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    console.log('Running daily prospect update job...');

    const activeSeasonQuery = await db.collection('seasons').where('status', '==', 'active').limit(1).get();
    if (activeSeasonQuery.empty) {
        console.error('Scheduled job failed: Could not find an active season.');
        return;
    }
    const activeSeasonId = activeSeasonQuery.docs[0].id;
    console.log(`Found active season: ${activeSeasonId}`);

    const prospectsCollectionRef = db.collection('seasons').doc(activeSeasonId).collection('draft_prospects');
    const prospectsSnap = await prospectsCollectionRef.get();

    if (prospectsSnap.empty) {
        console.log('No prospects to update.');
        return;
    }

    const batch = db.batch();

    const updatePromises = prospectsSnap.docs.map(async (doc) => {
        const existingData = doc.data();
        const handle = existingData.player_handle;

        const freshData = await fetchProspectData(handle);
        if (freshData) {
            const docRef = prospectsCollectionRef.doc(freshData.player_id);
            batch.update(docRef, {
                karma: freshData.karma,
                ranked_days: freshData.ranked_days,
                monthly_rank: freshData.monthly_rank
            });
        } else {
            console.log(`Skipping update for ${handle}, failed to fetch fresh data.`);
        }
    });

    await Promise.all(updatePromises);
    await batch.commit();

    console.log(`Successfully updated ${prospectsSnap.size} prospects.`);
    return;
});