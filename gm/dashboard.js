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
    getDocs
} from '/js/firebase-init.js';


// ======================= MODIFICATION START =======================
// This helper function makes the script self-sufficient, just like manage-games.js.
// Set to 'false' when deploying to production.
const USE_DEV_COLLECTIONS = false; 
const getCollectionName = (baseName) => {
    // Note: The admin dashboard uses 'users', but the GM logic relies on 'v2_teams' which has the gm_uid field.
    if (baseName === 'teams') {
        return USE_DEV_COLLECTIONS ? 'v2_teams_dev' : 'v2_teams';
    }
    return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
};
// ======================= MODIFICATION END =======================


document.addEventListener('DOMContentLoaded', () => {
    const loadingContainer = document.getElementById('loading-container');
    const gmDashboardContainer = document.getElementById('gm-dashboard-container');
    const authStatusDiv = document.getElementById('auth-status');

    onAuthStateChanged(auth, async (user) => {
        if (user) {
            const userRef = doc(db, getCollectionName('users'), user.uid);
            const userDoc = await getDoc(userRef);

            if (userDoc.exists() && userDoc.data().role === 'admin') {
                loadingContainer.innerHTML = `
                    <div class="error" style="text-align: center;">
                        Welcome, Admin. <br/>
                        <a href="/admin/dashboard.html">Proceed to Admin Dashboard</a>
                    </div>`;
                return;
            }

            const teamsQuery = query(collection(db, getCollectionName('teams')), where("gm_uid", "==", user.uid), limit(1));
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
            window.location.href = '/login.html?reason=unauthorized';
        }
    });
});
