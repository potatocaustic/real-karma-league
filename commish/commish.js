// /commish/commish.js

import { auth, db, onAuthStateChanged, signOut, doc, getDoc, getCurrentLeague } from '/js/firebase-init.js';

/**
 * Checks if a user has the 'commish' role for a specific league
 * @param {Object} userData - The user document data from Firestore
 * @param {string} league - The league to check ('major' or 'minor')
 * @returns {boolean} - True if the user is a commish for that league
 */
export function isCommishForLeague(userData, league) {
    if (!userData) return false;

    // Check for league-specific role (e.g., role_major: 'commish' or role_minor: 'commish')
    const roleField = `role_${league}`;
    if (userData[roleField] === 'commish') {
        return true;
    }

    // Also check if they're an admin (admins have access to everything)
    if (userData.role === 'admin') {
        return true;
    }

    return false;
}

/**
 * Initializes commish authentication for a page
 * @param {Function} onSuccess - Callback function to execute when authentication succeeds
 * @returns {Promise<void>}
 */
export async function initCommishAuth(onSuccess) {
    const loadingContainer = document.getElementById('loading-container');
    const adminContainer = document.getElementById('admin-container');
    const authStatusDiv = document.getElementById('auth-status');

    onAuthStateChanged(auth, async (user) => {
        try {
            if (user) {
                // If the user is anonymous, sign them out and redirect to login
                if (user.isAnonymous) {
                    await signOut(auth);
                    window.location.href = '/login.html';
                    return;
                }

                const currentLeague = getCurrentLeague();
                const userRef = doc(db, "users", user.uid);
                const userDoc = await getDoc(userRef);

                if (userDoc.exists() && isCommishForLeague(userDoc.data(), currentLeague)) {
                    loadingContainer.style.display = 'none';
                    adminContainer.style.display = 'block';

                    const userData = userDoc.data();
                    const isAdmin = userData.role === 'admin';
                    const roleDisplay = isAdmin ? 'Admin' : 'Commish';
                    const leagueDisplay = currentLeague === 'minor' ? 'Minor League' : 'Major League';

                    authStatusDiv.innerHTML = `Welcome, ${roleDisplay} (${leagueDisplay}) | <a href="#" id="logout-btn">Logout</a>`;
                    addLogoutListener();

                    if (onSuccess) {
                        await onSuccess();
                    }
                } else {
                    const currentLeague = getCurrentLeague();
                    const leagueDisplay = currentLeague === 'minor' ? 'Minor League' : 'Major League';
                    loadingContainer.innerHTML = `<div class="error">Access Denied. You do not have commish permissions for the ${leagueDisplay}.</div>`;
                    authStatusDiv.innerHTML = `Access Denied | <a href="#" id="logout-btn">Logout</a>`;
                    addLogoutListener();
                }
            } else {
                window.location.href = '/login.html';
            }
        } catch (error) {
            console.error("Fatal Error during Authentication/Initialization:", error);
            loadingContainer.innerHTML = `<div class="error">A critical error occurred. Please check the console and refresh.</div>`;
        }
    });
}

function addLogoutListener() {
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            auth.signOut().then(() => {
                window.location.href = '/login.html';
            });
        });
    }
}
