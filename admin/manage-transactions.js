// /admin/manage-transactions.js

import { auth, db, onAuthStateChanged, doc, getDoc, collection, getDocs, httpsCallable, functions, serverTimestamp, query, where, getCurrentLeague, collectionNames, getLeagueCollectionName } from '/js/firebase-init.js';

// --- Page Elements ---
const loadingContainer = document.getElementById('loading-container');
const adminContainer = document.getElementById('admin-container');
const authStatusDiv = document.getElementById('auth-status');
const transactionForm = document.getElementById('transaction-form');
const typeSelect = document.getElementById('transaction-type-select');
const cutTeamFilter = document.getElementById('cut-team-filter-select');
const retireTeamFilter = document.getElementById('retire-team-filter-select');


let allPlayers = [];
let allTeams = [];
let allPicks = [];

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
            window.location.href = '/login.html';
        }
    });
});

async function initializePage() {
    try {
        const seasonsQuery = query(collection(db, collectionNames.seasons), where("status", "==", "active"));
        const activeSeasonsSnap = await getDocs(seasonsQuery);
        const activeSeasonId = !activeSeasonsSnap.empty ? activeSeasonsSnap.docs[0].id : null;

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

        setupEventListeners();
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
    block.className = 'trade-party-block';
    block.id = partyId;

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


async function handleFormSubmit(e) {
    e.preventDefault();
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

        alert(result.data.message); // Show the dynamic message from the backend

        // Re-enable button and restore original text after success
        submitButton.disabled = false;
        submitButton.textContent = originalButtonText;

        transactionForm.reset();
        document.querySelectorAll('.transaction-section').forEach(sec => sec.style.display = 'none');
        document.querySelector('.trade-parties-container').innerHTML = '';

        const playersSnap = await getDocs(collection(db, collectionNames.players));
        allPlayers = playersSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        populateAllDropdowns();

    } catch (error) {
        console.error("Error logging transaction:", error);
        alert(`Error: ${error.message}`);

        // Re-enable button and restore original text on error
        submitButton.disabled = false;
        submitButton.textContent = originalButtonText;
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