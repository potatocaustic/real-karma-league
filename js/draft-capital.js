// /js/draft-capital.js

// Import functions from your firebase-init.js
import { 
    db, 
    collection, 
    getDocs,
    collectionGroup
} from './firebase-init.js';

// --- Globals ---
let currentSeason = 9; // Default to Season 9 draft
let currentView = 'table';
let allDraftPicks = [];
let allTeams = [];
let allTransactionsLogData = [];

// --- Helper Functions ---
const USE_DEV_COLLECTIONS = false; // Set to false for production
const getCollectionName = (baseName) => USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;

function escapeHTML(str) {
  if (typeof str !== 'string') return str; 
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
}

function getTeamName(teamId) {
  if (!teamId) return 'N/A';
  const team = allTeams.find(t => t.team_id === teamId);
  return team ? team.team_name : teamId;
}

function getTeamLogoHTML(teamId) {
  if (!teamId || teamId === 'N/A') return '';
  const teamName = getTeamName(teamId); 
  const altText = escapeHTML(teamName);   
  return `<img src="../icons/${encodeURIComponent(teamId)}.webp" alt="${altText}" class="team-logo" onerror="this.style.display='none'">`;
}

/**
 * Parses a Firestore Timestamp object or a date string into a YYYY-MM-DD format.
 * @param {object|string} dateValue - Firestore Timestamp or a date string.
 * @returns {string|null} - e.g., "2025-08-11" or null if invalid.
 */
function parseFirestoreDate(dateValue) {
    if (!dateValue) return null;
    let dateObj;

    // Handle Firestore Timestamp object
    if (typeof dateValue.toDate === 'function') {
        dateObj = dateValue.toDate();
    }
    // Handle string date as a fallback
    else if (typeof dateValue === 'string') {
        const parsableString = dateValue.split(' at ')[0];
        dateObj = new Date(parsableString);
    } else {
        return null; // Unsupported type
    }

    if (isNaN(dateObj.getTime())) return null;

    const year = dateObj.getFullYear();
    const month = String(dateObj.getMonth() + 1).padStart(2, '0');
    const day = String(dateObj.getDate()).padStart(2, '0');
    
    return `${year}-${month}-${day}`;
}

// --- Data Loading from Firestore ---
async function loadData() {
  try {
      console.log("Loading data from Firestore...");

      const draftPicksCol = collection(db, getCollectionName('draftPicks'));
      const draftPicksSnap = await getDocs(draftPicksCol);
      allDraftPicks = draftPicksSnap.docs.map(doc => doc.data());

      const teamRecordsColGroup = collectionGroup(db, getCollectionName('seasonal_records'));
      const teamRecordsSnap = await getDocs(teamRecordsColGroup);
      allTeams = teamRecordsSnap.docs
          .filter(doc => doc.id.startsWith('S'))
          .map(doc => ({
              team_id: doc.ref.parent.parent.id, 
              team_name: doc.data().team_name,
              season: doc.id
          }))
          .reduce((acc, current) => {
              const existingTeam = acc.find(team => team.team_id === current.team_id);
              if (!existingTeam || parseInt(current.season.slice(1)) > parseInt(existingTeam.season.slice(1))) {
                  return [...acc.filter(team => team.team_id !== current.team_id), current];
              }
              return acc;
          }, []);
      
      const activeLeagueSeason = "S8";
      const transCol = collection(db, getCollectionName('transactions'), 'seasons', activeLeagueSeason);
      const transSnap = await getDocs(transCol);
      allTransactionsLogData = transSnap.docs.map(doc => ({
          transaction_id: doc.id,
          ...doc.data()
      })).sort((a, b) => {
          const timeA = a.date?.toDate ? a.date.toDate().getTime() : 0;
          const timeB = b.date?.toDate ? b.date.toDate().getTime() : 0;
          return timeB - timeA;
      });

      console.log(`Loaded ${allDraftPicks.length} draft picks, ${allTeams.length} teams, and ${allTransactionsLogData.length} transactions.`);

      setupFilters();
      displayDraftBoard();

  } catch (error) {
      console.error("Error loading data from Firestore:", error);
      const errorMsg = '<tr><td colspan="4" class="error">Error loading data from Firestore. Please check the console for details.</td></tr>';
      document.getElementById('draft-table-body').innerHTML = errorMsg;
      if(document.getElementById('pick-summary').querySelector('.loading')) {
        document.getElementById('pick-summary').innerHTML = '<div class="error" style="text-align:center;">Summary unavailable due to data loading error.</div>';
      }
  }
}

// --- UI and Filtering Logic ---
function setupFilters() {
  const teamOptions = allTeams
    .filter(team => team.team_id && team.team_name && team.team_id !== "FA") 
    .sort((a, b) => a.team_name.localeCompare(b.team_name))
    .map(team => `<option value="${escapeHTML(team.team_id)}">${escapeHTML(team.team_name)}</option>`) 
    .join('');
  document.getElementById('owner-filter').innerHTML = 
    '<option value="all">All Teams</option>' + teamOptions;
  
  ['round-filter', 'owner-filter', 'status-filter'].forEach(filterId => {
    document.getElementById(filterId).addEventListener('change', displayDraftBoard);
  });
}

function getFilteredPicks() {
  const roundFilter = document.getElementById('round-filter').value;
  const ownerFilter = document.getElementById('owner-filter').value;
  const statusFilter = document.getElementById('status-filter').value;
  
  return allDraftPicks.filter(pick => {
    if (parseInt(pick.season) !== currentSeason) return false;
    if (roundFilter !== 'all' && parseInt(pick.round) !== parseInt(roundFilter)) return false;
    if (ownerFilter !== 'all' && pick.current_owner !== ownerFilter) return false;
    
    if (statusFilter !== 'all') {
      const isOriginal = pick.current_owner === pick.original_team;
      const isPendingForfeiture = pick.notes && pick.notes.toUpperCase() === 'PENDING FORFEITURE';
      
      if (statusFilter === 'original' && !isOriginal) return false;
      if (statusFilter === 'traded' && (isOriginal || isPendingForfeiture)) return false; 
      if (statusFilter === 'pending_forfeiture' && !isPendingForfeiture) return false;
    }
    return true;
  });
}

function displayDraftBoard() {
  document.getElementById('draft-title').textContent = `Season ${currentSeason} Draft Picks`;
  if (currentView === 'table') {
    displayTableView();
  } else {
    displayTeamView();
  }
}

function displayTableView() {
  const filteredPicks = getFilteredPicks();
  
  const totalPicks = filteredPicks.length;
  const originalPicksCount = filteredPicks.filter(p => p.current_owner === p.original_team && !(p.notes && p.notes.toUpperCase() === 'PENDING FORFEITURE')).length;
  const pendingForfeiturePicksCount = filteredPicks.filter(p => p.notes && p.notes.toUpperCase() === 'PENDING FORFEITURE').length;
  const tradedPicksCount = filteredPicks.filter(p => p.current_owner !== p.original_team && !(p.notes && p.notes.toUpperCase() === 'PENDING FORFEITURE')).length;
  
  document.getElementById('pick-summary').innerHTML = `
    <div class="summary-grid">
      <div class="summary-item"><div class="summary-number">${totalPicks}</div><div class="summary-label">Total Picks</div></div>
      <div class="summary-item"><div class="summary-number">${originalPicksCount}</div><div class="summary-label">Original Owner</div></div>
      <div class="summary-item"><div class="summary-number">${tradedPicksCount}</div><div class="summary-label">Traded</div></div>
      <div class="summary-item"><div class="summary-number">${pendingForfeiturePicksCount}</div><div class="summary-label">Pending Forfeiture</div></div>
    </div>`;
  
  const sortedPicks = filteredPicks.sort((a, b) => {
    const teamNameA = getTeamName(a.original_team);
    const teamNameB = getTeamName(b.original_team);
    if (teamNameA < teamNameB) return -1;
    if (teamNameA > teamNameB) return 1;
    const roundA = parseInt(a.round);
    const roundB = parseInt(b.round);
    if (roundA !== roundB) return roundA - roundB;
    return (a.pick_description || '').localeCompare(b.pick_description || '');
  });
  
  const tableHTML = sortedPicks.map(pick => {
    const isPendingForfeiture = pick.notes && pick.notes.toUpperCase() === 'PENDING FORFEITURE';
    let rowClass = isPendingForfeiture ? 'forfeited-pick' : '';
    let tradeStatusText = '';
    let finalTradeStatusHTML = '';

    const safePickDescription = escapeHTML(pick.pick_description);
    const currentOwnerHTML = `<a href="team.html?id=${pick.current_owner}">${escapeHTML(getTeamName(pick.current_owner))}</a>`;
    const originalTeamHTML = `<a href="team.html?id=${pick.original_team}">${escapeHTML(getTeamName(pick.original_team))}</a>`;
    
    if (isPendingForfeiture) {
      tradeStatusText = 'Pending Forfeiture';
      finalTradeStatusHTML = escapeHTML(tradeStatusText);
    } else if (pick.current_owner !== pick.original_team) {
      
      const relevantTransactions = (allTransactionsLogData || [])
          .filter(t => t.type === 'TRADE' && t.involved_picks?.some(p => p.id === pick.pick_id && p.to === pick.current_owner));
      
      if (relevantTransactions.length > 0) {
          const lastAcquisition = relevantTransactions[0];
          const pickInTrade = lastAcquisition.involved_picks.find(p => p.id === pick.pick_id);
          const fromTeamId = pickInTrade.from;

          if (fromTeamId === pick.original_team) {
              tradeStatusText = `Acquired from ${getTeamName(pick.original_team)}`;
          } else {
              tradeStatusText = `Acquired via ${getTeamName(fromTeamId)}`;
          }
          
          // **FIXED**: Generate link using the unique transaction_id
          const tradeId = lastAcquisition.transaction_id;
          if (tradeId) {
              const transactionsLink = `transactions.html?id=${tradeId}`;
              const titleDate = lastAcquisition.date?.toDate ? new Date(lastAcquisition.date.toDate()).toLocaleString() : 'View transaction';
              finalTradeStatusHTML = `<a href="${transactionsLink}" title="${titleDate}">${escapeHTML(tradeStatusText)}</a>`;
          } else {
              finalTradeStatusHTML = escapeHTML(tradeStatusText);
          }

      } else {
          tradeStatusText = `Acquired from ${getTeamName(pick.original_team)}`;
          finalTradeStatusHTML = escapeHTML(tradeStatusText);
      }

    } else {
      tradeStatusText = 'Original Owner';
      finalTradeStatusHTML = `<span class="status-original">${escapeHTML(tradeStatusText)}</span>`;
    }
    
    let originalTeamCellClasses = "owner-cell"; 
    if (pick.current_owner !== pick.original_team && !isPendingForfeiture) { 
      originalTeamCellClasses += " original-team-cell-traded";
    }

    return `
      <tr class="${rowClass}">
        <td class="pick-description">${safePickDescription}</td>
        <td class="owner-cell"><div class="cell-content-flex">${getTeamLogoHTML(pick.current_owner)} ${currentOwnerHTML}</div></td>
        <td class="${originalTeamCellClasses}"><div class="cell-content-flex">${getTeamLogoHTML(pick.original_team)} ${originalTeamHTML}</div></td>
        <td>${finalTradeStatusHTML}</td>
      </tr>
    `;
  }).join('');
  
  const colSpanForMessages = 4; 
  document.getElementById('draft-table-body').innerHTML = tableHTML || 
    `<tr><td colspan="${colSpanForMessages}" style="text-align: center; padding: 2rem; color: #666;">No picks match your filters for this season.</td></tr>`;
}

function displayTeamView() {
  const seasonPicks = allDraftPicks.filter(pick => parseInt(pick.season) === currentSeason);
  const teamPicksMap = {};
  allTeams.forEach(team => {
      if (team.team_id && team.team_id !== "FA") { 
           teamPicksMap[team.team_id] = seasonPicks.filter(pick => pick.current_owner === team.team_id);
      }
  });
  
  const teamHTML = Object.entries(teamPicksMap)
    .sort(([teamIdA], [teamIdB]) => getTeamName(teamIdA).localeCompare(getTeamName(teamIdB)))
    .map(([teamId, picks]) => {
      if (picks.length === 0) return ''; 
      const team = allTeams.find(t => t.team_id === teamId);
      const safeTeamName = escapeHTML(team.team_name);
      const pickCount = picks.length;

      const sortedPicks = picks.sort((a, b) => {
        const roundA = parseInt(a.round);
        const roundB = parseInt(b.round);
        if (roundA !== roundB) return roundA - roundB;
        return (a.pick_description || '').localeCompare(b.pick_description || '');
      });
      
      return `
        <div class="team-card">
          <div class="team-header">
            ${getTeamLogoHTML(teamId)} 
            <h4>${safeTeamName}</h4>
            <span>(${pickCount} pick${pickCount !==1 ? 's' : ''})</span>
          </div>
          <div class="team-picks">
            ${sortedPicks.map(pick => {
              const isOwn = pick.current_owner === pick.original_team;
              const isPendingForfeiture = pick.notes && pick.notes.toUpperCase() === 'PENDING FORFEITURE';
              let originText = '';
              if (isPendingForfeiture) { 
                  originText = '<div class="pick-origin" style="color: #dc3545;">PENDING FORFEITURE</div>'; 
              } else if (!isOwn) {
                  originText = `<div class="pick-origin">from ${escapeHTML(getTeamName(pick.original_team))}</div>`;
              }
              
              let pickItemClass = isOwn && !isPendingForfeiture ? 'own' : 'acquired';
              if (isPendingForfeiture) pickItemClass = 'forfeited-pick'; 

              return `
                <div class="pick-item ${pickItemClass}">
                  ${escapeHTML(pick.pick_description)}
                  ${originText}
                </div>
              `;
            }).join('') || '<div class="pick-item" style="text-align:center; color:#999;">No picks in selected filters.</div>'}
          </div>
        </div>
      `;
    }).join('');
  
  document.getElementById('team-view').innerHTML = teamHTML || 
    '<div class="error" style="grid-column: 1 / -1;">No teams hold picks for this season or matching current filters.</div>';
}

// --- Page Listeners ---
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.season-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const newSeason = parseInt(tab.dataset.season);
      if (newSeason === currentSeason && allDraftPicks.length > 0) return; 

      document.querySelectorAll('.season-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentSeason = newSeason;

      displayDraftBoard();
    });
  });
  
  document.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentView = btn.dataset.view;
      
      const filterControlsElement = document.getElementById('filter-controls'); 

      if (currentView === 'table') {
        document.getElementById('table-view').style.display = 'block';
        document.getElementById('team-view').style.display = 'none';
        if (filterControlsElement) filterControlsElement.style.display = 'block'; 
      } else {
        document.getElementById('table-view').style.display = 'none';
        document.getElementById('team-view').style.display = 'grid';
        if (filterControlsElement) filterControlsElement.style.display = 'none'; 
      }
      displayDraftBoard(); 
    });
  });
  
  const initialFilterControlsElement = document.getElementById('filter-controls');
  if (initialFilterControlsElement) { 
      if (currentView === 'table') {
          initialFilterControlsElement.style.display = 'block';
      } else {
          initialFilterControlsElement.style.display = 'none';
      }
  }

  loadData();
});