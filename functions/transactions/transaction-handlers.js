// functions/transactions/transaction-handlers.js

const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { admin, db } = require("../utils/firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const { getCollectionName, LEAGUES } = require('../utils/firebase-helpers');
const { addFreeAgentInternal, removeFreeAgentInternal } = require('../free-agents');

/**
 * Major League: Handles transaction creation and processing
 * Triggers when a new document is created in the transactions collection
 */
exports.onTransactionCreate_V2 = onDocumentCreated(`transactions/{transactionId}`, async (event) => {
    const transaction = event.data.data();
    const transactionId = event.params.transactionId;

    if (transaction.schema !== 'v2') {
        console.log(`V2: Ignoring transaction ${transactionId} without v2 schema.`);
        return null;
    }

    console.log(`V2: Processing transaction ${transactionId} of type ${transaction.type}.`);

    try {
        const batch = db.batch();

        const activeSeasonQuery = db.collection(getCollectionName('seasons')).where('status', '==', 'active').limit(1);
        const activeSeasonSnap = await activeSeasonQuery.get();

        if (activeSeasonSnap.empty) {
            throw new Error('No active season found. Cannot process transaction.');
        }

        const activeSeasonDoc = activeSeasonSnap.docs[0];
        const activeSeasonId = activeSeasonDoc.id;
        const currentWeek = activeSeasonDoc.data().current_week || null;

        const involvedPlayers = transaction.involved_players || [];
        const involvedPicks = transaction.involved_picks || [];
        const involvedTeams = transaction.involved_teams || [];

        const playerIds = involvedPlayers.map(p => p.id);
        const teamIds = involvedTeams;

        const playerDocsPromises = playerIds.map(id => db.collection(getCollectionName('v2_players')).doc(id).get());
        const teamRecordDocsPromises = teamIds.map(id => {
            if (id === 'RETIRED' || id === 'FREE_AGENT') return Promise.resolve(null);
            return db.collection(getCollectionName('v2_teams')).doc(id).collection(getCollectionName('seasonal_records')).doc(activeSeasonId).get()
        });


        const [playerDocsSnap, teamRecordsDocsSnap] = await Promise.all([
            Promise.all(playerDocsPromises),
            Promise.all(teamRecordDocsPromises),
        ]);

        const playerHandlesMap = new Map(playerDocsSnap.map(doc => [doc.id, doc.data()?.player_handle]));
        const teamNamesMap = new Map(teamRecordsDocsSnap.filter(Boolean).map(doc => [doc.ref.parent.parent.id, doc.data()?.team_name]));


        for (const playerMove of involvedPlayers) {
            const playerRef = db.collection(getCollectionName('v2_players')).doc(playerMove.id);
            const newTeamId = playerMove.to;
            let updateData = {};

            switch (transaction.type) {
                case 'RETIREMENT':
                    updateData = {
                        current_team_id: 'RETIRED',
                        player_status: 'RETIRED'
                    };
                    break;
                case 'UNRETIREMENT':
                    updateData = {
                        current_team_id: newTeamId,
                        player_status: 'ACTIVE'
                    };
                    break;
                default:
                    updateData = {
                        current_team_id: newTeamId
                    };
                    break;
            }

            batch.update(playerRef, updateData);
        }

        for (const pickMove of involvedPicks) {
            const pickRef = db.collection(getCollectionName('draftPicks')).doc(pickMove.id);
            const newOwnerId = pickMove.to;
            batch.update(pickRef, { current_owner: newOwnerId });
        }

        // Remove involved players/picks from trade blocks
        const involvedPlayerIds = involvedPlayers.map(p => p.id);
        const involvedPickIds = involvedPicks.map(p => p.id);

        if (involvedPlayerIds.length > 0 || involvedPickIds.length > 0) {
            const tradeBlocksSnap = await db.collection('tradeblocks').get();

            tradeBlocksSnap.forEach(blockDoc => {
                const blockData = blockDoc.data();
                let needsUpdate = false;

                // Filter out involved players
                const updatedPlayers = (blockData.on_the_block || []).filter(player => {
                    if (involvedPlayerIds.includes(player.id)) {
                        needsUpdate = true;
                        return false;
                    }
                    return true;
                });

                // Filter out involved picks
                const updatedPicks = (blockData.picks_available_ids || []).filter(pick => {
                    if (involvedPickIds.includes(pick.id)) {
                        needsUpdate = true;
                        return false;
                    }
                    return true;
                });

                // Only update if something was removed
                if (needsUpdate) {
                    batch.update(blockDoc.ref, {
                        on_the_block: updatedPlayers,
                        picks_available_ids: updatedPicks
                    });
                    console.log(`Removed ${involvedPlayerIds.length} player(s) and ${involvedPickIds.length} pick(s) from trade block ${blockDoc.id}`);
                }
            });
        }

        const enhancedInvolvedPlayers = involvedPlayers.map(p => ({
            ...p,
            player_handle: playerHandlesMap.get(p.id) || 'Unknown'
        }));
        const enhancedInvolvedTeams = involvedTeams.map(id => ({
            id: id,
            team_name: teamNamesMap.get(id) || 'Unknown'
        }));

        const newTransactionData = {
            ...transaction,
            involved_players: enhancedInvolvedPlayers,
            involved_teams: enhancedInvolvedTeams,
            season: activeSeasonId,
            week: currentWeek,
            status: 'PROCESSED',
            processed_at: FieldValue.serverTimestamp()
        };

        const seasonTransactionsRef = db.collection(getCollectionName('transactions')).doc('seasons').collection(activeSeasonId);
        const newTransactionRef = seasonTransactionsRef.doc(transactionId);
        batch.set(newTransactionRef, newTransactionData);

        const originalTransactionRef = event.data.ref;
        batch.delete(originalTransactionRef);

        await batch.commit();

        // Handle free agent pool updates after batch commit
        for (const playerMove of involvedPlayers) {
            const playerHandle = playerHandlesMap.get(playerMove.id) || 'Unknown';

            // If player is being cut (moved to FREE_AGENT), add to free_agents collection
            if (playerMove.to === 'FREE_AGENT' && transaction.type === 'CUT') {
                await addFreeAgentInternal(playerMove.id, playerHandle, LEAGUES.MAJOR);
                console.log(`Added ${playerHandle} to free_agents collection after CUT transaction.`);
            }

            // If player is being signed (moved from FREE_AGENT to a team), remove from free_agents
            if (transaction.type === 'SIGN' && playerMove.to !== 'FREE_AGENT' && playerMove.to !== 'RETIRED') {
                await removeFreeAgentInternal(playerMove.id, LEAGUES.MAJOR);
                console.log(`Removed ${playerHandle} from free_agents collection after SIGN transaction.`);
            }
        }

        console.log(`V2 Transaction ${transactionId} processed successfully and moved to season ${activeSeasonId}.`);

    } catch (error) {
        console.error(`Error processing V2 transaction ${transactionId}:`, error);
        await event.data.ref.update({ status: 'FAILED', error: error.message });
    }
    return null;
});

/**
 * Minor League: Handles transaction creation and processing
 * Triggers when a new document is created in the minor_transactions collection
 */
exports.minor_onTransactionCreate_V2 = onDocumentCreated(`minor_transactions/{transactionId}`, async (event) => {
    const transaction = event.data.data();
    const transactionId = event.params.transactionId;

    if (transaction.schema !== 'v2') {
        console.log(`Minor League V2: Ignoring transaction ${transactionId} without v2 schema.`);
        return null;
    }

    console.log(`Minor League V2: Processing transaction ${transactionId} of type ${transaction.type}.`);

    try {
        const batch = db.batch();

        const activeSeasonQuery = db.collection(getCollectionName('seasons', LEAGUES.MINOR)).where('status', '==', 'active').limit(1);
        const activeSeasonSnap = await activeSeasonQuery.get();

        if (activeSeasonSnap.empty) {
            throw new Error('No active season found. Cannot process transaction.');
        }

        const activeSeasonDoc = activeSeasonSnap.docs[0];
        const activeSeasonId = activeSeasonDoc.id;
        const currentWeek = activeSeasonDoc.data().current_week || null;

        const involvedPlayers = transaction.involved_players || [];
        const involvedPicks = transaction.involved_picks || [];
        const involvedTeams = transaction.involved_teams || [];

        const playerIds = involvedPlayers.map(p => p.id);
        const teamIds = involvedTeams;

        const playerDocsPromises = playerIds.map(id => db.collection(getCollectionName('v2_players', LEAGUES.MINOR)).doc(id).get());
        const teamRecordDocsPromises = teamIds.map(id => {
            if (id === 'RETIRED' || id === 'FREE_AGENT') return Promise.resolve(null);
            return db.collection(getCollectionName('v2_teams', LEAGUES.MINOR)).doc(id).collection(getCollectionName('seasonal_records', LEAGUES.MINOR)).doc(activeSeasonId).get()
        });


        const [playerDocsSnap, teamRecordsDocsSnap] = await Promise.all([
            Promise.all(playerDocsPromises),
            Promise.all(teamRecordDocsPromises),
        ]);

        const playerHandlesMap = new Map(playerDocsSnap.map(doc => [doc.id, doc.data()?.player_handle]));
        const teamNamesMap = new Map(teamRecordsDocsSnap.filter(Boolean).map(doc => [doc.ref.parent.parent.id, doc.data()?.team_name]));


        for (const playerMove of involvedPlayers) {
            const playerRef = db.collection(getCollectionName('v2_players', LEAGUES.MINOR)).doc(playerMove.id);
            const newTeamId = playerMove.to;
            let updateData = {};

            switch (transaction.type) {
                case 'RETIREMENT':
                    updateData = {
                        current_team_id: 'RETIRED',
                        player_status: 'RETIRED'
                    };
                    break;
                case 'UNRETIREMENT':
                    updateData = {
                        current_team_id: newTeamId,
                        player_status: 'ACTIVE'
                    };
                    break;
                default:
                    updateData = {
                        current_team_id: newTeamId
                    };
                    break;
            }

            batch.update(playerRef, updateData);
        }

        for (const pickMove of involvedPicks) {
            const pickRef = db.collection(getCollectionName('draftPicks', LEAGUES.MINOR)).doc(pickMove.id);
            const newOwnerId = pickMove.to;
            batch.update(pickRef, { current_owner: newOwnerId });
        }

        // Remove involved players/picks from trade blocks
        const involvedPlayerIds = involvedPlayers.map(p => p.id);
        const involvedPickIds = involvedPicks.map(p => p.id);

        if (involvedPlayerIds.length > 0 || involvedPickIds.length > 0) {
            const tradeBlocksSnap = await db.collection('minor_tradeblocks').get();

            tradeBlocksSnap.forEach(blockDoc => {
                const blockData = blockDoc.data();
                let needsUpdate = false;

                // Filter out involved players
                const updatedPlayers = (blockData.on_the_block || []).filter(player => {
                    if (involvedPlayerIds.includes(player.id)) {
                        needsUpdate = true;
                        return false;
                    }
                    return true;
                });

                // Filter out involved picks
                const updatedPicks = (blockData.picks_available_ids || []).filter(pick => {
                    if (involvedPickIds.includes(pick.id)) {
                        needsUpdate = true;
                        return false;
                    }
                    return true;
                });

                // Only update if something was removed
                if (needsUpdate) {
                    batch.update(blockDoc.ref, {
                        on_the_block: updatedPlayers,
                        picks_available_ids: updatedPicks
                    });
                    console.log(`Minor League: Removed ${involvedPlayerIds.length} player(s) and ${involvedPickIds.length} pick(s) from trade block ${blockDoc.id}`);
                }
            });
        }

        const enhancedInvolvedPlayers = involvedPlayers.map(p => ({
            ...p,
            player_handle: playerHandlesMap.get(p.id) || 'Unknown'
        }));
        const enhancedInvolvedTeams = involvedTeams.map(id => ({
            id: id,
            team_name: teamNamesMap.get(id) || 'Unknown'
        }));

        const newTransactionData = {
            ...transaction,
            involved_players: enhancedInvolvedPlayers,
            involved_teams: enhancedInvolvedTeams,
            season: activeSeasonId,
            week: currentWeek,
            status: 'PROCESSED',
            processed_at: FieldValue.serverTimestamp()
        };

        const seasonTransactionsRef = db.collection(getCollectionName('transactions', LEAGUES.MINOR)).doc('seasons').collection(activeSeasonId);
        const newTransactionRef = seasonTransactionsRef.doc(transactionId);
        batch.set(newTransactionRef, newTransactionData);

        const originalTransactionRef = event.data.ref;
        batch.delete(originalTransactionRef);

        await batch.commit();

        // Handle free agent pool updates after batch commit
        for (const playerMove of involvedPlayers) {
            const playerHandle = playerHandlesMap.get(playerMove.id) || 'Unknown';

            // If player is being cut (moved to FREE_AGENT), add to free_agents collection
            if (playerMove.to === 'FREE_AGENT' && transaction.type === 'CUT') {
                await addFreeAgentInternal(playerMove.id, playerHandle, LEAGUES.MINOR);
                console.log(`[Minor] Added ${playerHandle} to free_agents collection after CUT transaction.`);
            }

            // If player is being signed (moved from FREE_AGENT to a team), remove from free_agents
            if (transaction.type === 'SIGN' && playerMove.to !== 'FREE_AGENT' && playerMove.to !== 'RETIRED') {
                await removeFreeAgentInternal(playerMove.id, LEAGUES.MINOR);
                console.log(`[Minor] Removed ${playerHandle} from free_agents collection after SIGN transaction.`);
            }
        }

        console.log(`Minor League V2 Transaction ${transactionId} processed successfully and moved to season ${activeSeasonId}.`);

    } catch (error) {
        console.error(`Minor League: Error processing V2 transaction ${transactionId}:`, error);
        await event.data.ref.update({ status: 'FAILED', error: error.message });
    }
    return null;
});

/**
 * Major League: Updates transaction counts when a transaction is created
 * Increments season-wide and team-specific transaction counters
 */
exports.onTransactionUpdate_V2 = onDocumentCreated(`transactions/{transactionId}`, async (event) => {
    const transaction = event.data.data();
    if (transaction.schema !== 'v2') {
        console.log(`V2: Ignoring transaction count update for ${event.params.transactionId} without v2 schema.`);
        return null;
    }

    const transactionId = event.params.transactionId;

    const activeSeasonQuery = db.collection(getCollectionName("seasons")).where("status", "==", "active").limit(1);
    const activeSeasonSnap = await activeSeasonQuery.get();

    if (activeSeasonSnap.empty) {
        console.error("Could not find an active season. Cannot update transaction counts.");
        return null;
    }
    const seasonId = activeSeasonSnap.docs[0].id;

    console.log(`V2: Updating transaction counts for transaction ${transactionId} in season ${seasonId}`);

    const involvedTeams = new Set(transaction.involved_teams || []);
    if (involvedTeams.size === 0) {
        console.log("No teams involved. Skipping transaction count update.");
        return null;
    }

    const batch = db.batch();
    const seasonRef = db.collection(getCollectionName('seasons')).doc(seasonId);

    batch.update(seasonRef, { season_trans: FieldValue.increment(1) });

    for (const teamId of involvedTeams) {
        const teamStatsRef = db.collection(getCollectionName('v2_teams')).doc(teamId).collection(getCollectionName('seasonal_records')).doc(seasonId);
        batch.update(teamStatsRef, { total_transactions: FieldValue.increment(1) });
    }

    await batch.commit();
    console.log(`Successfully updated transaction counts for teams: ${[...involvedTeams].join(', ')}`);

    return null;
});

/**
 * Minor League: Updates transaction counts when a transaction is created
 * Increments season-wide and team-specific transaction counters
 */
exports.minor_onTransactionUpdate_V2 = onDocumentCreated(`minor_transactions/{transactionId}`, async (event) => {
    const transaction = event.data.data();
    if (transaction.schema !== 'v2') {
        console.log(`Minor League V2: Ignoring transaction count update for ${event.params.transactionId} without v2 schema.`);
        return null;
    }

    const transactionId = event.params.transactionId;

    const activeSeasonQuery = db.collection(getCollectionName("seasons", LEAGUES.MINOR)).where("status", "==", "active").limit(1);
    const activeSeasonSnap = await activeSeasonQuery.get();

    if (activeSeasonSnap.empty) {
        console.error("Minor League: Could not find an active season. Cannot update transaction counts.");
        return null;
    }
    const seasonId = activeSeasonSnap.docs[0].id;

    console.log(`Minor League V2: Updating transaction counts for transaction ${transactionId} in season ${seasonId}`);

    const involvedTeams = new Set(transaction.involved_teams || []);
    if (involvedTeams.size === 0) {
        console.log("Minor League: No teams involved. Skipping transaction count update.");
        return null;
    }

    const batch = db.batch();
    const seasonRef = db.collection(getCollectionName('seasons', LEAGUES.MINOR)).doc(seasonId);

    batch.update(seasonRef, { season_trans: FieldValue.increment(1) });

    for (const teamId of involvedTeams) {
        const teamStatsRef = db.collection(getCollectionName('v2_teams', LEAGUES.MINOR)).doc(teamId).collection(getCollectionName('seasonal_records', LEAGUES.MINOR)).doc(seasonId);
        batch.update(teamStatsRef, { total_transactions: FieldValue.increment(1) });
    }

    await batch.commit();
    console.log(`Minor League: Successfully updated transaction counts for teams: ${[...involvedTeams].join(', ')}`);

    return null;
});
