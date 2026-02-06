// functions/bundles/standings-bundle.js

const { onRequest } = require("firebase-functions/v2/https");
const { db } = require("../utils/firebase-admin");
const { getCollectionName, validateLeague, LEAGUES } = require("../utils/firebase-helpers");

const CACHE_CONTROL_HEADER = "public, max-age=300, s-maxage=3600";

function normalizeSeasonId(seasonParam) {
  if (!seasonParam) return null;
  const raw = String(seasonParam).trim();
  if (!raw) return null;
  if (/^S\\d+$/i.test(raw)) return raw.toUpperCase();
  if (/^\\d+$/.test(raw)) return `S${raw}`;
  return raw.toUpperCase();
}

function getConferenceNames(league) {
  return league === LEAGUES.MINOR
    ? ['Northern', 'Southern']
    : ['Eastern', 'Western'];
}

exports.standingsBundle = onRequest({ region: "us-central1" }, async (req, res) => {
  try {
    const league = (req.query.league || LEAGUES.MAJOR).toString();
    validateLeague(league);

    const seasonsCollection = getCollectionName('seasons', league);
    const teamsCollection = getCollectionName('v2_teams', league);
    const seasonalRecordsCollection = getCollectionName('seasonal_records', league);
    const powerRankingsCollection = getCollectionName('power_rankings', league);

    const seasonOverride = normalizeSeasonId(req.query.season);

    let seasonId = seasonOverride;
    let activeSeasonSnap = null;
    let seasonDocSnap = null;
    let powerRankingsSeasonSnap = null;
    let latestPowerRankingsVersion = null;

    if (seasonOverride) {
      seasonDocSnap = await db.collection(seasonsCollection).doc(seasonOverride).get();
      if (!seasonDocSnap.exists) {
        res.status(404).json({ error: `Season ${seasonOverride} not found.` });
        return;
      }
    } else {
      const activeSeasonQuery = db.collection(seasonsCollection)
        .where('status', '==', 'active')
        .limit(1);
      activeSeasonSnap = await activeSeasonQuery.get();
      if (activeSeasonSnap.empty) {
        res.status(404).json({ error: "No active season found." });
        return;
      }
      seasonId = activeSeasonSnap.docs[0].id;
      seasonDocSnap = activeSeasonSnap.docs[0];
    }

    const powerRankingsSeasonDocId = `season_${seasonId.replace('S', '')}`;
    powerRankingsSeasonSnap = await db.collection(powerRankingsCollection).doc(powerRankingsSeasonDocId).get();
    if (powerRankingsSeasonSnap.exists) {
      latestPowerRankingsVersion = powerRankingsSeasonSnap.data()?.latest_version || null;
    }

    const conferences = getConferenceNames(league);

    const teamsQuery = db.collection(teamsCollection)
      .where('conference', 'in', conferences);
    const recordsQuery = db.collectionGroup(seasonalRecordsCollection)
      .where('seasonId', '==', seasonId);

    const [teamsSnap, recordsSnap] = await Promise.all([
      teamsQuery.get(),
      recordsQuery.get()
    ]);

    const bundleId = `standings_${league}_${seasonId}`;
    const bundle = db.bundle(bundleId);

    if (activeSeasonSnap) {
      bundle.add('activeSeason', activeSeasonSnap);
    }
    if (seasonDocSnap) {
      bundle.add(seasonDocSnap);
    }
    if (powerRankingsSeasonSnap && powerRankingsSeasonSnap.exists) {
      bundle.add(powerRankingsSeasonSnap);
    }

    bundle.add('teams', teamsSnap);
    bundle.add('seasonalRecords', recordsSnap);

    if (latestPowerRankingsVersion) {
      const powerRankingsVersionRef = db.collection(powerRankingsCollection)
        .doc(powerRankingsSeasonDocId)
        .collection(latestPowerRankingsVersion);
      const powerRankingsSnap = await powerRankingsVersionRef.get();
      bundle.add('powerRankingsLatest', powerRankingsSnap);
    }

    const buffer = bundle.build();

    res.set("Content-Type", "application/octet-stream");
    res.set("Cache-Control", CACHE_CONTROL_HEADER);
    res.status(200).send(buffer);
  } catch (error) {
    console.error("Failed to build standings bundle:", error);
    res.status(500).json({ error: "Failed to build standings bundle." });
  }
});
