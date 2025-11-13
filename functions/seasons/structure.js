// functions/seasons/structure.js

const { admin, db } = require('../utils/firebase-admin');
const { getCollectionName } = require('../utils/firebase-helpers');

/**
 * Creates the full data structure for a new season including:
 * - Daily averages and scores collections
 * - Postseason collections
 * - Season subcollections (games, lineups, etc.)
 * - Empty seasonal stats for all players
 * - Empty seasonal records for all teams
 *
 * @param {number} seasonNum - The season number
 * @param {FirebaseFirestore.WriteBatch} batch - Firestore batch to add operations to
 * @param {string} activeSeasonId - ID of the current active season (for team name lookup)
 * @param {string} league - League context (major or minor)
 * @returns {FirebaseFirestore.DocumentReference} Reference to the new season document
 */
async function createSeasonStructure(seasonNum, batch, activeSeasonId, league = 'major') {
    const seasonId = `S${seasonNum}`;
    console.log(`Creating structure for season ${seasonId}`);

    batch.set(db.doc(`${getCollectionName('daily_averages', league)}/season_${seasonNum}`), { description: `Daily averages for Season ${seasonNum}` });
    batch.set(db.doc(`${getCollectionName('daily_averages', league)}/season_${seasonNum}/${getCollectionName(`S${seasonNum}_daily_averages`, league)}/placeholder`), {});
    batch.set(db.doc(`${getCollectionName('daily_scores', league)}/season_${seasonNum}`), { description: `Daily scores for Season ${seasonNum}` });
    batch.set(db.doc(`${getCollectionName('daily_scores', league)}/season_${seasonNum}/${getCollectionName(`S${seasonNum}_daily_scores`, league)}/placeholder`), {});

    batch.set(db.doc(`${getCollectionName('post_daily_averages', league)}/season_${seasonNum}`), { description: `Postseason daily averages for Season ${seasonNum}` });
    batch.set(db.doc(`${getCollectionName('post_daily_averages', league)}/season_${seasonNum}/${getCollectionName(`S${seasonNum}_post_daily_averages`, league)}/placeholder`), {});
    batch.set(db.doc(`${getCollectionName('post_daily_scores', league)}/season_${seasonNum}`), { description: `Postseason daily scores for Season ${seasonNum}` });
    batch.set(db.doc(`${getCollectionName('post_daily_scores', league)}/season_${seasonNum}/${getCollectionName(`S${seasonNum}_post_daily_scores`, league)}/placeholder`), {});


    const seasonRef = db.collection(getCollectionName("seasons", league)).doc(seasonId);
    batch.set(seasonRef.collection(getCollectionName("games", league)).doc("placeholder"), {});
    batch.set(seasonRef.collection(getCollectionName("lineups", league)).doc("placeholder"), {});
    batch.set(seasonRef.collection(getCollectionName("post_games", league)).doc("placeholder"), {});
    batch.set(seasonRef.collection(getCollectionName("post_lineups", league)).doc("placeholder"), {});
    batch.set(seasonRef.collection(getCollectionName("exhibition_games", league)).doc("placeholder"), {});
    batch.set(seasonRef.collection(getCollectionName("exhibition_lineups", league)).doc("placeholder"), {});

    const playersSnap = await db.collection(getCollectionName("v2_players", league)).get();
    playersSnap.forEach(playerDoc => {
        const statsRef = playerDoc.ref.collection(getCollectionName("seasonal_stats", league)).doc(seasonId);
        batch.set(statsRef, {
            aag_mean: 0, aag_mean_pct: 0, aag_median: 0, aag_median_pct: 0, games_played: 0, GEM: 0, meansum: 0, medrank: 0, meanrank: 0, medsum: 0,
            post_aag_mean: 0, post_aag_mean_pct: 0, post_aag_median: 0, post_aag_median_pct: 0, post_games_played: 0, post_GEM: 0, post_meansum: 0,
            post_medrank: 0, post_meanrank: 0, post_medsum: 0, post_rel_mean: 0, post_rel_median: 0, post_total_points: 0, post_WAR: 0, rel_mean: 0, rel_median: 0,
            WAR: 0, total_points: 0, t100: 0, t100_pct: 0, post_t100: 0, post_t100_pct: 0, t50: 0, t50_pct: 0, post_t50: 0, post_t50_pct: 0, rookie: '0', all_star: '0'
        });
    });
    console.log(`Prepared empty seasonal_stats for ${playersSnap.size} players.`);

    const teamsSnap = await db.collection(getCollectionName("v2_teams", league)).get();
    for (const teamDoc of teamsSnap.docs) {
        const recordRef = teamDoc.ref.collection(getCollectionName("seasonal_records", league)).doc(seasonId);
        const teamRootData = teamDoc.data();

        const activeRecordRef = teamDoc.ref.collection(getCollectionName("seasonal_records", league)).doc(activeSeasonId);
        const activeRecordSnap = await activeRecordRef.get();
        const teamName = activeRecordSnap.exists ? activeRecordSnap.data().team_name : "Name Not Found";

        batch.set(recordRef, {
            season: seasonId,
            team_id: teamDoc.id,
            apPAM: 0, apPAM_count: 0, apPAM_total: 0, elim: 0, losses: 0, MaxPotWins: 0, med_starter_rank: 0, msr_rank: 0, pam: 0, pam_rank: 0, playin: 0,
            playoffs: 0, post_losses: 0, post_med_starter_rank: 0, post_msr_rank: 0, post_pam: 0, post_pam_rank: 0, post_wins: 0, postseed: 0, sortscore: 0,
            wins: 0, wpct: 0, total_transactions: 0,
            tREL: 0,
            post_tREL: 0,
            team_name: teamName,
            gm_player_id: teamRootData.gm_player_id || null
        });
    }
    console.log(`Prepared empty seasonal_records for ${teamsSnap.size} teams.`);

    return seasonRef;
}

module.exports = {
    createSeasonStructure
};
