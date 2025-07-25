// /admin/manage-transactions.js

import { auth, db, onAuthStateChanged, doc, getDoc, collection, getDocs, addDoc, serverTimestamp } from '/js/firebase-init.js';

// --- Page Elements ---
const loadingContainer = document.getElementById('loading-container');
const adminContainer = document.getElementById('admin-container');
const authStatusDiv = document.getElementById('auth-status');
const transactionForm = document.getElementById('transaction-form');
const typeSelect = document.getElementById('transaction-type-select');

let allPlayers = [];
let allTeams = [];
let allPicks = [];

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
        const [playersSnap, teamsSnap, picksSnap] = await Promise.all([
            getDocs(collection(db, "new_players")),
            getDocs(collection(db, "new_teams")),
            getDocs(collection(db, "draftPicks"))
        ]);

        allPlayers = playersSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })).sort((a, b) => a.id.localeCompare(b.id));
        allTeams = teamsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })).sort((a, b) => a.team_name.localeCompare(b.team_name));
        allPicks = picksSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        setupEventListeners();
        populateInitialDropdowns();

    } catch (error) {
        console.error("Error initializing page:", error);
        adminContainer.innerHTML = '<div class="error">Could not load required league data.</div>';
    }
}

function populateInitialDropdowns() {
    // Populate Sign Team Dropdown
    const signTeamSelect = document.getElementById('sign-team-select');
    signTeamSelect.innerHTML = `<option value="">Select team...</option>` + allTeams.map(t => `<option value="${t.id}">${t.team_name}</option>`).join('');

    // ### CORRECTED: Filter for "FREE_AGENT" ###
    const signPlayerSelect = document.getElementById('sign-player-select');
    const freeAgents = allPlayers.filter(p => p.current_team_id === 'FREE_AGENT' || !p.current_team_id);
    signPlayerSelect.innerHTML = `<option value="">Select player...</option>` + freeAgents.map(p => `<option value="${p.id}">${p.id}</option>`).join('');

    // Populate Cut Player Dropdown
    const cutPlayerSelect = document.getElementById('cut-player-select');
    const activeRosteredPlayers = allPlayers.filter(p => p.current_team_id && p.current_team_id !== 'FREE_AGENT');
    cutPlayerSelect.innerHTML = `<option value="">Select player...</option>` + activeRosteredPlayers.map(p => `<option value="${p.id}">${p.id} (${p.current_team_id})</option>`).join('');
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

    document.getElementById('add-team-btn').addEventListener('click', addTradePartyBlock);

    transactionForm.addEventListener('submit', handleFormSubmit);
}

// --- Trade Block Logic ---
function addTradePartyBlock() {
    const container = document.querySelector('.trade-parties-container');
    // Using a more robust unique ID for the block
    const partyId = `party-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const block = document.createElement('div');
    block.className = 'trade-party-block';
    block.id = partyId; // Assign the unique ID to the block itself
    block.innerHTML = `
        <div class="form-group-admin">
            <label>Team</label>
            <select class="team-select trade-team-select" required>
                <option value="">Select team...</option>
                ${allTeams.map(t => `<option value="${t.id}">${t.team_name}</option>`).join('')}
            </select>
        </div>
        <div class="assets-container">
            <label>Assets Sent by this Team:</label>
            <div class="asset-list"></div>
            <div class="asset-controls">
                <select class="asset-type-select">
                    <option value="player">Player</option>
                    <option value="pick">Draft Pick</option>
                </select>
                <button type="button" class="btn-admin-add-asset">+ Add</button>
            </div>
        </div>
    `;
    container.appendChild(block);

    // Add event listeners for the new elements within the block
    block.querySelector('.btn-admin-add-asset').addEventListener('click', addAssetToTrade);
}

// ### CORRECTED AND REFACTORED FUNCTION ###
function addAssetToTrade(event) {
    // Find the parent block of the button that was clicked
    const tradeBlock = event.target.closest('.trade-party-block');
    if (!tradeBlock) return;

    // Find elements *within* that specific block
    const assetList = tradeBlock.querySelector('.asset-list');
    const assetType = tradeBlock.querySelector('.asset-type-select').value;
    const teamId = tradeBlock.querySelector('.trade-team-select').value;

    if (!teamId) {
        alert("Please select a team for this trade block first.");
        return;
    }

    const assetItem = document.createElement('div');
    assetItem.className = 'asset-item';

    let selectHTML = '';
    if (assetType === 'player') {
        const teamPlayers = allPlayers.filter(p => p.current_team_id === teamId);
        if (teamPlayers.length === 0) {
            alert(`No players found on team: ${teamId}`);
            return;
        }
        selectHTML = `<select class="asset-value-select" data-asset-type="player">${teamPlayers.map(p => `<option value="${p.id}">${p.id}</option>`).join('')}</select>`;
    } else { // pick
        const teamPicks = allPicks.filter(p => p.current_owner === teamId);
        if (teamPicks.length === 0) {
            alert(`No draft picks found for team: ${teamId}`);
            return;
        }
        selectHTML = `<select class="asset-value-select" data-asset-type="pick">${teamPicks.map(p => `<option value="${p.id}">${p.pick_description}</option>`).join('')}</select>`;
    }

    assetItem.innerHTML = `
        <span>${assetType.charAt(0).toUpperCase() + assetType.slice(1)}:</span>
        ${selectHTML}
        <button type="button" class="btn-admin-remove-asset">&times;</button>
    `;
    assetList.appendChild(assetItem);
    assetItem.querySelector('.btn-admin-remove-asset').addEventListener('click', (e) => e.target.parentElement.remove());
}


// --- Form Submission ---
async function handleFormSubmit(e) {
    e.preventDefault();
    const type = typeSelect.value;
    const notes = document.getElementById('transaction-notes').value.trim();
    let transactionData = { type, notes, date: serverTimestamp(), involved_teams: [], involved_players: [], involved_picks: [] };

    try {
        switch (type) {
            case 'TRADE':
                const tradeBlocks = document.querySelectorAll('.trade-party-block');
                for (const block of tradeBlocks) {
                    const teamId = block.querySelector('.trade-team-select').value;
                    if (!teamId) continue; // Skip blocks without a team selected
                    transactionData.involved_teams.push(teamId);

                    block.querySelectorAll('.asset-value-select').forEach(assetSelect => {
                        const assetId = assetSelect.value;
                        const assetType = assetSelect.dataset.assetType;
                        if (assetType === 'player') {
                            transactionData.involved_players.push({ id: assetId, from: teamId, to: 'TBD' });
                        } else {
                            transactionData.involved_picks.push({ id: assetId, from: teamId, to: 'TBD' });
                        }
                    });
                }
                if (transactionData.involved_teams.length < 2) {
                    throw new Error("A trade must involve at least two teams.");
                }
                break;
            case 'SIGN':
                const signTeam = document.getElementById('sign-team-select').value;
                const signPlayer = document.getElementById('sign-player-select').value;
                if (!signTeam || !signPlayer) throw new Error("You must select a team and a player to sign.");
                transactionData.involved_teams.push(signTeam);
                transactionData.involved_players.push({ id: signPlayer, to: signTeam });
                break;
            case 'CUT':
                const cutPlayerId = document.getElementById('cut-player-select').value;
                if (!cutPlayerId) throw new Error("You must select a player to cut.");
                const playerToCut = allPlayers.find(p => p.id === cutPlayerId);
                transactionData.involved_teams.push(playerToCut.current_team_id);
                transactionData.involved_players.push({ id: cutPlayerId, to: 'FREE_AGENT' });
                break;
            default:
                throw new Error("Invalid transaction type.");
        }

        // Save to Firestore
        await addDoc(collection(db, "transactions"), transactionData);
        alert('Transaction logged successfully! Player data will be updated automatically.');
        transactionForm.reset();
        document.querySelectorAll('.transaction-section').forEach(sec => sec.style.display = 'none');
        document.querySelector('.trade-parties-container').innerHTML = '';
        // Repopulate dropdowns in case player rosters changed
        populateInitialDropdowns();

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