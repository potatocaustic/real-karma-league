// /admin/manage-games.js

import { auth, db, functions, onAuthStateChanged, doc, getDoc, collection, getDocs, updateDoc, setDoc, deleteDoc, httpsCallable, query, where } from '/js/firebase-init.js';
import { writeBatch } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

// --- Page Elements ---
let loadingContainer, adminContainer, authStatusDiv, seasonSelect, weekSelect, gamesListContainer, lineupModal, lineupForm, closeLineupModalBtn, liveScoringControls;

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


    onAuthStateChanged(auth, async (user) => {
        try {
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
        } catch (error) {
            console.error("Fatal Error during Authentication/Initialization:", error);
            loadingContainer.innerHTML = `<div class="error">A critical error occurred. Please check the console and refresh.</div>`;
        }
    });
});

async function initializePage() {
    try {
        // Cache player data, which is not season-dependent
        const playersSnap = await getDocs(collection(db, "v2_players"));
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
                handleSubmitForLiveScoring(e);
            } else if (e.target.id === 'finalize-live-game-btn') {
                handleFinalizeLiveGame(e);
            }
        });
    }
}

async function updateAwardsCache(seasonId) {
    awardSelections.clear();
    const seasonNumber = seasonId.replace('S', '');
    const awardsRef = collection(db, `awards/season_${seasonNumber}/S${seasonNumber}_awards`);
    const awardsSnap = await getDocs(awardsRef);
    awardsSnap.forEach(doc => awardSelections.set(doc.id, doc.data()));
}

async function updateTeamCache(seasonId) {
    allTeams.clear();
    const teamsSnap = await getDocs(collection(db, "v2_teams"));

    const teamPromises = teamsSnap.docs.map(async (teamDoc) => {
        if (!teamDoc.data().conference) {
            return null;
        }

        const teamData = { id: teamDoc.id, ...teamDoc.data() };
        const seasonRecordRef = doc(db, "v2_teams", teamDoc.id, "seasonal_records", seasonId);
        const seasonRecordSnap = await getDoc(seasonRecordRef);

        if (seasonRecordSnap.exists()) {
            teamData.team_name = seasonRecordSnap.data().team_name;
        } else {
            teamData.team_name = "Name Not Found";
        }
        return teamData;
    });

    const teamsWithData = (await Promise.all(teamPromises)).filter(Boolean);
    teamsWithData.forEach(team => allTeams.set(team.id, team));
}

async function populateSeasons() {
    try {
        const seasonsSnap = await getDocs(query(collection(db, "seasons")));
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

async function handleSeasonChange() {
    if (currentSeasonId) {
        await populateWeeks(currentSeasonId);
        const defaultWeek = "1";
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

async function fetchAndDisplayGames(seasonId, week) {
    gamesListContainer.innerHTML = '<div class="loading">Fetching games...</div>';
    const isPostseason = !/^\d+$/.test(week) && week !== 'All-Star' && week !== 'Relegation';
    const isExhibition = week === 'All-Star' || week === 'Relegation';

    let collectionName = 'games';
    if (isPostseason) collectionName = 'post_games';
    if (isExhibition) collectionName = 'exhibition_games';

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
                <div class="game-entry" data-game-id="${game.id}" data-collection="${collectionName}">
                    <span class="game-details">
                        <span class="game-teams"><strong>${team1?.team_name || game.team1_id}</strong> vs <strong>${team2?.team_name || game.team2_id}</strong></span>
                        <span class="game-date">Date: ${game.date || 'N/A'}</span>
                    </span>
                    <span class="game-score">${game.completed === 'TRUE' ? `${game.team1_score} - ${game.team2_score}` : 'Pending'}</span>
                    <button class="btn-admin-edit">Enter/Edit Score</button>
                </div>`;
        });
        gamesListContainer.innerHTML = gamesHTML;
    } catch (error) {
        console.error("Error fetching games: ", error);
        gamesListContainer.innerHTML = '<div class="error">Could not fetch games.</div>';
    }
}

async function handleOpenModalClick(e) {
    if (!e.target.matches('.btn-admin-edit')) return;
    const gameEntry = e.target.closest('.game-entry');
    const gameId = gameEntry.dataset.gameId;
    const collectionName = gameEntry.dataset.collection;

    const gameRef = doc(db, "seasons", currentSeasonId, collectionName, gameId);
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
        const eastPlayers = awardSelections.get('all-stars-eastern')?.players || [];
        const westPlayers = awardSelections.get('all-stars-western')?.players || [];
        if (teamId.includes('EAST')) return eastPlayers.map(p => allPlayers.get(p.player_id)).filter(Boolean);
        if (teamId.includes('WEST')) return westPlayers.map(p => allPlayers.get(p.player_id)).filter(Boolean);
    } else if (week === 'Rising Stars') {
        const eastPlayers = awardSelections.get('rising-stars-eastern')?.players || [];
        const westPlayers = awardSelections.get('rising-stars-western')?.players || [];
        if (teamId.includes('EAST')) return eastPlayers.map(p => allPlayers.get(p.player_id)).filter(Boolean);
        if (teamId.includes('WEST')) return westPlayers.map(p => allPlayers.get(p.player_id)).filter(Boolean);
    } else if (week === 'GM Game') {
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
        const gameDateParts = game.date.split('/');
        const gameDate = new Date(+gameDateParts[2], gameDateParts[0] - 1, +gameDateParts[1]);

        const isToday = gameDate.getFullYear() === today.getFullYear() &&
            gameDate.getMonth() === today.getMonth() &&
            gameDate.getDate() === today.getDate();

        liveScoringControls.style.display = isToday ? 'block' : 'none';
    }


    document.getElementById('lineup-game-id').value = game.id;
    document.getElementById('lineup-game-date').value = game.date;
    document.getElementById('lineup-is-postseason').value = game.collectionName === 'post_games';
    document.getElementById('lineup-game-completed-checkbox').checked = game.completed === 'TRUE';

    const isExhibition = game.collectionName === 'exhibition_games';
    const lineupsCollectionName = isExhibition ? 'exhibition_lineups' : (game.collectionName === 'post_games' ? 'post_lineups' : 'lineups');

    const lineupsQuery = query(collection(db, "seasons", currentSeasonId, lineupsCollectionName), where("game_id", "==", game.id));
    const lineupsSnap = await getDocs(lineupsQuery);

    const existingLineups = new Map();
    let team1Roster, team2Roster;

    if (!lineupsSnap.empty) {
        const team1PlayersForGame = [];
        const team2PlayersForGame = [];
        const playerIdsInGame = new Set(getRosterForTeam(game.team1_id, game.week).concat(getRosterForTeam(game.team2_id, game.week)).map(p => p.id));
        lineupsSnap.forEach(d => {
            const lineupData = d.data();
            if (playerIdsInGame.has(lineupData.player_id)) {
                if (lineupData.team_id === game.team1_id) {
                    team1PlayersForGame.push(allPlayers.get(lineupData.player_id));
                } else if (lineupData.team_id === game.team2_id) {
                    team2PlayersForGame.push(allPlayers.get(lineupData.player_id));
                }
                existingLineups.set(lineupData.player_id, lineupData);
            }
        });
        team1Roster = team1PlayersForGame;
        team2Roster = team2PlayersForGame;
    } else {
        team1Roster = getRosterForTeam(game.team1_id, game.week);
        team2Roster = getRosterForTeam(game.team2_id, game.week);
    }

    const team1 = allTeams.get(game.team1_id) || { team_name: game.team1_id };
    const team2 = allTeams.get(game.team2_id) || { team_name: game.team2_id };

    renderTeamUI('team1', team1, team1Roster, existingLineups);
    renderTeamUI('team2', team2, team2Roster, existingLineups);

    document.getElementById('lineup-modal-title').textContent = `Lineups for ${team1.team_name} vs ${team2.team_name}`;
    calculateAllScores();
    lineupModal.classList.add('is-visible');
}

function renderTeamUI(teamPrefix, teamData, roster, existingLineups) {
    document.getElementById(`${teamPrefix}-name-header`).textContent = teamData.team_name;
    const rosterContainer = document.getElementById(`${teamPrefix}-roster`);
    rosterContainer.innerHTML = '';

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

    // Validation
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

    try {
        const batch = writeBatch(db);
        const { id: gameId, date: gameDate, collectionName, week, team1_id, team2_id } = currentGameData;
        const isExhibition = collectionName === 'exhibition_games';
        const lineupsCollectionName = isExhibition ? 'exhibition_lineups' : (collectionName === 'post_games' ? 'post_lineups' : 'lineups');
        const lineupsCollectionRef = collection(db, "seasons", currentSeasonId, lineupsCollectionName);

        const liveGameRef = doc(db, 'live_games', gameId);
        const liveGameSnap = await getDoc(liveGameRef);
        if (liveGameSnap.exists()) {
            const liveGameData = liveGameSnap.data();
            ['team1', 'team2'].forEach(prefix => {
                document.querySelectorAll(`#${prefix}-starters .starter-card`).forEach(card => {
                    const playerId = card.id.replace('starter-card-', '');
                    const reductions = parseFloat(document.getElementById(`reductions-${playerId}`).value) || 0;
                    const teamArrayName = (prefix === 'team1') ? 'team1_lineup' : 'team2_lineup';
                    const playerInLineup = liveGameData[teamArrayName].find(p => p.player_id === playerId);
                    if (playerInLineup) {
                        playerInLineup.deductions = reductions;
                    }
                });
            });
            await setDoc(liveGameRef, liveGameData);
            alert('Deductions for live game updated successfully!');
            lineupModal.classList.remove('is-visible');
            return;
        }

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

        const gameRef = doc(db, "seasons", currentSeasonId, collectionName, gameId);
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

// --- NEW: Live Scoring Functions ---
async function handleSubmitForLiveScoring(e) {
    e.preventDefault();
    const button = e.target;
    button.disabled = true;
    button.textContent = 'Submitting...';

    // Validation: Check for 6 starters
    let isLineupValid = true;
    ['team1', 'team2'].forEach(prefix => {
        if (document.querySelectorAll(`#${prefix}-starters .starter-card`).length !== 6) {
            isLineupValid = false;
        }
    });

    if (!isLineupValid) {
        alert("Validation failed. Each team must have exactly 6 starters selected.");
        button.disabled = false;
        button.textContent = 'Submit Lineups for Live Scoring';
        return;
    }

    const { id: gameId, collectionName, team1_id, team2_id } = currentGameData;
    const team1_lineup = [];
    const team2_lineup = [];

    ['team1', 'team2'].forEach(prefix => {
        const captainId = lineupForm.querySelector(`input[name="${prefix}-captain"]:checked`)?.value;
        document.querySelectorAll(`#${prefix}-starters .starter-card`).forEach(card => {
            const playerId = card.id.replace('starter-card-', '');
            const player = allPlayers.get(playerId);
            const lineupPlayer = {
                player_id: playerId,
                player_handle: player.player_handle,
                team_id: (prefix === 'team1') ? team1_id : team2_id,
                is_captain: playerId === captainId,
                deductions: parseFloat(document.getElementById(`reductions-${playerId}`).value) || 0
            };
            if (prefix === 'team1') {
                team1_lineup.push(lineupPlayer);
            } else {
                team2_lineup.push(lineupPlayer);
            }
        });
    });

    try {
        const activateLiveGame = httpsCallable(functions, 'activateLiveGame');
        await activateLiveGame({
            gameId,
            seasonId: currentSeasonId,
            collectionName,
            team1_lineup,
            team2_lineup
        });
        alert('Live scoring activated successfully!');
        lineupModal.classList.remove('is-visible');
    } catch (error) {
        console.error("Error activating live scoring:", error);
        alert(`Failed to activate live scoring: ${error.message}`);
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
        fetchAndDisplayGames(currentSeasonId, weekSelect.value); // Refresh the game list
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