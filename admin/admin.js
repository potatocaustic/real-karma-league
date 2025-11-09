// /admin/admin.js

import { auth, db, functions, onAuthStateChanged, signOut, doc, getDoc, httpsCallable, collection, query, where, getDocs, getCurrentLeague } from '/js/firebase-init.js';

document.addEventListener('DOMContentLoaded', () => {
    const loadingContainer = document.getElementById('loading-container');
    const adminContainer = document.getElementById('admin-container');
    const authStatusDiv = document.getElementById('auth-status');

    onAuthStateChanged(auth, async (user) => {
        if (user) {
            // If the user is anonymous, sign them out and redirect to login.
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
                addLogoutListener();
                addSeasonManagementListeners();
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

                // MODIFICATION: Fetch the active season to create a dynamic confirmation message.
                try {
                    const activeSeasonQuery = query(collection(db, "seasons"), where("status", "==", "active"));
                    const activeSeasonSnap = await getDocs(activeSeasonQuery);

                    if (activeSeasonSnap.empty) {
                        alert("Error: Could not find an active season to advance from.");
                        return;
                    }

                    const activeSeasonId = activeSeasonSnap.docs[0].id; // e.g., 'S8'
                    const activeSeasonNum = parseInt(activeSeasonId.replace('S', ''), 10); // e.g., 8

                    const newSeasonNum = activeSeasonNum + 1; // e.g., 9
                    const futureDraftNum = newSeasonNum + 5; // e.g., 14

                    const confirmationMessage = `Are you sure you want to advance from ${activeSeasonId} to S${newSeasonNum}? This will create S${newSeasonNum} structures and generate S${futureDraftNum} draft picks. This is irreversible.`;

                    // MODIFICATION: Use the dynamic confirmation message.
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