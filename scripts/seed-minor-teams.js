// /scripts/seed-minor-teams.js
// Script to seed the minor_v2_teams collection in Firestore

const admin = require("firebase-admin");
const fetch = require("node-fetch");

// Initialize the Firebase Admin SDK
admin.initializeApp({
    projectId: "real-karma-league",
});

const db = admin.firestore();

// --- CONFIGURATION ---
const CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRzKZ3Bhr1kC5176yPZ6hLvIl2t_Y1-LbGxVliiGNxPa0jFqheH6kMp_HoVexd78mWUnx1k857lC3oj/pub?output=csv";
const SEASON_ID = "S9";
const COLLECTION_NAME = "minor_v2_teams";
const SEASONAL_RECORDS_COLLECTION = "minor_seasonal_records";

// Template for seasonal record fields based on v2_teams structure
const SEASONAL_RECORD_TEMPLATE = {
    season: SEASON_ID,
    apPAM: 0,
    apPAM_count: 0,
    apPAM_total: 0,
    elim: 0,
    losses: 0,
    MaxPotWins: 0,
    med_starter_rank: 0,
    msr_rank: 0,
    pam: 0,
    pam_rank: 0,
    playin: 0,
    playoffs: 0,
    post_losses: 0,
    post_med_starter_rank: 0,
    post_msr_rank: 0,
    post_pam: 0,
    post_pam_rank: 0,
    post_wins: 0,
    postseed: 0,
    sortscore: 0,
    wins: 0,
    wpct: 0,
    total_transactions: 0,
    tREL: 0,
    post_tREL: 0
};

// --- Helper Functions ---
function parseCSV(csvText) {
    const lines = csvText.trim().split('\n').filter(line => line.trim() !== '');
    if (lines.length === 0) return [];

    // First line is headers
    const headers = lines.shift().split(',').map(h => h.replace(/"/g, '').trim());

    return lines.map(line => {
        const values = line.match(/(".*?"|[^",]+)(?=\s*,|\s*$)/g) || [];
        const row = {};
        headers.forEach((header, i) => {
            if (header) row[header] = (values[i] || '').replace(/"/g, '').trim();
        });
        return row;
    });
}

async function fetchCSVData() {
    console.log("Fetching CSV data from Google Sheets...");
    const response = await fetch(CSV_URL);
    if (!response.ok) {
        throw new Error(`Failed to fetch CSV: ${response.statusText}`);
    }
    const csvText = await response.text();
    return parseCSV(csvText);
}

// --- Main Seeding Function ---
async function seedMinorTeams() {
    console.log("=== Starting Minor League Teams Seeding ===\n");

    try {
        // 1. Fetch CSV data
        const teamsData = await fetchCSVData();
        console.log(`✓ Fetched ${teamsData.length} teams from CSV\n`);

        // 2. Prepare batch writes
        const BATCH_SIZE = 400;
        let batch = db.batch();
        let writeCount = 0;

        const commitBatchIfNeeded = async () => {
            if (writeCount >= BATCH_SIZE) {
                console.log(`  Committing batch of ${writeCount} writes...`);
                await batch.commit();
                batch = db.batch();
                writeCount = 0;
            }
        };

        // 3. Process each team
        console.log("Creating team documents and seasonal records...\n");

        for (const team of teamsData) {
            const teamId = team.team_id;
            const teamName = team.team_name;

            // Create root level team document
            const teamDocRef = db.collection(COLLECTION_NAME).doc(teamId);
            const teamRootData = {
                team_id: teamId,
                conference: team.conference,
                current_gm_handle: team.current_gm_handle,
                gm_player_id: team.gm_player_id || null,
                gm_uid: team.gm_uid || null
            };

            batch.set(teamDocRef, teamRootData);
            writeCount++;

            // Create seasonal record document
            const seasonalRecordRef = teamDocRef.collection(SEASONAL_RECORDS_COLLECTION).doc(SEASON_ID);
            const seasonalRecordData = {
                ...SEASONAL_RECORD_TEMPLATE,
                team_id: teamId,
                team_name: teamName,
                gm_player_id: team.gm_player_id || null
            };

            batch.set(seasonalRecordRef, seasonalRecordData);
            writeCount++;

            console.log(`  ✓ Prepared ${teamId} (${teamName}) - ${team.conference}`);

            await commitBatchIfNeeded();
        }

        // 4. Commit any remaining writes
        if (writeCount > 0) {
            console.log(`\nCommitting final batch of ${writeCount} writes...`);
            await batch.commit();
        }

        console.log("\n=== ✅ Minor League Teams Seeding Complete! ===");
        console.log(`Successfully seeded ${teamsData.length} teams to ${COLLECTION_NAME}`);
        console.log(`Each team has a seasonal record for ${SEASON_ID}\n`);

    } catch (error) {
        console.error("\n❌ Error during seeding:", error);
        throw error;
    }
}

// --- Reversal/Cleanup Function ---
async function cleanupMinorTeams() {
    console.log("=== Starting Cleanup of Minor League Teams ===\n");
    console.log("⚠️  WARNING: This will delete all documents in the minor_v2_teams collection!");
    console.log("Proceeding in 3 seconds...\n");

    await new Promise(resolve => setTimeout(resolve, 3000));

    try {
        const BATCH_SIZE = 400;
        let deletedCount = 0;

        // Get all team documents
        const teamsSnapshot = await db.collection(COLLECTION_NAME).get();
        console.log(`Found ${teamsSnapshot.size} teams to delete\n`);

        // Delete in batches
        for (let i = 0; i < teamsSnapshot.docs.length; i += BATCH_SIZE) {
            const batch = db.batch();
            const batchDocs = teamsSnapshot.docs.slice(i, i + BATCH_SIZE);

            for (const teamDoc of batchDocs) {
                // First, delete all seasonal records subcollection documents
                const seasonalRecordsSnapshot = await teamDoc.ref.collection(SEASONAL_RECORDS_COLLECTION).get();

                for (const recordDoc of seasonalRecordsSnapshot.docs) {
                    batch.delete(recordDoc.ref);
                    deletedCount++;
                }

                // Then delete the team document itself
                batch.delete(teamDoc.ref);
                deletedCount++;

                console.log(`  ✓ Queued deletion of ${teamDoc.id} and its ${seasonalRecordsSnapshot.size} seasonal record(s)`);
            }

            console.log(`\n  Committing batch deletion...`);
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
    seedMinorTeams()
        .then(() => process.exit(0))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
} else if (command === 'cleanup') {
    cleanupMinorTeams()
        .then(() => process.exit(0))
        .catch((error) => {
            console.error(error);
            process.exit(1);
        });
} else {
    console.log("Usage:");
    console.log("  node scripts/seed-minor-teams.js seed     - Seed the minor league teams");
    console.log("  node scripts/seed-minor-teams.js cleanup  - Remove all seeded minor league teams");
    process.exit(1);
}
