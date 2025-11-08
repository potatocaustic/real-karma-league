const { HttpsError } = require("firebase-functions/v2/https");

const LEAGUES = {
  MAJOR: 'major',
  MINOR: 'minor'
};

/**
 * Checks if user has admin/scorekeeper access for the specified league
 * @param {object} auth - Firebase auth context
 * @param {object} db - Firestore database instance
 * @param {string} league - League context
 * @returns {Promise<boolean>}
 */
async function hasLeagueAccess(auth, db, league) {
  if (!auth) return false;

  const userDoc = await db.collection('users').doc(auth.uid).get();
  if (!userDoc.exists) return false;

  const userData = userDoc.data();
  const role = userData.role;

  // Admins have access to all leagues
  if (role === 'admin') return true;

  // Check league-specific access (future: userData.leagues array)
  // For now, scorekeepers have access to their assigned league
  if (role === 'scorekeeper') {
    // TODO: Implement league-specific permissions
    return true;
  }

  return false;
}

/**
 * Wraps a function to inject league context
 * @param {Function} fn - The function to wrap
 * @returns {Function} Wrapped function with league support
 */
function withLeagueContext(fn) {
  return async (request) => {
    const league = request.data?.league || LEAGUES.MAJOR;

    if (!Object.values(LEAGUES).includes(league)) {
      throw new HttpsError('invalid-argument', `Invalid league: ${league}`);
    }

    // Inject league into request context
    request.leagueContext = league;

    return fn(request);
  };
}

module.exports = {
  LEAGUES,
  hasLeagueAccess,
  withLeagueContext
};
