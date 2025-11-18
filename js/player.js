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
let currentTeam1Name = '';
let currentTeam2Name = '';
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
            collection(db, collectionNames.seasons, SEASON_ID, getLeagueCollectionName('lineups')),
            where('player_id', '==', finalPlayerId),
            where('started', '==', 'TRUE')
        );
        const gamesQuery = query(collection(db, collectionNames.seasons, SEASON_ID, getLeagueCollectionName('games')));

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

function renderGameFlowChart(snapshots, team1Name, team2Name) {
    const chartArea = document.getElementById('game-flow-chart-area');
    const canvas = document.getElementById('game-flow-chart');

    if (!canvas || !chartArea) {
        console.error('Chart elements not found');
        return;
    }

    // Store current data for toggling between chart types
    currentGameFlowData = snapshots;
    currentTeam1Name = team1Name;
    currentTeam2Name = team2Name;

    // Destroy existing chart if any
    if (gameFlowChartInstance) {
        gameFlowChartInstance.destroy();
        gameFlowChartInstance = null;
    }

    if (snapshots.length === 0) {
        chartArea.innerHTML = '<div class="loading" style="padding: 2rem; text-align: center;">No game flow data available for this matchup.</div>';
        return;
    }

    // Render based on current chart type
    if (currentChartType === 'differential') {
        renderDifferentialChart(snapshots, team1Name, team2Name);
        return;
    }

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
                label: team1Name,
                data: team1Scores,
                borderColor: '#007bff',
                backgroundColor: 'rgba(0, 123, 255, 0.1)',
                borderWidth: 3,
                tension: 0.1,
                pointRadius: 0,
                pointHoverRadius: 6,
                pointHoverBackgroundColor: '#007bff',
                pointHoverBorderColor: '#fff',
                pointHoverBorderWidth: 2
            }, {
                label: team2Name,
                data: team2Scores,
                borderColor: '#dc3545',
                backgroundColor: 'rgba(220, 53, 69, 0.1)',
                borderWidth: 3,
                tension: 0.1,
                pointRadius: 0,
                pointHoverRadius: 6,
                pointHoverBackgroundColor: '#dc3545',
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
                    display: true,
                    text: 'Game Flow Chart',
                    font: { size: 18 },
                    color: textColor
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
                        display: true,
                        text: 'Score',
                        color: textColor
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
    addChartControls(sortedSnapshots, team1Name, team2Name);
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

function renderDifferentialChart(snapshots, team1Name, team2Name) {
    const canvas = document.getElementById('game-flow-chart');
    if (!canvas) return;

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

    // Calculate differentials if not already present
    const differentials = sortedSnapshots.map(s =>
        s.differential !== undefined ? s.differential : (s.team1_score - s.team2_score)
    );

    // Create colors based on which team is leading
    const backgroundColors = differentials.map(diff => {
        if (diff > 0) return 'rgba(0, 123, 255, 0.3)'; // Team 1 blue
        if (diff < 0) return 'rgba(220, 53, 69, 0.3)'; // Team 2 red
        return 'rgba(128, 128, 128, 0.2)'; // Tied
    });

    const borderColors = differentials.map(diff => {
        if (diff > 0) return '#007bff'; // Team 1 blue
        if (diff < 0) return '#dc3545'; // Team 2 red
        return '#888'; // Tied
    });

    const ctx = canvas.getContext('2d');

    gameFlowChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Lead Margin',
                data: differentials,
                borderColor: '#007bff',
                backgroundColor: function(context) {
                    const index = context.dataIndex;
                    return backgroundColors[index];
                },
                borderWidth: 2,
                tension: 0.3,
                fill: true,
                pointRadius: 0,
                pointHoverRadius: 6,
                pointHoverBackgroundColor: function(context) {
                    const index = context.dataIndex;
                    return borderColors[index];
                },
                pointHoverBorderColor: '#fff',
                pointHoverBorderWidth: 2,
                segment: {
                    borderColor: function(context) {
                        const index = context.p0DataIndex;
                        return borderColors[index];
                    }
                }
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
                    display: true,
                    text: 'Game Flow - Lead Margin',
                    font: { size: 18 },
                    color: textColor
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
                    callbacks: {
                        label: function(context) {
                            const diff = context.parsed.y;
                            if (diff > 0) {
                                return `${team1Name} leads by ${Math.round(Math.abs(diff)).toLocaleString()}`;
                            } else if (diff < 0) {
                                return `${team2Name} leads by ${Math.round(Math.abs(diff)).toLocaleString()}`;
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
                        color: textColor
                    },
                    grid: {
                        color: gridColor,
                        display: false
                    }
                },
                y: {
                    title: {
                        display: true,
                        text: 'Lead Margin',
                        color: textColor
                    },
                    ticks: {
                        color: textColor,
                        callback: function(value) {
                            return value.toLocaleString();
                        }
                    },
                    grid: {
                        color: gridColor,
                        lineWidth: function(context) {
                            return context.tick.value === 0 ? 2 : 1;
                        }
                    }
                }
            }
        }
    });

    // Add stats display and toggle button
    addChartControls(sortedSnapshots, team1Name, team2Name);
}

function addChartControls(snapshots, team1Name, team2Name) {
    // Remove existing controls if any
    const existingControls = document.getElementById('chart-controls');
    if (existingControls) {
        existingControls.remove();
    }

    const chartArea = document.getElementById('game-flow-chart-area');
    if (!chartArea) return;

    // Get final snapshot for stats
    const finalSnapshot = snapshots[snapshots.length - 1];
    const leadChanges = finalSnapshot.lead_changes !== undefined ? finalSnapshot.lead_changes :
        calculateLeadChanges(snapshots);
    const team1BiggestLead = finalSnapshot.team1_biggest_lead !== undefined ? finalSnapshot.team1_biggest_lead :
        calculateBiggestLead(snapshots, 1);
    const team2BiggestLead = finalSnapshot.team2_biggest_lead !== undefined ? finalSnapshot.team2_biggest_lead :
        calculateBiggestLead(snapshots, 2);

    // Detect dark mode
    const isDarkMode = document.documentElement.classList.contains('dark-mode');

    // Create controls container
    const controlsDiv = document.createElement('div');
    controlsDiv.id = 'chart-controls';
    controlsDiv.style.cssText = `
        margin-top: 1rem;
        padding: 1rem;
        background-color: ${isDarkMode ? '#2c2c2c' : '#f8f9fa'};
        border-radius: 8px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: 1rem;
    `;

    // Stats display
    const statsDiv = document.createElement('div');
    statsDiv.style.cssText = `
        display: flex;
        gap: 2rem;
        flex-wrap: wrap;
        color: ${isDarkMode ? '#e0e0e0' : '#333'};
        font-size: 0.9rem;
    `;

    statsDiv.innerHTML = `
        <div><strong>Lead Changes:</strong> ${leadChanges}</div>
        <div><strong>${team1Name} Biggest Lead:</strong> ${Math.round(team1BiggestLead).toLocaleString()}</div>
        <div><strong>${team2Name} Biggest Lead:</strong> ${Math.round(team2BiggestLead).toLocaleString()}</div>
    `;

    // Toggle button
    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = currentChartType === 'cumulative' ? 'Show Differential View' : 'Show Cumulative View';
    toggleBtn.style.cssText = `
        padding: 0.5rem 1rem;
        background-color: #007bff;
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.9rem;
        transition: background-color 0.3s;
    `;
    toggleBtn.onmouseover = () => toggleBtn.style.backgroundColor = '#0056b3';
    toggleBtn.onmouseout = () => toggleBtn.style.backgroundColor = '#007bff';
    toggleBtn.onclick = () => toggleChartType();

    controlsDiv.appendChild(statsDiv);
    controlsDiv.appendChild(toggleBtn);
    chartArea.appendChild(controlsDiv);
}

function toggleChartType() {
    currentChartType = currentChartType === 'cumulative' ? 'differential' : 'cumulative';
    if (currentGameFlowData && currentTeam1Name && currentTeam2Name) {
        renderGameFlowChart(currentGameFlowData, currentTeam1Name, currentTeam2Name);
    }
}

function calculateLeadChanges(snapshots) {
    let leadChanges = 0;
    let prevDifferential = null;

    for (const snapshot of snapshots) {
        const differential = snapshot.team1_score - snapshot.team2_score;

        if (prevDifferential !== null) {
            if ((prevDifferential > 0 && differential < 0) ||
                (prevDifferential < 0 && differential > 0) ||
                (prevDifferential === 0 && differential !== 0)) {
                leadChanges++;
            }
        }

        prevDifferential = differential;
    }

    return leadChanges;
}

function calculateBiggestLead(snapshots, teamNumber) {
    let biggestLead = 0;

    for (const snapshot of snapshots) {
        const differential = snapshot.team1_score - snapshot.team2_score;

        if (teamNumber === 1 && differential > biggestLead) {
            biggestLead = differential;
        } else if (teamNumber === 2 && differential < 0 && Math.abs(differential) > biggestLead) {
            biggestLead = Math.abs(differential);
        }
    }

    return biggestLead;
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
            collection(db, collectionNames.seasons, SEASON_ID, getLeagueCollectionName('lineups')),
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
            renderGameFlowChart(flowData, team1.team_name, team2.team_name);
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
    loadPlayerData();
});
