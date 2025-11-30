// functions/auth/activation.js

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require("../utils/firebase-admin");
const { getUserRole, LEAGUES } = require("../utils/auth-helpers");
const { getCollectionName } = require("../utils/firebase-helpers");

/**
 * Generate a unique activation code
 * @returns {string} A unique activation code in format "XXX-XXX-XXX"
 */
function generateUniqueCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid ambiguous chars (0, O, 1, I)
    const segments = 3;
    const segmentLength = 3;

    const code = Array(segments)
        .fill(null)
        .map(() => {
            return Array(segmentLength)
                .fill(null)
                .map(() => chars[Math.floor(Math.random() * chars.length)])
                .join('');
        })
        .join('-');

    return code;
}

/**
 * Generate an activation code for a team
 * Requires admin role
 */
exports.generateActivationCode = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth) {
        throw new HttpsError('permission-denied', 'Must be authenticated');
    }

    const role = await getUserRole(request.auth);
    if (role !== 'admin') {
        throw new HttpsError('permission-denied', 'Admin access required');
    }

    const { team_id, league, expires_in_days } = request.data;

    if (!team_id) {
        throw new HttpsError('invalid-argument', 'team_id required');
    }

    if (!league || (league !== 'major' && league !== 'minor')) {
        throw new HttpsError('invalid-argument', 'Valid league required (major or minor)');
    }

    // Verify team exists
    const teamsCollectionName = getCollectionName('v2_teams', league);
    const teamDoc = await db.collection(teamsCollectionName).doc(team_id).get();

    if (!teamDoc.exists) {
        throw new HttpsError('not-found', `Team ${team_id} not found in ${league} league`);
    }

    // Generate unique code
    const code = generateUniqueCode();

    // Calculate expiration
    const expiresAt = expires_in_days
        ? admin.firestore.Timestamp.fromDate(
            new Date(Date.now() + expires_in_days * 24 * 60 * 60 * 1000)
        )
        : null;

    // Store code in shared activation_codes collection
    const codesCollectionName = getCollectionName('activation_codes');
    const codeDoc = {
        code: code,
        team_id: team_id,
        league: league,
        created_by: request.auth.uid,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
        expires_at: expiresAt,
        used_by: null,
        used_at: null,
        is_active: true
    };

    await db.collection(codesCollectionName).add(codeDoc);

    return {
        code,
        team_id,
        league,
        expires_at: expiresAt ? expiresAt.toDate().toISOString() : null
    };
});

/**
 * Activate user account with activation code
 * Links user to a team in the specified league
 */
exports.activateUserWithCode = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth) {
        throw new HttpsError('permission-denied', 'Must be authenticated');
    }

    const { code, league } = request.data;

    if (!code) {
        throw new HttpsError('invalid-argument', 'Activation code required');
    }

    if (!league || (league !== 'major' && league !== 'minor')) {
        throw new HttpsError('invalid-argument', 'Valid league required (major or minor)');
    }

    // Find activation code in shared collection
    const codesCollectionName = getCollectionName('activation_codes');
    const codeQuery = await db.collection(codesCollectionName)
        .where('code', '==', code.toUpperCase())
        .where('league', '==', league)
        .where('is_active', '==', true)
        .limit(1)
        .get();

    if (codeQuery.empty) {
        throw new HttpsError('not-found', `Invalid or expired activation code for ${league} league`);
    }

    const codeDocRef = codeQuery.docs[0].ref;
    const codeData = codeQuery.docs[0].data();

    // Check if already used
    if (codeData.used_by) {
        throw new HttpsError('already-exists', 'This activation code has already been used');
    }

    // Check expiration
    if (codeData.expires_at && codeData.expires_at.toDate() < new Date()) {
        throw new HttpsError('deadline-exceeded', 'This activation code has expired');
    }

    const userId = request.auth.uid;
    const teamId = codeData.team_id;

    // Get team from league-specific collection
    const teamsCollectionName = getCollectionName('v2_teams', league);
    const teamRef = db.collection(teamsCollectionName).doc(teamId);
    const teamDoc = await teamRef.get();

    if (!teamDoc.exists) {
        throw new HttpsError('not-found', 'Team not found');
    }

    const batch = db.batch();

    // Update user document in SHARED collection
    const usersCollectionName = getCollectionName('users');
    const userRef = db.collection(usersCollectionName).doc(userId);
    const userSnapshot = await userRef.get();

    const teamIdField = league === 'minor' ? 'minor_team_id' : 'major_team_id';
    const codeField = league === 'minor' ? 'minor_activated_with_code' : 'major_activated_with_code';
    const activatedAtField = league === 'minor' ? 'minor_activated_at' : 'major_activated_at';

    // Prepare user update
    const userUpdate = {
        uid: userId,
        role: 'gm',  // Set role to gm (or preserve existing role if admin/scorekeeper)
        [teamIdField]: teamId,
        [codeField]: code,
        [activatedAtField]: admin.firestore.FieldValue.serverTimestamp(),
        auth_provider: request.auth.token.firebase.sign_in_provider,
        email: request.auth.token.email || request.auth.token.phone_number || userId,
    };

    // Backward compatibility: if activating for major league, also set old team_id field
    if (league === 'major') {
        userUpdate.team_id = teamId;
    }

    // Preserve existing data (don't overwrite role if user is already admin/scorekeeper)
    if (userSnapshot.exists) {
        const existingData = userSnapshot.data();
        if (existingData.role === 'admin' || existingData.role === 'scorekeeper') {
            userUpdate.role = existingData.role;
        }
    }

    batch.set(userRef, userUpdate, { merge: true });

    // Update team document in league-specific collection
    batch.update(teamRef, {
        gm_uid: userId
    });

    // Mark code as used
    batch.update(codeDocRef, {
        used_by: userId,
        used_at: admin.firestore.FieldValue.serverTimestamp()
    });

    await batch.commit();

    return {
        success: true,
        teamName: teamDoc.data().franchise_name || teamDoc.data().team_id,
        teamId: teamId,
        league: league
    };
});

/**
 * Revoke an activation code
 * Requires admin role
 */
exports.revokeActivationCode = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth) {
        throw new HttpsError('permission-denied', 'Must be authenticated');
    }

    const role = await getUserRole(request.auth);
    if (role !== 'admin') {
        throw new HttpsError('permission-denied', 'Admin access required');
    }

    const { code } = request.data;

    if (!code) {
        throw new HttpsError('invalid-argument', 'Activation code required');
    }

    // Find and deactivate code
    const codesCollectionName = getCollectionName('activation_codes');
    const codeQuery = await db.collection(codesCollectionName)
        .where('code', '==', code.toUpperCase())
        .limit(1)
        .get();

    if (codeQuery.empty) {
        throw new HttpsError('not-found', 'Activation code not found');
    }

    const codeDocRef = codeQuery.docs[0].ref;
    await codeDocRef.update({
        is_active: false,
        revoked_by: request.auth.uid,
        revoked_at: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true, code };
});

/**
 * List activation codes
 * Requires admin role
 */
exports.listActivationCodes = onCall({ region: "us-central1" }, async (request) => {
    if (!request.auth) {
        throw new HttpsError('permission-denied', 'Must be authenticated');
    }

    const role = await getUserRole(request.auth);
    if (role !== 'admin') {
        throw new HttpsError('permission-denied', 'Admin access required');
    }

    const { league, include_used } = request.data;

    let query = db.collection(getCollectionName('activation_codes'));

    if (league && (league === 'major' || league === 'minor')) {
        query = query.where('league', '==', league);
    }

    if (!include_used) {
        query = query.where('used_by', '==', null);
    }

    query = query.orderBy('created_at', 'desc').limit(100);

    const snapshot = await query.get();

    const codes = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data(),
        created_at: doc.data().created_at?.toDate().toISOString(),
        used_at: doc.data().used_at?.toDate().toISOString(),
        expires_at: doc.data().expires_at?.toDate().toISOString(),
        revoked_at: doc.data().revoked_at?.toDate().toISOString(),
    }));

    return { codes };
});
