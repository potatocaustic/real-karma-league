// /js/schedule.js

import { db, getDoc, getDocs, collection, doc, query, where, onSnapshot } from '../js/firebase-init.js';

const USE_DEV_COLLECTIONS = true; // Set to false for production
const getCollectionName = (baseName) => USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;

let activeSeasonId = '';
let allTeams = [];
let allGamesCache = [];
let dailyScoresCache = []; // ADDED: Cache for daily score data
let allLineupsCache = []; // ADDED: Cache for all lineup data
let liveGamesUnsubscribe = null;
let currentWeek = '1';

// --- UTILITY FUNCTIONS ---
const formatInThousands = (value) => {
    const num = parseFloat(value);
    if (isNaN(num)) return '0';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
    return Math.round(num).toLocaleString();
};
const formatDate = (dateString) => {
    if (!dateString || dateString.toUpperCase() === 'TBD') return 'TBD';
    const [month, day, year] = dateString.split('/');
    const date = new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T00:00:00Z`);
    if (isNaN(date.getTime())) return 'Invalid Date';
    return date.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
};
const formatDateShort = (dateString) => {
    if (!dateString) return 'N/A';
    if (dateString.toUpperCase() === 'TBD') return 'TBD';
    const [month, day, year] = dateString.split('/');
    return `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${String(year).slice(-2)}`;
};
const getTeamById = (teamId) => allTeams.find(t => t.id === teamId) || { team_name: teamId, id: teamId };
const escapeHTML = (str) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');


// --- DATA FETCHING ---
async function getActiveSeason() {
    const seasonsQuery = query(collection(db, getCollectionName('seasons')), where('status', '==', 'active'));
    const seasonsSnapshot = await getDocs(seasonsQuery);
    if (seasonsSnapshot.empty) throw new Error("No active season found.");
    activeSeasonId = seasonsSnapshot.docs[0].id;
}

async function fetchAllData(seasonId) {
    const teamsCollection = getCollectionName('v2_teams');
    const gamesRef = collection(db, getCollectionName('seasons'), seasonId, getCollectionName('games'));
    const postGamesRef = collection(db, getCollectionName('seasons'), seasonId, getCollectionName('post_games'));
    const dailyScoresRef = collection(db, getCollectionName('daily_scores'), `season_${seasonId.replace('S','')}`, getCollectionName(`S${seasonId.replace('S','')}_daily_scores`));
    const lineupsRef = collection(db, getCollectionName('seasons'), seasonId, getCollectionName('lineups'));
    const postLineupsRef = collection(db, getCollectionName('seasons'), seasonId, getCollectionName('post_lineups'));

    const [teamsSnapshot, gamesSnap, postGamesSnap, dailyScoresSnap, lineupsSnap, postLineupsSnap] = await Promise.all([
        getDocs(collection(db, teamsCollection)),
        getDocs(gamesRef),
        getDocs(postGamesRef),
        getDocs(dailyScoresRef),
        getDocs(lineupsRef),
        getDocs(postLineupsRef),
    ]);
    
    // Process Teams
    const teamPromises = teamsSnapshot.docs.map(async (teamDoc) => {
        const teamData = { id: teamDoc.id, ...teamDoc.data() };
        const seasonalRecordRef = doc(db, teamsCollection, teamDoc.id, getCollectionName('seasonal_records'), seasonId);
        const seasonalRecordSnap = await getDoc(seasonalRecordRef);
        return seasonalRecordSnap.exists() ? { ...teamData, ...seasonalRecordSnap.data() } : null;
    });
    allTeams = (await Promise.all(teamPromises)).filter(t => t !== null);
    
    // Process Games, Scores, and Lineups
    allGamesCache = [...gamesSnap.docs.map(d => ({ id: d.id, ...d.data() })), ...postGamesSnap.docs.map(d => ({ id: d.id, ...d.data() }))];
    dailyScoresCache = dailyScoresSnap.docs.map(d => d.data());
    allLineupsCache = [...lineupsSnap.docs.map(d => d.data()), ...postLineupsSnap.docs.map(d => d.data())];
}


// --- CORE LOGIC & RENDERING ---

function initializeGamesSection() {
    const statusRef = doc(db, getCollectionName('live_scoring_status'), 'status');
    onSnapshot(statusRef, (statusSnap) => {
        if (liveGamesUnsubscribe) liveGamesUnsubscribe();
        const status = statusSnap.exists() ? statusSnap.data().status : 'stopped';
        const liveContainer = document.getElementById('live-games-container');
        liveContainer.style.display = (status === 'active' || status === 'paused') ? 'block' : 'none';
        if (liveContainer.style.display === 'block') loadLiveGames();
    });
}

function loadLiveGames() {
    const liveGamesList = document.getElementById('live-games-list');
    const liveQuery = query(collection(db, getCollectionName('live_games')));
    liveGamesUnsubscribe = onSnapshot(liveQuery, (snapshot) => {
        if (snapshot.empty) {
            liveGamesList.innerHTML = '<div class="no-games">No live games are currently active.</div>';
            return;
        }
        liveGamesList.innerHTML = snapshot.docs.map(doc => {
            const game = doc.data();
            const team1 = getTeamById(game.team1_lineup[0]?.team_id);
            const team2 = getTeamById(game.team2_lineup[0]?.team_id);
            const team1Total = game.team1_lineup.reduce((sum, p) => sum + (p.final_score || 0), 0);
            const team2Total = game.team2_lineup.reduce((sum, p) => sum + (p.final_score || 0), 0);
            return `<div class="game-item" data-game-id="${doc.id}" data-is-live="true">...</div>`; // Abridged for brevity
        }).join('');
        document.querySelectorAll('.game-item[data-is-live="true"]').forEach(item => {
            item.addEventListener('click', () => showGameDetails(item.dataset.gameId, true));
        });
    });
}

function setupWeekSelector() {
    const allWeeks = [...new Set(allGamesCache.map(g => g.week))];
    const weekOrder = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', 'Play-In', 'Round 1', 'Round 2', 'Conf Finals', 'Finals'];
    allWeeks.sort((a, b) => weekOrder.indexOf(a) - weekOrder.indexOf(b));

    const weekButtonsContainer = document.getElementById('week-buttons');
    weekButtonsContainer.innerHTML = allWeeks.map(week => {
        const weekGames = allGamesCache.filter(g => g.week === week);
        const isCompleted = weekGames.length > 0 && weekGames.every(g => g.completed === 'TRUE');
        return `<div class="week-btn ${isCompleted ? 'completed' : ''}" data-week="${week}">${isNaN(week) ? week : `Week ${week}`}</div>`;
    }).join('');

    const buttons = weekButtonsContainer.querySelectorAll('.week-btn');
    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            currentWeek = btn.dataset.week;
            buttons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            displayWeek(currentWeek);
        });
    });
    
    const initialButton = weekButtonsContainer.querySelector(`[data-week="${currentWeek}"]`);
    if (initialButton) initialButton.classList.add('active');
}

function displayWeek(week) {
    document.getElementById('games-title').textContent = `${isNaN(week) ? week : `Week ${week}`} Games`;
    const gamesContent = document.getElementById('games-content');
    const weekStandoutsSection = document.getElementById('week-standouts-section');
    
    const weekGames = allGamesCache.filter(g => g.week === week);
    if (weekGames.length === 0) {
        gamesContent.innerHTML = '<div class="no-games">No games scheduled.</div>';
        weekStandoutsSection.style.display = 'none';
        return;
    }

    const allGamesInWeekCompleted = weekGames.every(g => g.completed === 'TRUE');
    if (allGamesInWeekCompleted && !isNaN(week)) {
        calculateAndDisplayStandouts(week, weekGames);
        weekStandoutsSection.style.display = 'block';
    } else {
        weekStandoutsSection.style.display = 'none';
    }
    
    const gamesByDate = weekGames.reduce((acc, game) => {
        (acc[game.date] = acc[game.date] || []).push(game);
        return acc;
    }, {});
    
    const sortedDates = Object.keys(gamesByDate).sort((a, b) => new Date(a) - new Date(b));

    gamesContent.innerHTML = sortedDates.map(date => {
        const dateGamesHTML = gamesByDate[date].map(game => {
            const team1 = getTeamById(game.team1_id);
            const team2 = getTeamById(game.team2_id);
            return `<div class="game-card ${game.completed === 'TRUE' ? 'completed' : 'upcoming'}" data-game-id="${game.id}" data-date="${game.date}">...</div>`; // Abridged
        }).join('');
        return `<div class="date-section"><div class="date-header">${formatDate(date)}</div><div class="games-grid">${dateGamesHTML}</div></div>`;
    }).join('');

    document.querySelectorAll('.game-card[data-game-id]').forEach(card => {
        if (card.classList.contains('completed')) {
            card.addEventListener('click', () => showGameDetails(card.dataset.gameId, false, card.dataset.date));
        }
    });
}

// --- ADDED: STANDOUTS CALCULATION ---
function calculateAndDisplayStandouts(week, completedGamesThisWeek) {
    document.getElementById('standout-week-number').textContent = week;

    let bestTeam = { id: null, name: 'N/A', pct_diff: -Infinity, game: null };
    let worstTeam = { id: null, name: 'N/A', pct_diff: Infinity, game: null };
    
    completedGamesThisWeek.forEach(game => {
        const dailyScoreData = dailyScoresCache.find(ds => ds.date === game.date && (ds.team_id === game.team1_id || ds.team_id === game.team2_id));
        if (!dailyScoreData || !dailyScoreData.daily_median) return;

        const processTeam = (teamId, teamScore) => {
            const pct_diff = ((teamScore / dailyScoreData.daily_median) - 1) * 100;
            if (pct_diff > bestTeam.pct_diff) {
                bestTeam = { id: teamId, name: getTeamById(teamId).team_name, pct_diff, game };
            }
            if (pct_diff < worstTeam.pct_diff) {
                worstTeam = { id: teamId, name: getTeamById(teamId).team_name, pct_diff, game };
            }
        };
        processTeam(game.team1_id, game.team1_score);
        processTeam(game.team2_id, game.team2_score);
    });

    let bestPlayer = { handle: null, rank: Infinity, game: null };
    let worstPlayer = { handle: null, rank: -Infinity, game: null };

    const gameDatesInWeek = [...new Set(completedGamesThisWeek.map(g => g.date))];
    const relevantLineups = allLineupsCache.filter(l => gameDatesInWeek.includes(l.date) && l.started === 'TRUE' && l.global_rank > 0);

    relevantLineups.forEach(lineup => {
        const rank = lineup.global_rank;
        const game = allGamesCache.find(g => g.id === lineup.game_id);
        if (rank < bestPlayer.rank) {
            bestPlayer = { handle: lineup.player_handle, rank, game };
        }
        if (rank > worstPlayer.rank) {
            worstPlayer = { handle: lineup.player_handle, rank, game };
        }
    });
    
    // Render Standouts
    const bestTeamEl = document.getElementById('best-team-perf');
    if (bestTeam.id) {
        bestTeamEl.innerHTML = `<a href="team.html?id=${bestTeam.id}" class="team-link">${escapeHTML(bestTeam.name)}</a>: <a href="#" onclick="return false;" class="standout-metric-link"><span class="detail-positive">+${bestTeam.pct_diff.toFixed(1)}% vs median</span></a>`;
    } else { bestTeamEl.textContent = 'Not enough data.'; }

    const worstTeamEl = document.getElementById('worst-team-perf');
    if (worstTeam.id && worstTeam.pct_diff !== Infinity) {
       worstTeamEl.innerHTML = `<a href="team.html?id=${worstTeam.id}" class="team-link">${escapeHTML(worstTeam.name)}</a>: <a href="#" onclick="return false;" class="standout-metric-link"><span class="detail-negative">${worstTeam.pct_diff.toFixed(1)}% vs median</span></a>`;
    } else { worstTeamEl.textContent = 'No team significantly below median.'; }

    const bestPlayerEl = document.getElementById('best-player-perf');
    if (bestPlayer.handle) {
       bestPlayerEl.innerHTML = `<a href="player.html?player=${encodeURIComponent(bestPlayer.handle)}" class="player-link">${escapeHTML(bestPlayer.handle)}</a>: <a href="#" onclick="return false;" class="standout-metric-link"><span class="detail-positive">Rank ${bestPlayer.rank}</span></a>`;
    } else { bestPlayerEl.textContent = 'No ranked player data.'; }
    
    const worstPlayerEl = document.getElementById('worst-player-perf');
    if (worstPlayer.handle) {
        worstPlayerEl.innerHTML = `<a href="player.html?player=${encodeURIComponent(worstPlayer.handle)}" class="player-link">${escapeHTML(worstPlayer.handle)}</a>: <a href="#" onclick="return false;" class="standout-metric-link"><span class="detail-negative">Rank ${worstPlayer.rank.toLocaleString()}</span></a>`;
    } else { worstPlayerEl.textContent = 'No ranked player data.'; }
}

// Modal, initialization, etc. (Abridged for brevity)
async function showGameDetails(gameId, isLive, gameDate) { /* ... same as before ... */ }
function closeModal() { document.getElementById('game-modal').style.display = 'none'; }

async function initializePage() {
    try {
        await getActiveSeason();
        await fetchAllData(activeSeasonId);
        initializeGamesSection();
        setupWeekSelector();
        displayWeek(currentWeek);
        document.querySelector('#game-modal .close-btn').addEventListener('click', closeModal);
        window.addEventListener('click', (event) => {
            if (event.target == document.getElementById('game-modal')) closeModal();
        });
    } catch (error) {
        console.error("Failed to initialize page:", error);
        document.querySelector('main').innerHTML = `<div class="error">Could not load schedule data. ${error.message}</div>`;
    }
}

document.addEventListener('DOMContentLoaded', initializePage);