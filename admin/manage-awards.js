// /admin/manage-awards.js

import { auth, db, functions, onAuthStateChanged, doc, getDoc, collection, getDocs, writeBatch, httpsCallable } from '/js/firebase-init.js';

// --- Page Elements ---
const loadingContainer = document.getElementById('loading-container');
const adminContainer = document.getElementById('admin-container');
const seasonSelect = document.getElementById('season-select');
const awardsForm = document.getElementById('awards-form');
const playerDatalist = document.getElementById('player-datalist');
const gmDatalist = document.getElementById('gm-datalist');
const calculateBtn = document.getElementById('calculate-awards-btn');

// --- Global Data Cache ---
let allPlayers = new Map();
let allGms = new Map();
let allTeams = [];
let currentSeasonId = null;

// --- Primary Auth Check & Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            const userRef = doc(db, "users", user.uid);
            const userDoc = await getDoc(userRef);
            if (userDoc.exists() && userDoc.data().role === 'admin') {
                await initializePage();
                loadingContainer.style.display = 'none';
                adminContainer.style.display = 'block';
            } else {
                loadingContainer.innerHTML = '<div class="error">Access Denied.</div>';
            }
        } else {
            window.location.href = '/login.html';
        }
    });
});

async function initializePage() {
    try {
        const [playersSnap, teamsSnap] = await Promise.all([
            getDocs(collection(db, "v2_players")),
            getDocs(collection(db, "v2_teams"))
        ]);

        playersSnap.docs.forEach(doc => {
            if (doc.data().player_status === 'ACTIVE') {
                allPlayers.set(doc.data().player_handle, { id: doc.id, ...doc.data() });
            }
        });

        allTeams = teamsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })).sort((a, b) => a.team_name.localeCompare(b.team_name));

        // Populate the GM map from the teams data
        allTeams.forEach(team => {
            if (team.current_gm_handle) {
                allGms.set(team.current_gm_handle, { team_id: team.id, team_name: team.team_name });
            }
        });

        populateDatalistAndSelects();

        seasonSelect.innerHTML = `<option value="S7">Season 7</option>`;
        currentSeasonId = seasonSelect.value;

        await loadExistingAwards();

        awardsForm.addEventListener('submit', handleFormSubmit);
        calculateBtn.addEventListener('click', handleCalculationTrigger);

    } catch (error) {
        console.error("Error initializing awards page:", error);
        adminContainer.innerHTML = `<div class="error">Could not load required league data.</div>`;
    }
}

function populateDatalistAndSelects() {
    playerDatalist.innerHTML = Array.from(allPlayers.keys()).map(handle => `<option value="${handle}"></option>`).join('');

    // Populate the GM datalist
    gmDatalist.innerHTML = Array.from(allGms.keys()).map(handle => `<option value="${handle}"></option>`).join('');

    const teamOptions = `<option value="">-- Select Team --</option>` + allTeams.map(t => `<option value="${t.id}">${t.team_name}</option>`).join('');
    document.querySelectorAll('.team-select').forEach(select => select.innerHTML = teamOptions);

    // Populate All-Star and Rising Star inputs
    for (let i = 1; i <= 8; i++) {
        document.getElementById('all-stars-eastern').innerHTML += `<input type="text" list="player-datalist" placeholder="East All-Star #${i}" autocomplete="off">`;
        document.getElementById('all-stars-western').innerHTML += `<input type="text" list="player-datalist" placeholder="West All-Star #${i}" autocomplete="off">`;
        document.getElementById('rising-stars-eastern').innerHTML += `<input type="text" list="player-datalist" placeholder="East Rising Star #${i}" autocomplete="off">`;
        document.getElementById('rising-stars-western').innerHTML += `<input type="text" list="player-datalist" placeholder="West Rising Star #${i}" autocomplete="off">`;
    }
}

async function loadExistingAwards() {
    const seasonNumber = currentSeasonId.replace('S', '');
    const awardsCollectionRef = collection(db, `awards/season_${seasonNumber}/S${seasonNumber}_awards`);
    const awardsSnap = await getDocs(awardsCollectionRef);

    if (awardsSnap.empty) {
        console.log("No existing awards found for this season.");
        return;
    }

    const awardsData = new Map();
    awardsSnap.forEach(doc => awardsData.set(doc.id, doc.data()));

    // Populate single-winner awards
    const singleAwards = ['finals-mvp', 'rookie-of-the-year', 'sixth-man', 'most-improved', 'lvp'];
    singleAwards.forEach(id => {
        const award = awardsData.get(id);
        if (award) document.getElementById(`award-${id}`).value = award.player_handle || '';
    });

    // Populate GM of the Year separately
    const gmAward = awardsData.get('gm-of-the-year');
    if (gmAward) document.getElementById('award-gm-of-the-year').value = gmAward.gm_handle || '';

    // Populate team awards
    const teamAwards = ['league-champion', 'regular-season-title'];
    teamAwards.forEach(id => {
        const award = awardsData.get(id);
        if (award) document.getElementById(`award-${id}`).value = award.team_id || '';
    });

    // Populate multi-player awards
    const listAwards = ['all-stars-eastern', 'all-stars-western', 'rising-stars-eastern', 'rising-stars-western'];
    listAwards.forEach(id => {
        const award = awardsData.get(id);
        if (award && award.players) {
            const inputs = document.getElementById(id).querySelectorAll('input');
            award.players.forEach((player, i) => {
                if (inputs[i]) inputs[i].value = player.player_handle;
            });
        }
    });

    // Display auto-calculated awards
    const bestPlayer = awardsData.get('best_performance_player');
    if (bestPlayer) {
        document.getElementById('best-player-performance-display').textContent = `${bestPlayer.player_handle} (${(bestPlayer.value * 100).toFixed(2)}% above median)`;
    }
    const bestTeam = awardsData.get('best_performance_team');
    if (bestTeam) {
        document.getElementById('best-team-performance-display').textContent = `${bestTeam.team_name} (${(bestTeam.value * 100).toFixed(2)}% above median)`;
    }
}

async function handleFormSubmit(e) {
    e.preventDefault();
    const saveButton = e.target.querySelector('button[type="submit"]');
    saveButton.disabled = true;
    saveButton.textContent = 'Saving...';

    try {
        const batch = writeBatch(db);
        const seasonNumber = currentSeasonId.replace('S', '');
        const awardsCollectionRef = collection(db, `awards/season_${seasonNumber}/S${seasonNumber}_awards`);

        // --- Process Single Player Awards ---
        const singleAwards = ['finals-mvp', 'rookie-of-the-year', 'sixth-man', 'most-improved', 'lvp'];
        for (const id of singleAwards) {
            const handle = document.getElementById(`award-${id}`).value;
            if (handle && allPlayers.has(handle)) {
                const player = allPlayers.get(handle);
                const docRef = doc(awardsCollectionRef, id);
                batch.set(docRef, { award_name: id.replace(/-/g, ' '), player_handle: player.player_handle, player_id: player.id, team_id: player.current_team_id });
            }
        }

        // --- Process GM of the Year Award ---
        const gmHandle = document.getElementById('award-gm-of-the-year').value;
        if (gmHandle && allGms.has(gmHandle)) {
            const gm = allGms.get(gmHandle);
            const docRef = doc(awardsCollectionRef, 'gm-of-the-year');
            batch.set(docRef, { award_name: 'GM of the Year', gm_handle: gmHandle, team_id: gm.team_id });
        }

        // --- Process Team Awards ---
        const teamAwards = ['league-champion', 'regular-season-title'];
        for (const id of teamAwards) {
            const teamId = document.getElementById(`award-${id}`).value;
            if (teamId) {
                const team = allTeams.find(t => t.id === teamId);
                const docRef = doc(awardsCollectionRef, id);
                batch.set(docRef, { award_name: id.replace(/-/g, ' '), team_id: team.id, team_name: team.team_name });
            }
        }

        // --- Process All-Star & Rising Star Lists ---
        const listAwards = ['all-stars-eastern', 'all-stars-western', 'rising-stars-eastern', 'rising-stars-western'];
        for (const id of listAwards) {
            const players = [];
            const inputs = document.getElementById(id).querySelectorAll('input');
            inputs.forEach(input => {
                const handle = input.value;
                if (handle && allPlayers.has(handle)) {
                    const player = allPlayers.get(handle);
                    players.push({ player_handle: player.player_handle, player_id: player.id, team_id: player.current_team_id });
                }
            });
            if (players.length > 0) {
                const docRef = doc(awardsCollectionRef, id);
                batch.set(docRef, { award_name: id.replace(/-/g, ' '), players: players });
            }
        }

        await batch.commit();
        alert('Manual awards saved successfully!');

    } catch (error) {
        console.error("Error saving awards:", error);
        alert('An error occurred. Check the console.');
    } finally {
        saveButton.disabled = false;
        saveButton.textContent = 'Save All Manual Awards';
    }
}

async function handleCalculationTrigger() {
    calculateBtn.disabled = true;
    calculateBtn.textContent = 'Calculating...';
    try {
        const calculatePerformanceAwards = httpsCallable(functions, 'calculatePerformanceAwards');
        const result = await calculatePerformanceAwards({ seasonId: currentSeasonId });
        alert(result.data.message);
        await loadExistingAwards(); // Refresh display
    } catch (error) {
        console.error("Error triggering award calculation:", error);
        alert(`Error: ${error.message}`);
    } finally {
        calculateBtn.disabled = false;
        calculateBtn.textContent = 'Run Performance Calculation';
    }
}
