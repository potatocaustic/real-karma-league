// /admin/manage-power-rankings.js

import { auth, db, onAuthStateChanged, doc, getDoc, collection, getDocs, writeBatch } from '/js/firebase-init.js';

// --- Page Elements ---
const loadingContainer = document.getElementById('loading-container');
const adminContainer = document.getElementById('admin-container');
const seasonSelect = document.getElementById('season-select');
const versionSelect = document.getElementById('version-select');
const rankingsBody = document.getElementById('power-rankings-body');
const rankingsForm = document.getElementById('power-rankings-form');
const saveButton = document.getElementById('save-rankings-btn');
const validationContainer = document.getElementById('validation-message-container');

// --- Global Data Cache ---
let allTeams = [];
let currentSeasonId = 'S7';
let currentVersion = 0;
const TOTAL_TEAMS = 30;

// --- Primary Auth Check & Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            const userRef = doc(db, "users", user.uid);
            const userDoc = await getDoc(userRef);
            if (userDoc.exists() && userDoc.data().role === 'admin') {
                await initializePage();
                loadingContainer.style.display = 'none';
                adminContainer.style.display = 'block';
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
        const teamsSnap = await getDocs(collection(db, "v2_teams"));
        allTeams = teamsSnap.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(team => team.conference); // Only include teams with a conference

        if (allTeams.length !== TOTAL_TEAMS) {
            console.warn(`Expected ${TOTAL_TEAMS} teams but found ${allTeams.length}.`);
        }

        populateSelectors();
        await loadRankingsBoard();

        versionSelect.addEventListener('change', loadRankingsBoard);
        rankingsForm.addEventListener('submit', handleFormSubmit);
        rankingsBody.addEventListener('change', validateRankings);

    } catch (error) {
        console.error("Error initializing page:", error);
        rankingsBody.innerHTML = `<tr><td colspan="4" class="error">Could not load team data.</td></tr>`;
    }
}

function populateSelectors() {
    seasonSelect.innerHTML = `<option value="S7">Season 7</option>`; // Static for now

    let versionOptions = '';
    for (let i = 0; i <= 10; i++) { // v0 to v10
        const label = i === 0 ? 'v0 (Preseason)' : `v${i} (After Week ${i * 3})`;
        versionOptions += `<option value="${i}">${label}</option>`;
    }
    versionSelect.innerHTML = versionOptions;
}

async function loadRankingsBoard() {
    currentVersion = parseInt(versionSelect.value);
    rankingsBody.innerHTML = `<tr><td colspan="4" class="loading">Loading rankings...</td></tr>`;

    const seasonNumber = currentSeasonId.replace('S', '');
    const prevVersion = currentVersion - 1;

    // Fetch previous and current rankings in parallel
    const [prevRankingsSnap, currentRankingsSnap] = await Promise.all([
        prevVersion >= 0 ? getDocs(collection(db, `power_rankings/season_${seasonNumber}/v${prevVersion}`)) : Promise.resolve(null),
        getDocs(collection(db, `power_rankings/season_${seasonNumber}/v${currentVersion}`))
    ]);

    const prevRankingsMap = new Map();
    if (prevRankingsSnap) {
        prevRankingsSnap.forEach(doc => prevRankingsMap.set(doc.id, doc.data()));
    }

    const currentRankingsMap = new Map();
    currentRankingsSnap.forEach(doc => currentRankingsMap.set(doc.id, doc.data()));

    // Generate rank dropdown options
    let rankOptionsHTML = `<option value="0">--</option>`;
    for (let i = 1; i <= TOTAL_TEAMS; i++) {
        rankOptionsHTML += `<option value="${i}">${i}</option>`;
    }

    // Build the table body
    let tableHTML = '';
    allTeams.sort((a, b) => a.team_name.localeCompare(b.team_name)).forEach(team => {
        const prevRankData = prevRankingsMap.get(team.id);
        const currentRankData = currentRankingsMap.get(team.id);

        const prevRank = prevRankData ? prevRankData.rank : 'N/A';
        const currentRank = currentRankData ? currentRankData.rank : 0;

        tableHTML += `
            <tr data-team-id="${team.id}">
                <td>${team.team_name}</td>
                <td>
                    <select class="rank-select">
                        ${rankOptionsHTML.replace(`value="${currentRank}"`, `value="${currentRank}" selected`)}
                    </select>
                </td>
                <td class="previous-rank">${prevRank}</td>
                <td class="rank-change">--</td>
            </tr>
        `;
    });
    rankingsBody.innerHTML = tableHTML;

    // Initial calculation and validation
    calculateAllChanges();
    validateRankings();
}

function calculateAllChanges() {
    rankingsBody.querySelectorAll('tr').forEach(row => {
        const newRank = parseInt(row.querySelector('.rank-select').value);
        const prevRankText = row.querySelector('.previous-rank').textContent;
        const prevRank = prevRankText === 'N/A' ? null : parseInt(prevRankText);
        const changeCell = row.querySelector('.rank-change');

        if (newRank > 0 && prevRank !== null) {
            const change = prevRank - newRank; // Lower rank number is better
            changeCell.textContent = change > 0 ? `+${change}` : change;
            changeCell.className = 'rank-change'; // Reset
            if (change > 0) changeCell.classList.add('positive');
            if (change < 0) changeCell.classList.add('negative');
        } else {
            changeCell.textContent = '--';
            changeCell.className = 'rank-change';
        }
    });
}

function validateRankings() {
    calculateAllChanges();
    const assignedRanks = new Map();
    let isValid = true;
    let errorMessage = '';

    // Reset all rows
    rankingsBody.querySelectorAll('tr').forEach(row => row.classList.remove('has-duplicate'));

    // Check for duplicates
    rankingsBody.querySelectorAll('.rank-select').forEach(select => {
        const rank = select.value;
        if (rank === "0") return; // Ignore unassigned ranks

        if (assignedRanks.has(rank)) {
            assignedRanks.get(rank).push(select.closest('tr'));
        } else {
            assignedRanks.set(rank, [select.closest('tr')]);
        }
    });

    assignedRanks.forEach((rows, rank) => {
        if (rows.length > 1) {
            isValid = false;
            errorMessage = `Rank ${rank} is assigned to multiple teams.`;
            rows.forEach(row => row.classList.add('has-duplicate'));
        }
    });

    // Check if all ranks are assigned
    if (isValid && assignedRanks.size !== TOTAL_TEAMS) {
        isValid = false;
        errorMessage = 'Not all ranks from 1-30 have been assigned.';
    }

    saveButton.disabled = !isValid;
    validationContainer.innerHTML = isValid ? '' : `<p class="validation-message">${errorMessage}</p>`;
}

async function handleFormSubmit(e) {
    e.preventDefault();
    saveButton.disabled = true;
    saveButton.textContent = 'Saving...';

    try {
        const batch = writeBatch(db);
        const seasonNumber = currentSeasonId.replace('S', '');
        const rankingsCollectionRef = collection(db, `power_rankings/season_${seasonNumber}/v${currentVersion}`);

        rankingsBody.querySelectorAll('tr').forEach(row => {
            const teamId = row.dataset.teamId;
            const team = allTeams.find(t => t.id === teamId);
            const rank = parseInt(row.querySelector('.rank-select').value);
            const prevRankText = row.querySelector('.previous-rank').textContent;
            const previous_rank = prevRankText === 'N/A' ? null : parseInt(prevRankText);
            const change = previous_rank !== null ? previous_rank - rank : null;

            const docRef = doc(rankingsCollectionRef, teamId);
            batch.set(docRef, {
                team_id: teamId,
                team_name: team.team_name,
                rank: rank,
                previous_rank: previous_rank,
                change: change
            });
        });

        await batch.commit();
        alert(`Power Rankings v${currentVersion} saved successfully!`);

    } catch (error) {
        console.error("Error saving power rankings:", error);
        alert('An error occurred. Please check the console.');
    } finally {
        saveButton.disabled = false;
        saveButton.textContent = 'Save Rankings';
    }
}
