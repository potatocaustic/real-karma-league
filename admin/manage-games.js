// /admin/manage-games.js

// Import necessary functions from your custom init file, but REMOVE writeBatch, which it doesn't export.
import { auth, db, onAuthStateChanged, doc, getDoc, collection, query, where, getDocs, updateDoc } from '/js/firebase-init.js';

// Import writeBatch separately and directly from the official Firebase SDK module.
// This is the correct source for the function and resolves the error.
import { writeBatch } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";


// --- Page Elements (will be assigned after DOM loads) ---
let loadingContainer, adminContainer, authStatusDiv, seasonSelect, weekSelect, gamesListContainer, lineupModal, lineupForm, closeLineupModalBtn;

// --- Global Data Cache ---
let currentSeasonId = null;
let allTeams = new Map();
let allPlayers = new Map();
let currentGameData = null;

// --- Primary Auth Check & Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    // Assign elements now that the DOM is guaranteed to be loaded
    loadingContainer = document.getElementById('loading-container');
    adminContainer = document.getElementById('admin-container');
    authStatusDiv = document.getElementById('auth-status');
    seasonSelect = document.getElementById('season-select');
    weekSelect = document.getElementById('week-select');
    gamesListContainer = document.getElementById('games-list-container');
    lineupModal = document.getElementById('lineup-modal');
    lineupForm = document.getElementById('lineup-form');
    closeLineupModalBtn = lineupModal.querySelector('.close-btn-admin');

    onAuthStateChanged(auth, async (user) => {
        try {
            if (user) {
                const userRef = doc(db, "users", user.uid);
                const userDoc = await getDoc(userRef);

                if (userDoc.exists() && userDoc.data().role === 'admin') {
                    // This is the correct point to show the main content
                    loadingContainer.style.display = 'none';
                    adminContainer.style.display = 'block';
                    authStatusDiv.innerHTML = `Welcome, Admin | <a href="#" id="logout-btn">Logout</a>`;

                    addLogoutListener();
                    await initializePage(); // Await the async initialization
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

// --- Initialization and Data Fetching ---

async function initializePage() {
    // Fetch all teams and players once and cache them
    try {
        const [teamsSnap, playersSnap] = await Promise.all([
            getDocs(collection(db, "new_teams")),
            getDocs(collection(db, "new_players"))
        ]);
        teamsSnap.docs.forEach(doc => allTeams.set(doc.id, { id: doc.id, ...doc.data() }));
        playersSnap.docs.forEach(doc => allPlayers.set(doc.id, { id: doc.id, ...doc.data() }));
        console.log(`Cached ${allTeams.size} teams and ${allPlayers.size} players.`);
    } catch (error) {
        console.error("Failed to cache teams and players:", error);
        adminContainer.innerHTML = `<div class="error">Could not load core league data. Please refresh.</div>`;
        return;
    }

    await populateSeasons();

    seasonSelect.addEventListener('change', async () => {
        currentSeasonId = seasonSelect.value;
        await populateWeeks(currentSeasonId);
        gamesListContainer.innerHTML = '<p class="placeholder-text">Please select a week.</p>';
    });

    weekSelect.addEventListener('change', () => {
        const week = weekSelect.value;
        if (currentSeasonId && week) {
            fetchAndDisplayGames(currentSeasonId, week);
        }
    });

    // --- New Lineup Modal Listeners ---
    closeLineupModalBtn.addEventListener('click', () => lineupModal.style.display = 'none');
    lineupForm.addEventListener('submit', handleLineupFormSubmit);
    lineupForm.addEventListener('input', calculateAllScores); // Recalculate on any input change
}

async function populateSeasons() {
    seasonSelect.innerHTML = `<option value="S7">Season 7</option>`;
    currentSeasonId = "S7";
    await populateWeeks(currentSeasonId);
}

async function populateWeeks(seasonId) {
    let weekOptions = '';
    for (let i = 1; i <= 15; i++) {
        weekOptions += `<option value="${i}">Week ${i}</option>`;
    }
    weekOptions += `
        <option value="Play-In">Play-In</option>
        <option value="Round 1">Round 1</option>
        <option value="Round 2">Round 2</option>
        <option value="Conf Finals">Conference Finals</option>
        <option value="Finals">Finals</option>
    `;
    weekSelect.innerHTML = `<option value="">Select a week...</option>${weekOptions}`;
}

async function fetchAndDisplayGames(seasonId, week) {
    gamesListContainer.innerHTML = '<div class="loading">Fetching games...</div>';
    const isPostseason = !/^\d+$/.test(week);
    const collectionName = isPostseason ? "post_games" : "games";
    const gamesQuery = query(collection(db, "seasons", seasonId, collectionName), where("week", "==", week));

    try {
        const querySnapshot = await getDocs(gamesQuery);
        if (querySnapshot.empty) {
            gamesListContainer.innerHTML = '<p class="placeholder-text">No games found for this week.</p>';
            return;
        }

        let gamesHTML = '';
        querySnapshot.forEach(doc => {
            const game = { id: doc.id, ...doc.data() };
            const team1 = allTeams.get(game.team1_id);
            const team2 = allTeams.get(game.team2_id);

            gamesHTML += `
                <div class="game-entry" data-game-id="${game.id}" data-is-postseason="${isPostseason}">
                    <span class="game-details">
                        <span class="game-teams"><strong>${team1?.team_name || game.team1_id}</strong> vs <strong>${team2?.team_name || game.team2_id}</strong></span>
                        <span class="game-date">Date: ${game.date || 'N/A'}</span>
                    </span>
                    <span class="game-score">
                        ${game.completed === 'TRUE' ? `${game.team1_score} - ${game.team2_score}` : 'Pending'}
                    </span>
                    <button class="btn-admin-edit">Enter/Edit Score</button>
                </div>
            `;
        });
        gamesListContainer.innerHTML = gamesHTML;

    } catch (error) {
        console.error("Error fetching games: ", error);
        gamesListContainer.innerHTML = '<div class="error">Could not fetch games.</div>';
    }
}

// --- Lineup Modal Opening and Rendering ---
gamesListContainer.addEventListener('click', async (e) => {
    if (e.target.matches('.btn-admin-edit')) {
        const gameEntry = e.target.closest('.game-entry');
        const gameId = gameEntry.dataset.gameId;
        const isPostseason = gameEntry.dataset.isPostseason === 'true';

        const collectionName = isPostseason ? "post_games" : "games";
        const gameRef = doc(db, "seasons", currentSeasonId, collectionName, gameId);
        const gameDoc = await getDoc(gameRef);

        if (gameDoc.exists()) {
            currentGameData = { id: gameDoc.id, ...gameDoc.data() };
            openLineupModal(currentGameData, isPostseason);
        }
    }
});

async function openLineupModal(game, isPostseason) {
    lineupForm.reset();
    document.querySelectorAll('.roster-list, .starters-list').forEach(el => el.innerHTML = '');
    document.querySelectorAll('.team-lineup-section').forEach(el => el.classList.remove('validation-error'));


    // Set hidden inputs
    document.getElementById('lineup-game-id').value = game.id;
    document.getElementById('lineup-game-date').value = game.date;
    document.getElementById('lineup-is-postseason').value = isPostseason;
    document.getElementById('lineup-game-completed-checkbox').checked = game.completed === 'TRUE';

    // Fetch existing lineup data for this game to pre-populate
    const lineupCollectionName = isPostseason ? "post_lineups" : "lineups";
    const lineupsQuery = query(collection(db, lineupCollectionName), where("game_id", "==", game.id));
    const lineupsSnap = await getDocs(lineupsQuery);
    const existingLineups = new Map(lineupsSnap.docs.map(d => [d.data().player_id, d.data()]));

    // --- Render Team 1 ---
    const team1 = allTeams.get(game.team1_id);
    const team1Roster = Array.from(allPlayers.values()).filter(p => p.current_team_id === game.team1_id);
    renderTeamUI('team1', team1, team1Roster, existingLineups);

    // --- Render Team 2 ---
    const team2 = allTeams.get(game.team2_id);
    const team2Roster = Array.from(allPlayers.values()).filter(p => p.current_team_id === game.team2_id);
    renderTeamUI('team2', team2, team2Roster, existingLineups);

    document.getElementById('lineup-modal-title').textContent = `Lineups for ${team1?.team_name} vs ${team2?.team_name}`;
    lineupModal.style.display = 'block';
    calculateAllScores();
}

function renderTeamUI(teamPrefix, teamData, roster, existingLineups) {
    document.getElementById(`${teamPrefix}-name-header`).textContent = teamData.team_name;
    const rosterContainer = document.getElementById(`${teamPrefix}-roster`);
    rosterContainer.innerHTML = ''; // Clear previous roster
    roster.forEach(player => {
        const isStarter = existingLineups.has(player.id) && existingLineups.get(player.id).started === 'TRUE';
        const playerHtml = `
            <label class="player-checkbox-item">
                <input type="checkbox" class="starter-checkbox" data-team-prefix="${teamPrefix}" data-player-id="${player.id}" data-player-handle="${player.player_handle}" ${isStarter ? 'checked' : ''}>
                ${player.player_handle}
            </label>
        `;
        rosterContainer.insertAdjacentHTML('beforeend', playerHtml);
    });

    // Attach event listeners and pre-populate starters
    rosterContainer.querySelectorAll('.starter-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', handleStarterChange);
        if (checkbox.checked) {
            const lineupData = existingLineups.get(checkbox.dataset.playerId);
            addStarterCard(checkbox, lineupData);
        }
    });
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

    const card = document.createElement('div');
    card.className = 'starter-card';
    card.id = `starter-card-${playerId}`;
    card.innerHTML = `
        <div class="starter-card-header">
            <strong>${playerHandle}</strong>
            <label><input type="radio" name="${teamPrefix}-captain" value="${playerId}" ${lineupData?.is_captain === 'TRUE' ? 'checked' : ''}> Captain</label>
        </div>
        <div class="starter-inputs">
            <div class="form-group-admin">
                <label for="raw-score-${playerId}">Raw Score</label>
                <input type="number" id="raw-score-${playerId}" value="${lineupData?.raw_score || 0}" step="any">
            </div>
            <div class="form-group-admin">
                <label for="global-rank-${playerId}">Global Rank</label>
                <input type="number" id="global-rank-${playerId}" value="${lineupData?.global_rank || 0}">
            </div>
            <div class="form-group-admin">
                <label for="adjustments-${playerId}">Adjustments</label>
                <input type="number" id="adjustments-${playerId}" value="${lineupData?.adjustments || 0}" step="any">
            </div>
        </div>
    `;
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


// --- Score Calculation ---
function calculateAllScores() {
    ['team1', 'team2'].forEach(teamPrefix => {
        let totalScore = 0;
        const captainId = lineupForm.querySelector(`input[name="${teamPrefix}-captain"]:checked`)?.value;
        const starterCards = document.querySelectorAll(`#${teamPrefix}-starters .starter-card`);

        starterCards.forEach(card => {
            const playerId = card.id.replace('starter-card-', '');
            const rawScore = parseFloat(document.getElementById(`raw-score-${playerId}`).value) || 0;
            const adjustments = parseFloat(document.getElementById(`adjustments-${playerId}`).value) || 0;

            let adjustedScore = rawScore - adjustments;

            if (playerId === captainId) {
                adjustedScore *= 1.5; // Apply 50% captain bonus
            }
            totalScore += adjustedScore;
        });

        document.getElementById(`${teamPrefix}-final-score`).textContent = totalScore.toFixed(2);
    });
}


// --- Form Submission ---
async function handleLineupFormSubmit(e) {
    e.preventDefault();
    const submitButton = e.target.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    submitButton.textContent = 'Saving...';

    // --- Validation ---
    let isValid = true;
    ['team1', 'team2'].forEach(prefix => {
        const section = document.getElementById(`${prefix}-section`);
        const starterCount = document.querySelectorAll(`#${prefix}-starters .starter-card`).length;
        const captainCount = document.querySelectorAll(`input[name="${prefix}-captain"]:checked`).length;
        if (starterCount !== 6 || captainCount !== 1) {
            isValid = false;
            section.classList.add('validation-error');
        } else {
            section.classList.remove('validation-error');
        }
    });

    if (!isValid) {
        alert("Validation failed. Each team must have exactly 6 starters and 1 captain selected.");
        submitButton.disabled = false;
        submitButton.textContent = 'Save Lineups & Final Score';
        return;
    }

    // --- Data Preparation and Firestore Write ---
    try {
        const batch = writeBatch(db);
        const gameId = document.getElementById('lineup-game-id').value;
        const gameDate = document.getElementById('lineup-game-date').value;
        const isPostseason = document.getElementById('lineup-is-postseason').value === 'true';
        const lineupCollectionName = isPostseason ? 'post_lineups' : 'lineups';
        const lineupCollectionRef = collection(db, lineupCollectionName);

        const team1Id = currentGameData.team1_id;
        const team2Id = currentGameData.team2_id;
        const team1Roster = Array.from(allPlayers.values()).filter(p => p.current_team_id === team1Id);
        const team2Roster = Array.from(allPlayers.values()).filter(p => p.current_team_id === team2Id);
        const fullRoster = [...team1Roster, ...team2Roster];

        // Process lineups for every player on both rosters
        fullRoster.forEach(player => {
            const starterCard = document.getElementById(`starter-card-${player.id}`);
            const lineupDocRef = doc(lineupCollectionRef, `${gameId}-${player.id}`);

            let lineupData = {
                game_id: gameId,
                date: gameDate,
                player_id: player.id,
                player_handle: player.player_handle,
                team_id: player.current_team_id,
                started: 'FALSE',
                is_captain: 'FALSE',
                raw_score: 0,
                global_rank: 0,
                adjustments: 0,
                final_score: 0
            };

            if (starterCard) { // Player is a starter
                const teamPrefix = player.current_team_id === team1Id ? 'team1' : 'team2';
                const captainId = lineupForm.querySelector(`input[name="${teamPrefix}-captain"]:checked`)?.value;
                const raw_score = parseFloat(document.getElementById(`raw-score-${player.id}`).value) || 0;
                const adjustments = parseFloat(document.getElementById(`adjustments-${player.id}`).value) || 0;
                let final_score = raw_score - adjustments;

                lineupData.started = 'TRUE';
                lineupData.is_captain = (player.id === captainId) ? 'TRUE' : 'FALSE';
                lineupData.raw_score = raw_score;
                lineupData.global_rank = parseInt(document.getElementById(`global-rank-${player.id}`).value) || 0;
                lineupData.adjustments = adjustments;

                if (lineupData.is_captain === 'TRUE') {
                    final_score *= 1.5;
                }
                lineupData.final_score = final_score;
            }
            batch.set(lineupDocRef, lineupData);
        });

        // Update the game document
        const gameCollectionName = isPostseason ? "post_games" : "games";
        const gameRef = doc(db, "seasons", currentSeasonId, gameCollectionName, gameId);
        const team1FinalScore = parseFloat(document.getElementById('team1-final-score').textContent);
        const team2FinalScore = parseFloat(document.getElementById('team2-final-score').textContent);

        batch.update(gameRef, {
            team1_score: team1FinalScore,
            team2_score: team2FinalScore,
            completed: document.getElementById('lineup-game-completed-checkbox').checked ? 'TRUE' : 'FALSE',
            winner: team1FinalScore > team2FinalScore ? team1Id : team2Id
        });

        await batch.commit();
        alert('Lineups and scores saved successfully!');
        lineupModal.style.display = 'none';
        fetchAndDisplayGames(currentSeasonId, weekSelect.value); // Refresh list

    } catch (error) {
        console.error("Error saving lineups and score:", error);
        alert('An error occurred. Check the console for details.');
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = 'Save Lineups & Final Score';
    }
}

// --- Utility ---
function addLogoutListener() {
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            auth.signOut().then(() => { window.location.href = '/login.html'; });
        });
    }
}
