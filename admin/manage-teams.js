// /admin/manage-teams.js

import { auth, db, onAuthStateChanged, doc, getDoc, collection, getDocs, updateDoc, query } from '/js/firebase-init.js';

// --- Page Elements ---
const loadingContainer = document.getElementById('loading-container');
const adminContainer = document.getElementById('admin-container');
const authStatusDiv = document.getElementById('auth-status');
const teamsListContainer = document.getElementById('teams-list-container');
const teamModal = document.getElementById('team-modal');
const closeModalBtn = teamModal.querySelector('.close-btn-admin');
const teamForm = document.getElementById('team-form');
// ADDED: Season select element
const seasonSelect = document.createElement('select');

let allTeams = [];
let currentSeasonId = "";

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
    const filtersContainer = document.createElement('div');
    filtersContainer.className = 'filters-container';
    const filterGroup = document.createElement('div');
    filterGroup.className = 'filter-group';
    const label = document.createElement('label');
    label.htmlFor = 'season-select-teams';
    label.textContent = 'Season:';
    seasonSelect.id = 'season-select-teams';
    filterGroup.append(label, seasonSelect);
    filtersContainer.appendChild(filterGroup);
    adminContainer.insertBefore(filtersContainer, document.getElementById('teams-list-container'));

    await populateSeasons();
    
    seasonSelect.addEventListener('change', () => {
        currentSeasonId = seasonSelect.value;
        loadAndDisplayTeams();
    });
}

async function populateSeasons() {
    const seasonsSnap = await getDocs(query(collection(db, "seasons")));
    let activeSeasonId = null;
    seasonSelect.innerHTML = seasonsSnap.docs
        .sort((a, b) => b.id.localeCompare(a.id))
        .map(doc => {
            if(doc.data().status === 'active') activeSeasonId = doc.id;
            return `<option value="${doc.id}">${doc.data().season_name}</option>`;
        }).join('');
    
    if(activeSeasonId) {
        seasonSelect.value = activeSeasonId;
        currentSeasonId = activeSeasonId;
    } else {
        currentSeasonId = seasonSelect.value;
    }
    await loadAndDisplayTeams();
}


async function loadAndDisplayTeams() {
    teamsListContainer.innerHTML = '<div class="loading">Loading teams...</div>';
    if (!currentSeasonId) {
        teamsListContainer.innerHTML = '<p class="placeholder-text">Please select a season.</p>';
        return;
    }

    try {
        const teamsSnap = await getDocs(collection(db, "v2_teams"));

        const teamPromises = teamsSnap.docs.map(async (teamDoc) => {
            const teamData = { id: teamDoc.id, ...teamDoc.data() };
            // MODIFIED: Fetches record for the currently selected season
            const seasonRecordRef = doc(db, "v2_teams", teamDoc.id, "seasonal_records", currentSeasonId);
            const seasonRecordSnap = await getDoc(seasonRecordRef);
            if (seasonRecordSnap.exists()) {
                teamData.season_record = seasonRecordSnap.data();
            } else {
                teamData.season_record = { wins: 0, losses: 0 }; 
            }
            return teamData;
        });
        allTeams = await Promise.all(teamPromises);
        allTeams.sort((a, b) => a.team_name.localeCompare(b.team_name));

        displayTeams(allTeams);

    } catch (error) {
        console.error("Error initializing page:", error);
        teamsListContainer.innerHTML = '<div class="error">Could not load team data.</div>';
    }
}

function displayTeams(teams) {
    if (teams.length === 0) {
        teamsListContainer.innerHTML = '<p class="placeholder-text">No teams found.</p>';
        return;
    }

    const teamsHTML = teams.map(team => `
        <div class="team-entry">
            <div class="team-details">
                <span class="team-name">${team.team_name}</span>
                <span class="team-sub-details">${team.season_record.wins}-${team.season_record.losses} | GM: ${team.current_gm_handle || 'N/A'}</span>
            </div>
            <button class="btn-admin-edit" data-team-id="${team.id}">Edit</button>
        </div>
    `).join('');

    teamsListContainer.innerHTML = teamsHTML;
}

// --- Event Handlers and Modal Logic ---
teamsListContainer.addEventListener('click', (e) => {
    if (e.target.matches('.btn-admin-edit')) {
        const teamId = e.target.dataset.teamId;
        const teamData = allTeams.find(t => t.id === teamId);
        if (teamData) {
            openTeamModal(teamData);
        }
    }
});

function openTeamModal(team) {
    document.getElementById('team-id-input').value = team.id;
    document.getElementById('team-id-display').textContent = team.id;
    document.getElementById('team-name-input').value = team.team_name || '';
    document.getElementById('team-conference-select').value = team.conference || 'Eastern';
    document.getElementById('team-gm-handle-input').value = team.current_gm_handle || '';
    document.getElementById('team-gm-uid-input').value = team.gm_uid || '';

    teamModal.style.display = 'block';
}

closeModalBtn.addEventListener('click', () => {
    teamModal.style.display = 'none';
});

teamForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const teamId = document.getElementById('team-id-input').value;
    const updatedData = {
        team_name: document.getElementById('team-name-input').value,
        conference: document.getElementById('team-conference-select').value,
        current_gm_handle: document.getElementById('team-gm-handle-input').value,
        gm_uid: document.getElementById('team-gm-uid-input').value
    };
    const teamRef = doc(db, "v2_teams", teamId);

    try {
        await updateDoc(teamRef, updatedData);
        alert('Team updated successfully!');
        teamModal.style.display = 'none';
        // Reload teams for the current season to reflect changes
        await loadAndDisplayTeams();
    } catch (error) {
        console.error("Error updating team:", error);
        alert('Failed to update team.');
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