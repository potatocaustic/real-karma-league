// /gm/submit-lineup.js

import { auth, db, functions, onAuthStateChanged, doc, getDoc, collection, getDocs, httpsCallable, query, where, orderBy, documentId, limit, getCurrentLeague, collectionNames, getLeagueCollectionName } from '/js/firebase-init.js';

// --- Page Elements ---
let loadingContainer, gmContainer, scheduleListContainer, lineupModal, lineupForm, closeLineupModalBtn, lineupModalWarning;

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
    lineupModalWarning = document.getElementById('lineup-modal-warning');
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
        const teamsQuery = query(collection(db, collectionNames.teams), where("gm_uid", "==", userId), limit(1));
        const teamSnap = await getDocs(teamsQuery);

        if (teamSnap.empty) {
            loadingContainer.innerHTML = '<div class="error">You are not registered as a GM for any team.</div>';
            return;
        }
        myTeamId = teamSnap.docs[0].id;

        const seasonsQuery = query(collection(db, collectionNames.seasons), where("status", "==", "active"), limit(1));
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
    const playersSnap = await getDocs(collection(db, collectionNames.players));
    playersSnap.docs.forEach(doc => allPlayers.set(doc.id, { id: doc.id, ...doc.data() }));

    const teamsSnap = await getDocs(collection(db, collectionNames.teams));
    const teamPromises = teamsSnap.docs.map(async (teamDoc) => {
        const teamData = { id: teamDoc.id, ...teamDoc.data() };
        const seasonRecordSnap = await getDoc(doc(db, collectionNames.teams, teamDoc.id, collectionNames.seasonalRecords, seasonId));
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

    const gamesQuery1 = query(collection(db, collectionNames.seasons, currentSeasonId, "games"), where("team1_id", "==", myTeamId));
    const gamesQuery2 = query(collection(db, collectionNames.seasons, currentSeasonId, "games"), where("team2_id", "==", myTeamId));
    const postGamesQuery1 = query(collection(db, collectionNames.seasons, currentSeasonId, "post_games"), where("team1_id", "==", myTeamId));
    const postGamesQuery2 = query(collection(db, collectionNames.seasons, currentSeasonId, "post_games"), where("team2_id", "==", myTeamId));

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
        const deadlineQuery = query(collection(db, collectionNames.lineupDeadlines), where(documentId(), 'in', deadlineDates));
        const deadlinesSnap = await getDocs(deadlineQuery);
        deadlinesSnap.forEach(doc => deadlinesMap.set(doc.id, doc.data().deadline.toDate()));
    }

    const gameIds = allMyGames.map(g => g.id);
    const pendingLineups = new Map();
    const liveGames = new Map();

    if (gameIds.length > 0) {
        const pendingQuery = query(collection(db, collectionNames.pendingLineups), where(documentId(), 'in', gameIds));
        const liveQuery = query(collection(db, collectionNames.liveGames), where(documentId(), 'in', gameIds));
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
        let buttonDisabled = '';
        let buttonText = 'Submit Lineup';
        let dataDeadlineAttr = '';

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
            statusHTML = `<span class="submission-success">Lineup Submitted ✅</span>`;
            buttonText = 'Edit Lineup';
        }

        if (deadline) {
            dataDeadlineAttr = `data-deadline="${deadline.toISOString()}"`;
            const gracePeriodEnd = new Date(deadline.getTime() + 150 * 60 * 1000);
            const now = new Date();

            if (now > gracePeriodEnd) {
                statusHTML = `<span class="submission-failed">Submission Window Closed</span>`;
                buttonText = 'Window Closed';
                buttonDisabled = 'disabled';
            } else if (!isMyTeamSubmitted) {
                const deadlineET = deadline.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true });
                const deadlineDateET = deadline.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric' });

                statusHTML = `
                    <div>
                        <span id="countdown-${game.id}" class="countdown-timer"></span>
                        <small style="display: block; font-size: 0.75rem; color: #666;">${deadlineDateET}, ${deadlineET} ET</small>
                    </div>
                `;
                const intervalId = setInterval(() => {
                    const timerEl = document.getElementById(`countdown-${game.id}`);
                    if (!timerEl) { clearInterval(intervalId); return; }
                    
                    const now = new Date();
                    const diff = deadline.getTime() - now.getTime();

                    if (diff <= 0) { 
                        timerEl.textContent = 'Deadline Passed';
                    } else { 
                        const d = Math.floor(diff / (1000 * 60 * 60 * 24));
                        const h = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                        const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
                        const s = Math.floor((diff % (1000 * 60)) / 1000);
                        timerEl.textContent = `Due in: ${d}d ${h}h ${m}m ${s}s`;
                    }

                    const twentyFourHoursInMs = 24 * 60 * 60 * 1000;
                    if (diff < twentyFourHoursInMs) {
                        timerEl.style.color = '#dc3545';
                    } else {
                        timerEl.style.color = '#fd7e14';
                    }

                    if (now > gracePeriodEnd) {
                        clearInterval(intervalId);
                        const gameEntryEl = document.getElementById(`game-entry-${game.id}`);
                        if (gameEntryEl) {
                            gameEntryEl.querySelector('.game-status').innerHTML = `<span class="submission-failed">Submission Window Closed</span>`;
                            const btn = gameEntryEl.querySelector('button');
                            btn.textContent = 'Window Closed';
                            btn.disabled = true;
                        }
                    }

                }, 1000);
                countdownIntervals.push(intervalId);
            }
        } else {
             if (!isMyTeamSubmitted) statusHTML = `<span>Awaiting Deadline</span>`;
             buttonDisabled = 'disabled';
             buttonText = 'Awaiting Deadline';
        }
        
        scheduleHTML += `
            <div class="game-entry" data-game-id="${game.id}" data-collection="${game.collectionName}" ${dataDeadlineAttr} id="game-entry-${game.id}">
                <span class="game-details">
                    <span class="game-teams">
                        vs <strong>${opponent?.team_name || opponentId}</strong>
                    </span>
                    <span class="game-date">Date: ${game.date || 'N/A'}</span>
                </span>
                <div class="game-status">${statusHTML}</div>
                <button class="btn-admin-edit" ${buttonDisabled}>${buttonText}</button>
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
    const deadlineString = gameEntry.dataset.deadline;

    const gameRef = doc(db, collectionNames.seasons, currentSeasonId, collectionName, gameId);
    const gameDoc = await getDoc(gameRef);

    if (gameDoc.exists()) {
        currentGameData = { id: gameDoc.id, ...gameDoc.data(), collectionName };
        await openLineupModal(currentGameData, deadlineString);
    } else {
        alert("Error: Could not load data for the selected game.");
    }
}

async function openLineupModal(game, deadlineString) {
    lineupForm.reset();
    document.querySelectorAll('.roster-list, .starters-list').forEach(el => el.innerHTML = '');
    lineupModalWarning.style.display = 'none'; 

    document.getElementById('lineup-game-id').value = game.id;
    document.getElementById('lineup-game-date').value = game.date;
    document.getElementById('lineup-collection-name').value = game.collectionName;

    const opponentId = game.team1_id === myTeamId ? game.team2_id : game.team1_id;
    const opponent = allTeams.get(opponentId);
    
    document.getElementById('lineup-modal-subheader').textContent = `vs. ${opponent.team_name}, ${game.date}`;

    const myRoster = Array.from(allPlayers.values()).filter(p => p.current_team_id === myTeamId);
    let myLineupData = null;
    let myLineupOrdered = [];

    const pendingGameSnap = await getDoc(doc(db, collectionNames.pendingLineups, game.id));
    if (pendingGameSnap.exists()) {
        const pendingData = pendingGameSnap.data();
        myLineupData = game.team1_id === myTeamId ? pendingData.team1_lineup : pendingData.team2_lineup;
    } else {
        const liveGameSnap = await getDoc(doc(db, collectionNames.liveGames, game.id));
        if (liveGameSnap.exists()) {
            const liveData = liveGameSnap.data();
            myLineupData = game.team1_id === myTeamId ? liveData.team1_lineup : liveData.team2_lineup;
        }
    }

    const myStartersMap = new Map();
    if (myLineupData) {
        myLineupOrdered = myLineupData; // Preserve the ordered array
        myLineupData.forEach(p => myStartersMap.set(p.player_id, p));
    }
    
    let isCaptainDisabled = false;
    let existingCaptainId = null; 

    if (deadlineString) {
        const deadline = new Date(deadlineString);
        const lateNoCaptainEnd = new Date(deadline.getTime() + 10 * 60 * 1000);
        const now = new Date();
        if (now > lateNoCaptainEnd) {
            isCaptainDisabled = true;
            lineupModalWarning.textContent = "Lineup deadline passed. Cannot submit new/edited lineup with a captain.";
            lineupModalWarning.style.display = 'block';

            if (myStartersMap.size > 0) {
                for (const player of myStartersMap.values()) {
                    if (player.is_captain) {
                        existingCaptainId = player.player_id;
                        break;
                    }
                }
            }
        }
    }

    renderMyTeamUI('my-team', allTeams.get(myTeamId), myRoster, myStartersMap, myLineupOrdered, isCaptainDisabled, existingCaptainId);

    lineupModal.classList.add('is-visible');
}

function renderMyTeamUI(teamPrefix, teamData, roster, startersMap, startersOrdered = [], isCaptainDisabled = false, existingCaptainId = null) {
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
    });

    // If we have an ordered lineup, add starter cards in that order (preserves admin's ordering)
    if (startersOrdered.length > 0) {
        startersOrdered.forEach(starter => {
            const checkbox = rosterContainer.querySelector(`.starter-checkbox[data-player-id="${starter.player_id}"]`);
            if (checkbox) {
                const lineupData = startersMap.get(starter.player_id);
                addStarterCard(checkbox, lineupData, isCaptainDisabled, existingCaptainId);
            }
        });
    } else {
        // Otherwise add cards for checked checkboxes (new lineup)
        rosterContainer.querySelectorAll('.starter-checkbox:checked').forEach(cb => {
            addStarterCard(cb, startersMap.get(cb.dataset.playerId), isCaptainDisabled, existingCaptainId);
        });
    }
}

function handleStarterChange(event) {
    const checkbox = event.target;
    const isCaptainDisabled = lineupModalWarning.style.display !== 'none';
    if (checkbox.checked) {
        if (document.querySelectorAll('#my-team-starters .starter-card').length >= 6) {
            alert("You can only select 6 starters.");
            checkbox.checked = false;
            return;
        }
        addStarterCard(checkbox, null, isCaptainDisabled, null);
    } else {
        removeStarterCard(checkbox);
    }
    updateStarterCount();
}

function addStarterCard(checkbox, lineupData = null, isCaptainDisabled = false, existingCaptainId = null) {
    const { playerId, playerHandle } = checkbox.dataset;
    const startersContainer = document.getElementById(`my-team-starters`);
    const isCaptain = lineupData?.is_captain;
    
    const shouldBeDisabled = isCaptainDisabled && (playerId !== existingCaptainId);

    const card = document.createElement('div');
    card.className = 'starter-card';
    card.id = `starter-card-${playerId}`;
    card.innerHTML = `
        <div>
            <strong>${playerHandle}</strong>
            <label><input type="radio" name="my-team-captain" value="${playerId}" ${isCaptain ? 'checked' : ''} ${shouldBeDisabled ? 'disabled' : ''}> Captain</label>
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
    const deadlineRef = doc(db, collectionNames.lineupDeadlines, deadlineId);
    
    try {
        const deadlineSnap = await getDoc(deadlineRef);
        if (deadlineSnap.exists()) {
            const deadline = deadlineSnap.data().deadline.toDate();
            const lateNoCaptainEnd = new Date(deadline.getTime() + 10 * 60 * 1000); // 10 minutes
            const now = new Date();

            if (!captainId && now <= lateNoCaptainEnd) {
                alert("You must select a captain for your lineup.");
                return;
            }
            if (captainId && now > lateNoCaptainEnd) {
                 alert("Your submission is late. You must remove your captain selection to submit.");
                 return;
            }
        } else if (!captainId) {
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
        const team = allTeams.get(player.current_team_id);
        lineup.push({
            player_id: playerId,
            player_handle: player.player_handle,
            handle: player.player_handle, // Add for daily leaderboard compatibility
            player_name: player.player_name || player.player_handle, // Some players may not have separate player_name
            team_id: player.current_team_id || '',
            team_name: team?.team_name || '',
            is_captain: playerId === captainId,
            deductions: 0
        });
    });

    // Apply the same ordering logic as admin: captain at the top, rest in selection order
    if (captainId) {
        const captainIndex = lineup.findIndex(p => p.player_id === captainId);
        if (captainIndex > 0) {
            const captain = lineup.splice(captainIndex, 1)[0];
            lineup.unshift(captain);
        }
    }

    const isMyTeam1 = currentGameData.team1_id === myTeamId;
    const submissionData = {
        gameId: currentGameData.id,
        seasonId: currentSeasonId,
        collectionName: currentGameData.collectionName,
        gameDate: currentGameData.date,
        submittingTeamId: myTeamId,
        [isMyTeam1 ? 'team1_lineup' : 'team2_lineup']: lineup,
        league: getCurrentLeague()
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
