// /admin/manage-games.js

import { auth, db, functions, onAuthStateChanged, doc, getDoc, collection, getDocs, updateDoc, setDoc, deleteDoc, httpsCallable, query, where, documentId, limit } from '/js/firebase-init.js';
import { writeBatch } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

// --- DEV ENVIRONMENT CONFIG ---
const USE_DEV_COLLECTIONS = false;
const getCollectionName = (baseName) => {
    // Handle dynamically generated collection names
    if (baseName.includes('_awards') || baseName.includes('_lineups') || baseName.includes('_games') || baseName.includes('pending_lineups') || baseName.includes('lineup_deadlines')) {
        return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
    }
    return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
};

// --- Page Elements ---
let loadingContainer, adminContainer, authStatusDiv, seasonSelect, weekSelect, gamesListContainer, lineupModal, lineupForm, closeLineupModalBtn, liveScoringControls;
let deadlineForm, deadlineDateInput, deadlineDisplay;



// --- Global Data Cache ---
let currentSeasonId = null;
let allTeams = new Map();
let allPlayers = new Map();
let allGms = new Map();
let awardSelections = new Map();
let currentGameData = null;
let lastCheckedCaptain = { team1: null, team2: null };

document.addEventListener('DOMContentLoaded', () => {
    loadingContainer = document.getElementById('loading-container');
    adminContainer = document.getElementById('admin-container');
    authStatusDiv = document.getElementById('auth-status');
    seasonSelect = document.getElementById('season-select');
    weekSelect = document.getElementById('week-select');
    gamesListContainer = document.getElementById('games-list-container');
    lineupModal = document.getElementById('lineup-modal');
    lineupForm = document.getElementById('lineup-form');
    closeLineupModalBtn = lineupModal.querySelector('.close-btn-admin');
    liveScoringControls = document.getElementById('live-scoring-controls');
    deadlineForm = document.getElementById('deadline-form');
    deadlineDateInput = document.getElementById('deadline-date');
    deadlineDisplay = document.getElementById('current-deadline-display');



    onAuthStateChanged(auth, async (user) => {
        try {
            if (user) {
                const userRef = doc(db, getCollectionName("users"), user.uid);
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
        } catch (error) {
            console.error("Fatal Error during Authentication/Initialization:", error);
            loadingContainer.innerHTML = `<div class="error">A critical error occurred. Please check the console and refresh.</div>`;
        }
    });
});

async function initializePage() {
    try {
        const playersSnap = await getDocs(collection(db, getCollectionName("v2_players")));
        playersSnap.docs.forEach(doc => {
            allPlayers.set(doc.id, { id: doc.id, ...doc.data() });
        });

    } catch (error) {
        console.error("Failed to cache core data:", error);
    }

    await populateSeasons();

    seasonSelect.addEventListener('change', async () => {
        currentSeasonId = seasonSelect.value;
        if (currentSeasonId) {
            await updateTeamCache(currentSeasonId);
            await updateAwardsCache(currentSeasonId);
        }
        await handleSeasonChange();
    });

    weekSelect.addEventListener('change', () => {
        if (currentSeasonId && weekSelect.value) {
            fetchAndDisplayGames(currentSeasonId, weekSelect.value);
        }
    });

    gamesListContainer.addEventListener('click', handleOpenModalClick);
    closeLineupModalBtn.addEventListener('click', () => lineupModal.classList.remove('is-visible'));
    lineupForm.addEventListener('submit', handleLineupFormSubmit);
    lineupForm.addEventListener('input', calculateAllScores);
    document.getElementById('team1-starters').addEventListener('click', handleCaptainToggle);
    document.getElementById('team2-starters').addEventListener('click', handleCaptainToggle);

    if (liveScoringControls) {
        liveScoringControls.addEventListener('click', (e) => {
            if (e.target.id === 'submit-live-lineups-btn') {
                handleStageLiveLineups(e);
            } else if (e.target.id === 'finalize-live-game-btn') {
                handleFinalizeLiveGame(e);
            }
        });
    }

    // ======================= MODIFICATION START =======================
    deadlineForm.addEventListener('submit', handleSetDeadline);
    deadlineDateInput.addEventListener('change', () => displayDeadlineForDate(deadlineDateInput.value));
    // ======================= MODIFICATION END =======================
}

async function updateAwardsCache(seasonId) {
    awardSelections.clear();
    const seasonNumber = seasonId.replace('S', '');
    const awardsRef = collection(db, `${getCollectionName('awards')}/season_${seasonNumber}/${getCollectionName(`S${seasonNumber}_awards`)}`);
    const awardsSnap = await getDocs(awardsRef);
    awardsSnap.forEach(doc => awardSelections.set(doc.id, doc.data()));
}

async function updateTeamCache(seasonId) {
    allTeams.clear();
    allGms.clear(); 

    const teamsSnap = await getDocs(collection(db, getCollectionName("v2_teams")));

    const teamPromises = teamsSnap.docs.map(async (teamDoc) => {
        if (!teamDoc.data().conference) {
            return null;
        }

        const teamData = { id: teamDoc.id, ...teamDoc.data() };
        const seasonRecordRef = doc(db, getCollectionName("v2_teams"), teamDoc.id, getCollectionName("seasonal_records"), seasonId);
        const seasonRecordSnap = await getDoc(seasonRecordRef);

        if (seasonRecordSnap.exists()) {
            teamData.team_name = seasonRecordSnap.data().team_name;
        } else {
            teamData.team_name = "Name Not Found";
        }
        
        if (teamData.current_gm_handle && teamData.gm_player_id && teamData.conference) {
            allGms.set(teamData.gm_player_id, {
                id: teamData.gm_player_id,
                player_handle: teamData.current_gm_handle,
                conference: teamData.conference
            });
        }
        return teamData;
    });

    const teamsWithData = (await Promise.all(teamPromises)).filter(Boolean);
    teamsWithData.forEach(team => allTeams.set(team.id, team));
}

async function populateSeasons() {
    try {
        const seasonsSnap = await getDocs(query(collection(db, getCollectionName("seasons"))));
        if (seasonsSnap.empty) {
            seasonSelect.innerHTML = `<option value="">No Seasons Found</option>`;
            return;
        }

        let activeSeasonId = null;
        const seasonOptions = seasonsSnap.docs
            .sort((a, b) => b.id.localeCompare(a.id))
            .map(doc => {
                const seasonData = doc.data();
                if (seasonData.status === 'active') {
                    activeSeasonId = doc.id;
                }
                return `<option value="${doc.id}">${seasonData.season_name}</option>`;
            }).join('');

        seasonSelect.innerHTML = `<option value="">Select a season...</option>${seasonOptions}`;

        if (activeSeasonId) {
            seasonSelect.value = activeSeasonId;
        }

        currentSeasonId = seasonSelect.value;

        if (currentSeasonId) {
            await updateTeamCache(currentSeasonId);
            await updateAwardsCache(currentSeasonId);
            await handleSeasonChange();
        }

    } catch (error) {
        console.error("Error populating seasons:", error);
    }
}

async function findEarliestIncompleteWeek(seasonId) {
    const weeksInOrder = [
        '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15',
        'All-Star', 'Relegation', 'Play-In', 'Round 1', 'Round 2', 'Conf Finals', 'Finals'
    ];

    for (const week of weeksInOrder) {
        const isPostseason = !/^\d+$/.test(week) && week !== 'All-Star' && week !== 'Relegation';
        const isExhibition = week === 'All-Star' || week === 'Relegation';

        let collectionName = 'games';
        if (isPostseason) collectionName = 'post_games';
        if (isExhibition) collectionName = 'exhibition_games';

        const gamesCollectionRef = collection(db, getCollectionName("seasons"), seasonId, getCollectionName(collectionName));
        const q = query(gamesCollectionRef, where("week", "==", week), where("completed", "==", "FALSE"), limit(1));
        
        const querySnapshot = await getDocs(q);
        if (!querySnapshot.empty) {
            console.log(`Found incomplete games in week: ${week}. Setting as default.`);
            return week;
        }
    }

    console.log("No incomplete games found in any week. Defaulting to Week 1.");
    return '1';
}

async function handleSeasonChange() {
    if (currentSeasonId) {
        await populateWeeks(currentSeasonId);
        const defaultWeek = await findEarliestIncompleteWeek(currentSeasonId);
        weekSelect.value = defaultWeek;
        await fetchAndDisplayGames(currentSeasonId, defaultWeek);
    } else {
        weekSelect.innerHTML = '<option>Select a season...</option>';
        gamesListContainer.innerHTML = '<p class="placeholder-text">Please select a season to view games.</p>';
    }
}


async function populateWeeks(seasonId) {
    let weekOptions = '';
    for (let i = 1; i <= 15; i++) weekOptions += `<option value="${i}">Week ${i}</option>`;
    weekOptions += `<option value="All-Star">All-Star</option>`;
    weekOptions += `<option value="Relegation">Relegation</option>`;
    weekOptions += `<option value="Play-In">Play-In</option>`;
    weekOptions += `<option value="Round 1">Round 1</option>`;
    weekOptions += `<option value="Round 2">Round 2</option>`;
    weekOptions += `<option value="Conf Finals">Conference Finals</option>`;
    weekOptions += `<option value="Finals">Finals</option>`;
    weekSelect.innerHTML = `<option value="">Select a week...</option>${weekOptions}`;
}

/**
 * MODIFICATION: This function now populates the deadline date input with the
 * date of the first game in the list for the selected week.
 */
async function fetchAndDisplayGames(seasonId, week) {
    gamesListContainer.innerHTML = '<div class="loading">Fetching games...</div>';

    const liveGamesRef = collection(db, getCollectionName('live_games'));
    const liveGamesSnap = await getDocs(liveGamesRef);
    const liveGameIds = new Set(liveGamesSnap.docs.map(doc => doc.id));

    const isPostseason = !/^\d+$/.test(week) && week !== 'All-Star' && week !== 'Relegation';
    const isExhibition = week === 'All-Star' || week === 'Relegation';
    let collectionName = isPostseason ? 'post_games' : isExhibition ? 'exhibition_games' : 'games';

    const gamesQuery = query(collection(db, getCollectionName("seasons"), seasonId, getCollectionName(collectionName)), where("week", "==", week));

    try {
        const querySnapshot = await getDocs(gamesQuery);
        if (querySnapshot.empty) {
            gamesListContainer.innerHTML = '<p class="placeholder-text">No games found for this week.</p>';
            // ======================= MODIFICATION START =======================
            deadlineDateInput.value = '';
            deadlineDisplay.innerHTML = '<p>Select a date to see the current deadline.</p>';
            // ======================= MODIFICATION END =======================
            return;
        }

        const gameIds = querySnapshot.docs.map(doc => doc.id);
        const pendingLineups = new Map();

        if (gameIds.length > 0) {
            const pendingQuery = query(collection(db, getCollectionName('pending_lineups')), where(documentId(), 'in', gameIds));
            const pendingSnap = await getDocs(pendingQuery);
            pendingSnap.forEach(doc => {
                pendingLineups.set(doc.id, doc.data());
            });
        }

        let gamesHTML = '';
        querySnapshot.docs.forEach(doc => {
            const game = { id: doc.id, ...doc.data() };
            const team1 = allTeams.get(game.team1_id);
            const team2 = allTeams.get(game.team2_id);

            const isLive = liveGameIds.has(game.id);
            const isComplete = game.completed === 'TRUE';
            const gameStatus = isComplete ? `${game.team1_score} - ${game.team2_score}` : (isLive ? 'Live' : 'Pending');
            
            let team1Indicator = '';
            let team2Indicator = '';
            if (!isComplete && !isLive) {
                const pendingStatus = pendingLineups.get(game.id);
                team1Indicator = pendingStatus?.team1_submitted ? '✅' : '❌';
                team2Indicator = pendingStatus?.team2_submitted ? '✅' : '❌';
            }

            gamesHTML += `
                <div class="game-entry" data-game-id="${game.id}" data-collection="${collectionName}">
                    <span class="game-details">
                        <span class="game-teams">
                            <strong>${team1?.team_name || game.team1_id} ${team1Indicator}</strong> vs 
                            <strong>${team2?.team_name || game.team2_id} ${team2Indicator}</strong>
                        </span>
                        <span class="game-date">Date: ${game.date || 'N/A'}</span>
                    </span>
                    <span class="game-score">${gameStatus}</span>
                    <button class="btn-admin-edit">Enter/Edit Score</button>
                </div>`;
        });
        gamesListContainer.innerHTML = gamesHTML;
        
        // ======================= MODIFICATION START =======================
        // Auto-populate deadline input with the first game's date
        if (querySnapshot.docs.length > 0) {
            const firstGameDateStr = querySnapshot.docs[0].data().date; // "M/D/YYYY"
            const [month, day, year] = firstGameDateStr.split('/');
            const formattedDateForInput = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            deadlineDateInput.value = formattedDateForInput;
            displayDeadlineForDate(formattedDateForInput);
        }
        // ======================= MODIFICATION END =======================

    } catch (error) {
        console.error("Error fetching games: ", error);
        gamesListContainer.innerHTML = '<div class="error">Could not fetch games.</div>';
    }
}


// ======================= MODIFICATION START =======================
/**
 * NEW: Fetches and displays the deadline for a specific date.
 * @param {string} dateString - The date in 'YYYY-MM-DD' format from the input.
 */
async function displayDeadlineForDate(dateString) {
    if (!dateString) {
        deadlineDisplay.innerHTML = '<p>Select a date to see the current deadline.</p>';
        return;
    }
    deadlineDisplay.innerHTML = '<p>Checking...</p>';
    
    try {
        const deadlineRef = doc(db, getCollectionName('lineup_deadlines'), dateString);
        const deadlineSnap = await getDoc(deadlineRef);

        if (deadlineSnap.exists()) {
            const data = deadlineSnap.data();
            const deadline = data.deadline.toDate();
            const formattedTime = deadline.toLocaleTimeString('en-US', { 
                hour: '2-digit', 
                minute: '2-digit', 
                timeZone: data.timeZone, 
                hour12: true 
            });
            deadlineDisplay.innerHTML = `<p><strong>Current Deadline:</strong> ${formattedTime} ${data.timeZone}</p>`;
        } else {
            deadlineDisplay.innerHTML = '<p>No deadline is currently set for this date.</p>';
        }
    } catch (error) {
        console.error("Error fetching deadline:", error);
        deadlineDisplay.innerHTML = '<p class="error">Could not fetch deadline.</p>';
    }
}

/**
 * NEW: Handles the submission of the deadline form.
 */
async function handleSetDeadline(e) {
    e.preventDefault();
    const button = e.target.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = 'Saving...';

    const dateInput = deadlineDateInput.value;
    const timeInput = document.getElementById('deadline-time').value;

    const [year, month, day] = dateInput.split('-');
    const formattedDateForFunction = `${parseInt(month, 10)}/${parseInt(day, 10)}/${year}`;
    const timeZone = 'America/Chicago'; // Hardcoded as per league standard

    try {
        const setLineupDeadline = httpsCallable(functions, 'setLineupDeadline');
        const result = await setLineupDeadline({
            date: formattedDateForFunction,
            time: timeInput,
            timeZone: timeZone
        });
        alert(result.data.message);
        await displayDeadlineForDate(dateInput); // Refresh the display
    } catch (error) {
        console.error("Error setting deadline:", error);
        alert(`Failed to set deadline: ${error.message}`);
    } finally {
        button.disabled = false;
        button.textContent = 'Set';
    }
}
// ======================= MODIFICATION END =======================


async function handleOpenModalClick(e) {
    if (!e.target.matches('.btn-admin-edit')) return;
    const gameEntry = e.target.closest('.game-entry');
    const gameId = gameEntry.dataset.gameId;
    const collectionName = gameEntry.dataset.collection;

    const gameRef = doc(db, getCollectionName("seasons"), currentSeasonId, getCollectionName(collectionName), gameId);
    const gameDoc = await getDoc(gameRef);
    if (gameDoc.exists()) {
        currentGameData = { id: gameDoc.id, ...gameDoc.data(), collectionName };
        await openLineupModal(currentGameData);
    } else {
        alert("Error: Could not load data for the selected game.");
    }
}

function getRosterForTeam(teamId, week) {
    if (week === 'All-Star') {
        if (teamId === 'EGM') {
            return Array.from(allGms.values()).filter(gm => gm.conference === 'Eastern');
        }
        if (teamId === 'WGM') {
            return Array.from(allGms.values()).filter(gm => gm.conference === 'Western');
        }

        if (teamId === 'RSE') {
            const eastPlayers = awardSelections.get('rising-stars-eastern')?.players || [];
            return eastPlayers.map(p => allPlayers.get(p.player_id)).filter(Boolean);
        }
        if (teamId === 'RSW') {
            const westPlayers = awardSelections.get('rising-stars-western')?.players || [];
            return westPlayers.map(p => allPlayers.get(p.player_id)).filter(Boolean);
        }

        const eastPlayers = awardSelections.get('all-stars-eastern')?.players || [];
        const westPlayers = awardSelections.get('all-stars-western')?.players || [];
        if (teamId === 'EAST') return eastPlayers.map(p => allPlayers.get(p.player_id)).filter(Boolean);
        if (teamId === 'WEST') return westPlayers.map(p => allPlayers.get(p.player_id)).filter(Boolean);
    } 
    else if (week === 'GM Game') {
        return Array.from(allGms.values());
    }

    return Array.from(allPlayers.values()).filter(p => p.current_team_id === teamId);
}

async function openLineupModal(game) {
    lineupForm.reset();
    lastCheckedCaptain = { team1: null, team2: null };
    document.querySelectorAll('.roster-list, .starters-list').forEach(el => el.innerHTML = '');
    document.querySelectorAll('.team-lineup-section').forEach(el => el.classList.remove('validation-error'));

    if (liveScoringControls) {
        const today = new Date();
        today.setHours(0, 0, 0, 0); 
        const gameDateParts = game.date.split('/');
        const gameDate = new Date(+gameDateParts[2], gameDateParts[0] - 1, +gameDateParts[1]);

        const timeDiff = gameDate.getTime() - today.getTime();
        const dayDiff = timeDiff / (1000 * 3600 * 24);

        liveScoringControls.style.display = (dayDiff >= 0 && dayDiff <= 2) ? 'block' : 'none';
        document.getElementById('submit-live-lineups-btn').textContent = 'Submit Lineups for Live Scoring';
    }


    document.getElementById('lineup-game-id').value = game.id;
    document.getElementById('lineup-game-date').value = game.date;
    document.getElementById('lineup-is-postseason').value = game.collectionName === 'post_games';
    document.getElementById('lineup-game-completed-checkbox').checked = game.completed === 'TRUE';

    const isExhibition = game.collectionName === 'exhibition_games';
    const lineupsCollectionName = isExhibition ? 'exhibition_lineups' : (game.collectionName === 'post_games' ? 'post_lineups' : 'lineups');

    const existingLineups = new Map();

    let team1StartersOrdered = [];
    let team2StartersOrdered = [];

    
    const team1Roster = getRosterForTeam(game.team1_id, game.week);
    const team2Roster = getRosterForTeam(game.team2_id, game.week);

    const liveGameRef = doc(db, getCollectionName('live_games'), game.id);
    const pendingGameRef = doc(db, getCollectionName('pending_lineups'), game.id);
    const [liveGameSnap, pendingGameSnap] = await Promise.all([getDoc(liveGameRef), getDoc(pendingGameRef)]);

    if (pendingGameSnap.exists()) {
        const pendingData = pendingGameSnap.data();

        team1StartersOrdered = pendingData.team1_lineup || [];
        team2StartersOrdered = pendingData.team2_lineup || [];
        [...team1StartersOrdered, ...team2StartersOrdered].forEach(player => {
            existingLineups.set(player.player_id, {
                started: 'TRUE',
                is_captain: player.is_captain ? 'TRUE' : 'FALSE',
                adjustments: player.deductions || 0,
            });
        });

    }
    else if (liveGameSnap.exists()) {
        const liveData = liveGameSnap.data();

        team1StartersOrdered = liveData.team1_lineup || [];
        team2StartersOrdered = liveData.team2_lineup || [];
        [...team1StartersOrdered, ...team2StartersOrdered].forEach(player => {
            existingLineups.set(player.player_id, {
                started: 'TRUE',
                is_captain: player.is_captain ? 'TRUE' : 'FALSE',
                adjustments: player.deductions || 0,
            });
        });

    } else {
        const lineupsQuery = query(collection(db, getCollectionName("seasons"), currentSeasonId, getCollectionName(lineupsCollectionName)), where("game_id", "==", game.id));
        const lineupsSnap = await getDocs(lineupsQuery);
        if (!lineupsSnap.empty) {
            lineupsSnap.forEach(d => {
                const lineupData = d.data();
                existingLineups.set(lineupData.player_id, lineupData);
            });
        }
    }

    const team1 = allTeams.get(game.team1_id) || { team_name: game.team1_id };
    const team2 = allTeams.get(game.team2_id) || { team_name: game.team2_id };


    renderTeamUI('team1', team1, team1Roster, existingLineups, team1StartersOrdered);
    renderTeamUI('team2', team2, team2Roster, existingLineups, team2StartersOrdered);


    document.getElementById('lineup-modal-title').textContent = `Lineups for ${team1.team_name} vs ${team2.team_name}`;
    calculateAllScores();
    lineupModal.classList.add('is-visible');
}

function renderTeamUI(teamPrefix, teamData, roster, existingLineups, startersOrdered = []) {
    document.getElementById(`${teamPrefix}-name-header`).textContent = teamData.team_name;
    const rosterContainer = document.getElementById(`${teamPrefix}-roster`);
    rosterContainer.innerHTML = '';
    roster.sort((a, b) => a.player_handle.localeCompare(b.player_handle));
    roster.forEach(player => {
        const lineupData = existingLineups.get(player.id);
        const isStarter = lineupData?.started === 'TRUE';
        const playerHtml = `
            <label class="player-checkbox-item">
                <input type="checkbox" class="starter-checkbox" data-team-prefix="${teamPrefix}" data-player-id="${player.id}" data-player-handle="${player.player_handle}" ${isStarter ? 'checked' : ''}>
                ${player.player_handle}
            </label>
        `;
        rosterContainer.insertAdjacentHTML('beforeend', playerHtml);
    });

    rosterContainer.querySelectorAll('.starter-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', handleStarterChange);
    });


    if (startersOrdered.length > 0) {

        startersOrdered.forEach(starter => {
            const checkbox = rosterContainer.querySelector(`.starter-checkbox[data-player-id="${starter.player_id}"]`);
            if (checkbox) {
                const lineupData = existingLineups.get(starter.player_id);
                addStarterCard(checkbox, lineupData);
            }
        });
    } else {

        rosterContainer.querySelectorAll('.starter-checkbox:checked').forEach(checkbox => {
            const lineupData = existingLineups.get(checkbox.dataset.playerId);
            addStarterCard(checkbox, lineupData);
        });
    }
}

function handleStarterChange(event) {
    const checkbox = event.target;
    if (checkbox.checked) {
        const teamPrefix = checkbox.dataset.teamPrefix;
        const starterCount = document.querySelectorAll(`#${teamPrefix}-starters .starter-card`).length;
        if (starterCount >= 6) {
            alert("You can only select 6 starters per team.");
            checkbox.checked = false;
            return;
        }
        addStarterCard(checkbox);
    } else {
        removeStarterCard(checkbox);
    }
    updateStarterCount(checkbox.dataset.teamPrefix);
}

function addStarterCard(checkbox, lineupData = null) {
    const { teamPrefix, playerId, playerHandle } = checkbox.dataset;
    const startersContainer = document.getElementById(`${teamPrefix}-starters`);
    const rawScore = lineupData?.raw_score ?? 0;
    const isCaptain = lineupData?.is_captain === 'TRUE';

    const card = document.createElement('div');
    card.className = 'starter-card';
    card.id = `starter-card-${playerId}`;
    card.innerHTML = `
        <div class="starter-card-header">
            <strong>${playerHandle}</strong>
            <label><input type="radio" name="${teamPrefix}-captain" value="${playerId}" ${isCaptain ? 'checked' : ''}> Captain</label>
        </div>
        <div class="starter-inputs">
            <div class="form-group-admin"><label for="raw-score-${playerId}">Raw Score</label><input type="number" id="raw-score-${playerId}" value="${rawScore}" step="any"></div>
            <div class="form-group-admin"><label for="global-rank-${playerId}">Global Rank</label><input type="number" id="global-rank-${playerId}" value="${lineupData?.global_rank || 0}"></div>
            <div class="form-group-admin"><label for="reductions-${playerId}">Reductions</label><input type="number" id="reductions-${playerId}" value="${lineupData?.adjustments || 0}" step="any"></div>
        </div>`;
    startersContainer.appendChild(card);
    updateStarterCount(teamPrefix);
}

function removeStarterCard(checkbox) {
    const card = document.getElementById(`starter-card-${checkbox.dataset.playerId}`);
    if (card) card.remove();
    updateStarterCount(checkbox.dataset.teamPrefix);
}

function updateStarterCount(teamPrefix) {
    const count = document.querySelectorAll(`#${teamPrefix}-starters .starter-card`).length;
    document.getElementById(`${teamPrefix}-starter-count`).textContent = count;
}

function handleCaptainToggle(e) {
    if (e.target.type !== 'radio') return;
    const radio = e.target;
    const teamPrefix = radio.name.replace('-captain', '');
    if (radio === lastCheckedCaptain[teamPrefix]) {
        radio.checked = false;
        lastCheckedCaptain[teamPrefix] = null;
    } else {
        lastCheckedCaptain[teamPrefix] = radio;
    }
}

function calculateAllScores() {
    ['team1', 'team2'].forEach(teamPrefix => {
        let totalScore = 0;
        const captainId = lineupForm.querySelector(`input[name="${teamPrefix}-captain"]:checked`)?.value;
        document.querySelectorAll(`#${teamPrefix}-starters .starter-card`).forEach(card => {
            const playerId = card.id.replace('starter-card-', '');
            const rawScore = parseFloat(document.getElementById(`raw-score-${playerId}`).value) || 0;
            const adjustments = parseFloat(document.getElementById(`reductions-${playerId}`).value) || 0;
            let adjustedScore = rawScore - adjustments;
            if (playerId === captainId) {
                adjustedScore *= 1.5;
            }
            totalScore += adjustedScore;
        });
        document.getElementById(`${teamPrefix}-final-score`).textContent = totalScore.toFixed(2);
    });
}

async function handleLineupFormSubmit(e) {
    e.preventDefault();
    const submitButton = e.target.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    submitButton.textContent = 'Saving...';

    let isValid = true;
    ['team1', 'team2'].forEach(prefix => {
        const section = document.getElementById(`${prefix}-section`);
        const starterCount = document.querySelectorAll(`#${prefix}-starters .starter-card`).length;
        
        if (starterCount !== 6) {
            isValid = false;
            section.classList.add('validation-error');
        } else {
            section.classList.remove('validation-error');
        }
    });

    if (!isValid) {
        alert("Validation failed. Each team must have exactly 6 starters selected.");
        submitButton.disabled = false;
        submitButton.textContent = 'Save Lineups & Final Score';
        return;
    }

    try {
        const batch = writeBatch(db);
        const { id: gameId, date: gameDate, collectionName, week, team1_id, team2_id } = currentGameData;
        
        const liveGameRef = doc(db, getCollectionName('live_games'), gameId);
        const liveGameSnap = await getDoc(liveGameRef);

        if (liveGameSnap.exists()) {
            console.log("Live game detected. Overwriting lineup with changes.");

            const liveGameData = liveGameSnap.data();
            const oldPlayerScores = new Map();
            [...liveGameData.team1_lineup, ...liveGameData.team2_lineup].forEach(p => {
                oldPlayerScores.set(p.player_id, {
                    points_raw: p.points_raw || 0,
                    points_adjusted: p.points_adjusted || 0,
                    final_score: p.final_score || 0,
                    global_rank: p.global_rank || 0
                });
            });

            let new_team1_lineup = [];
            const captainId1 = lineupForm.querySelector('input[name="team1-captain"]:checked')?.value;
            document.querySelectorAll('#team1-starters .starter-card').forEach(card => {
                const playerId = card.id.replace('starter-card-', '');
                const player = allPlayers.get(playerId) || allGms.get(playerId);
                new_team1_lineup.push({
                    player_id: playerId,
                    player_handle: player.player_handle,
                    is_captain: playerId === captainId1,
                    deductions: parseFloat(document.getElementById(`reductions-${playerId}`).value) || 0,
                });
            });

            let new_team2_lineup = [];
            const captainId2 = lineupForm.querySelector('input[name="team2-captain"]:checked')?.value;
            document.querySelectorAll('#team2-starters .starter-card').forEach(card => {
                const playerId = card.id.replace('starter-card-', '');
                const player = allPlayers.get(playerId) || allGms.get(playerId);
                new_team2_lineup.push({
                    player_id: playerId,
                    player_handle: player.player_handle,
                    is_captain: playerId === captainId2,
                    deductions: parseFloat(document.getElementById(`reductions-${playerId}`).value) || 0,
                });
            });

            const merged_team1_lineup = new_team1_lineup.map(p => ({ ...(oldPlayerScores.get(p.player_id) || {}), ...p }));
            const merged_team2_lineup = new_team2_lineup.map(p => ({ ...(oldPlayerScores.get(p.player_id) || {}), ...p }));

            await updateDoc(liveGameRef, {
                team1_lineup: merged_team1_lineup,
                team2_lineup: merged_team2_lineup
            });

            alert('Live game lineup updated successfully!');
            lineupModal.classList.remove('is-visible');
            fetchAndDisplayGames(currentSeasonId, weekSelect.value);
            return; 
        }

        const isExhibition = collectionName === 'exhibition_games';
        const lineupsCollectionName = isExhibition ? 'exhibition_lineups' : (collectionName === 'post_games' ? 'post_lineups' : 'lineups');
        const lineupsCollectionRef = collection(db, getCollectionName("seasons"), currentSeasonId, getCollectionName(lineupsCollectionName));

        const team1Roster = getRosterForTeam(team1_id, week);
        const team2Roster = getRosterForTeam(team2_id, week);
        const playersInGame = [...team1Roster, ...team2Roster];

        for (const player of playersInGame) {
            const starterCard = document.getElementById(`starter-card-${player.id}`);
            const lineupId = `${gameId}-${player.id}`;
            const docRef = doc(lineupsCollectionRef, lineupId);

            const teamPrefix = team1Roster.find(p => p.id === player.id) ? 'team1' : 'team2';
            const captainId = lineupForm.querySelector(`input[name="${teamPrefix}-captain"]:checked`)?.value;

            let lineupData = {
                player_id: player.id, player_handle: player.player_handle,
                team_id: team1Roster.find(p => p.id === player.id) ? team1_id : team2_id,
                game_id: gameId, date: gameDate,
                game_type: isExhibition ? 'exhibition' : (collectionName === 'post_games' ? 'postseason' : 'regular'),
                started: 'FALSE', is_captain: 'FALSE', raw_score: 0, adjustments: 0,
                points_adjusted: 0, final_score: 0, global_rank: 0
            };

            if (starterCard) {
                const raw_score = parseFloat(document.getElementById(`raw-score-${player.id}`).value) || 0;
                const adjustments = parseFloat(document.getElementById(`reductions-${player.id}`).value) || 0;
                const points_adjusted = raw_score - adjustments;
                let final_score = points_adjusted;
                const isCaptain = player.id === captainId;
                if (isCaptain) final_score *= 1.5;

                Object.assign(lineupData, {
                    started: 'TRUE', is_captain: isCaptain ? 'TRUE' : 'FALSE',
                    raw_score, adjustments, points_adjusted, final_score,
                    global_rank: parseInt(document.getElementById(`global-rank-${player.id}`).value) || 0
                });
            }
            batch.set(docRef, lineupData, { merge: true });
        }

        const gameRef = doc(db, getCollectionName("seasons"), currentSeasonId, getCollectionName(collectionName), gameId);
        const team1FinalScore = parseFloat(document.getElementById('team1-final-score').textContent);
        const team2FinalScore = parseFloat(document.getElementById('team2-final-score').textContent);

        batch.update(gameRef, {
            team1_score: team1FinalScore,
            team2_score: team2FinalScore,
            completed: document.getElementById('lineup-game-completed-checkbox').checked ? 'TRUE' : 'FALSE',
            winner: team1FinalScore > team2FinalScore ? team1_id : (team2FinalScore > team1FinalScore ? team2_id : '')
        });

        await batch.commit();
        alert('Lineups and scores saved successfully!');
        lineupModal.classList.remove('is-visible');
        fetchAndDisplayGames(currentSeasonId, weekSelect.value);

    } catch (error) {
        console.error("Error saving lineups and score:", error);
        alert('An error occurred. Check the console for details.');
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = 'Save Lineups & Final Score';
    }
}


async function handleStageLiveLineups(e) {
    e.preventDefault();
    const button = e.target;
    button.disabled = true;
    button.textContent = 'Processing...';

    const team1Starters = document.querySelectorAll('#team1-starters .starter-card');
    const team2Starters = document.querySelectorAll('#team2-starters .starter-card');
    
    const isTeam1LineupValid = team1Starters.length === 6;
    const isTeam2LineupValid = team2Starters.length === 6;

    if (!isTeam1LineupValid && !isTeam2LineupValid) {
        alert("Validation failed. At least one team must have exactly 6 starters selected to submit a lineup.");
        button.disabled = false;
        button.textContent = 'Submit Lineups for Live Scoring';
        return;
    }

    const { id: gameId, collectionName, date: gameDateStr } = currentGameData;
    let team1_lineup = null;
    let team2_lineup = null;

    if (isTeam1LineupValid) {
        team1_lineup = [];
        const captainId = lineupForm.querySelector('input[name="team1-captain"]:checked')?.value;
        team1Starters.forEach(card => {
            const playerId = card.id.replace('starter-card-', '');
            const player = allPlayers.get(playerId) || allGms.get(playerId);
            team1_lineup.push({
                player_id: playerId,
                player_handle: player.player_handle,
                is_captain: playerId === captainId,
                deductions: parseFloat(document.getElementById(`reductions-${playerId}`).value) || 0,
            });
        });
    }

    if (isTeam2LineupValid) {
        team2_lineup = [];
        const captainId = lineupForm.querySelector('input[name="team2-captain"]:checked')?.value;
        team2Starters.forEach(card => {
            const playerId = card.id.replace('starter-card-', '');
            const player = allPlayers.get(playerId) || allGms.get(playerId);
            team2_lineup.push({
                player_id: playerId,
                player_handle: player.player_handle,
                is_captain: playerId === captainId,
                deductions: parseFloat(document.getElementById(`reductions-${playerId}`).value) || 0,
            });
        });
    }
    
    try {
        button.textContent = 'Submitting...';
        const stageLiveLineups = httpsCallable(functions, 'stageLiveLineups');
        
        await stageLiveLineups({
            gameId,
            seasonId: currentSeasonId,
            collectionName,
            gameDate: gameDateStr,
            team1_lineup,
            team2_lineup
        });
        
        alert('Lineup(s) submitted successfully! The server will process them according to the game day schedule.');

        lineupModal.classList.remove('is-visible');
        fetchAndDisplayGames(currentSeasonId, weekSelect.value);

    } catch (error) {
        console.error("Error submitting lineups:", error);
        alert(`Failed to submit lineups: ${error.message}`);
    } finally {
        button.disabled = false;
        button.textContent = 'Submit Lineups for Live Scoring';
    }
}

async function handleFinalizeLiveGame(e) {
    e.preventDefault();
    if (!confirm("Are you sure you want to finalize this game? This will write the current live scores to the database and cannot be undone.")) {
        return;
    }
    const button = e.target;
    button.disabled = true;
    button.textContent = 'Finalizing...';

    try {
        const finalizeLiveGame = httpsCallable(functions, 'finalizeLiveGame');
        const result = await finalizeLiveGame({ gameId: currentGameData.id });
        alert(result.data.message);
        lineupModal.classList.remove('is-visible');
        fetchAndDisplayGames(currentSeasonId, weekSelect.value);
    } catch (error) {
        console.error("Error finalizing live game:", error);
        alert(`Failed to finalize game: ${error.message}`);
    } finally {
        button.disabled = false;
        button.textContent = 'Finalize Live Game Now';
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