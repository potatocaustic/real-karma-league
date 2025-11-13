// functions/admin/admin-teams.js

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getCollectionName, getLeagueFromRequest } = require('../utils/firebase-helpers');

// Ensure admin is initialized (will use existing instance if already initialized)
if (!admin.apps.length) {
    admin.initializeApp();
}
const db = admin.firestore();

/**
 * Rebrands a team by migrating all data from an old team ID to a new team ID.
 * Updates team documents, player assignments, draft picks, and maintains historical records.
 * Admin-only function.
 */
exports.rebrandTeam = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
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

        const activeSeasonSnap = await db.collection(getCollectionName('seasons', league)).where('status', '==', 'active').limit(1).get();
        if (activeSeasonSnap.empty) {
            throw new HttpsError('failed-precondition', 'No active season found.');
        }
        const activeSeasonId = activeSeasonSnap.docs[0].id;

        const oldTeamRef = db.collection(getCollectionName('v2_teams', league)).doc(oldTeamId);
        const oldTeamDoc = await oldTeamRef.get();
        if (!oldTeamDoc.exists) {
            throw new HttpsError('not-found', `Old team with ID ${oldTeamId} not found.`);
        }

        const newTeamRef = db.collection(getCollectionName('v2_teams', league)).doc(newTeamId);
        const newTeamData = { ...oldTeamDoc.data(), team_id: newTeamId, gm_player_id: oldTeamDoc.data().gm_player_id || null };
        batch.set(newTeamRef, newTeamData);

        const oldRecordsSnap = await oldTeamRef.collection(getCollectionName('seasonal_records', league)).get();
        oldRecordsSnap.forEach(doc => {
            const newRecordRef = newTeamRef.collection(getCollectionName('seasonal_records', league)).doc(doc.id);
            let recordData = doc.data();
            if (doc.id === activeSeasonId) {
                recordData.team_id = newTeamId;
                recordData.team_name = newTeamName;
            }
            batch.set(newRecordRef, recordData);
        });

        const playersQuery = db.collection(getCollectionName('v2_players', league)).where('current_team_id', '==', oldTeamId);
        const playersSnap = await playersQuery.get();
        playersSnap.forEach(doc => {
            batch.update(doc.ref, { current_team_id: newTeamId });
        });
        console.log(`Found and updated ${playersSnap.size} players.`);

        const picksOwnerQuery = db.collection(getCollectionName('draftPicks', league)).where('current_owner', '==', oldTeamId);
        const picksOriginalQuery = db.collection(getCollectionName('draftPicks', league)).where('original_team', '==', oldTeamId);

        const [ownerPicksSnap, originalPicksSnap] = await Promise.all([picksOwnerQuery.get(), picksOriginalQuery.get()]);

        const allPicksToUpdate = new Map();
        ownerPicksSnap.forEach(doc => allPicksToUpdate.set(doc.id, doc.data()));
        originalPicksSnap.forEach(doc => allPicksToUpdate.set(doc.id, doc.data()));

        for (const [pickId, pickData] of allPicksToUpdate.entries()) {
            const oldPickRef = db.collection(getCollectionName('draftPicks', league)).doc(pickId);

            if (pickData.pick_description && pickData.pick_description.includes(oldTeamId)) {
                pickData.pick_description = pickData.pick_description.replace(oldTeamId, newTeamId);
            }

            if (pickId.includes(oldTeamId)) {
                const newPickId = pickId.replace(oldTeamId, newTeamId);
                const newPickRef = db.collection(getCollectionName('draftPicks', league)).doc(newPickId);
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
        const oldTeamRecordsToDeleteSnap = await oldTeamRef.collection(getCollectionName('seasonal_records', league)).get();
        oldTeamRecordsToDeleteSnap.forEach(doc => {
            deleteBatch.delete(doc.ref);
        });
        deleteBatch.delete(oldTeamRef);
        await deleteBatch.commit();

        console.log(`Rebrand complete. Old team ${oldTeamId} deleted.`);
        return { success: true, league, message: `Team ${oldTeamId} successfully rebranded to ${newTeamId}.` };

    } catch (error) {
        console.error("Error rebranding team:", error);
        throw new HttpsError('internal', `Failed to rebrand team: ${error.message}`);
    }
});
