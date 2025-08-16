// /admin/manage-teams.js

import { auth, db, onAuthStateChanged, doc, getDoc, collection, getDocs, updateDoc, query, setDoc } from '/js/firebase-init.js';

// --- DEV ENVIRONMENT CONFIG ---
const USE_DEV_COLLECTIONS = true;
const getCollectionName = (baseName) => USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;

// --- Page Elements ---
const loadingContainer = document.getElementById('loading-container');
const adminContainer = document.getElementById('admin-container');
const authStatusDiv = document.getElementById('auth-status');
const teamsListContainer = document.getElementById('teams-list-container');
const teamModal = document.getElementById('team-modal');
const closeModalBtn = teamModal.querySelector('.close-btn-admin');
const teamForm = document.getElementById('team-form');
const seasonSelect = document.getElementById('season-select-teams');


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
        if (e.target.matches('.btn-admin-edit')) {
            const teamId = e.target.dataset.teamId;
            const teamData = allTeams.find(t => t.id === teamId);
            if (teamData) {
                openTeamModal(teamData);
            }
        }
    });

    closeModalBtn.addEventListener('click', () => {
        teamModal.style.display = 'none';
    });

    teamForm.addEventListener('submit', handleTeamFormSubmit);
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
            <button class="btn-admin-edit" data-team-id="${team.id}">Edit</button>
        `;
        fragment.appendChild(teamEntryDiv);
    });

    teamsListContainer.appendChild(fragment);
    teamsListContainer.style.display = 'block';
    teamsListContainer.style.visibility = 'visible';
    teamsListContainer.style.height = 'auto';
    teamsListContainer.style.opacity = '1';
}

function openTeamModal(team) {
    document.getElementById('team-id-input').value = team.id;
    document.getElementById('team-id-display').textContent = team.id;
    document.getElementById('team-name-input').value = team.season_record.team_name || '';
    document.getElementById('team-conference-select').value = team.conference || 'Eastern';
    document.getElementById('team-gm-handle-input').value = team.current_gm_handle || '';
    document.getElementById('team-gm-uid-input').value = team.gm_uid || '';
    teamModal.style.display = 'block';
}


async function handleTeamFormSubmit(e) {
    e.preventDefault();
    const teamId = document.getElementById('team-id-input').value;

    const rootData = {
        conference: document.getElementById('team-conference-select').value,
        current_gm_handle: document.getElementById('team-gm-handle-input').value,
        gm_uid: document.getElementById('team-gm-uid-input').value
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
        teamModal.style.display = 'none'; // Use style.display to hide
        await loadAndDisplayTeams();
    } catch (error) {
        console.error("Error updating team:", error);
        alert('Failed to update team.');
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