// /admin/manage-players.js

import { auth, db, onAuthStateChanged, doc, getDoc, collection, getDocs, updateDoc, setDoc } from '/js/firebase-init.js';

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

let allPlayers = [];
let allTeams = [];
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
        const [playersSnap, teamsSnap] = await Promise.all([
            getDocs(collection(db, "new_players")),
            getDocs(collection(db, "new_teams"))
        ]);

        // The document ID is now the player_id, which is stored as 'id'
        allPlayers = playersSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        allTeams = teamsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        allPlayers.sort((a, b) => a.player_handle.localeCompare(b.player_handle));
        allTeams.sort((a, b) => a.team_name.localeCompare(b.team_name));

        displayPlayers(allPlayers);

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

function displayPlayers(players) {
    if (players.length === 0) {
        playersListContainer.innerHTML = '<p class="placeholder-text">No players found.</p>';
        return;
    }

    const playersHTML = players.map(player => {
        const team = allTeams.find(t => t.id === player.current_team_id);
        return `
            <div class="player-entry">
                <div class="player-details">
                    <span class="player-handle">${player.player_handle}</span>
                    <span class="player-sub-details">Team: ${team?.team_name || 'N/A'} | Status: ${player.player_status || 'N/A'}</span>
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
    openPlayerModal(); // Call with no player data for creation mode
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
        document.getElementById('player-rookie-checkbox').checked = player.rookie === '1';
        document.getElementById('player-allstar-checkbox').checked = player.all_star === '1';
    } else {
        // For new players, the admin must create a unique ID.
        document.getElementById('player-id-input').readOnly = false;
        document.getElementById('player-id-input').placeholder = "Enter a new unique ID (e.g. jdoe123)";
    }

    // Populate team dropdown
    const teamSelect = document.getElementById('player-team-select');
    const freeAgentOption = `<option value="FREE_AGENT">Free Agent</option>`;
    teamSelect.innerHTML = freeAgentOption + allTeams
        .map(team => `<option value="${team.id}" ${player && player.current_team_id === team.id ? 'selected' : ''}>${team.team_name}</option>`)
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

playerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const playerId = document.getElementById('player-id-input').value.trim();
    if (!playerId) {
        alert("Player ID cannot be empty.");
        return;
    }

    const dataToSave = {
        player_handle: document.getElementById('player-handle-input').value.trim(),
        current_team_id: document.getElementById('player-team-select').value,
        player_status: document.getElementById('player-status-select').value,
        rookie: document.getElementById('player-rookie-checkbox').checked ? '1' : '0',
        all_star: document.getElementById('player-allstar-checkbox').checked ? '1' : '0'
    };

    const playerRef = doc(db, "new_players", playerId);

    try {
        if (isEditMode) {
            // Editing existing player - we use updateDoc
            await updateDoc(playerRef, dataToSave);
            alert('Player updated successfully!');
        } else {
            // Creating a new player - we use setDoc
            const docSnap = await getDoc(playerRef);
            if (docSnap.exists()) {
                alert("A player with this ID already exists. Please choose a unique ID.");
                return;
            }
            // Add default stats for a new player
            dataToSave.games_played = 0;
            dataToSave.total_points = 0;
            // ... etc.

            await setDoc(playerRef, dataToSave);
            alert('New player created successfully!');
        }

        await initializePage(); // Refresh list from DB
        playerModal.style.display = 'none';

    } catch (error) {
        console.error("Error saving player:", error);
        alert('Failed to save player.');
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