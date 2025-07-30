// /admin/manage-schedule.js

import { auth, db, functions, onAuthStateChanged, doc, getDoc, collection, getDocs, query, where, writeBatch, deleteDoc, setDoc, httpsCallable } from '/js/firebase-init.js';

const loadingContainer = document.getElementById('loading-container');
const adminContainer = document.getElementById('admin-container');
const regularSeasonContainer = document.getElementById('regular-season-schedule-container');
const postseasonContainer = document.getElementById('postseason-schedule-container');
const postseasonDatesContainer = document.getElementById('postseason-dates-grid');
const addGameBtn = document.getElementById('add-game-btn');
const generatePostseasonBtn = document.getElementById('generate-postseason-btn');

// Modal Elements
const gameModal = document.getElementById('game-modal');
const gameForm = document.getElementById('game-form');
const closeModalBtn = gameModal.querySelector('.close-btn-admin');
const gameWeekInput = document.getElementById('game-week');
const team1Select = document.getElementById('team1-select');
const team2Select = document.getElementById('team2-select');

let allTeams = [];
let gamesByWeek = {};
let currentSeasonId = 'S7';

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
        const teamsSnap = await getDocs(collection(db, "v2_teams"));
        allTeams = teamsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        populatePostseasonDates();
        await loadSchedules();

        addGameBtn.addEventListener('click', openGameModal);
        closeModalBtn.addEventListener('click', () => gameModal.style.display = 'none');
        gameForm.addEventListener('submit', handleSaveGame);
        gameWeekInput.addEventListener('change', populateAvailableTeams);
        generatePostseasonBtn.addEventListener('click', handleGeneratePostseason);
        regularSeasonContainer.addEventListener('click', handleDeleteGame);


        loadingContainer.style.display = 'none';
        adminContainer.style.display = 'block';
    } catch (error) {
        console.error("Error initializing schedule manager:", error);
    }
}

function populatePostseasonDates() {
    const rounds = {
        'Play-In': 2, 'Round 1': 3, 'Round 2': 3, 'Conf Finals': 5, 'Finals': 7
    };

    let html = '';
    for (const [round, count] of Object.entries(rounds)) {
        html += `<div class="form-group-admin"><h4>${round}</h4>`;
        for (let i = 1; i <= count; i++) {
            html += `<label for="date-${round.replace(' ', '-')}-${i}">Game ${i} Date</label>
                     <input type="date" id="date-${round.replace(' ', '-')}-${i}">`;
        }
        html += `</div>`;
    }
    postseasonDatesContainer.innerHTML = html;
}

async function loadSchedules() {
    gamesByWeek = {};
    // Load Regular Season
    const gamesRef = collection(db, `seasons/${currentSeasonId}/games`);
    const gamesSnap = await getDocs(gamesRef);
    gamesSnap.docs.forEach(doc => {
        const game = { id: doc.id, ...doc.data() };
        if (!gamesByWeek[game.week]) gamesByWeek[game.week] = [];
        gamesByWeek[game.week].push(game);
    });
    renderSchedule(regularSeasonContainer, true);

    // Load Postseason
    const postGamesRef = collection(db, `seasons/${currentSeasonId}/post_games`);
    const postGamesSnap = await getDocs(postGamesRef);
    const postGamesByWeek = {};
    postGamesSnap.docs.forEach(doc => {
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
    const sortedWeeks = Object.keys(gamesSource).sort((a, b) => {
        if (!isNaN(a) && !isNaN(b)) return a - b;
        return a.localeCompare(b); // For postseason week names
    });

    for (const week of sortedWeeks) {
        finalHTML += `<details class="week-details"><summary class="week-summary">${isNaN(week) ? week : `Week ${week}`}</summary>`;
        finalHTML += '<table class="schedule-table">';
        gamesSource[week].forEach(game => {
            const team1 = allTeams.find(t => t.id === game.team1_id)?.team_name || 'TBD';
            const team2 = allTeams.find(t => t.id === game.team2_id)?.team_name || 'TBD';
            finalHTML += `
                <tr>
                    <td>${game.date}</td>
                    <td>${team1} vs ${team2}</td>
                    ${allowDelete ? `<td><button class="btn-admin-delete" data-game-id="${game.id}">Delete</button></td>` : ''}
                </tr>
            `;
        });
        finalHTML += '</table></details>';
    }
    container.innerHTML = finalHTML;
}

function openGameModal() {
    gameForm.reset();
    team1Select.innerHTML = '';
    team2Select.innerHTML = '';
    team1Select.disabled = true;
    team2Select.disabled = true;
    // Set default date to today
    document.getElementById('game-date').valueAsDate = new Date();
    gameModal.style.display = 'flex';
}

function populateAvailableTeams() {
    const week = gameWeekInput.value;
    if (!week) {
        team1Select.disabled = true;
        team2Select.disabled = true;
        return;
    }

    const scheduledTeams = new Set();
    if (gamesByWeek[week]) {
        gamesByWeek[week].forEach(game => {
            scheduledTeams.add(game.team1_id);
            scheduledTeams.add(game.team2_id);
        });
    }

    const availableTeams = allTeams.filter(team => !scheduledTeams.has(team.id));
    const teamOptions = availableTeams.map(t => `<option value="${t.id}">${t.team_name}</option>`).join('');

    team1Select.innerHTML = teamOptions;
    team2Select.innerHTML = teamOptions;
    team1Select.disabled = false;
    team2Select.disabled = false;
}

async function handleSaveGame(e) {
    e.preventDefault();
    const dateValue = document.getElementById('game-date').value; // YYYY-MM-DD
    const [year, month, day] = dateValue.split('-');
    const formattedDateForDoc = `${month}/${day}/${year}`;
    const formattedDateForId = `${month}-${day}-${year}`;

    const team1Id = team1Select.value;
    const team2Id = team2Select.value;

    if (team1Id === team2Id) {
        alert("A team cannot play against itself.");
        return;
    }

    const gameData = {
        date: formattedDateForDoc,
        week: gameWeekInput.value,
        team1_id: team1Id,
        team2_id: team2Id,
        completed: 'FALSE',
        team1_score: 0,
        team2_score: 0,
        winner: ''
    };

    const gameId = `${formattedDateForId}-${team1Id}-${team2Id}`;

    try {
        await setDoc(doc(db, `seasons/${currentSeasonId}/games`, gameId), gameData);
        gameModal.style.display = 'none';
        await loadSchedules();
    } catch (error) {
        console.error("Error saving game:", error);
        alert("Could not save game.");
    }
}

async function handleDeleteGame(e) {
    if (!e.target.matches('.btn-admin-delete')) return;
    const gameId = e.target.dataset.gameId;
    if (confirm("Are you sure you want to delete this game?")) {
        try {
            await deleteDoc(doc(db, `seasons/${currentSeasonId}/games`, gameId));
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

    document.querySelectorAll('#postseason-dates-grid input[type="date"]').forEach(input => {
        const [prefix, round, gameNum] = input.id.split('-');
        const roundName = round === 'Conf' ? 'Conf Finals' : round;
        if (dates[roundName] && input.value) {
            const [year, month, day] = input.value.split('-');
            dates[roundName].push(`${month}/${day}/${year}`);
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
