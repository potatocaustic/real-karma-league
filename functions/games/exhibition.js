// functions/games/exhibition.js

const { onDocumentUpdated } = require("firebase-functions/v2/firestore");

/**
 * Logs completion of exhibition games for major league (no stat aggregation)
 */
exports.processCompletedExhibitionGame = onDocumentUpdated(`seasons/{seasonId}/exhibition_games/{gameId}`, async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    const { seasonId, gameId } = event.params;

    if (after.completed !== 'TRUE' || before.completed === 'TRUE') {
        return null;
    }

    console.log(`Logging completion of EXHIBITION game ${gameId} in season ${seasonId}. No stat aggregation will occur.`);

    return null;
});

/**
 * Logs completion of exhibition games for minor league (no stat aggregation)
 */
exports.minor_processCompletedExhibitionGame = onDocumentUpdated(`minor_seasons/{seasonId}/minor_exhibition_games/{gameId}`, async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();
    const { seasonId, gameId } = event.params;

    if (after.completed !== 'TRUE' || before.completed === 'TRUE') {
        return null;
    }

    console.log(`Minor League: Logging completion of EXHIBITION game ${gameId} in season ${seasonId}. No stat aggregation will occur.`);

    return null;
});
