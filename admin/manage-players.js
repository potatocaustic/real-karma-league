// /admin/manage-players.js

import { auth, db, onAuthStateChanged, doc, getDoc, collection, getDocs, updateDoc } from '/js/firebase-init.js';

// --- Page Elements ---
const loadingContainer = document.getElementById('loading-container');
const adminContainer = document.getElementById('admin-container');
const authStatusDiv = document.getElementById('auth-status');
const searchInput = document.getElementById('player-search-input');
const playersListContainer = document.getElementById('players-list-container');
const playerModal = document.getElementById('player-modal');
const closeModalBtn = playerModal.querySelector('.close-btn-admin');
const playerForm = document.getElementById('player-form');

let allPlayers = [];
let allTeams = [];

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
            getDocs(collection(db, "new_players")), // CORRECTED LINE
            getDocs(collection(db, "new_teams"))
        ]);

        allPlayers = playersSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        allTeams = teamsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // Sort players alphabetically by handle
        allPlayers.sort((a, b) => a.id.localeCompare(b.id));

        displayPlayers(allPlayers);

        searchInput.addEventListener('input', () => {
            const searchTerm = searchInput.value.toLowerCase();
            const filteredPlayers = allPlayers.filter(player => player.id.toLowerCase().includes(searchTerm));
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
                    <span class="player-handle">${player.id}</span>
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

function openPlayerModal(player) {
    document.getElementById('player-id-input').value = player.id;
    document.getElementById('player-handle-display').textContent = player.id;

    // Populate team dropdown
    const teamSelect = document.getElementById('player-team-select');
    teamSelect.innerHTML = allTeams
        .sort((a, b) => a.team_name.localeCompare(b.team_name))
        .map(team => `<option value="${team.id}" ${player.current_team_id === team.id ? 'selected' : ''}>${team.team_name}</option>`)
        .join('');

    // Set status and accolades
    document.getElementById('player-status-select').value = player.player_status || 'ACTIVE';
    document.getElementById('player-rookie-checkbox').checked = player.rookie === '1';
    document.getElementById('player-allstar-checkbox').checked = player.all_star === '1';

    playerModal.style.display = 'block';
}

closeModalBtn.addEventListener('click', () => {
    playerModal.style.display = 'none';
});

playerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const playerId = document.getElementById('player-id-input').value;

    const updatedData = {
        current_team_id: document.getElementById('player-team-select').value,
        player_status: document.getElementById('player-status-select').value,
        rookie: document.getElementById('player-rookie-checkbox').checked ? '1' : '0',
        all_star: document.getElementById('player-allstar-checkbox').checked ? '1' : '0'
    };

    const playerRef = doc(db, "new_players", playerId); // CORRECTED LINE

    try {
        await updateDoc(playerRef, updatedData);
        alert('Player updated successfully!');

        // Update local data and refresh list
        const playerIndex = allPlayers.findIndex(p => p.id === playerId);
        if (playerIndex > -1) {
            allPlayers[playerIndex] = { ...allPlayers[playerIndex], ...updatedData };
        }
        displayPlayers(allPlayers.filter(p => p.id.toLowerCase().includes(searchInput.value.toLowerCase())));

        playerModal.style.display = 'none';
    } catch (error) {
        console.error("Error updating player:", error);
        alert('Failed to update player.');
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