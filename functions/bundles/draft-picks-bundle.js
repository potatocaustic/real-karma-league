// functions/bundles/draft-picks-bundle.js

const { onRequest } = require("firebase-functions/v2/https");
const { db } = require("../utils/firebase-admin");
const { getCollectionName, validateLeague, LEAGUES } = require("../utils/firebase-helpers");

const CACHE_CONTROL_HEADER = "public, max-age=300, s-maxage=7200";

exports.draftPicksBundle = onRequest({ region: "us-central1" }, async (req, res) => {
  try {
    const league = (req.query.league || LEAGUES.MAJOR).toString();
    validateLeague(league);

    const draftPicksCollection = getCollectionName('draftPicks', league);
    const draftPicksSnap = await db.collection(draftPicksCollection).get();

    const bundleId = `draftPicks_${league}`;
    const bundle = db.bundle(bundleId);
    bundle.add('draftPicks', draftPicksSnap);

    const buffer = bundle.build();

    res.set("Content-Type", "application/octet-stream");
    res.set("Cache-Control", CACHE_CONTROL_HEADER);
    res.status(200).send(buffer);
  } catch (error) {
    console.error("Failed to build draft picks bundle:", error);
    res.status(500).json({ error: "Failed to build draft picks bundle." });
  }
});
