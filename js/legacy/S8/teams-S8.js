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
  getLeagueCollectionName
} from '../../firebase-init.js';

const SEASON_ID = 'S8';

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
             onerror="this.onerror=null; this.src='../icons/FA.webp';">
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
  easternTeamsGrid.innerHTML = '<div class="loading">Loading Eastern Conference teams...</div>';
  westernTeamsGrid.innerHTML = '<div class="loading">Loading Western Conference teams...</div>';

  console.log("Attempting to load teams for season:", SEASON_ID);
  try {
    const teamsRef = collection(db, collectionNames.teams);
    const recordsQuery = query(collectionGroup(db, collectionNames.seasonalRecords));

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
        // Only process documents that match the current season ID
        if (doc.id === SEASON_ID) {
            const teamId = doc.ref.parent.parent.id;
            seasonalRecordsMap.set(teamId, doc.data());
        }
    });
    console.log("Seasonal records map created with size:", seasonalRecordsMap.size);

    const allTeams = [];
    teamsSnap.docs.forEach(teamDoc => {
        const teamData = teamDoc.data();
        const seasonalRecord = seasonalRecordsMap.get(teamDoc.id);

        if (seasonalRecord && (teamData.conference === 'Eastern' || teamData.conference === 'Western')) {
            const combinedData = {
                id: teamDoc.id,
                ...teamData,
                ...seasonalRecord
            };
            allTeams.push(combinedData);
        }
    });

    console.log("Total valid teams found with records:", allTeams.length);

    const easternTeams = allTeams
      .filter(team => team.conference === 'Eastern')
      .sort((a, b) => {
        const winsA = parseInt(a.wins || 0);
        const winsB = parseInt(b.wins || 0);
        if (winsB !== winsA) return winsB - winsA;
        return parseFloat(b.pam || 0) - parseFloat(a.pam || 0);
      });
      
    const westernTeams = allTeams
      .filter(team => team.conference === 'Western')
      .sort((a, b) => {
        const winsA = parseInt(a.wins || 0);
        const winsB = parseInt(b.wins || 0);
        if (winsB !== winsA) return winsB - winsA;
        return parseFloat(b.pam || 0) - parseFloat(a.pam || 0);
      });

    console.log("Eastern teams to display:", easternTeams.length);
    console.log("Western teams to display:", westernTeams.length);

    const easternHTML = easternTeams.map((team, index) => generateTeamCard(team, index + 1)).join('');
    const westernHTML = westernTeams.map((team, index) => generateTeamCard(team, index + 1)).join('');
    
    easternTeamsGrid.innerHTML = easternHTML || '<p class="error" style="grid-column: 1 / -1;">No Eastern Conference teams found.</p>';
    westernTeamsGrid.innerHTML = westernHTML || '<p class="error" style="grid-column: 1 / -1;">No Western Conference teams found.</p>';

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
    loadTeams();
});
