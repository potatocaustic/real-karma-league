// /gm/submit-lineup.js

import { auth, db, functions, onAuthStateChanged, doc, getDoc, collection, getDocs, httpsCallable, query, where, orderBy, documentId } from '/js/firebase-init.js';

// --- Page Elements ---
let loadingContainer, gmContainer, scheduleListContainer, lineupModal, lineupForm, closeLineupModalBtn;

// --- Global Data Cache ---
let currentSeasonId = null;
let myTeamId = null;
let allTeams = new Map();
let allPlayers = new Map();
let allGms = new Map();
let awardSelections = new Map();
let currentGameData = null;
let lastCheckedCaptain = null;
let countdownIntervals = [];

document.addEventListener('DOMContentLoaded', () => {
    loadingContainer = document.getElementById('loading-container');
    gmContainer = document.getElementById('gm-container');
    scheduleListContainer = document.getElementById('schedule-list-container');
    lineupModal = document.getElementById('lineup-modal');
    lineupForm = document.getElementById('lineup-form');
    closeLineupModalBtn = lineupModal.querySelector('.close-btn-admin');

    onAuthStateChanged(auth, async (user) => {
        if (user) {
            await initializePage(user.uid);
        } else {
            window.location.href = '/login.html';
        }
    });
});

async function initializePage(userId) {
    try {
        // Find the user's team
        const teamsQuery = query(collection(db, "v2_teams_dev"), where("gm_uid", "==", userId), limit(1));
        const teamSnap = await getDocs(teamsQuery);

        if (teamSnap.empty) {
            loadingContainer.innerHTML = '<div class="error">You are not registered as a GM for any team.</div>';
            return;
        }
        myTeamId = teamSnap.docs[0].id;

        // Get active season
        const seasonsQuery = query(collection(db, "seasons_dev"), where("status", "==", "active"), limit(1));
        const seasonSnap = await getDocs(seasonsQuery);
        if (seasonSnap.empty) {
            loadingContainer.innerHTML = '<div class="error">No active season found.</div>';
            return;
        }
        currentSeasonId = seasonSnap.docs[0].id;
        
        // Cache core data
        await cacheCoreData(currentSeasonId);
        
        document.getElementById('gm-team-name').textContent = allTeams.get(myTeamId)?.team_name || 'My Team';
        loadingContainer.style.display = 'none';
        gmContainer.style.display = 'block';

        // Fetch and display schedule
        await fetchAndDisplaySchedule();

        scheduleListContainer.addEventListener('click', handleOpenModalClick);
        closeLineupModalBtn.addEventListener('click', () => lineupModal.classList.remove('is-visible'));
        lineupForm.addEventListener('submit', handleLineupFormSubmit);
        document.getElementById('my-team-starters').addEventListener('click', handleCaptainToggle);

    } catch (error) {
        console.error("Fatal Error during Initialization:", error);
        loadingContainer.innerHTML = `<div class="error">A critical error occurred. Please check the console and refresh.</div>`;
    }
}

async function cacheCoreData(seasonId) {
    const playersSnap = await getDocs(collection(db, "v2_players_dev"));
    playersSnap.docs.forEach(doc => allPlayers.set(doc.id, { id: doc.id, ...doc.data() }));

    const teamsSnap = await getDocs(collection(db, "v2_teams_dev"));
    const teamPromises = teamsSnap.docs.map(async (teamDoc) => {
        const teamData = { id: teamDoc.id, ...teamDoc.data() };
        const seasonRecordSnap = await getDoc(doc(db, "v2_teams_dev", teamDoc.id, "seasonal_records_dev", seasonId));
        teamData.team_name = seasonRecordSnap.exists() ? seasonRecordSnap.data().team_name : "Name Not Found";
        return teamData;
    });
    const teamsWithData = await Promise.all(teamPromises);
    teamsWithData.forEach(team => allTeams.set(team.id, team));
}


async function fetchAndDisplaySchedule() {
    scheduleListContainer.innerHTML = '<div class="loading">Fetching schedule...</div>';
    countdownIntervals.forEach(clearInterval); // Clear old timers
    countdownIntervals = [];

    // Fetch regular season games
    const gamesQuery1 = query(collection(db, "seasons_dev", currentSeasonId, "games_dev"), where("team1_id", "==", myTeamId));
    const gamesQuery2 = query(collection(db, "seasons_dev", currentSeasonId, "games_dev"), where("team2_id", "==", myTeamId));
    
    // Fetch post-season games
    const postGamesQuery1 = query(collection(db, "seasons_dev", currentSeasonId, "post_games_dev"), where("team1_id", "==", myTeamId));
    const postGamesQuery2 = query(collection(db, "seasons_dev", currentSeasonId, "post_games_dev"), where("team2_id", "==", myTeamId));

    const [snap1, snap2, postSnap1, postSnap2] = await Promise.all([
        getDocs(gamesQuery1), getDocs(gamesQuery2), getDocs(postGamesQuery1), getDocs(postGamesQuery2)
    ]);

    const allMyGames = [];
    const addGame = (doc, collectionName) => allMyGames.push({ id: doc.id, collectionName, ...doc.data() });
    
    snap1.forEach(doc => addGame(doc, 'games_dev'));
    snap2.forEach(doc => addGame(doc, 'games_dev'));
    postSnap1.forEach(doc => addGame(doc, 'post_games_dev'));
    postSnap2.forEach(doc => addGame(doc, 'post_games_dev'));

    if (allMyGames.length === 0) {
        scheduleListContainer.innerHTML = '<p class="placeholder-text">No games found on your schedule.</p>';
        return;
    }

    // Sort games by date
    allMyGames.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Fetch deadlines and submission statuses
    const deadlineDates = [...new Set(allMyGames.map(g => g.date.split('/').reverse().join('-')))];
    const deadlinesMap = new Map();
    if (deadlineDates.length > 0) {
        const deadlineQuery = query(collection(db, "lineup_deadlines_dev"), where(documentId(), 'in', deadlineDates));
        const deadlinesSnap = await getDocs(deadlineQuery);
        deadlinesSnap.forEach(doc => deadlinesMap.set(doc.id, doc.data().deadline.toDate()));
    }

    const gameIds = allMyGames.map(g => g.id);
    const pendingLineups = new Map();
    if (gameIds.length > 0) {
        const pendingQuery = query(collection(db, "pending_lineups_dev"), where(documentId(), 'in', gameIds));
        const pendingSnap = await getDocs(pendingQuery);
        pendingSnap.forEach(doc => pendingLineups.set(doc.id, doc.data()));
    }

    let scheduleHTML = '';
    let firstIncompleteGameId = null;

    allMyGames.forEach(game => {
        const opponentId = game.team1_id === myTeamId ? game.team2_id : game.team1_id;
        const opponent = allTeams.get(opponentId);
        const isComplete = game.completed === 'TRUE';
        
        if (!isComplete && !firstIncompleteGameId) {
            firstIncompleteGameId = game.id;
        }

        let statusHTML = '';
        if (isComplete) {
            const myScore = game.team1_id === myTeamId ? game.team1_score : game.team2_score;
            const oppScore = game.team1_id === myTeamId ? game.team2_score : game.team1_score;
            statusHTML = `<span>${myScore.toFixed(0)} - ${oppScore.toFixed(0)}</span>`;
        } else {
            const isMyTeamSubmitted = game.team1_id === myTeamId ? pendingLineups.get(game.id)?.team1_submitted : pendingLineups.get(game.id)?.team2_submitted;
            const deadlineKey = game.date.split('/').reverse().join('-');
            const deadline = deadlinesMap.get(deadlineKey);

            if (isMyTeamSubmitted) {
                statusHTML = `<span style="color: green;">Lineup Submitted ✅</span>`;
            } else if (deadline) {
                statusHTML = `<span id="countdown-${game.id}" class="countdown-timer"></span>`;
                // Set up countdown timer
                const intervalId = setInterval(() => {
                    const timerEl = document.getElementById(`countdown-${game.id}`);
                    if (!timerEl) {
                        clearInterval(intervalId);
                        return;
                    }
                    const now = new Date();
                    const diff = deadline.getTime() - now.getTime();
                    if (diff <= 0) {
                        timerEl.textContent = 'Deadline Passed';
                        clearInterval(intervalId);
                    } else {
                        const d = Math.floor(diff / (1000 * 60 * 60 * 24));
                        const h = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                        const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
                        const s = Math.floor((diff % (1000 * 60)) / 1000);
                        timerEl.textContent = `Due in: ${d}d ${h}h ${m}m ${s}s`;
                    }
                }, 1000);
                countdownIntervals.push(intervalId);
            } else {
                 statusHTML = `<span>Awaiting Deadline</span>`;
            }
        }
        
        scheduleHTML += `
            <div class="game-entry" data-game-id="${game.id}" data-collection="${game.collectionName}" id="game-entry-${game.id}">
                <span class="game-details">
                    <span class="game-teams">
                        vs <strong>${opponent?.team_name || opponentId}</strong>
                    </span>
                    <span class="game-date">Date: ${game.date || 'N/A'}</span>
                </span>
                <span class="game-status">${statusHTML}</span>
                <button class="btn-admin-edit" ${isComplete ? 'disabled' : ''}>${isComplete ? 'Game Final' : 'Submit Lineup'}</button>
            </div>`;
    });
    scheduleListContainer.innerHTML = scheduleHTML;
    
    // Default to earliest incomplete game
    if (firstIncompleteGameId) {
        document.getElementById(`game-entry-${firstIncompleteGameId}`).style.border = "2px solid #007bff";
        document.getElementById(`game-entry-${firstIncompleteGameId}`).scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// Other functions (get roster, handle clicks, etc.) will be similar to manage-games.js but simplified for the GM.
// This is a representative subset of the required logic. Full implementation would follow this pattern.

async function handleOpenModalClick(e) {
    if (!e.target.matches('.btn-admin-edit')) return;
    
    const gameEntry = e.target.closest('.game-entry');
    const gameId = gameEntry.dataset.gameId;
    const collectionName = gameEntry.dataset.collection;

    const gameRef = doc(db, "seasons_dev", currentSeasonId, collectionName, gameId);
    const gameDoc = await getDoc(gameRef);

    if (gameDoc.exists()) {
        currentGameData = { id: gameDoc.id, ...gameDoc.data(), collectionName };
        await openLineupModal(currentGameData);
    } else {
        alert("Error: Could not load data for the selected game.");
    }
}

async function openLineupModal(game) {
    lineupForm.reset();
    document.querySelectorAll('.roster-list, .starters-list').forEach(el => el.innerHTML = '');

    document.getElementById('lineup-game-id').value = game.id;
    document.getElementById('lineup-game-date').value = game.date;
    document.getElementById('lineup-collection-name').value = game.collectionName;

    const myRoster = Array.from(allPlayers.values()).filter(p => p.current_team_id === myTeamId);
    const opponentId = game.team1_id === myTeamId ? game.team2_id : game.team1_id;
    const opponentRoster = Array.from(allPlayers.values()).filter(p => p.current_team_id === opponentId);
    
    const pendingGameSnap = await getDoc(doc(db, "pending_lineups_dev", game.id));
    const pendingData = pendingGameSnap.exists() ? pendingGameSnap.data() : {};
    
    const myLineupData = game.team1_id === myTeamId ? pendingData.team1_lineup : pendingData.team2_lineup;
    const myStartersMap = new Map();
    if (myLineupData) {
        myLineupData.forEach(p => myStartersMap.set(p.player_id, p));
    }

    // Render My Team's UI (Editable)
    renderMyTeamUI('my-team', allTeams.get(myTeamId), myRoster, myStartersMap);
    
    // Render Opponent's UI (Read-only)
    renderOpponentUI('opponent-team', allTeams.get(opponentId), opponentRoster);
    
    lineupModal.classList.add('is-visible');
}

function renderMyTeamUI(teamPrefix, teamData, roster, startersMap) {
    document.getElementById(`${teamPrefix}-name-header`).textContent = teamData.team_name;
    const rosterContainer = document.getElementById(`${teamPrefix}-roster`);
    rosterContainer.innerHTML = '';
    roster.sort((a, b) => a.player_handle.localeCompare(b.player_handle)).forEach(player => {
        const isStarter = startersMap.has(player.id);
        rosterContainer.innerHTML += `
            <label class="player-checkbox-item">
                <input type="checkbox" class="starter-checkbox" data-player-id="${player.id}" data-player-handle="${player.player_handle}" ${isStarter ? 'checked' : ''}>
                ${player.player_handle}
            </label>
        `;
    });

    rosterContainer.querySelectorAll('.starter-checkbox').forEach(cb => {
        cb.addEventListener('change', handleStarterChange);
        if (cb.checked) {
            addStarterCard(cb, startersMap.get(cb.dataset.playerId));
        }
    });
}

function renderOpponentUI(teamPrefix, teamData, roster) {
    document.getElementById(`${teamPrefix}-name-header`).textContent = teamData.team_name;
    const rosterContainer = document.getElementById(`${teamPrefix}-roster`);
    rosterContainer.innerHTML = roster.map(p => `<div>${p.player_handle}</div>`).join('');
}


function handleStarterChange(event) {
    const checkbox = event.target;
    if (checkbox.checked) {
        if (document.querySelectorAll('#my-team-starters .starter-card').length >= 6) {
            alert("You can only select 6 starters.");
            checkbox.checked = false;
            return;
        }
        addStarterCard(checkbox);
    } else {
        removeStarterCard(checkbox);
    }
    updateStarterCount();
}

function addStarterCard(checkbox, lineupData = null) {
    const { playerId, playerHandle } = checkbox.dataset;
    const startersContainer = document.getElementById(`my-team-starters`);
    const isCaptain = lineupData?.is_captain;
    
    const card = document.createElement('div');
    card.className = 'starter-card';
    card.id = `starter-card-${playerId}`;
    card.innerHTML = `
        <div>
            <strong>${playerHandle}</strong>
            <label><input type="radio" name="my-team-captain" value="${playerId}" ${isCaptain ? 'checked' : ''}> Captain</label>
        </div>`;
    startersContainer.appendChild(card);
    updateStarterCount();
}

function removeStarterCard(checkbox) {
    const card = document.getElementById(`starter-card-${checkbox.dataset.playerId}`);
    if (card) card.remove();
    updateStarterCount();
}

function updateStarterCount() {
    const count = document.querySelectorAll('#my-team-starters .starter-card').length;
    document.getElementById('my-team-starter-count').textContent = count;
}


function handleCaptainToggle(e) {
    if (e.target.type !== 'radio') return;
    const radio = e.target;
    if (radio === lastCheckedCaptain) {
        radio.checked = false;
        lastCheckedCaptain = null;
    } else {
        lastCheckedCaptain = radio;
    }
}

async function handleLineupFormSubmit(e) {
    e.preventDefault();
    const button = e.target.querySelector('button[type="submit"]');
    
    const starterCards = document.querySelectorAll('#my-team-starters .starter-card');
    if (starterCards.length !== 6) {
        alert("You must select exactly 6 starters.");
        return;
    }

    button.disabled = true;
    button.textContent = 'Submitting...';

    const lineup = [];
    const captainId = lineupForm.querySelector('input[name="my-team-captain"]:checked')?.value;
    starterCards.forEach(card => {
        const playerId = card.id.replace('starter-card-', '');
        const player = allPlayers.get(playerId);
        lineup.push({
            player_id: playerId,
            player_handle: player.player_handle,
            is_captain: playerId === captainId,
            deductions: 0 // GMs cannot set deductions
        });
    });

    const isMyTeam1 = currentGameData.team1_id === myTeamId;
    const submissionData = {
        gameId: currentGameData.id,
        seasonId: currentSeasonId,
        collectionName: currentGameData.collectionName,
        gameDate: currentGameData.date,
        submittingTeamId: myTeamId,
        [isMyTeam1 ? 'team1_lineup' : 'team2_lineup']: lineup,
    };
    
    try {
        const stageLiveLineups = httpsCallable(functions, 'stageLiveLineups');
        await stageLiveLineups(submissionData);
        alert('Lineup submitted successfully!');
        lineupModal.classList.remove('is-visible');
        fetchAndDisplaySchedule(); // Refresh schedule to show submitted status
    } catch (error) {
        console.error("Error submitting lineup:", error);
        alert(`Submission Failed: ${error.message}`);
    } finally {
        button.disabled = false;
        button.textContent = 'Submit My Lineup';
    }
}