// /admin/manage-schedule.js

import { auth, db, functions, onAuthStateChanged, doc, getDoc, collection, getDocs, query, where, writeBatch, deleteDoc, setDoc, httpsCallable, getCurrentLeague, collectionNames, getLeagueCollectionName } from '/js/firebase-init.js';

const loadingContainer = document.getElementById('loading-container');
const adminContainer = document.getElementById('admin-container');
const seasonSelect = document.getElementById('season-select');
const regularSeasonContainer = document.getElementById('regular-season-schedule-container');
const postseasonContainer = document.getElementById('postseason-schedule-container');
const postseasonDatesContainer = document.getElementById('postseason-dates-container');
const addGameBtn = document.getElementById('add-game-btn');
const generatePostseasonBtn = document.getElementById('generate-postseason-btn');

const gameModal = document.getElementById('game-modal');
const gameForm = document.getElementById('game-form');
const closeModalBtn = gameModal.querySelector('.close-btn-admin');
const gameWeekSelect = document.getElementById('game-week');
const team1Select = document.getElementById('team1-select');
const team2Select = document.getElementById('team2-select');

let allTeams = [];
let gamesByWeek = {};
let exhibitionGamesByWeek = {};
let currentSeasonId = '';

document.addEventListener('DOMContentLoaded', () => {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            const userRef = doc(db, collectionNames.users, user.uid);
            const userDoc = await getDoc(userRef);
            if (userDoc.exists() && userDoc.data().role === 'admin') {
                await initializePage();
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
        const seasonsSnap = await getDocs(collection(db, collectionNames.seasons));
        if (seasonsSnap.empty) {
            adminContainer.innerHTML = `<div class="error">No seasons found in the database.</div>`;
            loadingContainer.style.display = 'none';
            adminContainer.style.display = 'block';
            return;
        }

        seasonSelect.innerHTML = seasonsSnap.docs
            .sort((a, b) => b.id.localeCompare(a.id))
            .map(doc => `<option value="${doc.id}">${doc.data().season_name}</option>`).join('');

        const activeSeason = seasonsSnap.docs.find(doc => doc.data().status === 'active');
        currentSeasonId = activeSeason ? activeSeason.id : seasonsSnap.docs[0].id;
        seasonSelect.value = currentSeasonId;

        await updateTeamCache(currentSeasonId);
        populatePostseasonDates();
        await loadSchedules();

        seasonSelect.addEventListener('change', async () => {
            currentSeasonId = seasonSelect.value;
            await updateTeamCache(currentSeasonId);
            await loadSchedules();
        });

        addGameBtn.addEventListener('click', openGameModal);
        closeModalBtn.addEventListener('click', () => gameModal.classList.remove('is-visible'));
        
        gameForm.addEventListener('submit', (e) => {
            e.preventDefault();
            saveGame(true); 
        });
        document.getElementById('save-another-btn').addEventListener('click', () => {
            saveGame(false); 
        });

        gameWeekSelect.addEventListener('change', populateAvailableTeams);
        generatePostseasonBtn.addEventListener('click', handleGeneratePostseason);
        regularSeasonContainer.addEventListener('click', handleDeleteGame);

        // Add event listener for force week update button
        const forceWeekUpdateBtn = document.getElementById('force-week-update-btn');
        if (forceWeekUpdateBtn) {
            forceWeekUpdateBtn.addEventListener('click', handleForceWeekUpdate);
        }

        // Listen for league changes and reload the page data
        window.addEventListener('leagueChanged', async (event) => {
            console.log('League changed to:', event.detail.league);
            // Reload all data for the new league
            await initializePage();
        });

        loadingContainer.style.display = 'none';
        adminContainer.style.display = 'block';

    } catch (error) {
        console.error("Error initializing schedule manager:", error);
        adminContainer.innerHTML = `<div class="error">An error occurred during initialization. Check the console for details.</div>`;
        loadingContainer.style.display = 'none';
        adminContainer.style.display = 'block';
    }
}

async function updateTeamCache(seasonId) {
    const teamsSnap = await getDocs(collection(db, collectionNames.teams));
    const teamPromises = teamsSnap.docs.map(async (teamDoc) => {
        const teamData = { id: teamDoc.id, ...teamDoc.data() };
        const seasonRecordRef = doc(db, collectionNames.teams, teamDoc.id, collectionNames.seasonalRecords, seasonId);
        const seasonRecordSnap = await getDoc(seasonRecordRef);

        teamData.team_name = seasonRecordSnap.exists() ? seasonRecordSnap.data().team_name : "Name Not Found";
        return teamData;
    });

    allTeams = (await Promise.all(teamPromises)).filter(Boolean);
}

function populatePostseasonDates() {
    const rounds = {
        'Play-In': 2, 'Round 1': 3, 'Round 2': 3, 'Conf Finals': 5, 'Finals': 7
    };

    let html = '';
    for (const [round, count] of Object.entries(rounds)) {
        html += `<details class="round-details"><summary class="round-summary">${round}</summary><div class="round-date-inputs">`;
        for (let i = 1; i <= count; i++) {
            html += `<div class="form-group-admin" style="margin-bottom: 0.5rem;"><label for="date-${round.replace(' ', '-')}-${i}">Game ${i} Date</label><input type="date" id="date-${round.replace(' ', '-')}-${i}" data-round-name="${round}"></div>`;
        }
        html += `</div></details>`;
    }
    postseasonDatesContainer.innerHTML = html;
}

async function loadSchedules() {
    if (!currentSeasonId) {
        console.error("Cannot load schedules without a valid season ID.");
        return;
    }

    gamesByWeek = {};
    exhibitionGamesByWeek = {};

    const [gamesSnap, postGamesSnap, exhibitionGamesSnap] = await Promise.all([
        getDocs(collection(db, collectionNames.seasons, currentSeasonId, getLeagueCollectionName('games'))),
        getDocs(collection(db, collectionNames.seasons, currentSeasonId, getLeagueCollectionName('post_games'))),
        getDocs(collection(db, collectionNames.seasons, currentSeasonId, getLeagueCollectionName('exhibition_games')))
    ]);

    gamesSnap.forEach(doc => {
        if (doc.id === 'placeholder') return;
        const game = { id: doc.id, ...doc.data() };
        if (!gamesByWeek[game.week]) gamesByWeek[game.week] = [];
        gamesByWeek[game.week].push(game);
    });

    exhibitionGamesSnap.forEach(doc => {
        if (doc.id === 'placeholder') return;
        const game = { id: doc.id, ...doc.data() };
        if (!exhibitionGamesByWeek[game.week]) exhibitionGamesByWeek[game.week] = [];
        exhibitionGamesByWeek[game.week].push(game);
    });

    const combinedGames = { ...gamesByWeek, ...exhibitionGamesByWeek };
    renderSchedule(regularSeasonContainer, true, combinedGames);

    const postGamesByWeek = {};
    postGamesSnap.forEach(doc => {
        if (doc.id === 'placeholder') return;
        const game = { id: doc.id, ...doc.data() };
        if (!postGamesByWeek[game.week]) postGamesByWeek[game.week] = [];
        postGamesByWeek[game.week].push(game);
    });
    renderSchedule(postseasonContainer, false, postGamesByWeek);
}

function renderSchedule(container, allowDelete = true, gamesSource = gamesByWeek) {
    if (Object.keys(gamesSource).length === 0) {
        container.innerHTML = '<p>No games scheduled.</p>';
        return;
    }

    let finalHTML = '';
    const weekOrder = ['Preseason', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', 'All-Star', 'Relegation', 'Play-In', 'Round 1', 'Round 2', 'Conf Finals', 'Finals'];
    const sortedWeeks = Object.keys(gamesSource).sort((a, b) => weekOrder.indexOf(a) - weekOrder.indexOf(b));

    for (const week of sortedWeeks) {
        finalHTML += `<details class="week-details"><summary class="week-summary">${isNaN(week) ? week : `Week ${week}`}</summary>`;
        finalHTML += '<table class="schedule-table">';
        gamesSource[week].forEach(game => {
            const team1 = allTeams.find(t => t.id === game.team1_id)?.team_name || game.team1_id || 'TBD';
            const team2 = allTeams.find(t => t.id === game.team2_id)?.team_name || game.team2_id || 'TBD';
            finalHTML += `
                <tr>
                    <td>${game.date}</td>
                    <td>${team1} vs ${team2}</td>
                    ${allowDelete ? `<td><button class="btn-admin-delete" data-game-id="${game.id}" data-is-exhibition="${game.week === 'All-Star' || game.week === 'Relegation' || game.week === 'Preseason'}">Delete</button></td>` : '<td></td>'}
                </tr>
            `;
        });
        finalHTML += '</table></details>';
    }
    container.innerHTML = finalHTML;
}

function openGameModal() {
    gameForm.reset();
    let weekOptions = '<option value="">-- Select a Week --</option>';
    weekOptions += `<option value="Preseason">Preseason</option>`;
    for (let i = 1; i <= 15; i++) {
        weekOptions += `<option value="${i}">Week ${i}</option>`;
    }
    weekOptions += `<option value="All-Star">All-Star</option>`;
    weekOptions += `<option value="Relegation">Relegation</option>`;
    gameWeekSelect.innerHTML = weekOptions;

    team1Select.innerHTML = '';
    team2Select.innerHTML = '';
    team1Select.disabled = true;
    team2Select.disabled = true;
    document.getElementById('game-date').valueAsDate = new Date();
    gameModal.classList.add('is-visible');
}

function populateAvailableTeams() {
    const week = gameWeekSelect.value;
    if (!week) {
        team1Select.disabled = true;
        team2Select.disabled = true;
        return;
    }

    let availableTeams;

    if (week === 'All-Star' || week === 'Relegation' || week === 'Preseason') {
        availableTeams = allTeams;
    } else {
        const scheduledTeams = new Set();
        if (gamesByWeek[week]) {
            gamesByWeek[week].forEach(game => {
                scheduledTeams.add(game.team1_id);
                scheduledTeams.add(game.team2_id);
            });
        }
        availableTeams = allTeams.filter(team => team.conference && !scheduledTeams.has(team.id));
    }

    const teamOptions = '<option value="">-- Select a Team --</option>' + availableTeams
        .sort((a,b) => a.team_name.localeCompare(b.team_name))
        .map(t => `<option value="${t.id}">${t.team_name}</option>`).join('');

    team1Select.innerHTML = teamOptions;
    team2Select.innerHTML = teamOptions;
    team1Select.disabled = false;
    team2Select.disabled = false;
}

async function saveGame(andExit = true) {
    const dateValue = document.getElementById('game-date').value;
    if (!dateValue || !team1Select.value || !team2Select.value || !gameWeekSelect.value) {
        alert("Please fill out all fields.");
        return;
    }

    const [year, month, day] = dateValue.split('-');
    const formattedDateForDoc = `${parseInt(month, 10)}/${parseInt(day, 10)}/${year}`;
    const formattedDateForId = `${year}-${month}-${day}`;

    const team1Id = team1Select.value;
    const team2Id = team2Select.value;
    const week = gameWeekSelect.value;

    if (team1Id === team2Id) {
        alert("A team cannot play against itself.");
        return;
    }

    const gameData = {
        date: formattedDateForDoc, week, team1_id: team1Id, team2_id: team2Id,
        completed: 'FALSE', team1_score: 0, team2_score: 0, winner: ''
    };

    const isExhibition = week === 'All-Star' || week === 'Relegation' || week === 'Preseason';
    const collectionName = isExhibition ? 'exhibition_games' : 'games';
    const gameId = `${formattedDateForId}-${team1Id}-${team2Id}`;
    
    const saveExitBtn = document.getElementById('save-exit-btn');
    const saveAnotherBtn = document.getElementById('save-another-btn');

    try {
        saveExitBtn.disabled = true;
        saveAnotherBtn.disabled = true;
        saveAnotherBtn.textContent = 'Saving...';

        await setDoc(doc(db, collectionNames.seasons, currentSeasonId, getLeagueCollectionName(collectionName), gameId), gameData);
        await loadSchedules();

        if (andExit) {
            gameModal.classList.remove('is-visible');
        } else {
            team1Select.value = '';
            team2Select.value = '';
            team1Select.focus();
        }
    } catch (error) {
        console.error("Error saving game:", error);
        alert("Could not save game.");
    } finally {
        saveExitBtn.disabled = false;
        saveAnotherBtn.disabled = false;
        saveAnotherBtn.textContent = 'Save & Log Another';
    }
}


async function handleDeleteGame(e) {
    if (!e.target.matches('.btn-admin-delete')) return;
    const gameId = e.target.dataset.gameId;
    const isExhibition = e.target.dataset.isExhibition === 'true';
    const collectionName = isExhibition ? 'exhibition_games' : 'games';

    if (confirm("Are you sure you want to delete this game?")) {
        try {
            await deleteDoc(doc(db, collectionNames.seasons, currentSeasonId, getLeagueCollectionName(collectionName), gameId));
            await loadSchedules();
        } catch (error) {
            console.error("Error deleting game:", error);
            alert("Could not delete game.");
        }
    }
}


async function handleGeneratePostseason() {
    generatePostseasonBtn.disabled = true;
    generatePostseasonBtn.textContent = 'Generating...';

    const dates = {
        'Play-In': [], 'Round 1': [], 'Round 2': [], 'Conf Finals': [], 'Finals': []
    };

    document.querySelectorAll('#postseason-dates-container input[type="date"]').forEach(input => {
        const roundName = input.dataset.roundName;

        if (dates[roundName] && input.value) {
            const [year, month, day] = input.value.split('-');
            dates[roundName].push(`${parseInt(month, 10)}/${parseInt(day, 10)}/${year}`);
        }
    });

    try {
        const generateSchedule = httpsCallable(functions, 'generatePostseasonSchedule');
        const result = await generateSchedule({ seasonId: currentSeasonId, dates, league: getCurrentLeague() });
        alert(result.data.message);
        await loadSchedules();
    } catch (error) {
        console.error("Error generating postseason schedule:", error);
        alert(`Error: ${error.message}`);
    } finally {
        generatePostseasonBtn.disabled = false;
        generatePostseasonBtn.textContent = 'Generate/Update Postseason Schedule';
    }
}

async function handleForceWeekUpdate() {
    const button = document.getElementById('force-week-update-btn');
    const statusDiv = document.getElementById('week-update-status');

    button.disabled = true;
    button.textContent = 'Updating...';
    statusDiv.innerHTML = '<p style="color: #666;">Processing week update...</p>';

    try {
        const forceWeekUpdate = httpsCallable(functions, 'forceWeekUpdate');
        const result = await forceWeekUpdate({ league: getCurrentLeague() });
        statusDiv.innerHTML = `<p style="color: green;">✓ ${result.data.message}</p>`;
    } catch (error) {
        console.error("Error forcing week update:", error);
        statusDiv.innerHTML = `<p style="color: red;">✗ Error: ${error.message}</p>`;
    } finally {
        button.disabled = false;
        button.textContent = '🔄 Update Current Week';
    }
}
