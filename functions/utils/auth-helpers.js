// functions/utils/auth-helpers.js

const { admin, db } = require('./firebase-admin');
const { getCollectionName } = require('./firebase-helpers');

/**
 * League context constants
 */
const LEAGUES = {
    MAJOR: 'major',
    MINOR: 'minor'
};

/**
 * Helper function to check for admin or scorekeeper roles
 * @param {object} auth - The Firebase auth context
 * @param {string} league - League context ('major' or 'minor')
 * @returns {Promise<boolean>} True if user is admin or scorekeeper
 */
async function isScorekeeperOrAdmin(auth, league = LEAGUES.MAJOR) {
    if (!auth) return false;
    // 'users' is a shared collection, so no league parameter needed
    const userDoc = await db.collection(getCollectionName('users')).doc(auth.uid).get();
    if (!userDoc.exists) return false;
    const role = userDoc.data().role;
    return role === 'admin' || role === 'scorekeeper';
}

/**
 * Helper function to get user role
 * @param {object} auth - The Firebase auth context
 * @param {string} league - League context ('major' or 'minor')
 * @returns {Promise<string|null>} The user's role or null
 */
async function getUserRole(auth, league = LEAGUES.MAJOR) {
    if (!auth) return null;
    // 'users' is a shared collection, so no league parameter needed
    const userDoc = await db.collection(getCollectionName('users')).doc(auth.uid).get();
    return userDoc.exists ? userDoc.data().role : null;
}

module.exports = {
    isScorekeeperOrAdmin,
    getUserRole,
    LEAGUES
};
