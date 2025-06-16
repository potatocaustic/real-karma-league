// In firebase-init.js

// Your web app's Firebase configuration (from Part 1)
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
firebase.initializeApp(firebaseConfig);

// Get references to the services
const auth = firebase.auth();
const db = firebase.firestore();