// functions/playoffs/bracket-advancement.js

const admin = require("firebase-admin");
const { LEAGUES } = require('../utils/firebase-helpers');

// Ensure admin is initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

const db = admin.firestore();

/**
 * Core logic for advancing teams in the playoff bracket.
 * This function is now shared between the scheduled job and the on-demand test function.
 * @param {Array<admin.firestore.QueryDocumentSnapshot>} gamesToProcess - An array of game document snapshots to process for advancement.
 * @param {admin.firestore.CollectionReference} postGamesRef - A reference to the postseason games collection.
 * @param {string} league - League context (major or minor)
 */
async function advanceBracket(gamesToProcess, postGamesRef, league = LEAGUES.MAJOR) {
    if (gamesToProcess.length === 0) {
        console.log(`advanceBracket: No games to process for ${league} league.`);
        return;
    }
    console.log(`Processing bracket advancement for ${league} league...`);

    // (advancementRules object remains the same)
    const advancementRules = {
        "W7vW8": { winnerTo: "W2vW7", winnerField: "team2_id", loserTo: "W8thSeedGame", loserField: "team1_id" },
        "E7vE8": { winnerTo: "E2vE7", winnerField: "team2_id", loserTo: "E8thSeedGame", loserField: "team1_id" },
        "W9vW10": { winnerTo: "W8thSeedGame", winnerField: "team2_id" },
        "E9vE10": { winnerTo: "E8thSeedGame", winnerField: "team2_id" },
        "W8thSeedGame": { winnerTo: "W1vW8", winnerField: "team2_id" },
        "E8thSeedGame": { winnerTo: "E1vE8", winnerField: "team2_id" },
        "E1vE8": { winnerTo: "E-R2-T", winnerField: "team1_id" },
        "W1vW8": { winnerTo: "W-R2-T", winnerField: "team1_id" },
        "E4vE5": { winnerTo: "E-R2-T", winnerField: "team2_id" },
        "W4vW5": { winnerTo: "W-R2-T", winnerField: "team2_id" },
        "E2vE7": { winnerTo: "E-R2-B", winnerField: "team2_id" },
        "W2vW7": { winnerTo: "W-R2-B", winnerField: "team2_id" },
        "E3vE6": { winnerTo: "E-R2-B", winnerField: "team1_id" },
        "W3vW6": { winnerTo: "W-R2-B", winnerField: "team1_id" },
        "E-R2-T": { winnerTo: "ECF", winnerField: "team1_id" },
        "W-R2-T": { winnerTo: "WCF", winnerField: "team1_id" },
        "E-R2-B": { winnerTo: "ECF", winnerField: "team2_id" },
        "W-R2-B": { winnerTo: "WCF", winnerField: "team2_id" },
        "ECF": { winnerTo: "Finals", winnerField: "team2_id" },
        "WCF": { winnerTo: "Finals", winnerField: "team1_id" },
    };

    for (const gameDoc of gamesToProcess) {
        const game = gameDoc.data();
        const rule = advancementRules[game.series_id];

        if (!rule) continue;

        // ======================= FIX START =======================
        // For any series that is NOT a Play-In game, we must check if a series_winner
        // exists. If it doesn't, the series isn't over, and we should not advance anyone.
        if (game.week !== 'Play-In' && !game.series_winner) {
            console.log(`Series ${game.series_id} is not yet complete. Deferring advancement.`);
            continue; // Skips to the next game document without processing advancement
        }
        // ======================= FIX END =======================

        const batch = db.batch();
        let shouldCommit = false;

        // The winner to be advanced. For Play-In, this is the game winner.
        // For other rounds, this is the series winner.
        const winnerId = game.series_winner || game.winner;
        const loserId = game.team1_id === winnerId ? game.team2_id : game.team1_id;

        if (rule.winnerTo && winnerId) {
            let winnerSeed = winnerId === game.team1_id ? game.team1_seed : game.team2_seed;

            if (game.series_id === "E7vE8" || game.series_id === "W7vW8") {
                winnerSeed = '7';
            } else if (game.series_id.includes('8thSeedGame')) {
                winnerSeed = '8';
            }

            const winnerSeedField = rule.winnerField.replace('_id', '_seed');
            const winnerNextSeriesSnap = await postGamesRef.where('series_id', '==', rule.winnerTo).get();

            winnerNextSeriesSnap.forEach(doc => {
                batch.update(doc.ref, {
                    [rule.winnerField]: winnerId,
                    [winnerSeedField]: winnerSeed || ''
                });
            });
            console.log(`Advancing winner ${winnerId} (seed ${winnerSeed}) from ${game.series_id} to ${rule.winnerTo}.`);
            shouldCommit = true;
        }

        if (rule.loserTo && loserId) {
            const loserSeed = loserId === game.team1_id ? game.team1_seed : game.team2_seed;
            const loserSeedField = rule.loserField.replace('_id', '_seed');
            const loserNextSeriesSnap = await postGamesRef.where('series_id', '==', rule.loserTo).get();

            loserNextSeriesSnap.forEach(doc => {
                batch.update(doc.ref, {
                    [rule.loserField]: loserId,
                    [loserSeedField]: loserSeed || ''
                });
            });
            console.log(`Moving loser ${loserId} (seed ${loserSeed}) from ${game.series_id} to ${rule.loserTo}.`);
            shouldCommit = true;
        }

        if (game.week !== 'Play-In' && game.series_winner) {
            const incompleteGamesSnap = await postGamesRef.where('series_id', '==', game.series_id).where('completed', '==', 'FALSE').get();
            if (!incompleteGamesSnap.empty) {
                console.log(`Series ${game.series_id} won by ${game.series_winner}. Deleting ${incompleteGamesSnap.size} incomplete games.`);
                incompleteGamesSnap.forEach(doc => batch.delete(doc.ref));
                shouldCommit = true;
            }
        }

        if (shouldCommit) {
            await batch.commit();
        }
    }
}

module.exports = {
    advanceBracket
};
