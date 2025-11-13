// functions/admin/admin-tradeblocks.js

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getCollectionName, getLeagueFromRequest } = require('../utils/firebase-helpers');

// Ensure admin is initialized (will use existing instance if already initialized)
if (!admin.apps.length) {
    admin.initializeApp();
}
const db = admin.firestore();

/**
 * Clears all trade blocks and sets the trade deadline status to closed.
 * Used when the trade deadline passes.
 * Admin-only function.
 */
exports.clearAllTradeBlocks = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
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
        return { success: true, league, message: "All trade blocks have been cleared and the deadline is now active." };

    } catch (error) {
        console.error("Error clearing trade blocks:", error);
        throw new HttpsError('internal', 'An error occurred while clearing trade blocks.');
    }
});

/**
 * Reopens the trade blocks for a new trading period.
 * Admin-only function.
 */
exports.reopenTradeBlocks = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
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

        return { success: true, league, message: "Trading has been successfully re-opened." };

    } catch (error) {
        console.error("Error reopening trade blocks:", error);
        throw new HttpsError('internal', 'An error occurred while reopening trade blocks.');
    }
});
