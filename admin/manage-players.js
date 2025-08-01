// /admin/manage-players.js

import { auth, db, onAuthStateChanged, doc, getDoc, collection, getDocs, updateDoc, setDoc, arrayUnion } from '/js/firebase-init.js';

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
let allTeams = new Map(); // Use a Map for efficient team lookups
let currentSeasonId = "S7"; // Hardcode for now
let isEditMode = false;

// --- Primary Auth Check ---
document.addEventListener('DOMContentLoaded', () => {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            const userRef = doc(db, "users", user.uid);
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

// --- Initialization and Data Fetching ---
async function initializePage() {
    try {
        // Fetch teams once
        const teamsSnap = await getDocs(collection(db, "v2_teams"));
        teamsSnap.docs.forEach(doc => allTeams.set(doc.id, doc.data()));

        // Populate seasons and trigger initial player load
        await populateSeasons();

        seasonSelect.addEventListener('change', () => {
            currentSeasonId = seasonSelect.value;
            loadAndDisplayPlayers();
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
    await loadAndDisplayPlayers();
}

async function loadAndDisplayPlayers() {
    playersListContainer.innerHTML = '<div class="loading">Loading players...</div>';
    try {
        const playersSnap = await getDocs(collection(db, "v2_players"));

        const playerPromises = playersSnap.docs.map(async (playerDoc) => {
            const playerData = { id: playerDoc.id, ...playerDoc.data() };
            // MODIFIED: Fetch stats for the currently selected season
            const seasonStatsRef = doc(db, "v2_players", playerDoc.id, "seasonal_stats", currentSeasonId);
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

    document.getElementById('modal-title-player').textContent = isEditMode ? 'Edit Player' : 'Create New Player';
    document.getElementById('player-id-input').readOnly = isEditMode;

    if (isEditMode) {
        document.getElementById('player-id-input').value = player.id;
        document.getElementById('player-handle-input').value = player.player_handle || '';
        document.getElementById('player-status-select').value = player.player_status || 'ACTIVE';
        // MODIFIED: Use seasonal stats for accolades
        document.getElementById('player-rookie-checkbox').checked = player.season_stats?.rookie === '1';
        document.getElementById('player-allstar-checkbox').checked = player.season_stats?.all_star === '1';
    } else {
        document.getElementById('player-id-input').readOnly = false;
        document.getElementById('player-id-input').placeholder = "Enter a new unique ID (e.g. jdoe123)";
        // Defaults for a new player
        document.getElementById('player-rookie-checkbox').checked = true;
        document.getElementById('player-allstar-checkbox').checked = false;
    }

    const teamSelect = document.getElementById('player-team-select');
    const freeAgentOption = `<option value="FREE_AGENT">Free Agent</option>`;
    teamSelect.innerHTML = freeAgentOption + Array.from(allTeams.entries())
        .map(([id, team]) => `<option value="${id}" ${player && player.current_team_id === id ? 'selected' : ''}>${team.team_name}</option>`)
        .join('');

    // CORRECTED: The variable is 'isEditMode', not 'is_edit_mode'.
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

playerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const playerId = document.getElementById('player-id-input').value.trim();
    if (!playerId) {
        alert("Player ID cannot be empty.");
        return;
    }

    const newHandle = document.getElementById('player-handle-input').value.trim();
    const playerRef = doc(db, "v2_players", playerId);
    const seasonStatsRef = doc(playerRef, "seasonal_stats", currentSeasonId);

    try {
        if (isEditMode) {
            const originalPlayer = allPlayers.find(p => p.id === playerId);
            const oldHandle = originalPlayer ? originalPlayer.player_handle : null;

            // Update static data
            const updateData = {
                player_handle: newHandle,
                current_team_id: document.getElementById('player-team-select').value,
                player_status: document.getElementById('player-status-select').value,
            };
            if (oldHandle && oldHandle !== newHandle) {
                updateData.aliases = arrayUnion(oldHandle);
            }
            await updateDoc(playerRef, updateData);

            // MODIFIED: Update seasonal data in its own document
            const seasonalUpdateData = {
                rookie: document.getElementById('player-rookie-checkbox').checked ? '1' : '0',
                all_star: document.getElementById('player-allstar-checkbox').checked ? '1' : '0'
            };
            await setDoc(seasonStatsRef, seasonalUpdateData, { merge: true });

            alert('Player updated successfully!');
        } else {
            const staticDataToSave = {
                player_handle: newHandle,
                current_team_id: document.getElementById('player-team-select').value,
                player_status: document.getElementById('player-status-select').value,
            };
            const docSnap = await getDoc(playerRef);
            if (docSnap.exists()) {
                alert("A player with this ID already exists. Please choose a unique ID.");
                return;
            }
            await setDoc(playerRef, staticDataToSave);

            const initialStats = {
                aag_mean: 0, aag_mean_pct: 0, aag_median: 0, aag_median_pct: 0, games_played: 0, GEM: 0, meansum: 0, medrank: 0, medsum: 0,
                post_aag_mean: 0, post_aag_mean_pct: 0, post_aag_median: 0, post_aag_median_pct: 0, post_games_played: 0, post_GEM: 0, post_meansum: 0,
                post_medrank: 0, post_medsum: 0, post_rel_mean: 0, post_rel_median: 0, post_total_points: 0, post_WAR: 0, rel_mean: 0, rel_median: 0,
                WAR: 0, total_points: 0,
                rookie: document.getElementById('player-rookie-checkbox').checked ? '1' : '0',
                all_star: document.getElementById('player-allstar-checkbox').checked ? '1' : '0'
            };
            await setDoc(seasonStatsRef, initialStats);
            alert('New player created successfully!');
        }

        await initializePage();
        playerModal.style.display = 'none';

    } catch (error) {
        console.error("Error saving player:", error);
        alert('Failed to save player. Check the console for details.');
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