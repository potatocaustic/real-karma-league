// functions/bundles/awards-bundle.js

const { onRequest } = require("firebase-functions/v2/https");
const { db } = require("../utils/firebase-admin");
const { getCollectionName, validateLeague, LEAGUES } = require("../utils/firebase-helpers");

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

exports.awardsBundle = onRequest({ region: "us-central1" }, async (req, res) => {
  try {
    const league = (req.query.league || LEAGUES.MAJOR).toString();
    validateLeague(league);

    const awardsCollection = getCollectionName('awards', league);
    const seasonsCollection = getCollectionName('seasons', league);

    const seasonOverride = normalizeSeasonId(req.query.season);
    const bundleId = seasonOverride ? `awards_${league}_${seasonOverride}` : `awards_${league}_all`;
    const bundle = db.bundle(bundleId);

    if (seasonOverride) {
      const seasonNumber = getSeasonNumber(seasonOverride);
      if (!seasonNumber) {
        res.status(400).json({ error: `Invalid season '${seasonOverride}'.` });
        return;
      }

      const seasonDocRef = db.collection(awardsCollection).doc(`season_${seasonNumber}`);
      const seasonDocSnap = await seasonDocRef.get();
      if (seasonDocSnap.exists) {
        bundle.add(seasonDocSnap);
      }

      const awardsSubcollection = getCollectionName(`S${seasonNumber}_awards`, league);
      const awardsSnap = await seasonDocRef.collection(awardsSubcollection).get();
      bundle.add('awards', awardsSnap);
    } else {
      const seasonsSnap = await db.collection(seasonsCollection).get();
      const seasonIds = seasonsSnap.docs.map(doc => doc.id);

      for (const seasonId of seasonIds) {
        const seasonNumber = getSeasonNumber(seasonId);
        if (!seasonNumber) continue;

        const seasonDocRef = db.collection(awardsCollection).doc(`season_${seasonNumber}`);
        const seasonDocSnap = await seasonDocRef.get();
        if (seasonDocSnap.exists) {
          bundle.add(seasonDocSnap);
        }

        const awardsSubcollection = getCollectionName(`S${seasonNumber}_awards`, league);
        const awardsSnap = await seasonDocRef.collection(awardsSubcollection).get();
        bundle.add(`awards_${seasonNumber}`, awardsSnap);
      }
    }

    const buffer = bundle.build();

    res.set("Content-Type", "application/octet-stream");
    res.set("Cache-Control", CACHE_CONTROL_HEADER);
    res.status(200).send(buffer);
  } catch (error) {
    console.error("Failed to build awards bundle:", error);
    res.status(500).json({ error: "Failed to build awards bundle." });
  }
});
