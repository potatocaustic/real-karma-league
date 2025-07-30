// /admin/manage-schedule.js

import { auth, db, functions, onAuthStateChanged, doc, getDoc, collection, getDocs, writeBatch, deleteDoc, addDoc, httpsCallable } from '/js/firebase-init.js';

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

let allTeams = [];
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
        generatePostseasonBtn.addEventListener('click', handleGeneratePostseason);
        regularSeasonContainer.addEventListener('click', handleDeleteGame);


        loadingContainer.style.display = 'none';
        adminContainer.style.display = 'block';
    } catch (error) {
        console.error("Error initializing schedule manager:", error);
    }
}

function populatePostseasonDates() {
    const rounds = ['Play-In', 'Round 1', 'Round 2', 'Conf Finals', 'Finals'];
    postseasonDatesContainer.innerHTML = rounds.map(round => `
        <div class="form-group-admin">
            <label for="date-${round.replace(' ', '-')}">${round} Dates</label>
            <input type="text" id="date-${round.replace(' ', '-')}" placeholder="e.g., 4/15/2025, 4/17/2025">
        </div>
    `).join('');
}

async function loadSchedules() {
    // Load Regular Season
    const gamesRef = collection(db, `seasons/${currentSeasonId}/games`);
    const gamesSnap = await getDocs(gamesRef);
    renderSchedule(regularSeasonContainer, gamesSnap.docs);

    // Load Postseason
    const postGamesRef = collection(db, `seasons/${currentSeasonId}/post_games`);
    const postGamesSnap = await getDocs(postGamesRef);
    renderSchedule(postseasonContainer, postGamesSnap.docs, false);
}

function renderSchedule(container, gameDocs, allowDelete = true) {
    if (gameDocs.empty) {
        container.innerHTML = '<p>No games scheduled.</p>';
        return;
    }

    const gamesByWeek = {};
    gameDocs.forEach(doc => {
        const game = { id: doc.id, ...doc.data() };
        if (!gamesByWeek[game.week]) {
            gamesByWeek[game.week] = [];
        }
        gamesByWeek[game.week].push(game);
    });

    let tableHTML = '';
    for (const week in gamesByWeek) {
        tableHTML += `<h4>${isNaN(week) ? week : `Week ${week}`}</h4>`;
        tableHTML += '<table class="schedule-table">';
        gamesByWeek[week].forEach(game => {
            const team1 = allTeams.find(t => t.id === game.team1_id)?.team_name || 'TBD';
            const team2 = allTeams.find(t => t.id === game.team2_id)?.team_name || 'TBD';
            tableHTML += `
                <tr>
                    <td>${game.date}</td>
                    <td>${team1} vs ${team2}</td>
                    ${allowDelete ? `<td><button class="btn-admin-delete" data-game-id="${game.id}">Delete</button></td>` : ''}
                </tr>
            `;
        });
        tableHTML += '</table>';
    }
    container.innerHTML = tableHTML;
}

function openGameModal() {
    gameForm.reset();
    const teamOptions = allTeams.map(t => `<option value="${t.id}">${t.team_name}</option>`).join('');
    document.getElementById('team1-select').innerHTML = teamOptions;
    document.getElementById('team2-select').innerHTML = teamOptions;
    gameModal.style.display = 'flex';
}

async function handleSaveGame(e) {
    e.preventDefault();
    const gameData = {
        date: document.getElementById('game-date').value,
        week: document.getElementById('game-week').value,
        team1_id: document.getElementById('team1-select').value,
        team2_id: document.getElementById('team2-select').value,
        completed: 'FALSE',
        team1_score: 0,
        team2_score: 0,
        winner: ''
    };

    try {
        await addDoc(collection(db, `seasons/${currentSeasonId}/games`), gameData);
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
        'Play-In': document.getElementById('date-Play-In').value,
        'Round 1': document.getElementById('date-Round-1').value,
        'Round 2': document.getElementById('date-Round-2').value,
        'Conf Finals': document.getElementById('date-Conf-Finals').value,
        'Finals': document.getElementById('date-Finals').value,
    };

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
