// functions/utils/firebase-helpers.js

const { admin } = require('./firebase-admin');

let HttpsError;

function getHttpsError() {
    if (!HttpsError) {
        ({ HttpsError } = require('firebase-functions/v2/https'));
    }
    return HttpsError;
}

const USE_DEV_COLLECTIONS = false;

/**
 * League context constants
 */
const LEAGUES = {
    MAJOR: 'major',
    MINOR: 'minor'
};

/**
 * Normalizes league query parameters from HTTP requests.
 * Accepts arrays, trims whitespace, and extracts 'major'/'minor' if present.
 * Defaults to MAJOR when unset or empty.
 * @param {string|string[]|undefined|null} leagueParam
 * @returns {string}
 */
const normalizeLeagueParam = (leagueParam) => {
    if (!leagueParam) return LEAGUES.MAJOR;
    const rawValue = Array.isArray(leagueParam) ? leagueParam[0] : leagueParam;
    const raw = String(rawValue).trim().toLowerCase();
    if (!raw) return LEAGUES.MAJOR;
    const match = raw.match(/(major|minor)/);
    return match ? match[1] : raw;
};

/**
 * Gets the proper collection name with league prefix and dev suffix as needed
 * @param {string} baseName - Base collection name (e.g., 'seasons', 'v2_players')
 * @param {string} league - League context ('major' or 'minor')
 * @returns {string} Prefixed collection name
 */
const getCollectionName = (baseName, league = LEAGUES.MAJOR) => {
    // Special collections that are shared between leagues
    const sharedCollections = ['users', 'notifications', 'scorekeeper_activity_log'];

    // Collections that already have their own structure (don't double-prefix)
    const structuredCollections = [
        'daily_averages',
        'daily_scores',
        'post_daily_averages',
        'post_daily_scores',
        'draft_results',
        'awards',
        // Nested under league-specific season docs, so double-prefixing would create a wrong path
        'games',
        'lineups',
        'post_games',
        'post_lineups',
        'exhibition_games',
        'exhibition_lineups'
    ];

    // Apply dev suffix if needed
    const devSuffix = USE_DEV_COLLECTIONS ? '_dev' : '';

    // Return shared collections without league prefix
    if (sharedCollections.includes(baseName)) {
        return `${baseName}${devSuffix}`;
    }

    // Return structured collections without league prefix (handled internally)
    if (structuredCollections.includes(baseName)) {
        return `${baseName}${devSuffix}`;
    }

    // Apply league prefix for league-specific collections
    const leaguePrefix = league === LEAGUES.MINOR ? 'minor_' : '';
    return `${leaguePrefix}${baseName}${devSuffix}`;
};

/**
 * Validates league parameter
 * @param {string} league - League to validate
 * @throws {HttpsError} If league is invalid
 */
const validateLeague = (league) => {
    if (league && !Object.values(LEAGUES).includes(league)) {
        const HttpsErrorCtor = getHttpsError();
        throw new HttpsErrorCtor('invalid-argument', `Invalid league: ${league}. Must be 'major' or 'minor'.`);
    }
};

/**
 * Gets league from request data, defaults to major
 * @param {object} data - Request data object
 * @returns {string} League context
 */
const getLeagueFromRequest = (data) => {
    const league = data?.league || LEAGUES.MAJOR;
    validateLeague(league);
    return league;
};

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

module.exports = {
    getCollectionName,
    validateLeague,
    getLeagueFromRequest,
    deleteCollection,
    LEAGUES,
    USE_DEV_COLLECTIONS,
    normalizeLeagueParam
};
