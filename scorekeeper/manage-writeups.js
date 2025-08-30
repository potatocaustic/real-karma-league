// /scorekeeper/manage-writeups.js

import { auth, db, functions, onAuthStateChanged, doc, getDoc, collection, getDocs, query, where, httpsCallable } from '/js/firebase-init.js';

// --- DEV ENVIRONMENT CONFIG ---
const USE_DEV_COLLECTIONS = false;
const getCollectionName = (baseName) => {
    if (baseName.includes('_awards') || baseName.includes('_lineups') || baseName.includes('_games')) {
        return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
    }
    return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
};

// --- Page Elements ---
let loadingContainer, scorekeeperContainer, authStatusDiv, seasonSelect, weekSelect, gameSelect, writeupContainer, writeupOutput, copyWriteupBtn;

// --- Global Data Cache ---
let currentSeasonId = null;
let allTeams = new Map();
let currentGames = [];

document.addEventListener('DOMContentLoaded', () => {
    loadingContainer = document.getElementById('loading-container');
    scorekeeperContainer = document.getElementById('scorekeeper-container');
    authStatusDiv = document.getElementById('auth-status');
    seasonSelect = document.getElementById('season-select');
    weekSelect = document.getElementById('week-select');
    gameSelect = document.getElementById('game-select');
    writeupContainer = document.getElementById('writeup-container');
    writeupOutput = document.getElementById('writeup-output');
    copyWriteupBtn = document.getElementById('copy-writeup-btn');
    
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            const userRef = doc(db, getCollectionName("users"), user.uid);
            const userDoc = await getDoc(userRef);
            if (userDoc.exists() && (userDoc.data().role === 'admin' || userDoc.data().role === 'scorekeeper')) {
                loadingContainer.style.display = 'none';
                scorekeeperContainer.style.display = 'block';
                 const userRole = userDoc.data().role;
                 const roleDisplay = userRole.charAt(0).toUpperCase() + userRole.slice(1);
                authStatusDiv.innerHTML = `Welcome, ${roleDisplay} | <a href="#" id="logout-btn">Logout</a>`;
                addLogoutListener();
                await initializePage();
            } else {
                loadingContainer.innerHTML = '<div class="error">Access Denied.</div>';
            }
        } else {
            window.location.href = '/login.html';
        }
    });
});

async function initializePage() {
    await populateSeasons();

    seasonSelect.addEventListener('change', async () => {
        currentSeasonId = seasonSelect.value;
        if (currentSeasonId) {
            await updateTeamCache(currentSeasonId);
        }
        await handleSeasonChange();
    });

    weekSelect.addEventListener('change', () => {
        if (currentSeasonId && weekSelect.value) {
            fetchAndPopulateGames(currentSeasonId, weekSelect.value);
        }
    });
    
    gameSelect.addEventListener('change', handleGameSelection);

    copyWriteupBtn.addEventListener('click', () => {
        writeupOutput.select();
        document.execCommand('copy');
        copyWriteupBtn.textContent = 'Copied!';
        setTimeout(() => { copyWriteupBtn.textContent = 'Copy to Clipboard'; }, 2000);
    });
}

async function updateTeamCache(seasonId) {
    allTeams.clear();
    const teamsSnap = await getDocs(collection(db, getCollectionName("v2_teams")));

    const teamPromises = teamsSnap.docs.map(async (teamDoc) => {
        if (!teamDoc.data().conference) return null;
        const teamData = { id: teamDoc.id, ...teamDoc.data() };
        const seasonRecordRef = doc(db, getCollectionName("v2_teams"), teamDoc.id, getCollectionName("seasonal_records"), seasonId);
        const seasonRecordSnap = await getDoc(seasonRecordRef);
        teamData.team_name = seasonRecordSnap.exists() ? seasonRecordSnap.data().team_name : "Name Not Found";
        return teamData;
    });

    const teamsWithData = (await Promise.all(teamPromises)).filter(Boolean);
    teamsWithData.forEach(team => allTeams.set(team.id, team));
}

async function populateSeasons() {
    const seasonsSnap = await getDocs(query(collection(db, getCollectionName("seasons"))));
    if (seasonsSnap.empty) {
        seasonSelect.innerHTML = `<option value="">No Seasons</option>`;
        return;
    }

    let activeSeasonId = null;
    const seasonOptions = seasonsSnap.docs
        .sort((a, b) => b.id.localeCompare(a.id))
        .map(doc => {
            if (doc.data().status === 'active') activeSeasonId = doc.id;
            return `<option value="${doc.id}">${doc.data().season_name}</option>`;
        }).join('');
    seasonSelect.innerHTML = `<option value="">Select...</option>${seasonOptions}`;

    if (activeSeasonId) {
        seasonSelect.value = activeSeasonId;
        currentSeasonId = activeSeasonId;
        await updateTeamCache(currentSeasonId);
        await handleSeasonChange();
    }
}

async function handleSeasonChange() {
    if (currentSeasonId) {
        await populateWeeks(currentSeasonId);
        gameSelect.innerHTML = '<option>Select a week...</option>';
        writeupContainer.style.display = 'none';
    } else {
        weekSelect.innerHTML = '<option>Select a season...</option>';
        gameSelect.innerHTML = '<option>Select a week...</option>';
    }
}

async function populateWeeks(seasonId) {
    let weekOptions = '';
    for (let i = 1; i <= 15; i++) weekOptions += `<option value="${i}">Week ${i}</option>`;
    ['All-Star', 'Relegation', 'Play-In', 'Round 1', 'Round 2', 'Conf Finals', 'Finals'].forEach(w => {
        weekOptions += `<option value="${w}">${w}</option>`;
    });
    weekSelect.innerHTML = `<option value="">Select...</option>${weekOptions}`;
}

async function fetchAndPopulateGames(seasonId, week) {
    gameSelect.innerHTML = '<option>Loading games...</option>';
    writeupContainer.style.display = 'none';

    const isPostseason = !/^\d+$/.test(week) && week !== 'All-Star' && week !== 'Relegation';
    const isExhibition = week === 'All-Star' || week === 'Relegation';
    let collectionName = isPostseason ? 'post_games' : (isExhibition ? 'exhibition_games' : 'games');

    const gamesQuery = query(collection(db, getCollectionName("seasons"), seasonId, getCollectionName(collectionName)), where("week", "==", week), where("completed", "==", "TRUE"));

    try {
        const querySnapshot = await getDocs(gamesQuery);
        if (querySnapshot.empty) {
            gameSelect.innerHTML = '<option>No completed games found</option>';
            return;
        }

        currentGames = querySnapshot.docs.map(doc => ({ id: doc.id, collectionName, ...doc.data() }));
        
        let gamesOptions = currentGames.map(game => {
            const team1 = allTeams.get(game.team1_id);
            const team2 = allTeams.get(game.team2_id);
            const label = `${team1?.team_name || game.team1_id} vs ${team2?.team_name || game.team2_id}`;
            return `<option value="${game.id}">${label}</option>`;
        }).join('');
        gameSelect.innerHTML = `<option value="">Select a game...</option>${gamesOptions}`;

    } catch (error) {
        console.error("Error fetching games:", error);
        gameSelect.innerHTML = '<option>Error loading games</option>';
    }
}

async function handleGameSelection(e) {
    const gameId = e.target.value;
    if (!gameId) {
        writeupContainer.style.display = 'none';
        return;
    }

    const selectedGame = currentGames.find(g => g.id === gameId);
    if (!selectedGame) return;

    writeupContainer.style.display = 'block';
    writeupOutput.value = 'Generating writeup with Gemini... Please wait.';
    copyWriteupBtn.disabled = true;

    try {
        const generateGameWriteup = httpsCallable(functions, 'generateGameWriteup');
        const result = await generateGameWriteup({
            gameId: selectedGame.id,
            seasonId: currentSeasonId,
            collectionName: selectedGame.collectionName
        });
        
        if (result.data.success) {
            writeupOutput.value = result.data.writeup;
        } else {
            throw new Error(result.data.message || 'Unknown error from function.');
        }

    } catch (error) {
        console.error("Error generating writeup:", error);
        writeupOutput.value = `Error: ${error.message}`;
    } finally {
        copyWriteupBtn.disabled = false;
    }
}


function addLogoutListener() {
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            auth.signOut().then(() => { window.location.href = '/login.html'; });
        });
    }
}
