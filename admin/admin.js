// /admin/admin.js

import { auth, db, functions, onAuthStateChanged, doc, getDoc, httpsCallable } from '/js/firebase-init.js';

document.addEventListener('DOMContentLoaded', () => {
    const loadingContainer = document.getElementById('loading-container');
    const adminContainer = document.getElementById('admin-container');
    const authStatusDiv = document.getElementById('auth-status');

    onAuthStateChanged(auth, async (user) => {
        if (user) {
            const userRef = doc(db, "users", user.uid);
            const userDoc = await getDoc(userRef);

            if (userDoc.exists() && userDoc.data().role === 'admin') {
                loadingContainer.style.display = 'none';
                adminContainer.style.display = 'block';
                authStatusDiv.innerHTML = `Welcome, Admin | <a href="#" id="logout-btn">Logout</a>`;
                addLogoutListener();
                addSeasonManagementListeners(); // ADDED: Attach listeners for new buttons
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
                if (confirm("Are you sure you want to advance to the next season? This will create S8 structures and generate S13 draft picks. This is irreversible.")) {
                    try {
                        const createNewSeason = httpsCallable(functions, 'createNewSeason');
                        const result = await createNewSeason();
                        alert(result.data.message);
                    } catch (error) {
                        console.error("Error creating new season:", error);
                        alert(`Error: ${error.message}`);
                    }
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