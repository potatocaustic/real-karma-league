// functions/admin/admin-activity.js

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require("../utils/firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const { getCollectionName, getLeagueFromRequest } = require('../utils/firebase-helpers');
const { isScorekeeperOrAdmin, getUserRole } = require('../utils/auth-helpers');

/**
 * Logs scorekeeper and admin activities to an audit trail.
 * Used for tracking important actions performed by privileged users.
 */
exports.logScorekeeperActivity = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
    if (!(await isScorekeeperOrAdmin(request.auth, league))) {
        throw new HttpsError('permission-denied', 'Must be an admin or scorekeeper to log an action.');
    }

    const { action, details } = request.data;
    if (!action) {
        throw new HttpsError('invalid-argument', 'An "action" must be provided.');
    }

    const userId = request.auth.uid;
    const userEmail = request.auth.token.email || null;

    try {
        // 'scorekeeper_activity_log' is a shared collection, so no league parameter needed
        const logRef = db.collection(getCollectionName('scorekeeper_activity_log')).doc();
        await logRef.set({
            action: action,
            userId: userId,
            userEmail: userEmail,
            userRole: await getUserRole(request.auth, league),
            timestamp: FieldValue.serverTimestamp(),
            details: details || null
        });
        return { success: true, league, message: "Activity logged successfully." };

    } catch (error) {
        console.error("Error logging scorekeeper activity:", error);
        throw new HttpsError('internal', 'Could not log activity.');
    }
});
