// In /js/firebase-init.js

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";
import { getFunctions } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-functions.js";

// Your web app's Firebase configuration (from Part 1) [cite: 1]
const firebaseConfig = {
  apiKey: "AIzaSyDch0dQ1c9_mDzANAvfMoK1HAnMrRl1WnY",
  authDomain: "real-karma-league.firebaseapp.com",
  projectId: "real-karma-league",
  storageBucket: "real-karma-league.firebasestorage.app",
  messagingSenderId: "158995195520",
  appId: "1:158995195520:web:0e12dd5095595c0a42e865",
  measurementId: "G-E8LNVNG5M1"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Get references to the services and export them
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, 'us-central1'); // Specify region