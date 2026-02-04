// transactions.js

import {
import { getSeasonIdFromPage } from './season-utils.js';
  db,
  collection,
  query,
  where,
  getDocs,
  orderBy,
  doc,
  getDoc,
  limit,
  startAfter,
  collectionNames,
  getLeagueCollectionName
} from "../js/firebase-init.js";

// Get season from page lock (data-season, path, or ?season), fallback to S9
const { seasonId: ACTIVE_SEASON_ID } = getSeasonIdFromPage({ fallback: 'S9' });

// --- DOM Elements ---
const transactionsListEl = document.getElementById('transactions-list');
const transactionsTitleEl = document.getElementById('transactions-title');
const weekFilterEl = document.getElementById('week-filter');
const typeFilterEl = document.getElementById('type-filter');
const teamFilterEl = document.getElementById('team-filter');

// --- Global Data Stores ---
let allTransactions = [];
let allTeams = [];
let allDraftPicks = {};
let allPlayerStats = {};
let availableWeeks = new Set();

// --- Filter State ---
const currentFilters = {
    week: 'all',
    type: 'all',
    team: 'all'
};

// --- Pagination State ---
const TRANSACTIONS_PER_PAGE = 50; // Load 100 transactions at a time
let lastTransactionDoc = null;
let hasMoreTransactions = true;
let isLoadingMore = false;

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    loadData();
    setupEventListeners();
});

// --- Data Fetching Functions ---
async function loadData() {
    transactionsListEl.innerHTML = '<div class="loading">Loading transactions...</div>';

    try {
        const [allTeamsSnap, draftPicksSnap] = await Promise.all([
            getDocs(collection(db, collectionNames.teams)),
            getDocs(collection(db, collectionNames.draftPicks)),
        ]);

        const teamPromises = allTeamsSnap.docs.map(async (teamDoc) => {
            const teamId = teamDoc.id;
            const seasonalRecordRef = doc(db, collectionNames.teams, teamId, collectionNames.seasonalRecords, ACTIVE_SEASON_ID);
            const seasonalRecordSnap = await getDoc(seasonalRecordRef);
            return {
                id: teamId,
                team_name: seasonalRecordSnap.data()?.team_name || teamId,
                conference: teamDoc.data()?.conference
            };
        });
        allTeams = await Promise.all(teamPromises);

        draftPicksSnap.docs.forEach(doc => {
            allDraftPicks[doc.id] = doc.data()?.pick_description;
        });

        await fetchAvailableWeeks();
        populateFilters();

        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.has('id')) {
            weekFilterEl.disabled = true;
            typeFilterEl.disabled = true;
            teamFilterEl.disabled = true;
            transactionsTitleEl.textContent = 'Viewing Specific Transaction';
            await loadSpecificTransaction(urlParams.get('id'));
            return;
        }

        // Initialize filters from URL parameters
        if (urlParams.has('teamFilter')) {
            const teamId = urlParams.get('teamFilter');
            currentFilters.team = teamId;
            teamFilterEl.value = teamId;
        }
        if (urlParams.has('weekFilter')) {
            const week = urlParams.get('weekFilter');
            currentFilters.week = week;
            weekFilterEl.value = week;
        }
        if (urlParams.has('typeFilter')) {
            const type = urlParams.get('typeFilter');
            currentFilters.type = type;
            typeFilterEl.value = type;
        }

        await fetchTransactionsPage({ reset: true });
    } catch (error) {
        console.error("Error loading data:", error);
        transactionsListEl.innerHTML = '<div class="error">Error loading transaction data. Please try again.</div>';
    }
}

async function fetchAvailableWeeks() {
    try {
        const weeksQuery = query(
            collection(db, collectionNames.transactions, 'seasons', ACTIVE_SEASON_ID),
            orderBy('week')
        );

        const weeksSnap = await getDocs(weeksQuery);
        weeksSnap.docs.forEach(doc => {
            const weekValue = doc.data()?.week;
            if (weekValue) {
                availableWeeks.add(weekValue);
            }
        });
    } catch (error) {
        console.error('Error fetching weeks:', error);
    }
}

async function loadSpecificTransaction(transactionId) {
    try {
        const transactionRef = doc(db, collectionNames.transactions, 'seasons', ACTIVE_SEASON_ID, transactionId);
        const transactionSnap = await getDoc(transactionRef);

        if (!transactionSnap.exists()) {
            transactionsListEl.innerHTML = '<div class="error">Transaction not found.</div>';
            return;
        }

        const normalizedTransaction = normalizeTransactionDoc(transactionSnap);
        allTransactions = [normalizedTransaction];
        hasMoreTransactions = false;
        lastTransactionDoc = null;
        await fetchAllPlayerStats();
        displayTransactions();
    } catch (error) {
        console.error('Error loading specific transaction:', error);
        transactionsListEl.innerHTML = '<div class="error">Unable to load the requested transaction.</div>';
    }
}

async function fetchTransactionsPage({ reset = false } = {}) {
    if (reset) {
        lastTransactionDoc = null;
        hasMoreTransactions = true;
        allTransactions = [];
        transactionsListEl.innerHTML = '<div class="loading">Loading transactions...</div>';
    }

    if (!hasMoreTransactions || isLoadingMore) {
        return;
    }

    isLoadingMore = true;

    const constraints = [
        collection(db, collectionNames.transactions, 'seasons', ACTIVE_SEASON_ID),
        orderBy('date', 'desc')
    ];

    if (currentFilters.week !== 'all') {
        constraints.push(where('week', '==', currentFilters.week));
    }

    if (currentFilters.type !== 'all') {
        constraints.push(where('type', '==', currentFilters.type));
    }

    if (currentFilters.team !== 'all') {
        const selectedTeam = allTeams.find(team => team.id === currentFilters.team);

        // Transactions store involved_teams as objects ({ id, team_name }), so we need to match the full object
        if (selectedTeam) {
            constraints.push(where('involved_teams', 'array-contains', {
                id: selectedTeam.id,
                team_name: selectedTeam.team_name || selectedTeam.id
            }));
        } else {
            // Fallback to the raw ID if for some reason the team list isn't loaded
            constraints.push(where('involved_teams', 'array-contains', currentFilters.team));
        }
    }

    if (lastTransactionDoc) {
        constraints.push(startAfter(lastTransactionDoc));
    }

    constraints.push(limit(TRANSACTIONS_PER_PAGE));

    const transactionsQuery = query(...constraints);

    try {
        const snap = await getDocs(transactionsQuery);
        const newTransactions = snap.docs.map(normalizeTransactionDoc);

        allTransactions = reset ? newTransactions : [...allTransactions, ...newTransactions];

        if (snap.docs.length < TRANSACTIONS_PER_PAGE) {
            hasMoreTransactions = false;
        } else {
            lastTransactionDoc = snap.docs[snap.docs.length - 1];
        }

        await fetchPlayerStatsForTransactions(newTransactions);
        displayTransactions();
    } catch (error) {
        console.error('Error loading transactions:', error);
        transactionsListEl.innerHTML = '<div class="error">Error loading transaction data. Please try again.</div>';
    } finally {
        isLoadingMore = false;
    }
}

async function loadMoreTransactions() {
    const loadMoreBtn = document.getElementById('load-more-btn');
    if (loadMoreBtn) {
        loadMoreBtn.textContent = 'Loading...';
        loadMoreBtn.disabled = true;
    }

    await fetchTransactionsPage({ reset: false });

    if (loadMoreBtn) {
        loadMoreBtn.textContent = 'Load More Transactions';
        loadMoreBtn.disabled = false;
    }
}

function normalizeTransactionDoc(docSnap) {
    const data = docSnap.data() || {};
    const rawTeams = data.involved_teams || [];
    const normalizedTeams = rawTeams.map(teamEntry => {
        if (typeof teamEntry === 'string') {
            return { id: teamEntry, team_name: teamEntry };
        }
        return teamEntry;
    });

    return {
        id: docSnap.id,
        ...data,
        involved_teams: normalizedTeams
    };
}

async function fetchPlayerStatsForTransactions(transactions) {
    const uniquePlayerIds = new Set();
    transactions.forEach(t => {
        t.involved_players?.forEach(p => {
            if (!allPlayerStats[p.id]) {
                uniquePlayerIds.add(p.id);
            }
        });
    });

    const playerStatsPromises = Array.from(uniquePlayerIds).map(async (playerId) => {
        const statsRef = doc(db, collectionNames.players, playerId, collectionNames.seasonalStats, ACTIVE_SEASON_ID);
        const statsSnap = await getDoc(statsRef);
        if (statsSnap.exists()) {
            allPlayerStats[playerId] = statsSnap.data();
        }
    });

    await Promise.all(playerStatsPromises);
}

async function fetchAllPlayerStats() {
    await fetchPlayerStatsForTransactions(allTransactions);
}

// --- Filter and Display Logic ---
function populateFilters() {
    const weekValues = Array.from(availableWeeks).filter(Boolean).sort();
    const weekOptions = weekValues.map(week => `<option value="${week}">${week}</option>`).join('');
    weekFilterEl.innerHTML = '<option value="all">All Weeks</option>' + weekOptions;

    const validTeams = allTeams.filter(team => team.id !== 'FA' && team.team_name && typeof team.team_name === 'string' && team.conference);
    const sortedTeams = validTeams.sort((a, b) => a.team_name.localeCompare(b.team_name));

    const teamOptions = sortedTeams
        .map(team => `<option value="${team.id}">${team.team_name}</option>`)
        .join('');
    teamFilterEl.innerHTML = '<option value="all">All Teams</option>' + teamOptions;
}

function setupEventListeners() {
    weekFilterEl.addEventListener('change', handleFilterChange);
    typeFilterEl.addEventListener('change', handleFilterChange);
    teamFilterEl.addEventListener('change', handleFilterChange);
}

function handleFilterChange() {
    currentFilters.week = weekFilterEl.value;
    currentFilters.type = typeFilterEl.value;
    currentFilters.team = teamFilterEl.value;
    fetchTransactionsPage({ reset: true });
}

function getFilteredTransactions() {
    const urlParams = new URLSearchParams(window.location.search);
    const transactionIdFromUrl = urlParams.get('id');

    // **NEW**: If an ID is in the URL, prioritize it and ignore other filters.
    if (transactionIdFromUrl) {
        return allTransactions.filter(transaction => transaction.id === transactionIdFromUrl);
    }

    // Data is already filtered via Firestore queries based on dropdown selections
    return allTransactions;
}

function displayTransactions() {
    const filteredTransactions = getFilteredTransactions();

    if (filteredTransactions.length === 0) {
        transactionsListEl.innerHTML = '<div class="no-transactions">No transactions match your filters.</div>';
        transactionsTitleEl.textContent = 'No Transactions Found';
        return;
    }

    const urlParams = new URLSearchParams(window.location.search);
    if (!urlParams.has('id')) {
        const loadedCount = allTransactions.length;
        const displayCount = filteredTransactions.length;
        transactionsTitleEl.textContent = `Showing ${displayCount} Transaction${displayCount === 1 ? '' : 's'}${hasMoreTransactions ? ` (${loadedCount} loaded)` : ''}`;
    }

    const transactionsHTML = filteredTransactions.map(renderTransaction).join('');

    // Add "Load More" button if there are more transactions available
    let loadMoreHTML = '';
    if (hasMoreTransactions) {
        loadMoreHTML = `
            <div style="text-align: center; margin: 2rem 0; padding: 1rem;">
                <button id="load-more-btn" class="load-more-btn" style="
                    padding: 0.75rem 2rem;
                    font-size: 1rem;
                    background: #0d6efd;
                    color: white;
                    border: none;
                    border-radius: 6px;
                    cursor: pointer;
                    transition: background 0.3s;
                " onmouseover="this.style.background='#0b5ed7'" onmouseout="this.style.background='#0d6efd'">
                    Load More Transactions
                </button>
                <div style="margin-top: 0.5rem; color: #666; font-size: 0.9rem;">
                    ${allTransactions.length} of 615+ transactions loaded
                </div>
            </div>
        `;
    }

    transactionsListEl.innerHTML = transactionsHTML + loadMoreHTML;

    // Attach event listener to Load More button
    if (hasMoreTransactions) {
        const loadMoreBtn = document.getElementById('load-more-btn');
        if (loadMoreBtn) {
            loadMoreBtn.addEventListener('click', loadMoreTransactions);
        }
    }
}

// --- HTML Rendering Functions ---
function getTeamDataFromTransaction(transaction, teamId) {
    if (!transaction || !transaction.involved_teams || !teamId) return null;
    return transaction.involved_teams.find(t => t.id === teamId);
}

function getPlayerStatsString(playerId) {
    const stats = allPlayerStats[playerId];
    if (stats) {
        const gamesPlayed = stats.games_played || 0;
        const medianRank = stats.medrank > 0 ? Math.round(stats.medrank) : '-';
        const relMedian = (stats.rel_median || 0).toFixed(3);
        return ` <span class="player-stats-inline">(${gamesPlayed} GP, ${medianRank} Med Rank, ${relMedian} REL)</span>`;
    }
    return ' <span class="player-stats-inline">(Stats N/A)</span>';
}

function getTeamLogo(teamId) {
    if (!teamId) return '';
    const teamData = allTeams.find(t => t.id === teamId);
    if (!teamData) return '';
    return `<img src="/icons/${teamId}.webp" alt="${teamData.team_name}" class="team-logo-inline" onerror="this.style.display='none'" loading="lazy">`;
}

function getTeamNameLink(teamId) {
    if (!teamId) return 'N/A';
    const teamData = allTeams.find(t => t.id === teamId);
    if (!teamData) return teamId;
    return `<a href="team.html?id=${teamId}" class="team-name-link">${teamData.team_name}</a>`;
}

function getPlayerNameLink(playerHandle) {
    if (!playerHandle) return 'N/A';
    const player = allTransactions.flatMap(t => t.involved_players || []).find(p => p.player_handle === playerHandle);
    const playerId = player?.id || '';
    return `<a href="player.html?id=${playerId}" class="player-name-link">${playerHandle}</a>`;
}

function getVerb(teamName, verb) {
    if (typeof teamName === 'string' && teamName.toLowerCase().endsWith('s')) {
        return verb;
    }
    return verb + 's';
}

function renderTransaction(transaction) {
    const typeClass = transaction.type.toLowerCase().replace(/_/g, '-');
    let details = '';

    switch (transaction.type) {
        case 'SIGN': {
            const player = transaction.involved_players[0];
            const team = getTeamDataFromTransaction(transaction, player.to);
            if (team && player) {
                details = `${getTeamLogo(team.id)}${getPlayerNameLink(player.player_handle)}${getPlayerStatsString(player.id)} signed with ${getTeamNameLink(team.id)} as a free agent.`;
            } else {
                details = `A player was signed by an unknown team.`;
            }
            break;
        }
        case 'CUT': {
            const player = transaction.involved_players[0];
            const fromTeamId = transaction.involved_teams[0]?.id;
            const team = allTeams.find(t => t.id === fromTeamId);
            if (team && player) {
                details = `${getTeamLogo(team.id)}${getPlayerNameLink(player.player_handle)}${getPlayerStatsString(player.id)} cut by ${getTeamNameLink(team.id)}.`;
            } else {
                details = `A player was cut by an unknown team.`;
            }
            break;
        }
        case 'RETIREMENT': {
            const player = transaction.involved_players[0];
            const team = transaction.involved_teams[0];
            if (team && player) {
                details = `${getTeamLogo(team.id)}${getPlayerNameLink(player.player_handle)}${getPlayerStatsString(player.id)} retired from ${getTeamNameLink(team.id)}.`;
            } else {
                details = `A player retired from an unknown team.`;
            }
            break;
        }
        case 'UNRETIREMENT': {
            const player = transaction.involved_players[0];
            const team = transaction.involved_teams[0];
            if (team && player) {
                details = `${getTeamLogo(team.id)}${getPlayerNameLink(player.player_handle)}${getPlayerStatsString(player.id)} unretired and signed with ${getTeamNameLink(team.id)}.`;
            } else {
                details = `A player unretired and signed with an unknown team.`;
            }
            break;
        }
        case 'TRADE': {
            const involvedTeams = transaction.involved_teams.map(t => t.id);
            const teamAssetsMap = {};
            involvedTeams.forEach(teamId => {
                teamAssetsMap[teamId] = { players: [], picks: [] };
            });

            transaction.involved_players.forEach(p => {
                teamAssetsMap[p.to].players.push(p);
            });
            transaction.involved_picks.forEach(p => {
                teamAssetsMap[p.to].picks.push(p);
            });

            const teamIdsArray = Object.keys(teamAssetsMap);
            let tradePartsClass = 'trade-parts';
            if (teamIdsArray.length === 3) {
                tradePartsClass += ' three-team-grid';
            } else if (teamIdsArray.length >= 4) {
                tradePartsClass += ' four-team-grid';
            }
            
            let tradeSummaryHtml = `<div class="${tradePartsClass}">`;

            teamIdsArray.forEach((teamId, index) => {
                const assets = teamAssetsMap[teamId];
                const teamData = allTeams.find(t => t.id === teamId);
                const teamName = teamData ? teamData.team_name : teamId;
                const verb = getVerb(teamName, 'receive');

                tradeSummaryHtml += `
                    <div class="trade-side">
                        <div class="trade-team">${getTeamLogo(teamId)}${getTeamNameLink(teamId)}&nbsp;${verb}:</div>
                        <ul class="trade-assets">
                            ${assets.players.map(p => `<li>📝 ${getPlayerNameLink(p.player_handle)}${getPlayerStatsString(p.id)}</li>`).join('')}
                            ${assets.picks.map(p => `<li>🎯 <span class="draft-pick">${allDraftPicks[p.id] || p.id}</span></li>`).join('')}
                            ${assets.players.length === 0 && assets.picks.length === 0 ? '<li><em>Nothing</em></li>' : ''}
                        </ul>
                    </div>`; 
                if (index < teamIdsArray.length - 1 && teamIdsArray.length === 2) {
                    tradeSummaryHtml += `<div class="trade-arrow">⇄</div>`;
                }
            });
            tradeSummaryHtml += '</div>';

            details = tradeSummaryHtml;
            break;
        }
        default:
            details = 'Unknown transaction type.';
            break;
    }

    const weekDisplay = transaction.week ? `Week ${transaction.week}` : '';
    const dateDisplay = transaction.date?.toDate().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

    return `
      <div class="transaction-item">
        <div class="transaction-header">
          <span class="transaction-type ${typeClass}">${transaction.type.replace(/_/g, ' ')}</span>
          <span class="transaction-date">${weekDisplay} - ${dateDisplay}</span>
        </div>
        <div class="transaction-details">
          ${details}
          ${transaction.notes ? `<br><em>Note: ${transaction.notes}</em>` : ''}
        </div>
      </div>
    `;
}

// Listen for league changes and refresh the page content
window.addEventListener('leagueChanged', () => {
    console.log('League changed, reloading transactions page...');
    // Reset pagination state
    lastTransactionDoc = null;
    hasMoreTransactions = true;
    allTransactions = [];
    allPlayerStats = {};
    availableWeeks.clear();
    // Reload all data
    loadData();
});
