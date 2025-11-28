import {
    auth,
    db,
    functions,
    onAuthStateChanged,
    signOut,
    doc,
    getDoc,
    httpsCallable,
    collection,
    query,
    where,
    getDocs,
    limit,
    getCurrentLeague
} from '/js/firebase-init.js';

import {
    isLeagueSwitcherPublic,
    setLeagueSwitcherPublic
} from '/js/league-switcher-settings.js';

// --- Notification Logic ---
async function checkForNotifications() {
    const manageDraftCard = document.getElementById('manage-draft-card');
    if (!manageDraftCard) return;

    const badge = manageDraftCard.querySelector('.notification-badge');

    const notificationsQuery = query(
        collection(db, 'notifications'),
        where('module', '==', 'manage-draft'),
        where('status', '==', 'unread'),
        limit(1)
    );

    try {
        const querySnapshot = await getDocs(notificationsQuery);
        badge.style.display = !querySnapshot.empty ? 'flex' : 'none';
    } catch (error) {
        console.error("Error checking for notifications:", error);
    }
}

// --- League Switcher Rollout Logic ---
async function updateLeagueSwitcherStatus() {
    const statusDiv = document.getElementById('league-switcher-status');
    if (!statusDiv) return;

    try {
        const isPublic = await isLeagueSwitcherPublic();
        statusDiv.textContent = isPublic
            ? '✅ Public (click to disable)'
            : '🔒 Admin Only (click to enable)';
    } catch (error) {
        console.error("Error checking league switcher status:", error);
        statusDiv.textContent = 'Error loading status';
    }
}

async function toggleLeagueSwitcherRollout() {
    const statusDiv = document.getElementById('league-switcher-status');
    if (!statusDiv) return;

    try {
        const currentStatus = await isLeagueSwitcherPublic();
        const newStatus = !currentStatus;

        const action = newStatus ? 'enable public access' : 'disable public access and make admin-only';
        const confirmation = confirm(
            `Are you sure you want to ${action} for the league switcher?\n\n` +
            `This will ${newStatus ? 'show' : 'hide'} the league switcher button to all users on S9 pages.`
        );

        if (confirmation) {
            statusDiv.textContent = 'Updating...';
            const success = await setLeagueSwitcherPublic(newStatus);

            if (success) {
                await updateLeagueSwitcherStatus();
                alert(`League switcher is now ${newStatus ? 'public' : 'admin-only'}!`);
            } else {
                alert('Failed to update league switcher settings. Please try again.');
                await updateLeagueSwitcherStatus();
            }
        }
    } catch (error) {
        console.error("Error toggling league switcher rollout:", error);
        alert(`An error occurred: ${error.message}`);
        await updateLeagueSwitcherStatus();
    }
}


// --- Main Page Logic ---
document.addEventListener('DOMContentLoaded', () => {
    const loadingContainer = document.getElementById('loading-container');
    const adminContainer = document.getElementById('admin-container');
    const authStatusDiv = document.getElementById('auth-status');

    onAuthStateChanged(auth, async (user) => {
        if (user) {
            if (user.isAnonymous) {
                await signOut(auth);
                window.location.href = '/login.html';
                return;
            }

            const userRef = doc(db, "users", user.uid);
            const userDoc = await getDoc(userRef);

            if (userDoc.exists() && userDoc.data().role === 'admin') {
                loadingContainer.style.display = 'none';
                adminContainer.style.display = 'block';
                authStatusDiv.innerHTML = `Welcome, Admin | <a href="#" id="logout-btn">Logout</a>`;

                // Initialize all dashboard functionalities
                addLogoutListener();
                addSeasonManagementListeners();
                addLeagueSwitcherRolloutListener();
                checkForNotifications(); // Check for notifications on load
                updateLeagueSwitcherStatus(); // Check league switcher status on load
            } else {
                loadingContainer.innerHTML = '<div class="error">Access Denied. You do not have permission to view this page.</div>';
                authStatusDiv.innerHTML = `Access Denied | <a href="#" id="logout-btn">Logout</a>`;
                addLogoutListener();
            }
        } else {
            window.location.href = '/login.html';
        }
    });

    function addSeasonManagementListeners() {
        const createSeasonBtn = document.getElementById('create-season-btn');
        const createHistoricalBtn = document.getElementById('create-historical-season-btn');

        if (createSeasonBtn) {
            createSeasonBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                try {
                    const activeSeasonQuery = query(collection(db, "seasons"), where("status", "==", "active"));
                    const activeSeasonSnap = await getDocs(activeSeasonQuery);

                    if (activeSeasonSnap.empty) {
                        alert("Error: Could not find an active season to advance from.");
                        return;
                    }

                    const activeSeasonId = activeSeasonSnap.docs[0].id;
                    const activeSeasonNum = parseInt(activeSeasonId.replace('S', ''), 10);
                    const newSeasonNum = activeSeasonNum + 1;
                    const futureDraftNum = newSeasonNum + 5;

                    const confirmationMessage = `Are you sure you want to advance from ${activeSeasonId} to S${newSeasonNum}? This will create S${newSeasonNum} structures and generate S${futureDraftNum} draft picks. This is irreversible.`;

                    if (confirm(confirmationMessage)) {
                        const createNewSeason = httpsCallable(functions, 'createNewSeason');
                        const result = await createNewSeason({ league: getCurrentLeague() });
                        alert(result.data.message);
                    }
                } catch (error) {
                    console.error("Error preparing for new season creation:", error);
                    alert(`An error occurred: ${error.message}`);
                }
            });
        }

        if (createHistoricalBtn) {
            createHistoricalBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                const seasonNumberStr = prompt("Enter the historical season number to create (e.g., '6' for S6):");
                if (seasonNumberStr) {
                    const seasonNumber = parseInt(seasonNumberStr, 10);
                    if (isNaN(seasonNumber) || seasonNumber <= 0) {
                        alert("Please enter a valid, positive season number.");
                        return;
                    }
                    if (confirm(`Are you sure you want to create the structure for historical season S${seasonNumber}? This is irreversible.`)) {
                        try {
                            const createHistoricalSeason = httpsCallable(functions, 'createHistoricalSeason');
                            const result = await createHistoricalSeason({ seasonNumber, league: getCurrentLeague() });
                            alert(result.data.message);
                        } catch (error) {
                            console.error("Error creating historical season:", error);
                            alert(`Error: ${error.message}`);
                        }
                    }
                }
            });
        }
    }

    function addLeagueSwitcherRolloutListener() {
        const rolloutBtn = document.getElementById('league-switcher-rollout-btn');
        if (rolloutBtn) {
            rolloutBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                await toggleLeagueSwitcherRollout();
            });
        }
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

    // Reload notifications when league changes
    window.addEventListener('leagueChanged', (event) => {
        const newLeague = event.detail.league;
        console.log('League changed to:', newLeague);

        // Reload notifications for the new league
        checkForNotifications();
    });
});