// functions/bundles/transactions-bundle.js

const { onRequest } = require("firebase-functions/v2/https");
const { db } = require("../utils/firebase-admin");
const { getCollectionName, validateLeague, LEAGUES, normalizeLeagueParam } = require("../utils/firebase-helpers");

const CACHE_CONTROL_HEADER = "public, max-age=120, s-maxage=600";

function normalizeSeasonId(seasonParam) {
  if (!seasonParam) return null;
  const rawParam = Array.isArray(seasonParam) ? seasonParam[0] : seasonParam;
  const raw = String(rawParam).trim().toUpperCase();
  if (!raw) return null;
  const match = raw.match(/S?\d+/);
  if (!match) return null;
  const token = match[0];
  return token.startsWith('S') ? token : `S${token}`;
}

exports.transactionsBundle = onRequest({ region: "us-central1" }, async (req, res) => {
  try {
    const league = normalizeLeagueParam(req.query.league);
    validateLeague(league);

    const seasonsCollection = getCollectionName('seasons', league);
    const transactionsCollection = getCollectionName('transactions', league);

    const seasonOverride = normalizeSeasonId(req.query.season);
    let seasonId = seasonOverride;

    if (!seasonId) {
      const activeSeasonQuery = db.collection(seasonsCollection)
        .where('status', '==', 'active')
        .limit(1);
      const activeSeasonSnap = await activeSeasonQuery.get();
      if (activeSeasonSnap.empty) {
        res.status(404).json({ error: "No active season found." });
        return;
      }
      seasonId = activeSeasonSnap.docs[0].id;
    }

    const transactionsRef = db.collection(transactionsCollection).doc('seasons').collection(seasonId);
    const transactionsSnap = await transactionsRef.get();

    const bundleId = `transactions_${league}_${seasonId}`;
    const bundle = db.bundle(bundleId);
    bundle.add('transactions', transactionsSnap);

    const buffer = bundle.build();

    res.set("Content-Type", "application/octet-stream");
    res.set("Cache-Control", CACHE_CONTROL_HEADER);
    res.status(200).send(buffer);
  } catch (error) {
    console.error("Failed to build transactions bundle:", error);
    res.status(500).json({ error: "Failed to build transactions bundle." });
  }
});
