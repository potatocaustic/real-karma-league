// In /js/firebase-public-auth.js

import { auth, onAuthStateChanged } from './firebase-init.js';
import { signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";

// This script will only be loaded on public pages.
// It checks if a user is logged in, and if not, signs them in anonymously.
onAuthStateChanged(auth, (user) => {
    if (!user) {
        signInAnonymously(auth).catch((error) => {
            console.error("Anonymous sign-in failed:", error);
        });
    }
});
