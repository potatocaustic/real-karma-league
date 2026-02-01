#!/usr/bin/env node

/**
 * Enrich S10 draft picks with overall position numbers (1-90)
 *
 * This script parses draftOrder.txt and updates each S10 draft pick document
 * with its `overall` field representing the pick position (1-90).
 *
 * Usage:
 *   node scripts/enrich-s10-draft-picks.js            # Dry run (default)
 *   node scripts/enrich-s10-draft-picks.js --live     # Actually update Firestore
 *   node scripts/enrich-s10-draft-picks.js --strict   # Only update exact owner matches
 *
 * Notes:
 *   - Picks are matched by document ID: S10_{ORIGINAL_TEAM}_{ROUND}
 *   - Owner differences are logged but updates proceed (unless --strict)
 *   - The draftOrder.txt may have more recent trade info than Firestore
 */

const fs = require('fs');
const path = require('path');
const { db } = require('../utils/firebase-admin');

// Configuration
const DRY_RUN = !process.argv.includes('--live');
const STRICT_MODE = process.argv.includes('--strict'); // Only update exact owner matches
const COLLECTION = 'draftPicks';
const SEASON_ID = 'S10';  // For document IDs (e.g., S10_ACE_1)
const SEASON_FIELD = '10'; // For Firestore 'season' field query

// Team name to code mapping
const TEAM_NAME_TO_CODE = {
    'Aces': 'ACE',
    'Amigos': 'AMI',
    'Creamers': 'CRM',
    'Demons': 'SD',
    'Diabetics': 'DIA',
    'Donuts': 'DON',
    'Empire': 'EMP',
    'FaZe': 'FZC',
    'Flames': 'FLA',
    'Freaks': 'KF',
    'Gamblers': 'GAM',
    'Gravediggers': 'GD',
    'Heroes': 'HER',
    'Hornets': 'HOR',
    'Horses': 'HH',
    'Hounds': 'HND',
    'Jammers': 'JAM',
    'KOCK': 'KOCK',
    'Lean Team': 'LT',
    'Legion': 'LGN',
    'MLB': 'MLB',
    'Orphans': 'ORP',
    'Otters': 'OTT',
    'Outlaws': 'OUT',
    'Penguins': 'PEN',
    'Piggies': 'PIG',
    'Reapers': 'REA',
    'Stars': 'KS',
    'Tacos': 'TT',
    'Vipers': 'VIP'
};

/**
 * Parse a single line from draftOrder.txt
 * Format: "1. Hounds [via Outlaws]" or "7. FaZe" or "40. Penguins [via Piggies] **FORFEITED**"
 */
function parseDraftLine(line) {
    // Remove leading numbers with arrow (e.g., "1→")
    const cleanLine = line.replace(/^\s*\d+→/, '').trim();

    // Match: pick_number. current_owner [via original_team] optional_forfeited
    // or: pick_number. team_name optional_forfeited
    const match = cleanLine.match(/^(\d+)\.\s+([A-Za-z\s]+?)(?:\s+\[via\s+([A-Za-z\s]+?)\])?(\s+\*\*FORFEITED\*\*)?$/);

    if (!match) {
        return null;
    }

    const pickNumber = parseInt(match[1], 10);
    const currentOwnerName = match[2].trim();
    const originalTeamName = match[3] ? match[3].trim() : currentOwnerName;
    const forfeited = !!match[4];

    return {
        overall: pickNumber,
        currentOwnerName,
        originalTeamName,
        currentOwnerCode: TEAM_NAME_TO_CODE[currentOwnerName],
        originalTeamCode: TEAM_NAME_TO_CODE[originalTeamName],
        forfeited
    };
}

/**
 * Parse the entire draftOrder.txt file
 */
function parseDraftOrder(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());

    const picks = [];
    for (const line of lines) {
        const parsed = parseDraftLine(line);
        if (parsed) {
            picks.push(parsed);
        } else {
            console.warn(`  Warning: Could not parse line: "${line}"`);
        }
    }

    return picks;
}

/**
 * Get round number from overall pick position
 */
function getRound(overall) {
    if (overall <= 30) return 1;
    if (overall <= 60) return 2;
    return 3;
}

/**
 * Main function
 */
async function main() {
    console.log('=== Enrich S10 Draft Picks ===\n');
    console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE (will update Firestore)'}`);
    console.log(`Strict mode: ${STRICT_MODE ? 'ON (only exact owner matches)' : 'OFF (all found picks)'}`);
    console.log('');

    // Parse draft order file
    const draftOrderPath = path.join(__dirname, '../../draftOrder.txt');
    console.log(`Reading draft order from: ${draftOrderPath}`);

    const draftPicks = parseDraftOrder(draftOrderPath);
    console.log(`Parsed ${draftPicks.length} picks from draftOrder.txt\n`);

    // Validate all team codes were found
    let hasErrors = false;
    for (const pick of draftPicks) {
        if (!pick.currentOwnerCode) {
            console.error(`ERROR: Unknown team name "${pick.currentOwnerName}" (pick #${pick.overall})`);
            hasErrors = true;
        }
        if (!pick.originalTeamCode) {
            console.error(`ERROR: Unknown team name "${pick.originalTeamName}" (pick #${pick.overall})`);
            hasErrors = true;
        }
    }

    if (hasErrors) {
        console.error('\nAborting due to unknown team names.');
        process.exit(1);
    }

    // Query all S10 draft picks from Firestore
    console.log('Querying Firestore for S10 draft picks...');
    const snapshot = await db.collection(COLLECTION)
        .where('season', '==', SEASON_FIELD)
        .get();

    console.log(`Found ${snapshot.size} S10 draft picks in Firestore\n`);

    // Build a map of document ID -> document data
    const firestorePicks = new Map();
    snapshot.forEach(doc => {
        firestorePicks.set(doc.id, { ref: doc.ref, data: doc.data() });
    });

    // Match each parsed pick to a Firestore document
    console.log('Matching picks to Firestore documents:\n');
    const updates = [];
    let matchCount = 0;
    let mismatchCount = 0;
    let notFoundCount = 0;

    for (const pick of draftPicks) {
        const round = getRound(pick.overall);
        const docId = `${SEASON_ID}_${pick.originalTeamCode}_${round}`;
        const firestoreDoc = firestorePicks.get(docId);

        const forfeitedTag = pick.forfeited ? ' [FORFEITED]' : '';

        if (!firestoreDoc) {
            console.log(`  #${pick.overall.toString().padStart(2)}: NOT FOUND - ${docId}${forfeitedTag}`);
            notFoundCount++;
            continue;
        }

        const firestoreOwner = firestoreDoc.data.current_owner;
        const expectedOwner = pick.currentOwnerCode;

        if (firestoreOwner !== expectedOwner) {
            console.log(`  #${pick.overall.toString().padStart(2)}: OWNER DIFF - ${docId}${forfeitedTag}`);
            console.log(`           Firestore: ${firestoreOwner}, draftOrder.txt: ${expectedOwner}`);
            mismatchCount++;
            // In non-strict mode, still update the overall field
            if (!STRICT_MODE) {
                updates.push({
                    ref: firestoreDoc.ref,
                    overall: pick.overall,
                    docId
                });
            }
        } else {
            console.log(`  #${pick.overall.toString().padStart(2)}: MATCH - ${docId} (owner: ${firestoreOwner})${forfeitedTag}`);
            matchCount++;
            updates.push({
                ref: firestoreDoc.ref,
                overall: pick.overall,
                docId
            });
        }
    }

    console.log('\n=== Summary ===');
    console.log(`  Exact matches: ${matchCount}`);
    console.log(`  Owner differs: ${mismatchCount}`);
    console.log(`  Not found: ${notFoundCount}`);
    console.log(`  Total parsed: ${draftPicks.length}`);
    console.log(`  Will update: ${updates.length} picks`);

    if (notFoundCount > 0) {
        console.log('\nWarning: Some picks were not found in Firestore. Review above.');
    }
    if (mismatchCount > 0 && !STRICT_MODE) {
        console.log('\nNote: Owner differences exist but will still update overall field.');
        console.log('      (The draftOrder.txt may reflect recent trades not yet in Firestore)');
    }

    if (DRY_RUN) {
        console.log('\n=== DRY RUN - No changes made ===');
        console.log('Run with --live flag to update Firestore');
        process.exit(0);
    }

    // Execute updates
    console.log(`\nUpdating ${updates.length} documents in Firestore...`);

    // Use batched writes (max 500 per batch, but we only have 90)
    const batch = db.batch();
    for (const update of updates) {
        batch.update(update.ref, { overall: update.overall });
    }

    await batch.commit();

    console.log(`\n=== Complete ===`);
    console.log(`Updated ${updates.length} documents with 'overall' field.`);

    process.exit(0);
}

main().catch(err => {
    console.error('Script failed:', err);
    process.exit(1);
});
