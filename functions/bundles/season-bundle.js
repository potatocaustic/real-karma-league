// functions/bundles/season-bundle.js

const { onRequest } = require("firebase-functions/v2/https");
const { db } = require("../utils/firebase-admin");
const { getCollectionName, validateLeague, LEAGUES } = require("../utils/firebase-helpers");

const CACHE_CONTROL_HEADER = "public, max-age=300, s-maxage=1800";

function normalizeSeasonId(seasonParam) {
  if (!seasonParam) return null;
  const raw = String(seasonParam).trim();
  if (!raw) return null;
  if (/^S\\d+$/i.test(raw)) return raw.toUpperCase();
  if (/^\\d+$/.test(raw)) return `S${raw}`;
  return raw.toUpperCase();
}

exports.seasonBundle = onRequest({ region: "us-central1" }, async (req, res) => {
  try {
    const league = (req.query.league || LEAGUES.MAJOR).toString();
    validateLeague(league);

    const seasonsCollection = getCollectionName('seasons', league);
    const teamsCollection = getCollectionName('v2_teams', league);
    const seasonalRecordsCollection = getCollectionName('seasonal_records', league);
    const gamesCollection = getCollectionName('games', league);
    const postGamesCollection = getCollectionName('post_games', league);
    const exhibitionGamesCollection = getCollectionName('exhibition_games', league);

    const seasonOverride = normalizeSeasonId(req.query.season);

    let seasonId = seasonOverride;
    let activeSeasonSnap = null;
    let seasonDocSnap = null;

    if (seasonOverride) {
      const seasonDocRef = db.collection(seasonsCollection).doc(seasonOverride);
      seasonDocSnap = await seasonDocRef.get();
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

    const seasonDocRef = db.collection(seasonsCollection).doc(seasonId);

    const teamsQuery = db.collection(teamsCollection);
    const recordsQuery = db.collectionGroup(seasonalRecordsCollection)
      .where('seasonId', '==', seasonId);
    const gamesQuery = seasonDocRef.collection(gamesCollection);
    const postGamesQuery = seasonDocRef.collection(postGamesCollection);
    const exhibitionGamesQuery = seasonDocRef.collection(exhibitionGamesCollection);

    const [teamsSnap, recordsSnap, gamesSnap, postGamesSnap, exhibitionGamesSnap] = await Promise.all([
      teamsQuery.get(),
      recordsQuery.get(),
      gamesQuery.get(),
      postGamesQuery.get(),
      exhibitionGamesQuery.get()
    ]);

    const bundleId = `season_${league}_${seasonId}`;
    const bundle = db.bundle(bundleId);

    if (activeSeasonSnap) {
      bundle.add('activeSeason', activeSeasonSnap);
    }
    if (seasonDocSnap) {
      bundle.add(seasonDocSnap);
    }

    bundle.add('teams', teamsSnap);
    bundle.add('seasonalRecords', recordsSnap);
    bundle.add('games', gamesSnap);
    bundle.add('postGames', postGamesSnap);
    bundle.add('exhibitionGames', exhibitionGamesSnap);

    const buffer = bundle.build();

    res.set("Content-Type", "application/octet-stream");
    res.set("Cache-Control", CACHE_CONTROL_HEADER);
    res.status(200).send(buffer);
  } catch (error) {
    console.error("Failed to build season bundle:", error);
    res.status(500).json({ error: "Failed to build season bundle." });
  }
});
