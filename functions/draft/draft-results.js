// functions/draft/draft-results.js

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { admin, db } = require("../utils/firebase-admin");
const fetch = require("node-fetch");
const { getCollectionName, LEAGUES } = require('../utils/firebase-helpers');

/**
 * Major League: Processes draft results when a new pick is created
 * Creates or updates player records and seasonal stats
 */
exports.onDraftResultCreate = onDocumentCreated(`draft_results/{seasonDocId}/{resultsCollectionId}/{draftPickId}`, async (event) => {
    const { seasonDocId, resultsCollectionId } = event.params;
    const pickData = event.data.data();
    const { team_id, player_handle, forfeit, season: draftSeason, round, overall } = pickData;

    const API_ENDPOINT_TEMPLATE = process.env.REAL_API_ENDPOINT;

    if (!API_ENDPOINT_TEMPLATE) {
        console.error("FATAL ERROR: REAL_API_ENDPOINT environment variable not set. Aborting function.");
        return null;
    }

    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const seasonMatch = seasonDocId.match(/^season_(\d+)$/);
    const collectionMatch = resultsCollectionId.match(/^S(\d+)_draft_results_dev$/) || resultsCollectionId.match(/^S(\d+)_draft_results$/);
    if (!seasonMatch || !collectionMatch || seasonMatch[1] !== collectionMatch[1]) {
        console.log(`Function triggered on a non-draft path, exiting. Path: ${seasonDocId}/${resultsCollectionId}`);
        return null;
    }

    if (forfeit || !player_handle) {
        console.log(`Pick ${overall} was forfeited or had no player. No action taken.`);
        return null;
    }

    console.log(`Processing draft pick ${overall}: ${player_handle} to team ${team_id} in ${draftSeason} draft.`);

    try {
        const batch = db.batch();
        let playerIdToWrite = null; // This will hold the player's ID to write back to the draft doc

        const activeSeasonQuery = db.collection(getCollectionName("seasons")).where("status", "==", "active").limit(1);
        const [activeSeasonSnap, teamRecordSnap] = await Promise.all([
            activeSeasonQuery.get(),
            db.doc(`${getCollectionName('v2_teams')}/${team_id}/${getCollectionName('seasonal_records')}/${draftSeason}`).get()
        ]);
        const activeSeasonId = activeSeasonSnap.empty ? null : activeSeasonSnap.docs[0].id;
        const teamName = teamRecordSnap.exists ? teamRecordSnap.data().team_name : team_id;

        const getOrdinal = (n) => {
            if (n > 3 && n < 21) return n + 'th';
            switch (n % 10) {
                case 1: return n + "st";
                case 2: return n + "nd";
                case 3: return n + "rd";
                default: return n + "th";
            }
        };
        const bio = `R${round} (${getOrdinal(overall)} overall) selection by ${teamName} in ${draftSeason} draft.`;
        const isCurrentDraft = draftSeason === activeSeasonId;

        const initialStats = {
            aag_mean: 0, aag_mean_pct: 0, aag_median: 0, aag_median_pct: 0, games_played: 0, GEM: 0, meansum: 0, medrank: 0, meanrank: 0, medsum: 0,
            post_aag_mean: 0, post_aag_mean_pct: 0, post_aag_median: 0, post_aag_median_pct: 0, post_games_played: 0, post_GEM: 0, post_meansum: 0,
            post_medrank: 0, post_meanrank: 0, post_medsum: 0, post_rel_mean: 0, post_rel_median: 0, post_total_points: 0, post_WAR: 0, rel_mean: 0, rel_median: 0,
            WAR: 0, t100: 0, t100_pct: 0, post_t100: 0, post_t100_pct: 0, t50: 0, t50_pct: 0, post_t50: 0, post_t50_pct: 0, total_points: 0, all_star: '0'
        };

        if (isCurrentDraft) {
            const randomDelay = Math.floor(Math.random() * 201) + 100;
            await delay(randomDelay);

            console.log(`Current draft (${draftSeason}). Fetching player ID for: ${player_handle}.`);
            let newPlayerId;

            try {
                const apiUrl = API_ENDPOINT_TEMPLATE.replace('{}', encodeURIComponent(player_handle));
                const response = await fetch(apiUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                        'Accept': 'application/json, text/plain, */*'
                    }
                });

                if (response.ok) {
                    const data = await response.json();
                    const userId = data?.user?.id;
                    if (userId) {
                        newPlayerId = userId;
                        console.log(`Successfully fetched ID for ${player_handle}: ${newPlayerId}`);
                    }
                } else {
                    console.warn(`API request failed for ${player_handle} with status: ${response.status}.`);
                }
            } catch (error) {
                console.error(`Error fetching user ID for ${player_handle}:`, error);
            }

            if (!newPlayerId) {
                const sanitizedHandle = player_handle.toLowerCase().replace(/[^a-z0-9]/g, '');
                newPlayerId = `${sanitizedHandle}${draftSeason.replace('S', '')}${overall}`;
                console.warn(`Using fallback generated ID for ${player_handle}: ${newPlayerId}`);
            }

            playerIdToWrite = newPlayerId; // Set the ID to be written back

            const playerRef = db.collection(getCollectionName('v2_players')).doc(newPlayerId);
            const existingPlayerSnap = await playerRef.get();

            if (existingPlayerSnap.exists) {
                console.log(`Player with ID '${newPlayerId}' already exists. Updating their bio and current team.`);
                batch.update(playerRef, {
                    bio: bio,
                    current_team_id: team_id
                });
            } else {
                batch.set(playerRef, {
                    player_handle: player_handle,
                    current_team_id: team_id,
                    player_status: 'ACTIVE',
                    bio: bio
                });

                const seasonStatsRef = playerRef.collection(getCollectionName('seasonal_stats')).doc(draftSeason);
                batch.set(seasonStatsRef, { ...initialStats, rookie: '1' });
            }

        } else { // Historical draft
            const randomDelay = Math.floor(Math.random() * 201) + 100;
            await delay(randomDelay);

            console.log(`Historical draft (${draftSeason}). Fetching player ID for: ${player_handle}.`);
            let newPlayerId;

            try {
                const apiUrl = API_ENDPOINT_TEMPLATE.replace('{}', encodeURIComponent(player_handle));
                const response = await fetch(apiUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                        'Accept': 'application/json, text/plain, */*'
                    }
                });

                if (response.ok) {
                    const data = await response.json();
                    const userId = data?.user?.id;
                    if (userId) {
                        newPlayerId = userId;
                        console.log(`Successfully fetched ID for ${player_handle}: ${newPlayerId}`);
                    }
                } else {
                    console.warn(`API request failed for ${player_handle} with status: ${response.status}.`);
                }
            } catch (error) {
                console.error(`Error fetching user ID for ${player_handle}:`, error);
            }

            if (!newPlayerId) {
                const sanitizedHandle = player_handle.toLowerCase().replace(/[^a-z0-9]/g, '');
                newPlayerId = `${sanitizedHandle}${draftSeason.replace('S', '')}${overall}`;
                console.warn(`Using fallback generated ID for ${player_handle}: ${newPlayerId}`);
            }

            playerIdToWrite = newPlayerId; // Set the ID to be written back

            const playerRef = db.collection(getCollectionName('v2_players')).doc(newPlayerId);
            const existingPlayerSnap = await playerRef.get();

            if (existingPlayerSnap.exists) {
                console.log(`Player with ID '${newPlayerId}' already exists. Updating their bio.`);
                batch.update(playerRef, { bio: bio });
                const seasonStatsRef = playerRef.collection(getCollectionName('seasonal_stats')).doc(draftSeason);
                batch.set(seasonStatsRef, { ...initialStats, rookie: '0' });
            } else {
                console.log(`Player not found. Creating new player for historical draft.`);
                batch.set(playerRef, {
                    player_handle: player_handle,
                    current_team_id: team_id,
                    player_status: 'ACTIVE',
                    bio: bio
                });

                const seasonStatsRef = playerRef.collection(getCollectionName('seasonal_stats')).doc(draftSeason);
                batch.set(seasonStatsRef, { ...initialStats, rookie: '1' });
            }
        }

        // **NEW**: Write the determined player_id back to the draft result document
        if (playerIdToWrite) {
            console.log(`Updating draft result for pick ${overall} with player_id: ${playerIdToWrite}`);
            batch.update(event.data.ref, { player_id: playerIdToWrite });
        }

        await batch.commit();
        console.log(`Successfully processed draft pick for ${player_handle}.`);

    } catch (error) {
        console.error(`Error processing draft pick for ${player_handle}:`, error);
    }
    return null;
});

/**
 * Minor League: Processes draft results when a new pick is created
 * Creates or updates player records and seasonal stats
 */
exports.minor_onDraftResultCreate = onDocumentCreated(`minor_draft_results/{seasonDocId}/{resultsCollectionId}/{draftPickId}`, async (event) => {
    const { seasonDocId, resultsCollectionId } = event.params;
    const pickData = event.data.data();
    const { team_id, player_handle, forfeit, season: draftSeason, round, overall } = pickData;

    const API_ENDPOINT_TEMPLATE = process.env.REAL_API_ENDPOINT;

    if (!API_ENDPOINT_TEMPLATE) {
        console.error("FATAL ERROR: REAL_API_ENDPOINT environment variable not set. Aborting function.");
        return null;
    }

    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const seasonMatch = seasonDocId.match(/^season_(\d+)$/);
    const collectionMatch = resultsCollectionId.match(/^S(\d+)_draft_results_dev$/) || resultsCollectionId.match(/^S(\d+)_draft_results$/);
    if (!seasonMatch || !collectionMatch || seasonMatch[1] !== collectionMatch[1]) {
        console.log(`Minor League: Function triggered on a non-draft path, exiting. Path: ${seasonDocId}/${resultsCollectionId}`);
        return null;
    }

    if (forfeit || !player_handle) {
        console.log(`Minor League: Pick ${overall} was forfeited or had no player. No action taken.`);
        return null;
    }

    console.log(`Minor League: Processing draft pick ${overall}: ${player_handle} to team ${team_id} in ${draftSeason} draft.`);

    try {
        const batch = db.batch();
        let playerIdToWrite = null;

        const activeSeasonQuery = db.collection(getCollectionName("seasons", LEAGUES.MINOR)).where("status", "==", "active").limit(1);
        const [activeSeasonSnap, teamRecordSnap] = await Promise.all([
            activeSeasonQuery.get(),
            db.doc(`${getCollectionName('v2_teams', LEAGUES.MINOR)}/${team_id}/${getCollectionName('seasonal_records', LEAGUES.MINOR)}/${draftSeason}`).get()
        ]);
        const activeSeasonId = activeSeasonSnap.empty ? null : activeSeasonSnap.docs[0].id;
        const teamName = teamRecordSnap.exists ? teamRecordSnap.data().team_name : team_id;

        const getOrdinal = (n) => {
            if (n > 3 && n < 21) return n + 'th';
            switch (n % 10) {
                case 1: return n + "st";
                case 2: return n + "nd";
                case 3: return n + "rd";
                default: return n + "th";
            }
        };
        const bio = `R${round} (${getOrdinal(overall)} overall) selection by ${teamName} in ${draftSeason} draft.`;
        const isCurrentDraft = draftSeason === activeSeasonId;

        const initialStats = {
            aag_mean: 0, aag_mean_pct: 0, aag_median: 0, aag_median_pct: 0, games_played: 0, GEM: 0, meansum: 0, medrank: 0, meanrank: 0, medsum: 0,
            post_aag_mean: 0, post_aag_mean_pct: 0, post_aag_median: 0, post_aag_median_pct: 0, post_games_played: 0, post_GEM: 0, post_meansum: 0,
            post_medrank: 0, post_meanrank: 0, post_medsum: 0, post_rel_mean: 0, post_rel_median: 0, post_total_points: 0, post_WAR: 0, rel_mean: 0, rel_median: 0,
            WAR: 0, t100: 0, t100_pct: 0, post_t100: 0, post_t100_pct: 0, t50: 0, t50_pct: 0, post_t50: 0, post_t50_pct: 0, total_points: 0, all_star: '0'
        };

        if (isCurrentDraft) {
            const randomDelay = Math.floor(Math.random() * 201) + 100;
            await delay(randomDelay);

            console.log(`Minor League: Current draft (${draftSeason}). Fetching player ID for: ${player_handle}.`);
            let newPlayerId;

            try {
                const apiUrl = API_ENDPOINT_TEMPLATE.replace('{}', encodeURIComponent(player_handle));
                const response = await fetch(apiUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
                        'Accept': 'application/json, text/plain, */*'
                    }
                });

                if (response.ok) {
                    const data = await response.json();
                    const userId = data?.user?.id;
                    if (userId) {
                        newPlayerId = userId;
                        console.log(`Minor League: Successfully fetched ID for ${player_handle}: ${newPlayerId}`);
                    }
                } else {
                    console.warn(`Minor League: API request failed for ${player_handle} with status: ${response.status}.`);
                }
            } catch (error) {
                console.error(`Minor League: Error fetching user ID for ${player_handle}:`, error);
            }

            if (!newPlayerId) {
                const sanitizedHandle = player_handle.toLowerCase().replace(/[^a-z0-9]/g, '');
                newPlayerId = `${sanitizedHandle}${draftSeason.replace('S', '')}${overall}`;
                console.warn(`Minor League: Using fallback generated ID for ${player_handle}: ${newPlayerId}`);
            }

            playerIdToWrite = newPlayerId;

            const playerRef = db.collection(getCollectionName('v2_players', LEAGUES.MINOR)).doc(newPlayerId);
            const existingPlayerSnap = await playerRef.get();

            if (existingPlayerSnap.exists) {
                console.log(`Minor League: Player with ID '${newPlayerId}' already exists. Updating their bio and current team.`);
                batch.update(playerRef, {
                    bio: bio,
                    current_team_id: team_id
                });
            } else {
                batch.set(playerRef, {
                    player_handle: player_handle,
                    current_team_id: team_id,
                    player_status: 'ACTIVE',
                    bio: bio
                });

                const seasonStatsRef = playerRef.collection(getCollectionName('seasonal_stats', LEAGUES.MINOR)).doc(draftSeason);
                batch.set(seasonStatsRef, { ...initialStats, rookie: '1' });
            }

        } else {
            console.log(`Minor League: Historical draft (${draftSeason}). Checking for existing player: ${player_handle}.`);
            const existingPlayerQuery = db.collection(getCollectionName('v2_players', LEAGUES.MINOR)).where('player_handle', '==', player_handle).limit(1);
            const existingPlayerSnap = await existingPlayerQuery.get();

            if (existingPlayerSnap.empty) {
                console.log(`Minor League: Player not found. Creating new player for historical draft.`);
                const sanitizedHandle = player_handle.toLowerCase().replace(/[^a-z0-9]/g, '');
                const newPlayerId = `${sanitizedHandle}${draftSeason.replace('S', '')}${overall}`;
                playerIdToWrite = newPlayerId;
                const playerRef = db.collection(getCollectionName('v2_players', LEAGUES.MINOR)).doc(newPlayerId);

                batch.set(playerRef, {
                    player_handle: player_handle,
                    current_team_id: team_id,
                    player_status: 'ACTIVE',
                    bio: bio
                });

                const seasonStatsRef = playerRef.collection(getCollectionName('seasonal_stats', LEAGUES.MINOR)).doc(draftSeason);
                batch.set(seasonStatsRef, { ...initialStats, rookie: '1' });
            } else {
                console.log(`Minor League: Existing player found. Updating bio only.`);
                const playerDoc = existingPlayerSnap.docs[0];
                playerIdToWrite = playerDoc.id;
                const playerRef = playerDoc.ref;
                batch.update(playerRef, { bio: bio });
                const seasonStatsRef = playerRef.collection(getCollectionName('seasonal_stats', LEAGUES.MINOR)).doc(draftSeason);
                batch.set(seasonStatsRef, { ...initialStats, rookie: '0' });
            }
        }

        if (playerIdToWrite) {
            console.log(`Minor League: Updating draft result for pick ${overall} with player_id: ${playerIdToWrite}`);
            batch.update(event.data.ref, { player_id: playerIdToWrite });
        }

        await batch.commit();
        console.log(`Minor League: Successfully processed draft pick for ${player_handle}.`);

    } catch (error) {
        console.error(`Minor League: Error processing draft pick for ${player_handle}:`, error);
    }
    return null;
});
