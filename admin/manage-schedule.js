// /admin/manage-schedule.js

import { auth, db, functions, onAuthStateChanged, doc, getDoc, collection, getDocs, query, where, writeBatch, deleteDoc, setDoc, httpsCallable } from '/js/firebase-init.js';

const loadingContainer = document.getElementById('loading-container');
const adminContainer = document.getElementById('admin-container');
const seasonSelect = document.getElementById('season-select');
const regularSeasonContainer = document.getElementById('regular-season-schedule-container');
const postseasonContainer = document.getElementById('postseason-schedule-container');
const postseasonDatesContainer = document.getElementById('postseason-dates-container');
const addGameBtn = document.getElementById('add-game-btn');
const generatePostseasonBtn = document.getElementById('generate-postseason-btn');

// Modal Elements
const gameModal = document.getElementById('game-modal');
const gameForm = document.getElementById('game-form');
const closeModalBtn = gameModal.querySelector('.close-btn-admin');
const gameWeekSelect = document.getElementById('game-week');
const team1Select = document.getElementById('team1-select');
const team2Select = document.getElementById('team2-select');

let allTeams = [];
let gamesByWeek = {};
let exhibitionGamesByWeek = {};
let currentSeasonId = ''; // Start with an empty string

document.addEventListener('DOMContentLoaded', () => {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            const userRef = doc(db, "users", user.uid);
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
        const seasonsSnap = await getDocs(collection(db, "seasons"));
        if (seasonsSnap.empty) {
            adminContainer.innerHTML = `<div class="error">No seasons found in the database.</div>`;
            loadingContainer.style.display = 'none';
            adminContainer.style.display = 'block';
            return;
        }

        seasonSelect.innerHTML = seasonsSnap.docs
            .sort((a, b) => b.id.localeCompare(a.id))
            .map(doc => `<option value="${doc.id}">${doc.data().season_name}</option>`).join('');

        // Set the default selected season
        const activeSeason = seasonsSnap.docs.find(doc => doc.data().status === 'active');
        currentSeasonId = activeSeason ? activeSeason.id : seasonsSnap.docs[0].id;
        seasonSelect.value = currentSeasonId;

        // Initial data load for the default season
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
        gameForm.addEventListener('submit', handleSaveGame);
        gameWeekSelect.addEventListener('change', populateAvailableTeams);
        generatePostseasonBtn.addEventListener('click', handleGeneratePostseason);
        regularSeasonContainer.addEventListener('click', handleDeleteGame);

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
    const teamsSnap = await getDocs(collection(db, "v2_teams"));
    const teamPromises = teamsSnap.docs.map(async (teamDoc) => {
        if (!teamDoc.data().conference) return null;

        const teamData = { id: teamDoc.id, ...teamDoc.data() };
        const seasonRecordRef = doc(db, "v2_teams", teamDoc.id, "seasonal_records", seasonId);
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
            html += `<div class="form-group-admin" style="margin-bottom: 0.5rem;"><label for="date-${round.replace(' ', '-')}-${i}">Game ${i} Date</label><input type="date" id="date-${round.replace(' ', '-')}-${i}"></div>`;
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
        getDocs(collection(db, `seasons/${currentSeasonId}/games`)),
        getDocs(collection(db, `seasons/${currentSeasonId}/post_games`)),
        getDocs(collection(db, `seasons/${currentSeasonId}/exhibition_games`))
    ]);

    gamesSnap.forEach(doc => {
        const game = { id: doc.id, ...doc.data() };
        if (!gamesByWeek[game.week]) gamesByWeek[game.week] = [];
        gamesByWeek[game.week].push(game);
    });

    exhibitionGamesSnap.forEach(doc => {
        const game = { id: doc.id, ...doc.data() };
        if (!exhibitionGamesByWeek[game.week]) exhibitionGamesByWeek[game.week] = [];
        exhibitionGamesByWeek[game.week].push(game);
    });

    // Combine regular and exhibition for the main display
    const combinedGames = { ...gamesByWeek, ...exhibitionGamesByWeek };
    renderSchedule(regularSeasonContainer, true, combinedGames);

    const postGamesByWeek = {};
    postGamesSnap.forEach(doc => {
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
    const weekOrder = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', 'All-Star', 'Relegation', 'Play-In', 'Round 1', 'Round 2', 'Conf Finals', 'Finals'];
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
                    ${allowDelete ? `<td><button class="btn-admin-delete" data-game-id="${game.id}" data-is-exhibition="${game.week === 'All-Star' || game.week === 'Relegation'}">Delete</button></td>` : '<td></td>'}
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

    let availableTeams = allTeams;
    if (!isNaN(week)) { // Only filter for regular season weeks
        const scheduledTeams = new Set();
        if (gamesByWeek[week]) {
            gamesByWeek[week].forEach(game => {
                scheduledTeams.add(game.team1_id);
                scheduledTeams.add(game.team2_id);
            });
        }
        availableTeams = allTeams.filter(team => !scheduledTeams.has(team.id));
    }

    const teamOptions = '<option value="">-- Select a Team --</option>' + availableTeams.map(t => `<option value="${t.id}">${t.team_name}</option>`).join('');

    team1Select.innerHTML = teamOptions;
    team2Select.innerHTML = teamOptions;
    team1Select.disabled = false;
    team2Select.disabled = false;
}

async function handleSaveGame(e) {
    e.preventDefault();
    const dateValue = document.getElementById('game-date').value;
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

    const isExhibition = week === 'All-Star' || week === 'Relegation';
    const collectionName = isExhibition ? 'exhibition_games' : 'games';
    const gameId = `${formattedDateForId}-${team1Id}-${team2Id}`;

    try {
        await setDoc(doc(db, `seasons/${currentSeasonId}/${collectionName}`, gameId), gameData);
        gameModal.classList.remove('is-visible');
        await loadSchedules();
    } catch (error) {
        console.error("Error saving game:", error);
        alert("Could not save game.");
    }
}

async function handleDeleteGame(e) {
    if (!e.target.matches('.btn-admin-delete')) return;
    const gameId = e.target.dataset.gameId;
    const isExhibition = e.target.dataset.isExhibition === 'true';
    const collectionName = isExhibition ? 'exhibition_games' : 'games';

    if (confirm("Are you sure you want to delete this game?")) {
        try {
            await deleteDoc(doc(db, `seasons/${currentSeasonId}/${collectionName}`, gameId));
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
        const idParts = input.id.split('-');
        const roundName = idParts[1] === 'Conf' ? 'Conf Finals' : idParts[1];
        if (dates[roundName] && input.value) {
            const [year, month, day] = input.value.split('-');
            dates[roundName].push(`${parseInt(month, 10)}/${parseInt(day, 10)}/${year}`);
        }
    });

    try {
        const generateSchedule = httpsCallable(functions, 'generatePostseasonSchedule');
        const result = await generateSchedule({ seasonId: currentSeasonId, dates });
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
