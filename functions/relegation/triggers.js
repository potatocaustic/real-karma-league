// functions/relegation/triggers.js

const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { admin, db } = require('../utils/firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');

/**
 * Firestore trigger that detects when a Relegation game is completed.
 * Updates the relegation_games document with the result.
 *
 * Trigger path: seasons/{seasonId}/exhibition_games/{gameId}
 * (Relegation games are stored in Major league's exhibition_games collection)
 */
exports.onRelegationGameComplete = onDocumentUpdated(
    'seasons/{seasonId}/exhibition_games/{gameId}',
    async (event) => {
        const before = event.data.before.data();
        const after = event.data.after.data();
        const { seasonId, gameId } = event.params;

        // Only process if this is a Relegation game
        if (after.week !== 'Relegation') {
            return null;
        }

        // Only process if the game just completed (completed changed from not TRUE to TRUE)
        if (after.completed !== 'TRUE' || before.completed === 'TRUE') {
            return null;
        }

        console.log(`Relegation game ${gameId} in ${seasonId} completed. Processing result...`);

        try {
            // Get the relegation document
            const relegationRef = db.collection('relegation_games').doc(seasonId);
            const relegationSnap = await relegationRef.get();

            if (!relegationSnap.exists) {
                console.error(`No relegation_games document found for ${seasonId}`);
                return null;
            }

            const relegationData = relegationSnap.data();

            // Verify this game matches the one we're tracking
            if (relegationData.game_ref && !relegationData.game_ref.includes(gameId)) {
                console.log(`Game ${gameId} does not match tracked game ${relegationData.game_ref}. Skipping.`);
                return null;
            }

            const majorTeamId = relegationData.major_team?.team_id;
            const minorTeamId = relegationData.minor_champion?.team_id;

            if (!majorTeamId || !minorTeamId) {
                console.error('Relegation document missing team IDs');
                return null;
            }

            // Determine winner from game scores
            const team1Score = after.team1_score || 0;
            const team2Score = after.team2_score || 0;
            const gameWinnerId = after.winner;

            // Determine which league won
            let winnerLeague;
            let winnerTeamId;
            let promotionRequired;

            if (gameWinnerId === majorTeamId) {
                winnerLeague = 'major';
                winnerTeamId = majorTeamId;
                promotionRequired = false;
                console.log(`Major team ${majorTeamId} won. No promotion required.`);
            } else if (gameWinnerId === minorTeamId) {
                winnerLeague = 'minor';
                winnerTeamId = minorTeamId;
                promotionRequired = true;
                console.log(`Minor team ${minorTeamId} won! Promotion required.`);
            } else {
                // Try to determine winner by team IDs in the game
                if (after.team1_id === majorTeamId) {
                    if (team1Score > team2Score) {
                        winnerLeague = 'major';
                        winnerTeamId = majorTeamId;
                        promotionRequired = false;
                    } else {
                        winnerLeague = 'minor';
                        winnerTeamId = minorTeamId;
                        promotionRequired = true;
                    }
                } else if (after.team2_id === majorTeamId) {
                    if (team2Score > team1Score) {
                        winnerLeague = 'major';
                        winnerTeamId = majorTeamId;
                        promotionRequired = false;
                    } else {
                        winnerLeague = 'minor';
                        winnerTeamId = minorTeamId;
                        promotionRequired = true;
                    }
                } else {
                    console.error('Could not determine winner from game data');
                    return null;
                }
            }

            // Update relegation document
            await relegationRef.update({
                status: 'completed',
                winner_league: winnerLeague,
                winner_team_id: winnerTeamId,
                promotion_required: promotionRequired,
                game_result: {
                    team1_id: after.team1_id,
                    team1_score: team1Score,
                    team2_id: after.team2_id,
                    team2_score: team2Score,
                    completed_at: FieldValue.serverTimestamp()
                },
                updated_at: FieldValue.serverTimestamp()
            });

            console.log(`Relegation document updated. Winner: ${winnerLeague} (${winnerTeamId}), ` +
                `Promotion required: ${promotionRequired}`);

            return { success: true };

        } catch (error) {
            console.error('Error processing relegation game completion:', error);
            return null;
        }
    }
);

/**
 * Links a scheduled relegation game to the relegation_games document.
 * Called when an exhibition game with week="Relegation" is created or updated to add game_ref.
 */
exports.onRelegationGameScheduled = onDocumentUpdated(
    'seasons/{seasonId}/exhibition_games/{gameId}',
    async (event) => {
        const before = event.data.before.data();
        const after = event.data.after.data();
        const { seasonId, gameId } = event.params;

        // Only process if this is a Relegation game
        if (after.week !== 'Relegation') {
            return null;
        }

        // Only process if the game didn't exist before or week just changed to Relegation
        // This handles the case when a relegation game is created/scheduled
        if (before.week === 'Relegation' && before.date === after.date) {
            return null; // No scheduling change
        }

        console.log(`Relegation game ${gameId} scheduled in ${seasonId}. Updating relegation document...`);

        try {
            const relegationRef = db.collection('relegation_games').doc(seasonId);
            const relegationSnap = await relegationRef.get();

            if (!relegationSnap.exists) {
                console.log(`No relegation_games document found for ${seasonId}. Creating one may be needed.`);
                return null;
            }

            // Update with game reference
            await relegationRef.update({
                status: 'scheduled',
                game_ref: `seasons/${seasonId}/exhibition_games/${gameId}`,
                game_date: after.date || null,
                updated_at: FieldValue.serverTimestamp()
            });

            console.log(`Relegation document updated with game reference: ${gameId}`);
            return { success: true };

        } catch (error) {
            console.error('Error updating relegation game reference:', error);
            return null;
        }
    }
);
