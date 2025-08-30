// /scorekeeper/dashboard.js

import { auth, db, onAuthStateChanged, signOut, doc, getDoc } from '/js/firebase-init.js';

// --- DEV ENVIRONMENT CONFIG ---
const USE_DEV_COLLECTIONS = false;
const getCollectionName = (baseName) => USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;

document.addEventListener('DOMContentLoaded', () => {
    const loadingContainer = document.getElementById('loading-container');
    const scorekeeperContainer = document.getElementById('scorekeeper-container');
    const authStatusDiv = document.getElementById('auth-status');

    onAuthStateChanged(auth, async (user) => {
        if (user) {
            if (user.isAnonymous) {
                await signOut(auth);
                window.location.href = '/login.html';
                return;
            }

            const userRef = doc(db, getCollectionName("users"), user.uid);
            const userDoc = await getDoc(userRef);

            if (userDoc.exists()) {
                const userRole = userDoc.data().role;
                if (userRole === 'admin' || userRole === 'scorekeeper') {
                    loadingContainer.style.display = 'none';
                    scorekeeperContainer.style.display = 'block';
                    const roleDisplay = userRole.charAt(0).toUpperCase() + userRole.slice(1);
                    authStatusDiv.innerHTML = `Welcome, ${roleDisplay} | <a href="#" id="logout-btn">Logout</a>`;
                    addLogoutListener();
                } else {
                    displayAccessDenied(authStatusDiv);
                }
            } else {
                 displayAccessDenied(authStatusDiv);
            }
        } else {
            window.location.href = '/login.html';
        }
    });

    function displayAccessDenied(authStatusDiv) {
        loadingContainer.innerHTML = '<div class="error">Access Denied. You do not have permission to view this page.</div>';
        scorekeeperContainer.style.display = 'none';
        authStatusDiv.innerHTML = `Access Denied | <a href="#" id="logout-btn">Logout</a>`;
        addLogoutListener();
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
});
