// /js/player.js
import { db, collection, doc, getDoc, getDocs, query, where, documentId } from './firebase-init.js';
import { generateLineupTable } from './main.js';

// --- Configuration ---
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
 * OPTIMIZED: Fetches only the necessary data from Firestore in an efficient sequence.
 */
async function loadPlayerData() {
    const playerId = new URLSearchParams(window.location.search).get('id');
    if (!playerId) {
        document.getElementById('player-main-info').innerHTML = '<div class="error">No player ID specified in URL.</div>';
        return;
    }

    try {
        // --- Step 1: Fetch core player data and lineups in parallel ---
        const playerRef = doc(db, getCollectionName('v2_players'), playerId);
        const seasonalStatsRef = doc(db, playerRef.path, getCollectionName('seasonal_stats'), SEASON_ID);
        const lineupsQuery = query(
            collection(db, getCollectionName('seasons'), SEASON_ID, getCollectionName('lineups')),
            where('player_id', '==', playerId),
            where('started', '==', 'TRUE')
        );

        const [playerSnap, seasonalStatsSnap, lineupsSnap] = await Promise.all([
            getDoc(playerRef),
            getDoc(seasonalStatsRef),
            getDocs(lineupsQuery)
        ]);

        if (!playerSnap.exists()) {
            document.getElementById('player-main-info').innerHTML = `<div class="error">Player with ID '${playerId}' not found.</div>`;
            return;
        }
        
        const playerData = playerSnap.data();
        const seasonalStats = seasonalStatsSnap.exists() ? seasonalStatsSnap.data() : {};
        currentPlayer = { id: playerId, ...playerData, ...seasonalStats };
        playerLineups = lineupsSnap.docs.map(d => d.data()).sort((a,b) => (a.week || 0) - (b.week || 0));
        document.getElementById('page-title').textContent = `${playerData.player_handle} - RKL ${SEASON_ID}`;

        // --- Step 2: Compile lists of required game and team IDs from lineups ---
        const requiredGameIds = new Set();
        const requiredTeamIds = new Set([currentPlayer.current_team_id]);
        playerLineups.forEach(lineup => {
            requiredGameIds.add(lineup.game_id);
            requiredTeamIds.add(lineup.team_id); 
        });

        // --- Step 3: Fetch only the necessary games and teams ---
        const gamesPromise = fetchDocsInChunks(
            collection(db, getCollectionName('seasons'), SEASON_ID, getCollectionName('games')),
            Array.from(requiredGameIds)
        );
        const teamsPromise = fetchDocsInChunks(
            collection(db, getCollectionName('v2_teams')),
            Array.from(requiredTeamIds)
        );
        
        const [games, teams] = await Promise.all([gamesPromise, teamsPromise]);
        
        games.forEach(game => allGamesData.set(game.id, game));
        
        // --- Step 4: Fetch seasonal records ONLY for the required teams ---
        const teamRecordPromises = teams.map(team => getDoc(doc(db, `${getCollectionName('v2_teams')}/${team.id}/${getCollectionName('seasonal_records')}/${SEASON_ID}`)));
        const teamRecordSnaps = await Promise.all(teamRecordPromises);

        teams.forEach((team, index) => {
            const record = teamRecordSnaps[index].exists() ? teamRecordSnaps[index].data() : {};
            allTeamsData.set(team.id, { ...team, ...record });
        });

        // --- Step 5: Render all page components with the optimized data ---
        generateIconStylesheet(allTeamsData);
        displayPlayerHeader();
        loadPerformanceData();
        loadGameHistory();

    } catch (error) {
        console.error("Error loading player data from Firestore:", error);
        document.getElementById('player-main-info').innerHTML = `<div class="error">Failed to load player data. See console for details.</div>`;
    }
}

/**
 * Helper function to fetch documents using 'in' queries, handling arrays larger than 30.
 * @param {import("firebase/firestore").CollectionReference} collectionRef - The Firestore collection to query.
 * @param {string[]} ids - An array of document IDs to fetch.
 * @returns {Promise<object[]>} A promise that resolves to an array of document data.
 */
async function fetchDocsInChunks(collectionRef, ids) {
    if (!ids || ids.length === 0) return [];
    const chunks = [];
    for (let i = 0; i < ids.length; i += 30) {
        chunks.push(ids.slice(i, i + 30));
    }
    const promises = chunks.map(chunk => getDocs(query(collectionRef, where(documentId(), 'in', chunk))));
    const chunkSnapshots = await Promise.all(promises);
    const results = [];
    chunkSnapshots.forEach(snap => {
        snap.forEach(doc => results.push({ id: doc.id, ...doc.data() }));
    });
    return results;
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
        if (!n || isNaN(n) || n <= 0) return 'Unranked';
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
        <div class="stat-value">${(currentPlayer.GEM || 0) ? (currentPlayer.GEM).toFixed(1) : '-'}</div><div class="stat-label">GEM</div><div class="stat-rank">${formatRank(currentPlayer.GEM_rank)}</div></div></a>
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
        
        if (!playerTeam || !opponentTeam) return ''; 
        
        const playerTeamResult = game.winner === playerTeam.id ? 'W' : 'L';
        const opponentTeamResult = game.winner === opponentTeam.id ? 'W' : 'L';
        const playerIconClass = `icon-${playerTeam.id.replace(/[^a-zA-Z0-9]/g, '')}`;
        const opponentIconClass = `icon-${opponentTeam.id.replace(/[^a-zA-Z0-9]/g, '')}`;
        const isCaptain = lineup.is_captain === 'TRUE';
        const score = Math.round(lineup.points_adjusted || 0);
        const formattedDate = new Date(game.date.replace(/-/g, '/')).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });


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
                <div class="game-history-date">${formattedDate} (Week ${lineup.week})</div>
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
    
    if (!modal || !modalTitle || !modalContentArea) {
        console.error("Modal elements not found in the DOM. Ensure game-modal-component.html is loaded.");
        return;
    }
    
    modal.style.display = 'block';
    modalTitle.textContent = 'Game Details';
    modalContentArea.innerHTML = '<div class="loading">Loading game details...</div>';
    
    try {
        const game = allGamesData.get(gameId);
        if (!game) throw new Error("Game data not found.");

        const team1 = allTeamsData.get(game.team1_id);
        const team2 = allTeamsData.get(game.team2_id);
        const formattedDate = new Date(game.date.replace(/-/g, '/')).toLocaleDateString('en-US');
        
        modalTitle.textContent = `${team1.team_name} vs ${team2.team_name} - ${formattedDate}`;

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

    document.addEventListener('click', (event) => {
        const modal = document.getElementById('game-modal');
        
        // Handle modal closing
        if (event.target.id === 'close-modal-btn' || event.target === modal) {
            if(modal) modal.style.display = 'none';
        }

        // Handle modal opening
        const clickableRow = event.target.closest('.clickable-row, .game-item');
        if (clickableRow && clickableRow.dataset.gameid) {
            showGameDetails(clickableRow.dataset.gameid);
        }
    });
});