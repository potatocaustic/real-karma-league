#!/usr/bin/env node

/**
 * Initialize Minor League Firestore Collections
 *
 * This script creates all necessary Firestore collections for the minor league,
 * including an initial season with proper structure.
 *
 * Usage:
 *   node scripts/initialize-minor-league.js [--with-sample-data]
 *
 * Options:
 *   --with-sample-data    Also create sample teams and players for testing
 */

const admin = require("firebase-admin");

// Initialize Firebase Admin SDK
admin.initializeApp({
    projectId: "real-karma-league",
});

const db = admin.firestore();

// Configuration
const USE_DEV_COLLECTIONS = false;
const CREATE_SAMPLE_DATA = process.argv.includes('--with-sample-data');

// Helper to get collection names
const getCollectionName = (baseName, league = 'major') => {
    const sharedCollections = ['users', 'notifications', 'scorekeeper_activity_log'];
    const devSuffix = USE_DEV_COLLECTIONS ? '_dev' : '';

    if (sharedCollections.includes(baseName)) {
        return `${baseName}${devSuffix}`;
    }

    const leaguePrefix = league === 'minor' ? 'minor_' : '';
    return `${leaguePrefix}${baseName}${devSuffix}`;
};

/**
 * Create a collection by adding a placeholder document
 */
async function createCollection(collectionName, placeholderDoc) {
    console.log(`Creating collection: ${collectionName}...`);
    const docRef = db.collection(collectionName).doc('_placeholder');
    await docRef.set({
        ...placeholderDoc,
        _is_placeholder: true,
        created_at: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`✓ Created: ${collectionName}`);
}

/**
 * Create initial minor league season
 */
async function createInitialSeason() {
    console.log('\n=== Creating Initial Minor League Season ===\n');

    const seasonRef = db.collection(getCollectionName('seasons', 'minor')).doc();
    const seasonId = seasonRef.id;

    const seasonData = {
        season_name: "Minor Season 1",
        season_number: 1,
        status: "pending", // Start as pending, can be activated later
        current_week: "0",
        gp: 0,
        gs: 0,
        season_trans: 0,
        season_karma: 0,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
        updated_at: admin.firestore.FieldValue.serverTimestamp()
    };

    console.log(`Creating season document: ${seasonId}...`);
    await seasonRef.set(seasonData);
    console.log(`✓ Created season: ${seasonData.season_name} (ID: ${seasonId})`);

    // Create subcollections within the season
    const subcollections = [
        { name: 'games', doc: { week: '1', date: '', home_id: '', away_id: '', status: 'scheduled' } },
        { name: 'post_games', doc: { round: 'QF', matchup: '', home_id: '', away_id: '', status: 'scheduled' } },
        { name: 'exhibition_games', doc: { date: '', home_id: '', away_id: '', status: 'scheduled' } },
        { name: 'lineups', doc: { date: '', player_id: '', team_id: '', started: 'FALSE', points_adjusted: 0 } },
        { name: 'post_lineups', doc: { date: '', player_id: '', team_id: '', started: 'FALSE', points_adjusted: 0 } },
        { name: 'draft_prospects', doc: { handle: '', display_name: '', added_date: '' } }
    ];

    for (const subcol of subcollections) {
        const subcollectionName = getCollectionName(subcol.name, 'minor');
        console.log(`Creating subcollection: ${seasonId}/${subcollectionName}...`);
        await seasonRef.collection(subcollectionName).doc('_placeholder').set({
            ...subcol.doc,
            _is_placeholder: true,
            created_at: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`✓ Created: ${seasonId}/${subcollectionName}`);
    }

    return seasonId;
}

/**
 * Create top-level minor league collections
 */
async function createTopLevelCollections() {
    console.log('\n=== Creating Top-Level Minor League Collections ===\n');

    const collections = [
        {
            name: getCollectionName('v2_players', 'minor'),
            placeholder: {
                handle: 'placeholder',
                player_id: 'placeholder',
                display_name: 'Placeholder Player',
                current_team_id: null,
                is_active: false
            }
        },
        {
            name: getCollectionName('v2_teams', 'minor'),
            placeholder: {
                team_name: 'Placeholder Team',
                team_id: 'placeholder',
                gm_uid: null,
                conference: 'TBD'
            }
        },
        {
            name: getCollectionName('live_games', 'minor'),
            placeholder: {
                game_id: 'placeholder',
                status: 'inactive',
                last_updated: admin.firestore.FieldValue.serverTimestamp()
            }
        },
        {
            name: getCollectionName('lineup_deadlines', 'minor'),
            placeholder: {
                date: '2024-01-01',
                deadline_time: '12:00 PM',
                time_zone: 'America/Chicago'
            }
        },
        {
            name: getCollectionName('pending_lineups', 'minor'),
            placeholder: {
                game_id: 'placeholder',
                home_lineup: [],
                away_lineup: []
            }
        },
        {
            name: getCollectionName('live_scoring_status', 'minor'),
            placeholder: {
                is_active: false,
                last_updated: admin.firestore.FieldValue.serverTimestamp()
            }
        },
        {
            name: getCollectionName('transactions', 'minor'),
            placeholder: {
                transaction_id: 'placeholder',
                type: 'trade',
                status: 'pending',
                created_at: admin.firestore.FieldValue.serverTimestamp()
            }
        },
        {
            name: getCollectionName('pending_transactions', 'minor'),
            placeholder: {
                transaction_id: 'placeholder',
                release_date: '2024-01-01',
                status: 'pending'
            }
        },
        {
            name: getCollectionName('draftPicks', 'minor'),
            placeholder: {
                season: 1,
                round: 1,
                pick_number: 1,
                original_team_id: 'placeholder',
                current_team_id: 'placeholder'
            }
        },
        {
            name: getCollectionName('archived_live_games', 'minor'),
            placeholder: {
                game_id: 'placeholder',
                archived_at: admin.firestore.FieldValue.serverTimestamp()
            }
        }
    ];

    for (const collection of collections) {
        await createCollection(collection.name, collection.placeholder);
    }
}

/**
 * Create sample teams for testing
 */
async function createSampleTeams() {
    console.log('\n=== Creating Sample Teams ===\n');

    const teams = [
        { team_id: 'team_a', team_name: 'Alpha Squad', conference: 'East', logo_url: '' },
        { team_id: 'team_b', team_name: 'Beta Force', conference: 'East', logo_url: '' },
        { team_id: 'team_c', team_name: 'Gamma Legion', conference: 'West', logo_url: '' },
        { team_id: 'team_d', team_name: 'Delta Warriors', conference: 'West', logo_url: '' }
    ];

    const teamsCollection = getCollectionName('v2_teams', 'minor');

    for (const team of teams) {
        console.log(`Creating team: ${team.team_name}...`);
        await db.collection(teamsCollection).doc(team.team_id).set({
            ...team,
            gm_uid: null,
            gm_name: 'TBD',
            created_at: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`✓ Created: ${team.team_name}`);

        // Create seasonal_records subcollection
        await db.collection(teamsCollection)
            .doc(team.team_id)
            .collection('seasonal_records')
            .doc('_placeholder')
            .set({
                season_id: 'placeholder',
                wins: 0,
                losses: 0,
                _is_placeholder: true
            });
    }
}

/**
 * Create sample players for testing
 */
async function createSamplePlayers() {
    console.log('\n=== Creating Sample Players ===\n');

    const players = [
        { player_id: 'player_001', handle: 'testplayer1', display_name: 'Test Player 1', current_team_id: 'team_a' },
        { player_id: 'player_002', handle: 'testplayer2', display_name: 'Test Player 2', current_team_id: 'team_a' },
        { player_id: 'player_003', handle: 'testplayer3', display_name: 'Test Player 3', current_team_id: 'team_b' },
        { player_id: 'player_004', handle: 'testplayer4', display_name: 'Test Player 4', current_team_id: 'team_b' },
        { player_id: 'player_005', handle: 'testplayer5', display_name: 'Test Player 5', current_team_id: 'team_c' },
        { player_id: 'player_006', handle: 'testplayer6', display_name: 'Test Player 6', current_team_id: 'team_c' },
        { player_id: 'player_007', handle: 'testplayer7', display_name: 'Test Player 7', current_team_id: 'team_d' },
        { player_id: 'player_008', handle: 'testplayer8', display_name: 'Test Player 8', current_team_id: 'team_d' }
    ];

    const playersCollection = getCollectionName('v2_players', 'minor');

    for (const player of players) {
        console.log(`Creating player: ${player.display_name}...`);
        await db.collection(playersCollection).doc(player.player_id).set({
            ...player,
            is_active: true,
            created_at: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`✓ Created: ${player.display_name}`);

        // Create seasonal_stats subcollection
        await db.collection(playersCollection)
            .doc(player.player_id)
            .collection('seasonal_stats')
            .doc('_placeholder')
            .set({
                season_id: 'placeholder',
                games_played: 0,
                total_karma: 0,
                _is_placeholder: true
            });
    }
}

/**
 * Delete placeholder documents
 */
async function deletePlaceholders() {
    console.log('\n=== Cleaning Up Placeholder Documents ===\n');

    const collections = [
        getCollectionName('seasons', 'minor'),
        getCollectionName('v2_players', 'minor'),
        getCollectionName('v2_teams', 'minor'),
        getCollectionName('live_games', 'minor'),
        getCollectionName('lineup_deadlines', 'minor'),
        getCollectionName('pending_lineups', 'minor'),
        getCollectionName('live_scoring_status', 'minor'),
        getCollectionName('transactions', 'minor'),
        getCollectionName('pending_transactions', 'minor'),
        getCollectionName('draftPicks', 'minor'),
        getCollectionName('archived_live_games', 'minor')
    ];

    for (const collectionName of collections) {
        try {
            const placeholderRef = db.collection(collectionName).doc('_placeholder');
            const doc = await placeholderRef.get();
            if (doc.exists) {
                await placeholderRef.delete();
                console.log(`✓ Deleted placeholder from: ${collectionName}`);
            }
        } catch (error) {
            console.log(`⚠ Could not delete placeholder from ${collectionName}: ${error.message}`);
        }
    }
}

/**
 * Main initialization function
 */
async function initializeMinorLeague() {
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║   Minor League Firestore Initialization Script            ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    console.log('Configuration:');
    console.log(`  Project ID: real-karma-league`);
    console.log(`  Use Dev Collections: ${USE_DEV_COLLECTIONS}`);
    console.log(`  Create Sample Data: ${CREATE_SAMPLE_DATA}\n`);

    try {
        // Step 1: Create top-level collections
        await createTopLevelCollections();

        // Step 2: Create initial season with subcollections
        const seasonId = await createInitialSeason();

        // Step 3: Optionally create sample data
        if (CREATE_SAMPLE_DATA) {
            await createSampleTeams();
            await createSamplePlayers();
        } else {
            console.log('\n⚠ Skipping sample data creation (use --with-sample-data flag to include)');
        }

        // Step 4: Clean up placeholders (optional - you may want to keep some)
        console.log('\n⚠ Keeping placeholder documents to ensure collections persist');
        console.log('  (You can delete them manually later if needed)');

        // Summary
        console.log('\n╔════════════════════════════════════════════════════════════╗');
        console.log('║   ✓ Minor League Initialization Complete!                 ║');
        console.log('╚════════════════════════════════════════════════════════════╝\n');

        console.log('Created Collections:');
        console.log(`  • ${getCollectionName('seasons', 'minor')}`);
        console.log(`  • ${getCollectionName('v2_players', 'minor')}`);
        console.log(`  • ${getCollectionName('v2_teams', 'minor')}`);
        console.log(`  • ${getCollectionName('live_games', 'minor')}`);
        console.log(`  • ${getCollectionName('lineup_deadlines', 'minor')}`);
        console.log(`  • ${getCollectionName('pending_lineups', 'minor')}`);
        console.log(`  • ${getCollectionName('live_scoring_status', 'minor')}`);
        console.log(`  • ${getCollectionName('transactions', 'minor')}`);
        console.log(`  • ${getCollectionName('pending_transactions', 'minor')}`);
        console.log(`  • ${getCollectionName('draftPicks', 'minor')}`);
        console.log(`  • ${getCollectionName('archived_live_games', 'minor')}`);

        console.log(`\nCreated Season: ${seasonId}`);
        console.log('  Subcollections:');
        console.log(`    • ${getCollectionName('games', 'minor')}`);
        console.log(`    • ${getCollectionName('post_games', 'minor')}`);
        console.log(`    • ${getCollectionName('exhibition_games', 'minor')}`);
        console.log(`    • ${getCollectionName('lineups', 'minor')}`);
        console.log(`    • ${getCollectionName('post_lineups', 'minor')}`);
        console.log(`    • ${getCollectionName('draft_prospects', 'minor')}`);

        if (CREATE_SAMPLE_DATA) {
            console.log('\nSample Data:');
            console.log('  • 4 teams created');
            console.log('  • 8 players created');
        }

        console.log('\n📝 Next Steps:');
        console.log('  1. Update firestore.rules to include minor league collections');
        console.log('  2. Deploy updated security rules: firebase deploy --only firestore:rules');
        console.log('  3. Use admin panel to activate season and populate teams/players');
        console.log('  4. Test callable functions with league: "minor" parameter');
        console.log('  5. Begin frontend integration for league switching\n');

    } catch (error) {
        console.error('\n❌ Error during initialization:', error);
        console.error(error.stack);
        process.exit(1);
    }
}

// Run the script
initializeMinorLeague()
    .then(() => {
        console.log('Script completed successfully!');
        process.exit(0);
    })
    .catch((error) => {
        console.error('Script failed:', error);
        process.exit(1);
    });
