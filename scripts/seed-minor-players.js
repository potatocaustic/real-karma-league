// /scripts/seed-minor-players.js
// Script to seed minor_v2_players collection from Google Sheets CSV data
// This script is fully reversible - it creates a rollback file to undo all changes

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
// Note: fetch is built-in for Node.js 18+ (this project uses Node 22)

// Initialize the Firebase Admin SDK
admin.initializeApp({
    projectId: "real-karma-league",
});

const db = admin.firestore();

// --- CONFIGURATION ---
const CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vR2E--N7B6cD-_HWaIpxIObmDVuIxqgXhfHkf6vE1FGHeAccozSl416DtQF-lGeWUhiF_Bm-geu9yMU/pub?output=csv";
const SEASON_ID = "S9";
const COLLECTION_NAME = "minor_v2_players";
const BATCH_SIZE = 500; // Firestore batch limit

// Rollback tracking
const rollbackData = {
    timestamp: new Date().toISOString(),
    seasonId: SEASON_ID,
    collectionName: COLLECTION_NAME,
    createdPlayers: []
};

// --- Helper Functions ---

/**
 * Parse CSV data into array of objects
 */
function parseCSV(csvText) {
    const lines = csvText.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.trim());

    const data = [];
    for (let i = 1; i < lines.length; i++) {
        const values = lines[i].split(',').map(v => v.trim());
        if (values.length === headers.length) {
            const row = {};
            headers.forEach((header, index) => {
                row[header] = values[index];
            });
            data.push(row);
        }
    }

    return data;
}

/**
 * Create initial seasonal stats structure with all fields set to 0
 * This matches the structure from v2_players seasonal_stats
 */
function createInitialSeasonalStats(seasonId) {
    return {
        // Regular Season Stats
        aag_mean: 0,
        aag_mean_pct: 0,
        aag_median: 0,
        aag_median_pct: 0,
        games_played: 0,
        GEM: 0,
        meanrank: 0,
        medrank: 0,
        meansum: 0,
        medsum: 0,
        rel_mean: 0,
        rel_median: 0,
        t100: 0,
        t100_pct: 0,
        t50: 0,
        t50_pct: 0,
        total_points: 0,
        WAR: 0,

        // Postseason Stats
        post_aag_mean: 0,
        post_aag_mean_pct: 0,
        post_aag_median: 0,
        post_aag_median_pct: 0,
        post_games_played: 0,
        post_GEM: 0,
        post_meansum: 0,
        post_medrank: 0,
        post_meanrank: 0,
        post_medsum: 0,
        post_rel_mean: 0,
        post_rel_median: 0,
        post_total_points: 0,
        post_WAR: 0,
        post_t100: 0,
        post_t100_pct: 0,
        post_t50: 0,
        post_t50_pct: 0,

        // Leaderboard Ranks
        total_points_rank: 0,
        rel_mean_rank: 0,
        rel_median_rank: 0,
        GEM_rank: 0,
        WAR_rank: 0,
        medrank_rank: 0,
        meanrank_rank: 0,
        aag_mean_rank: 0,
        aag_median_rank: 0,
        t100_rank: 0,
        t50_rank: 0,
        post_total_points_rank: 0,
        post_rel_mean_rank: 0,
        post_rel_median_rank: 0,
        post_GEM_rank: 0,
        post_WAR_rank: 0,
        post_medrank_rank: 0,
        post_meanrank_rank: 0,
        post_aag_mean_rank: 0,
        post_aag_median_rank: 0,
        post_t100_rank: 0,
        post_t50_rank: 0,

        // Metadata
        rookie: "0",
        all_star: "0",
        season: seasonId
    };
}

/**
 * Fetch CSV data from Google Sheets
 */
async function fetchCSVData() {
    console.log("Fetching CSV data from Google Sheets...");
    const response = await fetch(CSV_URL);

    if (!response.ok) {
        throw new Error(`Failed to fetch CSV: ${response.statusText}`);
    }

    const csvText = await response.text();
    return parseCSV(csvText);
}

/**
 * Seed players to Firestore
 */
async function seedPlayers(players) {
    console.log(`\nSeeding ${players.length} players to ${COLLECTION_NAME}...`);

    let batch = db.batch();
    let operationCount = 0;
    let totalCreated = 0;
    let skipped = 0;

    for (const player of players) {
        const { player_handle, player_id, current_team_id } = player;

        // Skip players without a player_id
        if (!player_id || player_id.trim() === '') {
            console.log(`⚠️  Skipping player ${player_handle} - no player_id`);
            skipped++;
            continue;
        }

        // Create player document reference
        const playerRef = db.collection(COLLECTION_NAME).doc(player_id);

        // Player root document data
        const playerData = {
            player_id: player_id,
            player_handle: player_handle,
            player_status: "ACTIVE",
            current_team_id: current_team_id || ""
        };

        // Add to batch
        batch.set(playerRef, playerData);
        operationCount++;

        // Create seasonal_stats subcollection reference
        const seasonalStatsRef = playerRef.collection('seasonal_stats').doc(SEASON_ID);
        const seasonalStatsData = createInitialSeasonalStats(SEASON_ID);

        // Add to batch
        batch.set(seasonalStatsRef, seasonalStatsData);
        operationCount++;

        // Track for rollback
        rollbackData.createdPlayers.push({
            player_id: player_id,
            player_handle: player_handle
        });

        totalCreated++;

        // Commit batch if we hit the limit
        if (operationCount >= BATCH_SIZE) {
            await batch.commit();
            console.log(`✓ Committed batch (${totalCreated} players processed)`);
            batch = db.batch();
            operationCount = 0;
        }
    }

    // Commit remaining operations
    if (operationCount > 0) {
        await batch.commit();
        console.log(`✓ Committed final batch`);
    }

    console.log(`\n✓ Successfully created ${totalCreated} players`);
    if (skipped > 0) {
        console.log(`⚠️  Skipped ${skipped} players (missing player_id)`);
    }

    return totalCreated;
}

/**
 * Save rollback data to file
 */
function saveRollbackData() {
    const rollbackDir = path.join(__dirname, 'rollback');
    if (!fs.existsSync(rollbackDir)) {
        fs.mkdirSync(rollbackDir, { recursive: true });
    }

    const filename = `minor-players-${SEASON_ID}-${Date.now()}.json`;
    const filepath = path.join(rollbackDir, filename);

    fs.writeFileSync(filepath, JSON.stringify(rollbackData, null, 2));
    console.log(`\n✓ Rollback data saved to: ${filepath}`);
    console.log(`  To rollback, run: node scripts/rollback-minor-players.js ${filename}`);

    return filepath;
}

/**
 * Main execution function
 */
async function main() {
    console.log("=".repeat(60));
    console.log("SEED MINOR LEAGUE PLAYERS");
    console.log("=".repeat(60));
    console.log(`Collection: ${COLLECTION_NAME}`);
    console.log(`Season: ${SEASON_ID}`);
    console.log(`CSV Source: ${CSV_URL}`);
    console.log("=".repeat(60));

    try {
        // Step 1: Fetch CSV data
        const players = await fetchCSVData();
        console.log(`✓ Fetched ${players.length} players from CSV`);

        // Step 2: Validate data
        const validPlayers = players.filter(p => p.player_id && p.player_id.trim() !== '');
        console.log(`✓ Found ${validPlayers.length} valid players (with player_id)`);

        // Step 3: Confirm before proceeding
        console.log("\n⚠️  WARNING: This will create player documents in Firestore.");
        console.log("Press Ctrl+C to cancel, or wait 5 seconds to continue...\n");
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Step 4: Seed players
        const created = await seedPlayers(players);

        // Step 5: Save rollback data
        saveRollbackData();

        console.log("\n" + "=".repeat(60));
        console.log("✓ SEEDING COMPLETE");
        console.log("=".repeat(60));
        console.log(`Total players created: ${created}`);
        console.log(`Each player has a seasonal_stats/${SEASON_ID} subcollection`);
        console.log("=".repeat(60));

    } catch (error) {
        console.error("\n❌ Error during seeding:", error);
        console.error(error.stack);
        process.exit(1);
    }
}

// Run the script
main().then(() => {
    console.log("\n✓ Script completed successfully");
    process.exit(0);
}).catch((error) => {
    console.error("\n❌ Script failed:", error);
    process.exit(1);
});
