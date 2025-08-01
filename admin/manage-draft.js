// /admin/manage-draft.js

import { auth, db, onAuthStateChanged, doc, getDoc, collection, getDocs, writeBatch, query, where } from '/js/firebase-init.js';

// --- Page Elements ---
const loadingContainer = document.getElementById('loading-container');
const adminContainer = document.getElementById('admin-container');
const authStatusDiv = document.getElementById('auth-status');
const seasonSelect = document.getElementById('season-select');
const draftTableBody = document.getElementById('draft-table-body');
const draftForm = document.getElementById('draft-form');

// --- Global Data Cache ---
let allTeams = [];
let currentSeasonId = null;
const TOTAL_PICKS = 90;

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
        // First, find the active season to get the correct team names
        const seasonsQuery = query(collection(db, "seasons"), where("status", "==", "active"));
        const activeSeasonsSnap = await getDocs(seasonsQuery);
        const activeSeasonId = !activeSeasonsSnap.empty ? activeSeasonsSnap.docs[0].id : null;

        if (!activeSeasonId) {
            throw new Error("Could not determine the active season to fetch team names.");
        }

        // Now fetch all teams and their seasonal names
        const teamsSnap = await getDocs(collection(db, "v2_teams"));
        const teamPromises = teamsSnap.docs.map(async (teamDoc) => {
            if (!teamDoc.data().conference) return null; // Filter out non-team documents
            const teamData = { id: teamDoc.id, ...teamDoc.data() };
            const seasonRecordRef = doc(db, "v2_teams", teamDoc.id, "seasonal_records", activeSeasonId);
            const seasonRecordSnap = await getDoc(seasonRecordRef);

            teamData.team_name = seasonRecordSnap.exists() ? seasonRecordSnap.data().team_name : "Name Not Found";
            return teamData;
        });

        allTeams = (await Promise.all(teamPromises))
            .filter(Boolean)
            .sort((a, b) => (a.team_name || '').localeCompare(b.team_name || ''));

        await populateSeasons();

        seasonSelect.addEventListener('change', () => {
            currentSeasonId = seasonSelect.value;
            loadDraftBoard();
        });

        draftForm.addEventListener('submit', handleDraftSubmit);

    } catch (error) {
        console.error("Error initializing draft page:", error);
        draftTableBody.innerHTML = `<tr><td colspan="5" class="error">Could not load required league data.</td></tr>`;
    }
}

async function populateSeasons() {
    const seasonsSnap = await getDocs(query(collection(db, "seasons")));
    let activeSeasonId = null;
    const sortedDocs = seasonsSnap.docs.sort((a, b) => b.id.localeCompare(a.id));

    seasonSelect.innerHTML = sortedDocs.map(doc => {
        const seasonData = doc.data();
        if (seasonData.status === 'active') {
            activeSeasonId = doc.id;
        }
        // For draft, we often manage the *next* season's draft
        const seasonNum = parseInt(doc.id.replace('S', ''), 10);
        return `<option value="S${seasonNum + 1}">S${seasonNum + 1} Draft</option>`;
    }).join('');

    // Set a default selection
    if (activeSeasonId) {
        const activeNum = parseInt(activeSeasonId.replace('S', ''), 10);
        seasonSelect.value = `S${activeNum + 1}`;
    }

    currentSeasonId = seasonSelect.value;
    await loadDraftBoard();
}

async function loadDraftBoard() {
    if (!currentSeasonId) {
        draftTableBody.innerHTML = `<tr><td colspan="5" class="placeholder-text">Please select a draft season.</td></tr>`;
        return;
    }
    draftTableBody.innerHTML = `<tr><td colspan="5" class="loading">Loading draft board...</td></tr>`;

    const seasonNumber = currentSeasonId.replace('S', '');
    const draftResultsCollectionRef = collection(db, `draft_results/season_${seasonNumber}/S${seasonNumber}_draft_results`);
    const existingPicksSnap = await getDocs(draftResultsCollectionRef);
    const existingPicksMap = new Map();
    existingPicksSnap.forEach(doc => {
        existingPicksMap.set(doc.data().overall, doc.data());
    });

    let tableHTML = '';
    const teamOptionsHTML = `<option value="">-- Select Team --</option>` + allTeams.map(t => `<option value="${t.id}">${t.team_name}</option>`).join('');

    for (let i = 1; i <= TOTAL_PICKS; i++) {
        const overall = i;
        const round = Math.ceil(overall / 30);
        const existingPick = existingPicksMap.get(overall);

        const selectedTeam = existingPick?.team_id || '';
        const playerHandle = existingPick?.player_handle || '';
        const isForfeited = existingPick?.forfeit || false;

        tableHTML += `
            <tr id="pick-row-${overall}" class="${isForfeited ? 'is-forfeited' : ''}">
                <td class="read-only">${overall}</td>
                <td class="read-only">${round}</td>
                <td>
                    <select data-overall="${overall}" class="team-select" ${isForfeited ? 'disabled' : ''}>
                        ${teamOptionsHTML.replace(`value="${selectedTeam}"`, `value="${selectedTeam}" selected`)}
                    </select>
                </td>
                <td>
                    <input type="text" data-overall="${overall}" class="player-handle-input" value="${playerHandle}" placeholder="Enter player handle..." ${isForfeited ? 'disabled' : ''}>
                </td>
                <td style="text-align: center;">
                    <input type="checkbox" data-overall="${overall}" class="forfeit-checkbox" ${isForfeited ? 'checked' : ''}>
                </td>
            </tr>
        `;
    }
    draftTableBody.innerHTML = tableHTML;

    draftTableBody.querySelectorAll('.forfeit-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            const overall = e.target.dataset.overall;
            const row = document.getElementById(`pick-row-${overall}`);
            const isDisabled = e.target.checked;

            row.classList.toggle('is-forfeited', isDisabled);
            row.querySelector('.team-select').disabled = isDisabled;
            row.querySelector('.player-handle-input').disabled = isDisabled;
        });
    });
}

async function handleDraftSubmit(e) {
    e.preventDefault();
    const saveButton = e.target.querySelector('button[type="submit"]');
    saveButton.disabled = true;
    saveButton.textContent = 'Saving...';

    try {
        const batch = writeBatch(db);
        const seasonNumber = currentSeasonId.replace('S', '');
        const draftResultsCollectionRef = collection(db, `draft_results/season_${seasonNumber}/S${seasonNumber}_draft_results`);

        for (let i = 1; i <= TOTAL_PICKS; i++) {
            const row = document.getElementById(`pick-row-${i}`);
            const round = Math.ceil(i / 30);
            const teamId = row.querySelector('.team-select').value;
            const playerHandle = row.querySelector('.player-handle-input').value.trim();
            const isForfeited = row.querySelector('.forfeit-checkbox').checked;

            const docId = `round-${round}-pick-${i}`;
            const docRef = doc(draftResultsCollectionRef, docId);

            const draftData = {
                overall: i,
                round: round,
                team_id: isForfeited ? null : teamId,
                player_handle: isForfeited ? null : playerHandle,
                forfeit: isForfeited,
                season: currentSeasonId
            };

            batch.set(docRef, draftData);
        }

        await batch.commit();
        alert('Draft results saved successfully!');

    } catch (error) {
        console.error("Error saving draft results:", error);
        alert('An error occurred while saving. Please check the console.');
    } finally {
        saveButton.disabled = false;
        saveButton.textContent = 'Save Draft Results';
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