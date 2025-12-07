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
    collectionNames,
    getCurrentLeague,
    setCurrentLeague
} from '/js/firebase-init.js';


document.addEventListener('DOMContentLoaded', () => {
    const loadingContainer = document.getElementById('loading-container');
    const gmDashboardContainer = document.getElementById('gm-dashboard-container');
    const authStatusDiv = document.getElementById('auth-status');

    // Initialize league switcher
    const leagueSwitcherBtn = document.getElementById('league-toggle-btn');
    if (leagueSwitcherBtn) {
        leagueSwitcherBtn.addEventListener('click', () => {
            const currentLeague = getCurrentLeague();
            const newLeague = currentLeague === 'major' ? 'minor' : 'major';
            setCurrentLeague(newLeague);
            // Reload to refresh with new league context
            window.location.reload();
        });
    }

    function userMatchesTeam(teamData, userId) {
        return teamData?.gm_uid === userId || teamData?.co_gm_uid === userId;
    }

    async function findTeamByUser(userId) {
        const gmQuery = query(
            collection(db, collectionNames.teams),
            where("gm_uid", "==", userId),
            limit(1)
        );
        let teamSnap = await getDocs(gmQuery);
        if (!teamSnap.empty) return teamSnap.docs[0];

        const coGmQuery = query(
            collection(db, collectionNames.teams),
            where("co_gm_uid", "==", userId),
            limit(1)
        );
        teamSnap = await getDocs(coGmQuery);
        return teamSnap.empty ? null : teamSnap.docs[0];
    }

    async function checkAccess(user) {
        const currentLeague = getCurrentLeague();
        const userRef = doc(db, collectionNames.users, user.uid);
        const userDoc = await getDoc(userRef);

        if (!userDoc.exists()) {
            loadingContainer.innerHTML = '<div class="error">User not found. Please contact an administrator.</div>';
            return;
        }

        const userData = userDoc.data();
        const isAdmin = userData.role === 'admin';

        // Check for team in current league
        const teamIdField = currentLeague === 'minor' ? 'minor_team_id' : 'major_team_id';
        let teamId = userData[teamIdField] || (currentLeague === 'major' ? userData.team_id : null); // Backward compat

        // Fall back to searching by gm/co_gm assignments so co-GMs without team_id still get in
        let teamDoc = null;
        if (teamId) {
            const teamRef = doc(db, collectionNames.teams, teamId);
            const fetchedTeam = await getDoc(teamRef);
            if (fetchedTeam.exists()) {
                teamDoc = fetchedTeam;
            }
        }

        if (!teamDoc) {
            const discoveredTeam = await findTeamByUser(user.uid);
            if (discoveredTeam) {
                teamId = discoveredTeam.id;
                teamDoc = discoveredTeam;
            }
        }

        if (!teamDoc) {
            const otherLeague = currentLeague === 'minor' ? 'major' : 'minor';
            const otherTeamIdField = currentLeague === 'minor' ? 'major_team_id' : 'minor_team_id';
            const hasOtherTeam = userData[otherTeamIdField];

            if (hasOtherTeam) {
                loadingContainer.innerHTML = `
                    <div class="error" style="text-align: center;">
                        You are not a GM in the ${currentLeague} league.<br/>
                        <a href="/gm/dashboard.html?league=${otherLeague}">Switch to ${otherLeague} league</a>
                    </div>`;
            } else {
                loadingContainer.innerHTML = `
                    <div class="error" style="text-align: center;">
                        You are not registered as a GM in the ${currentLeague} league.<br/>
                        <a href="/activate.html?league=${currentLeague}">Activate with a code</a>
                    </div>`;
            }
            return;
        }

        const teamData = teamDoc.data();
        const userHasTeamAccess = isAdmin || userMatchesTeam(teamData, user.uid);

        if (userHasTeamAccess) {
            const leagueLabel = currentLeague === 'minor' ? 'Minor League' : 'Major League';
            document.getElementById('welcome-message').textContent =
                `Welcome to the ${leagueLabel} GM Portal! Select a management task below.`;

            loadingContainer.style.display = 'none';
            gmDashboardContainer.style.display = 'block';
        } else {
            loadingContainer.innerHTML = '<div class="error">Access Denied. Team not found.</div>';
        }
    }

    onAuthStateChanged(auth, async (user) => {
        if (user) {
            await checkAccess(user);
        } else {
            const currentLeague = getCurrentLeague();
            window.location.href = `/login.html?reason=unauthorized&league=${currentLeague}`;
        }
    });

    // Listen for league changes
    window.addEventListener('leagueChanged', (event) => {
        const newLeague = event.detail.league;
        console.log('League changed to:', newLeague);
        window.location.reload(); // Reload to check access for new league
    });
});
