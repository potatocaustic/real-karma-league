// /scripts/seed-minor-draft-picks.js
// Script to seed the minor_draftPicks collection in Firestore based on minor-draft-capital.md

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

// Initialize the Firebase Admin SDK
admin.initializeApp({
    projectId: "real-karma-league",
});

const db = admin.firestore();

// --- CONFIGURATION ---
const COLLECTION_NAME = "minor_draftPicks";
const MARKDOWN_FILE_PATH = path.join(__dirname, "..", "minor-draft-capital.md");
const MINOR_LEAGUE_ROUNDS = 2; // Minor league has 2 rounds vs major league's 3

// Map of all known minor league teams
const MINOR_LEAGUE_TEAMS = [
    "Avatars", "Buffalos", "Chiefs", "Crows", "Da Bois", "Dogs", "Eggheads",
    "Fruit", "Goats", "Hippos", "Huskies", "Kings", "Knights", "Leeks",
    "Mafia", "Methsters", "Minors", "Rams", "Raptors", "Savages", "Seagulls",
    "Strips", "SuperSonics", "Tigers", "Titans", "Twins", "Venom", "Vultures",
    "Wizards", "Bullets"
];

// --- Helper Functions ---

/**
 * Parse the markdown file and extract draft pick information
 */
function parseMarkdownFile() {
    console.log("Reading markdown file:", MARKDOWN_FILE_PATH);
    const content = fs.readFileSync(MARKDOWN_FILE_PATH, 'utf-8');

    const seasons = {};
    const lines = content.split('\n');

    let currentSeason = null;
    let currentRound = null;
    let inTable = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Detect season headers (e.g., "## Season 10 (S10)")
        const seasonMatch = line.match(/^##\s+Season\s+(\d+)\s+\(S(\d+)\)/);
        if (seasonMatch) {
            currentSeason = `S${seasonMatch[2]}`;
            seasons[currentSeason] = { firstRound: {}, secondRound: {} };
            inTable = false;
            continue;
        }

        // Detect round headers
        if (line.includes("### First Round Picks")) {
            currentRound = 1;
            inTable = false;
            continue;
        }
        if (line.includes("### Second Round Picks")) {
            currentRound = 2;
            inTable = false;
            continue;
        }

        // Detect table start
        if (line.startsWith("| Team |") && currentSeason && currentRound) {
            inTable = true;
            i++; // Skip the separator line
            continue;
        }

        // Parse table rows
        if (inTable && line.startsWith("|") && !line.includes("---")) {
            const cells = line.split('|').map(cell => cell.trim()).filter(cell => cell);

            if (cells.length >= 3) {
                const team = cells[0];
                const incoming = cells[1];
                const outgoing = cells[2];

                if (team && team !== "Team") {
                    const roundKey = currentRound === 1 ? 'firstRound' : 'secondRound';
                    seasons[currentSeason][roundKey][team] = {
                        incoming: incoming,
                        outgoing: outgoing
                    };
                }
            }
        }

        // End table on empty line or new section
        if ((line === "" || line.startsWith("#")) && inTable) {
            inTable = false;
        }
    }

    return seasons;
}

/**
 * Parse incoming picks string to extract individual picks
 * Example: "SuperSonics S10 1RP, Fruit S10 1RP" -> [{ team: "SuperSonics", season: "S10", round: 1 }, ...]
 */
function parseIncomingPicks(incomingStr) {
    if (!incomingStr || incomingStr === "-" || incomingStr.trim() === "") {
        return [];
    }

    const picks = [];
    const pickStrings = incomingStr.split(',').map(s => s.trim());

    for (const pickStr of pickStrings) {
        // Match pattern like "SuperSonics S10 1RP"
        const match = pickStr.match(/^(.+?)\s+(S\d+)\s+([12])RP/);
        if (match) {
            picks.push({
                team: match[1].trim(),
                season: match[2],
                round: parseInt(match[3])
            });
        }
    }

    return picks;
}

/**
 * Check if a pick was traded away
 */
function wasPickTradedAway(outgoingStr) {
    return outgoingStr && outgoingStr.includes("traded");
}

/**
 * Generate all draft picks for all teams across all seasons
 */
function generateAllDraftPicks(parsedData) {
    const allPicks = [];

    // Get all unique seasons from the parsed data
    const seasons = Object.keys(parsedData).sort();

    // For each season, generate picks for all teams
    for (const seasonId of seasons) {
        const seasonNum = parseInt(seasonId.substring(1));

        for (const team of MINOR_LEAGUE_TEAMS) {
            for (let round = 1; round <= MINOR_LEAGUE_ROUNDS; round++) {
                const pickId = `${seasonId}_${team}_${round}`;
                const roundSuffix = round === 1 ? 'st' : 'nd';

                const pick = {
                    pick_id: pickId,
                    pick_description: `${seasonId} ${team} ${round}${roundSuffix}`,
                    season: seasonNum,
                    round: round,
                    original_team: team,
                    current_owner: team, // Default to original team, will be updated if traded
                    acquired_week: null,
                    base_owner: null,
                    notes: null,
                    trade_id: null
                };

                allPicks.push(pick);
            }
        }
    }

    return allPicks;
}

/**
 * Update current owners based on trades in the parsed data
 */
function updatePickOwnership(picks, parsedData) {
    const pickMap = new Map(picks.map(p => [p.pick_id, p]));

    for (const [seasonId, seasonData] of Object.entries(parsedData)) {
        // Process first round picks
        for (const [team, roundData] of Object.entries(seasonData.firstRound)) {
            // Handle incoming picks - update current_owner
            const incomingPicks = parseIncomingPicks(roundData.incoming);
            for (const incoming of incomingPicks) {
                const pickId = `${incoming.season}_${incoming.team}_${incoming.round}`;
                const pick = pickMap.get(pickId);
                if (pick) {
                    pick.current_owner = team;
                    pick.notes = `Traded to ${team}`;
                }
            }
        }

        // Process second round picks
        for (const [team, roundData] of Object.entries(seasonData.secondRound)) {
            // Handle incoming picks - update current_owner
            const incomingPicks = parseIncomingPicks(roundData.incoming);
            for (const incoming of incomingPicks) {
                const pickId = `${incoming.season}_${incoming.team}_${incoming.round}`;
                const pick = pickMap.get(pickId);
                if (pick) {
                    pick.current_owner = team;
                    pick.notes = `Traded to ${team}`;
                }
            }
        }
    }

    return Array.from(pickMap.values());
}

/**
 * Main seeding function
 */
async function seedMinorDraftPicks() {
    console.log("=== Starting Minor League Draft Picks Seeding ===\n");

    try {
        // 1. Parse the markdown file
        console.log("Step 1: Parsing minor-draft-capital.md...");
        const parsedData = parseMarkdownFile();
        const seasons = Object.keys(parsedData).sort();
        console.log(`✓ Found data for seasons: ${seasons.join(', ')}\n`);

        // 2. Generate all draft picks
        console.log("Step 2: Generating all draft picks for all teams...");
        let allPicks = generateAllDraftPicks(parsedData);
        console.log(`✓ Generated ${allPicks.length} draft picks (${MINOR_LEAGUE_TEAMS.length} teams × ${MINOR_LEAGUE_ROUNDS} rounds × ${seasons.length} seasons)\n`);

        // 3. Update ownership based on trades
        console.log("Step 3: Processing trades and updating pick ownership...");
        allPicks = updatePickOwnership(allPicks, parsedData);
        const tradedCount = allPicks.filter(p => p.current_owner !== p.original_team).length;
        console.log(`✓ Updated ownership for ${tradedCount} traded picks\n`);

        // 4. Write to Firestore in batches
        console.log("Step 4: Writing to Firestore...");
        const BATCH_SIZE = 450; // Firestore batch limit is 500
        let totalWritten = 0;

        for (let i = 0; i < allPicks.length; i += BATCH_SIZE) {
            const batch = db.batch();
            const batchPicks = allPicks.slice(i, i + BATCH_SIZE);

            for (const pick of batchPicks) {
                const docRef = db.collection(COLLECTION_NAME).doc(pick.pick_id);
                batch.set(docRef, pick);
            }

            await batch.commit();
            totalWritten += batchPicks.length;
            console.log(`  ✓ Committed batch ${Math.floor(i / BATCH_SIZE) + 1}: ${totalWritten}/${allPicks.length} picks written`);
        }

        // 5. Summary
        console.log("\n=== ✅ Minor League Draft Picks Seeding Complete! ===");
        console.log(`Total picks created: ${allPicks.length}`);
        console.log(`Picks traded: ${tradedCount}`);
        console.log(`Collection: ${COLLECTION_NAME}\n`);

        // Print some examples
        console.log("Example picks:");
        console.log("- Original ownership:", allPicks.find(p => p.current_owner === p.original_team));
        console.log("- Traded pick:", allPicks.find(p => p.current_owner !== p.original_team));
        console.log();

    } catch (error) {
        console.error("\n❌ Error during seeding:", error);
        throw error;
    }
}

/**
 * Cleanup function to remove all seeded draft picks
 */
async function cleanupMinorDraftPicks() {
    console.log("=== Starting Cleanup of Minor League Draft Picks ===\n");
    console.log("⚠️  WARNING: This will delete all documents in the minor_draftPicks collection!");
    console.log("Proceeding in 3 seconds...\n");

    await new Promise(resolve => setTimeout(resolve, 3000));

    try {
        const BATCH_SIZE = 450;
        let deletedCount = 0;

        // Get all draft pick documents
        const picksSnapshot = await db.collection(COLLECTION_NAME).get();
        console.log(`Found ${picksSnapshot.size} draft picks to delete\n`);

        // Delete in batches
        for (let i = 0; i < picksSnapshot.docs.length; i += BATCH_SIZE) {
            const batch = db.batch();
            const batchDocs = picksSnapshot.docs.slice(i, i + BATCH_SIZE);

            for (const doc of batchDocs) {
                batch.delete(doc.ref);
                deletedCount++;
            }

            console.log(`  Committing batch deletion (${deletedCount}/${picksSnapshot.size})...`);
            await batch.commit();
        }

        console.log("\n=== ✅ Cleanup Complete! ===");
        console.log(`Successfully deleted ${deletedCount} documents from ${COLLECTION_NAME}\n`);

    } catch (error) {
        console.error("\n❌ Error during cleanup:", error);
        throw error;
    }
}

// --- Command Line Interface ---
const command = process.argv[2];

if (command === 'seed') {
    seedMinorDraftPicks()
        .then(() => process.exit(0))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
} else if (command === 'cleanup') {
    cleanupMinorDraftPicks()
        .then(() => process.exit(0))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
} else {
    console.log("Usage:");
    console.log("  node scripts/seed-minor-draft-picks.js seed     - Seed the minor league draft picks");
    console.log("  node scripts/seed-minor-draft-picks.js cleanup  - Remove all seeded minor league draft picks");
    process.exit(1);
}
