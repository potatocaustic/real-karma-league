// /js/schedule.js

import { generateLineupTable } from '../js/main.js';
import { db, getDoc, getDocs, collection, doc, query, where, onSnapshot, collectionNames, getLeagueCollectionName } from '../js/firebase-init.js';

let activeSeasonId = '';
let allTeams = [];
let allGamesCache = [];
// Caches for lineups and scores are removed from global scope to enforce on-demand loading.
let historicalRecords = {};
let liveGamesCache = new Map();
let currentWeek = '1'; // This will be updated on page load
let selectedTeamId = 'all';
let liveScoringStatus = 'stopped'; // Tracks the live_scoring_status

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
 */
const isPostseason = (week) => !/^\d+$/.test(week) && week !== "All-Star" && week !== "Relegation";

/**
 * Generates a descriptive label for postseason games based on their series name.
 */
function getPostseasonGameLabel(seriesName) {
    if (!seriesName) return seriesName;

    const gameNumberMatch = seriesName.match(/Game \d+$/);
    const gameNumberString = gameNumberMatch ? gameNumberMatch[0] : '';
    const baseSeriesId = seriesName.replace(/ Game \d+$/, '').trim();

    // Updated map with dashes as requested
    const seriesTypeMap = {
        'W7vW8': 'West Play-In Stage 1',
        'E7vE8': 'East Play-In Stage 1',
        'W9vW10': 'West Play-In Stage 1',
        'E9vE10': 'East Play-In Stage 1',
        'W8thSeedGame': 'West Play-In Stage 2',
        'E8thSeedGame': 'East Play-In Stage 2',
        'W1vW8': `West Round 1 - ${gameNumberString}`,
        'W4vW5': `West Round 1 - ${gameNumberString}`,
        'W3vW6': `West Round 1 - ${gameNumberString}`,
        'W2vW7': `West Round 1 - ${gameNumberString}`,
        'E1vE8': `East Round 1 - ${gameNumberString}`,
        'E4vE5': `East Round 1 - ${gameNumberString}`,
        'E3vE6': `East Round 1 - ${gameNumberString}`,
        'E2vE7': `East Round 1 - ${gameNumberString}`,
        'W-R2-T': `West Round 2 - ${gameNumberString}`,
        'W-R2-B': `West Round 2 - ${gameNumberString}`,
        'E-R2-T': `East Round 2 - ${gameNumberString}`,
        'E-R2-B': `East Round 2 - ${gameNumberString}`,
        'WCF': `WCF ${gameNumberString}`,
        'ECF': `ECF ${gameNumberString}`,
        'Finals': `RKL Finals ${gameNumberString}`,
    };

    const label = seriesTypeMap[baseSeriesId];
    return label ? label.trim() : seriesName;
}

// --- DATA FETCHING ---
async function getActiveSeason() {
    const seasonsQuery = query(collection(db, collectionNames.seasons), where('status', '==', 'active'));
    const seasonsSnapshot = await getDocs(seasonsQuery);
    if (seasonsSnapshot.empty) throw new Error("No active season found.");
    activeSeasonId = seasonsSnapshot.docs[0].id;
}

async function fetchInitialPageData(seasonId) {
    const gamesRef = collection(db, collectionNames.seasons, seasonId, getLeagueCollectionName('games'));
    const postGamesRef = collection(db, collectionNames.seasons, seasonId, getLeagueCollectionName('post_games'));
    const exhibitionGamesRef = collection(db, collectionNames.seasons, seasonId, getLeagueCollectionName('exhibition_games'));

    const [teamsSnapshot, gamesSnap, postGamesSnap, exhibitionGamesSnap] = await Promise.all([
        getDocs(collection(db, collectionNames.teams)),
        getDocs(gamesRef),
        getDocs(postGamesRef),
        getDocs(exhibitionGamesRef),
    ]);

    const teamPromises = teamsSnapshot.docs.map(async (teamDoc) => {
        let teamData = { id: teamDoc.id, ...teamDoc.data(), wins: 0, losses: 0 }; // Start with base data and default record
        const seasonalRecordRef = doc(db, collectionNames.teams, teamDoc.id, collectionNames.seasonalRecords, seasonId);
        const seasonalRecordSnap = await getDoc(seasonalRecordRef);
        if (seasonalRecordSnap.exists()) {
            teamData = { ...teamData, ...seasonalRecordSnap.data() }; // Merge seasonal record if it exists
        }
        return teamData;
    });
    allTeams = await Promise.all(teamPromises);
    
    allGamesCache = [
        ...gamesSnap.docs.filter(doc => doc.id !== 'placeholder').map(d => ({ id: d.id, ...d.data() })), 
        ...postGamesSnap.docs.filter(doc => doc.id !== 'placeholder').map(d => ({ id: d.id, ...d.data() })),
        ...exhibitionGamesSnap.docs.filter(doc => doc.id !== 'placeholder').map(d => ({ id: d.id, ...d.data() }))
    ];
}

// --- CORE LOGIC & RENDERING ---
function calculateHistoricalRecords() {
    const weekOrder = ['1', '2', '3', '4', '5', '6', '7', '8', 'All-Star', '9', '10', '11', '12', '13', '14', '15', 'Play-In', 'Round 1', 'Round 2', 'Conf Finals', 'Finals', 'Relegation'];
    const teamRecordsByWeek = {};

    allTeams.forEach(team => {
        teamRecordsByWeek[team.id] = { wins: 0, losses: 0 };
    });

    for (const week of weekOrder) {
        historicalRecords[week] = { ...Object.fromEntries(Object.entries(teamRecordsByWeek).map(([id, rec]) => [id, `${rec.wins}-${rec.losses}`])) };
        
        if (!isNaN(week)) {
            const gamesThisWeek = allGamesCache.filter(g => g.week === week && g.completed === 'TRUE');
            gamesThisWeek.forEach(game => {
                const winnerId = game.winner;
                const loserId = game.team1_id === winnerId ? game.team2_id : game.team1_id;

                if (teamRecordsByWeek[winnerId]) teamRecordsByWeek[winnerId].wins++;
                if (teamRecordsByWeek[loserId]) teamRecordsByWeek[loserId].losses++;
            });
        }
    }
}

function determineInitialWeek() {
    const weekOrder = ['1', '2', '3', '4', '5', '6', '7', '8', 'All-Star', '9', '10', '11', '12', '13', '14', '15', 'Play-In', 'Round 1', 'Round 2', 'Conf Finals', 'Finals', 'Relegation'];
    const allKnownWeeks = [...new Set(allGamesCache.map(g => g.week))].sort((a, b) => weekOrder.indexOf(a) - weekOrder.indexOf(b));

    let targetWeek = null;
    for (const week of allKnownWeeks) {
        const weekGames = allGamesCache.filter(g => g.week === week);
        if (weekGames.some(g => g.completed !== 'TRUE')) {
            targetWeek = week;
            break;
        }
    }
    currentWeek = targetWeek || allKnownWeeks[allKnownWeeks.length - 1] || '1';
}

function listenForLiveGames() {
    const liveQuery = query(collection(db, collectionNames.liveGames));
    onSnapshot(liveQuery, (snapshot) => {
        const liveGamesChanged = snapshot.docChanges().length > 0;
        liveGamesCache.clear();
        snapshot.forEach(doc => liveGamesCache.set(doc.id, doc.data()));

        if (liveGamesChanged) {
            if (selectedTeamId === 'all') {
                displayWeek(currentWeek);
            } else {
                displayGamesForTeam(selectedTeamId);
            }
        }
    });
}

function listenForScoringStatus() {
    const statusRef = doc(db, getLeagueCollectionName('live_scoring_status'), 'status');
    onSnapshot(statusRef, (docSnap) => {
        const newStatus = docSnap.exists() ? docSnap.data().status : 'stopped';
        if (newStatus !== liveScoringStatus) {
            liveScoringStatus = newStatus;
            // A change in scoring status requires a re-render to show/hide live indicators
            if (selectedTeamId === 'all') {
                displayWeek(currentWeek);
            } else {
                displayGamesForTeam(selectedTeamId);
            }
        }
    });
}

function setupWeekSelector() {
    const allKnownWeeks = [...new Set(allGamesCache.map(g => g.week))];
    const weekOrder = ['1', '2', '3', '4', '5', '6', '7', '8', 'All-Star', '9', '10', '11', '12', '13', '14', '15', 'Play-In', 'Round 1', 'Round 2', 'Conf Finals', 'Finals', 'Relegation'];
    allKnownWeeks.sort((a, b) => weekOrder.indexOf(a) - weekOrder.indexOf(b));

    const visibleWeeks = allKnownWeeks.filter(week => {
        if (week === 'All-Star' || week === 'Relegation' || !isPostseason(week)) return true;
        const weekGames = allGamesCache.filter(g => g.week === week);
        return weekGames.some(g => g.team1_id !== 'TBD' || g.team2_id !== 'TBD');
    });

    const weekButtonsContainer = document.getElementById('week-buttons');
    const weekDropdown = document.getElementById('week-dropdown');

    weekButtonsContainer.innerHTML = visibleWeeks.map(week => {
        const weekGames = allGamesCache.filter(g => g.week === week);
        const isCompleted = weekGames.length > 0 && weekGames.every(g => g.completed === 'TRUE');
        const buttonText = week === 'Finals' ? `🏆 ${escapeHTML(week)}` : (isNaN(week) ? escapeHTML(week) : `Week ${escapeHTML(week)}`);
        return `<div class="week-btn ${isCompleted ? 'completed' : ''}" data-week="${week}">${buttonText}</div>`;
    }).join('');

    weekDropdown.innerHTML = visibleWeeks.map(week => {
        const weekGames = allGamesCache.filter(g => g.week === week);
        const isCompleted = weekGames.length > 0 && weekGames.every(g => g.completed === 'TRUE');
        const prefix = isCompleted ? '✓ ' : '';
        const optionText = week === 'Finals' ? `🏆 ${escapeHTML(week)}` : (isNaN(week) ? escapeHTML(week) : `Week ${escapeHTML(week)}`);
        return `<option value="${week}">${prefix}${optionText}</option>`;
    }).join('');

    const buttons = weekButtonsContainer.querySelectorAll('.week-btn');
    
    const setActiveWeek = async (week) => {
        const teamFilterDropdown = document.getElementById('team-filter-dropdown');
        if (selectedTeamId !== 'all') {
            teamFilterDropdown.value = 'all';
            selectedTeamId = 'all';
            document.querySelector('.week-selector').style.display = 'block';
        }

        currentWeek = week;
        
        buttons.forEach(b => b.classList.remove('active'));
        const activeButton = weekButtonsContainer.querySelector(`[data-week="${currentWeek}"]`);
        if (activeButton) activeButton.classList.add('active');
        weekDropdown.value = currentWeek;

        await displayWeek(currentWeek);
    };

    buttons.forEach(btn => btn.addEventListener('click', () => setActiveWeek(btn.dataset.week)));
    weekDropdown.addEventListener('change', () => setActiveWeek(weekDropdown.value));
    
    const initialButton = weekButtonsContainer.querySelector(`[data-week="${currentWeek}"]`);
    if (initialButton) initialButton.classList.add('active');
    weekDropdown.value = currentWeek;
}

function setupTeamFilter() {
    const teamFilterDropdown = document.getElementById('team-filter-dropdown');
    if (!teamFilterDropdown) return;

    const sortedTeams = [...allTeams].sort((a, b) => a.team_name.localeCompare(b.team_name));

    const teamOptions = sortedTeams
        .filter(team => team.conference)
        .map(team => `<option value="${team.id}">${escapeHTML(team.team_name)}</option>`)
        .join('');

    teamFilterDropdown.innerHTML = `<option value="all">All Teams</option>${teamOptions}`;

    teamFilterDropdown.addEventListener('change', () => {
        selectedTeamId = teamFilterDropdown.value;
        if (selectedTeamId === 'all') {
            document.querySelector('.week-selector').style.display = 'block';
            displayWeek(currentWeek);
        } else {
            document.querySelector('.week-selector').style.display = 'none';
            document.getElementById('week-standouts-section').style.display = 'none';
            displayGamesForTeam(selectedTeamId);
        }
    });
}

async function displayGamesForTeam(teamId) {
    const gamesTitle = document.getElementById('games-title');
    const gamesContent = document.getElementById('games-content');
    const team = getTeamById(teamId);

    gamesTitle.textContent = `Full Schedule for ${escapeHTML(team.team_name)}`;
    
    // Correctly sort games by date before processing
    const teamGames = allGamesCache
        .filter(g => g.team1_id === teamId || g.team2_id === teamId)
        .sort((a, b) => {
            const [aMonth, aDay, aYear] = a.date.split('/');
            const [bMonth, bDay, bYear] = b.date.split('/');
            return new Date(aYear, aMonth - 1, aDay) - new Date(bYear, bMonth - 1, bDay);
        });

    if (teamGames.length === 0) {
        gamesContent.innerHTML = `<div class="no-games">No games found for ${escapeHTML(team.team_name)}.</div>`;
        return;
    }

    const gamesByDate = teamGames.reduce((acc, game) => {
        (acc[game.date] = acc[game.date] || []).push(game);
        return acc;
    }, {});
    
    // Correctly sort the date keys for rendering
    const sortedDates = Object.keys(gamesByDate).sort((a, b) => {
        const [aMonth, aDay, aYear] = a.split('/');
        const [bMonth, bDay, bYear] = b.split('/');
        return new Date(aYear, aMonth - 1, aDay) - new Date(bYear, bMonth - 1, bDay);
    });

    gamesContent.innerHTML = sortedDates.map(date => {
        const dateGamesHTML = gamesByDate[date].map(game => {
            const team1 = getTeamById(game.team1_id);
            const team2 = getTeamById(game.team2_id);
            const isLive = liveScoringStatus === 'active' && liveGamesCache.has(game.id);
            const isCompleted = game.completed === 'TRUE';
            let cardClass = 'upcoming', statusText = 'Upcoming', team1ScoreHTML = '', team2ScoreHTML = '';
            let team1NameHTML = escapeHTML(team1.team_name), team2NameHTML = escapeHTML(team2.team_name);
            let team1Record, team2Record;
            const isWeekPostseason = isPostseason(game.week);

            if (isWeekPostseason) {
                if (game.team1_seed) team1NameHTML += ` (${game.team1_seed})`;
                if (game.team2_seed) team2NameHTML += ` (${game.team2_seed})`;
                team1Record = `${game.team1_wins || 0} - ${game.team2_wins || 0}`;
                team2Record = `${game.team2_wins || 0} - ${game.team1_wins || 0}`;
            } else {
                team1Record = `${team1.wins || 0}-${team1.losses || 0}`;
                team2Record = `${team2.wins || 0}-${team2.losses || 0}`;
            }

            if (isLive) {
                const liveGameData = liveGamesCache.get(game.id);
                cardClass = 'live'; statusText = 'Live';
                const team1Total = liveGameData.team1_lineup.reduce((sum, p) => sum + (p.final_score || 0), 0);
                const team2Total = liveGameData.team2_lineup.reduce((sum, p) => sum + (p.final_score || 0), 0);
                team1ScoreHTML = `<div class="score-container"><div class="team-score">${formatInThousands(team1Total)}</div></div>`;
                team2ScoreHTML = `<div class="score-container"><div class="team-score">${formatInThousands(team2Total)}</div></div>`;
            } else if (isCompleted) {
                cardClass = 'completed'; statusText = 'Final';
                const winnerId = game.winner;
                const t1Indicator = winnerId === team1.id ? '<span class="winner-indicator"></span>' : '', t2Indicator = winnerId === team2.id ? '<span class="winner-indicator"></span>' : '';
                team1ScoreHTML = `<div class="score-container">${t1Indicator}<div class="team-score ${winnerId === team1.id ? 'winner' : ''}">${formatInThousands(game.team1_score)}</div></div>`;
                team2ScoreHTML = `<div class="score-container">${t2Indicator}<div class="team-score ${winnerId === team2.id ? 'winner' : ''}">${formatInThousands(game.team2_score)}</div></div>`;
            }
            
            const statusPrefix = isWeekPostseason ? getPostseasonGameLabel(game.series_name) : `Week ${game.week}`;
            const finalStatusText = statusPrefix ? `${statusPrefix} - ${statusText}` : statusText;
            const statusIndicator = isLive ? `<span class="live-indicator"></span>` : '';
            const statusHTML = `${statusIndicator}${finalStatusText}`;

            const allStarTeamIds = ["EAST", "WEST", "EGM", "WGM", "RSE", "RSW"];
            const team1IconExt = team1.id && allStarTeamIds.includes(team1.id) ? 'png' : 'webp';
            const team2IconExt = team2.id && allStarTeamIds.includes(team2.id) ? 'png' : 'webp';

            return `<div class="game-card ${cardClass}" data-game-id="${game.id}" data-is-live="${isLive}" data-date="${game.date}"><div class="game-teams"><div class="team ${isCompleted && game.winner === team1.id ? 'winner' : ''}"><div class="team-left"><img src="../icons/${team1.id}.${team1IconExt}" alt="${escapeHTML(team1.team_name)}" class="team-logo" onerror="this.style.display='none'"><div class="team-info"><div class="team-name">${team1NameHTML}</div><div class="team-record">${team1Record}</div></div></div>${team1ScoreHTML}</div><div class="team ${isCompleted && game.winner === team2.id ? 'winner' : ''}"><div class="team-left"><img src="../icons/${team2.id}.${team2IconExt}" alt="${escapeHTML(team2.team_name)}" class="team-logo" onerror="this.style.display='none'"><div class="team-info"><div class="team-name">${team2NameHTML}</div><div class="team-record">${team2Record}</div></div></div>${team2ScoreHTML}</div></div><div class="game-status ${cardClass}">${statusHTML}</div></div>`;
        }).join('');
        
        const dateHeaderPrefix = ''; // No prefix in team view
        return `<div class="date-section"><div class="date-header">${dateHeaderPrefix}${formatDate(date)}</div><div class="games-grid">${dateGamesHTML}</div></div>`;
    }).join('');

    document.querySelectorAll('.game-card.completed, .game-card.live').forEach(card => {
        card.addEventListener('click', () => showGameDetails(card.dataset.gameId, card.dataset.isLive === 'true', card.dataset.date));
    });
}

async function displayWeek(week) {
    const gamesTitle = document.getElementById('games-title');
    if (week === 'Relegation') {
        gamesTitle.textContent = 'Relegation Game';
    } else {
        gamesTitle.textContent = `${week === 'Finals' ? '🏆 ' : ''}${isNaN(week) ? escapeHTML(week) : `Week ${escapeHTML(week)}`} Games`;
    }
    const gamesContent = document.getElementById('games-content');
    const weekStandoutsSection = document.getElementById('week-standouts-section');
    
    const isWeekPostseason = isPostseason(week);
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
        if (allGamesInWeekCompleted && !isWeekPostseason && week !== 'All-Star' && week !== 'Relegation') {
            await calculateAndDisplayStandouts(week);
            weekStandoutsSection.style.display = 'block';
        } else {
            weekStandoutsSection.style.display = 'none';
        }
    }
    
    const gamesByDate = weekGames.reduce((acc, game) => {
        (acc[game.date] = acc[game.date] || []).push(game);
        return acc;
    }, {});
    
    // Correctly sort the date keys for rendering
    const sortedDates = Object.keys(gamesByDate).sort((a, b) => {
        const [aMonth, aDay, aYear] = a.split('/');
        const [bMonth, bDay, bYear] = b.split('/');
        return new Date(aYear, aMonth - 1, aDay) - new Date(bYear, bMonth - 1, bDay);
    });

    gamesContent.innerHTML = sortedDates.map(date => {
        const dateGamesHTML = gamesByDate[date].map(game => {
            const team1 = getTeamById(game.team1_id);
            const team2 = getTeamById(game.team2_id);
            const isLive = liveScoringStatus === 'active' && liveGamesCache.has(game.id);
            const isCompleted = game.completed === 'TRUE';
            let cardClass = 'upcoming', statusText = 'Upcoming', team1ScoreHTML = '', team2ScoreHTML = '';
            let team1NameHTML = escapeHTML(team1.team_name), team2NameHTML = escapeHTML(team2.team_name);
            let team1Record, team2Record;

            if (isWeekPostseason) {
                if (game.team1_seed) team1NameHTML += ` (${game.team1_seed})`;
                if (game.team2_seed) team2NameHTML += ` (${game.team2_seed})`;
                team1Record = `${game.team1_wins || 0} - ${game.team2_wins || 0}`;
                team2Record = `${game.team2_wins || 0} - ${game.team1_wins || 0}`;
            } else {
                team1Record = historicalRecords[week]?.[team1.id] || `${team1.wins || 0}-${team1.losses || 0}`;
                team2Record = historicalRecords[week]?.[team2.id] || `${team2.wins || 0}-${team2.losses || 0}`;
            }

            if (isLive) {
                const liveGameData = liveGamesCache.get(game.id);
                cardClass = 'live'; statusText = 'Live';
                const team1Total = liveGameData.team1_lineup.reduce((sum, p) => sum + (p.final_score || 0), 0);
                const team2Total = liveGameData.team2_lineup.reduce((sum, p) => sum + (p.final_score || 0), 0);
                team1ScoreHTML = `<div class="score-container"><div class="team-score">${formatInThousands(team1Total)}</div></div>`;
                team2ScoreHTML = `<div class="score-container"><div class="team-score">${formatInThousands(team2Total)}</div></div>`;
            } else if (isCompleted) {
                cardClass = 'completed'; statusText = 'Final';
                const winnerId = game.winner;
                const t1Indicator = winnerId === team1.id ? '<span class="winner-indicator"></span>' : '', t2Indicator = winnerId === team2.id ? '<span class="winner-indicator"></span>' : '';
                team1ScoreHTML = `<div class="score-container">${t1Indicator}<div class="team-score ${winnerId === team1.id ? 'winner' : ''}">${formatInThousands(game.team1_score)}</div></div>`;
                team2ScoreHTML = `<div class="score-container">${t2Indicator}<div class="team-score ${winnerId === team2.id ? 'winner' : ''}">${formatInThousands(game.team2_score)}</div></div>`;
                if (!isWeekPostseason) {
                    const preRec1 = historicalRecords[week]?.[team1.id]; if (preRec1) { let [w, l] = preRec1.split('-').map(Number); game.winner === team1.id ? w++ : l++; team1Record = `${w}-${l}`; }
                    const preRec2 = historicalRecords[week]?.[team2.id]; if (preRec2) { let [w, l] = preRec2.split('-').map(Number); game.winner === team2.id ? w++ : l++; team2Record = `${w}-${l}`; }
                }
            }
            
            const statusPrefix = isWeekPostseason ? getPostseasonGameLabel(game.series_name) : '';
            const finalStatusText = statusPrefix ? `${statusPrefix} - ${statusText}` : statusText;
            const statusIndicator = isLive ? `<span class="live-indicator"></span>` : '';
            const statusHTML = `${statusIndicator}${finalStatusText}`;

            const allStarTeamIds = ["EAST", "WEST", "EGM", "WGM", "RSE", "RSW"];
            const team1IconExt = team1.id && allStarTeamIds.includes(team1.id) ? 'png' : 'webp';
            const team2IconExt = team2.id && allStarTeamIds.includes(team2.id) ? 'png' : 'webp';

            return `<div class="game-card ${cardClass}" data-game-id="${game.id}" data-is-live="${isLive}" data-date="${game.date}"><div class="game-teams"><div class="team ${isCompleted && game.winner === team1.id ? 'winner' : ''}"><div class="team-left"><img src="../icons/${team1.id}.${team1IconExt}" alt="${escapeHTML(team1.team_name)}" class="team-logo" onerror="this.style.display='none'"><div class="team-info"><div class="team-name">${team1NameHTML}</div><div class="team-record">${team1Record}</div></div></div>${team1ScoreHTML}</div><div class="team ${isCompleted && game.winner === team2.id ? 'winner' : ''}"><div class="team-left"><img src="../icons/${team2.id}.${team2IconExt}" alt="${escapeHTML(team2.team_name)}" class="team-logo" onerror="this.style.display='none'"><div class="team-info"><div class="team-name">${team2NameHTML}</div><div class="team-record">${team2Record}</div></div></div>${team2ScoreHTML}</div></div><div class="game-status ${cardClass}">${statusHTML}</div></div>`;
        }).join('');
        
        const dateHeaderPrefix = week === 'Finals' ? '🏆 ' : '';
        return `<div class="date-section"><div class="date-header">${dateHeaderPrefix}${formatDate(date)}</div><div class="games-grid">${dateGamesHTML}</div></div>`;
    }).join('');

    document.querySelectorAll('.game-card.completed, .game-card.live').forEach(card => {
        card.addEventListener('click', () => showGameDetails(card.dataset.gameId, card.dataset.isLive === 'true', card.dataset.date));
    });
}


async function calculateAndDisplayStandouts(week) {
    const standoutWeekEl = document.getElementById('standout-week-number');
    if (standoutWeekEl) standoutWeekEl.textContent = week;

    const seasonNum = activeSeasonId.replace('S', '');
    const dailyScoresRef = collection(db, getLeagueCollectionName('daily_scores'), `season_${seasonNum}`, `S${seasonNum}_daily_scores`);
    const lineupsRef = collection(db, collectionNames.seasons, activeSeasonId, getLeagueCollectionName('lineups'));
    const dailyScoresQuery = query(dailyScoresRef, where('week', '==', week));
    const lineupsQuery = query(lineupsRef, where('week', '==', week));
    const [dailyScoresSnap, lineupsSnap] = await Promise.all([getDocs(dailyScoresQuery), getDocs(lineupsQuery)]);
    const weeklyDailyScores = dailyScoresSnap.docs.map(d => d.data());
    const weeklyLineups = lineupsSnap.docs.map(d => d.data());
    const completedGamesThisWeek = allGamesCache.filter(g => g.week === week && g.completed === 'TRUE');

    let bestTeam = { id: null, name: 'N/A', pct_diff: -Infinity }, worstTeam = { id: null, name: 'N/A', pct_diff: Infinity };
    completedGamesThisWeek.forEach(game => {
        const dailyScoreData = weeklyDailyScores.find(ds => ds.date === game.date);
        if (!dailyScoreData || !dailyScoreData.daily_median) return;
        const processTeam = (teamId, teamScore) => {
            const pct_diff = ((teamScore / dailyScoreData.daily_median) - 1) * 100;
            if (pct_diff > bestTeam.pct_diff) bestTeam = { id: teamId, name: getTeamById(teamId).team_name, pct_diff };
            if (pct_diff < worstTeam.pct_diff) worstTeam = { id: teamId, name: getTeamById(teamId).team_name, pct_diff };
        };
        processTeam(game.team1_id, game.team1_score);
        processTeam(game.team2_id, game.team2_score);
    });

    let bestPlayer = { handle: null, rank: Infinity }, worstPlayer = { handle: null, rank: -Infinity };
    weeklyLineups.filter(l => l.started === 'TRUE' && l.global_rank > 0).forEach(lineup => {
        if (lineup.global_rank < bestPlayer.rank) bestPlayer = { handle: lineup.player_handle, rank: lineup.global_rank };
        if (lineup.global_rank > worstPlayer.rank) worstPlayer = { handle: lineup.player_handle, rank: lineup.global_rank };
    });
    
    const bestTeamEl = document.getElementById('best-team-perf');
    if (bestTeamEl) bestTeamEl.innerHTML = bestTeam.id ? `<a href="team.html?id=${bestTeam.id}" class="team-link">${escapeHTML(bestTeam.name)}</a>: <span class="detail-positive">+${bestTeam.pct_diff.toFixed(1)}% vs median</span>` : 'Not enough data.';
    const worstTeamEl = document.getElementById('worst-team-perf');
    if (worstTeamEl) worstTeamEl.innerHTML = worstTeam.id && worstTeam.pct_diff !== Infinity ? `<a href="team.html?id=${worstTeam.id}" class="team-link">${escapeHTML(worstTeam.name)}</a>: <span class="detail-negative">${worstTeam.pct_diff.toFixed(1)}% vs median</span>` : 'No team significantly below median.';
    const bestPlayerEl = document.getElementById('best-player-perf');
    if (bestPlayerEl) bestPlayerEl.innerHTML = bestPlayer.handle ? `<a href="player.html?handle=${encodeURIComponent(bestPlayer.handle)}" class="player-link">${escapeHTML(bestPlayer.handle)}</a>: <span class="detail-positive">Rank ${bestPlayer.rank}</span>` : 'No ranked player data.';
    const worstPlayerEl = document.getElementById('worst-player-perf');
    if (worstPlayerEl) worstPlayerEl.innerHTML = worstPlayer.handle ? `<a href="player.html?handle=${encodeURIComponent(worstPlayer.handle)}" class="player-link">${escapeHTML(worstPlayer.handle)}</a>: <span class="detail-negative">Rank ${worstPlayer.rank.toLocaleString()}</span>` : 'No ranked player data.';
}

async function showGameDetails(gameId, isLive, gameDate = null) {
    const modal = document.getElementById('game-modal');
    const modalTitle = document.getElementById('modal-title');
    const contentArea = document.getElementById('game-details-content-area');
    modal.style.display = 'block';
    contentArea.innerHTML = '<div class="loading">Loading game details...</div>';

    try {
        let gameData, team1Lineups, team2Lineups, team1, team2;
        
        gameData = allGamesCache.find(g => g.id === gameId);
        if (!gameData) throw new Error("Game not found in cache.");
        const isGamePostseason = isPostseason(gameData.week);

        let titleTeam1Name = '';
        let titleTeam2Name = '';

        const allPlayerIdsInGame = [];

        if (isLive) {
            const liveGameData = liveGamesCache.get(gameId);
            if (liveGameData) {
                liveGameData.team1_lineup.forEach(p => allPlayerIdsInGame.push(p.player_id));
                liveGameData.team2_lineup.forEach(p => allPlayerIdsInGame.push(p.player_id));
            }
        } else {
            const lineupsCollectionName = isGamePostseason ? getLeagueCollectionName('post_lineups') : getLeagueCollectionName('lineups');
            const lineupsRef = collection(db, collectionNames.seasons, activeSeasonId, lineupsCollectionName);
            const lineupsQuery = query(lineupsRef, where('game_id', '==', gameId));
            const lineupsSnap = await getDocs(lineupsQuery);
            lineupsSnap.forEach(doc => allPlayerIdsInGame.push(doc.data().player_id));
        }

        const uniquePlayerIds = [...new Set(allPlayerIdsInGame)];
        const playerStatsPromises = uniquePlayerIds.map(playerId =>
            getDoc(doc(db, collectionNames.players, playerId, collectionNames.seasonalStats, activeSeasonId))
        );
        const playerStatsDocs = await Promise.all(playerStatsPromises);
        
        const playerSeasonalStats = new Map();
        playerStatsDocs.forEach((docSnap, index) => {
            if (docSnap.exists()) {
                playerSeasonalStats.set(uniquePlayerIds[index], docSnap.data());
            }
        });
        // ===================================================================
        // END OF BUG FIX
        // ===================================================================

        if (isLive) {
            const liveGameData = liveGamesCache.get(gameId);
            if (!liveGameData) throw new Error("Live game data not found in cache.");
            
            team1 = getTeamById(gameData.team1_id);
            team2 = getTeamById(gameData.team2_id);
            // Add seasonal stats to each player in the lineup
            team1Lineups = liveGameData.team1_lineup.map(p => ({ ...p, ...playerSeasonalStats.get(p.player_id) }));
            team2Lineups = liveGameData.team2_lineup.map(p => ({ ...p, ...playerSeasonalStats.get(p.player_id) }));
            
            titleTeam1Name = escapeHTML(team1.team_name);
            titleTeam2Name = escapeHTML(team2.team_name);

            if (isGamePostseason) {
                if (gameData.team1_seed) titleTeam1Name = `(${gameData.team1_seed}) ${titleTeam1Name}`;
                if (gameData.team2_seed) titleTeam2Name = `(${gameData.team2_seed}) ${titleTeam2Name}`;
            }
            modalTitle.textContent = `${titleTeam1Name} vs ${titleTeam2Name} - Live`;

        } else {
            const isExhibition = gameData.week === 'All-Star' || gameData.week === 'Relegation';
            let lineupsCollectionName;
            if (isExhibition) {
                lineupsCollectionName = getLeagueCollectionName('exhibition_lineups');
            } else if (isGamePostseason) {
                lineupsCollectionName = getLeagueCollectionName('post_lineups');
            } else {
                lineupsCollectionName = getLeagueCollectionName('lineups');
            }
            const lineupsRef = collection(db, collectionNames.seasons, activeSeasonId, lineupsCollectionName);
            const lineupsQuery = query(lineupsRef, where('game_id', '==', gameId));
            
            const lineupsSnap = await getDocs(lineupsQuery);
            const allLineupsForGame = lineupsSnap.docs.map(d => {
                const lineupData = d.data();
                // Add seasonal stats to each player in the lineup
                return { ...lineupData, ...playerSeasonalStats.get(lineupData.player_id) };
            });

            team1 = getTeamById(gameData.team1_id);
            team2 = getTeamById(gameData.team2_id);
            team1Lineups = allLineupsForGame.filter(l => l.team_id === team1.id && l.started === "TRUE");
            team2Lineups = allLineupsForGame.filter(l => l.team_id === team2.id && l.started === "TRUE");

            titleTeam1Name = escapeHTML(team1.team_name);
            titleTeam2Name = escapeHTML(team2.team_name);
            if (isGamePostseason) {
                if (gameData.team1_seed) titleTeam1Name = `(${gameData.team1_seed}) ${titleTeam1Name}`;
                if (gameData.team2_seed) titleTeam2Name = `(${gameData.team2_seed}) ${titleTeam2Name}`;
            }
            modalTitle.textContent = `${titleTeam1Name} vs ${titleTeam2Name} - ${formatDateShort(gameDate)}`;
        }

        let modalTeam1 = { ...team1 };
        let modalTeam2 = { ...team2 };

        if (isGamePostseason) {
            modalTeam1.wins = gameData.team1_wins || 0;
            modalTeam1.losses = gameData.team2_wins || 0;
            modalTeam2.wins = gameData.team2_wins || 0;
            modalTeam2.losses = gameData.team1_wins || 0;
            modalTeam1.seed = gameData.team1_seed;
            modalTeam2.seed = gameData.team2_seed;
        }

        const winnerId = isLive ? null : gameData.winner;
        contentArea.innerHTML = `<div class="game-details-grid">${generateLineupTable(team1Lineups, modalTeam1, !isLive && winnerId === team1.id, isLive)}${generateLineupTable(team2Lineups, modalTeam2, !isLive && winnerId === team2.id, isLive)}</div>`;
        
        if (isLive) {
            const teamTotalElements = contentArea.querySelectorAll('.team-total');
            teamTotalElements.forEach(el => {
                el.innerHTML = `<span class="live-indicator-text"></span> ${el.innerHTML}`;
            });
        }

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
        await fetchInitialPageData(activeSeasonId);
        calculateHistoricalRecords(); 
        determineInitialWeek();     
        
        setTimeout(async () => {
            setupWeekSelector();
            setupTeamFilter();
            await displayWeek(currentWeek);
            document.getElementById('close-modal-btn').addEventListener('click', closeModal);
            window.addEventListener('click', (event) => {
                if (event.target.id === 'game-modal') closeModal();
            });
        }, 0);

        listenForLiveGames();
        listenForScoringStatus(); // Add this line
    } catch (error) {
        console.error("Failed to initialize page:", error);
        document.querySelector('main').innerHTML = `<div class="error">Could not load schedule data. ${error.message}</div>`;
    }
}

document.addEventListener('DOMContentLoaded', initializePage);

// Reload schedule when league changes
window.addEventListener('leagueChanged', (event) => {
    const newLeague = event.detail.league;
    console.log('League changed to:', newLeague);
    initializePage();
});
