// /js/teams.js
import {
  db,
  collection,
  getDocs,
  doc,
  query,
  where,
  collectionGroup,
  collectionNames,
  getLeagueCollectionName,
  getCurrentLeague
} from './firebase-init.js';

// Get season from path (/S8/ or /S9/), URL parameter, or default to S9
const urlParams = new URLSearchParams(window.location.search);
const pathMatch =  window.location.pathname.match(/\/S(\d+)\//);
const seasonFromPath = pathMatch ? `S${pathMatch[1]}` : null;
const SEASON_ID = seasonFromPath || urlParams.get('season') || 'S9';

function getPlayoffIndicator(rankInConference) {
  if (rankInConference <= 6) {
    return `<div class="playoff-position playoff-seed">${rankInConference}</div>`;
  } else if (rankInConference <= 10) {
    return `<div class="playoff-position playin-seed">${rankInConference}</div>`;
  } else {
    return `<div class="playoff-position eliminated">${rankInConference}</div>`;
  }
}

function getPAMClass(pam) {
  const pamValue = parseFloat(pam);
  if (pamValue > 0) return 'pam-positive';
  if (pamValue < 0) return 'pam-negative';
  return '';
}

function getRecordClass(wins, losses) {
  const w = parseInt(wins || 0);
  const l = parseInt(losses || 0);
  if (w > l) return 'record-positive';
  if (l > w) return 'record-negative';
  return '';
}

function generateTeamCard(team, rankInConference) {
  const wins = parseInt(team.wins || 0);
  const losses = parseInt(team.losses || 0);
  const pam = parseFloat(team.pam || 0);
  const medStarterRank = parseFloat(team.med_starter_rank || 0);
  const cardClass = rankInConference > 10 ? 'eliminated-from-playoffs' : '';
  const totalTransactions = team.total_transactions || 0;

  return `
    <a href="team.html?id=${team.id}" class="team-card ${cardClass}">
      ${getPlayoffIndicator(rankInConference)}
      <div class="team-header">
        <img src="../icons/${team.id}.webp"
             alt="${team.team_name}"
             class="team-logo"
             onerror="this.onerror=null; this.src='../icons/FA.webp';" loading="lazy">
        <div class="team-info">
          <div class="team-name">${team.team_name}</div>
          <div class="team-id">${team.id}</div>
          <div class="gm-name">GM: ${team.current_gm_handle || 'N/A'}</div>
        </div>
      </div>
      
      <div class="team-stats">
        <div class="stat-item">
          <div class="stat-value ${getRecordClass(wins, losses)}">${wins}-${losses}</div>
          <div class="stat-label">Record</div>
        </div>
        <div class="stat-item">
          <div class="stat-value ${getPAMClass(pam)}">${Math.round(pam).toLocaleString()}</div>
          <div class="stat-label">PAM</div>
        </div>
        <div class="stat-item stat-desktop-only">
          <div class="stat-value">${medStarterRank > 0 ? Math.round(medStarterRank) : '-'}</div>
          <div class="stat-label">Med Rank</div>
        </div>
        <div class="stat-item stat-desktop-only">
          <div class="stat-value">${totalTransactions}</div>
          <div class="stat-label">Transactions</div>
        </div>
      </div>
    </a>
  `;
}

async function loadTeams() {
  const easternTeamsGrid = document.getElementById('eastern-teams');
  const westernTeamsGrid = document.getElementById('western-teams');

  // Get conference headers by traversing from the teams grids
  const easternHeader = easternTeamsGrid.closest('.conference-section')?.querySelector('.conference-header h3');
  const westernHeader = westernTeamsGrid.closest('.conference-section')?.querySelector('.conference-header h3');

  // Determine conference names based on current league
  const currentLeague = getCurrentLeague();
  const isMinorLeague = currentLeague === 'minor';
  const conference1 = isMinorLeague ? 'Northern' : 'Eastern';
  const conference2 = isMinorLeague ? 'Southern' : 'Western';

  // Update conference headers
  if (easternHeader) {
    easternHeader.textContent = `${conference1} Conference`;
    console.log(`Updated first conference header to: ${conference1} Conference`);
  } else {
    console.error('Could not find eastern conference header');
  }

  if (westernHeader) {
    westernHeader.textContent = `${conference2} Conference`;
    console.log(`Updated second conference header to: ${conference2} Conference`);
  } else {
    console.error('Could not find western conference header');
  }

  easternTeamsGrid.innerHTML = `<div class="loading">Loading ${conference1} Conference teams...</div>`;
  westernTeamsGrid.innerHTML = `<div class="loading">Loading ${conference2} Conference teams...</div>`;

  console.log("Attempting to load teams for season:", SEASON_ID, "League:", currentLeague);
  try {
    const teamsRef = collection(db, collectionNames.teams);
    const recordsQuery = query(
      collectionGroup(db, collectionNames.seasonalRecords),
      where('seasonId', '==', SEASON_ID)
    );

    console.log("Starting parallel Firestore queries...");
    const [teamsSnap, recordsSnap] = await Promise.all([
        getDocs(teamsRef),
        getDocs(recordsQuery)
    ]);

    console.log(`- Teams collection query: Found ${teamsSnap.docs.length} documents.`);
    console.log(`- Seasonal records collection group query: Found ${recordsSnap.docs.length} documents.`);

    if (teamsSnap.empty) {
        easternTeamsGrid.innerHTML = '<p class="error" style="grid-column: 1 / -1;">No teams found or data error.</p>';
        westernTeamsGrid.innerHTML = '<p class="error" style="grid-column: 1 / -1;">No teams found or data error.</p>';
        return;
    }

    const seasonalRecordsMap = new Map();
    recordsSnap.forEach(doc => {
        // Server-side filtered by seasonId - all results match SEASON_ID
        const teamId = doc.ref.parent.parent.id;
        seasonalRecordsMap.set(teamId, doc.data());
    });
    console.log("Seasonal records map created with size:", seasonalRecordsMap.size);

    const allTeams = [];
    teamsSnap.docs.forEach(teamDoc => {
        const teamData = teamDoc.data();
        const seasonalRecord = seasonalRecordsMap.get(teamDoc.id);

        if (seasonalRecord && (teamData.conference === conference1 || teamData.conference === conference2)) {
            const combinedData = {
                id: teamDoc.id,
                ...teamData,
                ...seasonalRecord
            };
            allTeams.push(combinedData);
        }
    });

    console.log("Total valid teams found with records:", allTeams.length);

    const conference1Teams = allTeams
      .filter(team => team.conference === conference1)
      .sort((a, b) => {
        const winsA = parseInt(a.wins || 0);
        const winsB = parseInt(b.wins || 0);
        if (winsB !== winsA) return winsB - winsA;
        return parseFloat(b.pam || 0) - parseFloat(a.pam || 0);
      });

    const conference2Teams = allTeams
      .filter(team => team.conference === conference2)
      .sort((a, b) => {
        const winsA = parseInt(a.wins || 0);
        const winsB = parseInt(b.wins || 0);
        if (winsB !== winsA) return winsB - winsA;
        return parseFloat(b.pam || 0) - parseFloat(a.pam || 0);
      });

    console.log(`${conference1} teams to display:`, conference1Teams.length);
    console.log(`${conference2} teams to display:`, conference2Teams.length);

    const conference1HTML = conference1Teams.map((team, index) => generateTeamCard(team, index + 1)).join('');
    const conference2HTML = conference2Teams.map((team, index) => generateTeamCard(team, index + 1)).join('');

    easternTeamsGrid.innerHTML = conference1HTML || `<p class="error" style="grid-column: 1 / -1;">No ${conference1} Conference teams found.</p>`;
    westernTeamsGrid.innerHTML = conference2HTML || `<p class="error" style="grid-column: 1 / -1;">No ${conference2} Conference teams found.</p>`;

  } catch (error) {
    console.error("Error loading teams from Firestore:", error);
    easternTeamsGrid.innerHTML = '<p class="error" style="grid-column: 1 / -1;">Error loading team data.</p>';
    westernTeamsGrid.innerHTML = '<p class="error" style="grid-column: 1 / -1;">Error loading team data.</p>';
  }
}

document.addEventListener('DOMContentLoaded', loadTeams);

// Reload teams when league changes
window.addEventListener('leagueChanged', (event) => {
    const newLeague = event.detail.league;
    console.log('League changed to:', newLeague);

    // Hide content during transition
    const mainElement = document.querySelector('main');
    if (mainElement) mainElement.style.opacity = '0';

    // Small delay before reloading to ensure fade-out completes
    setTimeout(() => {
        loadTeams();

        // Show content after reload
        setTimeout(() => {
            if (mainElement) mainElement.style.opacity = '1';
        }, 100);
    }, 150);
});
