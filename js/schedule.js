// /js/schedule.js

import { generateLineupTable } from '../js/main.js';
import { db, getDoc, getDocs, collection, doc, query, where, onSnapshot } from '../js/firebase-init.js';

const USE_DEV_COLLECTIONS = true; // Set to false for production
const getCollectionName = (baseName) => USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;

let activeSeasonId = '';
let allTeams = [];
let allGamesCache = [];
let dailyScoresCache = [];
let allLineupsCache = [];
let historicalRecords = {};
let liveGamesCache = new Map();
let currentWeek = '1'; // This will be updated on page load

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
const escapeHTML = (str) => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');

/**
 * Checks if a given week is part of the postseason.
 * @param {string} week The week identifier (e.g., '15', 'Play-In', 'Round 1').
 * @returns {boolean} True if the week is a postseason week.
 */
const isPostseason = (week) => !/^\d+$/.test(week) && week !== "All-Star" && week !== "Relegation";

/**
 * [CORRECTED] Generates a descriptive label for postseason games based on their series name.
 * This version uses a map for more reliable matching.
 * @param {string} seriesName The full series name from the game document (e.g., "W1vW8 Game 1").
 * @returns {string} A formatted label for the game status line.
 */
function getPostseasonGameLabel(seriesName) {
    if (!seriesName) return seriesName;

    const gameNumberMatch = seriesName.match(/Game \d+$/);
    const gameNumberString = gameNumberMatch ? gameNumberMatch[0] : ''; // e.g., "Game 1"
    const baseSeriesId = seriesName.replace(/ Game \d+$/, '').trim();

    const seriesTypeMap = {
        'W7vW8': 'West Play-In Stage 1',
        'E7vE8': 'East Play-In Stage 1',
        'W9vW10': 'West Play-In Stage 1',
        'E9vE10': 'East Play-In Stage 1',
        'W8thSeedGame': 'West Play-In Stage 2',
        'E8thSeedGame': 'East Play-In Stage 2',
        'W1vW8': `West Round 1 ${gameNumberString}`,
        'W4vW5': `West Round 1 ${gameNumberString}`,
        'W3vW6': `West Round 1 ${gameNumberString}`,
        'W2vW7': `West Round 1 ${gameNumberString}`,
        'E1vE8': `East Round 1 ${gameNumberString}`,
        'E4vE5': `East Round 1 ${gameNumberString}`,
        'E3vE6': `East Round 1 ${gameNumberString}`,
        'E2vE7': `East Round 1 ${gameNumberString}`,
        'W-R2-T': `West Round 2 ${gameNumberString}`,
        'W-R2-B': `West Round 2 ${gameNumberString}`,
        'E-R2-T': `East Round 2 ${gameNumberString}`,
        'E-R2-B': `East Round 2 ${gameNumberString}`,
        'WCF': `WCF ${gameNumberString}`,
        'ECF': `ECF ${gameNumberString}`,
        'Finals': `RKL Finals ${gameNumberString}`,
    };

    const label = seriesTypeMap[baseSeriesId];

    return label ? label.trim() : seriesName; // Return the original name if no match is found
}


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
    
    const teamPromises = teamsSnapshot.docs.map(async (teamDoc) => {
        const teamData = { id: teamDoc.id, ...teamDoc.data() };
        const seasonalRecordRef = doc(db, teamsCollection, teamDoc.id, getCollectionName('seasonal_records'), seasonId);
        const seasonalRecordSnap = await getDoc(seasonalRecordRef);
        return seasonalRecordSnap.exists() ? { ...teamData, ...seasonalRecordSnap.data() } : null;
    });
    allTeams = (await Promise.all(teamPromises)).filter(t => t !== null);
    
    // Filter out the placeholder document from both collections
    allGamesCache = [
        ...gamesSnap.docs.filter(doc => doc.id !== 'placeholder').map(d => ({ id: d.id, ...d.data() })), 
        ...postGamesSnap.docs.filter(doc => doc.id !== 'placeholder').map(d => ({ id: d.id, ...d.data() }))
    ];
    dailyScoresCache = dailyScoresSnap.docs.map(d => d.data());
    allLineupsCache = [...lineupsSnap.docs.map(d => d.data()), ...postLineupsSnap.docs.map(d => d.data())];
}

// --- CORE LOGIC & RENDERING ---
function calculateHistoricalRecords() {
    const weekOrder = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', 'Play-In', 'Round 1', 'Round 2', 'Conf Finals', 'Finals'];
    const teamRecordsByWeek = {};

    allTeams.forEach(team => {
        teamRecordsByWeek[team.id] = { wins: 0, losses: 0 };
    });

    for (const week of weekOrder) {
        historicalRecords[week] = { ...Object.fromEntries(Object.entries(teamRecordsByWeek).map(([id, rec]) => [id, `${rec.wins}-${rec.losses}`])) };

        const gamesThisWeek = allGamesCache.filter(g => g.week === week && g.completed === 'TRUE');
        gamesThisWeek.forEach(game => {
            const winnerId = game.winner;
            const loserId = game.team1_id === winnerId ? game.team2_id : game.team1_id;

            if (teamRecordsByWeek[winnerId]) {
                teamRecordsByWeek[winnerId].wins++;
            }
            if (teamRecordsByWeek[loserId]) {
                teamRecordsByWeek[loserId].losses++;
            }
        });
    }
}

function determineInitialWeek() {
    const weekOrder = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', 'Play-In', 'Round 1', 'Round 2', 'Conf Finals', 'Finals'];
    const allKnownWeeks = [...new Set(allGamesCache.map(g => g.week))].sort((a, b) => weekOrder.indexOf(a) - weekOrder.indexOf(b));

    let targetWeek = null;

    for (const week of allKnownWeeks) {
        const weekGames = allGamesCache.filter(g => g.week === week);
        const hasIncompleteGame = weekGames.some(g => g.completed !== 'TRUE');
        if (hasIncompleteGame) {
            targetWeek = week;
            break;
        }
    }
    
    currentWeek = targetWeek || allKnownWeeks[allKnownWeeks.length - 1] || '1';
}

function listenForLiveGames() {
    const liveQuery = query(collection(db, getCollectionName('live_games')));
    onSnapshot(liveQuery, (snapshot) => {
        liveGamesCache.clear();
        snapshot.forEach(doc => {
            liveGamesCache.set(doc.id, doc.data());
        });
        displayWeek(currentWeek);
    });
}

/**
 * Hides postseason weeks where all games are TBD vs TBD.
 */
function setupWeekSelector() {
    const allKnownWeeks = [...new Set(allGamesCache.map(g => g.week))];
    const weekOrder = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', 'Play-In', 'Round 1', 'Round 2', 'Conf Finals', 'Finals'];
    allKnownWeeks.sort((a, b) => weekOrder.indexOf(a) - weekOrder.indexOf(b));

    // Filter out weeks that shouldn't be visible yet.
    const visibleWeeks = allKnownWeeks.filter(week => {
        if (!isPostseason(week)) return true; // Always show regular season weeks.
        const weekGames = allGamesCache.filter(g => g.week === week);
        // A week is visible if at least one game has at least one non-TBD team.
        return weekGames.some(g => g.team1_id !== 'TBD' || g.team2_id !== 'TBD');
    });

    const weekButtonsContainer = document.getElementById('week-buttons');
    weekButtonsContainer.innerHTML = visibleWeeks.map(week => {
        const weekGames = allGamesCache.filter(g => g.week === week);
        const isCompleted = weekGames.length > 0 && weekGames.every(g => g.completed === 'TRUE');
        return `<div class="week-btn ${isCompleted ? 'completed' : ''}" data-week="${week}">${isNaN(week) ? escapeHTML(week) : `Week ${escapeHTML(week)}`}</div>`;
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

/**
 * Handles all display logic for a given week, including postseason specifics.
 */
function displayWeek(week) {
    document.getElementById('games-title').textContent = `${isNaN(week) ? escapeHTML(week) : `Week ${escapeHTML(week)}`} Games`;
    const gamesContent = document.getElementById('games-content');
    const weekStandoutsSection = document.getElementById('week-standouts-section');
    
    const isWeekPostseason = isPostseason(week);

    // Filter games for the current week. For postseason, also filter out games that are fully TBD.
    let weekGames = allGamesCache.filter(g => g.week === week);
    if (isWeekPostseason) {
        weekGames = weekGames.filter(g => g.team1_id !== 'TBD' || g.team2_id !== 'TBD');
    }

    if (weekGames.length === 0) {
        gamesContent.innerHTML = '<div class="no-games">No games scheduled for this week.</div>';
        if (weekStandoutsSection) weekStandoutsSection.style.display = 'none';
        return;
    }

    if (weekStandoutsSection) {
        const allGamesInWeekCompleted = weekGames.every(g => g.completed === 'TRUE');
        if (allGamesInWeekCompleted && !isWeekPostseason) { // Standouts only for regular season
            calculateAndDisplayStandouts(week, weekGames);
            weekStandoutsSection.style.display = 'block';
        } else {
            weekStandoutsSection.style.display = 'none';
        }
    }
    
    const gamesByDate = weekGames.reduce((acc, game) => {
        (acc[game.date] = acc[game.date] || []).push(game);
        return acc;
    }, {});
    const sortedDates = Object.keys(gamesByDate).sort((a, b) => new Date(a.split('/').reverse().join('-')) - new Date(b.split('/').reverse().join('-')));

    gamesContent.innerHTML = sortedDates.map(date => {
        const dateGamesHTML = gamesByDate[date].map(game => {
            const team1 = getTeamById(game.team1_id);
            const team2 = getTeamById(game.team2_id);

            const liveGameData = liveGamesCache.get(game.id);
            const isLive = !!liveGameData;
            const isCompleted = game.completed === 'TRUE';

            let cardClass = 'upcoming';
            let statusText = 'Upcoming';
            let team1ScoreHTML = '';
            let team2ScoreHTML = '';

            // --- Postseason Overrides ---
            let team1NameHTML = escapeHTML(team1.team_name);
            let team2NameHTML = escapeHTML(team2.team_name);
            let team1Record, team2Record;

            if (isWeekPostseason) {
                // Requirement 1: Add seed to name
                if (game.team1_seed) team1NameHTML += ` (${game.team1_seed})`;
                if (game.team2_seed) team2NameHTML += ` (${game.team2_seed})`;

                // Requirement 2: Show series record
                team1Record = `${game.team1_wins || 0} - ${game.team2_wins || 0}`;
                team2Record = `${game.team2_wins || 0} - ${game.team1_wins || 0}`;
            } else {
                // Default regular season record
                team1Record = historicalRecords[week]?.[team1.id] || `${team1.wins || 0}-${team1.losses || 0}`;
                team2Record = historicalRecords[week]?.[team2.id] || `${team2.wins || 0}-${team2.losses || 0}`;
            }

            if (isLive) {
                cardClass = 'live';
                statusText = 'Live';
                const team1Total = liveGameData.team1_lineup.reduce((sum, p) => sum + (p.final_score || 0), 0);
                const team2Total = liveGameData.team2_lineup.reduce((sum, p) => sum + (p.final_score || 0), 0);
                team1ScoreHTML = `<div class="score-container"><div class="team-score">${formatInThousands(team1Total)}</div></div>`;
                team2ScoreHTML = `<div class="score-container"><div class="team-score">${formatInThousands(team2Total)}</div></div>`;
            } else if (isCompleted) {
                cardClass = 'completed';
                statusText = 'Final';
                const winnerId = game.winner;
                
                const team1Indicator = winnerId === team1.id ? '<span class="winner-indicator"></span>' : '';
                const team2Indicator = winnerId === team2.id ? '<span class="winner-indicator"></span>' : '';

                team1ScoreHTML = `<div class="score-container">${team1Indicator}<div class="team-score ${winnerId === team1.id ? 'winner' : ''}">${formatInThousands(game.team1_score)}</div></div>`;
                team2ScoreHTML = `<div class="score-container">${team2Indicator}<div class="team-score ${winnerId === team2.id ? 'winner' : ''}">${formatInThousands(game.team2_score)}</div></div>`;
                
                // Update regular season record post-game (this won't show for postseason)
                if (!isWeekPostseason) {
                    const preGameRecord1 = historicalRecords[week]?.[team1.id];
                    if (preGameRecord1) {
                        let [wins, losses] = preGameRecord1.split('-').map(Number);
                        game.winner === team1.id ? wins++ : losses++;
                        team1Record = `${wins}-${losses}`;
                    }
                    const preGameRecord2 = historicalRecords[week]?.[team2.id];
                    if (preGameRecord2) {
                        let [wins, losses] = preGameRecord2.split('-').map(Number);
                        game.winner === team2.id ? wins++ : losses++;
                        team2Record = `${wins}-${losses}`;
                    }
                }
            }
            
            // Requirement 4: Prepend label to status
            let statusPrefix = isWeekPostseason ? getPostseasonGameLabel(game.series_name) : '';
            const finalStatusText = statusPrefix ? `${statusPrefix} - ${statusText}` : statusText;
            const statusIndicator = isLive ? `<span class="live-indicator"></span>` : '';
            const statusHTML = `${statusIndicator}${finalStatusText}`;

            return `
                <div class="game-card ${cardClass}" data-game-id="${game.id}" data-is-live="${isLive}" data-date="${game.date}">
                    <div class="game-teams">
                        <div class="team ${isCompleted && game.winner === team1.id ? 'winner' : ''}">
                            <div class="team-left">
                                <img src="../icons/${team1.id}.webp" alt="${escapeHTML(team1.team_name)}" class="team-logo" onerror="this.style.display='none'">
                                <div class="team-info">
                                    <div class="team-name">${team1NameHTML}</div>
                                    <div class="team-record">${team1Record}</div>
                                </div>
                            </div>
                            ${team1ScoreHTML}
                        </div>
                        <div class="team ${isCompleted && game.winner === team2.id ? 'winner' : ''}">
                            <div class="team-left">
                                <img src="../icons/${team2.id}.webp" alt="${escapeHTML(team2.team_name)}" class="team-logo" onerror="this.style.display='none'">
                                <div class="team-info">
                                    <div class="team-name">${team2NameHTML}</div>
                                    <div class="team-record">${team2Record}</div>
                                </div>
                            </div>
                            ${team2ScoreHTML}
                        </div>
                    </div>
                    <div class="game-status ${cardClass}">${statusHTML}</div>
                </div>`;
        }).join('');
        return `<div class="date-section"><div class="date-header">${formatDate(date)}</div><div class="games-grid">${dateGamesHTML}</div></div>`;
    }).join('');

    document.querySelectorAll('.game-card.completed, .game-card.live').forEach(card => {
        card.addEventListener('click', () => {
            const isLive = card.dataset.isLive === 'true';
            showGameDetails(card.dataset.gameId, isLive, card.dataset.date);
        });
    });
}

function calculateAndDisplayStandouts(week, completedGamesThisWeek) {
    const standoutWeekEl = document.getElementById('standout-week-number');
    if (standoutWeekEl) standoutWeekEl.textContent = week;

    let bestTeam = { id: null, name: 'N/A', pct_diff: -Infinity, game: null };
    let worstTeam = { id: null, name: 'N/A', pct_diff: Infinity, game: null };
    
    completedGamesThisWeek.forEach(game => {
        const dailyScoreData = dailyScoresCache.find(ds => ds.date === game.date);
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

    const gameIdsInWeek = new Set(completedGamesThisWeek.map(g => g.id));
    const relevantLineups = allLineupsCache.filter(l => gameIdsInWeek.has(l.game_id) && l.started === 'TRUE' && l.global_rank > 0);

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
    
    const bestTeamEl = document.getElementById('best-team-perf');
    if (bestTeamEl) {
        if (bestTeam.id) {
            bestTeamEl.innerHTML = `<a href="team.html?id=${bestTeam.id}" class="team-link">${escapeHTML(bestTeam.name)}</a>: <a href="#" onclick="return false;" class="standout-metric-link"><span class="detail-positive">+${bestTeam.pct_diff.toFixed(1)}% vs median</span></a>`;
        } else { bestTeamEl.textContent = 'Not enough data.'; }
    }

    const worstTeamEl = document.getElementById('worst-team-perf');
    if (worstTeamEl) {
        if (worstTeam.id && worstTeam.pct_diff !== Infinity) {
           worstTeamEl.innerHTML = `<a href="team.html?id=${worstTeam.id}" class="team-link">${escapeHTML(worstTeam.name)}</a>: <a href="#" onclick="return false;" class="standout-metric-link"><span class="detail-negative">${worstTeam.pct_diff.toFixed(1)}% vs median</span></a>`;
        } else { worstTeamEl.textContent = 'No team significantly below median.'; }
    }

    const bestPlayerEl = document.getElementById('best-player-perf');
    if (bestPlayerEl) {
        if (bestPlayer.handle) {
           bestPlayerEl.innerHTML = `<a href="player.html?player=${encodeURIComponent(bestPlayer.handle)}" class="player-link">${escapeHTML(bestPlayer.handle)}</a>: <a href="#" onclick="return false;" class="standout-metric-link"><span class="detail-positive">Rank ${bestPlayer.rank}</span></a>`;
        } else { bestPlayerEl.textContent = 'No ranked player data.'; }
    }
    
    const worstPlayerEl = document.getElementById('worst-player-perf');
    if (worstPlayerEl) {
        if (worstPlayer.handle) {
            worstPlayerEl.innerHTML = `<a href="player.html?player=${encodeURIComponent(worstPlayer.handle)}" class="player-link">${escapeHTML(worstPlayer.handle)}</a>: <a href="#" onclick="return false;" class="standout-metric-link"><span class="detail-negative">Rank ${worstPlayer.rank.toLocaleString()}</span></a>`;
        } else { worstPlayerEl.textContent = 'No ranked player data.'; }
    }
}

async function showGameDetails(gameId, isLive, gameDate = null) {
    const modal = document.getElementById('game-modal');
    const modalTitle = document.getElementById('modal-title');
    const contentArea = document.getElementById('game-details-content-area');
    modal.style.display = 'block';
    contentArea.innerHTML = '<div class="loading">Loading game details...</div>';

    try {
        let gameData, team1Lineups, team2Lineups, team1, team2;
        const isGamePostseason = isPostseason(currentWeek);

        if (isLive) {
            const liveGameData = liveGamesCache.get(gameId);
            if (!liveGameData) throw new Error("Live game data not found in cache.");
            gameData = liveGameData;
            team1 = getTeamById(gameData.team1_lineup[0]?.team_id);
            team2 = getTeamById(gameData.team2_lineup[0]?.team_id);
            team1Lineups = gameData.team1_lineup || [];
            team2Lineups = gameData.team2_lineup || [];
            modalTitle.textContent = `${escapeHTML(team1.team_name)} vs ${escapeHTML(team2.team_name)} - Live`;
        } else {
            gameData = allGamesCache.find(g => g.id === gameId);
            if (!gameData) throw new Error("Game not found in cache.");
            
            const lineupsCollectionName = getCollectionName(isGamePostseason ? 'post_lineups' : 'lineups');
            const lineupsRef = collection(db, getCollectionName('seasons'), activeSeasonId, lineupsCollectionName);
            const lineupsQuery = query(lineupsRef, where('game_id', '==', gameId));
            
            const lineupsSnap = await getDocs(lineupsQuery);
            const allLineupsForGame = lineupsSnap.docs.map(d => d.data());

            team1 = getTeamById(gameData.team1_id);
            team2 = getTeamById(gameData.team2_id);
            team1Lineups = allLineupsForGame.filter(l => l.team_id === team1.id && l.started === "TRUE");
            team2Lineups = allLineupsForGame.filter(l => l.team_id === team2.id && l.started === "TRUE");
            modalTitle.textContent = `${escapeHTML(team1.team_name)} vs ${escapeHTML(team2.team_name)} - ${formatDateShort(gameDate)}`;
        }

        const winnerId = isLive ? null : gameData.winner;
        
        contentArea.innerHTML = `
            <div class="game-details-grid">
                ${generateLineupTable(team1Lineups, team1, !isLive && winnerId === team1.id)}
                ${generateLineupTable(team2Lineups, team2, !isLive && winnerId === team2.id)}
            </div>
        `;

    } catch (error) {
        console.error("Error showing game details:", error);
        contentArea.innerHTML = `<div class="error">Could not load details. ${error.message}</div>`;
    }
}

function closeModal() {
    document.getElementById('game-modal').style.display = 'none';
}

async function initializePage() {
    try {
        await getActiveSeason();
        await fetchAllData(activeSeasonId);

        calculateHistoricalRecords(); 
        determineInitialWeek();     
        
        // Defer DOM rendering to prevent race conditions
        setTimeout(() => {
            setupWeekSelector();
            displayWeek(currentWeek);
            
            // Attach modal listeners after the modal is in the DOM
            document.getElementById('close-modal-btn').addEventListener('click', closeModal);
            window.addEventListener('click', (event) => {
                if (event.target.id === 'game-modal') closeModal();
            });
        }, 0);

        listenForLiveGames();       

    } catch (error) {
        console.error("Failed to initialize page:", error);
        document.querySelector('main').innerHTML = `<div class="error">Could not load schedule data. ${error.message}</div>`;
    }
}

document.addEventListener('DOMContentLoaded', initializePage);
