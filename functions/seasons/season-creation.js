// functions/seasons/season-creation.js

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const { getCollectionName, getLeagueFromRequest } = require('../utils/firebase-helpers');
const { createSeasonStructure } = require('./structure');

// Ensure admin is initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

const db = admin.firestore();

/**
 * Creates a new season by advancing from the current active season
 * - Marks current season as completed
 * - Creates new season structure
 * - Generates draft picks for 5 seasons in the future
 * Admin-only function.
 */
exports.createNewSeason = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
    if (!request.auth || !request.auth.uid) {
        throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }

    try {
        const activeSeasonQuery = db.collection(getCollectionName('seasons', league)).where('status', '==', 'active').limit(1);
        const activeSeasonSnap = await activeSeasonQuery.get();

        if (activeSeasonSnap.empty) {
            throw new HttpsError('failed-precondition', 'No active season found. Cannot advance to the next season.');
        }

        const activeSeasonDoc = activeSeasonSnap.docs[0];
        const activeSeasonId = activeSeasonDoc.id;
        const activeSeasonNum = parseInt(activeSeasonId.replace('S', ''), 10);

        const newSeasonNumber = activeSeasonNum + 1;
        const futureDraftSeasonNumber = newSeasonNumber + 5;

        console.log(`Advancing from active season ${activeSeasonId} to new season S${newSeasonNumber}.`);

        const batch = db.batch();

        const newSeasonRef = await createSeasonStructure(newSeasonNumber, batch, activeSeasonId, league);

        batch.set(newSeasonRef, {
            season_name: `Season ${newSeasonNumber}`,
            status: "active",
            current_week: "1",
            gp: 0,
            gs: 0,
            season_trans: 0,
            season_karma: 0
        }, { merge: true });

        const oldSeasonRef = db.doc(`${getCollectionName('seasons', league)}/${activeSeasonId}`);
        batch.update(oldSeasonRef, { status: "completed" });


        const oldPicksQuery = db.collection(getCollectionName("draftPicks", league)).where("season", "==", String(newSeasonNumber));
        const oldPicksSnap = await oldPicksQuery.get();
        console.log(`Deleting ${oldPicksSnap.size} draft picks for season ${newSeasonNumber}.`);
        oldPicksSnap.forEach(doc => batch.delete(doc.ref));

        const teamsSnap = await db.collection(getCollectionName("v2_teams", league)).where("conference", "in", ["Eastern", "Western"]).get();
        const activeTeams = teamsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        console.log(`Creating future draft picks for S${futureDraftSeasonNumber} for ${activeTeams.length} teams.`);
        for (const team of activeTeams) {
            for (let round = 1; round <= 3; round++) {
                const pickId = `S${futureDraftSeasonNumber}_${team.id}_${round}`;
                const pickRef = db.collection(getCollectionName("draftPicks", league)).doc(pickId);
                const pickData = {
                    pick_id: pickId,
                    pick_description: `S${futureDraftSeasonNumber} ${team.id} ${round}${round === 1 ? 'st' : round === 2 ? 'nd' : 'rd'}`,
                    season: futureDraftSeasonNumber,
                    round: round,
                    original_team: team.id,
                    current_owner: team.id,
                    acquired_week: null,
                    base_owner: null,
                    notes: null,
                    trade_id: null
                };
                batch.set(pickRef, pickData);
            }
        }

        await batch.commit();
        return { success: true, league, message: `Successfully advanced from ${activeSeasonId} to Season ${newSeasonNumber} and generated draft picks for Season ${futureDraftSeasonNumber}.` };
    } catch (error) {
        console.error("Error creating new season:", error);
        throw new HttpsError('internal', `Failed to create new season: ${error.message}`);
    }
});


/**
 * Creates a historical season structure for a past season
 * Used to backfill data for seasons that occurred before the system was in place
 * Admin-only function.
 */
exports.createHistoricalSeason = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
    if (!request.auth || !request.auth.uid) {
        throw new HttpsError('unauthenticated', 'The function must be called while authenticated.');
    }
    const { seasonNumber } = request.data;
    if (!seasonNumber) {
        throw new HttpsError('invalid-argument', 'A seasonNumber must be provided.');
    }

    const activeSeasonQuery = db.collection(getCollectionName('seasons', league)).where('status', '==', 'active').limit(1);
    const activeSeasonSnap = await activeSeasonQuery.get();

    if (activeSeasonSnap.empty) {
        throw new HttpsError('failed-precondition', 'Could not determine the current active season. Aborting.');
    }

    const activeSeasonId = activeSeasonSnap.docs[0].id;
    const activeSeasonNum = parseInt(activeSeasonId.replace('S', ''), 10);

    if (seasonNumber >= activeSeasonNum) {
        throw new HttpsError('failed-precondition', `Historical season (${seasonNumber}) must be less than the current active season (S${activeSeasonNum}).`);
    }

    const seasonDoc = await db.doc(`${getCollectionName('seasons', league)}/S${seasonNumber}`).get();
    if (seasonDoc.exists) {
        throw new HttpsError('already-exists', `Season S${seasonNumber} already exists in the database.`);
    }

    try {
        const batch = db.batch();

        const historicalSeasonRef = await createSeasonStructure(seasonNumber, batch, activeSeasonId, league);

        batch.set(historicalSeasonRef, {
            season_name: `Season ${seasonNumber}`,
            status: "completed",
            gp: 0,
            gs: 0,
            season_trans: 0,
            season_karma: 0
        }, { merge: true });

        await batch.commit();
        return { success: true, league, message: `Successfully created historical data structure for Season ${seasonNumber}.` };
    } catch (error) {
        console.error("Error creating historical season:", error);
        throw new HttpsError('internal', `Failed to create historical season: ${error.message}`);
    }
});
