/**
 * map-s6-player-ids.js
 *
 * Maps player handles from season 6 lineup data to their Firestore player IDs
 * and weekly rankings.
 *
 * USAGE:
 *   Run from the functions directory (where node_modules are installed):
 *   $ cd functions && node ../scripts/map-s6-player-ids.js
 *
 * PREREQUISITES:
 *   - Firebase Admin SDK credentials (Application Default Credentials or service account)
 *   - npm install in the functions directory
 *
 * INPUT FILES:
 *   - manual_extract_simplified.json (root dir) - Season 6 lineup data
 *   - RKL History - Full Player Stats.csv (root dir) - Player aliases in parentheses
 *   - RKL History - S6 Averages.csv (root dir) - Player weekly rankings
 *
 * OUTPUT FILES (in scripts/output/):
 *   - s6-games-enhanced.json - Game-by-game data with player IDs and weekly rankings
 *   - s6-handle-to-id.json - Simple handle -> player_id mapping
 *
 * OUTPUT FORMAT (s6-games-enhanced.json):
 *   Each game object is enhanced with:
 *   - week: The week number (1-15) based on game date
 *   - roster_a/roster_b: Array of player objects with:
 *     - handle: Original player handle
 *     - player_id: Firestore player ID (or null if not found)
 *     - ranking: Player's ranking for that week (or null if not available)
 *
 * REPORTS:
 *   The script will print to console:
 *   - Summary of matches (direct, alias, not found)
 *   - Date-to-week mapping (3 game dates per week)
 *   - List of players found via alias lookup
 *   - List of players not found in Firestore
 */

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

// Initialize Firebase Admin SDK
const serviceAccountPath = path.join(__dirname, '..', 'functions', 'scripts', 'serviceAccountKey.json');
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf-8'));

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: "real-karma-league",
});

const db = admin.firestore();

/**
 * Parse the S6 Averages CSV to extract weekly rankings
 * Format: #,PLAYER,AVERAGE,GEM,T100,T50,GP,W1,W2,...,W15
 * Returns a Map: lowercase_handle -> { rank, weeklyRankings: { W1: rank, W2: rank, ... } }
 */
function parseWeeklyRankings(csvPath) {
    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.split('\n');

    // Map from lowercase player handle -> { rank, weeklyRankings }
    const rankingsMap = new Map();

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const columns = line.split(',');
        if (columns.length < 7) continue;

        const overallRank = parseInt(columns[0], 10);
        // Player column may have aliases in parentheses, extract primary handle
        const playerField = columns[1];
        const primaryHandle = playerField.replace(/\s*\([^)]+\)/g, '').toLowerCase().trim();

        // Also extract aliases from the player field
        const aliases = [];
        const aliasMatches = playerField.match(/\(([^)]+)\)/g);
        if (aliasMatches) {
            for (const match of aliasMatches) {
                aliases.push(match.slice(1, -1).toLowerCase().trim());
            }
        }

        // Weekly rankings are in columns 7-21 (W1-W15)
        const weeklyRankings = {};
        for (let w = 1; w <= 15; w++) {
            const colIndex = 6 + w; // W1 is at index 7
            if (colIndex < columns.length) {
                const rankVal = columns[colIndex].trim();
                if (rankVal !== '') {
                    weeklyRankings[`W${w}`] = parseInt(rankVal, 10);
                }
            }
        }

        const playerData = { rank: overallRank, weeklyRankings };

        // Store for primary handle
        rankingsMap.set(primaryHandle, playerData);

        // Also store for aliases so we can look them up
        for (const alias of aliases) {
            if (!rankingsMap.has(alias)) {
                rankingsMap.set(alias, playerData);
            }
        }
    }

    return rankingsMap;
}

/**
 * Build a mapping from game dates to week numbers
 * Regular season: 3 unique game dates per week
 */
function buildDateToWeekMap(games) {
    // Extract unique dates and sort them
    const uniqueDates = [...new Set(games.map(g => g.game_date))].sort();

    // Group by 3 dates per week
    const dateToWeek = new Map();
    for (let i = 0; i < uniqueDates.length; i++) {
        const weekNum = Math.floor(i / 3) + 1;
        dateToWeek.set(uniqueDates[i], weekNum);
    }

    return dateToWeek;
}

/**
 * Parse the CSV file to extract alias mappings
 * Format: "primary_handle (alias1) (alias2) ..." -> maps each alias to primary_handle
 */
function parseAliasesFromCSV(csvPath) {
    const content = fs.readFileSync(csvPath, 'utf-8');
    const lines = content.split('\n');

    // Map from alias -> primary handle
    const aliasMap = new Map();
    // Map from primary handle -> all aliases (for reporting)
    const primaryToAliases = new Map();

    for (const line of lines) {
        // Find all player name entries with format: "name (alias1) (alias2)..."
        const matches = line.match(/([^\s,]+(?:\s*\([^)]+\))+)/g);
        if (matches) {
            for (const match of matches) {
                // Parse: "primary (alias1) (alias2)"
                const aliasPattern = /^([^\s(]+)\s*((?:\([^)]+\)\s*)+)$/;
                const aliasMatch = match.match(aliasPattern);

                if (aliasMatch) {
                    const primary = aliasMatch[1].toLowerCase().trim();
                    const aliasesStr = aliasMatch[2];

                    // Extract individual aliases from (alias1) (alias2) format
                    const aliases = aliasesStr.match(/\(([^)]+)\)/g);
                    if (aliases) {
                        const aliasNames = aliases.map(a => a.slice(1, -1).toLowerCase().trim());

                        // Store primary -> aliases mapping
                        if (!primaryToAliases.has(primary)) {
                            primaryToAliases.set(primary, new Set());
                        }

                        for (const alias of aliasNames) {
                            aliasMap.set(alias, primary);
                            primaryToAliases.get(primary).add(alias);
                        }
                    }
                }
            }
        }
    }

    return { aliasMap, primaryToAliases };
}

/**
 * Extract player handles and their game appearances from the lineup JSON
 * Returns { games, uniqueHandles, playerGameDates }
 */
function extractPlayerHandles(jsonPath) {
    const content = fs.readFileSync(jsonPath, 'utf-8');
    const games = JSON.parse(content);

    const handles = new Set();
    // Map from handle -> Set of game dates they played
    const playerGameDates = new Map();

    for (const game of games) {
        const gameDate = game.game_date;
        const allPlayers = [
            ...(game.roster_a || []),
            ...(game.roster_b || [])
        ];

        for (const handle of allPlayers) {
            const lowerHandle = handle.toLowerCase().trim();
            handles.add(lowerHandle);

            if (!playerGameDates.has(lowerHandle)) {
                playerGameDates.set(lowerHandle, new Set());
            }
            playerGameDates.get(lowerHandle).add(gameDate);
        }
    }

    return { games, uniqueHandles: handles, playerGameDates };
}

/**
 * Fetch all players from v2_players collection
 */
async function fetchAllPlayers() {
    console.log("Fetching all players from v2_players collection...");
    const snapshot = await db.collection('v2_players').get();

    // Map from lowercase player_handle -> { player_id, player_handle (original case) }
    const playerMap = new Map();

    snapshot.forEach(doc => {
        const data = doc.data();
        if (data.player_handle) {
            playerMap.set(data.player_handle.toLowerCase(), {
                player_id: data.player_id || doc.id,
                player_handle: data.player_handle
            });
        }
    });

    console.log(`Found ${playerMap.size} players in Firestore`);
    return playerMap;
}

/**
 * Look up a player's ranking for a specific week
 */
function getPlayerRanking(handle, weekNum, rankingsMap, aliasMap, primaryToAliases) {
    const weekKey = `W${weekNum}`;

    // Try direct lookup
    if (rankingsMap.has(handle)) {
        const data = rankingsMap.get(handle);
        return data.weeklyRankings[weekKey] || null;
    }

    // Try via alias -> primary
    if (aliasMap.has(handle)) {
        const primaryHandle = aliasMap.get(handle);
        if (rankingsMap.has(primaryHandle)) {
            const data = rankingsMap.get(primaryHandle);
            return data.weeklyRankings[weekKey] || null;
        }
    }

    // Try via primary -> alias
    if (primaryToAliases.has(handle)) {
        for (const alias of primaryToAliases.get(handle)) {
            if (rankingsMap.has(alias)) {
                const data = rankingsMap.get(alias);
                return data.weeklyRankings[weekKey] || null;
            }
        }
    }

    return null;
}

/**
 * Main function to map player handles to IDs
 */
async function mapPlayerIds() {
    const rootDir = path.join(__dirname, '..');
    const jsonPath = path.join(rootDir, 'manual_extract_simplified.json');
    const csvPath = path.join(rootDir, 'RKL History - Full Player Stats.csv');
    const rankingsCsvPath = path.join(rootDir, 'RKL History - S6 Averages.csv');

    console.log("=".repeat(60));
    console.log("Season 6 Player ID Mapping Script");
    console.log("=".repeat(60));

    // Step 1: Parse aliases from CSV
    console.log("\n[1] Parsing alias mappings from CSV...");
    const { aliasMap, primaryToAliases } = parseAliasesFromCSV(csvPath);
    console.log(`   Found ${aliasMap.size} aliases mapping to ${primaryToAliases.size} primary handles`);

    // Step 2: Parse weekly rankings from S6 Averages CSV
    console.log("\n[2] Parsing weekly rankings from S6 Averages CSV...");
    const rankingsMap = parseWeeklyRankings(rankingsCsvPath);
    console.log(`   Found rankings for ${rankingsMap.size} players`);

    // Step 3: Extract player handles from JSON
    console.log("\n[3] Extracting player handles from lineup data...");
    const { games, uniqueHandles, playerGameDates } = extractPlayerHandles(jsonPath);
    console.log(`   Found ${uniqueHandles.size} unique player handles across ${games.length} games`);

    // Step 4: Build date-to-week mapping
    console.log("\n[4] Building date-to-week mapping...");
    const dateToWeek = buildDateToWeekMap(games);
    console.log(`   Mapped ${dateToWeek.size} unique dates to weeks`);
    // Log the mapping for reference
    const weekDates = new Map();
    for (const [date, week] of dateToWeek) {
        if (!weekDates.has(week)) weekDates.set(week, []);
        weekDates.get(week).push(date);
    }
    for (const [week, dates] of [...weekDates.entries()].sort((a, b) => a[0] - b[0])) {
        console.log(`   Week ${week}: ${dates.join(', ')}`);
    }

    // Step 5: Fetch players from Firestore
    console.log("\n[5] Fetching players from Firestore...");
    const firestorePlayers = await fetchAllPlayers();

    // Step 6: Map handles to IDs
    console.log("\n[6] Mapping handles to player IDs...");

    const results = {
        directMatch: [],      // Found directly by handle
        aliasMatch: [],       // Found via alias lookup
        notFound: []          // Could not be found
    };

    const handleToId = new Map(); // Final mapping

    for (const handle of uniqueHandles) {
        // Try direct match first
        if (firestorePlayers.has(handle)) {
            const player = firestorePlayers.get(handle);
            results.directMatch.push({
                handle,
                player_id: player.player_id,
                firestore_handle: player.player_handle
            });
            handleToId.set(handle, player.player_id);
            continue;
        }

        // Try alias lookup (handle is an alias -> find primary or sibling alias in Firestore)
        if (aliasMap.has(handle)) {
            const primaryHandle = aliasMap.get(handle);

            // First check if primary is in Firestore
            if (firestorePlayers.has(primaryHandle)) {
                const player = firestorePlayers.get(primaryHandle);
                results.aliasMatch.push({
                    handle,
                    alias_of: primaryHandle,
                    player_id: player.player_id,
                    firestore_handle: player.player_handle,
                    note: "Handle is alias, primary found in Firestore"
                });
                handleToId.set(handle, player.player_id);
                continue;
            }

            // Primary not in Firestore - check if any sibling aliases are in Firestore
            if (primaryToAliases.has(primaryHandle)) {
                const siblingAliases = primaryToAliases.get(primaryHandle);
                let found = false;
                for (const sibling of siblingAliases) {
                    if (sibling !== handle && firestorePlayers.has(sibling)) {
                        const player = firestorePlayers.get(sibling);
                        results.aliasMatch.push({
                            handle,
                            alias_of: sibling,
                            player_id: player.player_id,
                            firestore_handle: player.player_handle,
                            note: `Handle is alias of "${primaryHandle}", sibling alias in Firestore`
                        });
                        handleToId.set(handle, player.player_id);
                        found = true;
                        break;
                    }
                }
                if (found) continue;
            }
        }

        // Check if handle is a primary that has aliases - maybe one of its aliases is in Firestore
        if (primaryToAliases.has(handle)) {
            const aliases = primaryToAliases.get(handle);
            let found = false;
            for (const alias of aliases) {
                if (firestorePlayers.has(alias)) {
                    const player = firestorePlayers.get(alias);
                    results.aliasMatch.push({
                        handle,
                        alias_of: alias,
                        player_id: player.player_id,
                        firestore_handle: player.player_handle,
                        note: "Primary handle in lineup, alias in Firestore"
                    });
                    handleToId.set(handle, player.player_id);
                    found = true;
                    break;
                }
            }
            if (found) continue;
        }

        // Not found
        const possibleAliases = primaryToAliases.get(handle);
        results.notFound.push({
            handle,
            known_aliases: possibleAliases ? Array.from(possibleAliases) : [],
            alias_of: aliasMap.get(handle) || null
        });
    }

    // Step 7: Build enhanced game-by-game output
    console.log("\n[7] Building enhanced game-by-game output...");

    /**
     * Enhance a player handle with ID and ranking for a specific week
     */
    function enhancePlayer(handle, weekNum) {
        const lowerHandle = handle.toLowerCase().trim();
        const player_id = handleToId.get(lowerHandle) || null;
        const ranking = getPlayerRanking(lowerHandle, weekNum, rankingsMap, aliasMap, primaryToAliases);

        return {
            handle,
            player_id,
            ranking
        };
    }

    const enhancedGames = games.map(game => {
        const weekNum = dateToWeek.get(game.game_date);

        return {
            ...game,
            week: weekNum,
            roster_a: (game.roster_a || []).map(h => enhancePlayer(h, weekNum)),
            roster_b: (game.roster_b || []).map(h => enhancePlayer(h, weekNum))
        };
    });

    console.log(`   Enhanced ${enhancedGames.length} games with player IDs and rankings`);

    // Step 8: Generate report
    console.log("\n" + "=".repeat(60));
    console.log("RESULTS SUMMARY");
    console.log("=".repeat(60));

    console.log(`\n✓ Direct matches: ${results.directMatch.length}`);
    console.log(`✓ Found via alias: ${results.aliasMatch.length}`);
    console.log(`✗ Not found: ${results.notFound.length}`);
    console.log(`─────────────────────────`);
    console.log(`  Total handles: ${uniqueHandles.size}`);
    console.log(`  Total games: ${enhancedGames.length}`);

    // Report: Players found via alias
    if (results.aliasMatch.length > 0) {
        console.log("\n" + "─".repeat(60));
        console.log("PLAYERS FOUND VIA ALIAS:");
        console.log("─".repeat(60));
        for (const match of results.aliasMatch) {
            console.log(`  "${match.handle}" → "${match.alias_of}" (ID: ${match.player_id})`);
            if (match.note) console.log(`     Note: ${match.note}`);
        }
    }

    // Report: Players not found
    if (results.notFound.length > 0) {
        console.log("\n" + "─".repeat(60));
        console.log("PLAYERS NOT FOUND:");
        console.log("─".repeat(60));
        for (const player of results.notFound) {
            let info = `  "${player.handle}"`;
            if (player.alias_of) {
                info += ` (alias of "${player.alias_of}")`;
            }
            if (player.known_aliases.length > 0) {
                info += ` [known aliases: ${player.known_aliases.join(', ')}]`;
            }
            console.log(info);
        }
    }

    // Save results to files
    const outputDir = path.join(rootDir, 'scripts', 'output');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Save the enhanced games output (primary output)
    const enhancedGamesPath = path.join(outputDir, 's6-games-enhanced.json');
    fs.writeFileSync(enhancedGamesPath, JSON.stringify(enhancedGames, null, 2));
    console.log(`\n✓ Enhanced games saved to: ${enhancedGamesPath}`);

    // Also create a simple handle->id map file for reference
    const simpleMapPath = path.join(outputDir, 's6-handle-to-id.json');
    fs.writeFileSync(simpleMapPath, JSON.stringify(Object.fromEntries(handleToId), null, 2));
    console.log(`✓ Handle-to-ID mapping saved to: ${simpleMapPath}`);

    console.log("\n" + "=".repeat(60));
    console.log("Script completed successfully!");
    console.log("=".repeat(60));

    return enhancedGames;
}

// Run the script
mapPlayerIds()
    .then(() => process.exit(0))
    .catch(err => {
        console.error("Script failed:", err);
        process.exit(1);
    });
