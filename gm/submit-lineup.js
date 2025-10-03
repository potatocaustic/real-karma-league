// /gm/submit-lineup.js

import { auth, db, functions, onAuthStateChanged, doc, getDoc, collection, getDocs, httpsCallable, query, where, orderBy, documentId, limit } from '/js/firebase-init.js';

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
        const teamsQuery = query(collection(db, "v2_teams"), where("gm_uid", "==", userId), limit(1));
        const teamSnap = await getDocs(teamsQuery);

        if (teamSnap.empty) {
            loadingContainer.innerHTML = '<div class="error">You are not registered as a GM for any team.</div>';
            return;
        }
        myTeamId = teamSnap.docs[0].id;

        const seasonsQuery = query(collection(db, "seasons"), where("status", "==", "active"), limit(1));
        const seasonSnap = await getDocs(seasonsQuery);
        if (seasonSnap.empty) {
            loadingContainer.innerHTML = '<div class="error">No active season found.</div>';
            return;
        }
        currentSeasonId = seasonSnap.docs[0].id;
        
        await cacheCoreData(currentSeasonId);
        
        const teamName = allTeams.get(myTeamId)?.team_name || 'My Team';
        document.getElementById('page-main-header').textContent = `${teamName} Upcoming Schedule`;
        loadingContainer.style.display = 'none';
        gmContainer.style.display = 'block';

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
    const playersSnap = await getDocs(collection(db, "v2_players"));
    playersSnap.docs.forEach(doc => allPlayers.set(doc.id, { id: doc.id, ...doc.data() }));

    const teamsSnap = await getDocs(collection(db, "v2_teams"));
    const teamPromises = teamsSnap.docs.map(async (teamDoc) => {
        const teamData = { id: teamDoc.id, ...teamDoc.data() };
        const seasonRecordSnap = await getDoc(doc(db, "v2_teams", teamDoc.id, "seasonal_records", seasonId));
        teamData.team_name = seasonRecordSnap.exists() ? seasonRecordSnap.data().team_name : "Name Not Found";
        return teamData;
    });
    const teamsWithData = await Promise.all(teamPromises);
    teamsWithData.forEach(team => allTeams.set(team.id, team));
}


async function fetchAndDisplaySchedule() {
    scheduleListContainer.innerHTML = '<div class="loading">Fetching schedule...</div>';
    countdownIntervals.forEach(clearInterval);
    countdownIntervals = [];

    const gamesQuery1 = query(collection(db, "seasons", currentSeasonId, "games"), where("team1_id", "==", myTeamId));
    const gamesQuery2 = query(collection(db, "seasons", currentSeasonId, "games"), where("team2_id", "==", myTeamId));
    const postGamesQuery1 = query(collection(db, "seasons", currentSeasonId, "post_games"), where("team1_id", "==", myTeamId));
    const postGamesQuery2 = query(collection(db, "seasons", currentSeasonId, "post_games"), where("team2_id", "==", myTeamId));

    const [snap1, snap2, postSnap1, postSnap2] = await Promise.all([
        getDocs(gamesQuery1), getDocs(gamesQuery2), getDocs(postGamesQuery1), getDocs(postGamesQuery2)
    ]);

    let allMyGames = [];
    const addGame = (doc, collectionName) => allMyGames.push({ id: doc.id, collectionName, ...doc.data() });
    
    snap1.forEach(doc => addGame(doc, 'games'));
    snap2.forEach(doc => addGame(doc, 'games'));
    postSnap1.forEach(doc => addGame(doc, 'post_games'));
    postSnap2.forEach(doc => addGame(doc, 'post_games'));

    allMyGames = allMyGames.filter(game => game.completed !== 'TRUE');

    if (allMyGames.length === 0) {
        scheduleListContainer.innerHTML = '<p class="placeholder-text">No upcoming games found on your schedule.</p>';
        return;
    }

    allMyGames.sort((a, b) => new Date(a.date) - new Date(b.date));

    const deadlineDates = [...new Set(allMyGames.map(g => {
        const [month, day, year] = g.date.split('/');
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }))];

    const deadlinesMap = new Map();
    if (deadlineDates.length > 0) {
        const deadlineQuery = query(collection(db, "lineup_deadlines"), where(documentId(), 'in', deadlineDates));
        const deadlinesSnap = await getDocs(deadlineQuery);
        deadlinesSnap.forEach(doc => deadlinesMap.set(doc.id, doc.data().deadline.toDate()));
    }

    const gameIds = allMyGames.map(g => g.id);
    const pendingLineups = new Map();
    const liveGames = new Map();

    if (gameIds.length > 0) {
        const pendingQuery = query(collection(db, "pending_lineups"), where(documentId(), 'in', gameIds));
        const liveQuery = query(collection(db, "live_games"), where(documentId(), 'in', gameIds));
        const [pendingSnap, liveSnap] = await Promise.all([getDocs(pendingQuery), getDocs(liveQuery)]);
        
        pendingSnap.forEach(doc => pendingLineups.set(doc.id, doc.data()));
        liveSnap.forEach(doc => liveGames.set(doc.id, doc.data()));
    }

    let scheduleHTML = '';
    const firstIncompleteGameId = allMyGames.length > 0 ? allMyGames[0].id : null;

    allMyGames.forEach(game => {
        const opponentId = game.team1_id === myTeamId ? game.team2_id : game.team1_id;
        const opponent = allTeams.get(opponentId);
        
        let statusHTML = '';
        
        let isMyTeamSubmitted = false;
        if (liveGames.has(game.id)) {
            isMyTeamSubmitted = true;
        } else {
            const pendingGame = pendingLineups.get(game.id);
            isMyTeamSubmitted = game.team1_id === myTeamId ? pendingGame?.team1_submitted : pendingGame?.team2_submitted;
        }

        const [month, day, year] = game.date.split('/');
        const deadlineKey = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const deadline = deadlinesMap.get(deadlineKey);

        if (isMyTeamSubmitted) {
            statusHTML = `<span style="color: green;">Lineup Submitted ✅</span>`;
        } else if (deadline) {
            // Format the deadline time for display in Eastern Time.
            const deadlineET = deadline.toLocaleTimeString('en-US', {
                timeZone: 'America/New_York',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            });
            const deadlineDateET = deadline.toLocaleDateString('en-US', {
                timeZone: 'America/New_York',
                month: 'numeric',
                day: 'numeric'
            });

            // Add the countdown timer and the new deadline display text.
            statusHTML = `
                <div>
                    <span id="countdown-${game.id}" class="countdown-timer"></span>
                    <small style="display: block; font-size: 0.75rem; color: #666;">
                        ${deadlineDateET}, ${deadlineET} ET
                    </small>
                </div>
            `;

            const intervalId = setInterval(() => {
                const timerEl = document.getElementById(`countdown-${game.id}`);
                if (!timerEl) { clearInterval(intervalId); return; }
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
        
        scheduleHTML += `
            <div class="game-entry" data-game-id="${game.id}" data-collection="${game.collectionName}" id="game-entry-${game.id}">
                <span class="game-details">
                    <span class="game-teams">
                        vs <strong>${opponent?.team_name || opponentId}</strong>
                    </span>
                    <span class="game-date">Date: ${game.date || 'N/A'}</span>
                </span>
                <div class="game-status">${statusHTML}</div>
                <button class="btn-admin-edit">Submit Lineup</button>
            </div>`;
    });
    scheduleListContainer.innerHTML = scheduleHTML;
    
    if (firstIncompleteGameId) {
        document.getElementById(`game-entry-${firstIncompleteGameId}`).style.border = "2px solid #007bff";
        document.getElementById(`game-entry-${firstIncompleteGameId}`).scrollIntoView({ behavior: 'smooth', block: 'center' });
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

async function openLineupModal(game) {
    lineupForm.reset();
    document.querySelectorAll('.roster-list, .starters-list').forEach(el => el.innerHTML = '');

    document.getElementById('lineup-game-id').value = game.id;
    document.getElementById('lineup-game-date').value = game.date;
    document.getElementById('lineup-collection-name').value = game.collectionName;

    const opponentId = game.team1_id === myTeamId ? game.team2_id : game.team1_id;
    const opponent = allTeams.get(opponentId);
    
    // === REQUEST 2: Populate the new subheader ===
    document.getElementById('lineup-modal-subheader').textContent = `vs. ${opponent.team_name}, ${game.date}`;

    const myRoster = Array.from(allPlayers.values()).filter(p => p.current_team_id === myTeamId);
    const pendingGameSnap = await getDoc(doc(db, "pending_lineups", game.id));
    const pendingData = pendingGameSnap.exists() ? pendingGameSnap.data() : {};
    
    const myLineupData = game.team1_id === myTeamId ? pendingData.team1_lineup : pendingData.team2_lineup;
    const myStartersMap = new Map();
    if (myLineupData) {
        myLineupData.forEach(p => myStartersMap.set(p.player_id, p));
    }

    renderMyTeamUI('my-team', allTeams.get(myTeamId), myRoster, myStartersMap);
    
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

    const captainId = lineupForm.querySelector('input[name="my-team-captain"]:checked')?.value;

    
    const [month, day, year] = currentGameData.date.split('/');
    const deadlineId = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const deadlineRef = doc(db, "lineup_deadlines", deadlineId);
    
    try {
        const deadlineSnap = await getDoc(deadlineRef);
        if (deadlineSnap.exists()) {
            const deadline = deadlineSnap.data().deadline.toDate();
            const lateNoCaptainEnd = new Date(deadline.getTime() + 10 * 60 * 1000); // 10 minutes
            const now = new Date();

            // If it's NOT past the grace period AND there's no captain, throw an error.
            if (!captainId && now <= lateNoCaptainEnd) {
                alert("You must select a captain for your lineup.");
                return;
            }
        } else if (!captainId) {
            // If no deadline is set yet, a captain is still required.
            alert("You must select a captain for your lineup.");
            return;
        }
    } catch (error) {
        console.error("Could not verify deadline for captain validation:", error);
        alert("An error occurred while validating your lineup. Please try again.");
        return;
    }

    button.disabled = true;
    button.textContent = 'Submitting...';

    const lineup = [];
    starterCards.forEach(card => {
        const playerId = card.id.replace('starter-card-', '');
        const player = allPlayers.get(playerId);
        lineup.push({
            player_id: playerId,
            player_handle: player.player_handle,
            is_captain: playerId === captainId,
            deductions: 0
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
        fetchAndDisplaySchedule();
    } catch (error) {
        console.error("Error submitting lineup:", error);
        alert(`Submission Failed: ${error.message}`);
    } finally {
        button.disabled = false;
        button.textContent = 'Submit My Lineup';
    }
}
