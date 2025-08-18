// /js/player.js
import { db, collection, doc, getDoc, getDocs, query, where, collectionGroup } from './firebase-init.js';
import { generateLineupTable } from './main.js';

// --- Configuration ---
const USE_DEV_COLLECTIONS = false; 
const SEASON_ID = 'S8';

// --- Global State ---
let allTeamsData = new Map();
let allGamesData = new Map();
let playerLineups = [];
let currentPlayer = null;

/**
 * Gets the correct Firestore collection name based on the environment.
 */
const getCollectionName = (baseName) => {
    if (baseName === 'seasonal_records' || baseName === 'seasonal_stats') {
        return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
    }
    return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
};


/**
 * Generates and injects CSS rules for team logos.
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
 * Fetches all necessary REGULAR SEASON data from Firestore to build the player page.
 */
// js/player.js

async function loadPlayerData() {
    const params = new URLSearchParams(window.location.search);
    const playerId = params.get('id');
    const playerHandle = params.get('handle');

    if (!playerId && !playerHandle) {
        document.getElementById('player-main-info').innerHTML = '<div class="error">No player ID or handle specified in URL.</div>';
        return;
    }
    
    try {
        let playerSnap;
        let finalPlayerId;

        if (playerId) {
            // --- If an ID is provided, fetch the player directly (current logic) ---
            finalPlayerId = playerId;
            const playerRef = doc(db, getCollectionName('v2_players'), finalPlayerId);
            playerSnap = await getDoc(playerRef);
        } else {
            // --- If a HANDLE is provided, query to find the player ---
            const playersRef = collection(db, getCollectionName('v2_players'));
            const q = query(playersRef, where('player_handle', '==', playerHandle));
            const querySnapshot = await getDocs(q);

            if (querySnapshot.empty) {
                document.getElementById('player-main-info').innerHTML = `<div class="error">Player with handle '${playerHandle}' not found.</div>`;
                return;
            }
            // Get the full document snapshot from the query results
            playerSnap = querySnapshot.docs[0];
            // Get the player's ID from the document itself
            finalPlayerId = playerSnap.id; 
        }

        if (!playerSnap.exists()) {
            document.getElementById('player-main-info').innerHTML = `<div class="error">Player not found.</div>`;
            return;
        }

        // --- The rest of the function proceeds as normal from here ---
        // It now has the correct playerSnap and finalPlayerId regardless of how it was found.
        
        const playerData = playerSnap.data();
        // Use document.title for a more robust way to set the page title
        document.title = `${playerData.player_handle} - RKL ${SEASON_ID}`;

        const seasonalStatsRef = doc(db, `${getCollectionName('v2_players')}/${finalPlayerId}/${getCollectionName('seasonal_stats')}`, SEASON_ID);
        const teamsQuery = query(collection(db, getCollectionName('v2_teams')));

        const [seasonalStatsSnap, teamsSnap] = await Promise.all([
            getDoc(seasonalStatsRef),
            getDocs(teamsQuery)
        ]);

        const seasonalStats = seasonalStatsSnap.exists() ? seasonalStatsSnap.data() : {};
        // The spread order here ensures player identity data takes precedence
        currentPlayer = { id: finalPlayerId, ...seasonalStats, ...playerData };

        for (const teamDoc of teamsSnap.docs) {
            allTeamsData.set(teamDoc.id, { id: teamDoc.id, ...teamDoc.data() });
        }
        
        const seasonalRecordsQuery = query(
            collectionGroup(db, getCollectionName('seasonal_records')),
            where('season', '==', SEASON_ID)
        );
        const seasonalRecordsSnap = await getDocs(seasonalRecordsQuery);
        seasonalRecordsSnap.forEach(recordDoc => {
            const teamId = recordDoc.ref.parent.parent.id;
            const teamData = allTeamsData.get(teamId);
            if (teamData) {
                Object.assign(teamData, recordDoc.data());
            }
        });
        
        generateIconStylesheet(allTeamsData);

        const lineupsQuery = query(
            collection(db, getCollectionName('seasons'), SEASON_ID, getCollectionName('lineups')),
            where('player_id', '==', finalPlayerId),
            where('started', '==', 'TRUE')
        );
        const gamesQuery = query(collection(db, getCollectionName('seasons'), SEASON_ID, getCollectionName('games')));

        const [lineupsSnap, gamesSnap] = await Promise.all([
            getDocs(lineupsQuery),
            getDocs(gamesQuery)
        ]);

        playerLineups = lineupsSnap.docs.map(d => d.data()).sort((a,b) => (a.week || 0) - (b.week || 0));
        gamesSnap.forEach(gameDoc => {
            allGamesData.set(gameDoc.id, { id: gameDoc.id, ...gameDoc.data() });
        });

        displayPlayerHeader();
        loadPerformanceData();
        loadGameHistory();

    } catch (error) {
        console.error("Error loading player data from Firestore:", error);
        document.getElementById('player-main-info').innerHTML = `<div class="error">Failed to load player data. See console for details.</div>`;
    }
}


/**
 * Displays the main player header and REGULAR SEASON stat cards.
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

    // **MODIFIED: Conditionally create the bio HTML**
    const bioHTML = currentPlayer.bio
        ? `<div class="player-bio">${currentPlayer.bio}</div>`
        : '';

    document.getElementById('player-main-info').innerHTML = `
      ${teamLogoHTML}
      <div class="player-details">
        <h2>${currentPlayer.player_handle}${isRookie ? '<span class="rookie-badge">R</span>' : ''}${isAllStar ? ' <span class="all-star-badge">★</span>' : ''}</h2>
        <div class="player-subtitle">${currentPlayer.player_status} • ${currentPlayer.games_played || 0} games played</div>
        ${teamInfoHTML}
        ${bioHTML}
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
 * Fills the weekly performance table with the player's REGULAR SEASON game data.
 */
function loadPerformanceData() {
    if (playerLineups.length === 0) {
        document.getElementById('performance-table').innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 2rem;">No regular season games played yet.</td></tr>';
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
        
        // MODIFIED: Added captain-row class
        const rowClass = `${isClickable ? 'clickable-row' : ''} ${isCaptain ? 'captain-row' : ''}`;

        return `<tr class="${rowClass}" ${isClickable ? `data-gameid="${lineup.game_id}"` : ''}>
                    <td>Week ${lineup.week}${isCaptain ? '<span class="captain-badge-small">C</span>' : ''}</td>
                    <td>${points.toLocaleString()}${isCaptain ? ` (+${captainBonus.toLocaleString()})` : ''}</td>
                    <td>${formatRankBadge(lineup.global_rank)}</td>
                    <td>${isCaptain ? 'Captain' : 'Starter'}</td>
                </tr>`;
    }).join('');
    document.getElementById('performance-table').innerHTML = performanceHTML;
}

/**
 * Fills the game history list with the player's REGULAR SEASON matchups.
 */
function loadGameHistory() {
    const completedGames = playerLineups.map(lineup => {
        const game = allGamesData.get(lineup.game_id);
        return (game && game.completed === 'TRUE') ? { lineup, game } : null;
    }).filter(Boolean);

    if (completedGames.length === 0) {
        document.getElementById('game-history').innerHTML = '<div style="text-align: center; padding: 2rem;">No completed regular season game history found.</div>';
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
        
        const allPlayerIdsInGame = lineupsSnap.docs.map(doc => doc.data().player_id);
        const uniquePlayerIds = [...new Set(allPlayerIdsInGame)];

        const playerStatsPromises = uniquePlayerIds.map(playerId => 
            getDoc(doc(db, getCollectionName('v2_players'), playerId, getCollectionName('seasonal_stats'), SEASON_ID))
        );
        const playerStatsDocs = await Promise.all(playerStatsPromises);
        
        const playerSeasonalStats = new Map();
        playerStatsDocs.forEach((docSnap, index) => {
            if (docSnap.exists()) {
                playerSeasonalStats.set(uniquePlayerIds[index], docSnap.data());
            }
        });

        const allGameLineups = lineupsSnap.docs.map(d => {
            const lineupData = d.data();
            return { ...lineupData, ...playerSeasonalStats.get(lineupData.player_id) };
        });

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
        
        // Use event delegation for the close button since it's loaded dynamically
        if (event.target.matches('#close-modal-btn') || event.target === modal) {
            if(modal) modal.style.display = 'none';
        }

        const clickableRow = event.target.closest('.clickable-row, .game-item');
        if (clickableRow && clickableRow.dataset.gameid) {
            showGameDetails(clickableRow.dataset.gameid);
        }
    });
});
