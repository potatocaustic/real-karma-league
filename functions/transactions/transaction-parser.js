// functions/transactions/transaction-parser.js
// Automated transaction parser that monitors Real app groups

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { admin, db } = require('../utils/firebase-admin');
const { FieldValue } = require('firebase-admin/firestore');
const { getCollectionName, LEAGUES } = require('../utils/firebase-helpers');

// Import utility modules
const { fetchNewComments, GROUP_IDS, realAuthToken } = require('../utils/real-api-client');
const { parseCommentEnhanced, mightBeTransaction, TRANSACTION_TYPES } = require('../utils/transaction-text-parser');
const { matchTeamName, matchTeamNames, extractPotentialTeamNames } = require('../utils/team-name-matcher');
const { resolvePlayerHandles, validatePlayerMove } = require('../utils/player-handle-resolver');

/**
 * Process a single parsed transaction and enrich with IDs
 * @param {Object} parsedComment - Parsed comment result from parser
 * @returns {Promise<Object>} Enriched transaction ready for storage
 */
async function enrichParsedTransaction(parsedComment) {
    const enrichedTransactions = [];

    for (const transaction of parsedComment.transactions) {
        // Extract team names from transaction
        const teamNames = [];
        if (transaction.teamName) {
            teamNames.push(transaction.teamName);
        }
        if (transaction.teamNames) {
            teamNames.push(...transaction.teamNames);
        }

        // Match teams and determine league
        const teamMatches = await matchTeamNames(teamNames);
        const league = teamMatches.league || LEAGUES.MAJOR;

        // Extract player handles
        const playerHandles = transaction.players?.map(p => p.handle) || [];

        // Resolve player handles to IDs
        const { resolved: resolvedPlayers, unresolved: unresolvedPlayers } =
            await resolvePlayerHandles(playerHandles, league);

        // Build enriched player list
        const enrichedPlayers = [];
        const validationErrors = [];

        for (const playerData of transaction.players || []) {
            const resolvedPlayer = resolvedPlayers.find(
                p => p.handle.toLowerCase() === playerData.handle.toLowerCase()
            );

            if (resolvedPlayer) {
                // Validate the move
                const validation = validatePlayerMove(
                    resolvedPlayer,
                    transaction.type,
                    playerData.to
                );

                if (validation.errors.length > 0) {
                    validationErrors.push(...validation.errors);
                }
                if (validation.warnings.length > 0) {
                    validationErrors.push(...validation.warnings.map(w => `Warning: ${w}`));
                }

                // Match destination team if provided
                let toTeamId = playerData.to;
                if (toTeamId && toTeamId !== 'RETIRED' && toTeamId !== 'FREE_AGENT') {
                    const teamMatch = await matchTeamName(toTeamId, league);
                    if (teamMatch) {
                        toTeamId = teamMatch.teamId;
                    }
                }

                // Match source team if provided
                let fromTeamId = playerData.from || resolvedPlayer.currentTeamId;
                if (fromTeamId && fromTeamId !== 'RETIRED' && fromTeamId !== 'FREE_AGENT') {
                    const fromMatch = await matchTeamName(fromTeamId, league);
                    if (fromMatch) {
                        fromTeamId = fromMatch.teamId;
                    }
                }

                enrichedPlayers.push({
                    id: resolvedPlayer.id,
                    handle: resolvedPlayer.handle,
                    from: fromTeamId,
                    to: toTeamId || (transaction.type === 'RETIREMENT' ? 'RETIRED' :
                        transaction.type === 'CUT' ? 'FREE_AGENT' : null)
                });
            } else {
                validationErrors.push(`Could not find player: ${playerData.handle}`);
                enrichedPlayers.push({
                    id: null,
                    handle: playerData.handle,
                    from: playerData.from || null,
                    to: playerData.to || null
                });
            }
        }

        // Build enriched teams list
        const enrichedTeams = teamMatches.matches.map(m => ({
            id: m.teamId,
            name: m.teamName
        })).filter(t => t.id);

        // Determine confidence level
        let confidence = 'low';
        const hasAllPlayers = unresolvedPlayers.length === 0 && enrichedPlayers.length > 0;
        const hasAllTeams = teamMatches.matches.every(m => m.teamId);
        const noErrors = validationErrors.filter(e => !e.startsWith('Warning:')).length === 0;

        if (hasAllPlayers && hasAllTeams && noErrors) {
            confidence = 'high';
        } else if (hasAllPlayers || hasAllTeams) {
            confidence = 'medium';
        }

        enrichedTransactions.push({
            type: transaction.type,
            players: enrichedPlayers,
            teams: enrichedTeams,
            picks: transaction.picks || [],
            league,
            confidence,
            validationErrors,
            rawLine: transaction.rawLine
        });
    }

    return {
        ...parsedComment,
        transactions: enrichedTransactions,
        confidence: enrichedTransactions.length > 0 ?
            enrichedTransactions.reduce((min, t) =>
                t.confidence === 'low' ? 'low' :
                    t.confidence === 'medium' && min !== 'low' ? 'medium' : min,
                'high'
            ) : 'low'
    };
}

/**
 * Store a parsed transaction for admin review
 * @param {Object} enrichedParsed - Enriched parsed transaction data
 * @returns {Promise<string>} Document ID of stored transaction
 */
async function storeParsedTransaction(enrichedParsed) {
    // Determine collection based on detected league
    const league = enrichedParsed.transactions[0]?.league || LEAGUES.MAJOR;
    const collectionName = league === LEAGUES.MINOR ?
        'minor_parsed_transactions' : 'parsed_transactions';

    // Build document data
    const docData = {
        // Source info
        source_comment_id: enrichedParsed.commentId,
        source_group_id: enrichedParsed.groupId,
        source_author: enrichedParsed.author,
        source_timestamp: enrichedParsed.timestamp ?
            admin.firestore.Timestamp.fromDate(new Date(enrichedParsed.timestamp)) : null,
        raw_text: enrichedParsed.rawText,
        mentions: enrichedParsed.mentions,

        // Parsed data
        transactions: enrichedParsed.transactions,
        confidence: enrichedParsed.confidence,

        // Status
        status: 'pending_review',
        validation_errors: enrichedParsed.transactions.flatMap(t => t.validationErrors || []),

        // Metadata
        created_at: FieldValue.serverTimestamp(),
        league
    };

    const docRef = await db.collection(collectionName).add(docData);
    console.log(`Stored parsed transaction ${docRef.id} in ${collectionName}`);

    return docRef.id;
}

/**
 * Get or create parser state for a group
 * @param {string} groupId - Group ID
 * @returns {Promise<Object>} Parser state
 */
async function getParserState(groupId) {
    const stateDoc = await db.collection('parser_state').doc(groupId).get();

    if (stateDoc.exists) {
        return stateDoc.data();
    }

    return {
        group_id: groupId,
        last_processed_comment_id: null,
        last_processed_timestamp: null,
        last_run_at: null
    };
}

/**
 * Update parser state after processing
 * @param {string} groupId - Group ID
 * @param {string} lastCommentId - Last processed comment ID
 * @param {string} lastTimestamp - Last processed timestamp
 */
async function updateParserState(groupId, lastCommentId, lastTimestamp) {
    await db.collection('parser_state').doc(groupId).set({
        group_id: groupId,
        last_processed_comment_id: lastCommentId,
        last_processed_timestamp: lastTimestamp,
        last_run_at: FieldValue.serverTimestamp()
    }, { merge: true });
}

/**
 * Process comments from a single group
 * @param {string} groupId - Group ID to process
 * @returns {Promise<Object>} Processing result { processed, stored, errors }
 */
async function processGroup(groupId) {
    const state = await getParserState(groupId);

    console.log(`Processing group ${groupId}, last comment: ${state.last_processed_comment_id}`);

    // Fetch new comments since last run
    const comments = await fetchNewComments(groupId, state.last_processed_comment_id);

    if (comments.length === 0) {
        console.log(`No new comments in group ${groupId}`);
        return { processed: 0, stored: 0, errors: [] };
    }

    let processed = 0;
    let stored = 0;
    const errors = [];
    let newestCommentId = null;
    let newestTimestamp = null;

    // Process comments in reverse order (oldest first)
    const orderedComments = [...comments].reverse();

    for (const comment of orderedComments) {
        try {
            // Track newest for state update
            if (!newestCommentId) {
                newestCommentId = comments[0].id; // First in original order is newest
                newestTimestamp = comments[0].createdAt;
            }

            // Quick filter
            if (!mightBeTransaction(comment)) {
                continue;
            }

            // Parse the comment
            const parsed = parseCommentEnhanced(comment);

            if (parsed.hasTransactions && parsed.transactions.length > 0) {
                // Enrich with IDs
                const enriched = await enrichParsedTransaction(parsed);

                // Store for review
                await storeParsedTransaction(enriched);
                stored++;
            }

            processed++;
        } catch (error) {
            console.error(`Error processing comment ${comment.id}:`, error);
            errors.push({ commentId: comment.id, error: error.message });
        }
    }

    // Update state with newest comment
    if (newestCommentId) {
        await updateParserState(groupId, newestCommentId, newestTimestamp);
    }

    console.log(`Group ${groupId}: processed ${processed}, stored ${stored}, errors ${errors.length}`);

    return { processed, stored, errors };
}

/**
 * Main parser function - processes all transaction groups
 * @returns {Promise<Object>} Overall results
 */
async function runTransactionParser() {
    console.log('Starting transaction parser run...');

    const groups = [
        GROUP_IDS.NEWS_CHANNEL,
        GROUP_IDS.MAJOR_CHAT,
        GROUP_IDS.MINOR_CHAT
    ];

    const results = {
        groups: {},
        totalProcessed: 0,
        totalStored: 0,
        totalErrors: 0,
        timestamp: new Date().toISOString()
    };

    for (const groupId of groups) {
        try {
            const groupResult = await processGroup(groupId);
            results.groups[groupId] = groupResult;
            results.totalProcessed += groupResult.processed;
            results.totalStored += groupResult.stored;
            results.totalErrors += groupResult.errors.length;
        } catch (error) {
            console.error(`Error processing group ${groupId}:`, error);
            results.groups[groupId] = {
                processed: 0,
                stored: 0,
                errors: [{ error: error.message }]
            };
            results.totalErrors++;
        }
    }

    console.log(`Transaction parser complete: ${results.totalStored} transactions stored`);

    return results;
}

// ============================================================================
// SCHEDULED FUNCTION
// Runs every 30 minutes from 7 AM to midnight Central Time
// ============================================================================

exports.scheduledTransactionParser = onSchedule({
    schedule: '*/30 7-23 * * *',
    timeZone: 'America/Chicago',
    memory: '512MiB',
    timeoutSeconds: 300,
    secrets: [realAuthToken]
}, async (event) => {
    console.log('Scheduled transaction parser triggered');
    const results = await runTransactionParser();
    console.log('Scheduled run results:', JSON.stringify(results));
    return results;
});

// ============================================================================
// MANUAL TRIGGER FUNCTION
// Callable by admins to run parser on demand
// ============================================================================

exports.admin_triggerTransactionParser = onCall({
    memory: '512MiB',
    timeoutSeconds: 300,
    secrets: [realAuthToken]
}, async (request) => {
    // Check for admin role
    const userId = request.auth?.uid;
    if (!userId) {
        throw new HttpsError('unauthenticated', 'Must be logged in');
    }

    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();

    if (!userData?.role || !['admin', 'commish'].includes(userData.role)) {
        throw new HttpsError('permission-denied', 'Admin access required');
    }

    console.log(`Manual parser trigger by user ${userId}`);

    const results = await runTransactionParser();

    return {
        success: true,
        ...results
    };
});

// ============================================================================
// APPROVE TRANSACTION FUNCTION
// Approves a parsed transaction and submits to transactions collection
// ============================================================================

exports.admin_approveParsedTransaction = onCall({
    memory: '256MiB',
    timeoutSeconds: 60
}, async (request) => {
    const userId = request.auth?.uid;
    if (!userId) {
        throw new HttpsError('unauthenticated', 'Must be logged in');
    }

    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();

    if (!userData?.role || !['admin', 'commish'].includes(userData.role)) {
        throw new HttpsError('permission-denied', 'Admin access required');
    }

    const { parsedTransactionId, league } = request.data;

    if (!parsedTransactionId) {
        throw new HttpsError('invalid-argument', 'parsedTransactionId required');
    }

    const resolvedLeague = league || LEAGUES.MAJOR;
    const parsedCollectionName = resolvedLeague === LEAGUES.MINOR ?
        'minor_parsed_transactions' : 'parsed_transactions';

    // Get the parsed transaction
    const parsedDoc = await db.collection(parsedCollectionName).doc(parsedTransactionId).get();

    if (!parsedDoc.exists) {
        throw new HttpsError('not-found', 'Parsed transaction not found');
    }

    const parsedData = parsedDoc.data();

    if (parsedData.status !== 'pending_review') {
        throw new HttpsError('failed-precondition', `Transaction already ${parsedData.status}`);
    }

    // Process each transaction in the parsed result
    const transactionCollection = getCollectionName('transactions', resolvedLeague);
    const batch = db.batch();
    const createdTransactions = [];

    for (const trans of parsedData.transactions) {
        // Build involved_players array
        const involvedPlayers = trans.players
            .filter(p => p.id)
            .map(p => ({
                id: p.id,
                from: p.from,
                to: p.to
            }));

        // Build involved_teams array - include teams from both trans.teams and player moves
        const teamsFromPlayers = trans.players
            .flatMap(p => [p.from, p.to])
            .filter(t => t && t !== 'RETIRED' && t !== 'FREE_AGENT');
        const teamsFromMatches = trans.teams.map(t => t.id).filter(Boolean);
        const involvedTeams = [...new Set([...teamsFromMatches, ...teamsFromPlayers])];

        // Build involved_picks array
        const involvedPicks = (trans.picks || []).map(pick => ({
            id: pick.id || `pick_${Date.now()}`,
            from: pick.from,
            to: pick.to,
            description: pick.description
        }));

        // Create transaction document
        const transactionData = {
            schema: 'v2',
            type: trans.type,
            involved_players: involvedPlayers,
            involved_teams: involvedTeams,
            involved_picks: involvedPicks,
            date: FieldValue.serverTimestamp(),
            created_at: FieldValue.serverTimestamp(),
            created_by: userId,
            source: 'parsed_transaction',
            source_comment_id: parsedData.source_comment_id
        };

        const newTransRef = db.collection(transactionCollection).doc();
        batch.set(newTransRef, transactionData);
        createdTransactions.push(newTransRef.id);
    }

    // Update parsed transaction status
    batch.update(parsedDoc.ref, {
        status: 'approved',
        reviewed_at: FieldValue.serverTimestamp(),
        reviewed_by: userId,
        created_transaction_ids: createdTransactions
    });

    await batch.commit();

    console.log(`Approved parsed transaction ${parsedTransactionId}, created ${createdTransactions.length} transactions`);

    return {
        success: true,
        parsedTransactionId,
        createdTransactionIds: createdTransactions
    };
});

// ============================================================================
// REJECT TRANSACTION FUNCTION
// Rejects a parsed transaction
// ============================================================================

exports.admin_rejectParsedTransaction = onCall({
    memory: '256MiB',
    timeoutSeconds: 30
}, async (request) => {
    const userId = request.auth?.uid;
    if (!userId) {
        throw new HttpsError('unauthenticated', 'Must be logged in');
    }

    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();

    if (!userData?.role || !['admin', 'commish'].includes(userData.role)) {
        throw new HttpsError('permission-denied', 'Admin access required');
    }

    const { parsedTransactionId, league, reason } = request.data;

    if (!parsedTransactionId) {
        throw new HttpsError('invalid-argument', 'parsedTransactionId required');
    }

    const resolvedLeague = league || LEAGUES.MAJOR;
    const parsedCollectionName = resolvedLeague === LEAGUES.MINOR ?
        'minor_parsed_transactions' : 'parsed_transactions';

    const parsedDoc = await db.collection(parsedCollectionName).doc(parsedTransactionId).get();

    if (!parsedDoc.exists) {
        throw new HttpsError('not-found', 'Parsed transaction not found');
    }

    await parsedDoc.ref.update({
        status: 'rejected',
        reviewed_at: FieldValue.serverTimestamp(),
        reviewed_by: userId,
        rejection_reason: reason || null
    });

    console.log(`Rejected parsed transaction ${parsedTransactionId}`);

    return {
        success: true,
        parsedTransactionId
    };
});

// ============================================================================
// GET PENDING TRANSACTIONS FUNCTION
// Retrieves pending parsed transactions for the admin monitor
// ============================================================================

exports.admin_getPendingParsedTransactions = onCall({
    memory: '256MiB',
    timeoutSeconds: 30
}, async (request) => {
    const userId = request.auth?.uid;
    if (!userId) {
        throw new HttpsError('unauthenticated', 'Must be logged in');
    }

    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();

    if (!userData?.role || !['admin', 'commish', 'scorekeeper'].includes(userData.role)) {
        throw new HttpsError('permission-denied', 'Admin access required');
    }

    const { league, status, limit = 50 } = request.data || {};

    const results = {
        major: [],
        minor: []
    };

    // Fetch from both collections if no league specified
    const leaguesToFetch = league ? [league] : [LEAGUES.MAJOR, LEAGUES.MINOR];

    for (const fetchLeague of leaguesToFetch) {
        const collectionName = fetchLeague === LEAGUES.MINOR ?
            'minor_parsed_transactions' : 'parsed_transactions';

        let query = db.collection(collectionName)
            .orderBy('created_at', 'desc')
            .limit(limit);

        if (status) {
            query = query.where('status', '==', status);
        }

        const snapshot = await query.get();

        const transactions = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            created_at: doc.data().created_at?.toDate?.()?.toISOString() || null,
            source_timestamp: doc.data().source_timestamp?.toDate?.()?.toISOString() || null,
            reviewed_at: doc.data().reviewed_at?.toDate?.()?.toISOString() || null
        }));

        if (fetchLeague === LEAGUES.MINOR) {
            results.minor = transactions;
        } else {
            results.major = transactions;
        }
    }

    return results;
});
