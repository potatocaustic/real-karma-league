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
            // Check if the user is an admin first
            const userRef = doc(db, collectionNames.users, user.uid);
            const userDoc = await getDoc(userRef);

            if (userDoc.exists() && userDoc.data().role === 'admin') {
                // If admin, show a link to the admin dashboard
                loadingContainer.innerHTML = `
                    <div class="error" style="text-align: center;">
                        Welcome, Admin. <br/>
                        <a href="/admin/dashboard.html">Proceed to Admin Dashboard</a>
                    </div>`;
                return;
            }

            // Check if the user is a GM
            const teamsQuery = query(collection(db, collectionNames.v2_teams), where("gm_uid", "==", user.uid), limit(1));
            const teamSnap = await getDocs(teamsQuery);

            if (!teamSnap.empty) {
                const teamData = teamSnap.docs[0].data();
                const welcomeMsg = `Welcome, ${teamData.gm_handle}! Select a management task below.`;
                document.getElementById('welcome-message').textContent = welcomeMsg;

                loadingContainer.style.display = 'none';
                gmDashboardContainer.style.display = 'block';
            } else {
                loadingContainer.innerHTML = '<div class="error">Access Denied. You are not registered as a GM.</div>';
            }

        } else {
            // If not logged in at all, redirect to login page
            window.location.href = '/login.html?reason=unauthorized';
        }
    });
});
