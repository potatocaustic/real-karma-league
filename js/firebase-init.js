// In /js/firebase-init.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";
import { 
    getFirestore, 
    collection, 
    doc, 
    getDoc, 
    getDocs, 
    query, 
    where, 
    limit, 
    setDoc, 
    deleteDoc, 
    serverTimestamp 
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-functions.js";

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
  httpsCallable,
  setDoc,
  deleteDoc,
  serverTimestamp
};