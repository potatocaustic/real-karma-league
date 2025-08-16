// /admin/manage-teams.js

import { auth, db, onAuthStateChanged, doc, getDoc, collection, getDocs, updateDoc, query, setDoc, httpsCallable, functions } from '/js/firebase-init.js';

// --- DEV ENVIRONMENT CONFIG ---
const USE_DEV_COLLECTIONS = true;
const getCollectionName = (baseName) => USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;

// --- Page Elements ---
const loadingContainer = document.getElementById('loading-container');
const adminContainer = document.getElementById('admin-container');
const authStatusDiv = document.getElementById('auth-status');
const teamsListContainer = document.getElementById('teams-list-container');
const seasonSelect = document.getElementById('season-select-teams');

// Edit Modal
const teamModal = document.getElementById('team-modal');
const closeTeamModalBtn = teamModal.querySelector('.close-btn-admin');
const teamForm = document.getElementById('team-form');

// Rebrand Modal
const rebrandModal = document.getElementById('rebrand-modal');
const closeRebrandModalBtn = rebrandModal.querySelector('.close-btn-admin');
const rebrandForm = document.getElementById('rebrand-form');

let allTeams = [];
let currentSeasonId = "";

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
    await populateSeasons();

    seasonSelect.addEventListener('change', () => {
        currentSeasonId = seasonSelect.value;
        loadAndDisplayTeams();
    });

    teamsListContainer.addEventListener('click', (e) => {
        const teamId = e.target.dataset.teamId;
        const teamData = allTeams.find(t => t.id === teamId);
        if (!teamData) return;

        if (e.target.matches('.btn-admin-edit')) {
            openTeamModal(teamData);
        } else if (e.target.matches('.btn-admin-rebrand')) {
            openRebrandModal(teamData);
        }
    });

    closeTeamModalBtn.addEventListener('click', () => teamModal.style.display = 'none');
    closeRebrandModalBtn.addEventListener('click', () => rebrandModal.style.display = 'none');

    teamForm.addEventListener('submit', handleTeamFormSubmit);
    rebrandForm.addEventListener('submit', handleRebrandFormSubmit);
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
    await loadAndDisplayTeams();
}


async function loadAndDisplayTeams() {
    teamsListContainer.innerHTML = '<div class="loading">Loading teams...</div>';
    if (!currentSeasonId) {
        teamsListContainer.innerHTML = '<p class="placeholder-text">Please select a season.</p>';
        return;
    }

    try {
        const teamsSnap = await getDocs(collection(db, getCollectionName("v2_teams")));
        const validTeamDocs = teamsSnap.docs.filter(doc => doc.data().conference);

        const teamPromises = validTeamDocs.map(async (teamDoc) => {
            const teamId = teamDoc.id;
            const teamData = { id: teamId, ...teamDoc.data() };
            const seasonRecordRef = doc(db, getCollectionName("v2_teams"), teamId, getCollectionName("seasonal_records"), currentSeasonId);
            const seasonRecordSnap = await getDoc(seasonRecordRef);

            if (seasonRecordSnap.exists()) {
                teamData.season_record = seasonRecordSnap.data();
            } else {
                teamData.season_record = { wins: 0, losses: 0, team_name: "Name Not Found" };
            }
            return teamData;
        });

        allTeams = await Promise.all(teamPromises);
        allTeams.sort((a, b) => (a.season_record.team_name || '').localeCompare(b.season_record.team_name || ''));

        displayTeams(allTeams);

    } catch (error) {
        console.error("Error loading teams data:", error);
        teamsListContainer.innerHTML = '<div class="error">Could not load team data.</div>';
    }
}

function displayTeams(teams) {
    teamsListContainer.innerHTML = '';

    if (teams.length === 0) {
        teamsListContainer.innerHTML = '<p class="placeholder-text">No teams found for this season.</p>';
        return;
    }

    const fragment = document.createDocumentFragment();

    teams.forEach(team => {
        const wins = team.season_record?.wins ?? 'N/A';
        const losses = team.season_record?.losses ?? 'N/A';

        const teamEntryDiv = document.createElement('div');
        teamEntryDiv.className = 'team-entry';
        teamEntryDiv.innerHTML = `
            <div class="team-details">
                <span class="team-name">${team.season_record.team_name || 'N/A'}</span>
                <span class="team-sub-details">${wins}-${losses} | GM: ${team.current_gm_handle || 'N/A'}</span>
            </div>
            <div class="team-actions">
                <button class="btn-admin-secondary btn-admin-rebrand" data-team-id="${team.id}">Rebrand</button>
                <button class="btn-admin-edit" data-team-id="${team.id}">Edit</button>
            </div>
        `;
        fragment.appendChild(teamEntryDiv);
    });

    teamsListContainer.appendChild(fragment);
}

function openTeamModal(team) {
    document.getElementById('team-id-input').value = team.id;
    document.getElementById('team-id-display').textContent = team.id;
    document.getElementById('team-name-input').value = team.season_record.team_name || '';
    document.getElementById('team-conference-select').value = team.conference || 'Eastern';
    document.getElementById('team-gm-handle-input').value = team.current_gm_handle || '';
    document.getElementById('team-gm-uid-input').value = team.gm_uid || '';
    // *** MODIFIED LOGIC ***
    document.getElementById('team-gm-player-id-input').value = team.gm_player_id || '';
    teamModal.style.display = 'block';
}

function openRebrandModal(team) {
    document.getElementById('rebrand-old-team-id-input').value = team.id;
    document.getElementById('rebrand-old-team-id-display').textContent = team.id;
    document.getElementById('rebrand-new-name-input').value = '';
    document.getElementById('rebrand-new-id-input').value = '';
    rebrandModal.style.display = 'block';
}

async function handleTeamFormSubmit(e) {
    e.preventDefault();
    const teamId = document.getElementById('team-id-input').value;

    // *** MODIFIED LOGIC ***
    const rootData = {
        conference: document.getElementById('team-conference-select').value,
        current_gm_handle: document.getElementById('team-gm-handle-input').value,
        gm_uid: document.getElementById('team-gm-uid-input').value,
        gm_player_id: document.getElementById('team-gm-player-id-input').value
    };
    const seasonalData = {
        team_name: document.getElementById('team-name-input').value
    };

    const teamRef = doc(db, getCollectionName("v2_teams"), teamId);
    const seasonRecordRef = doc(teamRef, getCollectionName("seasonal_records"), currentSeasonId);

    try {
        await updateDoc(teamRef, rootData);
        await setDoc(seasonRecordRef, seasonalData, { merge: true });

        alert('Team updated successfully!');
        teamModal.style.display = 'none';
        await loadAndDisplayTeams();
    } catch (error) {
        console.error("Error updating team:", error);
        alert('Failed to update team.');
    }
}

async function handleRebrandFormSubmit(e) {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Processing...';

    const oldTeamId = document.getElementById('rebrand-old-team-id-input').value;
    const newTeamName = document.getElementById('rebrand-new-name-input').value;
    const newTeamId = document.getElementById('rebrand-new-id-input').value.toUpperCase();

    if (oldTeamId === newTeamId) {
        alert("New Team ID cannot be the same as the Old Team ID.");
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Rebrand';
        return;
    }

    if (!confirm(`Are you sure you want to rebrand ${oldTeamId} to ${newTeamId} (${newTeamName})? This action is permanent.`)) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Rebrand';
        return;
    }

    try {
        const rebrandTeam = httpsCallable(functions, 'rebrandTeam');
        const result = await rebrandTeam({ oldTeamId, newTeamId, newTeamName });
        alert(result.data.message);
        rebrandModal.style.display = 'none';
        await loadAndDisplayTeams();
    } catch (error) {
        console.error("Error calling rebrandTeam function:", error);
        alert(`An error occurred: ${error.message}`);
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Rebrand';
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
