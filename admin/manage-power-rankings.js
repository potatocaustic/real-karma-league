// /admin/manage-power-rankings.js

import { auth, db, onAuthStateChanged, doc, getDoc, collection, getDocs, writeBatch, query, setDoc } from '/js/firebase-init.js';

// --- DEV ENVIRONMENT CONFIG ---
const USE_DEV_COLLECTIONS = false;
const getCollectionName = (baseName) => USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;

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
let prevRankingsMap = new Map();
let currentSeasonId = null;
let currentVersion = 0;
const TOTAL_TEAMS = 30;

// --- Primary Auth Check & Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            const userRef = doc(db, getCollectionName("users"), user.uid);
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
        populateVersions();
        await populateSeasons();

        seasonSelect.addEventListener('change', async () => {
            currentSeasonId = seasonSelect.value;
            await updateTeamCache(currentSeasonId);
            await loadRankingsBoard();
        });

        versionSelect.addEventListener('change', loadRankingsBoard);
        rankingsForm.addEventListener('submit', handleFormSubmit);
        rankingsBody.addEventListener('change', handleSelectionChange);

    } catch (error) {
        console.error("Error initializing page:", error);
        rankingsBody.innerHTML = `<tr><td colspan="4" class="error">Could not load team data.</td></tr>`;
    }
}

async function updateTeamCache(seasonId) {
    const teamsSnap = await getDocs(collection(db, getCollectionName("v2_teams")));
    const teamPromises = teamsSnap.docs.map(async (teamDoc) => {
        if (!teamDoc.data().conference) return null;

        const teamData = { id: teamDoc.id, ...teamDoc.data() };
        const seasonRecordRef = doc(db, getCollectionName("v2_teams"), teamDoc.id, getCollectionName("seasonal_records"), seasonId);
        const seasonRecordSnap = await getDoc(seasonRecordRef);

        teamData.team_name = seasonRecordSnap.exists() ? seasonRecordSnap.data().team_name : "Name Not Found";
        return teamData;
    });

    const teamsWithData = (await Promise.all(teamPromises)).filter(Boolean);
    allTeams = teamsWithData.filter(team => team.conference);
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

    await updateTeamCache(currentSeasonId);
    await loadRankingsBoard();
}

function populateVersions() {
    let versionOptions = '';
    for (let i = 0; i <= 10; i++) {
        const label = i === 0 ? 'v0 (Preseason)' : `v${i} (After Week ${i * 3})`;
        versionOptions += `<option value="${i}">${label}</option>`;
    }
    versionSelect.innerHTML = versionOptions;
    versionSelect.value = "0";
}

async function loadRankingsBoard() {
    currentSeasonId = seasonSelect.value;
    currentVersion = parseInt(versionSelect.value, 10);
    rankingsBody.innerHTML = `<tr><td colspan="4" class="loading">Loading rankings...</td></tr>`;

    if (!currentSeasonId || isNaN(currentVersion)) return;

    const seasonNumber = currentSeasonId.replace('S', '');
    const prevVersion = currentVersion - 1;

    const prevRankingsPath = prevVersion >= 0 ? `${getCollectionName('power_rankings')}/season_${seasonNumber}/v${prevVersion}` : null;
    const currentRankingsPath = `${getCollectionName('power_rankings')}/season_${seasonNumber}/v${currentVersion}`;

    const [prevRankingsSnap, currentRankingsSnap] = await Promise.all([
        prevRankingsPath ? getDocs(collection(db, prevRankingsPath)) : Promise.resolve(null),
        getDocs(collection(db, currentRankingsPath))
    ]);

    prevRankingsMap.clear();
    if (prevRankingsSnap) {
        prevRankingsSnap.forEach(doc => prevRankingsMap.set(doc.id, doc.data().rank));
    }

    const currentRankToTeamMap = new Map();
    currentRankingsSnap.forEach(doc => currentRankToTeamMap.set(doc.data().rank, doc.id));

    const teamOptionsHTML = `<option value="">-- Select Team --</option>` + allTeams
        .sort((a, b) => a.team_name.localeCompare(b.team_name))
        .map(t => `<option value="${t.id}">${t.team_name}</option>`).join('');

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

    calculateAllChanges();
    validateRankings();
    updateTeamSelectOptions();
}

function handleSelectionChange(e) {
    if (e.target.classList.contains('team-select')) {
        calculateAllChanges();
        validateRankings();
        updateTeamSelectOptions();
    }
}

function updateTeamSelectOptions() {
    const selectedTeamIds = new Set();
    document.querySelectorAll('#power-rankings-body .team-select').forEach(select => {
        if (select.value) {
            selectedTeamIds.add(select.value);
        }
    });

    document.querySelectorAll('#power-rankings-body .team-select').forEach(select => {
        const currentSelectionInThisDropdown = select.value;
        select.querySelectorAll('option').forEach(option => {
            if (option.value && selectedTeamIds.has(option.value) && option.value !== currentSelectionInThisDropdown) {
                option.hidden = true;
            } else {
                option.hidden = false;
            }
        });
    });
}


function calculateAllChanges() {
    rankingsBody.querySelectorAll('tr').forEach(row => {
        const selectedTeamId = row.querySelector('.team-select').value;
        const prevRankCell = row.querySelector('.previous-rank');
        const changeCell = row.querySelector('.rank-change');

        if (selectedTeamId && prevRankingsMap.has(selectedTeamId)) {
            const newRank = parseInt(row.dataset.rank);
            const prevRank = prevRankingsMap.get(selectedTeamId);
            const change = prevRank - newRank;

            prevRankCell.textContent = prevRank;
            changeCell.textContent = change > 0 ? `+${change}` : change;
            changeCell.className = 'rank-change';
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

    rankingsBody.querySelectorAll('tr').forEach(row => row.classList.remove('has-duplicate'));

    rankingsBody.querySelectorAll('.team-select').forEach(select => {
        const teamId = select.value;
        if (!teamId) return;

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

    if (isValid) {
        const assignedCount = Array.from(rankingsBody.querySelectorAll('.team-select')).filter(s => s.value).length;
        if (assignedCount < TOTAL_TEAMS) {
            isValid = false;
            errorMessage = `Not all teams have been assigned a rank. ${TOTAL_TEAMS - assignedCount} remaining.`;
        }
    }

    saveButton.disabled = !isValid;
    validationContainer.innerHTML = isValid ? '' : `<p class="validation-message">${errorMessage}</p>`;
}


async function handleFormSubmit(e) {
    e.preventDefault();
    saveButton.disabled = true;
    saveButton.textContent = 'Saving...';

    try {
        const versionToSave = parseInt(versionSelect.value, 10);
        if (isNaN(versionToSave)) {
            alert("Error: A valid version is not selected. Cannot save.");
            saveButton.disabled = false;
            saveButton.textContent = 'Save Rankings';
            return;
        }

        const batch = writeBatch(db);
        const seasonNumber = currentSeasonId.replace('S', '');
        const seasonDocName = `season_${seasonNumber}`;
        const rankingsCollectionPath = `${getCollectionName('power_rankings')}/${seasonDocName}/v${versionToSave}`;
        const rankingsCollectionRef = collection(db, rankingsCollectionPath);

        const teamRecordsMap = new Map();
        const seasonalRecordsPromises = allTeams.map(team => {
            const recordRef = doc(db, getCollectionName("v2_teams"), team.id, getCollectionName("seasonal_records"), currentSeasonId);
            return getDoc(recordRef);
        });
        const seasonalRecordsSnaps = await Promise.all(seasonalRecordsPromises);
        seasonalRecordsSnaps.forEach(snap => {
            if (snap.exists()) {
                const teamId = snap.ref.parent.parent.id;
                teamRecordsMap.set(teamId, snap.data());
            }
        });
        // --- END NEW ---

        const ranksToWrite = [];
        let error = false;
        rankingsBody.querySelectorAll('tr').forEach(row => {
            const teamId = row.querySelector('.team-select').value;
            if (!teamId) {
                error = true;
            }
            ranksToWrite.push({
                rank: parseInt(row.dataset.rank),
                teamId: teamId
            });
        });

        if (error) {
            alert("All ranks must be filled before saving.");
            saveButton.disabled = false;
            saveButton.textContent = 'Save Rankings';
            return;
        }

        const existingDocsSnap = await getDocs(rankingsCollectionRef);
        existingDocsSnap.forEach(doc => batch.delete(doc.ref));

        for (const item of ranksToWrite) {
            const team = allTeams.find(t => t.id === item.teamId);
            const previous_rank = prevRankingsMap.get(item.teamId) || null;
            const change = previous_rank !== null ? previous_rank - item.rank : null;
            const teamRecord = teamRecordsMap.get(item.teamId) || { wins: 0, losses: 0 };

            const docRef = doc(rankingsCollectionRef, item.teamId);
            batch.set(docRef, {
                team_id: item.teamId,
                team_name: team.team_name,
                rank: item.rank,
                previous_rank: previous_rank,
                change: change,
                version: versionToSave,
                season: currentSeasonId,
                // --- NEW FIELDS ---
                power_wins: teamRecord.wins || 0,
                power_losses: teamRecord.losses || 0
            });
        }
        
        const seasonDocRef = doc(db, getCollectionName('power_rankings'), seasonDocName);
        const versionLabel = `v${versionToSave}`;
        
        batch.set(seasonDocRef, { 
            latest_version: versionLabel,
        }, { merge: true });

        await batch.commit();
        alert(`Power Rankings ${versionLabel} saved successfully!`);

    } catch (error) {
        console.error("Error saving power rankings:", error);
        alert('An error occurred. Please check the console.');
    } finally {
        saveButton.disabled = false;
        saveButton.textContent = 'Save Rankings';
    }
}
