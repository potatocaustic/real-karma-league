// /js/postseason-team.js
import { db, collection, doc, getDoc, getDocs, query, where, collectionGroup } from './firebase-init.js';
import { generateLineupTable } from './main.js';

const SEASON_ID = 'S8';
const USE_DEV_COLLECTIONS = false;
const getCollectionName = (baseName) => USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;

// --- Global State ---
let teamId = null;
let currentTeamData = null;
let allTeamsData = new Map();
let allGamesData = new Map();
let rosterPlayerData = new Map();
let rosterSortState = { column: 'rel', direction: 'desc' };

/**
 * Generates and injects CSS rules for team logos.
 */
function generateIconStylesheet() {
    let iconStyles = '';
    allTeamsData.forEach(team => {
        const className = `icon-${team.id.replace(/[^a-zA-Z0-9]/g, '')}`;
        iconStyles += `.${className} { background-image: url('../icons/${team.id}.webp'); }\n`;
    });
    const styleElement = document.getElementById('team-icon-styles');
    if (styleElement) {
        styleElement.innerHTML = `
            .team-logo-css { background-size: cover; background-position: center; ... }
            ${iconStyles}
        `;
    }
}

/**
 * Displays the main team header with postseason stats.
 */
function displayTeamHeader() {
    document.title = `${currentTeamData.team_name} - S8 Postseason`;
    
    const regularSeasonBtn = document.getElementById('regular-season-btn');
    if (regularSeasonBtn) {
        regularSeasonBtn.href = `team.html?id=${teamId}`;
        regularSeasonBtn.style.display = 'inline-block';
    }

    const teamIdClassName = `icon-${currentTeamData.id.replace(/[^a-zA-Z0-9]/g, '')}`;
    const gmHandle = currentTeamData.gm_player_id ? allTeamsData.get(currentTeamData.id)?.gm_player_handle || 'N/A' : 'N/A';

    document.getElementById('team-main-info').innerHTML = `
        <div class="team-logo-css team-logo-large ${teamIdClassName}" role="img" aria-label="${currentTeamData.team_name}"></div>
        <div class="team-details">
            <h2>${currentTeamData.team_name}</h2>
            <div class="postseason-subtitle">Postseason Profile</div>
            <div class="team-subtitle">${currentTeamData.id} • ${currentTeamData.conference} Conference</div>
            <a href="player.html?id=${currentTeamData.gm_player_id}" class="gm-info">General Manager: ${gmHandle}</a>
        </div>
    `;

    const wins = currentTeamData.post_wins || 0;
    const losses = currentTeamData.post_losses || 0;
    const pam = currentTeamData.post_pam || 0;
    const medRank = currentTeamData.post_med_starter_rank || 0;

    const getRecordClass = (w, l) => w > l ? 'positive' : l > w ? 'negative' : '';
    const getPamClass = p => p > 0 ? 'positive' : p < 0 ? 'negative' : '';
    
    const statsContainer = document.getElementById('team-stats');
    statsContainer.innerHTML = `
        <div class="stat-card">
            <div class="stat-value ${getRecordClass(wins, losses)}">${wins}-${losses}</div>
            <div class="stat-label">Postseason Record</div>
        </div>
        <div class="stat-card">
            <div class="stat-value ${getPamClass(pam)}">${Math.round(pam).toLocaleString()}</div>
            <div class="stat-label">Postseason PAM</div>
            <div class="stat-rank">${currentTeamData.post_pam_rank ? `${currentTeamData.post_pam_rank}th` : ''}</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${medRank > 0 ? Math.round(medRank) : '-'}</div>
            <div class="stat-label">Median Starter Rank</div>
            <div class="stat-rank">${currentTeamData.post_msr_rank ? `${currentTeamData.post_msr_rank}th` : ''}</div>
        </div>
    `;
    statsContainer.style.display = 'grid';
}

/**
 * Renders the team's roster with postseason stats.
 */
function displayRoster() {
    const rosterContainer = document.getElementById('roster-list');
    const teamPlayers = Array.from(rosterPlayerData.values());

    if (teamPlayers.length === 0) {
        rosterContainer.innerHTML = '<div class="loading">No active players on roster.</div>';
        return;
    }

    teamPlayers.sort((a, b) => {
        const col = rosterSortState.column;
        const dir = rosterSortState.direction === 'asc' ? 1 : -1;
        const valA = col === 'rel' ? (a.post_rel_median || 0) : (a.post_WAR || 0);
        const valB = col === 'rel' ? (b.post_rel_median || 0) : (b.post_WAR || 0);
        if (valA < valB) return -1 * dir;
        if (valA > valB) return 1 * dir;
        return 0;
    });
    
    const teamIdClassName = `icon-${teamId.replace(/[^a-zA-Z0-9]/g, '')}`;
    const rosterHTML = teamPlayers.map(player => `
        <div class="player-item">
            <div class="roster-player-logo-col desktop-only-roster-logo">
                <div class="team-logo-css ${teamIdClassName}" style="width: 24px; height: 24px;"></div>
            </div>
            <div class="player-info">
                <a href="postseason-player.html?id=${player.id}" class="player-name">${player.player_handle}${player.rookie === '1' ? ' <span class="rookie-badge">R</span>' : ''}${player.all_star === '1' ? ' <span class="all-star-badge">★</span>' : ''}</a>
                <div class="player-stats">${player.post_games_played || 0} GP • ${player.post_medrank > 0 ? Math.round(player.post_medrank) : '-'} Med Rank</div>
            </div>
            <div class="player-rel">${(player.post_rel_median || 0).toFixed(3)}</div>
            <div class="player-war">${(player.post_WAR || 0).toFixed(2)}</div>
        </div>
    `).join('');

    const relIndicator = rosterSortState.column === 'rel' ? (rosterSortState.direction === 'desc' ? ' ▼' : ' ▲') : '';
    const warIndicator = rosterSortState.column === 'war' ? (rosterSortState.direction === 'desc' ? ' ▼' : ' ▲') : '';
    
    rosterContainer.innerHTML = `
        <div class="roster-header">
            <span class="desktop-only-roster-logo"></span>
            <span class="header-player">Player</span>
            <span class="header-rel sortable" onclick="window.handleRosterSort('rel')">REL<span class="sort-indicator">${relIndicator}</span></span>
            <span class="header-war sortable" onclick="window.handleRosterSort('war')">WAR<span class="sort-indicator">${warIndicator}</span></span>
        </div>
        <div class="roster-content">${rosterHTML}</div>
    `;
}

// Attach sort handler to window
window.handleRosterSort = (column) => {
    if (rosterSortState.column === column) {
        rosterSortState.direction = rosterSortState.direction === 'desc' ? 'asc' : 'desc';
    } else {
        rosterSortState.column = column;
        rosterSortState.direction = 'desc';
    }
    displayRoster();
};


/**
 * Renders the team's postseason schedule.
 */
function displaySchedule() {
    const scheduleContainer = document.getElementById('team-schedule');
    const teamGames = Array.from(allGamesData.values())
        .filter(game => game.team1_id === teamId || game.team2_id === teamId)
        .sort((a, b) => new Date(a.date.replace(/-/g, '/')) - new Date(b.date.replace(/-/g, '/')));

    if (teamGames.length === 0) {
        scheduleContainer.innerHTML = '<div class="loading">No postseason games found.</div>';
        return;
    }

    const getWeekAbbreviation = (weekName) => {
        if (!weekName) return 'TBD';
        const lower = weekName.toLowerCase();
        if (lower.includes('play-in')) return 'PI';
        if (lower.includes('round 1')) return 'R1';
        if (lower.includes('round 2')) return 'R2';
        if (lower.includes('conf finals')) return 'CF';
        if (lower.includes('finals')) return 'F';
        return weekName;
    };

    scheduleContainer.innerHTML = teamGames.map(game => {
        const isTeam1 = game.team1_id === teamId;
        const opponentId = isTeam1 ? game.team2_id : game.team1_id;
        const opponent = allTeamsData.get(opponentId) || { team_name: 'TBD', id: 'TBD' };
        
        const isCompleted = game.completed === 'TRUE';
        const teamScore = isTeam1 ? game.team1_score : game.team2_score;
        const oppScore = isTeam1 ? game.team2_score : game.team1_score;
        const isWin = isCompleted && game.winner === teamId;
        const isLoss = isCompleted && game.winner === opponentId;

        return `
            <div class="game-item" ${isCompleted ? `onclick="window.showGameDetails('${game.id}', 'post_games')"` : ''}>
                <div class="game-info-table">
                    <div class="week-cell"><div class="week-badge">${getWeekAbbreviation(game.week)}</div></div>
                    <div class="date-cell"><div class="date-badge">${new Date(game.date.replace(/-/g, '/')).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' })}</div></div>
                </div>
                <div class="game-content-table">
                     <div class="team-section left">
                        <img src="../icons/${teamId}.webp" class="team-logo-css" style="width:32px; height:32px;">
                        <div class="team-details"><div class="team-name-game">${currentTeamData.team_name}</div></div>
                    </div>
                    <div class="scores-section">
                        <div class="score ${isWin ? 'win' : ''}">${isCompleted ? Math.round(teamScore) : '-'}</div>
                        <div class="vs-text">vs</div>
                        <div class="score ${isLoss ? 'win' : ''}">${isCompleted ? Math.round(oppScore) : '-'}</div>
                    </div>
                    <div class="team-section right">
                        <img src="../icons/${opponent.id}.webp" class="team-logo-css" style="width:32px; height:32px;">
                        <div class="team-details right"><div class="team-name-game">${opponent.team_name}</div></div>
                    </div>
                </div>
            </div>`;
    }).join('');
}


/**
 * Main data loading function.
 */
async function loadTeamData() {
    teamId = new URLSearchParams(window.location.search).get('id');
    if (!teamId) {
        document.querySelector('main').innerHTML = '<div class="error">No team ID provided.</div>';
        return;
    }

    try {
        // Parallelize Firestore fetches
        const teamsQuery = query(collection(db, getCollectionName('v2_teams')));
        const recordsQuery = query(collectionGroup(db, getCollectionName('seasonal_records')), where('season', '==', SEASON_ID));
        const playersQuery = query(collection(db, getCollectionName('v2_players')));
        const gamesQuery = query(collection(db, getCollectionName('seasons'), SEASON_ID, getCollectionName('post_games')));
        
        const [teamsSnap, recordsSnap, playersSnap, gamesSnap] = await Promise.all([
            getDocs(teamsQuery),
            getDocs(recordsQuery),
            getDocs(playersQuery),
            getDocs(gamesQuery)
        ]);

        // Process Teams and Records
        const recordsMap = new Map();
        recordsSnap.forEach(doc => recordsMap.set(doc.ref.parent.parent.id, doc.data()));

        teamsSnap.forEach(doc => {
            const teamData = { id: doc.id, ...doc.data(), ...recordsMap.get(doc.id) };
            allTeamsData.set(doc.id, teamData);
            if (doc.id === teamId) {
                currentTeamData = teamData;
            }
        });

        // Process Players for Roster and GM lookup
        const playerStatsPromises = playersSnap.docs.map(doc => 
            getDoc(collection(doc.ref, getCollectionName('seasonal_stats')).doc(SEASON_ID))
        );
        const playerStatsSnaps = await Promise.all(playerStatsPromises);

        playersSnap.forEach((doc, i) => {
            const playerData = { id: doc.id, ...doc.data() };
            if (playerStatsSnaps[i].exists()) {
                Object.assign(playerData, playerStatsSnaps[i].data());
            }
            if (playerData.current_team_id === teamId && playerData.player_status === 'ACTIVE') {
                rosterPlayerData.set(playerData.id, playerData);
            }
            // Add GM handle to team data
            if (currentTeamData && playerData.id === currentTeamData.gm_player_id) {
                allTeamsData.get(teamId).gm_player_handle = playerData.player_handle;
            }
        });
        
        // Process Games
        gamesSnap.forEach(doc => allGamesData.set(doc.id, { id: doc.id, ...doc.data() }));

        if (!currentTeamData) {
            throw new Error("Team data not found.");
        }
        
        generateIconStylesheet();
        displayTeamHeader();
        displayRoster();
        displaySchedule();

    } catch (error) {
        console.error("Error loading team data:", error);
        document.querySelector('main').innerHTML = `<div class="error">Failed to load team data: ${error.message}</div>`;
    }
}

document.addEventListener('DOMContentLoaded', loadTeamData);