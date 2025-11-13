// functions/games/legacy.js

const { onDocumentUpdated, onDocumentCreated } = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");

// Ensure admin is initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

const db = admin.firestore();

/**
 * Legacy transaction processor for player movements and draft pick trades
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

/**
 * Legacy game update handler for old schedule collection
 */
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
