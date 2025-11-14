// /js/postseason-leaderboards.js
import { db, collection, getDocs, doc, getDoc, collectionGroup, query, where, collectionNames, getLeagueCollectionName } from './firebase-init.js';

// Get season from URL parameter or default to S8
const urlParams = new URLSearchParams(window.location.search);
const SEASON_ID = urlParams.get('season') || 'S8';

// Helper formatting functions
function formatKarma(value) { return Math.round(parseFloat(value || 0)).toLocaleString(); }
function formatRank(value) {
    const num = parseFloat(String(value));
    return (!isNaN(num) && num > 0) ? Math.round(num) : '-';
}
function formatPercentage(value) { return `${(parseFloat(value || 0) * 100).toFixed(1)}%`; }

// Configuration object for all leaderboard categories
const categories = {
    post_total_points: {
        title: 'Total Karma Leaders',
        cols: [
            { header: 'Rank', dataField: 'post_total_points_rank', type: 'number', formatFn: formatRank },
            { header: 'Player', dataField: 'player_handle', type: 'string' },
            { header: 'Karma', dataField: 'post_total_points', type: 'number', formatFn: formatKarma },
            { header: 'Games', dataField: 'post_games_played', type: 'number' }
        ],
        defaultSortField: 'post_total_points_rank', defaultSortDescending: false, dataSourceType: 'players'
    },
    post_rel_median: {
        title: 'REL Median Leaders',
        cols: [
            { header: 'Rank', dataField: 'post_rel_median_rank', type: 'number', formatFn: formatRank },
            { header: 'Player', dataField: 'player_handle', type: 'string' },
            { header: 'REL Median', dataField: 'post_rel_median', type: 'number', formatFn: (v) => parseFloat(v || 0).toFixed(3) },
            { header: 'Games', dataField: 'post_games_played', type: 'number' }
        ],
        defaultSortField: 'post_rel_median_rank', defaultSortDescending: false, dataSourceType: 'players', hasMinGamesFilter: true
    },
    post_war: {
        title: 'WAR Leaders',
        subtitle: 'Wins Above Replacement. Min. 1 game played.',
        cols: [
            { header: 'Rank', dataField: 'post_WAR_rank', type: 'number', formatFn: formatRank },
            { header: 'Player', dataField: 'player_handle', type: 'string' },
            { header: 'WAR', dataField: 'post_WAR', type: 'number', formatFn: (v) => parseFloat(v || 0).toFixed(2) },
            { header: 'Games', dataField: 'post_games_played', type: 'number' }
        ],
        defaultSortField: 'post_WAR_rank', defaultSortDescending: false, dataSourceType: 'players'
    },
    post_gem: {
        title: 'GEM Leaders',
        subtitle: 'Geometric Mean of Gameday Rank',
        cols: [
            { header: 'Rank', dataField: 'post_GEM_rank', type: 'number', formatFn: formatRank },
            { header: 'Player', dataField: 'player_handle', type: 'string' },
            { header: 'GEM', dataField: 'post_GEM', type: 'number', formatFn: (v) => parseFloat(v || 0).toFixed(1) },
            { header: 'Games', dataField: 'post_games_played', type: 'number' }
        ],
        defaultSortField: 'post_GEM_rank', defaultSortDescending: false, dataSourceType: 'players', hasMinGamesFilter: true
    },
    post_median_gameday_rank: {
        title: 'Median Gameday Rank Leaders',
        cols: [
            { header: 'Rank', dataField: 'post_medrank_rank', type: 'number', formatFn: formatRank },
            { header: 'Player', dataField: 'player_handle', type: 'string' },
            { header: 'Median Rank', dataField: 'post_medrank', type: 'number', formatFn: formatRank },
            { header: 'Games', dataField: 'post_games_played', type: 'number' }
        ],
        defaultSortField: 'post_medrank_rank', defaultSortDescending: false, dataSourceType: 'players', hasMinGamesFilter: true
    },
    post_aag_median: {
        title: 'Games Above Median Leaders',
        subtitle: 'Ties broken by % of Games Above Median',
        cols: [
            { header: 'Rank', dataField: 'post_aag_median_rank', type: 'number', formatFn: formatRank },
            { header: 'Player', dataField: 'player_handle', type: 'string' },
            { header: 'Above Median', dataField: 'post_aag_median', type: 'number' },
            { header: '% of Games', dataField: 'post_aag_median_pct', type: 'number', formatFn: formatPercentage }
        ],
        defaultSortField: 'post_aag_median_rank', defaultSortDescending: false, dataSourceType: 'players'
    },
    post_t100_finishes: {
        title: 'T100 Finishes Leaders',
        subtitle: 'Ties broken by % of Games in T100',
        cols: [
            { header: 'Rank', dataField: 'post_t100_rank', type: 'number', formatFn: formatRank },
            { header: 'Player', dataField: 'player_handle', type: 'string' },
            { header: 'T100 Finishes', dataField: 'post_t100', type: 'number' },
            { header: '% of Games', dataField: 'post_t100_pct', type: 'number', formatFn: formatPercentage }
        ],
        defaultSortField: 'post_t100_rank', defaultSortDescending: false, dataSourceType: 'players'
    },
    post_single_game_karma: {
        title: 'Single Game Karma Leaders',
        cols: [
            { header: 'Rank', dataField: 'rank', type: 'number' },
            { header: 'Player', dataField: 'player_handle', type: 'string' },
            { header: 'Karma', dataField: 'points_adjusted', type: 'number', formatFn: formatKarma },
            { header: 'Round', dataField: 'week', type: 'string' }
        ],
        defaultSortField: 'rank', defaultSortDescending: false, dataSourceType: 'single_game'
    },
    post_single_game_rank: {
        title: 'Single Game Rank Leaders',
        cols: [
            { header: 'Rank', dataField: 'rank', type: 'number' },
            { header: 'Player', dataField: 'player_handle', type: 'string' },
            { header: 'Daily Rank', dataField: 'global_rank', type: 'number', formatFn: formatRank },
            { header: 'Round', dataField: 'week', type: 'string' }
        ],
        defaultSortField: 'rank', defaultSortDescending: false, dataSourceType: 'single_game'
    }
};

// Global state variables
let currentCategory = 'post_total_points';
let allPlayersData = [];
let allTeamsData = new Map();
let allGamePerformancesData = {};
let leaderboardSortState = { columnField: null, direction: 'desc' };

// --- Data Fetching Functions ---

async function fetchSingleGameLeaderboard(boardName) {
    const docRef = doc(db, getLeagueCollectionName('post_leaderboards'), boardName, SEASON_ID, 'data');
    const docSnap = await getDoc(docRef);
    return docSnap.exists() ? (docSnap.data().rankings || []) : [];
}

async function fetchAllData() {
    const playersQuery = query(collection(db, collectionNames.players));
    const teamsQuery = query(collection(db, collectionNames.teams));
    const recordsQuery = query(collectionGroup(db, collectionNames.seasonalRecords), where('season', '==', SEASON_ID));

    const [playersSnap, teamsSnap, recordsSnap, singleGameKarma, singleGameRank] = await Promise.all([
        getDocs(playersQuery),
        getDocs(teamsQuery),
        getDocs(recordsQuery),
        fetchSingleGameLeaderboard('post_single_game_karma'),
        fetchSingleGameLeaderboard('post_single_game_rank')
    ]);

    const statsPromises = playersSnap.docs.map(pDoc => getDoc(doc(db, collectionNames.players, pDoc.id, collectionNames.seasonalStats, SEASON_ID)));
    const statsSnaps = await Promise.all(statsPromises);

    const recordsMap = new Map(recordsSnap.docs.map(doc => [doc.ref.parent.parent.id, doc.data()]));
    teamsSnap.forEach(doc => allTeamsData.set(doc.id, { id: doc.id, ...doc.data(), ...recordsMap.get(doc.id) }));

    allPlayersData = playersSnap.docs.map((pDoc, i) => ({
        id: pDoc.id,
        ...pDoc.data(),
        ...(statsSnaps[i].exists() ? statsSnaps[i].data() : {})
    }));
    
    allGamePerformancesData = {
        post_single_game_karma: singleGameKarma.map((p, i) => ({ ...p, rank: i + 1 })),
        post_single_game_rank: singleGameRank.map((p, i) => ({ ...p, rank: i + 1 }))
    };
}

/**
 * NEW FUNCTION: Loads all necessary data from Firestore for the leaderboards.
 * This is the function that was missing from the original code.
 */
async function loadData() {
    document.getElementById('leaderboard-body').innerHTML = '<tr><td colspan="4" class="loading">Loading leaderboard data...</td></tr>';
    await fetchAllData();
}

// --- DOM Manipulation and Rendering ---

function getTeamName(teamId) {
    return allTeamsData.get(teamId)?.team_name || 'Free Agent';
}

function getRankIndicator(rank) {
    if (rank === 1) return `<div class="first-place">${rank}</div>`;
    if (rank === 2) return `<div class="second-place">${rank}</div>`;
    if (rank === 3) return `<div class="third-place">${rank}</div>`;
    return `<span>${(typeof rank === 'number' && !isNaN(rank) && rank > 0) ? rank : '-'}</span>`;
}

function displayLeaderboard() {
    const categoryConfig = categories[currentCategory];
    if (!categoryConfig) return;

    // Update UI elements based on the selected category
    document.getElementById('leaderboard-title').textContent = categoryConfig.title;
    const header = document.querySelector('.leaderboard-header');
    let subtitle = header.querySelector('.leaderboard-subtitle');
    if (categoryConfig.subtitle) {
        if (!subtitle) {
            subtitle = document.createElement('div');
            subtitle.className = 'leaderboard-subtitle';
            header.appendChild(subtitle);
        }
        subtitle.textContent = categoryConfig.subtitle;
    } else if (subtitle) {
        subtitle.remove();
    }

    // Set visibility of filters
    document.getElementById('min-games-filter-container').style.display = categoryConfig.hasMinGamesFilter ? 'inline-flex' : 'none';
    document.getElementById('team-filter-container').style.display = 'inline-flex';

    // Build table headers
    let sortField = leaderboardSortState.columnField || categoryConfig.defaultSortField;
    let sortDir;
    
    // FIX: Determine initial sort direction based on state or category default
    if (leaderboardSortState.columnField) {
        // Use the direction from the current sort state (i.e., column has been clicked)
        sortDir = leaderboardSortState.direction;
    } else {
        // Use the direction appropriate for the default field on initial load
        sortDir = categoryConfig.defaultSortDescending ? 'desc' : 'asc';
    }

    const headerHTML = categoryConfig.cols.map(col => {
        const indicator = col.dataField === sortField ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '';
        return `<th class="sortable" onclick="window.handleLeaderboardSort('${col.dataField}')">${col.header}<span class="sort-indicator">${indicator}</span></th>`;
    }).join('');
    document.getElementById('table-header').innerHTML = `<tr>${headerHTML}</tr>`;

    // Filter and sort data
    let sourceData = categoryConfig.dataSourceType === 'single_game' ? allGamePerformancesData[currentCategory] : allPlayersData;
    let filteredData = [...sourceData];

    if (categoryConfig.hasMinGamesFilter) {
        const minGames = parseInt(document.getElementById('min-games').value) || 0;
        if (minGames > 0) filteredData = filteredData.filter(p => (p.post_games_played || 0) >= minGames);
    }
    
    const selectedTeamValues = Array.from(document.querySelectorAll('#team-filter-checklist input:checked')).map(cb => cb.value);
    if (!selectedTeamValues.includes('all') && selectedTeamValues.length > 0) {
        const playerTeamMap = new Map(allPlayersData.map(p => [p.id, p.current_team_id]));
        filteredData = filteredData.filter(item => selectedTeamValues.includes(item.current_team_id || playerTeamMap.get(item.player_id)));
    }

    filteredData.sort((a, b) => {
        let valA = a[sortField];
        let valB = b[sortField];
        
        // Handle null/undefined values for ranking fields
        if (typeof valA === 'undefined' || valA === null) valA = sortDir === 'asc' ? Infinity : -Infinity;
        if (typeof valB === 'undefined' || valB === null) valB = sortDir === 'asc' ? Infinity : -Infinity;
        
        // Ensure numeric comparison for number fields
        if (categoryConfig.cols.find(c => c.dataField === sortField)?.type === 'number') {
             valA = parseFloat(valA) || (sortDir === 'asc' ? Infinity : -Infinity);
             valB = parseFloat(valB) || (sortDir === 'asc' ? Infinity : -Infinity);
        }

        const comparison = String(valA).localeCompare(String(valB), undefined, { numeric: true });
        return sortDir === 'asc' ? comparison : -comparison;
    });

    // Render table rows
    const showCount = document.getElementById('show-count').value;
    const itemsToShow = showCount === 'all' ? filteredData : filteredData.slice(0, parseInt(showCount));
    const leaderboardBody = document.getElementById('leaderboard-body');

    if (itemsToShow.length === 0) {
        leaderboardBody.innerHTML = `<tr><td colspan="${categoryConfig.cols.length}" style="text-align:center; padding: 2rem;">No data available.</td></tr>`;
        return;
    }

    leaderboardBody.innerHTML = itemsToShow.map((item, index) => {
        const pData = allPlayersData.find(p => p.id === item.id || p.id === item.player_id) || {};
        const teamId = pData.current_team_id || item.team_id;
        const playerLink = `postseason-player.html?id=${pData.id || item.player_id}`;

        const cells = categoryConfig.cols.map(col => {
            if (col.header === 'Rank') return `<td class="rank-cell">${getRankIndicator(index + 1)}</td>`;
            if (col.header === 'Player') {
                return `<td class="player-cell">
                    <img src="../icons/${teamId || 'FA'}.webp" class="team-logo" onerror="this.src='../icons/FA.webp';" loading="lazy">
                    <div>
                        <div class="player-name"><a href="${playerLink}">${item.player_handle}</a></div>
                        <div class="team-name">${getTeamName(teamId)}</div>
                    </div>
                </td>`;
            }
            const value = item[col.dataField];
            return `<td class="stat-cell">${col.formatFn ? col.formatFn(value) : value || '-'}</td>`;
        }).join('');
        return `<tr>${cells}</tr>`;
    }).join('');
}

window.handleLeaderboardSort = (field) => {
    
    const isRankField = field.endsWith('_rank') || field === 'rank';
    
    // Initial click on a rank field should sort ASC (1 at top).
    // Initial click on a value field should sort DESC (highest value at top).
    const initialDirection = isRankField ? 'asc' : 'desc';

    if (leaderboardSortState.columnField === field) {
        leaderboardSortState.direction = leaderboardSortState.direction === 'asc' ? 'desc' : 'asc';
    } else {
        leaderboardSortState.columnField = field;
        leaderboardSortState.direction = initialDirection;
    }
    displayLeaderboard();
};

// --- Initialization ---

async function initializePage() {
    const categorySelect = document.getElementById('category-select');
    categorySelect.innerHTML = Object.keys(categories).map(key => `<option value="${key}">${categories[key].title.replace(/ Leaders$/, '')}</option>`).join('');
    
    const urlParam = new URLSearchParams(window.location.search).get('category');
    currentCategory = `post_${urlParam}` in categories ? `post_${urlParam}` : (urlParam in categories ? urlParam : sessionStorage.getItem('selectedPostseasonLeaderboard') || 'post_total_points');
    categorySelect.value = currentCategory;

    await loadData();
    
    // Setup team filter checklist
    const teamChecklist = document.getElementById('team-filter-checklist');
    const activeTeams = Array.from(allTeamsData.values()).filter(t => t.conference).sort((a,b) => a.team_name.localeCompare(b.team_name));
    teamChecklist.innerHTML = `<label><input type="checkbox" value="all" checked> All Teams</label>` + 
                              activeTeams.map(t => `<label><input type="checkbox" value="${t.id}"> ${t.team_name}</label>`).join('');

    // Add event listeners
    categorySelect.addEventListener('change', (e) => {
        currentCategory = e.target.value;
        sessionStorage.setItem('selectedPostseasonLeaderboard', currentCategory);
        leaderboardSortState.columnField = null; // Reset sort
        displayLeaderboard();
    });

    document.getElementById('show-count').addEventListener('change', displayLeaderboard);
    document.getElementById('min-games').addEventListener('input', displayLeaderboard);
    teamChecklist.addEventListener('change', (e) => {
        if (e.target.value === 'all' && e.target.checked) {
            teamChecklist.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
            e.target.checked = true;
        } else if (e.target.value !== 'all') {
            teamChecklist.querySelector('input[value="all"]').checked = false;
        }
        if (teamChecklist.querySelectorAll('input:checked').length === 0) {
            teamChecklist.querySelector('input[value="all"]').checked = true;
        }
        displayLeaderboard();
    });
    document.getElementById('team-filter-toggle-btn').addEventListener('click', () => {
        teamChecklist.style.display = teamChecklist.style.display === 'block' ? 'none' : 'block';
    });

    displayLeaderboard();
}

document.addEventListener('DOMContentLoaded', initializePage);
