// /admin/manage-lottery.js

import { auth, db, onAuthStateChanged, doc, getDoc, collection, getDocs, setDoc } from '/js/firebase-init.js';

// --- Page Elements ---
const loadingContainer = document.getElementById('loading-container');
const adminContainer = document.getElementById('admin-container');
const seasonSelect = document.getElementById('season-select');
const preLotteryList = document.getElementById('pre-lottery-list');
const finalLotteryList = document.getElementById('final-lottery-list');
const saveBtn = document.getElementById('save-lottery-btn');

// --- Global Data Cache ---
let allTeams = [];
let lotteryTeams = [];
let currentSeasonId = 'S7'; // Represents the season that was just completed
let draftSeason = 'S8'; // Represents the upcoming draft

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
        // For now, we'll hardcode the season selection
        seasonSelect.innerHTML = `<option value="S8">Season 8 Draft</option>`;

        await loadLotteryTeams();
        await loadExistingResults();
        setupDragAndDrop();

        saveBtn.addEventListener('click', saveLotteryResults);

        loadingContainer.style.display = 'none';
        adminContainer.style.display = 'block';
    } catch (error) {
        console.error("Error initializing lottery management page:", error);
        adminContainer.innerHTML = `<div class="error">Could not load required data.</div>`;
    }
}

async function loadLotteryTeams() {
    const [teamsSnap, postGamesSnap] = await Promise.all([
        getDocs(collection(db, "v2_teams")),
        getDocs(collection(db, `seasons/${currentSeasonId}/post_games`))
    ]);

    const teamRecordsPromises = teamsSnap.docs.map(async teamDoc => {
        const recordRef = doc(db, `v2_teams/${teamDoc.id}/seasonal_records/${currentSeasonId}`);
        // CORRECTED: Used getDoc(recordRef) instead of recordRef.get()
        const recordSnap = await getDoc(recordRef);
        return { id: teamDoc.id, ...teamDoc.data(), ...(recordSnap.exists() ? recordSnap.data() : {}) };
    });

    allTeams = await Promise.all(teamRecordsPromises);

    // Determine Playoff teams (top 6 + play-in winners)
    const playoffTeams = new Set();
    const eastPlayoffTeams = allTeams.filter(t => t.conference === 'Eastern' && t.postseed <= 6).map(t => t.id);
    const westPlayoffTeams = allTeams.filter(t => t.conference === 'Western' && t.postseed <= 6).map(t => t.id);
    eastPlayoffTeams.forEach(id => playoffTeams.add(id));
    westPlayoffTeams.forEach(id => playoffTeams.add(id));

    // Crude play-in winner logic for seeding, assuming 7/8 seeds win their first game and the final game.
    // A more robust solution would parse all play-in games.
    const east7th = allTeams.find(t => t.conference === 'Eastern' && t.postseed === 7);
    const west7th = allTeams.find(t => t.conference === 'Western' && t.postseed === 7);
    const east8th = allTeams.find(t => t.conference === 'Eastern' && t.postseed === 8);
    const west8th = allTeams.find(t => t.conference === 'Western' && t.postseed === 8);

    if (east7th) playoffTeams.add(east7th.id);
    if (west7th) playoffTeams.add(west7th.id);
    if (east8th) playoffTeams.add(east8th.id);
    if (west8th) playoffTeams.add(west8th.id);


    const nonPlayoffTeams = allTeams.filter(t => t.conference && !playoffTeams.has(t.id));

    lotteryTeams = nonPlayoffTeams.sort((a, b) => {
        const winPctA = a.wpct || 0;
        const winPctB = b.wpct || 0;
        if (winPctA !== winPctB) return winPctA - winPctB;
        return (a.pam || 0) - (b.pam || 0);
    }).slice(0, 14);

    renderLists(lotteryTeams);
}

function renderLists(teams) {
    preLotteryList.innerHTML = teams.map((team, index) =>
        `<li class="team-item"><span class="rank-number">${index + 1}.</span> ${team.team_name}</li>`
    ).join('');

    finalLotteryList.innerHTML = teams.map((team, index) =>
        `<li class="team-item" draggable="true" data-team-id="${team.id}">
            <span class="rank-number">${index + 1}.</span>
            <span>${team.team_name}</span>
        </li>`
    ).join('');
}

async function loadExistingResults() {
    const resultsRef = doc(db, `lottery_results/${draftSeason}_lottery_results`);
    const resultsSnap = await getDoc(resultsRef);

    if (resultsSnap.exists()) {
        const { final_order } = resultsSnap.data();
        const orderedTeams = final_order.map(teamId => lotteryTeams.find(t => t.id === teamId));
        renderLists(orderedTeams); // Re-render lists in the saved order
    }
}

function setupDragAndDrop() {
    let draggedItem = null;

    finalLotteryList.addEventListener('dragstart', e => {
        draggedItem = e.target;
        setTimeout(() => e.target.classList.add('dragging'), 0);
    });

    finalLotteryList.addEventListener('dragend', e => {
        setTimeout(() => {
            draggedItem.classList.remove('dragging');
            draggedItem = null;
            updateRanks();
        }, 0);
    });

    finalLotteryList.addEventListener('dragover', e => {
        e.preventDefault();
        const afterElement = getDragAfterElement(finalLotteryList, e.clientY);
        if (afterElement == null) {
            finalLotteryList.appendChild(draggedItem);
        } else {
            finalLotteryList.insertBefore(draggedItem, afterElement);
        }
    });
}

function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.team-item:not(.dragging)')];
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

function updateRanks() {
    const items = finalLotteryList.querySelectorAll('.team-item');
    items.forEach((item, index) => {
        item.querySelector('.rank-number').textContent = `${index + 1}.`;
    });
}

async function saveLotteryResults() {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    const finalOrderIds = [...finalLotteryList.querySelectorAll('.team-item')].map(item => item.dataset.teamId);

    if (finalOrderIds.length !== 14) {
        alert("Error: The final lottery order must contain exactly 14 teams.");
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Final Lottery Order';
        return;
    }

    try {
        const resultsRef = doc(db, `lottery_results/${draftSeason}_lottery_results`);
        await setDoc(resultsRef, {
            season: draftSeason,
            final_order: finalOrderIds,
            savedAt: new Date()
        });
        alert('Lottery results saved successfully!');
    } catch (error) {
        console.error("Error saving lottery results:", error);
        alert('An error occurred while saving. Please check the console.');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Final Lottery Order';
    }
}
