// /js/player.js
import { db, collection, doc, getDoc, getDocs, query, where, limit } from './firebase-init.js';
import { generateLineupTable } from './main.js';

// --- Configuration ---
// Mimics the USE_DEV_COLLECTIONS flag from your Cloud Functions (index.js)
// Set to `true` to use collections ending in `_dev`, `false` for production.
const USE_DEV_COLLECTIONS = true; 
const SEASON_ID = 'S8';

// --- Global State ---
let allTeamsData = new Map();
let allGamesData = new Map();
let playerLineups = [];
let currentPlayer = null;

/**
 * Gets the correct Firestore collection name based on the environment.
 * @param {string} baseName The base name of the collection (e.g., 'v2_players').
 * @returns {string} The collection name with a '_dev' suffix if in development mode.
 */
const getCollectionName = (baseName) => {
    return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
};

/**
 * Generates and injects CSS rules for team logos.
 * @param {Map<string, object>} teams - A map of team data objects.
 */
function generateIconStylesheet(teams) {
    let iconStyles = '';
    teams.forEach(team => {
        const className = `icon-${team.id.replace(/[^a-zA-Z0-9]/g, '')}`;
        iconStyles += `.${className} { background-image: url('../icons/${team.id}.webp'); }\n`;
    });
    const faIconStyle = ".icon-FREE_AGENT { background-image: url('../icons/FA.webp'); }";
    const styleElement = document.getElementById('team-icon-styles');
    if (styleElement) {
        styleElement.innerHTML = `
            .team-logo-css {
                background-size: cover;
                background-position: center;
                background-repeat: no-repeat;
                display: inline-block;
                vertical-align: middle;
                flex-shrink: 0;
            }
            ${iconStyles}
            ${faIconStyle}
        `;
    }
}

/**
 * Fetches all necessary data from Firestore to build the player page.
 */
async function loadPlayerData() {
    const playerHandle = new URLSearchParams(window.location.search).get('player');
    if (!playerHandle) {
        document.getElementById('player-main-info').innerHTML = '<div class="error">No player specified.</div>';
        return;
    }
    
    document.getElementById('page-title').textContent = `${playerHandle} - RKL ${SEASON_ID}`;

    try {
        // 1. Fetch the Player's core data and seasonal stats
        const playerQuery = query(collection(db, getCollectionName('v2_players')), where('player_handle', '==', playerHandle), limit(1));
        const playerSnap = await getDocs(playerQuery);

        if (playerSnap.empty) {
            document.getElementById('player-main-info').innerHTML = `<div class="error">Player '${playerHandle}' not found.</div>`;
            return;
        }

        const playerDoc = playerSnap.docs[0];
        const playerData = playerDoc.data();
        const playerId = playerDoc.id;

        const seasonalStatsRef = doc(db, `${getCollectionName('v2_players')}/${playerId}/${getCollectionName('seasonal_stats')}/${SEASON_ID}`);
        const seasonalStatsSnap = await getDoc(seasonalStatsRef);
        const seasonalStats = seasonalStatsSnap.exists() ? seasonalStatsSnap.data() : {};

        currentPlayer = { id: playerId, ...playerData, ...seasonalStats };

        // 2. Fetch all Teams data to create a map for easy lookup
        const teamsQuery = query(collection(db, getCollectionName('v2_teams')));
        const teamsSnap = await getDocs(teamsQuery);
        for (const teamDoc of teamsSnap.docs) {
            const teamData = { id: teamDoc.id, ...teamDoc.data() };
            const teamRecordRef = doc(db, `${getCollectionName('v2_teams')}/${teamDoc.id}/${getCollectionName('seasonal_records')}/${SEASON_ID}`);
            const teamRecordSnap = await getDoc(teamRecordRef);
            if (teamRecordSnap.exists()) {
                Object.assign(teamData, teamRecordSnap.data());
            }
            allTeamsData.set(teamDoc.id, teamData);
        }
        generateIconStylesheet(allTeamsData);

        // 3. Fetch this player's lineups for the season
        const lineupsQuery = query(
            collection(db, getCollectionName('seasons'), SEASON_ID, getCollectionName('lineups')),
            where('player_id', '==', playerId),
            where('started', '==', 'TRUE')
        );
        const lineupsSnap = await getDocs(lineupsQuery);
        playerLineups = lineupsSnap.docs.map(d => d.data()).sort((a,b) => (a.week || 0) - (b.week || 0));

        // 4. Fetch all games for the season and map them by ID
        const gamesQuery = query(collection(db, getCollectionName('seasons'), SEASON_ID, getCollectionName('games')));
        const gamesSnap = await getDocs(gamesQuery);
        gamesSnap.forEach(gameDoc => {
            allGamesData.set(gameDoc.id, { id: gameDoc.id, ...gameDoc.data() });
        });
        
        // 5. Render all page components with the fetched data
        displayPlayerHeader();
        loadPerformanceData();
        loadGameHistory();

    } catch (error) {
        console.error("Error loading player data from Firestore:", error);
        document.getElementById('player-main-info').innerHTML = `<div class="error">Failed to load player data. See console for details.</div>`;
    }
}

/**
 * Displays the main player header and stat cards.
 */
function displayPlayerHeader() {
    const isFreeAgent = !currentPlayer.current_team_id || currentPlayer.current_team_id === 'FREE_AGENT';
    const teamId = isFreeAgent ? 'FREE_AGENT' : currentPlayer.current_team_id;
    const team = allTeamsData.get(teamId) || { team_name: 'Free Agent', id: 'FREE_AGENT' };
    const teamIdClassName = `icon-${team.id.replace(/[^a-zA-Z0-9]/g, '')}`;

    const teamLogoHTML = `<div class="team-logo-css team-logo-large ${teamIdClassName}" role="img" aria-label="${team.team_name}"></div>`;
    const teamInfoHTML = !isFreeAgent
        ? `<a href="team.html?id=${team.id}" class="team-info">Current Team: ${team.team_name}</a>`
        : `<div class="team-info" style="color:#6c757d; cursor:default;">Current Team: Free Agent</div>`;

    const isAllStar = currentPlayer.all_star === '1';
    const isRookie = currentPlayer.rookie === '1';

    document.getElementById('player-main-info').innerHTML = `
      ${teamLogoHTML}
      <div class="player-details">
        <h2>${currentPlayer.player_handle}${isRookie ? '<span class="rookie-badge">R</span>' : ''}${isAllStar ? ' <span class="all-star-badge">★</span>' : ''}</h2>
        <div class="player-subtitle">${currentPlayer.player_status} • ${currentPlayer.games_played || 0} games played</div>
        ${teamInfoHTML}
      </div>`;

    const getOrdinal = (n) => {
        if (isNaN(n) || n <= 0) return 'Unranked';
        const s = ["th", "st", "nd", "rd"], v = n % 100;
        return n + (s[(v - 20) % 10] || s[v] || s[0]);
    };
    
    const formatRank = (rank) => rank ? `${getOrdinal(rank)} Overall` : 'Unranked';

    const medianRank = currentPlayer.medrank === Infinity ? '-' : Math.round(currentPlayer.medrank || 0) || '-';

    document.getElementById('player-stats').innerHTML = `
      <a href="leaderboards.html?category=war" class="stat-card-link"><div class="stat-card">
        <div class="stat-value">${(currentPlayer.WAR || 0).toFixed(2)}</div><div class="stat-label">WAR</div><div class="stat-rank">${formatRank(currentPlayer.WAR_rank)}</div></div></a>
      <a href="leaderboards.html?category=rel_median" class="stat-card-link"><div class="stat-card">
        <div class="stat-value">${(currentPlayer.rel_median || 0).toFixed(3)}</div><div class="stat-label">REL Median</div><div class="stat-rank">${formatRank(currentPlayer.rel_median_rank)}</div></div></a>
      <a href="leaderboards.html?category=median_gameday_rank" class="stat-card-link"><div class="stat-card">
        <div class="stat-value">${medianRank}</div><div class="stat-label">Median Gameday Rank</div><div class="stat-rank">${formatRank(currentPlayer.medrank_rank)}</div></div></a>
      <a href="leaderboards.html?category=gem" class="stat-card-link"><div class="stat-card">
        <div class="stat-value">${(currentPlayer.GEM || 0).toFixed(1) || '-'}</div><div class="stat-label">GEM</div><div class="stat-rank">${formatRank(currentPlayer.GEM_rank)}</div></div></a>
      <a href="leaderboards.html?category=aag_median" class="stat-card-link"><div class="stat-card"> <div class="stat-value">${currentPlayer.aag_median || 0}</div><div class="stat-label">Games Above Median</div><div class="stat-rank">${formatRank(currentPlayer.aag_median_rank)}</div></div></a>
    `;
    document.getElementById('player-stats').style.display = 'grid';
}

/**
 * Fills the weekly performance table with the player's game data.
 */
function loadPerformanceData() {
    if (playerLineups.length === 0) {
        document.getElementById('performance-table').innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 2rem;">No games played yet this season.</td></tr>';
        return;
    }
    const formatRankBadge = (rank) => {
        if (!rank || rank <= 0) return '-';
        if (rank === 1) return `<span class="rank-badge rank-gold">1</span>`;
        if (rank === 2) return `<span class="rank-badge rank-silver">2</span>`;
        if (rank === 3) return `<span class="rank-badge rank-bronze">3</span>`;
        if (rank <= 100) return `<span class="rank-badge rank-skyblue">${rank}</span>`;
        return rank;
    };
    const performanceHTML = playerLineups.map(lineup => {
        const isCaptain = lineup.is_captain === 'TRUE';
        const points = Math.round(lineup.points_adjusted || 0);
        const captainBonus = isCaptain ? Math.round(points * 0.5) : 0;
        const game = allGamesData.get(lineup.game_id);
        const isClickable = game && game.completed === 'TRUE';

        return `<tr class="${isClickable ? 'clickable-row' : ''}" ${isClickable ? `data-gameid="${lineup.game_id}"` : ''}>
                    <td>Week ${lineup.week}${isCaptain ? '<span class="captain-badge-small">C</span>' : ''}</td>
                    <td>${points.toLocaleString()}${isCaptain ? ` (+${captainBonus.toLocaleString()})` : ''}</td>
                    <td>${formatRankBadge(lineup.global_rank)}</td>
                    <td>${isCaptain ? 'Captain' : 'Starter'}</td>
                </tr>`;
    }).join('');
    document.getElementById('performance-table').innerHTML = performanceHTML;
}

/**
 * Fills the game history list with the player's matchups.
 */
function loadGameHistory() {
    const completedGames = playerLineups.map(lineup => {
        const game = allGamesData.get(lineup.game_id);
        return (game && game.completed === 'TRUE') ? { lineup, game } : null;
    }).filter(Boolean);

    if (completedGames.length === 0) {
        document.getElementById('game-history').innerHTML = '<div style="text-align: center; padding: 2rem;">No completed game history found.</div>';
        return;
    }

    const historyHTML = completedGames.map(({ lineup, game }) => {
        const playerTeam = allTeamsData.get(lineup.team_id);
        const opponentId = game.team1_id === lineup.team_id ? game.team2_id : game.team1_id;
        const opponentTeam = allTeamsData.get(opponentId);
        
        if (!playerTeam || !opponentTeam) return ''; // Skip if team data is missing
        
        const playerTeamResult = game.winner === playerTeam.id ? 'W' : 'L';
        const opponentTeamResult = game.winner === opponentTeam.id ? 'W' : 'L';
        const playerIconClass = `icon-${playerTeam.id.replace(/[^a-zA-Z0-9]/g, '')}`;
        const opponentIconClass = `icon-${opponentTeam.id.replace(/[^a-zA-Z0-9]/g, '')}`;
        const isCaptain = lineup.is_captain === 'TRUE';
        const score = Math.round(lineup.points_adjusted || 0);

        return `
            <div class="game-item" data-gameid="${game.id}">
              <div class="game-history-main-content">
                <div class="game-history-matchup-teams">
                    <span class="game-history-team-entry">
                      <div class="team-logo-css game-history-team-logo ${playerIconClass}"></div>
                      <span class="game-history-team-name">${playerTeam.team_name} <span class="game-result-indicator game-result-${playerTeamResult.toLowerCase()}">(${playerTeamResult})</span></span>
                    </span>
                    <span class="game-history-vs-separator">vs</span>
                    <span class="game-history-team-entry">
                      <div class="team-logo-css game-history-team-logo ${opponentIconClass}"></div>
                      <span class="game-history-team-name">${opponentTeam.team_name} <span class="game-result-indicator game-result-${opponentTeamResult.toLowerCase()}">(${opponentTeamResult})</span></span>
                    </span>
                </div>
                <div class="game-history-date">${new Date(game.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} (Week ${lineup.week})</div>
              </div>
              <div class="game-performance">
                <div class="performance-score ${isCaptain ? 'captain-performance' : ''}">${score.toLocaleString()}${isCaptain ? ' (C)' : ''}</div>
                <div class="performance-rank">Rank: ${lineup.global_rank || '-'}</div>
              </div>
            </div>`;
    }).join('');
    document.getElementById('game-history').innerHTML = historyHTML;
}

/**
 * Fetches data for a specific game and displays it in the modal.
 * @param {string} gameId The ID of the game to display.
 */
async function showGameDetails(gameId) {
    const modal = document.getElementById('game-modal');
    const modalTitle = document.getElementById('modal-title');
    const modalContentArea = document.getElementById('game-details-content-area');
    
    modal.style.display = 'block';
    modalTitle.textContent = 'Game Details';
    modalContentArea.innerHTML = '<div class="loading">Loading game details...</div>';
    
    try {
        const game = allGamesData.get(gameId);
        if (!game) throw new Error("Game data not found.");

        const team1 = allTeamsData.get(game.team1_id);
        const team2 = allTeamsData.get(game.team2_id);
        
        modalTitle.textContent = `${team1.team_name} vs ${team2.team_name} - ${new Date(game.date).toLocaleDateString()}`;

        const lineupsQuery = query(
            collection(db, getCollectionName('seasons'), SEASON_ID, getCollectionName('lineups')),
            where('game_id', '==', gameId),
            where('started', '==', 'TRUE')
        );
        const lineupsSnap = await getDocs(lineupsQuery);
        
        const allGameLineups = lineupsSnap.docs.map(d => d.data());
        const team1Lineups = allGameLineups.filter(l => l.team_id === game.team1_id);
        const team2Lineups = allGameLineups.filter(l => l.team_id === game.team2_id);

        const team1HTML = generateLineupTable(team1Lineups, team1, game.winner === team1.id);
        const team2HTML = generateLineupTable(team2Lineups, team2, game.winner === team2.id);

        modalContentArea.innerHTML = `<div class="game-details-grid">${team1HTML}${team2HTML}</div>`;

    } catch (error) {
        console.error("Error showing game details:", error);
        modalContentArea.innerHTML = '<div class="error">Could not load game details.</div>';
    }
}

// --- Event Listeners ---
document.addEventListener('DOMContentLoaded', () => {
    loadPlayerData();

    const modal = document.getElementById('game-modal');
    const closeModalBtn = document.getElementById('close-modal-btn');

    // Listener for closing the modal
    const closeModal = () => modal.style.display = 'none';
    closeModalBtn.addEventListener('click', closeModal);
    window.addEventListener('click', (event) => {
        if (event.target === modal) {
            closeModal();
        }
    });

    // Delegated event listener for opening the modal from game history or performance table
    document.querySelector('main').addEventListener('click', (event) => {
        const clickableRow = event.target.closest('.clickable-row, .game-item');
        if (clickableRow && clickableRow.dataset.gameid) {
            showGameDetails(clickableRow.dataset.gameid);
        }
    });
});