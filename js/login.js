// /js/login.js

import { auth, db, functions, onAuthStateChanged, doc, getDoc, collectionNames, getCurrentLeague } from './firebase-init.js';
import {
    signInWithEmailAndPassword,
    GoogleAuthProvider,
    signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-functions.js";

const ensureUserDocument = httpsCallable(functions, 'ensureUserDocument');

function userHasCommishAccess(userData, league) {
    if (!userData) return false;

    const roleField = `role_${league}`;
    if (userData[roleField] === 'commish') {
        return true;
    }

    return userData.role === 'admin';
}

// Handle OAuth sign-in flow
async function handleOAuthSignIn(user, targetPortal = 'gm') {
    const league = getCurrentLeague();

    try {
        const userDocRef = doc(db, collectionNames.users, user.uid);
        const userDoc = await getDoc(userDocRef);

        if (userDoc.exists()) {
            const userData = userDoc.data();
            const teamIdField = league === 'minor' ? 'minor_team_id' : 'major_team_id';

            if (targetPortal === 'admin' && userData.role === 'admin') {
                window.location.href = `/admin/dashboard.html?league=${league}`;
                return;
            }

            if (targetPortal === 'commish' && userHasCommishAccess(userData, league)) {
                window.location.href = `/commish/dashboard.html?league=${league}`;
                return;
            }

            // Check if user has a team in this league
            if (userData[teamIdField] || (league === 'major' && userData.team_id)) {
                // Has team in this league - go to dashboard
                window.location.href = `/gm/dashboard.html?league=${league}`;
            } else if (userData.role === 'admin') {
                // Admin without team - go to admin dashboard
                window.location.href = `/admin/dashboard.html?league=${league}`;
            } else if (userHasCommishAccess(userData, league)) {
                // Commish without a team - go to commish dashboard
                window.location.href = `/commish/dashboard.html?league=${league}`;
            } else if (userData.role === 'scorekeeper') {
                // Scorekeeper - go to scorekeeper dashboard
                window.location.href = `/scorekeeper/dashboard.html?league=${league}`;
            } else {
                // User exists but no team in this league - needs activation
                window.location.href = `/activate.html?league=${league}`;
            }
        } else {
            // Brand new user - create placeholder user doc then send to activation
            try {
                await ensureUserDocument();
            } catch (ensureError) {
                console.error('Failed to create user document:', ensureError);
            }
            window.location.href = `/activate.html?league=${league}`;
        }
    } catch (error) {
        console.error('Error checking user status:', error);
        const errorMessageDiv = document.getElementById('error-message');
        errorMessageDiv.textContent = 'An error occurred during sign-in. Please try again.';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    const targetParam = params.get('target');
    const targetPortal = targetParam === 'commish' ? 'commish' : targetParam === 'admin' ? 'admin' : 'gm';
    const league = getCurrentLeague();

    // Update login title based on league
    const loginTitle = document.getElementById('login-title');
    if (loginTitle) {
        const titlePrefix = league === 'minor' ? 'Minor League ' : '';
        const roleTitle = targetPortal === 'commish' ? 'Commish Login' : targetPortal === 'admin' ? 'Admin Login' : 'GM Login';
        loginTitle.textContent = `${titlePrefix}${roleTitle}`;
    }

    // Redirect if user is already logged in
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            console.log('User already signed in, redirecting...');
            await handleOAuthSignIn(user, targetPortal);
        }
    });

    const loginBtn = document.getElementById('login-btn');
    const usernameInput = document.getElementById('username');
    const passwordInput = document.getElementById('password');
    const errorMessageDiv = document.getElementById('error-message');

    // Google Sign-In
    const googleSignInBtn = document.getElementById('google-signin-btn');
    if (googleSignInBtn) {
        googleSignInBtn.addEventListener('click', async () => {
            const provider = new GoogleAuthProvider();
            errorMessageDiv.textContent = '';

            try {
                const result = await signInWithPopup(auth, provider);
                console.log('Google sign-in successful for:', result.user.email);
                await handleOAuthSignIn(result.user, targetPortal);
            } catch (error) {
                console.error('Google sign-in failed:', error);
                if (error.code === 'auth/popup-closed-by-user') {
                    errorMessageDiv.textContent = 'Sign-in cancelled.';
                } else if (error.code === 'auth/popup-blocked') {
                    errorMessageDiv.textContent = 'Pop-up blocked. Please allow pop-ups for this site.';
                } else {
                    errorMessageDiv.textContent = 'Google sign-in failed: ' + error.message;
                }
            }
        });
    }

    // Email/Password Login (existing users)
    loginBtn.addEventListener('click', async () => {
        const username = usernameInput.value.trim();
        const password = passwordInput.value;

        errorMessageDiv.textContent = ''; // Clear previous errors

        if (!username || !password) {
            errorMessageDiv.textContent = 'Please enter both username and password.';
            return;
        }

        const email = username + '@rkl.league';

        try {
            const userCredential = await signInWithEmailAndPassword(auth, email, password);
            console.log('Login successful for:', userCredential.user.email);
            await handleOAuthSignIn(userCredential.user, targetPortal);
        } catch (error) {
            // Handle errors
            console.error('Login failed:', error.code);
            switch (error.code) {
                case 'auth/invalid-credential':
                    errorMessageDiv.textContent = 'Invalid username or password. Please try again.';
                    break;
                case 'auth/invalid-email':
                    errorMessageDiv.textContent = 'Please enter a valid username.';
                    break;
                default:
                    errorMessageDiv.textContent = 'An error occurred. Please try again later.';
                    break;
            }
        }
    });

    // Allow Enter key to submit email login
    passwordInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            loginBtn.click();
        }
    });
});
