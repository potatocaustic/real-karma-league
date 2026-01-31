// functions/relegation/detection.js

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require('../utils/firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const { getCollectionName, LEAGUES } = require('../utils/firebase-helpers');

/**
 * Detects if both Major and Minor leagues have completed their postseasons
 * and identifies the relegation matchup (worst Major team vs Minor champion).
 *
 * Returns:
 * - bothSeasonsComplete: boolean
 * - majorSeasonStatus: string
 * - minorSeasonStatus: string
 * - matchup: { majorTeam, minorChampion } | null
 * - relegationDoc: existing relegation_games doc | null
 */
exports.detectRelegationMatchup = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth || !request.auth.uid) {
        throw new HttpsError('unauthenticated', 'Must be authenticated.');
    }

    try {
        // Get active Major season
        const majorSeasonQuery = db.collection(getCollectionName('seasons', LEAGUES.MAJOR))
            .where('status', '==', 'active')
            .limit(1);
        const majorSeasonSnap = await majorSeasonQuery.get();

        if (majorSeasonSnap.empty) {
            throw new HttpsError('not-found', 'No active Major league season found.');
        }

        const majorSeasonDoc = majorSeasonSnap.docs[0];
        const majorSeasonId = majorSeasonDoc.id;
        const majorSeasonData = majorSeasonDoc.data();

        // Get active Minor season
        const minorSeasonQuery = db.collection(getCollectionName('seasons', LEAGUES.MINOR))
            .where('status', '==', 'active')
            .limit(1);
        const minorSeasonSnap = await minorSeasonQuery.get();

        if (minorSeasonSnap.empty) {
            throw new HttpsError('not-found', 'No active Minor league season found.');
        }

        const minorSeasonDoc = minorSeasonSnap.docs[0];
        const minorSeasonId = minorSeasonDoc.id;
        const minorSeasonData = minorSeasonDoc.data();

        const majorComplete = majorSeasonData.current_week === 'Season Complete';
        const minorComplete = minorSeasonData.current_week === 'Season Complete';

        // Check for existing relegation doc
        const relegationRef = db.collection('relegation_games').doc(majorSeasonId);
        const relegationSnap = await relegationRef.get();
        const existingDoc = relegationSnap.exists ? { id: relegationSnap.id, ...relegationSnap.data() } : null;

        // If matchup already set, return existing data
        if (existingDoc && ['matchup_set', 'scheduled', 'completed', 'executed', 'no_change'].includes(existingDoc.status)) {
            return {
                bothSeasonsComplete: majorComplete && minorComplete,
                majorSeasonId,
                minorSeasonId,
                majorSeasonStatus: majorSeasonData.current_week,
                minorSeasonStatus: minorSeasonData.current_week,
                matchup: existingDoc.major_team && existingDoc.minor_champion ? {
                    majorTeam: existingDoc.major_team,
                    minorChampion: existingDoc.minor_champion
                } : null,
                relegationDoc: existingDoc
            };
        }

        // If both seasons aren't complete, return current status
        if (!majorComplete || !minorComplete) {
            return {
                bothSeasonsComplete: false,
                majorSeasonId,
                minorSeasonId,
                majorSeasonStatus: majorSeasonData.current_week,
                minorSeasonStatus: minorSeasonData.current_week,
                matchup: null,
                relegationDoc: existingDoc
            };
        }

        // Both seasons complete - identify matchup
        const matchup = await identifyMatchup(majorSeasonId, minorSeasonId);

        // Create/update relegation_games document
        const relegationData = {
            season: majorSeasonId,
            season_number: parseInt(majorSeasonId.replace('S', ''), 10),
            status: 'matchup_set',
            major_team: matchup.majorTeam,
            minor_champion: matchup.minorChampion,
            game_ref: null,
            game_date: null,
            winner_league: null,
            winner_team_id: null,
            promotion_required: false,
            executed_at: null,
            executed_by: null,
            updated_at: FieldValue.serverTimestamp()
        };

        if (!existingDoc) {
            relegationData.created_at = FieldValue.serverTimestamp();
        }

        await relegationRef.set(relegationData, { merge: true });

        return {
            bothSeasonsComplete: true,
            majorSeasonId,
            minorSeasonId,
            majorSeasonStatus: majorSeasonData.current_week,
            minorSeasonStatus: minorSeasonData.current_week,
            matchup,
            relegationDoc: { id: majorSeasonId, ...relegationData }
        };

    } catch (error) {
        console.error("Error detecting relegation matchup:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError('internal', `Failed to detect relegation matchup: ${error.message}`);
    }
});

/**
 * Gets the current relegation status for the active season.
 * Returns the relegation_games document with computed flags.
 */
exports.getRelegationStatus = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth || !request.auth.uid) {
        throw new HttpsError('unauthenticated', 'Must be authenticated.');
    }

    try {
        // Get active Major season to determine season ID
        const majorSeasonQuery = db.collection(getCollectionName('seasons', LEAGUES.MAJOR))
            .where('status', '==', 'active')
            .limit(1);
        const majorSeasonSnap = await majorSeasonQuery.get();

        if (majorSeasonSnap.empty) {
            throw new HttpsError('not-found', 'No active Major league season found.');
        }

        const majorSeasonId = majorSeasonSnap.docs[0].id;
        const majorSeasonData = majorSeasonSnap.docs[0].data();

        // Get Minor season status
        const minorSeasonQuery = db.collection(getCollectionName('seasons', LEAGUES.MINOR))
            .where('status', '==', 'active')
            .limit(1);
        const minorSeasonSnap = await minorSeasonQuery.get();
        const minorSeasonData = minorSeasonSnap.empty ? null : minorSeasonSnap.docs[0].data();

        // Get relegation document
        const relegationRef = db.collection('relegation_games').doc(majorSeasonId);
        const relegationSnap = await relegationRef.get();

        if (!relegationSnap.exists) {
            return {
                seasonId: majorSeasonId,
                majorSeasonStatus: majorSeasonData.current_week,
                minorSeasonStatus: minorSeasonData?.current_week || 'Unknown',
                exists: false,
                status: 'pending',
                canDetectMatchup: majorSeasonData.current_week === 'Season Complete' &&
                    minorSeasonData?.current_week === 'Season Complete',
                canScheduleGame: false,
                canExecutePromotion: false
            };
        }

        const docData = relegationSnap.data();
        return {
            seasonId: majorSeasonId,
            majorSeasonStatus: majorSeasonData.current_week,
            minorSeasonStatus: minorSeasonData?.current_week || 'Unknown',
            exists: true,
            ...docData,
            canDetectMatchup: false, // Already detected
            canScheduleGame: docData.status === 'matchup_set' && !docData.game_ref,
            canExecutePromotion: docData.status === 'completed' &&
                docData.promotion_required === true &&
                docData.executed_at === null
        };

    } catch (error) {
        console.error("Error getting relegation status:", error);
        if (error instanceof HttpsError) throw error;
        throw new HttpsError('internal', `Failed to get relegation status: ${error.message}`);
    }
});

/**
 * Identifies the worst Major team and Minor champion for the relegation matchup.
 */
async function identifyMatchup(majorSeasonId, minorSeasonId) {
    // Get worst Major team by sortscore (lowest = worst)
    const majorTeamsSnap = await db.collection(getCollectionName('v2_teams', LEAGUES.MAJOR)).get();

    let worstMajorTeam = null;
    let worstSortscore = Infinity;

    for (const teamDoc of majorTeamsSnap.docs) {
        const teamData = teamDoc.data();

        // Skip teams without a conference (inactive/placeholder teams)
        if (!teamData.conference) continue;

        // Get seasonal record for this team
        const seasonRecordRef = db.collection(getCollectionName('v2_teams', LEAGUES.MAJOR))
            .doc(teamDoc.id)
            .collection('seasonal_records')
            .doc(majorSeasonId);
        const seasonRecordSnap = await seasonRecordRef.get();

        if (seasonRecordSnap.exists) {
            const recordData = seasonRecordSnap.data();
            const sortscore = recordData.sortscore || 0;

            if (sortscore < worstSortscore) {
                worstSortscore = sortscore;
                worstMajorTeam = {
                    team_id: teamDoc.id,
                    team_name: recordData.team_name || teamData.team_name || teamDoc.id,
                    sortscore: sortscore,
                    record: `${recordData.wins || 0}-${recordData.losses || 0}`
                };
            }
        }
    }

    if (!worstMajorTeam) {
        throw new HttpsError('not-found', 'Could not identify worst Major league team.');
    }

    // Get Minor champion from Finals game
    const finalsQuery = db.collection(getCollectionName('seasons', LEAGUES.MINOR))
        .doc(minorSeasonId)
        .collection('post_games')
        .where('round', '==', 'Finals')
        .where('series_winner', '!=', null)
        .limit(1);
    const finalsSnap = await finalsQuery.get();

    if (finalsSnap.empty) {
        throw new HttpsError('not-found', 'Could not find completed Minor league Finals.');
    }

    const finalsData = finalsSnap.docs[0].data();
    const championId = finalsData.series_winner;

    // Get champion team details
    const championRef = db.collection(getCollectionName('v2_teams', LEAGUES.MINOR)).doc(championId);
    const championSnap = await championRef.get();

    if (!championSnap.exists) {
        throw new HttpsError('not-found', `Minor champion team ${championId} not found.`);
    }

    // Get team name from seasonal record
    const championSeasonRecordRef = db.collection(getCollectionName('v2_teams', LEAGUES.MINOR))
        .doc(championId)
        .collection('minor_seasonal_records')
        .doc(minorSeasonId);
    const championSeasonRecordSnap = await championSeasonRecordRef.get();

    const championData = championSnap.data();
    const championRecordData = championSeasonRecordSnap.exists ? championSeasonRecordSnap.data() : {};

    const minorChampion = {
        team_id: championId,
        team_name: championRecordData.team_name || championData.team_name || championId
    };

    return {
        majorTeam: worstMajorTeam,
        minorChampion
    };
}
