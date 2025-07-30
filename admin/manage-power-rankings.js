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
let prevRankingsMap = new Map(); // Stores { teamId: rank } for the previous version
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
        rankingsBody.addEventListener('change', handleSelectionChange);

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

    // Create a map of { teamId: rank } for the previous version
    prevRankingsMap.clear();
    if (prevRankingsSnap) {
        prevRankingsSnap.forEach(doc => prevRankingsMap.set(doc.id, doc.data().rank));
    }

    // Create a map of { rank: teamId } for the current version to pre-populate selections
    const currentRankToTeamMap = new Map();
    currentRankingsSnap.forEach(doc => currentRankToTeamMap.set(doc.data().rank, doc.id));

    // Generate team dropdown options
    const teamOptionsHTML = `<option value="">-- Select Team --</option>` + allTeams
        .sort((a, b) => a.team_name.localeCompare(b.team_name))
        .map(t => `<option value="${t.id}">${t.team_name}</option>`).join('');

    // Build the table body with 30 rows for ranks 1-30
    let tableHTML = '';
    for (let rank = 1; rank <= TOTAL_TEAMS; rank++) {
        const selectedTeamId = currentRankToTeamMap.get(rank) || "";

        tableHTML += `
            <tr data-rank="${rank}">
                <td style="text-align:center; font-weight:bold;">${rank}</td>
                <td>
                    <select class="team-select">
                        ${teamOptionsHTML.replace(`value="${selectedTeamId}"`, `value="${selectedTeamId}" selected`)}
                    </select>
                </td>
                <td class="previous-rank">--</td>
                <td class="rank-change">--</td>
            </tr>
        `;
    }
    rankingsBody.innerHTML = tableHTML;

    // Initial calculation and validation
    calculateAllChanges();
    validateRankings();
}

function handleSelectionChange(e) {
    if (e.target.classList.contains('team-select')) {
        calculateAllChanges();
        validateRankings();
    }
}

function calculateAllChanges() {
    rankingsBody.querySelectorAll('tr').forEach(row => {
        const selectedTeamId = row.querySelector('.team-select').value;
        const prevRankCell = row.querySelector('.previous-rank');
        const changeCell = row.querySelector('.rank-change');

        if (selectedTeamId && prevRankingsMap.has(selectedTeamId)) {
            const newRank = parseInt(row.dataset.rank);
            const prevRank = prevRankingsMap.get(selectedTeamId);
            const change = prevRank - newRank; // Lower rank number is better

            prevRankCell.textContent = prevRank;
            changeCell.textContent = change > 0 ? `+${change}` : change;
            changeCell.className = 'rank-change'; // Reset
            if (change > 0) changeCell.classList.add('positive');
            if (change < 0) changeCell.classList.add('negative');
        } else {
            prevRankCell.textContent = selectedTeamId ? 'N/A' : '--';
            changeCell.textContent = '--';
            changeCell.className = 'rank-change';
        }
    });
}

function validateRankings() {
    const assignedTeams = new Map();
    let isValid = true;
    let errorMessage = '';

    // Reset all rows
    rankingsBody.querySelectorAll('tr').forEach(row => row.classList.remove('has-duplicate'));

    // Check for duplicate teams
    rankingsBody.querySelectorAll('.team-select').forEach(select => {
        const teamId = select.value;
        if (!teamId) return; // Ignore unassigned ranks

        if (assignedTeams.has(teamId)) {
            assignedTeams.get(teamId).push(select.closest('tr'));
        } else {
            assignedTeams.set(teamId, [select.closest('tr')]);
        }
    });

    assignedTeams.forEach((rows, teamId) => {
        if (rows.length > 1) {
            isValid = false;
            const teamName = allTeams.find(t => t.id === teamId)?.team_name || 'A team';
            errorMessage = `${teamName} has been assigned to multiple ranks.`;
            rows.forEach(row => row.classList.add('has-duplicate'));
        }
    });

    // Check if all teams are assigned
    if (isValid && assignedTeams.size !== TOTAL_TEAMS) {
        isValid = false;
        errorMessage = 'Not all teams have been assigned a rank.';
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
            const rank = parseInt(row.dataset.rank);
            const teamId = row.querySelector('.team-select').value;
            const team = allTeams.find(t => t.id === teamId);

            const previous_rank = prevRankingsMap.get(teamId) || null;
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
