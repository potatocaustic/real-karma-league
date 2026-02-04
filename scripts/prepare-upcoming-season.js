// /scripts/prepare-upcoming-season.js
// Creates an upcoming season scaffold in Firestore without closing the active season.
// Usage:
//   node scripts/prepare-upcoming-season.js --season 10 --league major --status upcoming
// Notes:
// - Requires Firebase Admin credentials (ADC or service account env).
// - Uses the same structure builder as Cloud Functions.

const { admin, db } = require('../functions/utils/firebase-admin');
const { getCollectionName } = require('../functions/utils/firebase-helpers');
const { createSeasonStructure } = require('../functions/seasons/structure');

function parseArgs(argv) {
  const args = { season: null, league: 'major', status: 'upcoming' };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--season' && argv[i + 1]) {
      args.season = parseInt(argv[i + 1], 10);
      i += 1;
      continue;
    }
    if (token === '--league' && argv[i + 1]) {
      args.league = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === '--status' && argv[i + 1]) {
      args.status = argv[i + 1];
      i += 1;
      continue;
    }
  }
  return args;
}

async function getActiveSeasonId(league) {
  const seasonsQuery = db.collection(getCollectionName('seasons', league))
    .where('status', '==', 'active')
    .limit(1);
  const snapshot = await seasonsQuery.get();
  if (snapshot.empty) {
    throw new Error(`No active season found for league: ${league}`);
  }
  return snapshot.docs[0].id;
}

async function main() {
  const { season, league, status } = parseArgs(process.argv);
  if (!season || Number.isNaN(season)) {
    throw new Error('Missing or invalid --season argument (e.g., --season 10).');
  }
  const seasonId = `S${season}`;

  const activeSeasonId = await getActiveSeasonId(league);

  const seasonRef = db.collection(getCollectionName('seasons', league)).doc(seasonId);
  const seasonSnap = await seasonRef.get();
  if (seasonSnap.exists) {
    console.log(`${seasonId} already exists for ${league} league. Nothing to do.`);
    return;
  }

  const batch = db.batch();
  await createSeasonStructure(season, batch, activeSeasonId, league);

  batch.set(seasonRef, {
    season_name: `Season ${season}`,
    status: status,
    current_week: '1',
    gp: 0,
    gs: 0,
    season_trans: 0,
    season_karma: 0
  }, { merge: true });

  await batch.commit();
  console.log(`Created upcoming season scaffold for ${seasonId} (${league} league) with status '${status}'.`);
}

main().catch((err) => {
  console.error('Failed to prepare upcoming season:', err);
  process.exit(1);
});
