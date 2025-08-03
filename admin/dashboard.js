// /admin/dashboard.js

import { auth, db, functions, onAuthStateChanged, signOut, doc, getDoc, httpsCallable, collection, query, where, getDocs } from '/js/firebase-init.js';

// --- DEV ENVIRONMENT CONFIG ---
const USE_DEV_COLLECTIONS = true;
const getCollectionName = (baseName) => USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;

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

            const userRef = doc(db, getCollectionName("users"), user.uid);
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
                try {
                    const activeSeasonQuery = query(collection(db, getCollectionName("seasons")), where("status", "==", "active"));
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
                        const result = await createNewSeason();
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
                            const result = await createHistoricalSeason({ seasonNumber });
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