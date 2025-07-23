// /admin/manage-games.js

import { auth, db, onAuthStateChanged, doc, getDoc, collection, query, where, getDocs, updateDoc } from '/js/firebase-init.js';

// --- Page Elements ---
const loadingContainer = document.getElementById('loading-container');
const adminContainer = document.getElementById('admin-container');
const authStatusDiv = document.getElementById('auth-status');
const seasonSelect = document.getElementById('season-select');
const weekSelect = document.getElementById('week-select');
const gamesListContainer = document.getElementById('games-list-container');
const scoreModal = document.getElementById('score-modal');
const closeModalBtn = scoreModal.querySelector('.close-btn-admin');
const scoreForm = document.getElementById('score-form');

let currentSeasonId = null;

// --- Primary Auth Check ---
document.addEventListener('DOMContentLoaded', () => {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            const userRef = doc(db, "users", user.uid);
            const userDoc = await getDoc(userRef);

            if (userDoc.exists() && userDoc.data().role === 'admin') {
                loadingContainer.style.display = 'none';
                adminContainer.style.display = 'block';
                authStatusDiv.innerHTML = `Welcome, Admin | <a href="#" id="logout-btn">Logout</a>`;
                addLogoutListener();
                initializePage();
            } else {
                loadingContainer.innerHTML = '<div class="error">Access Denied.</div>';
            }
        } else {
            window.location.href = '/login.html';
        }
    });
});

// --- Initialization and Data Fetching ---

async function initializePage() {
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
}

async function populateSeasons() {
    // In the future, this will query the 'seasons' collection.
    // For now, we'll hardcode S7 for development.
    seasonSelect.innerHTML = `<option value="S7">Season 7</option>`;
    currentSeasonId = "S7";
    await populateWeeks(currentSeasonId);
}

async function populateWeeks(seasonId) {
    // This will eventually be dynamic based on the season's schedule.
    // For now, hardcoding S7 regular season + postseason stages.
    let weekOptions = '';
    for (let i = 1; i <= 15; i++) {
        weekOptions += `<option value="Week ${i}">Week ${i}</option>`;
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

    // NOTE: This queries your existing 'schedule' collection for development.
    // This will be updated to query '/seasons/S7/games' in the final version.
    const gamesQuery = query(collection(db, "schedule"), where("week", "==", week));
    const teamsSnap = await getDocs(collection(db, "teams"));

    const teamsMap = new Map(teamsSnap.docs.map(doc => [doc.id, doc.data()]));

    try {
        const querySnapshot = await getDocs(gamesQuery);
        if (querySnapshot.empty) {
            gamesListContainer.innerHTML = '<p class="placeholder-text">No games found for this week.</p>';
            return;
        }

        let gamesHTML = '';
        querySnapshot.forEach(doc => {
            const game = { id: doc.id, ...doc.data() };
            const team1 = teamsMap.get(game.team1_id);
            const team2 = teamsMap.get(game.team2_id);

            gamesHTML += `
                <div class="game-entry">
                    <span class="game-teams">
                        <strong>${team1?.team_name || game.team1_id}</strong> vs <strong>${team2?.team_name || game.team2_id}</strong>
                    </span>
                    <span class="game-score">
                        ${game.completed === 'TRUE' ? `${game.team1_score} - ${game.team2_score}` : 'Pending'}
                    </span>
                    <button class="btn-admin-edit" data-game-id="${game.id}">Enter/Edit Score</button>
                </div>
            `;
        });
        gamesListContainer.innerHTML = gamesHTML;

    } catch (error) {
        console.error("Error fetching games: ", error);
        gamesListContainer.innerHTML = '<div class="error">Could not fetch games.</div>';
    }
}

// --- Event Handlers and Modal Logic ---

gamesListContainer.addEventListener('click', async (e) => {
    if (e.target.matches('.btn-admin-edit')) {
        const gameId = e.target.dataset.gameId;
        const gameRef = doc(db, "schedule", gameId);
        const gameDoc = await getDoc(gameRef);

        if (gameDoc.exists()) {
            openScoreModal(gameDoc.data(), gameId);
        }
    }
});

function openScoreModal(gameData, gameId) {
    document.getElementById('game-id-input').value = gameId;
    document.getElementById('team1-label').textContent = `${gameData.team1_id} Score`;
    document.getElementById('team2-label').textContent = `${gameData.team2_id} Score`;
    document.getElementById('team1-score').value = gameData.team1_score || '';
    document.getElementById('team2-score').value = gameData.team2_score || '';
    document.getElementById('game-completed-checkbox').checked = gameData.completed === 'TRUE';
    scoreModal.style.display = 'block';
}

closeModalBtn.addEventListener('click', () => {
    scoreModal.style.display = 'none';
});

scoreForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const gameId = document.getElementById('game-id-input').value;
    const team1Score = document.getElementById('team1-score').value;
    const team2Score = document.getElementById('team2-score').value;
    const isCompleted = document.getElementById('game-completed-checkbox').checked;

    const gameRef = doc(db, "schedule", gameId);

    try {
        await updateDoc(gameRef, {
            team1_score: Number(team1Score),
            team2_score: Number(team2Score),
            completed: isCompleted ? 'TRUE' : 'FALSE',
            winner: Number(team1Score) > Number(team2Score) ? (await getDoc(gameRef)).data().team1_id : (await getDoc(gameRef)).data().team2_id
        });
        alert('Scores updated successfully!');
        scoreModal.style.display = 'none';
        fetchAndDisplayGames(currentSeasonId, weekSelect.value); // Refresh list
    } catch (error) {
        console.error("Error updating document: ", error);
        alert('Failed to update scores.');
    }
});

function addLogoutListener() {
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            auth.signOut().then(() => { window.location.href = '/login.html'; });
        });
    }
}