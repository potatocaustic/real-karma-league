import {
    auth,
    db,
    onAuthStateChanged,
    signOut,
    doc,
    getDoc,
    collection,
    query,
    where,
    limit,
    getDocs,
    collectionNames
} from '/js/firebase-init.js';


document.addEventListener('DOMContentLoaded', () => {
    const loadingContainer = document.getElementById('loading-container');
    const gmDashboardContainer = document.getElementById('gm-dashboard-container');
    const authStatusDiv = document.getElementById('auth-status');

    onAuthStateChanged(auth, async (user) => {
        if (user) {
            const userRef = doc(db, collectionNames.users, user.uid);
            const userDoc = await getDoc(userRef);

            if (userDoc.exists() && userDoc.data().role === 'admin') {
                loadingContainer.innerHTML = `
                    <div class="error" style="text-align: center;">
                        Welcome, Admin. <br/>
                        <a href="/admin/dashboard.html">Proceed to Admin Dashboard</a>
                    </div>`;
                return;
            }

            const teamsQuery = query(collection(db, collectionNames.teams), where("gm_uid", "==", user.uid), limit(1));
            const teamSnap = await getDocs(teamsQuery);

            if (!teamSnap.empty) {
                const teamData = teamSnap.docs[0].data();
                const welcomeMsg = `Welcome! Select a management task below.`;
                document.getElementById('welcome-message').textContent = welcomeMsg;

                loadingContainer.style.display = 'none';
                gmDashboardContainer.style.display = 'block';
            } else {
                loadingContainer.innerHTML = '<div class="error">Access Denied. You are not registered as a GM.</div>';
            }

        } else {
            window.location.href = '/login.html?reason=unauthorized';
        }
    });

    // Listen for league changes
    window.addEventListener('leagueChanged', (event) => {
        const newLeague = event.detail.league;
        console.log('League changed to:', newLeague);
        // GM dashboard doesn't display league-specific data, so just log the change
    });
});
