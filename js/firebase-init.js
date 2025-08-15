// /js/firebase-init.js

// MODIFIED: The hardcoded flag is removed from here.
// The script will now determine the environment dynamically.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut, signInAnonymously, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";
import {
    getFirestore,
    collection,
    doc,
    getDoc,
    getDocs,
    query,
    where,
    limit,
    orderBy,
    setDoc,
    deleteDoc,
    serverTimestamp,
    addDoc,
    updateDoc,
    writeBatch,
    arrayUnion,
    onSnapshot,
    connectFirestoreEmulator,
    collectionGroup,
    documentId,
    Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-functions.js";

// ===================================================================
// DYNAMIC ENVIRONMENT CONFIGURATION
// ===================================================================
// 1. Check for a page-specific configuration object.
const pageConfig = window.firebasePageConfig || {};

// 2. Determine the environment. Default to DEVELOPMENT unless the page
// explicitly requests production collections.
const IS_DEVELOPMENT = !pageConfig.useProdCollections;

// 3. Log the environment for easy debugging.
console.log(`Firebase is running in ${IS_DEVELOPMENT ? 'DEVELOPMENT' : 'PRODUCTION'} mode for this page.`);
// ===================================================================

const firebaseConfig = {
    apiKey: "AIzaSyDch0dQ1c9_mDzANAvfMoK1HAnMrRl1WnY",
    authDomain: "real-karma-league.firebaseapp.com",
    projectId: "real-karma-league",
    storageBucket: "real-karma-league.firebasestorage.app",
    messagingSenderId: "158995195520",
    appId: "1:158995195520:web:0e12dd5095595c0a42e865",
    measurementId: "G-E8LNVNG5M1"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, 'us-central1');

export const collectionNames = {
    seasons: IS_DEVELOPMENT ? 'seasons_dev' : 'seasons',
    users: IS_DEVELOPMENT ? 'users_dev' : 'users',
    settings: 'settings',
    teams: IS_DEVELOPMENT ? 'v2_teams_dev' : 'v2_teams',
    players: IS_DEVELOPMENT ? 'v2_players_dev' : 'v2_players',
    draftPicks: IS_DEVELOPMENT ? 'draftPicks_dev' : 'draftPicks',
    seasonalStats: IS_DEVELOPMENT ? 'seasonal_stats_dev' : 'seasonal_stats',
    seasonalRecords: IS_DEVELOPMENT ? 'seasonal_records_dev' : 'seasonal_records',
    tradeblocks: 'tradeblocks'
};

const isLocal = window.location.hostname.includes("localhost") || window.location.hostname.includes("127.0.0.1");
if (isLocal) {
    console.log("Connecting to local Firebase emulators...");
    connectAuthEmulator(auth, "http://127.0.0.1:9099");
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    connectFunctionsEmulator(functions, "127.0.0.1", 5001);
}

export {
    onAuthStateChanged,
    signOut,
    collection,
    doc,
    getDoc,
    getDocs,
    query,
    where,
    limit,
    orderBy,
    httpsCallable,
    setDoc,
    deleteDoc,
    serverTimestamp,
    addDoc,
    updateDoc,
    writeBatch,
    arrayUnion,
    onSnapshot,
    collectionGroup,
    documentId,
    Timestamp
};