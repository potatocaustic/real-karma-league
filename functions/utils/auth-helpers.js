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

/**
 * Helper function to get user's team ID in a specific league
 * @param {object} auth - The Firebase auth context
 * @param {string} league - League context ('major' or 'minor')
 * @returns {Promise<string|null>} The user's team ID or null
 */
async function getUserTeamId(auth, league = LEAGUES.MAJOR) {
    if (!auth) return null;

    const userDoc = await db.collection(getCollectionName('users')).doc(auth.uid).get();
    if (!userDoc.exists) return null;

    const userData = userDoc.data();
    const teamIdField = league === LEAGUES.MINOR ? 'minor_team_id' : 'major_team_id';

    // Return league-specific team, fallback to old team_id for major league (backward compat)
    return userData[teamIdField] || (league === LEAGUES.MAJOR ? userData.team_id : null);
}

/**
 * Helper function to check if user is GM of a specific team
 * @param {object} auth - The Firebase auth context
 * @param {string} teamId - Team ID to check
 * @param {string} league - League context ('major' or 'minor')
 * @returns {Promise<boolean>} True if user is GM of the team
 */
async function isUserGMOfTeam(auth, teamId, league = LEAGUES.MAJOR) {
    const userTeamId = await getUserTeamId(auth, league);
    return userTeamId === teamId;
}

module.exports = {
    isScorekeeperOrAdmin,
    getUserRole,
    getUserTeamId,
    isUserGMOfTeam,
    LEAGUES
};
