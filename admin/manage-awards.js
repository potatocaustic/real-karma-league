// /admin/manage-awards.js

import { auth, db, functions, onAuthStateChanged, signOut, doc, getDoc, collection, getDocs, writeBatch, httpsCallable, query } from '/js/firebase-init.js';

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
            if (user.isAnonymous) {
                await signOut(auth);
                window.location.href = '/login.html';
                return;
            }

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
        // Fetch players (not dependent on season selection)
        const playersSnap = await getDocs(collection(db, "v2_players"));
        playersSnap.docs.forEach(doc => {
            if (doc.data().player_status === 'ACTIVE') {
                allPlayers.set(doc.data().player_handle, { id: doc.id, ...doc.data() });
            }
        });

        // This will now handle fetching teams and populating dropdowns
        await populateSeasons();

        seasonSelect.addEventListener('change', async () => {
            currentSeasonId = seasonSelect.value;
            // On season change, re-fetch team data for that season
            await updateTeamCache(currentSeasonId);
            // Then, re-populate dropdowns and load the awards for the new season
            populateDatalistAndSelects();
            loadExistingAwards();
        });

        awardsForm.addEventListener('submit', handleFormSubmit);
        calculateBtn.addEventListener('click', handleCalculationTrigger);

    } catch (error) {
        console.error("Error initializing awards page:", error);
        adminContainer.innerHTML = `<div class="error">Could not load required league data.</div>`;
    }
}

async function updateTeamCache(seasonId) {
    const teamsSnap = await getDocs(collection(db, "v2_teams"));
    const teamPromises = teamsSnap.docs.map(async (teamDoc) => {
        if (!teamDoc.data().conference) return null;

        const teamData = { id: teamDoc.id, ...teamDoc.data() };
        const seasonRecordRef = doc(db, "v2_teams", teamDoc.id, "seasonal_records", seasonId);
        const seasonRecordSnap = await getDoc(seasonRecordRef);

        teamData.team_name = seasonRecordSnap.exists() ? seasonRecordSnap.data().team_name : "Name Not Found";
        return teamData;
    });

    // Update the global allTeams array and sort it
    allTeams = (await Promise.all(teamPromises))
        .filter(Boolean)
        .sort((a, b) => a.team_name.localeCompare(b.team_name));
}

async function populateSeasons() {
    const seasonsSnap = await getDocs(query(collection(db, "seasons")));
    let activeSeasonId = null;
    const sortedDocs = seasonsSnap.docs.sort((a, b) => b.id.localeCompare(a.id));

    seasonSelect.innerHTML = sortedDocs.map(doc => {
        const seasonData = doc.data();
        if (seasonData.status === 'active') {
            activeSeasonId = doc.id;
        }
        return `<option value="${doc.id}">${seasonData.season_name}</option>`;
    }).join('');

    if (activeSeasonId) {
        seasonSelect.value = activeSeasonId;
    }

    currentSeasonId = seasonSelect.value;

    // Fetch team data for the initial season before populating UI
    await updateTeamCache(currentSeasonId);
    populateDatalistAndSelects();
    await loadExistingAwards();
}

function populateDatalistAndSelects() {
    playerDatalist.innerHTML = Array.from(allPlayers.keys()).map(handle => `<option value="${handle}"></option>`).join('');

    // Re-populate GMs and Team dropdowns using the newly cached `allTeams` array
    allGms.clear();
    allTeams.forEach(team => {
        if (team.current_gm_handle) {
            allGms.set(team.current_gm_handle, { team_id: team.id, team_name: team.team_name });
        }
    });

    gmDatalist.innerHTML = Array.from(allGms.keys()).map(handle => `<option value="${handle}"></option>`).join('');

    const teamOptions = `<option value="">-- Select Team --</option>` + allTeams.map(t => `<option value="${t.id}">${t.team_name}</option>`).join('');
    document.querySelectorAll('.team-select').forEach(select => select.innerHTML = teamOptions);

    document.getElementById('all-stars-eastern').innerHTML = '';
    document.getElementById('all-stars-western').innerHTML = '';
    document.getElementById('rising-stars-eastern').innerHTML = '';
    document.getElementById('rising-stars-western').innerHTML = '';

    for (let i = 1; i <= 8; i++) {
        document.getElementById('all-stars-eastern').innerHTML += `<input type="text" list="player-datalist" placeholder="East All-Star #${i}" autocomplete="off">`;
        document.getElementById('all-stars-western').innerHTML += `<input type="text" list="player-datalist" placeholder="West All-Star #${i}" autocomplete="off">`;
        document.getElementById('rising-stars-eastern').innerHTML += `<input type="text" list="player-datalist" placeholder="East Rising Star #${i}" autocomplete="off">`;
        document.getElementById('rising-stars-western').innerHTML += `<input type="text" list="player-datalist" placeholder="West Rising Star #${i}" autocomplete="off">`;
    }
}

async function loadExistingAwards() {
    awardsForm.reset(); // Clear previous selections

    if (!currentSeasonId) return;
    const seasonNumber = currentSeasonId.replace('S', '');
    const awardsCollectionRef = collection(db, `awards/season_${seasonNumber}/S${seasonNumber}_awards`);
    const awardsSnap = await getDocs(awardsCollectionRef);

    if (awardsSnap.empty) {
        console.log("No existing awards found for this season.");
        // Clear displays for auto-calculated awards
        document.getElementById('best-player-performance-display').textContent = 'Not yet calculated.';
        document.getElementById('best-team-performance-display').textContent = 'Not yet calculated.';
        return;
    }

    const awardsData = new Map();
    awardsSnap.forEach(doc => awardsData.set(doc.id, doc.data()));

    const singleAwards = ['finals-mvp', 'rookie-of-the-year', 'sixth-man', 'most-improved', 'lvp'];
    singleAwards.forEach(id => {
        const award = awardsData.get(id);
        const element = document.getElementById(`award-${id}`);
        if (element) element.value = award?.player_handle || '';
    });

    const gmAward = awardsData.get('gm-of-the-year');
    const gmElement = document.getElementById('award-gm-of-the-year');
    if (gmElement) gmElement.value = gmAward?.gm_handle || '';

    const teamAwards = ['league-champion', 'regular-season-title'];
    teamAwards.forEach(id => {
        const award = awardsData.get(id);
        const element = document.getElementById(`award-${id}`);
        if (element) element.value = award?.team_id || '';
    });

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

    const bestPlayer = awardsData.get('best_performance_player');
    const bestPlayerDisplay = document.getElementById('best-player-performance-display');
    if (bestPlayer && bestPlayerDisplay) {
        bestPlayerDisplay.textContent = `${bestPlayer.player_handle} (${(bestPlayer.value * 100).toFixed(2)}% above median)`;
    } else if (bestPlayerDisplay) {
        bestPlayerDisplay.textContent = 'Not yet calculated.';
    }

    const bestTeam = awardsData.get('best_performance_team');
    const bestTeamDisplay = document.getElementById('best-team-performance-display');
    if (bestTeam && bestTeamDisplay) {
        bestTeamDisplay.textContent = `${bestTeam.team_name} (${(bestTeam.value * 100).toFixed(2)}% above median)`;
    } else if (bestTeamDisplay) {
        bestTeamDisplay.textContent = 'Not yet calculated.';
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

        const singleAwards = ['finals-mvp', 'rookie-of-the-year', 'sixth-man', 'most-improved', 'lvp'];
        for (const id of singleAwards) {
            const handle = document.getElementById(`award-${id}`).value;
            const docRef = doc(awardsCollectionRef, id);
            if (handle && allPlayers.has(handle)) {
                const player = allPlayers.get(handle);
                batch.set(docRef, { award_name: id.replace(/-/g, ' '), player_handle: player.player_handle, player_id: player.id, team_id: player.current_team_id });
            } else {
                batch.delete(docRef);
            }
        }

        const gmHandle = document.getElementById('award-gm-of-the-year').value;
        const gmDocRef = doc(awardsCollectionRef, 'gm-of-the-year');
        if (gmHandle && allGms.has(gmHandle)) {
            const gm = allGms.get(gmHandle);
            batch.set(gmDocRef, { award_name: 'GM of the Year', gm_handle: gmHandle, team_id: gm.team_id });
        } else {
            batch.delete(gmDocRef);
        }

        const teamAwards = ['league-champion', 'regular-season-title'];
        for (const id of teamAwards) {
            const teamId = document.getElementById(`award-${id}`).value;
            const docRef = doc(awardsCollectionRef, id);
            if (teamId) {
                const team = allTeams.find(t => t.id === teamId);
                batch.set(docRef, { award_name: id.replace(/-/g, ' '), team_id: team.id, team_name: team.team_name });
            } else {
                batch.delete(docRef);
            }
        }

        const listAwards = ['all-stars-eastern', 'all-stars-western', 'rising-stars-eastern', 'rising-stars-western'];
        for (const id of listAwards) {
            const players = [];
            const inputs = document.getElementById(id).querySelectorAll('input');
            inputs.forEach(input => {
                const handle = input.value.trim();
                if (handle && allPlayers.has(handle)) {
                    const player = allPlayers.get(handle);
                    players.push({ player_handle: player.player_handle, player_id: player.id, team_id: player.current_team_id });
                }
            });
            const docRef = doc(awardsCollectionRef, id);
            if (players.length > 0) {
                batch.set(docRef, { award_name: id.replace(/-/g, ' '), players: players });
            } else {
                batch.delete(docRef);
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