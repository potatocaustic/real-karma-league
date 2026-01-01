/**
 * map-s6-player-ids.js
 *
 * Maps player handles from season 6 lineup data to their Firestore player IDs.
 *
 * USAGE:
 *   Run from the functions directory (where node_modules are installed):
 *   $ cd functions && node ../scripts/map-s6-player-ids.js
 *
 * PREREQUISITES:
 *   - Firebase Admin SDK credentials (service account key or Application Default Credentials)
 *     - Set GOOGLE_APPLICATION_CREDENTIALS to a service account JSON file, or
 *     - Place serviceAccountKey.json at functions/scripts/serviceAccountKey.json, or
 *     - Configure Application Default Credentials via gcloud
 *   - npm install in the functions directory
 *
 * INPUT FILES:
 *   - manual_extract_simplified.json (root dir) - Season 6 lineup data
 *   - RKL History - Full Player Stats.csv (root dir) - Player aliases in parentheses
 *
 * OUTPUT FILES (in scripts/output/):
 *   - s6-player-id-mapping.json - Full mapping with details and report
 *   - s6-handle-to-id.json - Simple handle -> player_id mapping
 *
 * REPORTS:
 *   The script will print to console:
 *   - Summary of matches (direct, alias, not found)
 *   - List of players found via alias lookup
 *   - List of players not found in Firestore
 */

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

// Initialize Firebase Admin SDK
const rootDir = path.join(__dirname, '..');
const serviceAccountPath = path.join(rootDir, 'functions', 'scripts', 'serviceAccountKey.json');
const googleApplicationCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;

function resolveFirebaseCredential() {
    if (googleApplicationCredentials && !fs.existsSync(googleApplicationCredentials)) {
        throw new Error(
            `GOOGLE_APPLICATION_CREDENTIALS points to a missing file: ${googleApplicationCredentials}`
        );
    }

    if (googleApplicationCredentials) {
        return admin.credential.cert(JSON.parse(fs.readFileSync(googleApplicationCredentials, 'utf-8')));
    }

    if (fs.existsSync(serviceAccountPath)) {
        return admin.credential.cert(JSON.parse(fs.readFileSync(serviceAccountPath, 'utf-8')));
    }

    console.warn(
        "No service account key found. Falling back to Application Default Credentials. " +
            "Set GOOGLE_APPLICATION_CREDENTIALS or place a serviceAccountKey.json in functions/scripts."
    );
    return admin.credential.applicationDefault();
}

admin.initializeApp({
    credential: resolveFirebaseCredential(),
    projectId: "real-karma-league",
});

const db = admin.firestore();

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
 * Extract unique player handles from the lineup JSON
 */
function extractPlayerHandles(jsonPath) {
    const content = fs.readFileSync(jsonPath, 'utf-8');
    const games = JSON.parse(content);

    const handles = new Set();

    for (const game of games) {
        if (game.roster_a && Array.isArray(game.roster_a)) {
            for (const handle of game.roster_a) {
                handles.add(handle.toLowerCase().trim());
            }
        }
        if (game.roster_b && Array.isArray(game.roster_b)) {
            for (const handle of game.roster_b) {
                handles.add(handle.toLowerCase().trim());
            }
        }
    }

    return handles;
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
 * Main function to map player handles to IDs
 */
async function mapPlayerIds() {
    const jsonPath = path.join(rootDir, 'manual_extract_simplified.json');
    const csvPath = path.join(rootDir, 'RKL History - Full Player Stats.csv');

    console.log("=".repeat(60));
    console.log("Season 6 Player ID Mapping Script");
    console.log("=".repeat(60));

    // Step 1: Parse aliases from CSV
    console.log("\n[1] Parsing alias mappings from CSV...");
    const { aliasMap, primaryToAliases } = parseAliasesFromCSV(csvPath);
    console.log(`   Found ${aliasMap.size} aliases mapping to ${primaryToAliases.size} primary handles`);

    // Step 2: Extract player handles from JSON
    console.log("\n[2] Extracting player handles from lineup data...");
    const uniqueHandles = extractPlayerHandles(jsonPath);
    console.log(`   Found ${uniqueHandles.size} unique player handles`);

    // Step 3: Fetch players from Firestore
    console.log("\n[3] Fetching players from Firestore...");
    const firestorePlayers = await fetchAllPlayers();

    // Step 4: Map handles to IDs
    console.log("\n[4] Mapping handles to player IDs...");

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

        // Try alias lookup
        if (aliasMap.has(handle)) {
            const primaryHandle = aliasMap.get(handle);
            if (firestorePlayers.has(primaryHandle)) {
                const player = firestorePlayers.get(primaryHandle);
                results.aliasMatch.push({
                    handle,
                    alias_of: primaryHandle,
                    player_id: player.player_id,
                    firestore_handle: player.player_handle
                });
                handleToId.set(handle, player.player_id);
                continue;
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

    // Step 5: Generate report
    console.log("\n" + "=".repeat(60));
    console.log("RESULTS SUMMARY");
    console.log("=".repeat(60));

    console.log(`\n✓ Direct matches: ${results.directMatch.length}`);
    console.log(`✓ Found via alias: ${results.aliasMatch.length}`);
    console.log(`✗ Not found: ${results.notFound.length}`);
    console.log(`─────────────────────────`);
    console.log(`  Total handles: ${uniqueHandles.size}`);

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

    // Save the mapping
    const mappingOutput = {
        generated: new Date().toISOString(),
        stats: {
            total_handles: uniqueHandles.size,
            direct_matches: results.directMatch.length,
            alias_matches: results.aliasMatch.length,
            not_found: results.notFound.length
        },
        handle_to_id: Object.fromEntries(handleToId),
        details: {
            direct_matches: results.directMatch,
            alias_matches: results.aliasMatch,
            not_found: results.notFound
        }
    };

    const mappingPath = path.join(outputDir, 's6-player-id-mapping.json');
    fs.writeFileSync(mappingPath, JSON.stringify(mappingOutput, null, 2));
    console.log(`\n✓ Full mapping saved to: ${mappingPath}`);

    // Also create a simple handle->id map file
    const simpleMapPath = path.join(outputDir, 's6-handle-to-id.json');
    fs.writeFileSync(simpleMapPath, JSON.stringify(Object.fromEntries(handleToId), null, 2));
    console.log(`✓ Simple mapping saved to: ${simpleMapPath}`);

    console.log("\n" + "=".repeat(60));
    console.log("Script completed successfully!");
    console.log("=".repeat(60));

    return mappingOutput;
}

// Run the script
mapPlayerIds()
    .then(() => process.exit(0))
    .catch(err => {
        console.error("Script failed:", err);
        process.exit(1);
    });
