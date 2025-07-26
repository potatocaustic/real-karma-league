// /admin/manage-transactions.js

import { auth, db, onAuthStateChanged, doc, getDoc, collection, getDocs, addDoc, serverTimestamp } from '/js/firebase-init.js';

// --- Page Elements ---
const loadingContainer = document.getElementById('loading-container');
const adminContainer = document.getElementById('admin-container');
const authStatusDiv = document.getElementById('auth-status');
const transactionForm = document.getElementById('transaction-form');
const typeSelect = document.getElementById('transaction-type-select');
const cutTeamFilter = document.getElementById('cut-team-filter-select');

let allPlayers = [];
let allTeams = [];
let allPicks = [];

// --- Primary Auth Check & Initialization ---
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
    try {
        const [playersSnap, teamsSnap, picksSnap] = await Promise.all([
            getDocs(collection(db, "new_players")),
            getDocs(collection(db, "new_teams")),
            getDocs(collection(db, "draftPicks"))
        ]);

        allPlayers = playersSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        allTeams = teamsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })).sort((a, b) => a.team_name.localeCompare(b.team_name));
        allPicks = picksSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        setupEventListeners();
        populateAllDropdowns();

    } catch (error) {
        console.error("Error initializing page:", error);
        adminContainer.innerHTML = '<div class="error">Could not load required league data.</div>';
    }
}

function populateAllDropdowns() {
    const teamOptions = allTeams.map(t => `<option value="${t.id}">${t.team_name}</option>`).join('');

    // Sign section
    document.getElementById('sign-team-select').innerHTML = `<option value="">Select team...</option>${teamOptions}`;

    // MODIFIED: Populate datalist instead of select for free agents
    const freeAgentDataList = document.getElementById('free-agent-list');
    const freeAgents = allPlayers.filter(p => p.current_team_id === 'FREE_AGENT' && p.player_status !== 'RETIRED');
    freeAgentDataList.innerHTML = freeAgents.map(p => `<option value="${p.player_handle}"></option>`).join('');

    // Cut section
    cutTeamFilter.innerHTML = `<option value="">All Teams</option>${teamOptions}`;
    populateCutPlayerDropdown();
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


// --- Event Listeners ---
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

    // ADDED: Listener for the new form reset button
    transactionForm.addEventListener('reset', () => {
        // Hide all the specific transaction sections when the form is reset
        document.querySelectorAll('.transaction-section').forEach(sec => {
            sec.style.display = 'none';
        });
        // Clear the trade parties container
        document.querySelector('.trade-parties-container').innerHTML = '';
    });

    document.getElementById('add-team-btn').addEventListener('click', addTradePartyBlock);
    transactionForm.addEventListener('submit', handleFormSubmit);
}

// --- Trade Block Logic ---
function addTradePartyBlock() {
    const container = document.querySelector('.trade-parties-container');
    const partyId = `party-${Date.now()}`;
    const block = document.createElement('div');
    block.className = 'trade-party-block';
    block.id = partyId;

    // ADDED: Remove button for blocks beyond the second one
    const removeButtonHTML = container.children.length >= 2
        ? `<button type="button" class="btn-admin-remove-asset" onclick="this.closest('.trade-party-block').remove()" style="color: white;">&times;</button>`
        : '';

    block.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center;">
            <label>Team</label>
            ${removeButtonHTML}
        </div>
        <select class="team-select trade-team-select" required>
            <option value="">Select team...</option>
            ${allTeams.map(t => `<option value="${t.id}">${t.team_name}</option>`).join('')}
        </select>
        <div class="assets-container">
            <label>Assets Sent by this Team:</label>
            <div class="asset-list"></div>
            <div class="asset-controls">
                <select class="asset-type-select">
                    <option value="player">Player</option>
                    <option value="pick">Draft Pick</option>
                </select>
                <button type="button" class="btn-admin-add-asset">+ Add Asset</button>
            </div>
        </div>
    `;
    container.appendChild(block);
    block.querySelector('.btn-admin-add-asset').addEventListener('click', addAssetToTrade);
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

    // ADDED: Dropdown to select destination for the asset
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
        assetSelectHTML = `<select class="asset-value-select" data-asset-type="player">${teamPlayers.map(p => `<option value="${p.id}">${p.player_handle}</option>`).join('')}</select>`;
    } else {
        const teamPicks = allPicks.filter(p => p.current_owner === teamId);
        assetSelectHTML = `<select class="asset-value-select" data-asset-type="pick">${teamPicks.map(p => `<option value="${p.id}">${p.pick_description}</option>`).join('')}</select>`;
    }

    assetItem.innerHTML = `
        ${assetSelectHTML}
        <span> to </span>
        <select class="asset-destination-select">${destinationOptions}</select>
        <button type="button" class="btn-admin-remove-asset" onclick="this.parentElement.remove()">&times;</button>
    `;
    assetList.appendChild(assetItem);
}


// --- Form Submission ---
async function handleFormSubmit(e) {
    e.preventDefault();
    const type = typeSelect.value;
    let transactionData = { type, notes: document.getElementById('transaction-notes').value.trim(), date: serverTimestamp(), status: 'PENDING' };

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
            // MODIFIED: Get player handle from the new input field
            const playerHandle = document.getElementById('sign-player-input').value;

            // Find the player's ID based on their handle.
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
        } else {
            throw new Error("Invalid transaction type selected.");
        }

        await addDoc(collection(db, "transactions"), transactionData);
        alert('Transaction logged successfully! Player data will update automatically.');
        transactionForm.reset();
        document.querySelectorAll('.transaction-section').forEach(sec => sec.style.display = 'none');
        document.querySelector('.trade-parties-container').innerHTML = '';
        populateAllDropdowns(); // Refresh dropdowns

    } catch (error) {
        console.error("Error logging transaction:", error);
        alert(`Error: ${error.message}`);
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