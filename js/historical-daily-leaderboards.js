import { db, getDoc, getDocs, collection, doc, query, orderBy, limit as fbLimit, collectionNames, getLeagueCollectionName, getCurrentLeague, getConferenceNames } from './firebase-init.js';

// Get season from path (/S8/ or /S9/)
const pathMatch = window.location.pathname.match(/\/S(\d+)\//);
const seasonFromPath = pathMatch ? `S${pathMatch[1]}` : null;

let activeSeasonId = seasonFromPath || 'S9';
let allTeams = [];
let currentDate = null;
let availableDates = [];
let playerHistoryChart = null;

// --- UTILITY FUNCTIONS ---
function escapeHTML(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function getOrdinal(n) {
    if (n === undefined || n === null || n < 0) return 'N/A';
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function formatDate(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString + 'T00:00:00'); // Add time to ensure correct date parsing
    return date.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

// --- DATA FETCHING FUNCTIONS ---
async function loadTeams() {
    try {
        const teamsQuery = query(
            collection(db, collectionNames.teams),
            orderBy('team_name')
        );
        const teamsSnap = await getDocs(teamsQuery);
        allTeams = teamsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        console.log('Teams loaded:', allTeams.length);
    } catch (error) {
        console.error('Error loading teams:', error);
    }
}

function isDateCompleted(dateString) {
    // A date is considered completed after 7am ET the next day
    // Convert the date string to a Date object
    const gameDate = new Date(dateString + 'T00:00:00');

    // Get current time in ET (UTC-5 in standard time, UTC-4 in daylight time)
    const now = new Date();
    const etOffset = -5 * 60; // ET is UTC-5 (we'll use standard time)
    const nowET = new Date(now.getTime() + (etOffset + now.getTimezoneOffset()) * 60000);

    // Calculate when this date becomes "completed" (7am ET the next day)
    const completionTime = new Date(gameDate);
    completionTime.setDate(completionTime.getDate() + 1); // Next day
    completionTime.setHours(7, 0, 0, 0); // 7am

    // Check if current ET time is past the completion time
    return nowET >= completionTime;
}

async function fetchAvailableDates() {
    try {
        const leaderboardsRef = collection(db, getLeagueCollectionName('daily_leaderboards'));
        const leaderboardsSnap = await getDocs(leaderboardsRef);

        const allDates = leaderboardsSnap.docs
            .map(doc => doc.id)
            .filter(id => /^\d{4}-\d{2}-\d{2}$/.test(id)); // Only valid date format

        console.log('All dates from daily_leaderboards:', allDates.length);

        // Filter out exhibition/preseason dates
        const nonExhibitionDates = await filterOutExhibitionDates(allDates);

        // Filter out incomplete dates (current day before 7am ET the next day)
        const completedDates = nonExhibitionDates.filter(dateString => isDateCompleted(dateString));

        availableDates = completedDates
            .sort()
            .reverse(); // Most recent first

        console.log('Available dates (excluding exhibition/preseason and incomplete days):', availableDates);
        return availableDates;
    } catch (error) {
        console.error('Error fetching available dates:', error);
        return [];
    }
}

async function filterOutExhibitionDates(dates) {
    try {
        const seasonId = activeSeasonId || 'S9';

        // Try to fetch exhibition games to get dates to EXCLUDE
        console.log('Attempting to fetch exhibition games from seasons/', seasonId, '/exhibition_games');

        const exhibitionGamesRef = collection(db, collectionNames.seasons, seasonId, 'exhibition_games');
        const exhibitionGamesSnap = await getDocs(exhibitionGamesRef);

        console.log('Exhibition games documents found:', exhibitionGamesSnap.size);

        // Build a set of exhibition game dates to exclude
        const exhibitionDates = new Set();

        exhibitionGamesSnap.docs.forEach(doc => {
            // Extract date from document ID (format: YYYY-MM-DD-TEAM1-TEAM2)
            const docId = doc.id;
            if (docId !== 'placeholder' && docId.match(/^\d{4}-\d{2}-\d{2}/)) {
                const gameDate = docId.substring(0, 10); // Extract YYYY-MM-DD
                exhibitionDates.add(gameDate);
                console.log('Exhibition game found on date:', gameDate, 'from doc:', docId);
            }
        });

        console.log('Exhibition dates to exclude:', exhibitionDates.size, Array.from(exhibitionDates));


        // Filter OUT dates that are in exhibition games
        const filtered = dates.filter(date => !exhibitionDates.has(date));
        console.log(`Filtered ${dates.length} dates down to ${filtered.length} non-exhibition dates`);

        return filtered;
    } catch (error) {
        console.error('Error filtering exhibition dates:', error);
        console.error('Error details:', error.message, error.stack);
        // If error, return all dates as fallback to prevent breaking the page
        return dates;
    }
}

async function fetchDailyLeaderboard(dateString) {
    try {
        const leaderboardRef = doc(db, getLeagueCollectionName('daily_leaderboards'), dateString);
        const leaderboardSnap = await getDoc(leaderboardRef);

        if (leaderboardSnap.exists()) {
            const data = leaderboardSnap.data();
            return processLeaderboardData(data);
        } else {
            console.warn(`No leaderboard found for date: ${dateString}`);
            return null;
        }
    } catch (error) {
        console.error('Error fetching daily leaderboard:', error);
        return null;
    }
}

async function fetchPlayerHistory(playerId, playerName) {
    try {
        const leaderboardsRef = collection(db, getLeagueCollectionName('daily_leaderboards'));
        const leaderboardsSnap = await getDocs(leaderboardsRef);

        const playerHistory = [];

        // Only include dates that are in availableDates (excludes preseason)
        const validDatesSet = new Set(availableDates);

        leaderboardsSnap.docs.forEach(doc => {
            const dateId = doc.id;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(dateId)) return; // Skip non-date documents
            if (!validDatesSet.has(dateId)) return; // Skip preseason dates

            const data = doc.data();
            const processedData = processLeaderboardData(data);

            if (processedData && processedData.all_players) {
                const playerData = processedData.all_players.find(p => p.player_id === playerId);
                if (playerData) {
                    playerHistory.push({
                        date: dateId,
                        score: playerData.score,
                        rank: playerData.rank,
                        global_rank: playerData.global_rank,
                        percent_vs_median: playerData.percent_vs_median,
                        median_score: processedData.median_score
                    });
                }
            }
        });

        // Sort by date
        playerHistory.sort((a, b) => a.date.localeCompare(b.date));

        console.log(`Player history for ${playerName} (excluding preseason):`, playerHistory);
        return playerHistory;
    } catch (error) {
        console.error('Error fetching player history:', error);
        return [];
    }
}

function processLeaderboardData(data) {
    // Handle both old format (players) and new format (all_players, top_3, bottom_3)
    if (data.players && !data.all_players) {
        console.log('Converting old leaderboard format to new format...');
        const players = data.players.map((p, index) => ({
            ...p,
            rank: index + 1
        }));

        const medianScore = players.length > 0 ?
            (players.length % 2 === 0
                ? (players[Math.floor(players.length / 2) - 1].score + players[Math.floor(players.length / 2)].score) / 2
                : players[Math.floor(players.length / 2)].score)
            : 0;

        players.forEach(player => {
            player.percent_vs_median = medianScore !== 0
                ? ((player.score - medianScore) / Math.abs(medianScore)) * 100
                : 0;
        });

        return {
            top_3: players.slice(0, 3),
            bottom_3: players.slice(-3).reverse(),
            median_score: medianScore,
            all_players: players,
            date: data.date
        };
    }

    return data;
}

// --- RENDERING FUNCTIONS ---
async function renderDailyLeaderboard(leaderboardData, dateString) {
    const leaderboardContainer = document.getElementById('leaderboard-container');
    const dateTitle = document.getElementById('date-title');

    if (!leaderboardContainer || !dateTitle) {
        console.error('Leaderboard container or date title element not found');
        return;
    }

    // Update date title
    dateTitle.textContent = formatDate(dateString);

    if (!leaderboardData) {
        leaderboardContainer.innerHTML = '<div class="loading" style="padding: 2rem; text-align: center;">No leaderboard data available for this date.</div>';
        return;
    }

    const { top_3, bottom_3, median_score, all_players } = leaderboardData;

    if (!top_3 || !bottom_3 || !all_players || !Array.isArray(top_3) || !Array.isArray(bottom_3) || !Array.isArray(all_players)) {
        leaderboardContainer.innerHTML = '<div class="loading" style="padding: 2rem; text-align: center;">Leaderboard data is incomplete. Please try again later.</div>';
        console.error('Incomplete leaderboard data:', { top_3, bottom_3, all_players });
        return;
    }

    // Fetch player data to get rookie and all-star status
    const uniquePlayerIds = [...new Set(all_players.map(p => p.player_id))];
    const playerDataMap = new Map();

    try {
        const playerPromises = uniquePlayerIds.map(playerId =>
            getDoc(doc(db, collectionNames.players, playerId, collectionNames.seasonalStats, activeSeasonId))
        );
        const playerDocs = await Promise.all(playerPromises);

        playerDocs.forEach((playerDoc, index) => {
            if (playerDoc.exists()) {
                const data = playerDoc.data();
                playerDataMap.set(uniquePlayerIds[index], {
                    rookie: data.rookie === '1',
                    all_star: data.all_star === '1'
                });
            }
        });
    } catch (error) {
        console.error('Error fetching player badge data:', error);
    }

    // Build Top 3 section
    const top3HTML = top_3.map(player => {
        const team = allTeams.find(t => t.id === player.team_id);
        const specialTeamIds = ["EAST", "WEST", "EGM", "WGM", "RSE", "RSW"];
        const logoExt = team?.logo_ext || (specialTeamIds.includes(player.team_id) ? 'png' : 'webp');

        // Get badges
        const playerBadges = playerDataMap.get(player.player_id) || { rookie: false, all_star: false };
        const rookieBadge = playerBadges.rookie ? '<span class="rookie-badge">R</span>' : '';
        const allStarBadge = playerBadges.all_star ? '<span class="all-star-badge">★</span>' : '';

        return `
        <div class="leaderboard-stat">
            <div class="leaderboard-player-info">
                <span class="leaderboard-rank">#${player.rank}</span>
                <img src="../icons/${player.team_id}.${logoExt}" alt="${escapeHTML(player.team_name)}" class="team-logo" onerror="this.style.display='none'" style="width: 36px; height: 36px; margin: 0 8px;">
                <div>
                    <div class="leaderboard-player-name"><a href="player.html?id=${player.player_id}" style="color: inherit; text-decoration: none;">${escapeHTML(player.handle || player.player_name)}</a>${rookieBadge}${allStarBadge}</div>
                    <div class="leaderboard-team-name"><a href="team.html?id=${player.team_id}" style="color: inherit; text-decoration: none;">${escapeHTML(player.team_name)}</a></div>
                </div>
            </div>
            <div style="text-align: right;">
                <span class="leaderboard-score">${Math.round(player.score).toLocaleString()}</span>
                <div class="secondary-text">Rank: ${player.global_rank >= 0 ? player.global_rank : 'N/A'}</div>
            </div>
        </div>
        `;
    }).join('');

    // Build Bottom 3 section
    const bottom3HTML = bottom_3.map(player => {
        const team = allTeams.find(t => t.id === player.team_id);
        const specialTeamIds = ["EAST", "WEST", "EGM", "WGM", "RSE", "RSW"];
        const logoExt = team?.logo_ext || (specialTeamIds.includes(player.team_id) ? 'png' : 'webp');

        // Get badges
        const playerBadges = playerDataMap.get(player.player_id) || { rookie: false, all_star: false };
        const rookieBadge = playerBadges.rookie ? '<span class="rookie-badge">R</span>' : '';
        const allStarBadge = playerBadges.all_star ? '<span class="all-star-badge">★</span>' : '';

        return `
        <div class="leaderboard-stat">
            <div class="leaderboard-player-info">
                <span class="leaderboard-rank">#${player.rank}</span>
                <img src="../icons/${player.team_id}.${logoExt}" alt="${escapeHTML(player.team_name)}" class="team-logo" onerror="this.style.display='none'" style="width: 36px; height: 36px; margin: 0 8px;">
                <div>
                    <div class="leaderboard-player-name"><a href="player.html?id=${player.player_id}" style="color: inherit; text-decoration: none;">${escapeHTML(player.handle || player.player_name)}</a>${rookieBadge}${allStarBadge}</div>
                    <div class="leaderboard-team-name"><a href="team.html?id=${player.team_id}" style="color: inherit; text-decoration: none;">${escapeHTML(player.team_name)}</a></div>
                </div>
            </div>
            <div style="text-align: right;">
                <span class="leaderboard-score">${Math.round(player.score).toLocaleString()}</span>
                <div class="secondary-text">Rank: ${player.global_rank >= 0 ? player.global_rank : 'N/A'}</div>
            </div>
        </div>
        `;
    }).join('');

    // Build Percent vs Median section with click handlers
    const percentListHTML = all_players.map(player => {
        const percentClass = player.percent_vs_median >= 0 ? 'positive' : 'negative';
        const percentSign = player.percent_vs_median >= 0 ? '+' : '';

        const team = allTeams.find(t => t.id === player.team_id);
        const specialTeamIds = ["EAST", "WEST", "EGM", "WGM", "RSE", "RSW"];
        const logoExt = team?.logo_ext || (specialTeamIds.includes(player.team_id) ? 'png' : 'webp');

        // Get badges
        const playerBadges = playerDataMap.get(player.player_id) || { rookie: false, all_star: false };
        const rookieBadge = playerBadges.rookie ? '<span class="rookie-badge">R</span>' : '';
        const allStarBadge = playerBadges.all_star ? '<span class="all-star-badge">★</span>' : '';

        return `
            <div class="leaderboard-stat player-history-clickable" data-player-id="${player.player_id}" data-player-name="${escapeHTML(player.handle || player.player_name)}">
                <div class="leaderboard-player-info">
                    <span class="leaderboard-rank">#${player.rank}</span>
                    <img src="../icons/${player.team_id}.${logoExt}" alt="${escapeHTML(player.team_name)}" class="team-logo" onerror="this.style.display='none'" style="width: 36px; height: 36px; margin: 0 8px;">
                    <div>
                        <div class="leaderboard-player-name">${escapeHTML(player.handle || player.player_name)}${rookieBadge}${allStarBadge}</div>
                        <div class="leaderboard-team-name">${escapeHTML(player.team_name)}</div>
                    </div>
                </div>
                <div style="text-align: right;">
                    <span class="leaderboard-score ${percentClass}">${percentSign}${player.percent_vs_median.toFixed(1)}%</span>
                    <div class="secondary-text">${Math.round(player.score).toLocaleString()} | ${getOrdinal(player.global_rank)}</div>
                </div>
            </div>
        `;
    }).join('');

    leaderboardContainer.innerHTML = `
        <div class="leaderboard-section">
            <h4>🏆 Top 3 Performers</h4>
            ${top3HTML}
        </div>

        <div class="leaderboard-section">
            <h4>📊 Median Daily Score: ${Math.round(median_score).toLocaleString()}</h4>
        </div>

        <div class="leaderboard-section">
            <h4>📉 Bottom 3 Performers</h4>
            ${bottom3HTML}
        </div>

        <div class="leaderboard-section">
            <h4>📈 All Players (% vs Median) - Click to view history</h4>
            <div class="leaderboard-percent-list">
                ${percentListHTML}
            </div>
        </div>
    `;

    // Add click handlers for player history
    setupPlayerHistoryClickHandlers();
}

function setupPlayerHistoryClickHandlers() {
    const clickableElements = document.querySelectorAll('.player-history-clickable');

    clickableElements.forEach(element => {
        element.addEventListener('click', async () => {
            const playerId = element.getAttribute('data-player-id');
            const playerName = element.getAttribute('data-player-name');

            if (playerId && playerName) {
                await showPlayerHistory(playerId, playerName);
            }
        });
    });
}

async function showPlayerHistory(playerId, playerName) {
    const modal = document.getElementById('player-history-modal');
    const title = document.getElementById('player-history-title');
    const chartContainer = document.getElementById('player-history-chart-container');
    const statsContainer = document.getElementById('player-history-stats');

    if (!modal || !title || !chartContainer || !statsContainer) {
        console.error('Player history modal elements not found');
        return;
    }

    // Show modal with loading state
    modal.style.display = 'block';
    title.textContent = `${playerName} - Daily History`;
    chartContainer.innerHTML = '<div class="loading">Loading player history...</div>';
    statsContainer.innerHTML = '';

    // Fetch player history
    const history = await fetchPlayerHistory(playerId, playerName);

    if (history.length === 0) {
        chartContainer.innerHTML = '<div class="loading">No historical data available for this player.</div>';
        return;
    }

    // Render chart
    chartContainer.innerHTML = '<canvas id="player-history-chart"></canvas>';
    renderPlayerHistoryChart(history, playerName);

    // Render stats
    renderPlayerHistoryStats(history, statsContainer);
}

function renderPlayerHistoryChart(history, playerName) {
    const canvas = document.getElementById('player-history-chart');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');

    // Destroy existing chart if it exists
    if (playerHistoryChart) {
        playerHistoryChart.destroy();
    }

    const labels = history.map(h => {
        const date = new Date(h.date + 'T00:00:00');
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    });

    const isDarkMode = document.documentElement.classList.contains('dark-mode');
    const textColor = isDarkMode ? '#e0e0e0' : '#333';
    const gridColor = isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';

    playerHistoryChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: '% vs Median',
                    data: history.map(h => h.percent_vs_median),
                    borderColor: 'rgb(75, 192, 192)',
                    backgroundColor: 'rgba(75, 192, 192, 0.2)',
                    yAxisID: 'y',
                    tension: 0.1
                },
                {
                    label: 'Global Rank',
                    data: history.map(h => h.global_rank),
                    borderColor: 'rgb(255, 99, 132)',
                    backgroundColor: 'rgba(255, 99, 132, 0.2)',
                    yAxisID: 'y1',
                    tension: 0.1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: {
                title: {
                    display: true,
                    text: `${playerName} - Daily Trend`,
                    color: textColor
                },
                legend: {
                    labels: {
                        color: textColor
                    }
                },
                tooltip: {
                    callbacks: {
                        afterLabel: function(context) {
                            const index = context.dataIndex;
                            const historyItem = history[index];
                            return [
                                `Global Rank: ${getOrdinal(historyItem.global_rank)}`,
                                `vs Median: ${historyItem.percent_vs_median >= 0 ? '+' : ''}${historyItem.percent_vs_median.toFixed(1)}%`
                            ];
                        }
                    }
                }
            },
            scales: {
                x: {
                    ticks: {
                        color: textColor
                    },
                    grid: {
                        color: gridColor
                    }
                },
                y: {
                    type: 'linear',
                    display: true,
                    position: 'left',
                    title: {
                        display: true,
                        text: '% vs Median',
                        color: textColor
                    },
                    ticks: {
                        color: textColor,
                        callback: function(value) {
                            return value.toFixed(1) + '%';
                        }
                    },
                    grid: {
                        color: gridColor
                    }
                },
                y1: {
                    type: 'linear',
                    display: true,
                    position: 'right',
                    title: {
                        display: true,
                        text: 'Global Rank',
                        color: textColor
                    },
                    reverse: true,
                    ticks: {
                        color: textColor,
                        stepSize: 1,
                        callback: function(value) {
                            if (Number.isInteger(value)) {
                                return value;
                            }
                        }
                    },
                    grid: {
                        drawOnChartArea: false,
                    }
                }
            }
        }
    });
}

function renderPlayerHistoryStats(history, container) {
    const totalGames = history.length;
    const avgScore = history.reduce((sum, h) => sum + h.score, 0) / totalGames;

    // Calculate median rank (using global_rank)
    const sortedRanks = history.map(h => h.global_rank).sort((a, b) => a - b);
    const medianRank = totalGames % 2 === 0
        ? (sortedRanks[Math.floor(totalGames / 2) - 1] + sortedRanks[Math.floor(totalGames / 2)]) / 2
        : sortedRanks[Math.floor(totalGames / 2)];

    const avgPercentVsMedian = history.reduce((sum, h) => sum + h.percent_vs_median, 0) / totalGames;

    const bestGame = history.reduce((best, h) => h.score > best.score ? h : best, history[0]);
    const worstGame = history.reduce((worst, h) => h.score < worst.score ? h : worst, history[0]);
    const bestRank = history.reduce((best, h) => h.global_rank < best.global_rank ? h : best, history[0]);

    const top100Finishes = history.filter(h => h.rank <= 100).length;
    const aboveMedian = history.filter(h => h.percent_vs_median >= 0).length;

    container.innerHTML = `
        <div class="stats-grid">
            <div class="stat-item">
                <div class="stat-label">Total Games</div>
                <div class="stat-value">${totalGames}</div>
            </div>
            <div class="stat-item">
                <div class="stat-label">Avg Score</div>
                <div class="stat-value">${Math.round(avgScore).toLocaleString()}</div>
            </div>
            <div class="stat-item">
                <div class="stat-label">Median Rank</div>
                <div class="stat-value">${medianRank.toFixed(1)}</div>
            </div>
            <div class="stat-item">
                <div class="stat-label">Avg vs Median</div>
                <div class="stat-value ${avgPercentVsMedian >= 0 ? 'positive' : 'negative'}">${avgPercentVsMedian >= 0 ? '+' : ''}${avgPercentVsMedian.toFixed(1)}%</div>
            </div>
            <div class="stat-item">
                <div class="stat-label">Top 100 Finishes</div>
                <div class="stat-value">${top100Finishes}</div>
            </div>
            <div class="stat-item">
                <div class="stat-label">Above Median</div>
                <div class="stat-value">${aboveMedian} / ${totalGames}</div>
            </div>
            <div class="stat-item">
                <div class="stat-label">Best Score</div>
                <div class="stat-value">${Math.round(bestGame.score).toLocaleString()}</div>
                <div class="stat-detail">${formatDate(bestGame.date)}</div>
            </div>
            <div class="stat-item">
                <div class="stat-label">Best Rank</div>
                <div class="stat-value">${getOrdinal(bestRank.global_rank)}</div>
                <div class="stat-detail">${formatDate(bestRank.date)}</div>
            </div>
        </div>
    `;
}

// --- DATE NAVIGATION FUNCTIONS ---
async function loadDateLeaderboard(dateString) {
    const leaderboardContainer = document.getElementById('leaderboard-container');

    if (!dateString) {
        leaderboardContainer.innerHTML = '<div class="loading" style="padding: 2rem; text-align: center;">Please select a date.</div>';
        return;
    }

    currentDate = dateString;
    leaderboardContainer.innerHTML = '<div class="loading" style="padding: 2rem; text-align: center;">Loading leaderboard...</div>';

    const leaderboardData = await fetchDailyLeaderboard(dateString);
    renderDailyLeaderboard(leaderboardData, dateString);

    // Update date picker
    const datePicker = document.getElementById('date-picker');
    if (datePicker) {
        datePicker.value = dateString;
    }

    // Update navigation buttons
    updateNavigationButtons();
}

function updateNavigationButtons() {
    const prevBtn = document.getElementById('prev-date-btn');
    const nextBtn = document.getElementById('next-date-btn');

    if (!currentDate || availableDates.length === 0) return;

    const currentIndex = availableDates.indexOf(currentDate);

    // Prev button (goes to next date in the reversed array, which is an earlier date)
    if (prevBtn) {
        prevBtn.disabled = currentIndex >= availableDates.length - 1;
    }

    // Next button (goes to previous date in the reversed array, which is a later date)
    if (nextBtn) {
        nextBtn.disabled = currentIndex <= 0;
    }
}

function navigateToDate(direction) {
    if (!currentDate || availableDates.length === 0) return;

    const currentIndex = availableDates.indexOf(currentDate);
    let newIndex;

    if (direction === 'prev') {
        newIndex = currentIndex + 1; // Next in reversed array = earlier date
    } else if (direction === 'next') {
        newIndex = currentIndex - 1; // Previous in reversed array = later date
    }

    if (newIndex >= 0 && newIndex < availableDates.length) {
        loadDateLeaderboard(availableDates[newIndex]);
    }
}

// --- EVENT HANDLERS ---
function setupEventHandlers() {
    // Date picker change
    const datePicker = document.getElementById('date-picker');
    const loadBtn = document.getElementById('load-date-btn');

    if (loadBtn) {
        loadBtn.addEventListener('click', () => {
            if (datePicker && datePicker.value) {
                loadDateLeaderboard(datePicker.value);
            }
        });
    }

    if (datePicker) {
        datePicker.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && datePicker.value) {
                loadDateLeaderboard(datePicker.value);
            }
        });
    }

    // Navigation buttons
    const prevBtn = document.getElementById('prev-date-btn');
    const nextBtn = document.getElementById('next-date-btn');
    const todayBtn = document.getElementById('today-btn');

    if (prevBtn) {
        prevBtn.addEventListener('click', () => navigateToDate('prev'));
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', () => navigateToDate('next'));
    }

    if (todayBtn) {
        todayBtn.addEventListener('click', () => {
            if (availableDates.length > 0) {
                loadDateLeaderboard(availableDates[0]); // Most recent date
            }
        });
    }

    // Modal close
    const closeModal = document.getElementById('close-player-history');
    const modal = document.getElementById('player-history-modal');

    if (closeModal) {
        closeModal.addEventListener('click', () => {
            if (modal) {
                modal.style.display = 'none';
            }
        });
    }

    // Close modal when clicking outside
    window.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    });
}

// --- INITIALIZATION ---
async function init() {
    console.log('Initializing historical daily leaderboards page...');

    // Load teams
    await loadTeams();

    // Fetch available dates
    const dates = await fetchAvailableDates();

    if (dates.length > 0) {
        // Load the most recent date
        await loadDateLeaderboard(dates[0]);

        // Set min/max for date picker
        const datePicker = document.getElementById('date-picker');
        if (datePicker) {
            datePicker.min = dates[dates.length - 1];
            datePicker.max = dates[0];
        }
    } else {
        const leaderboardContainer = document.getElementById('leaderboard-container');
        if (leaderboardContainer) {
            leaderboardContainer.innerHTML = '<div class="loading" style="padding: 2rem; text-align: center;">No historical daily leaderboard data available.</div>';
        }
    }

    // Setup event handlers
    setupEventHandlers();

    console.log('Historical daily leaderboards page initialized');
}

// Wait for DOM to be ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Reload data when league changes
window.addEventListener('leagueChanged', async (event) => {
    const newLeague = event.detail.league;
    console.log('[Historical Daily Leaderboards] League changed to:', newLeague);

    // Hide content during transition
    const mainElement = document.querySelector('main');
    if (mainElement) mainElement.style.opacity = '0';

    // Small delay before reloading to ensure fade-out completes
    setTimeout(async () => {
        // Reinitialize the page with new league data
        await init();

        // Show content after reload
        setTimeout(() => {
            if (mainElement) mainElement.style.opacity = '1';
        }, 100);
    }, 150);
});
