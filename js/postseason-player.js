// /js/postseason-player.js
import { db, collection, doc, getDoc, getDocs, query, where, collectionGroup, collectionNames, getLeagueCollectionName } from './firebase-init.js';
import { generateLineupTable } from './main.js';

// --- Configuration ---
// Get season from path (/S8/ or /S9/), URL parameter, or default to S9
const urlParams = new URLSearchParams(window.location.search);
const pathMatch =  window.location.pathname.match(/\/S(\d+)\//);
const seasonFromPath = pathMatch ? `S${pathMatch[1]}` : null;
const SEASON_ID = seasonFromPath || urlParams.get('season') || 'S9';

// --- Global State ---
let allTeamsData = new Map();
let allGamesData = new Map();
let playerLineups = [];
let currentPlayer = null;

/**
 * Generates and injects CSS rules for team logos.
 */
function generateIconStylesheet(teams) {
    let iconStyles = '';
    teams.forEach(team => {
        const className = `icon-${team.id.replace(/[^a-zA-Z0-9]/g, '')}`;
        iconStyles += `.${className} { background-image: url('../icons/${team.id}.webp'); }\n`;
    });

    const styleElement = document.getElementById('team-icon-styles');
    if (styleElement) {
        styleElement.innerHTML = `
            .team-logo-css {
                background-size: cover; background-position: center;
                background-repeat: no-repeat; display: inline-block; vertical-align: middle;
                flex-shrink: 0; border-radius: 4px;
            }
            ${iconStyles}`;
    }
}

/**
 * Fetches all necessary POSTSEASON data from Firestore to build the player page.
 */
async function loadPlayerData() {
    const params = new URLSearchParams(window.location.search);
    const playerId = params.get('id');
    const playerHandle = params.get('handle');

    if (!playerId && !playerHandle) {
        document.getElementById('player-main-info').innerHTML = '<div class="error">No player ID or handle specified.</div>';
        return;
    }

    try {
        let playerSnap;
        let finalPlayerId = playerId;

        if (playerHandle && !playerId) {
            const playersRef = collection(db, collectionNames.players);
            const q = query(playersRef, where('player_handle', '==', playerHandle));
            const querySnapshot = await getDocs(q);
            if (!querySnapshot.empty) {
                playerSnap = querySnapshot.docs[0];
                finalPlayerId = playerSnap.id;
            }
        } else if (finalPlayerId) {
             const playerRef = doc(db, collectionNames.players, finalPlayerId);
             playerSnap = await getDoc(playerRef);
        }

        if (!playerSnap || !playerSnap.exists()) {
            document.getElementById('player-main-info').innerHTML = `<div class="error">Player not found.</div>`;
            return;
        }
        
        const playerData = playerSnap.data();
        document.title = `${playerData.player_handle} - RKL ${SEASON_ID} Postseason`;

        // Set up the link back to the regular season profile
        const regularSeasonBtn = document.getElementById('regular-season-btn');
        if(regularSeasonBtn) {
            regularSeasonBtn.href = `player.html?id=${finalPlayerId}`;
        }

        const seasonalStatsRef = doc(db, `${collectionNames.players}/${finalPlayerId}/${collectionNames.seasonalStats}`, SEASON_ID);
        const teamsQuery = query(collection(db, collectionNames.teams));

        const [seasonalStatsSnap, teamsSnap] = await Promise.all([ getDoc(seasonalStatsRef), getDocs(teamsQuery) ]);

        const seasonalStats = seasonalStatsSnap.exists() ? seasonalStatsSnap.data() : {};
        currentPlayer = { id: finalPlayerId, ...seasonalStats, ...playerData };

        teamsSnap.docs.forEach(teamDoc => allTeamsData.set(teamDoc.id, { id: teamDoc.id, ...teamDoc.data() }));

        const seasonalRecordsQuery = query(
            collectionGroup(db, 'seasonal_records'),
            where('seasonId', '==', SEASON_ID)
        );
        const seasonalRecordsSnap = await getDocs(seasonalRecordsQuery);
        seasonalRecordsSnap.forEach(recordDoc => {
            // Server-side filtered by seasonId - all results match SEASON_ID
            const teamId = recordDoc.ref.parent.parent.id;
            if (allTeamsData.has(teamId)) {
                Object.assign(allTeamsData.get(teamId), recordDoc.data());
            }
        });

        generateIconStylesheet(allTeamsData);

        const lineupsQuery = query(collection(db, collectionNames.seasons, SEASON_ID, 'post_lineups'), where('player_id', '==', finalPlayerId), where('started', '==', 'TRUE'));
        const gamesQuery = query(collection(db, collectionNames.seasons, SEASON_ID, 'post_games'));

        const [lineupsSnap, gamesSnap] = await Promise.all([ getDocs(lineupsQuery), getDocs(gamesQuery) ]);

        // --- THIS IS THE FIX ---
        // Sort by the actual game date instead of the week name string.
        playerLineups = lineupsSnap.docs.map(d => d.data()).sort((a, b) => new Date(a.date) - new Date(b.date));
        
        gamesSnap.forEach(gameDoc => allGamesData.set(gameDoc.id, { id: gameDoc.id, ...gameDoc.data() }));

        displayPlayerHeader();
        loadPerformanceData();
        loadGameHistory();

    } catch (error) {
        console.error("Error loading postseason player data:", error);
        document.getElementById('player-main-info').innerHTML = `<div class="error">Failed to load postseason data. See console.</div>`;
    }
}
/**
 * Displays the main player header and POSTSEASON stat cards.
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
    const bioHTML = currentPlayer.bio ? `<div class="player-bio">${currentPlayer.bio}</div>` : '';

    document.getElementById('player-main-info').innerHTML = `
      ${teamLogoHTML}
      <div class="player-details">
        <h2>${currentPlayer.player_handle}${isRookie ? '<span class="rookie-badge">R</span>' : ''}${isAllStar ? ' <span class="all-star-badge">★</span>' : ''}</h2>
        <div class="season-indicator">Postseason</div>
        <div class="player-subtitle">${currentPlayer.player_status} • ${currentPlayer.post_games_played || 0} games played</div>
        ${teamInfoHTML}
        ${bioHTML}
      </div>`;

    const getOrdinal = (n) => {
        if (!n || isNaN(n) || n <= 0) return 'Unranked';
        const s = ["th", "st", "nd", "rd"], v = n % 100;
        return n + (s[(v - 20) % 10] || s[v] || s[0]);
    };
    const formatRank = (rank) => rank ? `${getOrdinal(rank)} Overall` : 'Unranked';
    const medianRank = currentPlayer.post_medrank === Infinity ? '-' : Math.round(currentPlayer.post_medrank || 0) || '-';

    document.getElementById('player-stats').innerHTML = `
      <a href="postseason-leaderboards.html?category=war" class="stat-card-link"><div class="stat-card">
        <div class="stat-value">${(currentPlayer.post_WAR || 0).toFixed(2)}</div><div class="stat-label">WAR</div><div class="stat-rank">${formatRank(currentPlayer.post_WAR_rank)}</div></div></a>
      <a href="postseason-leaderboards.html?category=rel_median" class="stat-card-link"><div class="stat-card">
        <div class="stat-value">${(currentPlayer.post_rel_median || 0).toFixed(3)}</div><div class="stat-label">REL Median</div><div class="stat-rank">${formatRank(currentPlayer.post_rel_median_rank)}</div></div></a>
      <a href="postseason-leaderboards.html?category=median_gameday_rank" class="stat-card-link"><div class="stat-card">
        <div class="stat-value">${medianRank}</div><div class="stat-label">Median Gameday Rank</div><div class="stat-rank">${formatRank(currentPlayer.post_medrank_rank)}</div></div></a>
      <a href="postseason-leaderboards.html?category=gem" class="stat-card-link"><div class="stat-card">
        <div class="stat-value">${(currentPlayer.post_GEM || 0) ? (currentPlayer.post_GEM).toFixed(1) : '-'}</div><div class="stat-label">GEM</div><div class="stat-rank">${formatRank(currentPlayer.post_GEM_rank)}</div></div></a>
      <a href="postseason-leaderboards.html?category=aag_median" class="stat-card-link"><div class="stat-card"> <div class="stat-value">${currentPlayer.post_aag_median || 0}</div><div class="stat-label">Games Above Median</div><div class="stat-rank">${formatRank(currentPlayer.post_aag_median_rank)}</div></div></a>
    `;
    document.getElementById('player-stats').style.display = 'grid';
}

/**
 * Fills the performance table with POSTSEASON game data.
 */
function loadPerformanceData() {
    if (playerLineups.length === 0) {
        document.getElementById('performance-table').innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 2rem;">No postseason games played yet.</td></tr>';
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
        const rowClass = `${isClickable ? 'clickable-row' : ''} ${isCaptain ? 'captain-row' : ''}`;

        return `<tr class="${rowClass}" ${isClickable ? `data-gameid="${lineup.game_id}"` : ''}>
                    <td>${lineup.week}${isCaptain ? '<span class="captain-badge-small">C</span>' : ''}</td>
                    <td>${points.toLocaleString()}${isCaptain ? ` (+${captainBonus.toLocaleString()})` : ''}</td>
                    <td>${formatRankBadge(lineup.global_rank)}</td>
                    <td>${isCaptain ? 'Captain' : 'Starter'}</td>
                </tr>`;
    }).join('');
    document.getElementById('performance-table').innerHTML = performanceHTML;
}

/**
 * Fills the game history list with POSTSEASON matchups.
 */
function loadGameHistory() {
    const completedGames = playerLineups.map(lineup => {
        const game = allGamesData.get(lineup.game_id);
        return (game && game.completed === 'TRUE') ? { lineup, game } : null;
    }).filter(Boolean);

    if (completedGames.length === 0) {
        document.getElementById('game-history').innerHTML = '<div style="text-align: center; padding: 2rem;">No completed postseason game history found.</div>';
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
        const formattedDate = new Date(game.date.replace(/-/g, '/')).toLocaleString('en-US', { month: 'short', day: 'numeric' });

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
                <div class="game-history-date">${formattedDate} (${lineup.week})</div>
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
 * Fetches data for a specific POSTSEASON game and displays it in the modal.
 */
async function showGameDetails(gameId) {
    const modal = document.getElementById('game-modal');
    const modalTitle = document.getElementById('modal-title');
    const modalContentArea = document.getElementById('game-details-content-area');
    
    if (!modal || !modalTitle || !modalContentArea) return;
    
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

        const lineupsQuery = query(collection(db, collectionNames.seasons, SEASON_ID, 'post_lineups'), where('game_id', '==', gameId), where('started', '==', 'TRUE'));
        const lineupsSnap = await getDocs(lineupsQuery);
        
        const allPlayerIdsInGame = lineupsSnap.docs.map(doc => doc.data().player_id);
        const uniquePlayerIds = [...new Set(allPlayerIdsInGame)];

        const playerStatsPromises = uniquePlayerIds.map(playerId => getDoc(doc(db, collectionNames.players, playerId, 'seasonal_stats', SEASON_ID)));
        const playerStatsDocs = await Promise.all(playerStatsPromises);
        
        const playerSeasonalStats = new Map();
        playerStatsDocs.forEach((docSnap, index) => {
            if (docSnap.exists()) playerSeasonalStats.set(uniquePlayerIds[index], docSnap.data());
        });

        const allGameLineups = lineupsSnap.docs.map(d => ({ ...d.data(), ...playerSeasonalStats.get(d.data().player_id) }));
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
        if (event.target.matches('#close-modal-btn') || event.target === modal) {
            if(modal) modal.style.display = 'none';
        }
        const clickableRow = event.target.closest('.clickable-row, .game-item');
        if (clickableRow && clickableRow.dataset.gameid) {
            showGameDetails(clickableRow.dataset.gameid);
        }
    });
});
