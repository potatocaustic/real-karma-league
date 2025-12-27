// /admin/manage-players.js

import { auth, db, onAuthStateChanged, doc, getDoc, collection, getDocs, updateDoc, setDoc, query, httpsCallable, functions, getCurrentLeague, collectionNames, getLeagueCollectionName, orderBy, startAt, endAt, limit } from '/js/firebase-init.js';

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
const freeAgentsForm = document.getElementById('free-agents-form');
const freeAgentsHandlesInput = document.getElementById('free-agents-handles');
const initializeFreeAgentsBtn = document.getElementById('initialize-free-agents-btn');
const freeAgentsStatus = document.getElementById('free-agents-status');

let allTeams = new Map();
let currentSeasonId = "";
let isEditMode = false;
let listenersInitialized = false;
let displayedPlayers = [];
let searchDebounceId = null;

// --- Primary Auth Check ---
document.addEventListener('DOMContentLoaded', () => {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            const userRef = doc(db, collectionNames.users, user.uid);
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
            window.location.href = '/login.html?target=admin';
        }
    });
});

async function initializePage() {
    try {
        await populateSeasons();

        // Only add event listeners once
        if (!listenersInitialized) {
            seasonSelect.addEventListener('change', async () => {
                currentSeasonId = seasonSelect.value;
                await updateTeamCache(currentSeasonId);
                await handlePlayerSearch();
            });

            searchInput.addEventListener('input', () => {
                if (searchDebounceId) {
                    clearTimeout(searchDebounceId);
                }

                searchDebounceId = setTimeout(() => {
                    handlePlayerSearch();
                }, 250);
            });

            // Listen for league changes and reload the page data
            window.addEventListener('leagueChanged', async (event) => {
                console.log('League changed to:', event.detail.league);
                // Reload all data for the new league
                await initializePage();
            });

            listenersInitialized = true;
        }

    } catch (error) {
        console.error("Error initializing page:", error);
        playersListContainer.innerHTML = '<div class="error">Could not load player data.</div>';
    }
}

async function updateTeamCache(seasonId) {
    allTeams.clear();
    const teamsSnap = await getDocs(collection(db, collectionNames.teams));

    const teamPromises = teamsSnap.docs.map(async (teamDoc) => {
        if (!teamDoc.data().conference) {
            return null;
        }

        const teamData = { id: teamDoc.id, ...teamDoc.data() };
        const seasonRecordRef = doc(db, collectionNames.teams, teamDoc.id, collectionNames.seasonalRecords, seasonId);
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
    const seasonsSnap = await getDocs(query(collection(db, collectionNames.seasons)));
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
    showSearchPrompt();
}

async function handlePlayerSearch() {
    const searchTermRaw = searchInput.value.trim();

    if (!searchTermRaw) {
        displayedPlayers = [];
        showSearchPrompt();
        return;
    }

    playersListContainer.innerHTML = '<div class="loading">Searching players...</div>';

    try {
        const playersQuery = query(
            collection(db, collectionNames.players),
            orderBy('player_handle'),
            startAt(searchTermRaw),
            endAt(searchTermRaw + '\uf8ff'),
            limit(50)
        );

        const playersSnap = await getDocs(playersQuery);

        const playerPromises = playersSnap.docs.map(async (playerDoc) => {
            const playerData = { id: playerDoc.id, ...playerDoc.data() };
            const seasonStatsRef = doc(db, collectionNames.players, playerDoc.id, collectionNames.seasonalStats, currentSeasonId);
            const seasonStatsSnap = await getDoc(seasonStatsRef);
            if (seasonStatsSnap.exists()) {
                playerData.season_stats = seasonStatsSnap.data();
            } else {
                playerData.season_stats = { games_played: 0, WAR: 0, rookie: '0', all_star: '0' };
            }
            return playerData;
        });

        displayedPlayers = await Promise.all(playerPromises);
        displayedPlayers.sort((a, b) => (a.player_handle || '').localeCompare(b.player_handle));

        displayPlayers(displayedPlayers);
    } catch (error) {
        console.error(`Error searching players for season ${currentSeasonId}:`, error);
        playersListContainer.innerHTML = '<div class="error">Could not load player data.</div>';
    }
}

function showSearchPrompt() {
    playersListContainer.innerHTML = '<p class="placeholder-text">Start typing a player handle to search.</p>';
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
        const playerData = displayedPlayers.find(p => p.id === playerId);
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
        const result = await admin_updatePlayerId({ oldPlayerId, newPlayerId, league: getCurrentLeague() });

        alert(result.data.message);
        playerModal.style.display = 'none';
        await handlePlayerSearch();

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
            const result = await admin_updatePlayerDetails({ ...payload, league: getCurrentLeague() });
            alert(result.data.message);

        } else {
            // For creating a new player, we can do it on the client
            const newHandle = document.getElementById('player-handle-input').value.trim();

            // Explicitly get the current league and collection name to ensure correct duplicate check
            const currentLeague = getCurrentLeague();
            const playersCollectionName = getLeagueCollectionName('v2_players', currentLeague);
            console.log(`[Create Player] Checking for duplicate in collection: ${playersCollectionName} (league: ${currentLeague})`);

            const playerRef = doc(db, playersCollectionName, playerId);
            const docSnap = await getDoc(playerRef);
            if (docSnap.exists()) {
                alert(`A player with this ID already exists in the ${currentLeague} league. Please choose a unique ID.`);
                submitButton.disabled = false;
                submitButton.textContent = 'Save Player Changes';
                return;
            }

            await setDoc(playerRef, {
                player_handle: newHandle,
                current_team_id: document.getElementById('player-team-select').value,
                player_status: document.getElementById('player-status-select').value,
            });

            const seasonalStatsCollectionName = getLeagueCollectionName('seasonal_stats', currentLeague);
            const seasonStatsRef = doc(playerRef, seasonalStatsCollectionName, currentSeasonId);
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

        await handlePlayerSearch(); // Refresh the list
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
            auth.signOut().then(() => { window.location.href = '/login.html?target=admin'; });
        });
    }
}

// --- Free Agents Management ---
freeAgentsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const handles = freeAgentsHandlesInput.value.trim();

    if (!handles) {
        freeAgentsStatus.textContent = 'Please enter at least one player handle.';
        freeAgentsStatus.style.color = '#dc3545';
        return;
    }

    const submitBtn = freeAgentsForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Adding...';
    freeAgentsStatus.textContent = 'Processing...';
    freeAgentsStatus.style.color = '#666';

    try {
        const addFreeAgents = httpsCallable(functions, 'addFreeAgents');
        const result = await addFreeAgents({ handles, league: getCurrentLeague() });

        freeAgentsStatus.textContent = result.data.message;
        freeAgentsStatus.style.color = '#28a745';
        freeAgentsHandlesInput.value = '';
    } catch (error) {
        console.error('Error adding free agents:', error);
        freeAgentsStatus.textContent = `Error: ${error.message}`;
        freeAgentsStatus.style.color = '#dc3545';
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Add to Free Agent Pool';
    }
});

initializeFreeAgentsBtn.addEventListener('click', async () => {
    const confirmation = confirm(
        'This will scan all players in the database with FREE_AGENT status and add them to the free agent tracking pool. Continue?'
    );

    if (!confirmation) return;

    initializeFreeAgentsBtn.disabled = true;
    initializeFreeAgentsBtn.textContent = 'Initializing...';
    freeAgentsStatus.textContent = 'Scanning database for free agents...';
    freeAgentsStatus.style.color = '#666';

    try {
        const initializeFreeAgents = httpsCallable(functions, 'initializeFreeAgents');
        const result = await initializeFreeAgents({ league: getCurrentLeague() });

        freeAgentsStatus.textContent = result.data.message;
        freeAgentsStatus.style.color = '#28a745';
    } catch (error) {
        console.error('Error initializing free agents:', error);
        freeAgentsStatus.textContent = `Error: ${error.message}`;
        freeAgentsStatus.style.color = '#dc3545';
    } finally {
        initializeFreeAgentsBtn.disabled = false;
        initializeFreeAgentsBtn.textContent = 'Initialize from Database';
    }
});
