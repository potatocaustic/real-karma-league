// functions/games/game-updates.js

const { onDocumentUpdated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { admin, db } = require('../utils/firebase-admin');
const { FieldValue } = require("firebase-admin/firestore");
const { LEAGUES } = require('../utils/firebase-helpers');
const { processCompletedGame } = require('./game-processing');

/**
 * Regular season game update trigger for major league
 */
exports.onRegularGameUpdate_V2 = onDocumentUpdated(`seasons/{seasonId}/games/{gameId}`, processCompletedGame);

/**
 * Postseason game update trigger for major league
 */
exports.onPostGameUpdate_V2 = onDocumentUpdated(`seasons/{seasonId}/post_games/{gameId}`, processCompletedGame);

/**
 * Regular season game update trigger for minor league
 */
exports.minor_onRegularGameUpdate_V2 = onDocumentUpdated(`minor_seasons/{seasonId}/games/{gameId}`, async (event) => {
    return processCompletedGame(event, LEAGUES.MINOR);
});

/**
 * Postseason game update trigger for minor league
 */
exports.minor_onPostGameUpdate_V2 = onDocumentUpdated(`minor_seasons/{seasonId}/post_games/{gameId}`, async (event) => {
    return processCompletedGame(event, LEAGUES.MINOR);
});

/**
 * Updates games scheduled count when games are added/removed for major league
 */
exports.updateGamesScheduledCount = onDocumentWritten(`seasons/{seasonId}/games/{gameId}`, (event) => {
    const { seasonId, gameId } = event.params;
    if (gameId === 'placeholder') {
        return null;
    }

    const seasonRef = db.collection('seasons').doc(seasonId);
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

/**
 * Updates games scheduled count when games are added/removed for minor league
 */
exports.minor_updateGamesScheduledCount = onDocumentWritten(`minor_seasons/{seasonId}/games/{gameId}`, (event) => {
    const { seasonId, gameId } = event.params;
    if (gameId === 'placeholder') {
        return null;
    }

    const seasonRef = db.collection('minor_seasons').doc(seasonId);
    const beforeExists = event.data.before.exists;
    const afterExists = event.data.after.exists;

    if (!beforeExists && afterExists) {
        console.log(`Minor League: Incrementing games scheduled for ${seasonId}.`);
        return seasonRef.update({ gs: FieldValue.increment(1) });
    } else if (beforeExists && !afterExists) {
        console.log(`Minor League: Decrementing games scheduled for ${seasonId}.`);
        return seasonRef.update({ gs: FieldValue.increment(-1) });
    }

    return null;
});
