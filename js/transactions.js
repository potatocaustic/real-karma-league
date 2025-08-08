// transactions.js

import {
  db,
  collection,
  query,
  where,
  getDocs,
  orderBy,
  doc,
  getDoc,
} from "../js/firebase-init.js";

// --- DEV ENVIRONMENT CONFIG ---
const USE_DEV_COLLECTIONS = true;
const getCollectionName = (baseName) => USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
const ACTIVE_SEASON_ID = "S8";

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

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    loadData();
    setupEventListeners();
});

// --- Data Fetching Functions ---
async function loadData() {
    transactionsListEl.innerHTML = '<div class="loading">Loading transactions...</div>';

    try {
        const [transactionsSnap, allTeamsSnap, draftPicksSnap] = await Promise.all([
            getDocs(collection(db, getCollectionName('transactions'), 'seasons', ACTIVE_SEASON_ID)),
            getDocs(collection(db, getCollectionName('v2_teams'))),
            getDocs(collection(db, getCollectionName('draftPicks'))),
        ]);

        allTransactions = transactionsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        
        // Fetch team names from the seasonal_records subcollection
        const teamPromises = allTeamsSnap.docs.map(async (teamDoc) => {
            const teamId = teamDoc.id;
            const seasonalRecordRef = doc(db, getCollectionName('v2_teams'), teamId, getCollectionName('seasonal_records'), ACTIVE_SEASON_ID);
            const seasonalRecordSnap = await getDoc(seasonalRecordRef);
            return {
                id: teamId,
                team_name: seasonalRecordSnap.data()?.team_name || teamId,
                conference: teamDoc.data()?.conference // Fetching conference value from the top-level team document
            };
        });
        allTeams = await Promise.all(teamPromises);

        draftPicksSnap.docs.forEach(doc => {
            allDraftPicks[doc.id] = doc.data()?.pick_description;
        });

        await fetchAllPlayerStats();

        const sortedTransactions = allTransactions.sort((a, b) => {
            const dateA = a.date?.toDate() || 0;
            const dateB = b.date?.toDate() || 0;
            return dateB - dateA;
        });
        
        allTransactions = sortedTransactions;
        
        populateFilters();
        displayTransactions();

    } catch (error) {
        console.error("Error loading data:", error);
        transactionsListEl.innerHTML = '<div class="error">Error loading transaction data. Please try again.</div>';
    }
}

async function fetchAllPlayerStats() {
    const uniquePlayerIds = new Set();
    allTransactions.forEach(t => {
        t.involved_players?.forEach(p => uniquePlayerIds.add(p.id));
    });

    const playerStatsPromises = Array.from(uniquePlayerIds).map(async (playerId) => {
        const statsRef = doc(db, getCollectionName('v2_players'), playerId, getCollectionName('seasonal_stats'), ACTIVE_SEASON_ID);
        const statsSnap = await getDoc(statsRef);
        if (statsSnap.exists()) {
            allPlayerStats[playerId] = statsSnap.data();
        }
    });

    await Promise.all(playerStatsPromises);
}

// --- Filter and Display Logic ---
function populateFilters() {
    // Dynamically populate the week filter from transaction data
    const weekValues = [...new Set(allTransactions.map(t => t.week))].filter(Boolean).sort();
    const weekOptions = weekValues.map(week => `<option value="${week}">${week}</option>`).join('');
    weekFilterEl.innerHTML = '<option value="all">All Weeks</option>' + weekOptions;
    
    // Filter out malformed team documents AND teams without a conference
    const validTeams = allTeams.filter(team => team.id !== 'FA' && team.team_name && typeof team.team_name === 'string' && team.conference);

    // Sort valid teams alphabetically by name
    const sortedTeams = validTeams.sort((a, b) => a.team_name.localeCompare(b.team_name));
    
    const teamOptions = sortedTeams
        .map(team => `<option value="${team.id}">${team.team_name}</option>`)
        .join('');
    teamFilterEl.innerHTML = '<option value="all">All Teams</option>' + teamOptions;
}

function setupEventListeners() {
    weekFilterEl.addEventListener('change', displayTransactions);
    typeFilterEl.addEventListener('change', displayTransactions);
    teamFilterEl.addEventListener('change', displayTransactions);
}

function getFilteredTransactions() {
    const weekFilterValue = weekFilterEl.value;
    const typeFilterValue = typeFilterEl.value;
    const teamFilterValue = teamFilterEl.value;
    
    return allTransactions.filter(transaction => {
        // Filter by week
        if (weekFilterValue !== 'all' && transaction.week !== weekFilterValue) {
            return false;
        }

        // Filter by type
        if (typeFilterValue !== 'all' && transaction.type !== typeFilterValue) {
            return false;
        }

        // Filter by team
        if (teamFilterValue !== 'all') {
            const involvedTeamIds = (transaction.involved_teams || []).map(t => t.id);
            if (!involvedTeamIds.includes(teamFilterValue)) {
                return false;
            }
        }
        
        return true;
    });
}

function displayTransactions() {
    const filteredTransactions = getFilteredTransactions();

    if (filteredTransactions.length === 0) {
        transactionsListEl.innerHTML = '<div class="no-transactions">No transactions match your filters.</div>';
        transactionsTitleEl.textContent = 'No Transactions Found';
        return;
    }
    
    transactionsTitleEl.textContent = `${filteredTransactions.length} Transaction${filteredTransactions.length === 1 ? '' : 's'}`;
    
    const transactionsHTML = filteredTransactions.map(renderTransaction).join('');
    transactionsListEl.innerHTML = transactionsHTML;
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
    return `<img src="../icons/${teamId}.webp" alt="${teamData.team_name}" class="team-logo-inline" onerror="this.style.display='none'">`;
}

function getTeamNameLink(teamId) {
    if (!teamId) return 'N/A';
    const teamData = allTeams.find(t => t.id === teamId);
    if (!teamData) return teamId;
    return `<a href="../team.html?id=${teamId}" class="team-name-link">${teamData.team_name}</a>`;
}

function getPlayerNameLink(playerHandle) {
    if (!playerHandle) return 'N/A';
    const player = allTransactions.flatMap(t => t.involved_players || []).find(p => p.player_handle === playerHandle);
    const playerId = player?.id || '';
    return `<a href="../player.html?player=${playerId}" class="player-name-link">${playerHandle}</a>`;
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
            if (team) {
                details = `${getTeamLogo(team.id)}${getPlayerNameLink(player.player_handle)}${getPlayerStatsString(player.id)} signed with ${getTeamNameLink(team.id)} as a free agent.`;
            } else {
                details = `${getPlayerNameLink(player.player_handle)} signed with an unknown team.`;
            }
            break;
        }
        case 'CUT': {
            const player = transaction.involved_players[0];
            // Access the team ID from the `involved_teams` array, not from player.from
            const fromTeamId = transaction.involved_teams[0]?.id;
            const team = allTeams.find(t => t.id === fromTeamId);
            if (team) {
                details = `${getTeamLogo(team.id)}${getPlayerNameLink(player.player_handle)}${getPlayerStatsString(player.id)} cut by ${getTeamNameLink(team.id)}.`;
            } else {
                details = `${getPlayerNameLink(player.player_handle)} cut by an unknown team.`;
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