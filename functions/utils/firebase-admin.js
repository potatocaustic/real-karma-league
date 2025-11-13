// functions/utils/firebase-admin.js
// Centralized Firebase Admin initialization
// This ensures admin.initializeApp() is only called once

const admin = require("firebase-admin");

// Initialize the app only if it hasn't been initialized yet
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

module.exports = { admin, db };
