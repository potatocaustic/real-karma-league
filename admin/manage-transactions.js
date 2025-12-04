// /admin/manage-transactions.js

import { auth, db, onAuthStateChanged, doc, getDoc, collection, getDocs, httpsCallable, functions, serverTimestamp, query, where, getCurrentLeague, collectionNames, getLeagueCollectionName, updateDoc, increment } from '/js/firebase-init.js';

// --- Page Elements ---
const loadingContainer = document.getElementById('loading-container');
const adminContainer = document.getElementById('admin-container');
const authStatusDiv = document.getElementById('auth-status');
const transactionForm = document.getElementById('transaction-form');
const typeSelect = document.getElementById('transaction-type-select');
const feedbackContainer = document.getElementById('transaction-feedback');
const cutTeamFilter = document.getElementById('cut-team-filter-select');
const retireTeamFilter = document.getElementById('retire-team-filter-select');


let allPlayers = [];
let allTeams = [];
let allPicks = [];
let listenersInitialized = false;
let activeSeasonId = '';
let preserveFeedbackOnReset = false;

// --- Primary Auth Check & Initialization ---
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
                await initializePage();
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
        const seasonsQuery = query(collection(db, collectionNames.seasons), where("status", "==", "active"));
        const activeSeasonsSnap = await getDocs(seasonsQuery);
        activeSeasonId = !activeSeasonsSnap.empty ? activeSeasonsSnap.docs[0].id : null;

        if (!activeSeasonId) {
            throw new Error("Could not determine the active season to fetch team names.");
        }

        const [playersSnap, teamsSnap, picksSnap] = await Promise.all([
            getDocs(collection(db, collectionNames.players)),
            getDocs(collection(db, collectionNames.teams)),
            getDocs(collection(db, collectionNames.draftPicks))
        ]);

        allPlayers = playersSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        allPicks = picksSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        const teamPromises = teamsSnap.docs.map(async (teamDoc) => {
            if (!teamDoc.data().conference) return null;
            const teamData = { id: teamDoc.id, ...teamDoc.data() };
            const seasonRecordRef = doc(db, collectionNames.teams, teamDoc.id, collectionNames.seasonalRecords, activeSeasonId);
            const seasonRecordSnap = await getDoc(seasonRecordRef);
            teamData.team_name = seasonRecordSnap.exists() ? seasonRecordSnap.data().team_name : "Name Not Found";
            return teamData;
        });

        allTeams = (await Promise.all(teamPromises))
            .filter(Boolean)
            .sort((a, b) => a.team_name.localeCompare(b.team_name));

        // Only set up event listeners once
        if (!listenersInitialized) {
            setupEventListeners();

            // Listen for league changes and reload the page data
            window.addEventListener('leagueChanged', async (event) => {
                console.log('League changed to:', event.detail.league);
                // Reload all data for the new league
                await initializePage();
            });

            listenersInitialized = true;
        }

        populateAllDropdowns();

    } catch (error) {
        console.error("Error initializing page:", error);
        adminContainer.innerHTML = '<div class="error">Could not load required league data.</div>';
    }
}
function populateAllDropdowns() {
    const teamOptions = allTeams.map(t => `<option value="${t.id}">${t.team_name}</option>`).join('');

    document.getElementById('sign-team-select').innerHTML = `<option value="">Select team...</option>${teamOptions}`;
    document.getElementById('unretire-team-select').innerHTML = `<option value="">Select team...</option>${teamOptions}`;


    const freeAgentDataList = document.getElementById('free-agent-list');
    const freeAgents = allPlayers.filter(p => p.current_team_id === 'FREE_AGENT' && p.player_status !== 'RETIRED');
    freeAgentDataList.innerHTML = freeAgents.map(p => `<option value="${p.player_handle}"></option>`).join('');

    cutTeamFilter.innerHTML = `<option value="">All Teams</option>${teamOptions}`;
    retireTeamFilter.innerHTML = `<option value="">All Teams</option>${teamOptions}`;
    
    populateCutPlayerDropdown();
    populateRetirePlayerDropdown();
    populateUnretirePlayerDropdown();
}

function populateCutPlayerDropdown(teamId = '') {
    const cutPlayerSelect = document.getElementById('cut-player-select');
    let playersToDisplay = allPlayers.filter(p =>
        p.current_team_id && p.current_team_id !== 'FREE_AGENT' && p.player_status !== 'RETIRED'
    );
    if (teamId) {
        playersToDisplay = playersToDisplay.filter(p => p.current_team_id === teamId);
    }
    cutPlayerSelect.innerHTML = `<option value="">Select player...</option>` +
        playersToDisplay.map(p => `<option value="${p.id}">${p.player_handle} (${p.current_team_id})</option>`).join('');
}

function populateRetirePlayerDropdown(teamId = '') {
    const retirePlayerSelect = document.getElementById('retire-player-select');
     let playersToDisplay = allPlayers.filter(p =>
        p.current_team_id && p.current_team_id !== 'FREE_AGENT' && p.player_status !== 'RETIRED'
    );
    if (teamId) {
        playersToDisplay = playersToDisplay.filter(p => p.current_team_id === teamId);
    }
     retirePlayerSelect.innerHTML = `<option value="">Select player...</option>` +
        playersToDisplay.map(p => `<option value="${p.id}">${p.player_handle} (${p.current_team_id})</option>`).join('');
}

function populateUnretirePlayerDropdown() {
    const unretirePlayerSelect = document.getElementById('unretire-player-select');
    const retiredPlayers = allPlayers.filter(p => p.player_status === 'RETIRED');
    unretirePlayerSelect.innerHTML = `<option value="">Select player...</option>` +
        retiredPlayers.map(p => `<option value="${p.id}">${p.player_handle}</option>`).join('');
}


function setupEventListeners() {
    typeSelect.addEventListener('change', () => {
        document.querySelectorAll('.transaction-section').forEach(sec => sec.style.display = 'none');
        const selectedType = typeSelect.value;
        if (selectedType) {
            const section = document.getElementById(`${selectedType.toLowerCase()}-section`);
            if (section) section.style.display = 'block';
        }
        if (selectedType === 'TRADE' && document.querySelector('.trade-party-block') == null) {
            addTradePartyBlock();
            addTradePartyBlock();
        }
    });

    transactionForm.addEventListener('reset', () => {
        if (!preserveFeedbackOnReset) {
            clearFeedbackMessage();
        }
        preserveFeedbackOnReset = false;
        document.querySelectorAll('.transaction-section').forEach(sec => {
            sec.style.display = 'none';
        });
        document.querySelector('.trade-parties-container').innerHTML = '';
    });

    document.getElementById('add-team-btn').addEventListener('click', addTradePartyBlock);
    transactionForm.addEventListener('submit', handleFormSubmit);

    cutTeamFilter.addEventListener('change', (e) => {
        populateCutPlayerDropdown(e.target.value);
    });

    retireTeamFilter.addEventListener('change', (e) => {
        populateRetirePlayerDropdown(e.target.value);
    });
}

function addTradePartyBlock() {
    const container = document.querySelector('.trade-parties-container');
    const partyId = `party-${Date.now()}`;
    const block = document.createElement('div');
    block.className = 'trade-party-block elevated-card';
    block.id = partyId;

    const removeButtonHTML = `
        <button type="button" class="icon-button remove-trade-party" aria-label="Remove team from trade">
            <span aria-hidden="true">&times;</span>
        </button>
    `;

    block.innerHTML = `
        <div class="trade-party-header">
            <div class="trade-party-heading-group">
                <span class="trade-party-index">Team</span>
            </div>
            <div class="trade-party-actions">
                ${removeButtonHTML}
            </div>
        </div>
        <div class="form-group-admin compact">
            <label class="sr-only">Team</label>
            <select class="team-select trade-team-select" required>
                <option value="">Select team...</option>
                ${allTeams.map(t => `<option value="${t.id}">${t.team_name}</option>`).join('')}
            </select>
        </div>
        <div class="assets-container">
            <div class="assets-header">
                <div>
                    <p class="eyebrow">Assets Sent by this Team</p>
                </div>
            </div>
            <div class="asset-list"></div>
            <div class="asset-controls">
                <div class="asset-type-group">
                    <label class="sr-only" for="asset-type-${partyId}">Asset type</label>
                    <select id="asset-type-${partyId}" class="asset-type-select">
                        <option value="player">Player</option>
                        <option value="pick">Draft Pick</option>
                    </select>
                </div>
                <button type="button" class="btn-admin-add-asset">+ Add Asset</button>
            </div>
        </div>
    `;
    container.appendChild(block);

    const removeButton = block.querySelector('.remove-trade-party');
    if (removeButton) {
        removeButton.addEventListener('click', () => {
            block.remove();
            refreshTradePartyHeaders();
        });
    }

    block.querySelector('.btn-admin-add-asset').addEventListener('click', addAssetToTrade);
    refreshTradePartyHeaders();
}

function refreshTradePartyHeaders() {
    const blocks = Array.from(document.querySelectorAll('.trade-party-block'));
    const shouldShowRemove = blocks.length > 2;

    blocks.forEach((block, idx) => {
        const indexLabel = block.querySelector('.trade-party-index');
        if (indexLabel) {
            indexLabel.textContent = `Team ${idx + 1}`;
        }

        const removeBtn = block.querySelector('.remove-trade-party');
        if (removeBtn) {
            removeBtn.style.display = shouldShowRemove ? 'inline-flex' : 'none';
        }
    });
}

function addAssetToTrade(event) {
    const tradeBlock = event.target.closest('.trade-party-block');
    const assetList = tradeBlock.querySelector('.asset-list');
    const assetType = tradeBlock.querySelector('.asset-type-select').value;
    const teamId = tradeBlock.querySelector('.trade-team-select').value;

    if (!teamId) {
        alert("Please select a team for this trade block first.");
        return;
    }

    const otherTeams = Array.from(document.querySelectorAll('.trade-team-select'))
        .map(select => select.value)
        .filter(id => id && id !== teamId);

    if (otherTeams.length === 0) {
        alert("Add another team to the trade before adding assets.");
        return;
    }

    const destinationOptions = otherTeams.map(tId => {
        const team = allTeams.find(t => t.id === tId);
        return `<option value="${tId}">${team?.team_name || tId}</option>`;
    }).join('');

    const assetItem = document.createElement('div');
    assetItem.className = 'asset-item';
    let assetSelectHTML = '';
    if (assetType === 'player') {
        const teamPlayers = allPlayers.filter(p => p.current_team_id === teamId);
        if (!teamPlayers.length) {
            alert('No players available for the selected team.');
            return;
        }
        assetSelectHTML = `<select class="asset-value-select" data-asset-type="player">${teamPlayers.map(p => `<option value="${p.id}">${p.player_handle}</option>`).join('')}</select>`;
    } else {
        const teamPicks = allPicks.filter(p => p.current_owner === teamId);
        if (!teamPicks.length) {
            alert('No picks available for the selected team.');
            return;
        }
        assetSelectHTML = `<select class="asset-value-select" data-asset-type="pick">${teamPicks.map(p => `<option value="${p.id}">${p.pick_description}</option>`).join('')}</select>`;
    }

    assetItem.innerHTML = `
        <div class="asset-value-shell">${assetSelectHTML}</div>
        <button type="button" class="btn-admin-remove-asset" aria-label="Remove asset" onclick="this.parentElement.remove()">&times;</button>
        <span class="asset-to-label" aria-hidden="true"></span>
        <select class="asset-destination-select">${destinationOptions}</select>
    `;
    assetList.appendChild(assetItem);
}


async function handleFormSubmit(e) {
    e.preventDefault();
    clearFeedbackMessage();
    const type = typeSelect.value;

    // Get the submit button and store original text
    const submitButton = transactionForm.querySelector('button[type="submit"]');
    const originalButtonText = submitButton.textContent;

    // Disable button and show loading state
    submitButton.disabled = true;
    submitButton.textContent = 'Logging...';

    // We remove serverTimestamp() from here because the backend will add it.
    let transactionData = { type, schema: 'v2', notes: document.getElementById('transaction-notes').value.trim(), status: 'PENDING' };

    try {
        if (type === 'TRADE') {
            transactionData.involved_teams = [];
            transactionData.involved_players = [];
            transactionData.involved_picks = [];
            const tradeBlocks = document.querySelectorAll('.trade-party-block');
            tradeBlocks.forEach(block => {
                const teamId = block.querySelector('.trade-team-select').value;
                if (!teamId) return;
                transactionData.involved_teams.push(teamId);
                block.querySelectorAll('.asset-item').forEach(assetItem => {
                    const assetId = assetItem.querySelector('.asset-value-select').value;
                    const assetType = assetItem.querySelector('.asset-value-select').dataset.assetType;
                    const destination = assetItem.querySelector('.asset-destination-select').value;
                    if (assetType === 'player') {
                        transactionData.involved_players.push({ id: assetId, from: teamId, to: destination });
                    } else {
                        transactionData.involved_picks.push({ id: assetId, from: teamId, to: destination });
                    }
                });
            });
        } else if (type === 'SIGN') {
            const teamId = document.getElementById('sign-team-select').value;
            const playerHandle = document.getElementById('sign-player-input').value;
            const playerToSign = allPlayers.find(p => p.player_handle === playerHandle);

            if (!teamId || !playerToSign) {
                throw new Error("A valid team and free agent must be selected.");
            }
            if (playerToSign.current_team_id !== 'FREE_AGENT') {
                throw new Error(`${playerHandle} is not a free agent.`);
            }

            transactionData.involved_teams = [teamId];
            transactionData.involved_players = [{ id: playerToSign.id, to: teamId }];
        } else if (type === 'CUT') {
            const playerId = document.getElementById('cut-player-select').value;
            if (!playerId) throw new Error("A player must be selected to cut.");
            const playerToCut = allPlayers.find(p => p.id === playerId);
            transactionData.involved_teams = [playerToCut.current_team_id];
            transactionData.involved_players = [{ id: playerId, to: 'FREE_AGENT' }];
        } else if (type === 'RETIREMENT') {
            const playerId = document.getElementById('retire-player-select').value;
            if (!playerId) throw new Error("A player must be selected to retire.");
            const playerToRetire = allPlayers.find(p => p.id === playerId);
            transactionData.involved_teams = [playerToRetire.current_team_id];
            transactionData.involved_players = [{ id: playerId, from: playerToRetire.current_team_id, to: 'RETIRED' }];
        } else if (type === 'UNRETIREMENT') {
            const playerId = document.getElementById('unretire-player-select').value;
            const teamId = document.getElementById('unretire-team-select').value;
            if (!playerId || !teamId) throw new Error("A player and destination team must be selected.");
             transactionData.involved_teams = [teamId];
            transactionData.involved_players = [{ id: playerId, from: 'RETIRED', to: teamId }];
        } else {
            throw new Error("Invalid transaction type selected.");
        }

        // MODIFICATION: Call the cloud function instead of writing directly to DB
        const admin_processTransaction = httpsCallable(functions, 'admin_processTransaction');
        const result = await admin_processTransaction({ ...transactionData, league: getCurrentLeague() });

        showFeedbackMessage('success', {
            title: 'Transaction Logged',
            message: result.data.message
        });

        if (getCurrentLeague() === 'minor' && activeSeasonId) {
            await updateDoc(doc(db, collectionNames.seasons, activeSeasonId), { season_trans: increment(1) });
        }

        // Re-enable button and restore original text after success
        submitButton.disabled = false;
        submitButton.textContent = originalButtonText;

        preserveFeedbackOnReset = true;
        transactionForm.reset();
        document.querySelectorAll('.transaction-section').forEach(sec => sec.style.display = 'none');
        document.querySelector('.trade-parties-container').innerHTML = '';

        const playersSnap = await getDocs(collection(db, collectionNames.players));
        allPlayers = playersSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        populateAllDropdowns();

    } catch (error) {
        console.error("Error logging transaction:", error);
        showFeedbackMessage('error', {
            title: 'Could not log transaction',
            message: error.message
        });

        // Re-enable button and restore original text on error
        submitButton.disabled = false;
        submitButton.textContent = originalButtonText;
    }
}

function showFeedbackMessage(type, { title, message }) {
    if (!feedbackContainer) return;

    feedbackContainer.innerHTML = `
        <div class="admin-feedback-icon" aria-hidden="true">${type === 'success' ? '✓' : '!'}</div>
        <div>
            <p class="admin-feedback-title">${title}</p>
            <p class="admin-feedback-message">${message}</p>
        </div>
    `;

    feedbackContainer.classList.remove('admin-feedback--success', 'admin-feedback--error');
    feedbackContainer.classList.add(type === 'success' ? 'admin-feedback--success' : 'admin-feedback--error');
    feedbackContainer.hidden = false;
}

function clearFeedbackMessage() {
    if (!feedbackContainer) return;
    feedbackContainer.hidden = true;
    feedbackContainer.innerHTML = '';
    feedbackContainer.classList.remove('admin-feedback--success', 'admin-feedback--error');
}


function addLogoutListener() {
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            auth.signOut().then(() => { window.location.href = '/login.html?target=admin'; });
        });
    }
}