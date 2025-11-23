import { db, collection, getDocs, doc, getDoc, collectionGroup, query, where, collectionNames, getLeagueCollectionName, getCurrentLeague, getConferenceNames } from './firebase-init.js';

// Get season from path (/S8/ or /S9/), URL parameter, or default to S9
const urlParams = new URLSearchParams(window.location.search);
const pathMatch = window.location.pathname.match(/\/S(\d+)\//);
const seasonFromPath = pathMatch ? `S${pathMatch[1]}` : null;
const SEASON_ID = seasonFromPath || urlParams.get('season') || 'S9';

function formatKarma(value) {
    return Math.round(parseFloat(value || 0)).toLocaleString();
}
function formatRank(value) {
    if (value === null || typeof value === 'undefined' || String(value).trim() === '') return '-';
    const numValue = parseFloat(String(value));
    if (isNaN(numValue) || numValue <= 0) return '-';
    const rank = Math.round(numValue);
    return rank > 0 ? rank : '-';
}
function formatPercentage(value) {
    return `${(parseFloat(value || 0) * 100).toFixed(1)}%`;
}

const categories = {
    total_points: {
        title: 'Total Karma Leaders',
        cols: [
            { header: 'Rank', dataField: 'total_points_rank', sortable: true, type: 'number', formatFn: formatRank },
            { header: 'Player', dataField: 'player_handle', sortable: true, type: 'string' },
            { header: 'Karma', dataField: 'total_points', sortable: true, type: 'number', formatFn: formatKarma },
            { header: 'Games', dataField: 'games_played', sortable: true, type: 'number' }
        ],
        defaultSortField: 'total_points_rank', defaultSortDescending: false, dataSourceType: 'players'
    },
    rel_mean: {
        title: 'REL Mean Leaders',
        cols: [
            { header: 'Rank', dataField: 'rel_mean', sortable: true, type: 'number', formatFn: formatRank },
            { header: 'Player', dataField: 'player_handle', sortable: true, type: 'string' },
            { header: 'REL Mean', dataField: 'rel_mean', sortable: true, type: 'number', formatFn: (v) => parseFloat(v || 0).toFixed(3) },
            { header: 'Games', dataField: 'games_played', sortable: true, type: 'number' }
        ],
        defaultSortField: 'rel_mean', defaultSortDescending: true, dataSourceType: 'players', hasMinGamesFilter: true
    },
    rel_median: {
        title: 'REL Median Leaders',
        cols: [
            { header: 'Rank', dataField: 'rel_median', sortable: true, type: 'number', formatFn: formatRank },
            { header: 'Player', dataField: 'player_handle', sortable: true, type: 'string' },
            { header: 'REL Median', dataField: 'rel_median', sortable: true, type: 'number', formatFn: (v) => parseFloat(v || 0).toFixed(3) },
            { header: 'Games', dataField: 'games_played', sortable: true, type: 'number' }
        ],
        defaultSortField: 'rel_median', defaultSortDescending: true, dataSourceType: 'players', hasMinGamesFilter: true
    },
    gem: {
        title: 'GEM Leaders',
        subtitle: 'Geometric Mean of Gameday Rank',
        cols: [
            { header: 'Rank', dataField: 'GEM', sortable: true, type: 'number', formatFn: formatRank },
            { header: 'Player', dataField: 'player_handle', sortable: true, type: 'string' },
            { header: 'GEM', dataField: 'GEM', sortable: true, type: 'number', formatFn: (v) => parseFloat(v || 0).toFixed(1) },
            { header: 'Games', dataField: 'games_played', sortable: true, type: 'number' }
        ],
        defaultSortField: 'GEM', defaultSortDescending: false, dataSourceType: 'players', hasMinGamesFilter: true
    },
    war: {
        title: 'WAR Leaders',
        subtitle: 'Wins Above Replacement. Min. 1 game played.',
        cols: [
            { header: 'Rank', dataField: 'WAR_rank', sortable: true, type: 'number', formatFn: formatRank },
            { header: 'Player', dataField: 'player_handle', sortable: true, type: 'string' },
            { header: 'WAR', dataField: 'WAR', sortable: true, type: 'number', formatFn: (v) => parseFloat(v || 0).toFixed(2) },
            { header: 'Games', dataField: 'games_played', sortable: true, type: 'number' }
        ],
        defaultSortField: 'WAR_rank', defaultSortDescending: false, dataSourceType: 'players'
    },
    median_gameday_rank: {
        title: 'Median Gameday Rank Leaders',
        cols: [
            { header: 'Rank', dataField: 'medrank', sortable: true, type: 'number', formatFn: formatRank },
            { header: 'Player', dataField: 'player_handle', sortable: true, type: 'string' },
            { header: 'Median Rank', dataField: 'medrank', sortable: true, type: 'number', formatFn: formatRank },
            { header: 'Games', dataField: 'games_played', sortable: true, type: 'number' }
        ],
        defaultSortField: 'medrank', defaultSortDescending: false, dataSourceType: 'players', hasMinGamesFilter: true
    },
    avg_gameday_rank: {
        title: 'Average Gameday Rank Leaders',
        cols: [
            { header: 'Rank', dataField: 'meanrank', sortable: true, type: 'number', formatFn: formatRank },
            { header: 'Player', dataField: 'player_handle', sortable: true, type: 'string' },
            { header: 'Avg Rank', dataField: 'meanrank', sortable: true, type: 'number', formatFn: (v) => (v === null || typeof v === 'undefined' || isNaN(parseFloat(String(v)))) ? '-' : parseFloat(String(v)).toFixed(1) },
            { header: 'Games', dataField: 'games_played', sortable: true, type: 'number' }
        ],
        defaultSortField: 'meanrank', defaultSortDescending: false, dataSourceType: 'players', hasMinGamesFilter: true
    },
    aag_mean: {
        title: 'Games Above Mean Leaders',
        subtitle: 'Ties broken by % of Games Above Mean',
        cols: [
            { header: 'Rank', dataField: 'aag_mean_rank', sortable: true, type: 'number', formatFn: formatRank },
            { header: 'Player', dataField: 'player_handle', sortable: true, type: 'string' },
            { header: 'Above Mean', dataField: 'aag_mean', sortable: true, type: 'number' },
            { header: '% of Games', dataField: 'aag_mean_pct', sortable: true, type: 'number', formatFn: formatPercentage }
        ],
        defaultSortField: 'aag_mean_rank', defaultSortDescending: false, dataSourceType: 'players'
    },
    aag_median: {
        title: 'Games Above Median Leaders',
        subtitle: 'Ties broken by % of Games Above Median',
        cols: [
            { header: 'Rank', dataField: 'aag_median_rank', sortable: true, type: 'number', formatFn: formatRank },
            { header: 'Player', dataField: 'player_handle', sortable: true, type: 'string' },
            { header: 'Above Median', dataField: 'aag_median', sortable: true, type: 'number' },
            { header: '% of Games', dataField: 'aag_median_pct', sortable: true, type: 'number', formatFn: formatPercentage }
        ],
        defaultSortField: 'aag_median_rank', defaultSortDescending: false, dataSourceType: 'players'
    },
     t100_finishes: {
        title: 'T100 Finishes Leaders',
        subtitle: 'Ties broken by % of Games in T100',
        cols: [
            { header: 'Rank', dataField: 't100_rank', sortable: true, type: 'number', formatFn: formatRank },
            { header: 'Player', dataField: 'player_handle', sortable: true, type: 'string' },
            { header: 'T100 Finishes', dataField: 't100', sortable: true, type: 'number' },
            { header: '% of Games', dataField: 't100_pct', sortable: true, type: 'number', formatFn: formatPercentage }
        ],
        defaultSortField: 't100_rank', defaultSortDescending: false, dataSourceType: 'players'
    },
    t50_finishes: {
        title: 'T50 Finishes Leaders',
        subtitle: 'Ties broken by % of Games in T50',
        cols: [
            { header: 'Rank', dataField: 't50_rank', sortable: true, type: 'number', formatFn: formatRank },
            { header: 'Player', dataField: 'player_handle', sortable: true, type: 'string' },
            { header: 'T50 Finishes', dataField: 't50', sortable: true, type: 'number' },
            { header: '% of Games', dataField: 't50_pct', sortable: true, type: 'number', formatFn: formatPercentage }
        ],
        defaultSortField: 't50_rank', defaultSortDescending: false, dataSourceType: 'players'
    },
    single_game_karma: {
        title: 'Single Game Karma Leaders',
        cols: [
            { header: 'Rank', dataField: 'rank', sortable: true, type: 'number' },
            { header: 'Player', dataField: 'player_handle', sortable: true, type: 'string' },
            { header: 'Karma', dataField: 'points_adjusted', sortable: true, type: 'number', formatFn: formatKarma },
            { header: 'Week', dataField: 'week', sortable: true, type: 'number' }
        ],
        defaultSortField: 'rank', defaultSortDescending: false, dataSourceType: 'single_game'
    },
    single_game_rank: {
        title: 'Single Game Rank Leaders',
        cols: [
            { header: 'Rank', dataField: 'rank', sortable: true, type: 'number' },
            { header: 'Player', dataField: 'player_handle', sortable: true, type: 'string' },
            { header: 'Daily Rank', dataField: 'global_rank', sortable: true, type: 'number', formatFn: formatRank },
            { header: 'Week', dataField: 'week', sortable: true, type: 'number' }
        ],
        defaultSortField: 'rank', defaultSortDescending: false, dataSourceType: 'single_game'
    }
};

let currentCategory = 'total_points';
let allPlayersData = [];
let allTeamsData = [];
let allGamePerformancesData = {};

let leaderboardSortState = {
    columnField: null,
    direction: 'desc'
};

async function fetchSingleGameLeaderboard(boardName) {
    const docRef = doc(db, getLeagueCollectionName('leaderboards'), boardName, SEASON_ID, 'data');
    const docSnap = await getDoc(docRef);
    return docSnap.exists() ? (docSnap.data().rankings || []) : [];
}

async function fetchTeamsData(seasonId) {
    const teamsSnap = await getDocs(collection(db, collectionNames.teams));

    const teamsDataPromises = teamsSnap.docs.map(async (teamDoc) => {
        const teamData = teamDoc.data();
        const seasonalRecordRef = doc(db, collectionNames.teams, teamDoc.id, collectionNames.seasonalRecords, seasonId);
        const seasonalRecordSnap = await getDoc(seasonalRecordRef);

        if (seasonalRecordSnap.exists()) {
            return { 
                id: teamDoc.id, 
                ...teamData, 
                ...seasonalRecordSnap.data() 
            };
        }
        return { id: teamDoc.id, ...teamData, team_name: teamDoc.id };
    });

    return Promise.all(teamsDataPromises);
}

async function fetchAllPlayerStats(seasonId) {
    const playersQuery = query(collection(db, collectionNames.players));
    const statsQuery = query(
      collectionGroup(db, collectionNames.seasonalStats),
      where('seasonId', '==', seasonId)
    );

    const [playersSnap, statsSnap] = await Promise.all([
        getDocs(playersQuery),
        getDocs(statsQuery)
    ]);

    const statsMap = new Map();
    statsSnap.docs.forEach(statDoc => {
        // Server-side filtered by seasonId - all results match seasonId
        const playerId = statDoc.ref.parent.parent.id;
        statsMap.set(playerId, statDoc.data());
    });

    const mergedData = playersSnap.docs.map(playerDoc => {
        const playerId = playerDoc.id;
        const playerData = playerDoc.data();
        const playerStats = statsMap.get(playerId);

        if (playerStats) {
            return {
                id: playerId,
                ...playerData,
                ...playerStats
            };
        }
        return null;
    }).filter(p => p !== null);

    return mergedData;
}

async function loadData() {
    const leaderboardBody = document.getElementById('leaderboard-body');
    leaderboardBody.innerHTML = '<tr><td colspan="4" class="loading">Loading data from Firestore...</td></tr>';
    
    try {
        const activeSeasonQuery = query(collection(db, collectionNames.seasons), where('status', '==', 'active'));
        const [playerStats, teams, singleGameKarma, singleGameRank, activeSeasonSnap] = await Promise.all([
            fetchAllPlayerStats(SEASON_ID),
            fetchTeamsData(SEASON_ID),
            fetchSingleGameLeaderboard('single_game_karma'),
            fetchSingleGameLeaderboard('single_game_rank'),
            getDocs(activeSeasonQuery)
        ]);
        
        let currentWeek = null;
        let activeSeasonId = null;
        if (!activeSeasonSnap.empty) {
            const activeSeasonData = activeSeasonSnap.docs[0].data();
            currentWeek = activeSeasonData.current_week;
            activeSeasonId = activeSeasonSnap.docs[0].id;
        }

        const postseasonContainer = document.getElementById('postseason-btn-container');
        if (postseasonContainer) {
            const postseasonWeeks = ['Play-In', 'Round 1', 'Round 2', 'Conf Finals', 'Finals', 'Season Complete'];

            // Show playoff button if:
            // 1. This is a historical season (not the active season), OR
            // 2. This is the active season AND we're in the postseason
            const isHistoricalSeason = activeSeasonId && SEASON_ID !== activeSeasonId;
            const isActiveSeasonInPostseason = SEASON_ID === activeSeasonId && postseasonWeeks.includes(currentWeek);

            if (isHistoricalSeason || isActiveSeasonInPostseason) {
                postseasonContainer.style.display = 'block';
            }
        }
        
        const minGamesInput = document.getElementById('min-games');
        if (minGamesInput) {
            const parsedWeek = parseInt(currentWeek, 10);
            if (!isNaN(parsedWeek) && parsedWeek < 5) {
                minGamesInput.value = '1';
            } else {
                minGamesInput.value = '3';
            }
        }

        if (!playerStats || !teams) {
            throw new Error("Failed to load critical player or team data.");
        }

        allTeamsData = teams;
        allPlayersData = playerStats;
        
        allGamePerformancesData = {
            single_game_karma: singleGameKarma.map((p, i) => ({ ...p, rank: i + 1 })),
            single_game_rank: singleGameRank.map((p, i) => ({ ...p, rank: i + 1 }))
        };

        const teamFilterChecklistContainer = document.getElementById('team-filter-checklist');
        teamFilterChecklistContainer.innerHTML = '';

        const conferences = getConferenceNames();
        const activeTeams = allTeamsData.filter(team => team.conference === conferences.primary || team.conference === conferences.secondary);
        activeTeams.sort((a, b) => a.team_name.localeCompare(b.team_name));

        const allTeamsLabel = document.createElement('label');
        const allTeamsCheckbox = document.createElement('input');
        allTeamsCheckbox.type = 'checkbox';
        allTeamsCheckbox.name = 'teamFilter';
        allTeamsCheckbox.value = 'all';
        allTeamsCheckbox.id = 'team-filter-all';
        allTeamsLabel.appendChild(allTeamsCheckbox);
        allTeamsLabel.appendChild(document.createTextNode(' All Teams'));
        teamFilterChecklistContainer.appendChild(allTeamsLabel);

        activeTeams.forEach(team => {
            const label = document.createElement('label');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.name = 'teamFilter';
            checkbox.value = team.id;
            checkbox.classList.add('team-specific-filter');
            label.appendChild(checkbox);
            label.appendChild(document.createTextNode(` ${team.team_name}`));
            teamFilterChecklistContainer.appendChild(label);
        });

        const allTeamsCb = document.getElementById('team-filter-all');
        const specificTeamCheckboxes = Array.from(document.querySelectorAll('.team-specific-filter'));

        allTeamsCb.addEventListener('change', () => {
            if (allTeamsCb.checked) {
                specificTeamCheckboxes.forEach(cb => { cb.checked = false; });
            } else if (!specificTeamCheckboxes.some(cb => cb.checked)) {
                allTeamsCb.checked = true;
            }
            applyTeamSelections();
        });

        specificTeamCheckboxes.forEach(cb => {
            cb.addEventListener('change', () => {
                allTeamsCb.checked = cb.checked ? false : !specificTeamCheckboxes.some(c => c.checked);
                applyTeamSelections();
            });
        });
        
        const storedTeamFilterJSON = sessionStorage.getItem('selectedLeaderboardTeamFilter');
        if (storedTeamFilterJSON) {
            try {
                const storedTeamValues = JSON.parse(storedTeamFilterJSON);
                if (Array.isArray(storedTeamValues)) {
                    if (storedTeamValues.includes('all') || storedTeamValues.length === 0) {
                        allTeamsCb.checked = true;
                    } else {
                        allTeamsCb.checked = false;
                        specificTeamCheckboxes.forEach(cb => {
                            cb.checked = storedTeamValues.includes(cb.value);
                        });
                    }
                }
            } catch (e) { allTeamsCb.checked = true; }
        } else {
            allTeamsCb.checked = true;
        }
        updateToggleButtonText();

        const teamFilterToggleBtn = document.getElementById('team-filter-toggle-btn');
        const teamChecklistDropdown = document.getElementById('team-filter-checklist');

        teamFilterToggleBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            const isActive = teamChecklistDropdown.style.display === 'block';
            teamChecklistDropdown.style.display = isActive ? 'none' : 'block';
            teamFilterToggleBtn.classList.toggle('active', !isActive);
        });

        document.addEventListener('click', (event) => {
            const dropdownWrapper = teamFilterToggleBtn.closest('.dropdown-team-filter');
            if (dropdownWrapper && !dropdownWrapper.contains(event.target)) {
                if (teamChecklistDropdown.style.display === 'block') {
                    teamChecklistDropdown.style.display = 'none';
                    teamFilterToggleBtn.classList.remove('active');
                }
            }
        });
        
        displayLeaderboard();

    } catch(error) {
        console.error("Error loading Firestore data:", error);
        leaderboardBody.innerHTML = `<tr><td colspan="4" class="error">Error loading data. Please try again later.</td></tr>`;
    }
}

function updateToggleButtonText() {
    const teamFilterBtnText = document.getElementById('team-filter-btn-text');
    if (!teamFilterBtnText) return;

    const allTeamsCb = document.getElementById('team-filter-all');
    const specificTeamCheckboxes = Array.from(document.querySelectorAll('.team-specific-filter'));
    const currentSelectedTeamIds = specificTeamCheckboxes.filter(cb => cb.checked).map(cb => cb.value);
    
    if (allTeamsCb.checked || currentSelectedTeamIds.length === 0) {
        teamFilterBtnText.textContent = 'All Teams';
    } else if (currentSelectedTeamIds.length === 1) {
        const team = allTeamsData.find(t => t.id === currentSelectedTeamIds[0]);
        teamFilterBtnText.textContent = team ? team.team_name : '1 Team Selected';
    } else {
        teamFilterBtnText.textContent = `${currentSelectedTeamIds.length} Teams Selected`;
    }
}

function applyTeamSelections() {
    const allTeamsCb = document.getElementById('team-filter-all');
    const specificTeamCheckboxes = Array.from(document.querySelectorAll('.team-specific-filter'));
    let selectedValues = [];

    if (allTeamsCb && allTeamsCb.checked) {
        selectedValues.push('all');
    } else {
        specificTeamCheckboxes.forEach(cb => {
            if (cb.checked) selectedValues.push(cb.value);
        });
    }
    if (selectedValues.length === 0 && allTeamsCb) {
        allTeamsCb.checked = true;
        selectedValues.push('all');
    }
    sessionStorage.setItem('selectedLeaderboardTeamFilter', JSON.stringify(selectedValues));
    updateToggleButtonText();
    leaderboardSortState.columnField = null;
    displayLeaderboard();
}

function getTeamName(teamId) {
    if (!teamId || String(teamId).toLowerCase() === 'undefined' || String(teamId).trim() === '' || teamId === 'N/A') return 'N/A';
    const team = allTeamsData.find(t => t.id === teamId);
    return team ? team.team_name : (teamId === 'FA' ? 'Free Agent' : teamId);
}
function getRankIndicator(rank) {
    if (rank === 1) { return `<div class="first-place">${rank}</div>`; }
    else if (rank === 2) { return `<div class="second-place">${rank}</div>`; }
    else if (rank === 3) { return `<div class="third-place">${rank}</div>`; }
    else { return `<span>${(typeof rank === 'number' && !isNaN(rank) && rank > 0) ? rank : '-'}</span>`; }
}

function handleLeaderboardSort(columnField, columnType = 'number') {
    const categoryConfig = categories[currentCategory];
    if (leaderboardSortState.columnField === columnField) {
        leaderboardSortState.direction = leaderboardSortState.direction === 'asc' ? 'desc' : 'asc';
    } else {
        leaderboardSortState.columnField = columnField;
        leaderboardSortState.direction = categoryConfig.cols.find(c => c.dataField === columnField)?.type === 'number' ? 'asc' : 'desc';
        if (columnField.endsWith('_rank')) leaderboardSortState.direction = 'asc';
        else if (columnType === 'string') leaderboardSortState.direction = 'asc';
        else leaderboardSortState.direction = 'desc';
    }
    displayLeaderboard();
}

function displayLeaderboard() {
    const categoryConfig = categories[currentCategory];
    if (!categoryConfig) return;

    const allOption = document.querySelector('#show-count option[value="all"]');
    if (allOption) {
        if (currentCategory === 'single_game_karma' || currentCategory === 'single_game_rank') {
            allOption.textContent = 'All Games';
        } else {
            allOption.textContent = 'All Players';
        }
    }

    const showCount = document.getElementById('show-count').value;
    const leaderboardTable = document.getElementById('leaderboardTable');
    const leaderboardBody = document.getElementById('leaderboard-body');
    const minGamesContainer = document.getElementById('min-games-filter-container');
    const minGamesInput = document.getElementById('min-games');
    const teamFilterContainer = document.getElementById('team-filter-container');

    if (categoryConfig.hasMinGamesFilter) {
        minGamesContainer.style.display = 'inline-flex';
    } else {
        minGamesContainer.style.display = 'none';
    }
    teamFilterContainer.style.display = 'inline-flex';

    leaderboardBody.innerHTML = `<tr><td colspan="${categoryConfig.cols.length || 4}" class="loading">Processing leaderboard...</td></tr>`;

    document.getElementById('leaderboard-title').textContent = categoryConfig.title;
    const headerElement = document.querySelector('.leaderboard-header h3');
    const existingSubtitle = document.querySelector('.leaderboard-subtitle');
    if (existingSubtitle) existingSubtitle.remove();
    if (categoryConfig.subtitle) {
        const subtitleElement = document.createElement('div');
        subtitleElement.className = 'leaderboard-subtitle';
        subtitleElement.textContent = categoryConfig.subtitle;
        headerElement.parentNode.appendChild(subtitleElement);
    }

    const headerCellsHTML = categoryConfig.cols.map(colConfig => {
        let indicator = '';
        if (colConfig.sortable && leaderboardSortState.columnField === colConfig.dataField) {
            indicator = leaderboardSortState.direction === 'asc' ? ' ▲' : ' ▼';
        }
        return `<th class="${colConfig.sortable ? 'sortable' : ''}" onclick="${colConfig.sortable ? `handleLeaderboardSort('${colConfig.dataField}', '${colConfig.type}')` : ''}">${colConfig.header}<span class="sort-indicator">${indicator}</span></th>`;
    }).join('');
    document.getElementById('table-header').innerHTML = `<tr>${headerCellsHTML}</tr>`;
    
    let sourceData;
    if (categoryConfig.dataSourceType === 'single_game') {
        sourceData = allGamePerformancesData[currentCategory] || [];
    } else {
        sourceData = allPlayersData;
    }

    let filteredData = [...sourceData];
    const minGames = parseInt(minGamesInput.value) || 0;
    if (categoryConfig.hasMinGamesFilter && minGames > 0) {
        filteredData = filteredData.filter(p => (p.games_played || 0) >= minGames);
    } else if (currentCategory === 'war') {
        filteredData = filteredData.filter(p => (p.games_played || 0) >= 1);
    }

    const selectedTeamCheckboxes = document.querySelectorAll('#team-filter-checklist input[type="checkbox"]:checked');
    const selectedTeamValues = Array.from(selectedTeamCheckboxes).map(cb => cb.value);
    if (!selectedTeamValues.includes('all') && selectedTeamValues.length > 0) {
        if (categoryConfig.dataSourceType === 'single_game') {
            // Create a map from player_id to current_team_id for efficient lookup
            const playerTeamMap = new Map(allPlayersData.map(p => [p.id, p.current_team_id]));
            // Filter game performances based on the current team of the player involved
            filteredData = filteredData.filter(game => selectedTeamValues.includes(playerTeamMap.get(game.player_id)));
        } else {
            filteredData = filteredData.filter(player => selectedTeamValues.includes(player.current_team_id));
        }
    }
    
    const sortField = leaderboardSortState.columnField || categoryConfig.defaultSortField;
    const sortDirection = leaderboardSortState.columnField ? leaderboardSortState.direction : (categoryConfig.defaultSortDescending ? 'desc' : 'asc');
    const colConfig = categoryConfig.cols.find(c => c.dataField === sortField) || {};
    const sortType = colConfig.type || 'number';

    filteredData.sort((a, b) => {
        let valA = a[sortField];
        let valB = b[sortField];

        if (sortType === 'number') {
            valA = parseFloat(valA === null || valA === undefined ? (sortDirection === 'desc' ? -Infinity : Infinity) : valA);
            valB = parseFloat(valB === null || valB === undefined ? (sortDirection === 'desc' ? -Infinity : Infinity) : valB);
            if (isNaN(valA)) valA = (sortDirection === 'desc' ? -Infinity : Infinity);
            if (isNaN(valB)) valB = (sortDirection === 'desc' ? -Infinity : Infinity);
        } else {
            valA = String(valA || '').toLowerCase();
            valB = String(valB || '').toLowerCase();
        }

        let comparison = 0;
        if (valA < valB) comparison = -1;
        if (valA > valB) comparison = 1;
        
        const primarySortResult = sortDirection === 'asc' ? comparison : -comparison;
        
        if (primarySortResult === 0) {
            const defaultSortValA = a[categoryConfig.defaultSortField];
            const defaultSortValB = b[categoryConfig.defaultSortField];
            if (defaultSortValA < defaultSortValB) return -1;
            if (defaultSortValA > defaultSortValB) return 1;
        }
        return primarySortResult;
    });

    const itemsToShow = showCount === 'all' ? filteredData : filteredData.slice(0, parseInt(showCount));

    if (itemsToShow.length === 0) {
        leaderboardBody.innerHTML = `<tr><td colspan="${categoryConfig.cols.length || 4}" style="text-align:center; padding: 2rem;">No data available for this category or filter.</td></tr>`;
        return;
    }

    const tableHTML = itemsToShow.map((item, index) => {
        // The displayed rank is now its position in the filtered/sorted list, not the static rank from Firestore.
        const dynamicRank = index + 1;

        let playerHandle, teamId, isRookie, isAllStar, playerId;

        if (categoryConfig.dataSourceType === 'single_game') {
            // Use the player_id from the leaderboard entry to find the most current player data
            const pData = allPlayersData.find(p => p.id === item.player_id);
            if (pData) {
                // If found, use the current data from the v2_players collection
                playerId = pData.id;
                playerHandle = pData.player_handle; // Use the fresh handle
                teamId = pData.current_team_id;
                isRookie = pData.rookie === '1';
                isAllStar = pData.all_star === '1';
            } else {
                // Fallback to the (potentially stale) data in the leaderboard entry if player not found
                playerId = item.player_id;
                playerHandle = item.player_handle;
                teamId = 'N/A'; // Cannot determine current team
                isRookie = false;
                isAllStar = false;
            }
        } else {
            // This logic handles player-based leaderboards and remains the same
            playerId = item.id;
            playerHandle = item.player_handle;
            teamId = item.current_team_id;
            isRookie = item.rookie === '1';
            isAllStar = item.all_star === '1';
        }
        
        const teamLogoSrc = (teamId && teamId !== 'FA' && teamId !== 'N/A') ? `../icons/${encodeURIComponent(teamId)}.webp` : '../icons/FA.webp';
        const rookieBadge = isRookie ? '<span class="rookie-badge">R</span>' : '';
        const allStarBadge = isAllStar ? '<span class="all-star-badge">★</span>' : '';
        
        let rowCells = `<td class="rank-cell">${getRankIndicator(dynamicRank)}</td>
            <td class="player-cell">
            <img src="${teamLogoSrc}" alt="${getTeamName(teamId)}" class="team-logo" onerror="this.onerror=null; this.src='../icons/FA.webp';" loading="lazy">
            <div>
                <div class="player-name">
                <a href="player.html?id=${encodeURIComponent(playerId || '')}">
                    <span class="player-name-text">${playerHandle || 'N/A'}</span>${rookieBadge}${allStarBadge}
                </a>
                </div>
                <div class="team-name">${getTeamName(teamId)}</div>
            </div>
            </td>`;

        for (let i = 2; i < categoryConfig.cols.length; i++) {
            const colDef = categoryConfig.cols[i];
            const value = item[colDef.dataField];
            const formattedValue = colDef.formatFn ? colDef.formatFn(value) : (value !== undefined && value !== null ? value : '-');
            rowCells += `<td class="stat-cell">${formattedValue}</td>`;
        }
        return `<tr>${rowCells}</tr>`;
    }).join('');

    leaderboardBody.innerHTML = tableHTML;
}

function initializePage() {
    const categorySelect = document.getElementById('category-select');
    categorySelect.innerHTML = Object.keys(categories).map(key => `<option value="${key}">${categories[key].title.replace(/ Leaders$/, '')}</option>`).join('');

    const urlParams = new URLSearchParams(window.location.search);
    const categoryParam = urlParams.get('category');
    const storedCategory = sessionStorage.getItem('selectedLeaderboardCategory');
    currentCategory = categoryParam || storedCategory || 'total_points';

    if (categories[currentCategory]) {
        categorySelect.value = currentCategory;
    } else {
        currentCategory = 'total_points';
        categorySelect.value = currentCategory;
    }
    sessionStorage.setItem('selectedLeaderboardCategory', currentCategory);

    categorySelect.addEventListener('change', function () {
        currentCategory = this.value;
        sessionStorage.setItem('selectedLeaderboardCategory', currentCategory);
        leaderboardSortState.columnField = null;
        displayLeaderboard();
    });

    const showCountElement = document.getElementById('show-count');
    const storedShowCount = sessionStorage.getItem('selectedLeaderboardShowCount');
    if (storedShowCount) showCountElement.value = storedShowCount;
    showCountElement.addEventListener('change', () => {
        sessionStorage.setItem('selectedLeaderboardShowCount', showCountElement.value);
        displayLeaderboard();
    });

    const minGamesInputElement = document.getElementById('min-games');
    minGamesInputElement.addEventListener('change', displayLeaderboard);
    minGamesInputElement.addEventListener('input', displayLeaderboard);

    loadData();
}

document.addEventListener('DOMContentLoaded', initializePage);

// Reload leaderboards when league changes
window.addEventListener('leagueChanged', (event) => {
    const newLeague = event.detail.league;
    console.log('League changed to:', newLeague);
    loadData();
});
