// functions/utils/team-name-matcher.js
// Fuzzy matching for team names with league detection

const { admin, db } = require('./firebase-admin');
const { getCollectionName, LEAGUES } = require('./firebase-helpers');

/**
 * Pre-built alias map for common team name variations
 * Maps lowercase alias -> { id, league }
 */
const TEAM_ALIASES = {
    // Major League Teams (add actual team IDs as needed)
    'pengs': { id: 'PENGUINS', league: LEAGUES.MAJOR },
    'penguins': { id: 'PENGUINS', league: LEAGUES.MAJOR },
    'kock': { id: 'KOCK', league: LEAGUES.MAJOR },
    'fruit': { id: 'FRUIT', league: LEAGUES.MAJOR },
    'aces': { id: 'ACES', league: LEAGUES.MAJOR },
    'flames': { id: 'FLAMES', league: LEAGUES.MAJOR },
    'eggheads': { id: 'EGGHEADS', league: LEAGUES.MAJOR },
    'juice': { id: 'JUICE', league: LEAGUES.MAJOR },
    'bravos': { id: 'BRAVOS', league: LEAGUES.MAJOR },
    'mafia': { id: 'MAFIA', league: LEAGUES.MAJOR },
    'raptors': { id: 'RAPTORS', league: LEAGUES.MAJOR },
    'pandas': { id: 'PANDAS', league: LEAGUES.MAJOR },

    // Minor League Teams (add actual team IDs as needed)
    // These will be populated dynamically from Firestore
};

// Cache for team data from Firestore
let teamCache = null;
let teamCacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Load teams from Firestore and build lookup maps
 * @returns {Promise<Object>} Team lookup maps
 */
async function loadTeamsFromFirestore() {
    const now = Date.now();

    // Return cached data if still valid
    if (teamCache && now < teamCacheExpiry) {
        return teamCache;
    }

    console.log('Loading teams from Firestore...');

    const majorTeams = new Map();
    const minorTeams = new Map();
    const aliasMap = new Map();

    // Copy static aliases
    for (const [alias, data] of Object.entries(TEAM_ALIASES)) {
        aliasMap.set(alias.toLowerCase(), data);
    }

    // Get active seasons to find current team names
    const [majorSeasonSnap, minorSeasonSnap] = await Promise.all([
        db.collection(getCollectionName('seasons', LEAGUES.MAJOR))
            .where('status', '==', 'active')
            .limit(1)
            .get(),
        db.collection(getCollectionName('seasons', LEAGUES.MINOR))
            .where('status', '==', 'active')
            .limit(1)
            .get()
    ]);

    const majorSeasonId = majorSeasonSnap.empty ? null : majorSeasonSnap.docs[0].id;
    const minorSeasonId = minorSeasonSnap.empty ? null : minorSeasonSnap.docs[0].id;

    // Load major league teams
    const majorTeamsSnap = await db.collection(getCollectionName('v2_teams', LEAGUES.MAJOR)).get();
    for (const doc of majorTeamsSnap.docs) {
        const teamId = doc.id;
        let teamName = teamId; // Default to ID

        // Try to get current season name
        if (majorSeasonId) {
            const recordDoc = await db
                .collection(getCollectionName('v2_teams', LEAGUES.MAJOR))
                .doc(teamId)
                .collection(getCollectionName('seasonal_records', LEAGUES.MAJOR))
                .doc(majorSeasonId)
                .get();

            if (recordDoc.exists) {
                teamName = recordDoc.data().team_name || teamId;
            }
        }

        majorTeams.set(teamId, { id: teamId, name: teamName, league: LEAGUES.MAJOR });

        // Add aliases for this team
        aliasMap.set(teamId.toLowerCase(), { id: teamId, league: LEAGUES.MAJOR });
        aliasMap.set(teamName.toLowerCase(), { id: teamId, league: LEAGUES.MAJOR });

        // Add first word as alias (e.g., "EGGHEADS" from "EGGHEADS Something")
        const firstWord = teamName.split(/\s+/)[0];
        if (firstWord && !aliasMap.has(firstWord.toLowerCase())) {
            aliasMap.set(firstWord.toLowerCase(), { id: teamId, league: LEAGUES.MAJOR });
        }
    }

    // Load minor league teams
    const minorTeamsSnap = await db.collection(getCollectionName('v2_teams', LEAGUES.MINOR)).get();
    for (const doc of minorTeamsSnap.docs) {
        const teamId = doc.id;
        let teamName = teamId;

        if (minorSeasonId) {
            const recordDoc = await db
                .collection(getCollectionName('v2_teams', LEAGUES.MINOR))
                .doc(teamId)
                .collection(getCollectionName('seasonal_records', LEAGUES.MINOR))
                .doc(minorSeasonId)
                .get();

            if (recordDoc.exists) {
                teamName = recordDoc.data().team_name || teamId;
            }
        }

        minorTeams.set(teamId, { id: teamId, name: teamName, league: LEAGUES.MINOR });

        // Add aliases (only if not already claimed by major league)
        if (!aliasMap.has(teamId.toLowerCase())) {
            aliasMap.set(teamId.toLowerCase(), { id: teamId, league: LEAGUES.MINOR });
        }
        if (!aliasMap.has(teamName.toLowerCase())) {
            aliasMap.set(teamName.toLowerCase(), { id: teamId, league: LEAGUES.MINOR });
        }

        const firstWord = teamName.split(/\s+/)[0];
        if (firstWord && !aliasMap.has(firstWord.toLowerCase())) {
            aliasMap.set(firstWord.toLowerCase(), { id: teamId, league: LEAGUES.MINOR });
        }
    }

    teamCache = { majorTeams, minorTeams, aliasMap };
    teamCacheExpiry = now + CACHE_TTL_MS;

    console.log(`Loaded ${majorTeams.size} major and ${minorTeams.size} minor teams, ${aliasMap.size} aliases`);

    return teamCache;
}

/**
 * Calculate string similarity (Levenshtein distance based)
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {number} Similarity score 0-1
 */
function stringSimilarity(a, b) {
    a = a.toLowerCase();
    b = b.toLowerCase();

    if (a === b) return 1;
    if (a.length === 0 || b.length === 0) return 0;

    // Check if one contains the other
    if (a.includes(b) || b.includes(a)) {
        return 0.8;
    }

    // Levenshtein distance
    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }

    const distance = matrix[b.length][a.length];
    const maxLength = Math.max(a.length, b.length);
    return 1 - distance / maxLength;
}

/**
 * Match a team name to a team ID with league detection
 * @param {string} text - Team name/alias to match
 * @param {string|null} preferredLeague - Preferred league if ambiguous
 * @returns {Promise<Object|null>} Match result { teamId, teamName, league, confidence }
 */
async function matchTeamName(text, preferredLeague = null) {
    if (!text) return null;

    const { aliasMap, majorTeams, minorTeams } = await loadTeamsFromFirestore();
    const searchText = text.toLowerCase().trim();

    // Direct alias match
    if (aliasMap.has(searchText)) {
        const match = aliasMap.get(searchText);
        const teams = match.league === LEAGUES.MAJOR ? majorTeams : minorTeams;
        const teamData = teams.get(match.id);

        return {
            teamId: match.id,
            teamName: teamData?.name || match.id,
            league: match.league,
            confidence: 'high'
        };
    }

    // Fuzzy match against all aliases
    let bestMatch = null;
    let bestScore = 0;

    for (const [alias, data] of aliasMap) {
        const score = stringSimilarity(searchText, alias);
        if (score > bestScore && score > 0.6) {
            // Apply league preference boost
            let adjustedScore = score;
            if (preferredLeague && data.league === preferredLeague) {
                adjustedScore += 0.1;
            }

            if (adjustedScore > bestScore) {
                bestScore = adjustedScore;
                bestMatch = data;
            }
        }
    }

    if (bestMatch) {
        const teams = bestMatch.league === LEAGUES.MAJOR ? majorTeams : minorTeams;
        const teamData = teams.get(bestMatch.id);

        return {
            teamId: bestMatch.id,
            teamName: teamData?.name || bestMatch.id,
            league: bestMatch.league,
            confidence: bestScore > 0.85 ? 'high' : bestScore > 0.7 ? 'medium' : 'low'
        };
    }

    return null;
}

/**
 * Match multiple team names and determine league from consensus
 * @param {Array<string>} teamNames - Array of team names to match
 * @returns {Promise<Object>} { matches: [], league: 'major'|'minor', confidence }
 */
async function matchTeamNames(teamNames) {
    const matches = [];
    const leagueCounts = { major: 0, minor: 0 };

    for (const name of teamNames) {
        const match = await matchTeamName(name);
        if (match) {
            matches.push(match);
            leagueCounts[match.league]++;
        } else {
            matches.push({ teamName: name, teamId: null, league: null, confidence: 'none' });
        }
    }

    // Determine league by majority
    let detectedLeague = null;
    if (leagueCounts.major > leagueCounts.minor) {
        detectedLeague = LEAGUES.MAJOR;
    } else if (leagueCounts.minor > leagueCounts.major) {
        detectedLeague = LEAGUES.MINOR;
    } else if (leagueCounts.major > 0) {
        // Tie with at least one match - default to major
        detectedLeague = LEAGUES.MAJOR;
    }

    // Calculate overall confidence
    const matchedCount = matches.filter(m => m.teamId).length;
    let confidence = 'low';
    if (matchedCount === teamNames.length && matchedCount > 0) {
        confidence = 'high';
    } else if (matchedCount > 0) {
        confidence = 'medium';
    }

    return {
        matches,
        league: detectedLeague,
        confidence
    };
}

/**
 * Extract team names from transaction text
 * @param {string} text - Transaction text
 * @returns {Array<string>} Extracted potential team names
 */
function extractPotentialTeamNames(text) {
    const teamNames = [];

    // Pattern: "from TeamName" or "to TeamName"
    const fromToMatches = text.match(/(?:from|to)\s+(\w+)/gi);
    if (fromToMatches) {
        for (const match of fromToMatches) {
            const name = match.replace(/^(?:from|to)\s+/i, '');
            if (name && name.length > 2) {
                teamNames.push(name);
            }
        }
    }

    // Pattern: "TeamName cuts/signs/cut/sign"
    const actionMatches = text.match(/(\w+)\s+(?:cuts?|signs?|cutting|signing)/gi);
    if (actionMatches) {
        for (const match of actionMatches) {
            const name = match.replace(/\s+(?:cuts?|signs?|cutting|signing)$/i, '');
            if (name && name.length > 2 && !name.startsWith('@')) {
                teamNames.push(name);
            }
        }
    }

    // Pattern: "Trade between X and Y"
    const tradeMatch = text.match(/trade\s+between\s+(\w+)\s+and\s+(\w+)/i);
    if (tradeMatch) {
        teamNames.push(tradeMatch[1], tradeMatch[2]);
    }

    // Pattern: "X receives" (for trade blocks)
    const receivesMatches = text.match(/(\w+)\s+receives?:?/gi);
    if (receivesMatches) {
        for (const match of receivesMatches) {
            const name = match.replace(/\s+receives?:?$/i, '');
            if (name && name.length > 2) {
                teamNames.push(name);
            }
        }
    }

    // Remove duplicates
    return [...new Set(teamNames)];
}

/**
 * Clear the team cache (useful for testing or after team updates)
 */
function clearTeamCache() {
    teamCache = null;
    teamCacheExpiry = 0;
}

module.exports = {
    matchTeamName,
    matchTeamNames,
    extractPotentialTeamNames,
    loadTeamsFromFirestore,
    clearTeamCache,
    stringSimilarity,
    TEAM_ALIASES
};
