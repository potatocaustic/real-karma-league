// functions/utils/player-handle-resolver.js
// Resolve player handles to player IDs

const { admin, db } = require('./firebase-admin');
const { getCollectionName, LEAGUES } = require('./firebase-helpers');

// Cache for player handle lookups
let playerCache = {
    major: new Map(),
    minor: new Map()
};
let playerCacheExpiry = 0;
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Load all players from Firestore into cache
 * @returns {Promise<void>}
 */
async function loadPlayersIntoCache() {
    const now = Date.now();

    // Return if cache is still valid
    if (now < playerCacheExpiry) {
        return;
    }

    console.log('Loading players into cache...');

    // Load major league players
    const majorPlayersSnap = await db.collection(getCollectionName('v2_players', LEAGUES.MAJOR)).get();
    playerCache.major = new Map();

    for (const doc of majorPlayersSnap.docs) {
        const data = doc.data();
        const handle = (data.player_handle || '').toLowerCase();
        if (handle) {
            playerCache.major.set(handle, {
                id: doc.id,
                handle: data.player_handle,
                currentTeamId: data.current_team_id,
                status: data.player_status || 'ACTIVE'
            });
        }
    }

    // Load minor league players
    const minorPlayersSnap = await db.collection(getCollectionName('v2_players', LEAGUES.MINOR)).get();
    playerCache.minor = new Map();

    for (const doc of minorPlayersSnap.docs) {
        const data = doc.data();
        const handle = (data.player_handle || '').toLowerCase();
        if (handle) {
            playerCache.minor.set(handle, {
                id: doc.id,
                handle: data.player_handle,
                currentTeamId: data.current_team_id,
                status: data.player_status || 'ACTIVE'
            });
        }
    }

    playerCacheExpiry = now + CACHE_TTL_MS;
    console.log(`Loaded ${playerCache.major.size} major and ${playerCache.minor.size} minor players`);
}

/**
 * Resolve a player handle to player ID
 * @param {string} handle - Player handle (with or without @)
 * @param {string} league - League to search ('major', 'minor', or null for both)
 * @returns {Promise<Object|null>} Player info { id, handle, currentTeamId, status, league }
 */
async function resolvePlayerHandle(handle, league = null) {
    if (!handle) return null;

    // Normalize handle (remove @ if present)
    const normalizedHandle = handle.replace(/^@/, '').toLowerCase().trim();
    if (!normalizedHandle) return null;

    await loadPlayersIntoCache();

    // Search in specified league or both
    const leaguesToSearch = league ? [league] : [LEAGUES.MAJOR, LEAGUES.MINOR];

    for (const searchLeague of leaguesToSearch) {
        const cache = searchLeague === LEAGUES.MAJOR ? playerCache.major : playerCache.minor;
        const player = cache.get(normalizedHandle);

        if (player) {
            return {
                ...player,
                league: searchLeague
            };
        }
    }

    return null;
}

/**
 * Resolve multiple player handles
 * @param {Array<string>} handles - Array of player handles
 * @param {string|null} league - Preferred league
 * @returns {Promise<Object>} { resolved: [], unresolved: [], leagueFromPlayers }
 */
async function resolvePlayerHandles(handles, league = null) {
    const resolved = [];
    const unresolved = [];
    const leagueCounts = { major: 0, minor: 0 };

    for (const handle of handles) {
        const player = await resolvePlayerHandle(handle, league);

        if (player) {
            resolved.push(player);
            leagueCounts[player.league]++;
        } else {
            unresolved.push(handle);
        }
    }

    // Determine league from resolved players
    let leagueFromPlayers = null;
    if (leagueCounts.major > leagueCounts.minor) {
        leagueFromPlayers = LEAGUES.MAJOR;
    } else if (leagueCounts.minor > leagueCounts.major) {
        leagueFromPlayers = LEAGUES.MINOR;
    } else if (leagueCounts.major > 0) {
        leagueFromPlayers = LEAGUES.MAJOR; // Default to major on tie
    }

    return {
        resolved,
        unresolved,
        leagueFromPlayers
    };
}

/**
 * Get player's current team for validation
 * @param {string} playerId - Player document ID
 * @param {string} league - League
 * @returns {Promise<Object|null>} { teamId, status }
 */
async function getPlayerCurrentTeam(playerId, league) {
    const playerDoc = await db
        .collection(getCollectionName('v2_players', league))
        .doc(playerId)
        .get();

    if (!playerDoc.exists) {
        return null;
    }

    const data = playerDoc.data();
    return {
        teamId: data.current_team_id,
        status: data.player_status || 'ACTIVE'
    };
}

/**
 * Validate that a player move makes sense
 * @param {Object} player - Resolved player { id, currentTeamId, status }
 * @param {string} transactionType - Type of transaction
 * @param {string} toTeamId - Destination team ID (if applicable)
 * @returns {Object} { valid: boolean, warnings: [], errors: [] }
 */
function validatePlayerMove(player, transactionType, toTeamId = null) {
    const warnings = [];
    const errors = [];

    switch (transactionType) {
        case 'RETIREMENT':
            if (player.status === 'RETIRED') {
                errors.push(`Player ${player.handle} is already retired`);
            }
            break;

        case 'UNRETIREMENT':
            if (player.status !== 'RETIRED') {
                warnings.push(`Player ${player.handle} is not currently retired (status: ${player.status})`);
            }
            break;

        case 'SIGN':
            if (player.currentTeamId && player.currentTeamId !== 'FREE_AGENT' && player.currentTeamId !== 'RETIRED') {
                warnings.push(`Player ${player.handle} is currently on team ${player.currentTeamId}`);
            }
            break;

        case 'CUT':
            if (player.currentTeamId === 'FREE_AGENT') {
                warnings.push(`Player ${player.handle} is already a free agent`);
            }
            if (player.currentTeamId === 'RETIRED') {
                errors.push(`Player ${player.handle} is retired, cannot be cut`);
            }
            break;

        case 'TRADE':
            if (player.currentTeamId === 'FREE_AGENT' || player.currentTeamId === 'RETIRED') {
                errors.push(`Player ${player.handle} cannot be traded (status: ${player.currentTeamId})`);
            }
            break;
    }

    return {
        valid: errors.length === 0,
        warnings,
        errors
    };
}

/**
 * Search for players by partial handle match
 * @param {string} partialHandle - Partial handle to search for
 * @param {string|null} league - League to search
 * @param {number} limit - Max results
 * @returns {Promise<Array>} Matching players
 */
async function searchPlayersByHandle(partialHandle, league = null, limit = 5) {
    await loadPlayersIntoCache();

    const normalizedSearch = partialHandle.replace(/^@/, '').toLowerCase();
    const results = [];
    const leaguesToSearch = league ? [league] : [LEAGUES.MAJOR, LEAGUES.MINOR];

    for (const searchLeague of leaguesToSearch) {
        const cache = searchLeague === LEAGUES.MAJOR ? playerCache.major : playerCache.minor;

        for (const [handle, player] of cache) {
            if (handle.includes(normalizedSearch)) {
                results.push({
                    ...player,
                    league: searchLeague
                });

                if (results.length >= limit) {
                    return results;
                }
            }
        }
    }

    return results;
}

/**
 * Clear the player cache
 */
function clearPlayerCache() {
    playerCache = {
        major: new Map(),
        minor: new Map()
    };
    playerCacheExpiry = 0;
}

module.exports = {
    resolvePlayerHandle,
    resolvePlayerHandles,
    getPlayerCurrentTeam,
    validatePlayerMove,
    searchPlayersByHandle,
    loadPlayersIntoCache,
    clearPlayerCache
};
