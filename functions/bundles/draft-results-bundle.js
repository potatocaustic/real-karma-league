// functions/bundles/draft-results-bundle.js

const { onRequest } = require("firebase-functions/v2/https");
const { db } = require("../utils/firebase-admin");
const { validateLeague, LEAGUES, normalizeLeagueParam } = require("../utils/firebase-helpers");

const CACHE_CONTROL_HEADER = "public, max-age=600, s-maxage=86400";

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

function getSeasonNumber(seasonId) {
  const match = /^S(\\d+)$/i.exec(seasonId || "");
  return match ? parseInt(match[1], 10) : null;
}

exports.draftResultsBundle = onRequest({ region: "us-central1" }, async (req, res) => {
  try {
    const league = normalizeLeagueParam(req.query.league);
    validateLeague(league);

    const seasonOverride = normalizeSeasonId(req.query.season);
    if (!seasonOverride) {
      res.status(400).json({ error: "Missing season parameter." });
      return;
    }

    const seasonNumber = getSeasonNumber(seasonOverride);
    if (!seasonNumber) {
      res.status(400).json({ error: `Invalid season '${seasonOverride}'.` });
      return;
    }

    const draftResultsCollection = league === LEAGUES.MINOR ? 'minor_draft_results' : 'draft_results';
    const seasonDocId = `season_${seasonNumber}`;
    const resultsCollectionId = `S${seasonNumber}_draft_results`;

    const resultsRef = db.collection(draftResultsCollection).doc(seasonDocId).collection(resultsCollectionId);
    const resultsSnap = await resultsRef.get();

    const bundleId = `draft_results_${league}_${seasonOverride}`;
    const bundle = db.bundle(bundleId);
    bundle.add('draftResults', resultsSnap);

    const buffer = bundle.build();

    res.set("Content-Type", "application/octet-stream");
    res.set("Cache-Control", CACHE_CONTROL_HEADER);
    res.status(200).send(buffer);
  } catch (error) {
    console.error("Failed to build draft results bundle:", error);
    res.status(500).json({ error: "Failed to build draft results bundle." });
  }
});
