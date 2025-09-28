// /admin/manage-players.js

import { auth, db, onAuthStateChanged, doc, getDoc, collection, getDocs, updateDoc, setDoc, query, httpsCallable, functions } from '/js/firebase-init.js';

// --- DEV ENVIRONMENT CONFIG ---
const USE_DEV_COLLECTIONS = false;
const getCollectionName = (baseName) => USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;

// --- Page Elements ---
const loadingContainer = document.getElementById('loading-container');
const adminContainer = document.getElementById('admin-container');
const authStatusDiv = document.getElementById('auth-status');
const searchInput = document.getElementById('player-search-input');
const playersListContainer = document.getElementById('players-list-container');
const playerModal = document.getElementById('player-modal');
const closeModalBtn = playerModal.querySelector('.close-btn-admin');
const playerForm = document.getElementById('player-form');
const createPlayerBtn = document.getElementById('create-player-btn');
const seasonSelect = document.getElementById('player-season-select');

let allPlayers = [];
let allTeams = new Map();
let currentSeasonId = "";
let isEditMode = false;

// --- Primary Auth Check ---
document.addEventListener('DOMContentLoaded', () => {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            const userRef = doc(db, getCollectionName("users"), user.uid);
            const userDoc = await getDoc(userRef);

            if (userDoc.exists() && userDoc.data().role === 'admin') {
                loadingContainer.style.display = 'none';
                adminContainer.style.display = 'block';
                authStatusDiv.innerHTML = `Welcome, Admin | <a href="#" id="logout-btn">Logout</a>`;
                addLogoutListener();
                initializePage();
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
        await populateSeasons();

        seasonSelect.addEventListener('change', async () => {
            currentSeasonId = seasonSelect.value;
            await updateTeamCache(currentSeasonId);
            await loadAndDisplayPlayers();
        });

        searchInput.addEventListener('input', () => {
            const searchTerm = searchInput.value.toLowerCase();
            const filteredPlayers = allPlayers.filter(player => player.player_handle.toLowerCase().includes(searchTerm));
            displayPlayers(filteredPlayers);
        });

    } catch (error) {
        console.error("Error initializing page:", error);
        playersListContainer.innerHTML = '<div class="error">Could not load player data.</div>';
    }
}

async function updateTeamCache(seasonId) {
    allTeams.clear();
    const teamsSnap = await getDocs(collection(db, getCollectionName("v2_teams")));

    const teamPromises = teamsSnap.docs.map(async (teamDoc) => {
        if (!teamDoc.data().conference) {
            return null;
        }

        const teamData = { id: teamDoc.id, ...teamDoc.data() };
        const seasonRecordRef = doc(db, getCollectionName("v2_teams"), teamDoc.id, getCollectionName("seasonal_records"), seasonId);
        const seasonRecordSnap = await getDoc(seasonRecordRef);

        if (seasonRecordSnap.exists()) {
            teamData.team_name = seasonRecordSnap.data().team_name;
        } else {
            teamData.team_name = "Name Not Found";
        }
        return teamData;
    });

    const teamsWithData = (await Promise.all(teamPromises)).filter(Boolean);
    teamsWithData.forEach(team => allTeams.set(team.id, team));
}
async function populateSeasons() {
    const seasonsSnap = await getDocs(query(collection(db, getCollectionName("seasons"))));
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

    await updateTeamCache(currentSeasonId);
    await loadAndDisplayPlayers();
}

async function loadAndDisplayPlayers() {
    playersListContainer.innerHTML = '<div class="loading">Loading players...</div>';
    try {
        const playersSnap = await getDocs(collection(db, getCollectionName("v2_players")));

        const playerPromises = playersSnap.docs.map(async (playerDoc) => {
            const playerData = { id: playerDoc.id, ...playerDoc.data() };
            const seasonStatsRef = doc(db, getCollectionName("v2_players"), playerDoc.id, getCollectionName("seasonal_stats"), currentSeasonId);
            const seasonStatsSnap = await getDoc(seasonStatsRef);
            if (seasonStatsSnap.exists()) {
                playerData.season_stats = seasonStatsSnap.data();
            } else {
                playerData.season_stats = { games_played: 0, WAR: 0, rookie: '0', all_star: '0' };
            }
            return playerData;
        });

        allPlayers = await Promise.all(playerPromises);
        allPlayers.sort((a, b) => (a.player_handle || '').localeCompare(b.player_handle));

        displayPlayers(allPlayers);
    } catch (error) {
        console.error(`Error loading players for season ${currentSeasonId}:`, error);
        playersListContainer.innerHTML = '<div class="error">Could not load player data.</div>';
    }
}

function displayPlayers(players) {
    if (players.length === 0) {
        playersListContainer.innerHTML = '<p class="placeholder-text">No players found.</p>';
        return;
    }

    const playersHTML = players.map(player => {
        const team = allTeams.get(player.current_team_id);
        return `
            <div class="player-entry">
                <div class="player-details">
                    <span class="player-handle">${player.player_handle}</span>
                    <span class="player-sub-details">Team: ${team?.team_name || 'Free Agent'} | Status: ${player.player_status || 'N/A'}</span>
                </div>
                <button class="btn-admin-edit" data-player-id="${player.id}">Edit</button>
            </div>
        `;
    }).join('');

    playersListContainer.innerHTML = playersHTML;
}

// --- Event Handlers and Modal Logic ---
playersListContainer.addEventListener('click', (e) => {
    if (e.target.matches('.btn-admin-edit')) {
        const playerId = e.target.dataset.playerId;
        const playerData = allPlayers.find(p => p.id === playerId);
        if (playerData) {
            openPlayerModal(playerData);
        }
    }
});

createPlayerBtn.addEventListener('click', () => {
    openPlayerModal();
});

function openPlayerModal(player = null) {
    playerForm.reset();
    isEditMode = !!player;

    const dangerZoneWrapper = document.getElementById('danger-zone-wrapper');
    const dangerZoneContainer = document.getElementById('danger-zone-container');

    document.getElementById('modal-title-player').textContent = isEditMode ? 'Edit Player' : 'Create New Player';
    document.getElementById('player-id-input').readOnly = isEditMode;

    if (isEditMode) {
        document.getElementById('player-id-input').value = player.id;
        document.getElementById('player-handle-input').value = player.player_handle || '';
        document.getElementById('player-status-select').value = player.player_status || 'ACTIVE';
        document.getElementById('player-rookie-checkbox').checked = player.season_stats?.rookie === '1';
        document.getElementById('player-allstar-checkbox').checked = player.season_stats?.all_star === '1';
        
        // MODIFICATION: Show the wrapper, but hide the content initially
        dangerZoneWrapper.style.display = 'block'; 
        dangerZoneContainer.style.display = 'none';
        document.getElementById('toggle-danger-zone-btn').textContent = 'Show Danger Zone';

    } else {
        document.getElementById('player-id-input').readOnly = false;
        document.getElementById('player-id-input').placeholder = "Enter a new unique ID (e.g. jdoe123)";
        document.getElementById('player-rookie-checkbox').checked = true;
        document.getElementById('player-allstar-checkbox').checked = false;

        dangerZoneWrapper.style.display = 'none'; 
    }

    const teamSelect = document.getElementById('player-team-select');
    const freeAgentOption = `<option value="FREE_AGENT">Free Agent</option>`;
    teamSelect.innerHTML = freeAgentOption + Array.from(allTeams.entries())
        .map(([id, team]) => `<option value="${id}" ${player && player.current_team_id === id ? 'selected' : ''}>${team.team_name}</option>`)
        .join('');

    if (isEditMode && player.current_team_id) {
        teamSelect.value = player.current_team_id;
    } else {
        teamSelect.value = "FREE_AGENT";
    }

    playerModal.style.display = 'block';
}

closeModalBtn.addEventListener('click', () => {
    playerModal.style.display = 'none';
});

playerModal.addEventListener('click', async (e) => {
    if (e.target.id === 'toggle-danger-zone-btn') {
        const dangerZoneContainer = document.getElementById('danger-zone-container');
        const isVisible = dangerZoneContainer.style.display === 'block';
        dangerZoneContainer.style.display = isVisible ? 'none' : 'block';
        e.target.textContent = isVisible ? 'Show Danger Zone' : 'Hide Danger Zone';
        return; 
    }

    if (e.target.id !== 'migrate-player-id-btn') return;

    const migrateBtn = e.target;
    const oldPlayerId = document.getElementById('player-id-input').value;
    const newPlayerId = document.getElementById('player-new-id-input').value.trim();

    if (!newPlayerId) {
        alert("Please enter the new Player ID to migrate to.");
        return;
    }

    const confirmation = confirm(
        `DANGER ZONE\n\nYou are about to migrate this player from ID:\n${oldPlayerId}\nTO a new ID:\n${newPlayerId}\n\nThis action will update all historical stats and records and cannot be undone. Are you absolutely sure you want to proceed?`
    );

    if (!confirmation) return;

    migrateBtn.disabled = true;
    migrateBtn.textContent = 'Migrating...';

    try {
        const admin_updatePlayerId = httpsCallable(functions, 'admin_updatePlayerId');
        const result = await admin_updatePlayerId({ oldPlayerId, newPlayerId });
        
        alert(result.data.message);
        playerModal.style.display = 'none';
        await loadAndDisplayPlayers(); 

    } catch (error) {
        console.error("Player ID migration failed:", error);
        alert(`Migration failed: ${error.message}`);
    } finally {
        migrateBtn.disabled = false;
        migrateBtn.textContent = 'Migrate to New ID';
    }
});

/**
 * MODIFICATION: The submit handler now calls a Cloud Function for edits to propagate
 * handle changes everywhere. Creating a player still happens client-side.
 */
playerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitButton = e.target.querySelector('button[type="submit"]');
    const playerId = document.getElementById('player-id-input').value.trim();
    if (!playerId) {
        alert("Player ID cannot be empty.");
        return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Saving...';

    try {
        if (isEditMode) {
            // For edits, we call the backend function to handle propagation
            const payload = {
                playerId: playerId,
                newPlayerHandle: document.getElementById('player-handle-input').value.trim(),
                newTeamId: document.getElementById('player-team-select').value,
                newStatus: document.getElementById('player-status-select').value,
                isRookie: document.getElementById('player-rookie-checkbox').checked,
                isAllStar: document.getElementById('player-allstar-checkbox').checked,
                seasonId: currentSeasonId
            };

            const admin_updatePlayerDetails = httpsCallable(functions, 'admin_updatePlayerDetails');
            const result = await admin_updatePlayerDetails(payload);
            alert(result.data.message);

        } else {
            // For creating a new player, we can do it on the client
            const newHandle = document.getElementById('player-handle-input').value.trim();
            const playerRef = doc(db, getCollectionName("v2_players"), playerId);
            const docSnap = await getDoc(playerRef);
            if (docSnap.exists()) {
                alert("A player with this ID already exists. Please choose a unique ID.");
                submitButton.disabled = false;
                submitButton.textContent = 'Save Player Changes';
                return;
            }
            
            await setDoc(playerRef, {
                player_handle: newHandle,
                current_team_id: document.getElementById('player-team-select').value,
                player_status: document.getElementById('player-status-select').value,
            });

            const seasonStatsRef = doc(playerRef, getCollectionName("seasonal_stats"), currentSeasonId);
            await setDoc(seasonStatsRef, {
                aag_mean: 0, aag_mean_pct: 0, aag_median: 0, aag_median_pct: 0, games_played: 0, GEM: 0, meansum: 0, medrank: 0, medsum: 0,
                post_aag_mean: 0, post_aag_mean_pct: 0, post_aag_median: 0, post_aag_median_pct: 0, post_games_played: 0, post_GEM: 0, post_meansum: 0,
                post_medrank: 0, post_medsum: 0, post_rel_mean: 0, post_rel_median: 0, post_total_points: 0, post_WAR: 0, rel_mean: 0, rel_median: 0,
                WAR: 0, total_points: 0,
                rookie: document.getElementById('player-rookie-checkbox').checked ? '1' : '0',
                all_star: document.getElementById('player-allstar-checkbox').checked ? '1' : '0'
            });
            alert('New player created successfully!');
        }

        await loadAndDisplayPlayers(); // Refresh the list
        playerModal.style.display = 'none';

    } catch (error) {
        console.error("Error saving player:", error);
        alert(`Failed to save player: ${error.message}`);
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = 'Save Player Changes';
    }
});


function addLogoutListener() {
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            auth.signOut().then(() => { window.location.href = '/login.html'; });
        });
    }
}
