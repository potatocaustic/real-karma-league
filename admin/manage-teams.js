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
// MODIFIED: Get the season select element directly from the DOM
const seasonSelect = document.getElementById('season-select-teams');


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
    // REMOVED: The block that created the select element in JS.
    // It should now exist in the HTML file.

    await populateSeasons();

    seasonSelect.addEventListener('change', () => {
        currentSeasonId = seasonSelect.value;
        loadAndDisplayTeams();
    });

    // Add other event listeners
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
        teamModal.classList.remove('is-visible');
    });

    teamForm.addEventListener('submit', handleTeamFormSubmit);
}

async function populateSeasons() {
    const seasonsSnap = await getDocs(query(collection(db, "seasons")));
    let activeSeasonId = null;

    // Sort seasons descending by ID (e.g., S8, S7, S6)
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

    // Set current season and load initial data
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
        const teamsSnap = await getDocs(collection(db, "v2_teams"));

        const teamPromises = teamsSnap.docs.map(async (teamDoc) => {
            const teamData = { id: teamDoc.id, ...teamDoc.data() };
            const seasonRecordRef = doc(db, "v2_teams", teamDoc.id, "seasonal_records", currentSeasonId);
            const seasonRecordSnap = await getDoc(seasonRecordRef);
            if (seasonRecordSnap.exists()) {
                teamData.season_record = seasonRecordSnap.data();
            } else {
                // Provide a default name if a record doesn't exist for some reason
                teamData.season_record = { wins: 0, losses: 0, team_name: "Name Not Found" };
            }
            return teamData;
        });
        allTeams = await Promise.all(teamPromises);

        // MODIFIED: Sort by the team_name inside the season_record object
        allTeams.sort((a, b) => (a.season_record.team_name || '').localeCompare(b.season_record.team_name || ''));

        displayTeams(allTeams);

    } catch (error) {
        console.error("Error loading teams data:", error);
        teamsListContainer.innerHTML = '<div class="error">Could not load team data.</div>';
    }
}

function displayTeams(teams) {
    if (teams.length === 0) {
        teamsListContainer.innerHTML = '<p class="placeholder-text">No teams found for this season.</p>';
        return;
    }

    const teamsHTML = teams.map(team => `
        <div class="team-entry">
            <div class="team-details">
                <span class="team-name">${team.season_record.team_name || 'N/A'}</span>
                <span class="team-sub-details">${team.season_record.wins}-${team.season_record.losses} | GM: ${team.current_gm_handle || 'N/A'}</span>
            </div>
            <button class="btn-admin-edit" data-team-id="${team.id}">Edit</button>
        </div>
    `).join('');

    teamsListContainer.innerHTML = teamsHTML;
}


function openTeamModal(team) {
    document.getElementById('team-id-input').value = team.id;
    document.getElementById('team-id-display').textContent = team.id;
    // MODIFIED: Get team_name from the season_record
    document.getElementById('team-name-input').value = team.season_record.team_name || '';
    document.getElementById('team-conference-select').value = team.conference || 'Eastern';
    document.getElementById('team-gm-handle-input').value = team.current_gm_handle || '';
    document.getElementById('team-gm-uid-input').value = team.gm_uid || '';

    teamModal.classList.add('is-visible');
}

async function handleTeamFormSubmit(e) {
    e.preventDefault();
    const teamId = document.getElementById('team-id-input').value;

    // Data for the root v2_teams document
    const rootData = {
        conference: document.getElementById('team-conference-select').value,
        current_gm_handle: document.getElementById('team-gm-handle-input').value,
        gm_uid: document.getElementById('team-gm-uid-input').value
    };
    // Data for the seasonal_records sub-document
    const seasonalData = {
        team_name: document.getElementById('team-name-input').value
    };

    const teamRef = doc(db, "v2_teams", teamId);
    // MODIFIED: Get a ref to the seasonal record for the *currently selected season*
    const seasonRecordRef = doc(teamRef, "seasonal_records", currentSeasonId);

    try {
        // Update the root document with static data
        await updateDoc(teamRef, rootData);
        // Update the seasonal document with the team name
        await setDoc(seasonRecordRef, seasonalData, { merge: true });

        alert('Team updated successfully!');
        teamModal.classList.remove('is-visible');
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