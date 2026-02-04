// /js/schedule.js

import { generateLineupTable } from '../js/main.js';
import { db, getDoc, getDocs, collection, doc, query, where, onSnapshot, collectionNames, getLeagueCollectionName, getCurrentLeague } from '../js/firebase-init.js';
import { getSeasonIdFromPage } from './season-utils.js';

// Get season from page lock (data-season, path, or ?season)
const { seasonId: lockedSeasonId, isLocked: isSeasonLocked } = getSeasonIdFromPage();

let activeSeasonId = lockedSeasonId || '';
let allTeams = [];
let allGamesCache = [];
// Caches for lineups and scores are removed from global scope to enforce on-demand loading.
let historicalRecords = {};
let liveGamesCache = new Map();
let currentWeek = '1'; // This will be updated on page load
let selectedTeamId = 'all';
let liveScoringStatus = 'stopped'; // Tracks the live_scoring_status
let gameFlowChartInstance = null; // Tracks the Chart.js instance
let showLiveFeatures = true; // Controls visibility of live features
let currentGameFlowData = null;
let currentChartType = 'cumulative'; // 'cumulative' or 'differential'
let currentTeam1 = null;
let currentTeam2 = null;

// Listener unsubscribe functions for cleanup
let liveGamesUnsubscribe = null;
let statusUnsubscribe = null;

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
 * For minor leagues, converts East/West to North/South conference names.
 */
function getPostseasonGameLabel(seriesName) {
    if (!seriesName) return seriesName;

    const gameNumberMatch = seriesName.match(/Game \d+$/);
    const gameNumberString = gameNumberMatch ? gameNumberMatch[0] : '';
    const baseSeriesId = seriesName.replace(/ Game \d+$/, '').trim();

    const currentLeague = getCurrentLeague();
    const isMinor = currentLeague === 'minor';

    // Conference names differ by league: Major uses East/West, Minor uses North/South
    const westConf = isMinor ? 'South' : 'West';
    const eastConf = isMinor ? 'North' : 'East';
    const wcfLabel = isMinor ? 'SCF' : 'WCF';
    const ecfLabel = isMinor ? 'NCF' : 'ECF';
    const finalsLabel = isMinor ? 'RKML Finals' : 'RKL Finals';

    // Series keys use E/W internally, but display names use league-appropriate conference names
    const seriesTypeMap = {
        'W7vW8': `${westConf} Play-In Stage 1`,
        'E7vE8': `${eastConf} Play-In Stage 1`,
        'W9vW10': `${westConf} Play-In Stage 1`,
        'E9vE10': `${eastConf} Play-In Stage 1`,
        'W8thSeedGame': `${westConf} Play-In Stage 2`,
        'E8thSeedGame': `${eastConf} Play-In Stage 2`,
        'W1vW8': `${westConf} Round 1 - ${gameNumberString}`,
        'W4vW5': `${westConf} Round 1 - ${gameNumberString}`,
        'W3vW6': `${westConf} Round 1 - ${gameNumberString}`,
        'W2vW7': `${westConf} Round 1 - ${gameNumberString}`,
        'E1vE8': `${eastConf} Round 1 - ${gameNumberString}`,
        'E4vE5': `${eastConf} Round 1 - ${gameNumberString}`,
        'E3vE6': `${eastConf} Round 1 - ${gameNumberString}`,
        'E2vE7': `${eastConf} Round 1 - ${gameNumberString}`,
        'W-R2-T': `${westConf} Round 2 - ${gameNumberString}`,
        'W-R2-B': `${westConf} Round 2 - ${gameNumberString}`,
        'E-R2-T': `${eastConf} Round 2 - ${gameNumberString}`,
        'E-R2-B': `${eastConf} Round 2 - ${gameNumberString}`,
        'WCF': `${wcfLabel} ${gameNumberString}`,
        'ECF': `${ecfLabel} ${gameNumberString}`,
        'Finals': `${finalsLabel} ${gameNumberString}`,
    };

    const label = seriesTypeMap[baseSeriesId];
    return label ? label.trim() : seriesName;
}

// --- DATA FETCHING ---
async function getActiveSeason() {
    // If season is specified via URL parameter, skip querying for active season
    if (isSeasonLocked) {
        return; // activeSeasonId is already set from URL parameter
    }

    // Otherwise query for the active season
    const seasonsQuery = query(collection(db, collectionNames.seasons), where('status', '==', 'active'));
    const seasonsSnapshot = await getDocs(seasonsQuery);
    if (seasonsSnapshot.empty) throw new Error("No active season found.");
    activeSeasonId = seasonsSnapshot.docs[0].id;
}

async function fetchInitialPageData(seasonId) {
    const gamesRef = collection(db, collectionNames.seasons, seasonId, 'games');
    const postGamesRef = collection(db, collectionNames.seasons, seasonId, 'post_games');
    const exhibitionGamesRef = collection(db, collectionNames.seasons, seasonId, 'exhibition_games');

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
    // Clean up existing listener if any
    if (liveGamesUnsubscribe) {
        liveGamesUnsubscribe();
    }

    const liveQuery = query(collection(db, collectionNames.liveGames));
    liveGamesUnsubscribe = onSnapshot(liveQuery, (snapshot) => {
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
    // Clean up existing listener if any
    if (statusUnsubscribe) {
        statusUnsubscribe();
    }

    const statusRef = doc(db, getLeagueCollectionName('live_scoring_status'), 'status');
    statusUnsubscribe = onSnapshot(statusRef, (docSnap) => {
        const statusData = docSnap.exists() ? docSnap.data() : {};
        const newStatus = statusData.status || 'stopped';
        showLiveFeatures = statusData.show_live_features !== false; // Default to true if not set

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
    // Event delegation is handled by setupGameCardDelegation() - no per-element listeners needed
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
    // Event delegation is handled by setupGameCardDelegation() - no per-element listeners needed
}


async function calculateAndDisplayStandouts(week) {
    const standoutWeekEl = document.getElementById('standout-week-number');
    if (standoutWeekEl) standoutWeekEl.textContent = week;

    const seasonNum = activeSeasonId.replace('S', '');
    const currentLeague = getCurrentLeague();
    const leaguePrefix = currentLeague === 'minor' ? 'minor_' : '';
    const dailyScoresRef = collection(db, getLeagueCollectionName('daily_scores'), `season_${seasonNum}`, `${leaguePrefix}S${seasonNum}_daily_scores`);
    const lineupsRef = collection(db, collectionNames.seasons, activeSeasonId, 'lineups');
    const dailyScoresQuery = query(dailyScoresRef, where('week', '==', week));
    const lineupsQuery = query(lineupsRef, where('week', '==', week));
    const [dailyScoresSnap, lineupsSnap] = await Promise.all([getDocs(dailyScoresQuery), getDocs(lineupsQuery)]);
    const weeklyDailyScores = dailyScoresSnap.docs.map(d => d.data());
    const weeklyLineups = lineupsSnap.docs.map(d => d.data());
    const completedGamesThisWeek = allGamesCache.filter(g => g.week === week && g.completed === 'TRUE');

    // Index daily scores by date for O(1) lookups instead of O(n) find() in loop
    const dailyScoresByDate = new Map(weeklyDailyScores.map(ds => [ds.date, ds]));

    let bestTeam = { id: null, name: 'N/A', pct_diff: -Infinity }, worstTeam = { id: null, name: 'N/A', pct_diff: Infinity };
    completedGamesThisWeek.forEach(game => {
        const dailyScoreData = dailyScoresByDate.get(game.date);
        if (!dailyScoreData || !dailyScoreData.daily_median) return;
        const processTeam = (teamId, teamScore) => {
            const pct_diff = ((teamScore / dailyScoreData.daily_median) - 1) * 100;
            // getTeamById uses teamsCache Map internally, so already O(1)
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

// --- GAME FLOW CHART FUNCTIONS ---
async function fetchGameFlowData(gameId) {
    try {
        const flowRef = doc(db, getLeagueCollectionName('game_flow_snapshots'), gameId);
        const flowSnap = await getDoc(flowRef);

        if (flowSnap.exists()) {
            return flowSnap.data().snapshots || [];
        }
        return [];
    } catch (error) {
        console.error('Error fetching game flow data:', error);
        return [];
    }
}

async function renderGameFlowChart(snapshots, team1, team2) {
    const chartArea = document.getElementById('game-flow-chart-area');
    const canvas = document.getElementById('game-flow-chart');

    if (!canvas || !chartArea) {
        console.error('Chart elements not found');
        return;
    }

    // Store current data for toggling between chart types
    currentGameFlowData = snapshots;
    currentTeam1 = team1;
    currentTeam2 = team2;

    // Destroy existing chart if any
    if (gameFlowChartInstance) {
        gameFlowChartInstance.destroy();
        gameFlowChartInstance = null;
    }

    if (snapshots.length === 0) {
        chartArea.innerHTML = '<div class="loading" style="padding: 2rem; text-align: center;">No game flow data available for this matchup.</div>';
        return;
    }

    // Get team colors from logos
    const colors = await getTeamColors(team1, team2);

    // Render based on current chart type
    if (currentChartType === 'differential') {
        renderDifferentialChart(snapshots, team1, team2, colors);
        return;
    }

    // Remove team icons when rendering cumulative view
    const existingIcons = document.querySelectorAll('.chart-team-icon');
    existingIcons.forEach(icon => icon.remove());

    // Detect dark mode
    const isDarkMode = document.documentElement.classList.contains('dark-mode');
    const textColor = isDarkMode ? '#e0e0e0' : '#333';
    const gridColor = isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
    const tooltipBg = isDarkMode ? '#383838' : '#fff';
    const tooltipBorder = isDarkMode ? '#555' : '#ccc';

    // Sort snapshots by timestamp
    const sortedSnapshots = [...snapshots].sort((a, b) => a.timestamp.toMillis() - b.timestamp.toMillis());

    // Prepare data for Chart.js
    const labels = sortedSnapshots.map(s => {
        const date = s.timestamp.toDate();
        return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    });

    const team1Scores = sortedSnapshots.map(s => s.team1_score);
    const team2Scores = sortedSnapshots.map(s => s.team2_score);

    const ctx = canvas.getContext('2d');

    gameFlowChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: team1.team_name,
                data: team1Scores,
                borderColor: colors.team1,
                backgroundColor: colors.team1 + '1A',
                borderWidth: 3,
                tension: 0.1,
                pointRadius: 0,
                pointHoverRadius: 6,
                pointHoverBackgroundColor: colors.team1,
                pointHoverBorderColor: '#fff',
                pointHoverBorderWidth: 2
            }, {
                label: team2.team_name,
                data: team2Scores,
                borderColor: colors.team2,
                backgroundColor: colors.team2 + '1A',
                borderWidth: 3,
                tension: 0.1,
                pointRadius: 0,
                pointHoverRadius: 6,
                pointHoverBackgroundColor: colors.team2,
                pointHoverBorderColor: '#fff',
                pointHoverBorderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false
            },
            plugins: {
                title: {
                    display: false
                },
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        color: textColor,
                        font: { size: 14 }
                    }
                },
                tooltip: {
                    backgroundColor: tooltipBg,
                    titleColor: textColor,
                    bodyColor: textColor,
                    borderColor: tooltipBorder,
                    borderWidth: 1,
                    callbacks: {
                        label: function(context) {
                            return context.dataset.label + ': ' + Math.round(context.parsed.y).toLocaleString();
                        }
                    }
                }
            },
            scales: {
                x: {
                    title: {
                        display: true,
                        text: 'Time',
                        color: textColor
                    },
                    ticks: {
                        color: textColor
                    },
                    grid: {
                        color: gridColor
                    }
                },
                y: {
                    title: {
                        display: false
                    },
                    ticks: {
                        color: textColor
                    },
                    grid: {
                        color: gridColor
                    },
                    beginAtZero: true
                }
            }
        }
    });

    // Add stats display and toggle button
    addChartControls(sortedSnapshots, team1, team2, colors);
}

function toggleGameFlowChart() {
    const contentArea = document.getElementById('game-details-content-area');
    const chartArea = document.getElementById('game-flow-chart-area');
    const chartBtn = document.getElementById('game-flow-chart-btn');

    if (!contentArea || !chartArea || !chartBtn) return;

    if (contentArea.style.display === 'none') {
        // Switch back to traditional view
        contentArea.style.display = 'block';
        chartArea.style.display = 'none';
        chartBtn.classList.remove('active');

        // Track switch to traditional view
        if (typeof gtag !== 'undefined') {
            gtag('event', 'toggle_view', {
                event_category: 'Game Modal',
                event_label: 'Switched to traditional view',
                view_type: 'traditional'
            });
        }
    } else {
        // Switch to chart view
        contentArea.style.display = 'none';
        chartArea.style.display = 'block';
        chartBtn.classList.add('active');

        // Track switch to chart view
        if (typeof gtag !== 'undefined') {
            gtag('event', 'toggle_view', {
                event_category: 'Game Modal',
                event_label: 'Switched to chart view',
                view_type: 'chart'
            });
        }
    }
}

function renderDifferentialChart(snapshots, team1, team2, colors) {
    const canvas = document.getElementById('game-flow-chart');
    const chartArea = document.getElementById('game-flow-chart-area');
    if (!canvas || !chartArea) return;

    // Detect dark mode
    const isDarkMode = document.documentElement.classList.contains('dark-mode');
    const textColor = isDarkMode ? '#e0e0e0' : '#333';
    const gridColor = isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
    const tooltipBg = isDarkMode ? '#383838' : '#fff';
    const tooltipBorder = isDarkMode ? '#555' : '#ccc';

    // Sort snapshots by timestamp
    const sortedSnapshots = [...snapshots].sort((a, b) => a.timestamp.toMillis() - b.timestamp.toMillis());

    // Prepare data for Chart.js
    const labels = sortedSnapshots.map(s => {
        const date = s.timestamp.toDate();
        return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    });

    // Calculate differentials if not already present
    let rawDifferentials = sortedSnapshots.map(s =>
        s.differential !== undefined ? s.differential : (s.team1_score - s.team2_score)
    );

    // Interpolate zero-crossing points for smoother color transitions
    const interpolatedLabels = [];
    const interpolatedDifferentials = [];

    for (let i = 0; i < labels.length; i++) {
        interpolatedLabels.push(labels[i]);
        interpolatedDifferentials.push(rawDifferentials[i]);

        // Check if there's a zero crossing between this point and the next
        if (i < labels.length - 1) {
            const curr = rawDifferentials[i];
            const next = rawDifferentials[i + 1];

            // If signs differ (crossing zero), insert an interpolated zero point
            if ((curr > 0 && next < 0) || (curr < 0 && next > 0)) {
                // Calculate the position of the zero crossing
                const ratio = Math.abs(curr) / (Math.abs(curr) + Math.abs(next));

                // Create interpolated label (empty string for cleaner display)
                interpolatedLabels.push('');
                interpolatedDifferentials.push(0);
            }
        }
    }

    // Use interpolated data
    const differentials = interpolatedDifferentials;
    const finalLabels = interpolatedLabels;

    // Create colors based on which team is leading
    const hexToRgba = (hex, alpha) => {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };

    const backgroundColors = differentials.map(diff => {
        if (diff > 0) return hexToRgba(colors.team1, 0.3);
        if (diff < 0) return hexToRgba(colors.team2, 0.3);
        return 'rgba(128, 128, 128, 0.2)';
    });

    const borderColors = differentials.map(diff => {
        if (diff > 0) return colors.team1;
        if (diff < 0) return colors.team2;
        return '#888';
    });

    // Create multiple datasets, one for each segment with consistent lead
    // Each dataset spans all labels but has null for points outside its segment
    const datasets = [];
    const segments = []; // Track segment ranges: {start, end, leader}
    let currentLeader = null;
    let segmentStart = 0;

    for (let i = 0; i < differentials.length; i++) {
        const value = differentials[i];
        let leader;

        if (value > 0) {
            leader = 1;
        } else if (value < 0) {
            leader = -1;
        } else {  // value === 0 (tied game - interpolated or actual)
            // Look ahead to determine which team will be leading after the tie
            if (i < differentials.length - 1) {
                leader = differentials[i + 1] >= 0 ? 1 : -1;
            } else {
                // Last point is a tie - keep previous leader or default to team1
                leader = currentLeader || 1;
            }
        }

        // Detect leader change
        if (currentLeader !== null && leader !== currentLeader) {
            // Include the crossing point in previous segment (end at i+1)
            segments.push({ start: segmentStart, end: i + 1, leader: currentLeader });
            segmentStart = i;
        }
        currentLeader = leader;
    }
    // Add final segment
    segments.push({ start: segmentStart, end: differentials.length, leader: currentLeader });

    // Create a dataset for each segment
    segments.forEach(segment => {
        const segmentData = new Array(differentials.length).fill(null);

        // Fill in data for this segment's range
        for (let i = segment.start; i < segment.end; i++) {
            segmentData[i] = differentials[i];
        }

        const segmentColor = segment.leader === 1 ? colors.team1 : (segment.leader === -1 ? colors.team2 : '#888');

        datasets.push({
            label: 'Lead Margin',
            data: segmentData,
            borderColor: segmentColor,
            backgroundColor: hexToRgba(segmentColor, 0.3),
            borderWidth: 2,
            tension: 0.3,
            fill: true,
            pointRadius: 0,
            pointHoverRadius: function(context) {
                // Don't show hover dot for interpolated zeros (empty labels)
                return finalLabels[context.dataIndex] === '' && differentials[context.dataIndex] === 0 ? 0 : 6;
            },
            pointHoverBackgroundColor: segmentColor,
            pointHoverBorderColor: '#fff',
            pointHoverBorderWidth: 2,
            spanGaps: false
        });
    });

    const ctx = canvas.getContext('2d');

    gameFlowChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: finalLabels,
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                padding: {
                    bottom: 10
                }
            },
            interaction: {
                mode: 'index',
                intersect: false
            },
            plugins: {
                title: {
                    display: false
                },
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: tooltipBg,
                    titleColor: textColor,
                    bodyColor: textColor,
                    borderColor: tooltipBorder,
                    borderWidth: 1,
                    filter: function(tooltipItem) {
                        // Hide tooltip for interpolated zero points (empty labels)
                        return !(tooltipItem.parsed.y === 0 && finalLabels[tooltipItem.dataIndex] === '');
                    },
                    callbacks: {
                        label: function(context) {
                            const diff = context.parsed.y;
                            if (diff > 0) {
                                const verb = team1.team_name.endsWith('s') ? 'lead' : 'leads';
                                return `${team1.team_name} ${verb} by ${Math.round(Math.abs(diff)).toLocaleString()}`;
                            } else if (diff < 0) {
                                const verb = team2.team_name.endsWith('s') ? 'lead' : 'leads';
                                return `${team2.team_name} ${verb} by ${Math.round(Math.abs(diff)).toLocaleString()}`;
                            } else {
                                return 'Game tied';
                            }
                        }
                    }
                }
            },
            scales: {
                x: {
                    title: {
                        display: true,
                        text: 'Time',
                        color: textColor
                    },
                    ticks: {
                        display: false
                    },
                    grid: {
                        color: gridColor,
                        display: false
                    }
                },
                y: {
                    title: {
                        display: false
                    },
                    ticks: {
                        color: textColor,
                        callback: function(value) {
                            return Math.abs(value).toLocaleString();
                        }
                    },
                    grid: {
                        color: gridColor,
                        display: false,
                        lineWidth: function(context) {
                            return context.tick.value === 0 ? 2 : 1;
                        }
                    }
                }
            }
        }
    });

    // Add team icons to chart
    addTeamIconsToChart(chartArea, team1, team2, colors);

    // Add stats display and toggle button
    addChartControls(sortedSnapshots, team1, team2, colors);
}

function addChartControls(snapshots, team1, team2, colors) {
    // Remove existing controls if any
    const existingControls = document.getElementById('chart-controls');
    if (existingControls) {
        existingControls.remove();
    }

    const chartArea = document.getElementById('game-flow-chart-area');
    if (!chartArea) return;

    // Get stats with timestamps
    const stats = calculateGameStats(snapshots);

    // Detect dark mode
    const isDarkMode = document.documentElement.classList.contains('dark-mode');

    // Add title with toggle icon
    addChartTitle(chartArea, isDarkMode);

    // Create controls container
    const controlsDiv = document.createElement('div');
    controlsDiv.id = 'chart-controls';
    controlsDiv.style.cssText = `
        margin-top: 1rem;
        padding: 0.75rem 1rem;
        background-color: ${isDarkMode ? '#2c2c2c' : '#f8f9fa'};
        border-radius: 8px;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
    `;

    // Stats display
    const statsDiv = document.createElement('div');
    statsDiv.style.cssText = `
        display: flex;
        gap: 1.5rem;
        flex-wrap: wrap;
        color: ${isDarkMode ? '#e0e0e0' : '#333'};
        font-size: 0.9rem;
        line-height: 1.4;
    `;

    const formatTime = (timestamp) => {
        if (!timestamp) return '';
        const date = timestamp.toDate();
        return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    };

    statsDiv.innerHTML = `
        <div><strong>Lead Changes:</strong> ${stats.leadChanges}</div>
        <div><strong>${team1.team_name} Biggest Lead:</strong> ${Math.round(stats.team1BiggestLead).toLocaleString()} ${stats.team1BiggestLeadTime ? `(${formatTime(stats.team1BiggestLeadTime)})` : ''}</div>
        <div><strong>${team2.team_name} Biggest Lead:</strong> ${Math.round(stats.team2BiggestLead).toLocaleString()} ${stats.team2BiggestLeadTime ? `(${formatTime(stats.team2BiggestLeadTime)})` : ''}</div>
    `;

    controlsDiv.appendChild(statsDiv);
    chartArea.appendChild(controlsDiv);
}

function toggleChartType() {
    currentChartType = currentChartType === 'cumulative' ? 'differential' : 'cumulative';

    // Track chart type switch
    if (typeof gtag !== 'undefined') {
        gtag('event', 'chart_type_switch', {
            event_category: 'Game Modal',
            event_label: `Switched to ${currentChartType} view`,
            chart_type: currentChartType
        });
    }

    if (currentGameFlowData && currentTeam1 && currentTeam2) {
        renderGameFlowChart(currentGameFlowData, currentTeam1, currentTeam2);
    }
}

function calculateGameStats(snapshots) {
    let leadChanges = 0;
    let team1BiggestLead = 0;
    let team2BiggestLead = 0;
    let team1BiggestLeadTime = null;
    let team2BiggestLeadTime = null;
    let prevDifferential = null;

    for (const snapshot of snapshots) {
        const differential = snapshot.differential !== undefined ?
            snapshot.differential : (snapshot.team1_score - snapshot.team2_score);

        // Count lead changes
        if (prevDifferential !== null) {
            if ((prevDifferential > 0 && differential < 0) ||
                (prevDifferential < 0 && differential > 0) ||
                (prevDifferential === 0 && differential !== 0)) {
                leadChanges++;
            }
        }

        // Track biggest leads with timestamps
        if (differential > team1BiggestLead) {
            team1BiggestLead = differential;
            team1BiggestLeadTime = snapshot.timestamp;
        }
        if (differential < 0 && Math.abs(differential) > team2BiggestLead) {
            team2BiggestLead = Math.abs(differential);
            team2BiggestLeadTime = snapshot.timestamp;
        }

        prevDifferential = differential;
    }

    return {
        leadChanges,
        team1BiggestLead,
        team2BiggestLead,
        team1BiggestLeadTime,
        team2BiggestLeadTime
    };
}

async function getTeamColors(team1, team2) {
    // Check for color override first, then extract from logo, then fallback to defaults
    const team1Color = team1.color_override || await extractDominantColor(team1.id, team1.logo_ext) || '#007bff';
    const team2Color = team2.color_override || await extractDominantColor(team2.id, team2.logo_ext) || '#dc3545';

    return {
        team1: team1Color,
        team2: team2Color
    };
}

async function extractDominantColor(teamId, logoExt = 'webp') {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'Anonymous';
        img.src = `../icons/${teamId}.${logoExt}`;

        img.onload = function() {
            try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = img.width;
                canvas.height = img.height;
                ctx.drawImage(img, 0, 0);

                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const data = imageData.data;

                let r = 0, g = 0, b = 0, count = 0;

                // Sample every 4th pixel for efficiency
                for (let i = 0; i < data.length; i += 16) {
                    const alpha = data[i + 3];
                    const red = data[i];
                    const green = data[i + 1];
                    const blue = data[i + 2];

                    // Only count non-transparent pixels and skip very dark colors (likely background)
                    if (alpha > 128) {
                        const brightness = (red + green + blue) / 3;
                        // Skip if too dark (likely black background) unless it's a vibrant dark color
                        const isVibrant = Math.max(red, green, blue) - Math.min(red, green, blue) > 50;
                        if (brightness > 40 || isVibrant) {
                            r += red;
                            g += green;
                            b += blue;
                            count++;
                        }
                    }
                }

                if (count > 0) {
                    r = Math.floor(r / count);
                    g = Math.floor(g / count);
                    b = Math.floor(b / count);
                    const hex = '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
                    resolve(hex);
                } else {
                    resolve(null);
                }
            } catch (e) {
                console.warn('Error extracting color from logo:', e);
                resolve(null);
            }
        };

        img.onerror = function() {
            resolve(null);
        };
    });
}

function addChartTitle(chartArea, isDarkMode) {
    // Remove existing title if any
    const existingTitle = document.getElementById('chart-title-bar');
    if (existingTitle) {
        existingTitle.remove();
    }

    const titleBar = document.createElement('div');
    titleBar.id = 'chart-title-bar';
    titleBar.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.75rem;
        margin-bottom: 0.5rem;
        color: ${isDarkMode ? '#e0e0e0' : '#333'};
    `;

    const titleText = document.createElement('span');
    titleText.style.cssText = `
        font-size: 1.1rem;
        font-weight: 600;
    `;
    titleText.textContent = currentChartType === 'cumulative' ? 'Game Flow - Cumulative' : 'Game Flow - Lead Margin';

    const toggleIcon = document.createElement('button');
    toggleIcon.innerHTML = '&#8644;'; // Swap icon
    toggleIcon.title = 'Toggle chart view';
    toggleIcon.style.cssText = `
        background: none;
        border: 1px solid ${isDarkMode ? '#555' : '#ccc'};
        color: ${isDarkMode ? '#e0e0e0' : '#333'};
        cursor: pointer;
        padding: 0.25rem 0.5rem;
        border-radius: 4px;
        font-size: 1.2rem;
        transition: all 0.3s;
    `;
    toggleIcon.onmouseover = () => {
        toggleIcon.style.backgroundColor = isDarkMode ? '#444' : '#e9ecef';
    };
    toggleIcon.onmouseout = () => {
        toggleIcon.style.backgroundColor = 'transparent';
    };
    toggleIcon.onclick = () => toggleChartType();

    titleBar.appendChild(titleText);
    titleBar.appendChild(toggleIcon);

    // Insert before the canvas
    const canvas = document.getElementById('game-flow-chart');
    if (canvas) {
        chartArea.insertBefore(titleBar, canvas);
    } else {
        chartArea.insertBefore(titleBar, chartArea.firstChild);
    }
}

function addTeamIconsToChart(chartArea, team1, team2, colors) {
    // Remove existing icons if any
    const existingIcons = document.querySelectorAll('.chart-team-icon');
    existingIcons.forEach(icon => icon.remove());

    const createTeamIcon = (team, position) => {
        const iconDiv = document.createElement('div');
        iconDiv.className = 'chart-team-icon';
        const topPosition = currentChartType === 'differential' ? '40px' : '80px';
        iconDiv.style.cssText = `
            position: absolute;
            ${position === 'top' ? `top: ${topPosition};` : 'bottom: 20px;'}
            left: 60px;
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.25rem;
            background: transparent;
            z-index: 10;
        `;

        const img = document.createElement('img');
        const logoExt = team.logo_ext || 'webp';
        img.src = `../icons/${team.id}.${logoExt}`;
        img.alt = team.team_name;
        img.style.cssText = `
            width: 32px;
            height: 32px;
            border-radius: 50%;
            object-fit: cover;
            box-shadow: 0 2px 4px rgba(0,0,0,0.2);
        `;
        img.onerror = function() { this.style.display = 'none'; };

        iconDiv.appendChild(img);
        return iconDiv;
    };

    chartArea.style.position = 'relative';
    chartArea.appendChild(createTeamIcon(team1, 'top'));
    chartArea.appendChild(createTeamIcon(team2, 'bottom'));
}

// Event delegation flag to prevent duplicate listeners
let gameCardDelegationSetup = false;

/**
 * Sets up event delegation for game cards on the games-content container.
 * This is more efficient than attaching listeners to each card after every render.
 * Only sets up once per page load.
 */
function setupGameCardDelegation() {
    if (gameCardDelegationSetup) return;

    const gamesContent = document.getElementById('games-content');
    if (!gamesContent) return;

    gamesContent.addEventListener('click', (event) => {
        // Find the closest game-card ancestor
        const card = event.target.closest('.game-card.completed, .game-card.live');
        if (card) {
            const gameId = card.dataset.gameId;
            const isLive = card.dataset.isLive === 'true';
            const date = card.dataset.date;
            showGameDetails(gameId, isLive, date);
        }
    });

    gameCardDelegationSetup = true;
}

async function showGameDetails(gameId, isLive, gameDate = null) {
    const modal = document.getElementById('game-modal');
    const modalTitle = document.getElementById('modal-title');
    const contentArea = document.getElementById('game-details-content-area');

    // Clean up existing chart and reset state
    if (gameFlowChartInstance) {
        gameFlowChartInstance.destroy();
        gameFlowChartInstance = null;
    }
    currentChartType = 'cumulative'; // Reset to default view
    currentGameFlowData = null;
    currentTeam1 = null;
    currentTeam2 = null;

    // Clean up chart UI elements
    const existingTitle = document.getElementById('chart-title-bar');
    if (existingTitle) existingTitle.remove();
    const existingControls = document.getElementById('chart-controls');
    if (existingControls) existingControls.remove();
    const existingIcons = document.querySelectorAll('.chart-team-icon');
    existingIcons.forEach(icon => icon.remove());

    modal.style.display = 'block';
    contentArea.innerHTML = '<div class="loading">Loading game details...</div>';

    // Track modal open event
    if (typeof gtag !== 'undefined') {
        gtag('event', 'modal_open', {
            event_category: 'Game Modal',
            event_label: `Game ID: ${gameId}`,
            game_id: gameId,
            is_live: isLive
        });
    }

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
            const lineupsCollectionName = isGamePostseason ? 'post_lineups' : 'lineups';
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
            const isExhibition = gameData.week === 'All-Star' || gameData.week === 'Relegation' || gameData.week === 'Preseason';
            let lineupsCollectionName;
            if (isExhibition) {
                lineupsCollectionName = 'exhibition_lineups';
            } else if (isGamePostseason) {
                lineupsCollectionName = 'post_lineups';
            } else {
                lineupsCollectionName = 'lineups';
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

        // Fetch and prepare game flow chart (if admin allows and data exists)
        const chartBtn = document.getElementById('game-flow-chart-btn');
        const flowData = await fetchGameFlowData(gameId);

        console.log(`[Game Flow] Game ID: ${gameId}`);
        console.log(`[Game Flow] Flow data exists:`, !!flowData);
        console.log(`[Game Flow] Flow data length:`, flowData?.length || 0);
        console.log(`[Game Flow] Show live features:`, showLiveFeatures);
        console.log(`[Game Flow] Chart button found:`, !!chartBtn);

        if (flowData && flowData.length > 0 && showLiveFeatures) {
            // Show chart button
            if (chartBtn) {
                console.log(`[Game Flow] ✓ Showing game flow chart button`);
                chartBtn.style.display = 'flex';
                chartBtn.onclick = () => toggleGameFlowChart();
            } else {
                console.warn(`[Game Flow] ✗ Chart button element not found!`);
            }

            // Pre-render the chart (hidden initially)
            renderGameFlowChart(flowData, team1, team2);
        } else {
            console.log(`[Game Flow] Not showing chart button. Reasons:`, {
                hasData: !!flowData,
                hasSnapshots: flowData?.length > 0,
                featuresEnabled: showLiveFeatures
            });
            if (chartBtn) {
                chartBtn.style.display = 'none';
            }
        }

    } catch (error) {
        console.error("Error showing game details:", error);
        contentArea.innerHTML = `<div class="error">Could not load details. ${escapeHTML(error.message)}</div>`;

        // Track modal error event
        if (typeof gtag !== 'undefined') {
            gtag('event', 'modal_error', {
                event_category: 'Game Modal',
                event_label: `Error loading game ${gameId}`,
                game_id: gameId,
                error_message: error.message
            });
        }
    }
}

function closeModal() {
    const modal = document.getElementById('game-modal');
    if (modal) {
        modal.style.display = 'none';

        // Track modal close event
        if (typeof gtag !== 'undefined') {
            gtag('event', 'modal_close', {
                event_category: 'Game Modal',
                event_label: 'User closed modal'
            });
        }
    }

    // Clean up chart
    if (gameFlowChartInstance) {
        gameFlowChartInstance.destroy();
        gameFlowChartInstance = null;
    }

    // Reset views
    const contentArea = document.getElementById('game-details-content-area');
    const chartArea = document.getElementById('game-flow-chart-area');
    const chartBtn = document.getElementById('game-flow-chart-btn');

    if (contentArea) contentArea.style.display = 'block';
    if (chartArea) chartArea.style.display = 'none';
    if (chartBtn) {
        chartBtn.classList.remove('active');
        chartBtn.style.display = 'none';
    }
}

async function initializePage() {
    try {
        // Load modal component first
        const placeholder = document.getElementById('modal-placeholder');
        if (!placeholder) {
            throw new Error("Fatal: Modal placeholder div not found in schedule.html.");
        }

        const response = await fetch('../common/game-modal-component.html');
        if (!response.ok) {
            throw new Error(`Failed to fetch modal component: ${response.status} ${response.statusText}`);
        }

        placeholder.innerHTML = await response.text();

        // Set up modal event listeners
        const closeModalBtn = document.getElementById('close-modal-btn');
        const gameModal = document.getElementById('game-modal');

        if (closeModalBtn && gameModal) {
            closeModalBtn.addEventListener('click', closeModal);
            gameModal.addEventListener('click', (event) => {
                if (event.target === gameModal) {
                    closeModal();
                }
            });
        } else {
            console.warn("Game modal component was loaded, but its internal elements were not found.");
        }

        await getActiveSeason();
        await fetchInitialPageData(activeSeasonId);
        calculateHistoricalRecords();
        determineInitialWeek();

        setTimeout(async () => {
            setupWeekSelector();
            setupTeamFilter();
            setupGameCardDelegation(); // Set up event delegation once
            await displayWeek(currentWeek);
        }, 0);

        listenForLiveGames();
        listenForScoringStatus();
    } catch (error) {
        console.error("Failed to initialize page:", error);
        document.querySelector('main').innerHTML = `<div class="error">Could not load schedule data. ${escapeHTML(error.message)}</div>`;
    }
}

document.addEventListener('DOMContentLoaded', initializePage);

// Clean up listeners when page is unloaded to prevent memory leaks and excessive reads
function cleanupListeners() {
    console.log('Cleaning up Firestore listeners...');
    if (statusUnsubscribe) {
        statusUnsubscribe();
        statusUnsubscribe = null;
    }
    if (liveGamesUnsubscribe) {
        liveGamesUnsubscribe();
        liveGamesUnsubscribe = null;
    }
}

window.addEventListener('beforeunload', cleanupListeners);
window.addEventListener('pagehide', cleanupListeners);

// Reload schedule when league changes
window.addEventListener('leagueChanged', (event) => {
    const newLeague = event.detail.league;
    console.log('League changed to:', newLeague);

    // Hide content during transition
    const mainElement = document.querySelector('main');
    if (mainElement) mainElement.style.opacity = '0';

    // Small delay before reloading to ensure fade-out completes
    setTimeout(() => {
        initializePage();

        // Show content after reload
        setTimeout(() => {
            if (mainElement) mainElement.style.opacity = '1';
        }, 100);
    }, 150);
});
