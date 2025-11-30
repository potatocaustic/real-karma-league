// /js/player.js
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
let gameFlowChartInstance = null; // Tracks the Chart.js instance
let currentGameFlowData = null;
let currentChartType = 'cumulative'; // 'cumulative' or 'differential'
let currentTeam1 = null;
let currentTeam2 = null;
let showLiveFeatures = true; // Controls visibility of live features

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
            const playerRef = doc(db, collectionNames.players, finalPlayerId);
            playerSnap = await getDoc(playerRef);
        } else {
            // --- If a HANDLE is provided, query to find the player ---
            const playersRef = collection(db, collectionNames.players);
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

        const seasonalStatsRef = doc(db, collectionNames.players, finalPlayerId, collectionNames.seasonalStats, SEASON_ID);
        const teamsQuery = query(collection(db, collectionNames.teams));
        const activeSeasonQuery = query(collection(db, collectionNames.seasons), where('status', '==', 'active'));

        const [seasonalStatsSnap, teamsSnap, activeSeasonSnap] = await Promise.all([
            getDoc(seasonalStatsRef),
            getDocs(teamsQuery),
            getDocs(activeSeasonQuery)
        ]);

        const postseasonBtn = document.getElementById('postseason-btn');
        if (postseasonBtn) {
            const postseasonWeeks = ['Play-In', 'Round 1', 'Round 2', 'Conf Finals', 'Finals', 'Season Complete'];
            let currentWeek = null;
            let activeSeasonId = null;
            if (!activeSeasonSnap.empty) {
                const activeSeasonData = activeSeasonSnap.docs[0].data();
                currentWeek = activeSeasonData.current_week;
                activeSeasonId = activeSeasonSnap.docs[0].id;
            }

            // Show playoff button if:
            // 1. This is a historical season (not the active season), OR
            // 2. This is the active season AND we're in the postseason
            const isHistoricalSeason = activeSeasonId && SEASON_ID !== activeSeasonId;
            const isActiveSeasonInPostseason = SEASON_ID === activeSeasonId && postseasonWeeks.includes(currentWeek);

            if (isHistoricalSeason || isActiveSeasonInPostseason) {
                postseasonBtn.style.display = 'inline-block';
                postseasonBtn.href = `postseason-player.html?id=${finalPlayerId}`;
            }
        }

        const seasonalStats = seasonalStatsSnap.exists() ? seasonalStatsSnap.data() : {};
        // The spread order here ensures player identity data takes precedence
        currentPlayer = { id: finalPlayerId, ...seasonalStats, ...playerData };

        for (const teamDoc of teamsSnap.docs) {
            allTeamsData.set(teamDoc.id, { id: teamDoc.id, ...teamDoc.data() });
        }
        
        const seasonalRecordsQuery = query(
            collectionGroup(db, collectionNames.seasonalRecords),
            where('seasonId', '==', SEASON_ID)
        );
        const seasonalRecordsSnap = await getDocs(seasonalRecordsQuery);
        seasonalRecordsSnap.forEach(recordDoc => {
            // Server-side filtered by seasonId - all results match SEASON_ID
            const teamId = recordDoc.ref.parent.parent.id;
            const teamData = allTeamsData.get(teamId);
            if (teamData) {
                Object.assign(teamData, recordDoc.data());
            }
        });

        generateIconStylesheet(allTeamsData);

        const lineupsQuery = query(
            collection(db, collectionNames.seasons, SEASON_ID, 'lineups'),
            where('player_id', '==', finalPlayerId),
            where('started', '==', 'TRUE')
        );
        const gamesQuery = query(collection(db, collectionNames.seasons, SEASON_ID, 'games'));

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

// --- GAME FLOW CHART FUNCTIONS ---
async function fetchGameFlowData(gameId) {
    try {
        const flowRef = doc(db, getLeagueCollectionName('game_flow_snapshots'), gameId);
        const flowSnap = await getDoc(flowRef);

        if (flowSnap.exists()) {
            return flowSnap.data().snapshots || [];
        }
        return [];
    } catch (error) {
        console.error('Error fetching game flow data:', error);
        return [];
    }
}

async function renderGameFlowChart(snapshots, team1, team2) {
    const chartArea = document.getElementById('game-flow-chart-area');
    const canvas = document.getElementById('game-flow-chart');

    if (!canvas || !chartArea) {
        console.error('Chart elements not found');
        return;
    }

    // Store current data for toggling between chart types
    currentGameFlowData = snapshots;
    currentTeam1 = team1;
    currentTeam2 = team2;

    // Destroy existing chart if any
    if (gameFlowChartInstance) {
        gameFlowChartInstance.destroy();
        gameFlowChartInstance = null;
    }

    if (snapshots.length === 0) {
        chartArea.innerHTML = '<div class="loading" style="padding: 2rem; text-align: center;">No game flow data available for this matchup.</div>';
        return;
    }

    // Get team colors from logos
    const colors = await getTeamColors(team1, team2);

    // Render based on current chart type
    if (currentChartType === 'differential') {
        renderDifferentialChart(snapshots, team1, team2, colors);
        return;
    }

    // Remove team icons when rendering cumulative view
    const existingIcons = document.querySelectorAll('.chart-team-icon');
    existingIcons.forEach(icon => icon.remove());

    // Detect dark mode
    const isDarkMode = document.documentElement.classList.contains('dark-mode');
    const textColor = isDarkMode ? '#e0e0e0' : '#333';
    const gridColor = isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
    const tooltipBg = isDarkMode ? '#383838' : '#fff';
    const tooltipBorder = isDarkMode ? '#555' : '#ccc';

    // Sort snapshots by timestamp
    const sortedSnapshots = [...snapshots].sort((a, b) => a.timestamp.toMillis() - b.timestamp.toMillis());

    // Prepare data for Chart.js
    const labels = sortedSnapshots.map(s => {
        const date = s.timestamp.toDate();
        return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    });

    const team1Scores = sortedSnapshots.map(s => s.team1_score);
    const team2Scores = sortedSnapshots.map(s => s.team2_score);

    const ctx = canvas.getContext('2d');

    gameFlowChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: team1.team_name,
                data: team1Scores,
                borderColor: colors.team1,
                backgroundColor: colors.team1 + '1A',
                borderWidth: 3,
                tension: 0.1,
                pointRadius: 0,
                pointHoverRadius: 6,
                pointHoverBackgroundColor: colors.team1,
                pointHoverBorderColor: '#fff',
                pointHoverBorderWidth: 2
            }, {
                label: team2.team_name,
                data: team2Scores,
                borderColor: colors.team2,
                backgroundColor: colors.team2 + '1A',
                borderWidth: 3,
                tension: 0.1,
                pointRadius: 0,
                pointHoverRadius: 6,
                pointHoverBackgroundColor: colors.team2,
                pointHoverBorderColor: '#fff',
                pointHoverBorderWidth: 2
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false
            },
            plugins: {
                title: {
                    display: false
                },
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        color: textColor,
                        font: { size: 14 }
                    }
                },
                tooltip: {
                    backgroundColor: tooltipBg,
                    titleColor: textColor,
                    bodyColor: textColor,
                    borderColor: tooltipBorder,
                    borderWidth: 1,
                    callbacks: {
                        label: function(context) {
                            return context.dataset.label + ': ' + Math.round(context.parsed.y).toLocaleString();
                        }
                    }
                }
            },
            scales: {
                x: {
                    title: {
                        display: true,
                        text: 'Time',
                        color: textColor
                    },
                    ticks: {
                        color: textColor
                    },
                    grid: {
                        color: gridColor
                    }
                },
                y: {
                    title: {
                        display: false
                    },
                    ticks: {
                        color: textColor
                    },
                    grid: {
                        color: gridColor
                    },
                    beginAtZero: true
                }
            }
        }
    });

    // Add stats display and toggle button
    addChartControls(sortedSnapshots, team1, team2, colors);
}

function toggleGameFlowChart() {
    const contentArea = document.getElementById('game-details-content-area');
    const chartArea = document.getElementById('game-flow-chart-area');
    const chartBtn = document.getElementById('game-flow-chart-btn');

    if (!contentArea || !chartArea || !chartBtn) return;

    if (contentArea.style.display === 'none') {
        // Switch back to traditional view
        contentArea.style.display = 'block';
        chartArea.style.display = 'none';
        chartBtn.classList.remove('active');
    } else {
        // Switch to chart view
        contentArea.style.display = 'none';
        chartArea.style.display = 'block';
        chartBtn.classList.add('active');
    }
}

function renderDifferentialChart(snapshots, team1, team2, colors) {
    const canvas = document.getElementById('game-flow-chart');
    const chartArea = document.getElementById('game-flow-chart-area');
    if (!canvas || !chartArea) return;

    // Detect dark mode
    const isDarkMode = document.documentElement.classList.contains('dark-mode');
    const textColor = isDarkMode ? '#e0e0e0' : '#333';
    const gridColor = isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
    const tooltipBg = isDarkMode ? '#383838' : '#fff';
    const tooltipBorder = isDarkMode ? '#555' : '#ccc';

    // Sort snapshots by timestamp
    const sortedSnapshots = [...snapshots].sort((a, b) => a.timestamp.toMillis() - b.timestamp.toMillis());

    // Prepare data for Chart.js
    const labels = sortedSnapshots.map(s => {
        const date = s.timestamp.toDate();
        return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    });

    // Calculate differentials if not already present
    let rawDifferentials = sortedSnapshots.map(s =>
        s.differential !== undefined ? s.differential : (s.team1_score - s.team2_score)
    );

    // Interpolate zero-crossing points for smoother color transitions
    const interpolatedLabels = [];
    const interpolatedDifferentials = [];

    for (let i = 0; i < labels.length; i++) {
        interpolatedLabels.push(labels[i]);
        interpolatedDifferentials.push(rawDifferentials[i]);

        // Check if there's a zero crossing between this point and the next
        if (i < labels.length - 1) {
            const curr = rawDifferentials[i];
            const next = rawDifferentials[i + 1];

            // If signs differ (crossing zero), insert an interpolated zero point
            if ((curr > 0 && next < 0) || (curr < 0 && next > 0)) {
                // Calculate the position of the zero crossing
                const ratio = Math.abs(curr) / (Math.abs(curr) + Math.abs(next));

                // Create interpolated label (empty string for cleaner display)
                interpolatedLabels.push('');
                interpolatedDifferentials.push(0);
            }
        }
    }

    // Use interpolated data
    const differentials = interpolatedDifferentials;
    const finalLabels = interpolatedLabels;

    // Create colors based on which team is leading
    const hexToRgba = (hex, alpha) => {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };

    const backgroundColors = differentials.map(diff => {
        if (diff > 0) return hexToRgba(colors.team1, 0.3);
        if (diff < 0) return hexToRgba(colors.team2, 0.3);
        return 'rgba(128, 128, 128, 0.2)';
    });

    const borderColors = differentials.map(diff => {
        if (diff > 0) return colors.team1;
        if (diff < 0) return colors.team2;
        return '#888';
    });

    // Create multiple datasets, one for each segment with consistent lead
    // Each dataset spans all labels but has null for points outside its segment
    const datasets = [];
    const segments = []; // Track segment ranges: {start, end, leader}
    let currentLeader = null;
    let segmentStart = 0;

    for (let i = 0; i < differentials.length; i++) {
        const value = differentials[i];
        let leader;

        if (value > 0) {
            leader = 1;
        } else if (value < 0) {
            leader = -1;
        } else {  // value === 0 (tied game - interpolated or actual)
            // Look ahead to determine which team will be leading after the tie
            if (i < differentials.length - 1) {
                leader = differentials[i + 1] >= 0 ? 1 : -1;
            } else {
                // Last point is a tie - keep previous leader or default to team1
                leader = currentLeader || 1;
            }
        }

        // Detect leader change
        if (currentLeader !== null && leader !== currentLeader) {
            // Include the crossing point in previous segment (end at i+1)
            segments.push({ start: segmentStart, end: i + 1, leader: currentLeader });
            segmentStart = i;
        }
        currentLeader = leader;
    }
    // Add final segment
    segments.push({ start: segmentStart, end: differentials.length, leader: currentLeader });

    // Create a dataset for each segment
    segments.forEach(segment => {
        const segmentData = new Array(differentials.length).fill(null);

        // Fill in data for this segment's range
        for (let i = segment.start; i < segment.end; i++) {
            segmentData[i] = differentials[i];
        }

        const segmentColor = segment.leader === 1 ? colors.team1 : (segment.leader === -1 ? colors.team2 : '#888');

        datasets.push({
            label: 'Lead Margin',
            data: segmentData,
            borderColor: segmentColor,
            backgroundColor: hexToRgba(segmentColor, 0.3),
            borderWidth: 2,
            tension: 0.3,
            fill: true,
            pointRadius: 0,
            pointHoverRadius: function(context) {
                // Don't show hover dot for interpolated zeros (empty labels)
                return finalLabels[context.dataIndex] === '' && differentials[context.dataIndex] === 0 ? 0 : 6;
            },
            pointHoverBackgroundColor: segmentColor,
            pointHoverBorderColor: '#fff',
            pointHoverBorderWidth: 2,
            spanGaps: false
        });
    });

    const ctx = canvas.getContext('2d');

    gameFlowChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: finalLabels,
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            layout: {
                padding: {
                    bottom: 10
                }
            },
            interaction: {
                mode: 'index',
                intersect: false
            },
            plugins: {
                title: {
                    display: false
                },
                legend: {
                    display: false
                },
                tooltip: {
                    backgroundColor: tooltipBg,
                    titleColor: textColor,
                    bodyColor: textColor,
                    borderColor: tooltipBorder,
                    borderWidth: 1,
                    filter: function(tooltipItem) {
                        // Hide tooltip for interpolated zero points (empty labels)
                        return !(tooltipItem.parsed.y === 0 && finalLabels[tooltipItem.dataIndex] === '');
                    },
                    callbacks: {
                        label: function(context) {
                            const diff = context.parsed.y;
                            if (diff > 0) {
                                const verb = team1.team_name.endsWith('s') ? 'lead' : 'leads';
                                return `${team1.team_name} ${verb} by ${Math.round(Math.abs(diff)).toLocaleString()}`;
                            } else if (diff < 0) {
                                const verb = team2.team_name.endsWith('s') ? 'lead' : 'leads';
                                return `${team2.team_name} ${verb} by ${Math.round(Math.abs(diff)).toLocaleString()}`;
                            } else {
                                return 'Game tied';
                            }
                        }
                    }
                }
            },
            scales: {
                x: {
                    title: {
                        display: true,
                        text: 'Time',
                        color: textColor
                    },
                    ticks: {
                        display: false
                    },
                    grid: {
                        color: gridColor,
                        display: false
                    }
                },
                y: {
                    title: {
                        display: false
                    },
                    ticks: {
                        color: textColor,
                        callback: function(value) {
                            return Math.abs(value).toLocaleString();
                        }
                    },
                    grid: {
                        color: gridColor,
                        display: false,
                        lineWidth: function(context) {
                            return context.tick.value === 0 ? 2 : 1;
                        }
                    }
                }
            }
        }
    });

    // Add team icons to chart
    addTeamIconsToChart(chartArea, team1, team2, colors);

    // Add stats display and toggle button
    addChartControls(sortedSnapshots, team1, team2, colors);
}

function addChartControls(snapshots, team1, team2, colors) {
    // Remove existing controls if any
    const existingControls = document.getElementById('chart-controls');
    if (existingControls) {
        existingControls.remove();
    }

    const chartArea = document.getElementById('game-flow-chart-area');
    if (!chartArea) return;

    // Get stats with timestamps
    const stats = calculateGameStats(snapshots);

    // Detect dark mode
    const isDarkMode = document.documentElement.classList.contains('dark-mode');

    // Add title with toggle icon
    addChartTitle(chartArea, isDarkMode);

    // Create controls container
    const controlsDiv = document.createElement('div');
    controlsDiv.id = 'chart-controls';
    controlsDiv.style.cssText = `
        margin-top: 1rem;
        padding: 0.75rem 1rem;
        background-color: ${isDarkMode ? '#2c2c2c' : '#f8f9fa'};
        border-radius: 8px;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
    `;

    // Stats display
    const statsDiv = document.createElement('div');
    statsDiv.style.cssText = `
        display: flex;
        gap: 1.5rem;
        flex-wrap: wrap;
        color: ${isDarkMode ? '#e0e0e0' : '#333'};
        font-size: 0.9rem;
        line-height: 1.4;
    `;

    const formatTime = (timestamp) => {
        if (!timestamp) return '';
        const date = timestamp.toDate();
        return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    };

    statsDiv.innerHTML = `
        <div><strong>Lead Changes:</strong> ${stats.leadChanges}</div>
        <div><strong>${team1.team_name} Biggest Lead:</strong> ${Math.round(stats.team1BiggestLead).toLocaleString()} ${stats.team1BiggestLeadTime ? `(${formatTime(stats.team1BiggestLeadTime)})` : ''}</div>
        <div><strong>${team2.team_name} Biggest Lead:</strong> ${Math.round(stats.team2BiggestLead).toLocaleString()} ${stats.team2BiggestLeadTime ? `(${formatTime(stats.team2BiggestLeadTime)})` : ''}</div>
    `;

    controlsDiv.appendChild(statsDiv);
    chartArea.appendChild(controlsDiv);
}

function toggleChartType() {
    currentChartType = currentChartType === 'cumulative' ? 'differential' : 'cumulative';
    if (currentGameFlowData && currentTeam1 && currentTeam2) {
        renderGameFlowChart(currentGameFlowData, currentTeam1, currentTeam2);
    }
}

function calculateGameStats(snapshots) {
    let leadChanges = 0;
    let team1BiggestLead = 0;
    let team2BiggestLead = 0;
    let team1BiggestLeadTime = null;
    let team2BiggestLeadTime = null;
    let prevDifferential = null;

    for (const snapshot of snapshots) {
        const differential = snapshot.differential !== undefined ?
            snapshot.differential : (snapshot.team1_score - snapshot.team2_score);

        // Count lead changes
        if (prevDifferential !== null) {
            if ((prevDifferential > 0 && differential < 0) ||
                (prevDifferential < 0 && differential > 0) ||
                (prevDifferential === 0 && differential !== 0)) {
                leadChanges++;
            }
        }

        // Track biggest leads with timestamps
        if (differential > team1BiggestLead) {
            team1BiggestLead = differential;
            team1BiggestLeadTime = snapshot.timestamp;
        }
        if (differential < 0 && Math.abs(differential) > team2BiggestLead) {
            team2BiggestLead = Math.abs(differential);
            team2BiggestLeadTime = snapshot.timestamp;
        }

        prevDifferential = differential;
    }

    return {
        leadChanges,
        team1BiggestLead,
        team2BiggestLead,
        team1BiggestLeadTime,
        team2BiggestLeadTime
    };
}

async function getTeamColors(team1, team2) {
    // Check for color override first, then extract from logo, then fallback to defaults
    const team1Color = team1.color_override || await extractDominantColor(team1.id, team1.logo_ext) || '#007bff';
    const team2Color = team2.color_override || await extractDominantColor(team2.id, team2.logo_ext) || '#dc3545';

    return {
        team1: team1Color,
        team2: team2Color
    };
}

async function extractDominantColor(teamId, logoExt = 'webp') {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'Anonymous';
        img.src = `../icons/${teamId}.${logoExt}`;

        img.onload = function() {
            try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = img.width;
                canvas.height = img.height;
                ctx.drawImage(img, 0, 0);

                const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const data = imageData.data;

                let r = 0, g = 0, b = 0, count = 0;

                // Sample every 4th pixel for efficiency
                for (let i = 0; i < data.length; i += 16) {
                    const alpha = data[i + 3];
                    const red = data[i];
                    const green = data[i + 1];
                    const blue = data[i + 2];

                    // Only count non-transparent pixels and skip very dark colors (likely background)
                    if (alpha > 128) {
                        const brightness = (red + green + blue) / 3;
                        // Skip if too dark (likely black background) unless it's a vibrant dark color
                        const isVibrant = Math.max(red, green, blue) - Math.min(red, green, blue) > 50;
                        if (brightness > 40 || isVibrant) {
                            r += red;
                            g += green;
                            b += blue;
                            count++;
                        }
                    }
                }

                if (count > 0) {
                    r = Math.floor(r / count);
                    g = Math.floor(g / count);
                    b = Math.floor(b / count);
                    const hex = '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
                    resolve(hex);
                } else {
                    resolve(null);
                }
            } catch (e) {
                console.warn('Error extracting color from logo:', e);
                resolve(null);
            }
        };

        img.onerror = function() {
            resolve(null);
        };
    });
}

function addChartTitle(chartArea, isDarkMode) {
    // Remove existing title if any
    const existingTitle = document.getElementById('chart-title-bar');
    if (existingTitle) {
        existingTitle.remove();
    }

    const titleBar = document.createElement('div');
    titleBar.id = 'chart-title-bar';
    titleBar.style.cssText = `
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.75rem;
        margin-bottom: 0.5rem;
        color: ${isDarkMode ? '#e0e0e0' : '#333'};
    `;

    const titleText = document.createElement('span');
    titleText.style.cssText = `
        font-size: 1.1rem;
        font-weight: 600;
    `;
    titleText.textContent = currentChartType === 'cumulative' ? 'Game Flow - Cumulative' : 'Game Flow - Lead Margin';

    const toggleIcon = document.createElement('button');
    toggleIcon.innerHTML = '&#8644;'; // Swap icon
    toggleIcon.title = 'Toggle chart view';
    toggleIcon.style.cssText = `
        background: none;
        border: 1px solid ${isDarkMode ? '#555' : '#ccc'};
        color: ${isDarkMode ? '#e0e0e0' : '#333'};
        cursor: pointer;
        padding: 0.25rem 0.5rem;
        border-radius: 4px;
        font-size: 1.2rem;
        transition: all 0.3s;
    `;
    toggleIcon.onmouseover = () => {
        toggleIcon.style.backgroundColor = isDarkMode ? '#444' : '#e9ecef';
    };
    toggleIcon.onmouseout = () => {
        toggleIcon.style.backgroundColor = 'transparent';
    };
    toggleIcon.onclick = () => toggleChartType();

    titleBar.appendChild(titleText);
    titleBar.appendChild(toggleIcon);

    // Insert before the canvas
    const canvas = document.getElementById('game-flow-chart');
    if (canvas) {
        chartArea.insertBefore(titleBar, canvas);
    } else {
        chartArea.insertBefore(titleBar, chartArea.firstChild);
    }
}

function addTeamIconsToChart(chartArea, team1, team2, colors) {
    // Remove existing icons if any
    const existingIcons = document.querySelectorAll('.chart-team-icon');
    existingIcons.forEach(icon => icon.remove());

    const createTeamIcon = (team, position) => {
        const iconDiv = document.createElement('div');
        iconDiv.className = 'chart-team-icon';
        const topPosition = currentChartType === 'differential' ? '40px' : '80px';
        iconDiv.style.cssText = `
            position: absolute;
            ${position === 'top' ? `top: ${topPosition};` : 'bottom: 20px;'}
            left: 60px;
            display: flex;
            align-items: center;
            gap: 0.5rem;
            padding: 0.25rem;
            background: transparent;
            z-index: 10;
        `;

        const img = document.createElement('img');
        const logoExt = team.logo_ext || 'webp';
        img.src = `../icons/${team.id}.${logoExt}`;
        img.alt = team.team_name;
        img.style.cssText = `
            width: 32px;
            height: 32px;
            border-radius: 50%;
            object-fit: cover;
            box-shadow: 0 2px 4px rgba(0,0,0,0.2);
        `;
        img.onerror = function() { this.style.display = 'none'; };

        iconDiv.appendChild(img);
        return iconDiv;
    };

    chartArea.style.position = 'relative';
    chartArea.appendChild(createTeamIcon(team1, 'top'));
    chartArea.appendChild(createTeamIcon(team2, 'bottom'));
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

    // Clean up existing chart and reset state
    if (gameFlowChartInstance) {
        gameFlowChartInstance.destroy();
        gameFlowChartInstance = null;
    }
    currentChartType = 'cumulative'; // Reset to default view
    currentGameFlowData = null;
    currentTeam1 = null;
    currentTeam2 = null;

    // Clean up chart UI elements
    const existingTitle = document.getElementById('chart-title-bar');
    if (existingTitle) existingTitle.remove();
    const existingControls = document.getElementById('chart-controls');
    if (existingControls) existingControls.remove();
    const existingIcons = document.querySelectorAll('.chart-team-icon');
    existingIcons.forEach(icon => icon.remove());

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
            collection(db, collectionNames.seasons, SEASON_ID, 'lineups'),
            where('game_id', '==', gameId),
            where('started', '==', 'TRUE')
        );
        const lineupsSnap = await getDocs(lineupsQuery);

        const allPlayerIdsInGame = lineupsSnap.docs.map(doc => doc.data().player_id);
        const uniquePlayerIds = [...new Set(allPlayerIdsInGame)];

        const playerStatsPromises = uniquePlayerIds.map(playerId =>
            getDoc(doc(db, collectionNames.players, playerId, collectionNames.seasonalStats, SEASON_ID))
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

        // Fetch and prepare game flow chart (if available)
        const chartBtn = document.getElementById('game-flow-chart-btn');
        const flowData = await fetchGameFlowData(gameId);

        if (flowData && flowData.length > 0 && showLiveFeatures) {
            // Show chart button
            if (chartBtn) {
                chartBtn.style.display = 'flex';
                chartBtn.onclick = () => toggleGameFlowChart();
            }

            // Pre-render the chart (hidden initially)
            renderGameFlowChart(flowData, team1, team2);
        } else {
            if (chartBtn) {
                chartBtn.style.display = 'none';
            }
        }

    } catch (error) {
        console.error("Error showing game details:", error);
        modalContentArea.innerHTML = '<div class="error">Could not load game details.</div>';
    }
}

function closeModal() {
    const modal = document.getElementById('game-modal');
    if (modal) {
        modal.style.display = 'none';
    }

    // Clean up chart
    if (gameFlowChartInstance) {
        gameFlowChartInstance.destroy();
        gameFlowChartInstance = null;
    }

    // Reset views
    const contentArea = document.getElementById('game-details-content-area');
    const chartArea = document.getElementById('game-flow-chart-area');
    const chartBtn = document.getElementById('game-flow-chart-btn');

    if (contentArea) contentArea.style.display = 'block';
    if (chartArea) chartArea.style.display = 'none';
    if (chartBtn) {
        chartBtn.classList.remove('active');
        chartBtn.style.display = 'none';
    }
}

// --- Event Listeners ---
document.addEventListener('DOMContentLoaded', () => {
    loadPlayerData();

    document.addEventListener('click', (event) => {
        const modal = document.getElementById('game-modal');

        // Use event delegation for the close button since it's loaded dynamically
        if (event.target.matches('#close-modal-btn') || event.target === modal) {
            closeModal();
        }

        const clickableRow = event.target.closest('.clickable-row, .game-item');
        if (clickableRow && clickableRow.dataset.gameid) {
            showGameDetails(clickableRow.dataset.gameid);
        }
    });
});

// Reload player data when league changes
window.addEventListener('leagueChanged', (event) => {
    const newLeague = event.detail.league;
    console.log('League changed to:', newLeague);

    // Hide content during transition
    const mainElement = document.querySelector('main');
    if (mainElement) mainElement.style.opacity = '0';

    // Small delay before reloading to ensure fade-out completes
    setTimeout(() => {
        loadPlayerData();

        // Show content after reload
        setTimeout(() => {
            if (mainElement) mainElement.style.opacity = '1';
        }, 100);
    }, 150);
});
