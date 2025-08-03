// /admin/manage-lottery.js

import { auth, db, onAuthStateChanged, doc, getDoc, collection, getDocs, setDoc, query, where } from '/js/firebase-init.js';

// --- DEV ENVIRONMENT CONFIG ---
const USE_DEV_COLLECTIONS = true;
const getCollectionName = (baseName) => USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;

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
let completedSeasonId = null;
let draftSeasonId = null;

document.addEventListener('DOMContentLoaded', () => {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            const userRef = doc(db, getCollectionName("users"), user.uid);
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
        await populateSeasons();
        seasonSelect.addEventListener('change', handleSeasonChange);
        setupDragAndDrop();
        saveBtn.addEventListener('click', saveLotteryResults);

        loadingContainer.style.display = 'none';
        adminContainer.style.display = 'block';
    } catch (error) {
        console.error("Error initializing lottery management page:", error);
        adminContainer.innerHTML = `<div class="error">Could not load required data.</div>`;
    }
}

async function populateSeasons() {
    const seasonsSnap = await getDocs(query(collection(db, getCollectionName("seasons"))));
    let completedSeason = null;
    const sortedDocs = seasonsSnap.docs.sort((a, b) => b.id.localeCompare(a.id));

    seasonSelect.innerHTML = sortedDocs.map(doc => {
        const seasonData = doc.data();
        if (seasonData.status === 'completed' && !completedSeason) {
            completedSeason = doc.id;
        }
        const seasonNum = parseInt(doc.id.replace('S', ''), 10);
        return `<option value="S${seasonNum + 1}">S${seasonNum + 1} Draft Lottery</option>`;
    }).join('');

    if (completedSeason) {
        const completedNum = parseInt(completedSeason.replace('S', ''), 10);
        seasonSelect.value = `S${completedNum + 1}`;
    }

    await handleSeasonChange();
}

async function handleSeasonChange() {
    draftSeasonId = seasonSelect.value;
    const draftNum = parseInt(draftSeasonId.replace('S', ''), 10);
    completedSeasonId = `S${draftNum - 1}`;

    await loadLotteryTeams();
    await loadExistingResults();
}

async function loadLotteryTeams() {
    preLotteryList.innerHTML = `<li class="loading">Loading teams...</li>`;
    finalLotteryList.innerHTML = '';

    const postGamesCollectionRef = collection(db, `${getCollectionName('seasons')}/${completedSeasonId}/${getCollectionName('post_games')}`);

    const [teamsSnap, postGamesSnap] = await Promise.all([
        getDocs(collection(db, getCollectionName("v2_teams"))),
        getDocs(query(postGamesCollectionRef, where("week", "==", "Play-In")))
    ]);

    const teamRecordsPromises = teamsSnap.docs
        .filter(doc => doc.data() && doc.data().conference)
        .map(async teamDoc => {
            const recordRef = doc(db, `${getCollectionName('v2_teams')}/${teamDoc.id}/${getCollectionName('seasonal_records')}/${completedSeasonId}`);
            const recordSnap = await getDoc(recordRef);
            const teamData = { id: teamDoc.id, ...teamDoc.data() };
            if (recordSnap.exists()) {
                return { ...teamData, ...recordSnap.data() };
            }
            return { ...teamData, wins: 0, losses: 0, postseed: 99, wpct: 0, pam: 0 };
        });

    allTeams = await Promise.all(teamRecordsPromises);

    const playoffTeams = new Set();
    allTeams.forEach(team => {
        if (team.postseed && team.postseed <= 6) {
            playoffTeams.add(team.id);
        }
    });

    const playInGames = postGamesSnap.docs.map(d => d.data());
    for (const conf of ['E', 'W']) {
        const game7v8 = playInGames.find(g => g.series_id === `${conf}-PI-7v8`);
        const finalPlayInGame = playInGames.find(g => g.series_id === `${conf}-PI-L78vW910`);

        if (game7v8 && game7v8.winner) {
            playoffTeams.add(game7v8.winner);
        }
        if (finalPlayInGame && finalPlayInGame.winner) {
            playoffTeams.add(finalPlayInGame.winner);
        }
    }

    const nonPlayoffTeams = allTeams.filter(t => !playoffTeams.has(t.id));

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
    const resultsRef = doc(db, getCollectionName('lottery_results'), `${draftSeasonId}_lottery_results`);
    const resultsSnap = await getDoc(resultsRef);

    if (resultsSnap.exists()) {
        const { final_order } = resultsSnap.data();
        const orderedTeams = final_order.map(teamId => allTeams.find(t => t.id === teamId)).filter(Boolean);

        if (orderedTeams.length === 14) {
            finalLotteryList.innerHTML = orderedTeams.map((team, index) =>
                `<li class="team-item" draggable="true" data-team-id="${team.id}">
                    <span class="rank-number">${index + 1}.</span>
                    <span>${team.team_name}</span>
                </li>`
            ).join('');
        }
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
            if (draggedItem) {
                draggedItem.classList.remove('dragging');
            }
            draggedItem = null;
            updateRanks();
        }, 0);
    });

    finalLotteryList.addEventListener('dragover', e => {
        e.preventDefault();
        const afterElement = getDragAfterElement(finalLotteryList, e.clientY);
        if (draggedItem) {
            if (afterElement == null) {
                finalLotteryList.appendChild(draggedItem);
            } else {
                finalLotteryList.insertBefore(draggedItem, afterElement);
            }
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
        const resultsRef = doc(db, getCollectionName('lottery_results'), `${draftSeasonId}_lottery_results`);
        await setDoc(resultsRef, {
            season: draftSeasonId,
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