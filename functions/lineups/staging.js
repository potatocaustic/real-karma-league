// functions/lineups/staging.js

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require('../utils/firebase-admin');
const { FieldValue } = require("firebase-admin/firestore");
const { getCollectionName, getLeagueFromRequest, LEAGUES } = require('../utils/firebase-helpers');

/**
 * Stages lineups for live scoring. This function handles both GM submissions and admin submissions.
 * It validates deadlines, manages pending lineups, and automatically activates games when both lineups are ready.
 */
exports.stageLiveLineups = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth) {
        throw new HttpsError('permission-denied', 'You must be logged in to submit a lineup.');
    }

    const { gameId, seasonId, collectionName, gameDate, team1_lineup, team2_lineup, submittingTeamId } = request.data;
    const isGmSubmission = !!submittingTeamId;

    if (!gameId || !seasonId || !collectionName || !gameDate) {
        throw new HttpsError('invalid-argument', 'Missing required game parameters.');
    }
    if (!team1_lineup && !team2_lineup) {
        throw new HttpsError('invalid-argument', 'At least one team lineup must be provided.');
    }

    // Ensure we use the correct league context.
    // Trust the frontend's league parameter first, then verify against season location.
    let league = getLeagueFromRequest(request.data);

    // Only override if the frontend didn't provide a league or if the season doesn't exist in the specified league
    const requestedLeague = request.data?.league;
    if (!requestedLeague) {
        // No league specified, check where the season exists
        const [majorSeasonDoc, minorSeasonDoc] = await Promise.all([
            db.collection(getCollectionName('seasons', LEAGUES.MAJOR)).doc(seasonId).get(),
            db.collection(getCollectionName('seasons', LEAGUES.MINOR)).doc(seasonId).get()
        ]);

        if (majorSeasonDoc.exists !== minorSeasonDoc.exists) {
            league = minorSeasonDoc.exists ? LEAGUES.MINOR : LEAGUES.MAJOR;
        }
    }

    const logBatch = db.batch();
    const submissionLogRef = db.collection(getCollectionName('lineup_submission_logs', league)).doc();
    const isTeam1Submitting = team1_lineup && team1_lineup.length === 6;
    const isTeam2Submitting = team2_lineup && team2_lineup.length === 6;

    logBatch.set(submissionLogRef, {
        gameId,
        gameDate,
        userId: request.auth.uid,
        submittingTeamId: submittingTeamId || 'admin_submission',
        submittedLineup: isTeam1Submitting ? team1_lineup : (isTeam2Submitting ? team2_lineup : null),
        timestamp: FieldValue.serverTimestamp(),
        status: 'initiated'
    });
    await logBatch.commit();

    try {
        if (isGmSubmission) {
            const [month, day, year] = gameDate.split('/');
            const deadlineId = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const deadlineRef = db.collection(getCollectionName('lineup_deadlines', league)).doc(deadlineId);
            const deadlineDoc = await deadlineRef.get();

            if (!deadlineDoc.exists) {
                await submissionLogRef.update({ status: 'failure', reason: 'No deadline set for this game date.' });
                throw new HttpsError('failed-precondition', 'Lineup submissions are not yet open for this game date.');
            }

            const deadline = deadlineDoc.data().deadline.toDate();
            const now = new Date();
            const gracePeriodEnd = new Date(deadline.getTime() + 150 * 60 * 1000);
            const lateNoCaptainEnd = new Date(deadline.getTime() + 10 * 60 * 1000);

            if (now > gracePeriodEnd) {
                await submissionLogRef.update({ status: 'failure', reason: 'Submission window closed.' });
                throw new HttpsError('deadline-exceeded', 'The lineup submission window has closed for this game.');
            }

            const submittingLineup = isTeam1Submitting ? team1_lineup : team2_lineup;
            const hasCaptain = submittingLineup.some(p => p.is_captain);

            if (hasCaptain && now > lateNoCaptainEnd) {
                await submissionLogRef.update({ status: 'failure', reason: 'Late submission with captain.' });
                throw new HttpsError('invalid-argument', 'Your submission is late. You must remove your captain selection to submit.');
            }

            if (!hasCaptain && now <= lateNoCaptainEnd) {
                await submissionLogRef.update({ status: 'failure', reason: 'On-time submission missing captain.' });
                throw new HttpsError('invalid-argument', 'You must select a captain for your lineup.');
            }
        }

        const liveGameRef = db.collection(getCollectionName('live_games', league)).doc(gameId);
        const liveGameSnap = await liveGameRef.get();

        if (liveGameSnap.exists) {
            console.log(`Game ${gameId} is already live. Updating existing document.`);
            const liveGameData = liveGameSnap.data();
            const updateData = {};
            const oldPlayerScores = new Map();
            [...(liveGameData.team1_lineup || []), ...(liveGameData.team2_lineup || [])].forEach(p => {
                oldPlayerScores.set(p.player_id, {
                    points_raw: p.points_raw || 0,
                    points_adjusted: p.points_adjusted || 0,
                    final_score: p.final_score || 0,
                    global_rank: p.global_rank || 0
                });
            });

            if (team1_lineup && team1_lineup.length === 6) {
                updateData.team1_lineup = team1_lineup.map(p => ({ ...(oldPlayerScores.get(p.player_id) || {}), ...p }));
            }
            if (team2_lineup && team2_lineup.length === 6) {
                updateData.team2_lineup = team2_lineup.map(p => ({ ...(oldPlayerScores.get(p.player_id) || {}), ...p }));
            }

            if (Object.keys(updateData).length > 0) {
                await liveGameRef.update(updateData);
            }

            await submissionLogRef.update({ status: 'success', details: 'Updated live game document.' });
            return { success: true, league, message: "Live game lineup has been successfully updated." };
        }

        const pendingRef = db.collection(getCollectionName('pending_lineups', league)).doc(gameId);
        const dataToSet = {
            seasonId,
            collectionName,
            gameDate,
            lastUpdatedBy: request.auth.uid,
            lastUpdated: FieldValue.serverTimestamp()
        };

        if (isTeam1Submitting) {
            dataToSet.team1_lineup = team1_lineup;
            dataToSet.team1_submitted = true;
        }
        if (isTeam2Submitting) {
            dataToSet.team2_lineup = team2_lineup;
            dataToSet.team2_submitted = true;
        }

        await pendingRef.set(dataToSet, { merge: true });

        const updatedPendingDoc = await pendingRef.get();
        if (updatedPendingDoc.exists) {
            const data = updatedPendingDoc.data();

            const nowInChicago = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
            let gamedayInChicago = new Date(nowInChicago);

            if (gamedayInChicago.getHours() < 6) {
                gamedayInChicago.setDate(gamedayInChicago.getDate() - 1);
            }

            const todayStr = `${gamedayInChicago.getMonth() + 1}/${gamedayInChicago.getDate()}/${gamedayInChicago.getFullYear()}`;

            if (data.gameDate === todayStr && data.team1_submitted === true && data.team2_submitted === true) {
                console.log(`Game ${gameId} is ready for immediate activation.`);
                const batch = db.batch();
                batch.set(liveGameRef, {
                    seasonId: data.seasonId,
                    collectionName: data.collectionName,
                    team1_lineup: data.team1_lineup,
                    team2_lineup: data.team2_lineup,
                    activatedAt: FieldValue.serverTimestamp()
                });
                batch.delete(pendingRef);
                await batch.commit();
                console.log(`Game ${gameId} successfully activated and moved to live_games.`);
            }
        }

        await submissionLogRef.update({ status: 'success' });
        return { success: true, league, message: "Lineup has been successfully submitted." };

    } catch (error) {
        if (!(error instanceof HttpsError)) {
             console.error(`Error staging lineups for game ${gameId}:`, error);
             await submissionLogRef.update({ status: 'failure', reason: `Internal error: ${error.message}` });
             throw new HttpsError('internal', `Could not stage lineups: ${error.message}`);
        } else {
            throw error;
        }
    }
});
