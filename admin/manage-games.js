// /admin/manage-games.js

import { auth, db, onAuthStateChanged, doc, getDoc, collection, query, where, getDocs, updateDoc } from '/js/firebase-init.js';
import { writeBatch } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-firestore.js";

// --- Page Elements ---
let loadingContainer, adminContainer, authStatusDiv, seasonSelect, weekSelect, gamesListContainer, lineupModal, lineupForm, closeLineupModalBtn;

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
        // Only cache player data, which is not season-dependent
        const playersSnap = await getDocs(collection(db, "v2_players"));
        playersSnap.docs.forEach(doc => allPlayers.set(doc.id, { id: doc.id, ...doc.data() }));
    } catch (error) {
        console.error("Failed to cache core data:", error);
    }

    await populateSeasons();

    seasonSelect.addEventListener('change', async () => {
        currentSeasonId = seasonSelect.value;
        if (currentSeasonId) {
            // Update both caches for the newly selected season
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
            return null; // Filter out non-team documents
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
            // Update both caches for the initial season load
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
        // This populates the week dropdown
        await populateWeeks(currentSeasonId);

        // Automatically select Week 1 and fetch its games
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
    // Exhibition games have special rosters
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

    // Default: Regular team roster for regular season, postseason, and Relegation
    return Array.from(allPlayers.values()).filter(p => p.current_team_id === teamId);
}

async function openLineupModal(game) {
    lineupForm.reset();
    lastCheckedCaptain = { team1: null, team2: null };
    document.querySelectorAll('.roster-list, .starters-list').forEach(el => el.innerHTML = '');
    document.querySelectorAll('.team-lineup-section').forEach(el => el.classList.remove('validation-error'));

    document.getElementById('lineup-game-id').value = game.id;
    document.getElementById('lineup-game-date').value = game.date;
    document.getElementById('lineup-is-postseason').value = game.collectionName === 'post_games';
    document.getElementById('lineup-game-completed-checkbox').checked = game.completed === 'TRUE';

    const isExhibition = game.collectionName === 'exhibition_games';
    const lineupsCollectionName = isExhibition ? 'exhibition_lineups' : (game.collectionName === 'post_games' ? 'post_lineups' : 'lineups');

    // Fetch all lineups for the game's date
    const lineupsQuery = query(collection(db, "seasons", currentSeasonId, lineupsCollectionName), where("date", "==", game.date));
    const lineupsSnap = await getDocs(lineupsQuery);
    const existingLineups = new Map();

    // Get the full roster for each team in this specific game
    const team1Roster = getRosterForTeam(game.team1_id, game.week);
    const team2Roster = getRosterForTeam(game.team2_id, game.week);
    const playerIdsInGame = new Set([...team1Roster, ...team2Roster].map(p => p.id));

    // Filter the daily lineups to include only players involved in this game
    lineupsSnap.forEach(d => {
        const lineupData = d.data();
        if (playerIdsInGame.has(lineupData.player_id)) {
            existingLineups.set(lineupData.player_id, lineupData);
        }
    });

    const team1Roster = getRosterForTeam(game.team1_id, game.week);
    const team2Roster = getRosterForTeam(game.team2_id, game.week);

    const team1 = allTeams.get(game.team1_id) || { team_name: game.team1_id };
    const team2 = allTeams.get(game.team2_id) || { team_name: game.team2_id };

    renderTeamUI('team1', team1, team1Roster, existingLineups);
    renderTeamUI('team2', team2, team2Roster, existingLineups);

    document.getElementById('lineup-modal-title').textContent = `Lineups for ${team1.team_name} vs ${team2.team_name}`;
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

        const team1Roster = getRosterForTeam(team1_id, week);
        const team2Roster = getRosterForTeam(team2_id, week);
        const playersInGame = [...team1Roster, ...team2Roster];

        for (const player of playersInGame) {
            const starterCard = document.getElementById(`starter-card-${player.id}`);
            const lineupId = `${gameId}-${player.id}`;
            const docRef = doc(lineupsCollectionRef, lineupId);

            const teamPrefix = team1Roster.includes(player) ? 'team1' : 'team2';
            const captainId = lineupForm.querySelector(`input[name="${teamPrefix}-captain"]:checked`)?.value;

            let lineupData = {
                player_id: player.id, player_handle: player.player_handle,
                team_id: team1Roster.includes(player) ? team1_id : team2_id,
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
            winner: team1FinalScore > team2FinalScore ? team1_id : team2_id
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

function addLogoutListener() {
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            auth.signOut().then(() => { window.location.href = '/login.html'; });
        });
    }
}