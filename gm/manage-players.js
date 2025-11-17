// /gm/manage-players.js

import { auth, db, onAuthStateChanged, doc, getDoc, collection, getDocs, updateDoc, query, where, collectionNames } from '/js/firebase-init.js';

// --- Page Elements ---
const loadingContainer = document.getElementById('loading-container');
const gmContainer = document.getElementById('gm-container');
const authStatusDiv = document.getElementById('auth-status');
const searchInput = document.getElementById('player-search-input');
const playersListContainer = document.getElementById('players-list-container');
const playerModal = document.getElementById('player-modal');
const closeModalBtn = playerModal.querySelector('.close-btn-admin');
const playerForm = document.getElementById('player-form');

let allPlayers = [];
let currentUser = null;
let gmTeamId = null;
let currentSeasonId = "";

// --- Primary Auth Check ---
document.addEventListener('DOMContentLoaded', () => {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            currentUser = user;
            const userRef = doc(db, collectionNames.users, user.uid);
            const userDoc = await getDoc(userRef);

            if (userDoc.exists() && (userDoc.data().role === 'gm' || userDoc.data().role === 'admin')) {
                gmTeamId = userDoc.data().team_id;

                if (!gmTeamId) {
                    loadingContainer.innerHTML = '<div class="error">Error: GM team not assigned.</div>';
                    return;
                }

                loadingContainer.style.display = 'none';
                gmContainer.style.display = 'block';
                authStatusDiv.innerHTML = `Welcome, GM | <a href="#" id="logout-btn">Logout</a>`;
                addLogoutListener();
                await initializePage();
            } else {
                loadingContainer.innerHTML = '<div class="error">Access Denied. GM role required.</div>';
            }
        } else {
            window.location.href = '/login.html';
        }
    });
});

async function initializePage() {
    try {
        // Get active season
        const seasonsQuery = query(collection(db, collectionNames.seasons), where('status', '==', 'active'));
        const seasonsSnap = await getDocs(seasonsQuery);

        if (seasonsSnap.empty) {
            playersListContainer.innerHTML = '<div class="error">No active season found.</div>';
            return;
        }

        currentSeasonId = seasonsSnap.docs[0].id;

        await loadAndDisplayPlayers();

        searchInput.addEventListener('input', () => {
            const searchTerm = searchInput.value.toLowerCase();
            const filteredPlayers = allPlayers.filter(player =>
                player.player_handle.toLowerCase().includes(searchTerm)
            );
            displayPlayers(filteredPlayers);
        });

    } catch (error) {
        console.error("Error initializing page:", error);
        playersListContainer.innerHTML = '<div class="error">Could not load player data.</div>';
    }
}

async function loadAndDisplayPlayers() {
    playersListContainer.innerHTML = '<div class="loading">Loading players...</div>';
    try {
        // Query only players on the GM's team in the current season
        const playersQuery = query(
            collection(db, collectionNames.players),
            where('current_team_id', '==', gmTeamId)
        );
        const playersSnap = await getDocs(playersQuery);

        const playerPromises = playersSnap.docs.map(async (playerDoc) => {
            const playerData = { id: playerDoc.id, ...playerDoc.data() };

            // Get seasonal stats for current season to verify they played this season
            const seasonStatsRef = doc(db, collectionNames.players, playerDoc.id, collectionNames.seasonalStats, currentSeasonId);
            const seasonStatsSnap = await getDoc(seasonStatsRef);

            if (seasonStatsSnap.exists()) {
                playerData.season_stats = seasonStatsSnap.data();
                return playerData;
            }
            return null; // Skip players without stats this season
        });

        const playersWithStats = (await Promise.all(playerPromises)).filter(Boolean);
        allPlayers = playersWithStats.sort((a, b) => (a.player_handle || '').localeCompare(b.player_handle));

        displayPlayers(allPlayers);
    } catch (error) {
        console.error(`Error loading players for team ${gmTeamId}:`, error);
        playersListContainer.innerHTML = '<div class="error">Could not load player data.</div>';
    }
}

function displayPlayers(players) {
    if (players.length === 0) {
        playersListContainer.innerHTML = '<p class="placeholder-text">No players found on your team for the current season.</p>';
        return;
    }

    const playersHTML = players.map(player => {
        return `
            <div class="player-entry">
                <div class="player-details">
                    <span class="player-handle">${player.player_handle}</span>
                    <span class="player-sub-details">Status: ${player.player_status || 'N/A'}</span>
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
    playerForm.reset();

    document.getElementById('modal-title-player').textContent = 'Edit Player';
    document.getElementById('player-handle-input').value = player.player_handle || '';

    // Store player ID in a data attribute for submission
    playerForm.dataset.playerId = player.id;

    playerModal.style.display = 'block';
}

closeModalBtn.addEventListener('click', () => {
    playerModal.style.display = 'none';
});

playerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitButton = e.target.querySelector('button[type="submit"]');
    const playerId = playerForm.dataset.playerId;
    const newHandle = document.getElementById('player-handle-input').value.trim();

    if (!newHandle) {
        alert("Player handle cannot be empty.");
        return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Saving...';

    try {
        // Update player handle in the main player document
        const playerRef = doc(db, collectionNames.players, playerId);
        await updateDoc(playerRef, {
            player_handle: newHandle
        });

        alert('Player handle updated successfully!');
        await loadAndDisplayPlayers(); // Refresh the list
        playerModal.style.display = 'none';

    } catch (error) {
        console.error("Error saving player:", error);
        alert(`Failed to save player: ${error.message}`);
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = 'Save Changes';
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
