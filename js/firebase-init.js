// /js/firebase-init.js


import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";
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
    startAfter,
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
    Timestamp,
    increment
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

// ===================================================================
// LEAGUE CONTEXT MANAGEMENT
// ===================================================================
// League context - initialize from URL parameter, then localStorage, then default to major league
const LEAGUE_STORAGE_KEY = 'rkl_current_league';

function getInitialLeague() {
    // Check URL parameter first
    const urlParams = new URLSearchParams(window.location.search);
    const leagueParam = urlParams.get('league');
    if (leagueParam === 'major' || leagueParam === 'minor') {
        // Save to localStorage so it persists across navigation
        localStorage.setItem(LEAGUE_STORAGE_KEY, leagueParam);
        return leagueParam;
    }

    // Fall back to localStorage
    const storedLeague = localStorage.getItem(LEAGUE_STORAGE_KEY);
    if (storedLeague === 'major' || storedLeague === 'minor') {
        return storedLeague;
    }

    // Default to major league
    return 'major';
}

let currentLeague = getInitialLeague();

// Get current league
export function getCurrentLeague() {
    return currentLeague;
}

// Set current league
export function setCurrentLeague(league) {
    if (league !== 'major' && league !== 'minor') {
        console.error('Invalid league:', league);
        return;
    }
    currentLeague = league;

    // Persist to localStorage
    localStorage.setItem(LEAGUE_STORAGE_KEY, league);

    console.log('League context switched to:', league);

    // Dispatch custom event for components to react to league change
    window.dispatchEvent(new CustomEvent('leagueChanged', { detail: { league } }));
}

// Get collection name with league context
export function getLeagueCollectionName(baseName, league = null) {
    const targetLeague = league || currentLeague;

    // Shared collections (no prefix)
    const sharedCollections = ['users', 'notifications', 'scorekeeper_activity_log', 'settings', 'tradeblocks'];
    if (sharedCollections.includes(baseName)) {
        return IS_DEVELOPMENT ? `${baseName}_dev` : baseName;
    }

    // Structured collections (no prefix, handled internally)
    const structuredCollections = ['daily_averages', 'daily_scores', 'post_daily_averages',
                                   'post_daily_scores', 'leaderboards', 'post_leaderboards',
                                   'awards', 'draft_results'];
    if (structuredCollections.includes(baseName)) {
        return IS_DEVELOPMENT ? `${baseName}_dev` : baseName;
    }

    // League-specific collections
    const leaguePrefix = targetLeague === 'minor' ? 'minor_' : '';
    const devSuffix = IS_DEVELOPMENT ? '_dev' : '';
    return `${leaguePrefix}${baseName}${devSuffix}`;
}

// Get conference names based on league type
export function getConferenceNames(league = null) {
    const targetLeague = league || currentLeague;
    return targetLeague === 'minor'
        ? { primary: 'Northern', secondary: 'Southern' }
        : { primary: 'Eastern', secondary: 'Western' };
}

// Get short conference names based on league type
export function getShortConferenceNames(league = null) {
    const targetLeague = league || currentLeague;
    return targetLeague === 'minor'
        ? { primary: 'North', secondary: 'South' }
        : { primary: 'East', secondary: 'West' };
}
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

// Updated to use getters for dynamic league-aware collection names
export const collectionNames = {
    get seasons() { return getLeagueCollectionName('seasons'); },
    get users() { return getLeagueCollectionName('users'); },
    get settings() { return getLeagueCollectionName('settings'); },
    get teams() { return getLeagueCollectionName('v2_teams'); },
    get players() { return getLeagueCollectionName('v2_players'); },
    get draftPicks() { return getLeagueCollectionName('draftPicks'); },
    get seasonalStats() { return getLeagueCollectionName('seasonal_stats'); },
    get seasonalRecords() { return getLeagueCollectionName('seasonal_records'); },
    get tradeblocks() { return getLeagueCollectionName('tradeblocks'); },
    get liveGames() { return getLeagueCollectionName('live_games'); },
    get lineupDeadlines() { return getLeagueCollectionName('lineup_deadlines'); },
    get transactions() { return getLeagueCollectionName('transactions'); },
    get pendingLineups() { return getLeagueCollectionName('pending_lineups'); }
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
    startAfter,
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
    Timestamp,
    increment
};
