// functions/transactions/transaction-release.js

const { onSchedule } = require("firebase-functions/v2/scheduler");
const { admin, db } = require("../utils/firebase-admin");
const { getCollectionName, LEAGUES } = require('../utils/firebase-helpers');

/**
 * Major League: Scheduled function to release pending transactions
 * Runs daily at 6:20 AM Central Time to process pending transactions
 */
exports.releasePendingTransactions = onSchedule({
    schedule: "20 6 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    console.log("Running scheduled job to release pending transactions.");
    const pendingTransSnap = await db.collection(getCollectionName('pending_transactions')).get();

    if (pendingTransSnap.empty) {
        console.log("No pending transactions to release.");
        return null;
    }

    console.log(`Found ${pendingTransSnap.size} pending transactions to release.`);
    const batch = db.batch();

    for (const doc of pendingTransSnap.docs) {
        const transactionData = doc.data();

        // Create a new document in the main transactions collection
        const newTransactionRef = db.collection(getCollectionName('transactions')).doc();
        batch.set(newTransactionRef, transactionData);

        // Delete the old document from the pending collection
        batch.delete(doc.ref);
    }

    try {
        await batch.commit();
        console.log("Successfully released all pending transactions.");
    } catch (error) {
        console.error("Error releasing pending transactions:", error);
    }

    return null;
});

/**
 * Minor League: Scheduled function to release pending transactions
 * Runs daily at 6:20 AM Central Time to process pending transactions
 */
exports.minor_releasePendingTransactions = onSchedule({
    schedule: "20 6 * * *",
    timeZone: "America/Chicago",
}, async (event) => {
    console.log("Running scheduled job to release pending transactions (Minor League).");
    const pendingTransSnap = await db.collection(getCollectionName('pending_transactions', LEAGUES.MINOR)).get();

    if (pendingTransSnap.empty) {
        console.log("Minor League: No pending transactions to release.");
        return null;
    }

    console.log(`Minor League: Found ${pendingTransSnap.size} pending transactions to release.`);
    const batch = db.batch();

    for (const doc of pendingTransSnap.docs) {
        const transactionData = doc.data();

        // Create a new document in the main transactions collection
        const newTransactionRef = db.collection(getCollectionName('transactions', LEAGUES.MINOR)).doc();
        batch.set(newTransactionRef, transactionData);

        // Delete the old document from the pending collection
        batch.delete(doc.ref);
    }

    try {
        await batch.commit();
        console.log("Minor League: Successfully released all pending transactions.");
    } catch (error) {
        console.error("Minor League: Error releasing pending transactions:", error);
    }

    return null;
});
