// In /js/firebase-init.js

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
    documentId 
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-functions.js";

// Your web app's Firebase configuration...
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

// Initialize and export services
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, 'us-central1');

// --- Connect to Emulators when running locally ---
if (window.location.hostname.includes("localhost") || window.location.hostname.includes("127.0.0.1")) {
    console.log("Connecting to local Firebase emulators...");
    connectAuthEmulator(auth, "http://127.0.0.1:9099");
    connectFirestoreEmulator(db, "127.0.0.1", 8080);
    connectFunctionsEmulator(functions, "127.0.0.1", 5001);
}

// Export all the functions you'll use
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
    documentId 
};
