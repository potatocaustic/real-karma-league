// functions/bundles/draft-results-bundle.js

const { onRequest } = require("firebase-functions/v2/https");
const { db } = require("../utils/firebase-admin");
const { validateLeague, LEAGUES } = require("../utils/firebase-helpers");

const CACHE_CONTROL_HEADER = "public, max-age=600, s-maxage=86400";

function normalizeSeasonId(seasonParam) {
  if (!seasonParam) return null;
  const raw = String(seasonParam).trim();
  if (!raw) return null;
  if (/^S\\d+$/i.test(raw)) return raw.toUpperCase();
  if (/^\\d+$/.test(raw)) return `S${raw}`;
  return raw.toUpperCase();
}

function getSeasonNumber(seasonId) {
  const match = /^S(\\d+)$/i.exec(seasonId || "");
  return match ? parseInt(match[1], 10) : null;
}

exports.draftResultsBundle = onRequest({ region: "us-central1" }, async (req, res) => {
  try {
    const league = (req.query.league || LEAGUES.MAJOR).toString();
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
