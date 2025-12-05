// functions/admin/admin-transactions.js

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require("../utils/firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const { getCollectionName, getLeagueFromRequest } = require('../utils/firebase-helpers');

/**
 * Processes a transaction, checking if any involved players are in live games.
 * If players are in live games, the transaction is held in pending status until the games complete.
 * Otherwise, the transaction is processed immediately.
 * Requires admin or commissioner role for the specific league.
 */
exports.admin_processTransaction = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
    if (!request.auth || !request.auth.uid) {
        throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    const roleField = `role_${league}`;
    if (!userDoc.exists || !(userDoc.data().role === 'admin' || userDoc.data()[roleField] === 'commish')) {
        throw new HttpsError('permission-denied', 'Must be an admin or commissioner to process transactions.');
    }

    const transactionData = request.data;
    const involvedPlayerIds = (transactionData.involved_players || []).map(p => p.id);

    if (involvedPlayerIds.length === 0) {
        // Not a player transaction (e.g., draft pick only trade), process immediately
        await db.collection(getCollectionName("transactions", league)).add({ ...transactionData, date: FieldValue.serverTimestamp() });
        return { success: true, league, message: "Transaction logged successfully and will be processed immediately." };
    }

    try {
        const liveGamesSnap = await db.collection(getCollectionName('live_games', league)).get();
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
            await db.collection(getCollectionName('pending_transactions', league)).add({ ...transactionData, date: FieldValue.serverTimestamp() });
            return { success: true, league, message: "A player in this transaction is in a live game. The transaction is now pending and will be processed overnight." };
        } else {
            // No live players, process immediately
            await db.collection(getCollectionName('transactions', league)).add({ ...transactionData, date: FieldValue.serverTimestamp() });
            return { success: true, league, message: "Transaction logged successfully and will be processed immediately." };
        }

    } catch (error) {
        console.error("Error processing transaction:", error);
        throw new HttpsError('internal', 'An unexpected error occurred while processing the transaction.');
    }
});
