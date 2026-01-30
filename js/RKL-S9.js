import { db, getDoc, getDocs, collection, doc, query, where, orderBy, limit, onSnapshot, collectionGroup, documentId, getCurrentLeague, collectionNames, getLeagueCollectionName, getConferenceNames } from '../js/firebase-init.js';
import { generateLineupTable } from './main.js';

// Get season from path (/S8/ or /S9/), URL parameter, or query for active season
const urlParams = new URLSearchParams(window.location.search);
const pathMatch =  window.location.pathname.match(/\/S(\d+)\//);
const seasonFromPath = pathMatch ? `S${pathMatch[1]}` : null;
const urlSeasonId = seasonFromPath || urlParams.get('season');

let currentScoringStatus = null; // Tracks the current scoring status to prevent redundant re-renders.

let activeSeasonId = urlSeasonId || '';
let allTeams = [];
let liveGamesUnsubscribe = null; // To store the listener unsubscribe function
let dailyLeaderboardUnsubscribe = null; // To store the daily leaderboard listener unsubscribe function
let statusUnsubscribe = null; // To store the status listener unsubscribe function
let usageStatsUnsubscribe = null; // To store the usage stats listener unsubscribe function
let showLiveFeatures = true; // Controls visibility of new live features

// --- UTILITY FUNCTIONS ---
function formatInThousands(value) {
    const num = parseFloat(value);
    if (isNaN(num)) return '-';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'k';
    return Math.round(num).toLocaleString();
}

function formatDate(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateShort(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const year = String(date.getFullYear()).slice(-2);
    return `${month}/${day}/${year}`;
}

function isPostseasonWeek(weekString) {
    if (!weekString) return false;
    return isNaN(parseInt(weekString, 10));
}

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


// --- DATA FETCHING FUNCTIONS ---

// Cache for on-demand game document fetches
const gameDocCache = new Map();

async function fetchGameDoc(gameId, collectionName) {
    const cacheKey = `${collectionName}:${gameId}`;
    if (gameDocCache.has(cacheKey)) {
        return gameDocCache.get(cacheKey);
    }
    try {
        const gameRef = doc(db, collectionNames.seasons, activeSeasonId, collectionName, gameId);
        const gameSnap = await getDoc(gameRef);
        if (!gameSnap.exists()) {
            console.warn(`Game not found: ${collectionName}/${gameId}`);
            return null;
        }
        const gameData = { id: gameSnap.id, ...gameSnap.data() };
        gameDocCache.set(cacheKey, gameData);
        return gameData;
    } catch (error) {
        console.error(`Error fetching game ${gameId}:`, error);
        return null;
    }
}

async function getActiveSeason() {
    // If season is specified via URL parameter, fetch that season's data
    if (urlSeasonId) {
        const seasonDocRef = doc(db, collectionNames.seasons, urlSeasonId);
        const seasonDocSnap = await getDoc(seasonDocRef);
        if (!seasonDocSnap.exists()) throw new Error(`Season ${urlSeasonId} not found.`);
        return seasonDocSnap.data();
    }

    // Otherwise query for the active season
    const seasonsQuery = query(collection(db, collectionNames.seasons), where('status', '==', 'active'), limit(1));
    const seasonsSnapshot = await getDocs(seasonsQuery);
    if (seasonsSnapshot.empty) {
        throw new Error("No active season found in Firestore.");
    }
    const seasonDoc = seasonsSnapshot.docs[0];
    activeSeasonId = seasonDoc.id;
    return seasonDoc.data();
}

async function fetchAllTeams(seasonId) {
    if (!seasonId) {
        console.error("fetchAllTeams was called without a seasonId.");
        return;
    }
    const teamsCollectionName = collectionNames.teams;
    const seasonalRecordsCollectionName = collectionNames.seasonalRecords;

    const teamsQuery = query(collection(db, teamsCollectionName));
    const recordsQuery = query(
      collectionGroup(db, seasonalRecordsCollectionName),
      where('seasonId', '==', seasonId)
    );

    const [teamsSnap, recordsSnap] = await Promise.all([
        getDocs(teamsQuery),
        getDocs(recordsQuery)
    ]);

    if (teamsSnap.empty) {
        console.error(`No documents found in the '${teamsCollectionName}' collection.`);
        return;
    }

    const seasonalRecordsMap = new Map();
    recordsSnap.forEach(doc => {
        // Server-side filtered by seasonId - all results match seasonId
        const teamId = doc.ref.parent.parent.id;
        seasonalRecordsMap.set(teamId, doc.data());
    });

    const teams = teamsSnap.docs.map(teamDoc => {
        const teamData = { id: teamDoc.id, ...teamDoc.data() };
        const seasonalRecord = seasonalRecordsMap.get(teamDoc.id);

        if (seasonalRecord) {
            return { ...teamData, ...seasonalRecord };
        }
        return null;
    });

    allTeams = teams.filter(t => t !== null);
    console.log(`Successfully loaded ${allTeams.length} teams with seasonal records.`);
}


// --- DOM MANIPULATION & RENDERING ---

function loadStandingsPreview() {
    if (allTeams.length === 0) {
        document.getElementById('eastern-standings').innerHTML = '<tr><td colspan="4" class="error">Could not load standings.</td></tr>';
        document.getElementById('western-standings').innerHTML = '<tr><td colspan="4" class="error">Could not load standings.</td></tr>';
        return;
    }

    const standingsSort = (a, b) => (a.postseed || 99) - (b.postseed || 99);

    // Get conference names based on current league
    const conferenceNames = getConferenceNames();
    const conference1 = conferenceNames.primary;
    const conference2 = conferenceNames.secondary;

    // Update conference title DOM elements
    const conferenceTitles = document.querySelectorAll('.conference-title');
    if (conferenceTitles.length >= 2) {
        conferenceTitles[0].textContent = conference1 + ' Conference';
        conferenceTitles[1].textContent = conference2 + ' Conference';
    }

    const easternTeams = allTeams
        .filter(t => t.conference && t.conference.toLowerCase() === conference1.toLowerCase())
        .sort(standingsSort)
        .slice(0, 5);

    const westernTeams = allTeams
        .filter(t => t.conference && t.conference.toLowerCase() === conference2.toLowerCase())
        .sort(standingsSort)
        .slice(0, 5);

    const renderTable = (teams, tbodyId) => {
        const tbody = document.getElementById(tbodyId);
        if (!tbody) return;
        if (teams.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="loading">No teams to display.</td></tr>';
            return;
        }
        tbody.innerHTML = teams.map(team => {
            let clinchBadgeHtml = '';
            if (team.playoffs === 1 || team.playoffs === '1') {
                clinchBadgeHtml = '<span class="clinch-badge clinch-playoff">x</span>';
            } else if (team.playin === 1 || team.playin === '1') {
                clinchBadgeHtml = '<span class="clinch-badge clinch-playin">p</span>';
            } else if (team.elim === 1 || team.elim === '1') {
                clinchBadgeHtml = '<span class="clinch-badge clinch-eliminated">e</span>';
            }
            
            // Determine the correct logo extension, defaulting to 'webp'
            const logoExt = team.logo_ext || 'webp';

            return `
                <tr>
                    <td>
                        <a href="team.html?id=${team.id}" class="team-link">
                            <img src="../icons/${team.id}.${logoExt}" alt="${team.team_name}" class="team-logo" onerror="this.style.display='none'">
                            <span>${team.team_name}</span>
                            ${clinchBadgeHtml}
                        </a>
                    </td>
                    <td style="text-align: center;">${team.wins || 0}-${team.losses || 0}</td>
                    <td style="text-align: center;">${Math.round(team.pam || 0).toLocaleString()}</td>
                    <td class="desktop-only-col" style="text-align: center;">${Math.round(team.med_starter_rank) || '-'}</td>
                </tr>`;
        }).join('');
    };

    renderTable(easternTeams, 'eastern-standings');
    renderTable(westernTeams, 'western-standings');
}

function initializeGamesSection(seasonData) {
    const statusRef = doc(db, getLeagueCollectionName('live_scoring_status'), 'status');
    const gamesList = document.getElementById('recent-games');

    // Store the unsubscribe function for cleanup
    statusUnsubscribe = onSnapshot(statusRef, (statusSnap) => {
        const statusData = statusSnap.exists ? statusSnap.data() : {};
        const newStatus = statusData.status || 'stopped';
        showLiveFeatures = statusData.show_live_features !== false; // Default to true if not set

        if (newStatus === currentScoringStatus) {
            return;
        }

        currentScoringStatus = newStatus;

        if (currentScoringStatus === 'active' || currentScoringStatus === 'paused') {
            loadLiveGames();
        } else { // status is 'stopped'
            if (liveGamesUnsubscribe) {
                liveGamesUnsubscribe();
                liveGamesUnsubscribe = null;
            }
            if (gamesList) {
                gamesList.dataset.liveInitialized = 'false';
            }
            loadRecentGames();
        }
    }, (error) => {
        console.error("Error listening to scoring status, defaulting to recent games:", error);
        loadRecentGames();
    });
}

function loadLiveGames() {
    const gamesList = document.getElementById('recent-games');
    const gamesHeader = document.getElementById('games-header-title');
    const infoIconContainer = document.getElementById('live-scoring-info-icon-container');
    if (!gamesList || !gamesHeader) return;

    if (gamesList.dataset.liveInitialized === 'true') {
        return;
    }
    gamesList.dataset.liveInitialized = 'true';

    gamesHeader.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="24" height="24" style="vertical-align: -6px; margin-right: 8px;">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/>
            <circle cx="12" cy="12" r="5" fill="#dc3545"/>
        </svg>
        Live Games`;
    
    if (infoIconContainer) {
        infoIconContainer.style.display = 'block';
    }

    // Show daily leaderboard icon during live scoring (if admin allows)
    const leaderboardIcon = document.getElementById('daily-leaderboard-icon');
    if (leaderboardIcon && showLiveFeatures) {
        leaderboardIcon.style.display = 'flex';
        leaderboardIcon.onclick = () => toggleDailyLeaderboard();
    } else if (leaderboardIcon) {
        leaderboardIcon.style.display = 'none';
    }

    gamesList.innerHTML = '<div class="loading">Connecting to live games...</div>';

    const liveGamesQuery = query(
        collection(db, collectionNames.liveGames),
        where('seasonId', '==', activeSeasonId)
    );

    liveGamesUnsubscribe = onSnapshot(liveGamesQuery, async (snapshot) => {
        const loadingDiv = gamesList.querySelector('.loading');
        if (loadingDiv) loadingDiv.remove();

        if (snapshot.empty) {
            gamesList.querySelectorAll('.game-item').forEach(item => item.remove());
            if (!gamesList.querySelector('.no-games-message')) {
                const noGamesDiv = document.createElement('div');
                noGamesDiv.className = 'loading no-games-message';
                noGamesDiv.textContent = 'No live games are currently active.';
                gamesList.appendChild(noGamesDiv);
            }
            return;
        }

        const noGamesMessage = gamesList.querySelector('.no-games-message');
        if (noGamesMessage) noGamesMessage.remove();

        const activeGameIds = new Set(snapshot.docs.map(doc => doc.id));
        const allScores = snapshot.docs.map(doc => {
            const game = doc.data();
            const team1_total = game.team1_lineup.reduce((sum, p) => sum + (p.final_score || 0), 0);
            const team2_total = game.team2_lineup.reduce((sum, p) => sum + (p.final_score || 0), 0);
            return { team1_total, team2_total };
        });
        const maxScore = Math.max(...allScores.flatMap(g => [g.team1_total, g.team2_total]), 1);

        // Process live games - use for...of to handle async fallback fetches
        for (const gameDoc of snapshot.docs) {
            const gameId = gameDoc.id;
            const liveGameData = gameDoc.data();

            // First, try to find the team based on the player's team_id in the live game data.
            let team1 = allTeams.find(t => t.id === liveGameData.team1_lineup[0]?.team_id);
            let team2 = allTeams.find(t => t.id === liveGameData.team2_lineup[0]?.team_id);

            // If that fails (e.g., for the GM game), fall back to fetching the original game doc on-demand.
            let originalGame = null;
            if (!team1 || !team2) {
                const collName = liveGameData.collectionName || 'games';
                originalGame = await fetchGameDoc(gameId, collName);
                if (originalGame) {
                    if (!team1) team1 = allTeams.find(t => t.id === originalGame.team1_id);
                    if (!team2) team2 = allTeams.find(t => t.id === originalGame.team2_id);
                }
            }

            if (!team1 || !team2) {
                // If teams still not found, skip rendering this game tile to avoid errors.
                console.warn(`Could not find team data for live game ID: ${gameId}`);
                continue;
            }

            const specialTeamIds = ["EAST", "WEST", "EGM", "WGM", "RSE", "RSW"];
            const team1LogoExt = team1.logo_ext || (specialTeamIds.includes(team1.id) ? 'png' : 'webp');
            const team2LogoExt = team2.logo_ext || (specialTeamIds.includes(team2.id) ? 'png' : 'webp');

            // For postseason records, we need the original game - fetch if not already fetched
            let gameIsPostseason = false;
            if (!originalGame && (liveGameData.week && isPostseasonWeek(liveGameData.week))) {
                const collName = liveGameData.collectionName || 'post_games';
                originalGame = await fetchGameDoc(gameId, collName);
            }
            gameIsPostseason = originalGame ? isPostseasonWeek(originalGame.week) : false;
            let team1Record, team2Record;

            if (gameIsPostseason && originalGame) {
                const team1SeedHTML = originalGame.team1_seed ? `<strong>(${originalGame.team1_seed})</strong> ` : '';
                const team2SeedHTML = originalGame.team2_seed ? `<strong>(${originalGame.team2_seed})</strong> ` : '';
                team1Record = `${team1SeedHTML}${originalGame.team1_wins || 0}-${originalGame.team2_wins || 0}`;
                team2Record = `${team2SeedHTML}${originalGame.team2_wins || 0}-${originalGame.team1_wins || 0}`;
            } else {
                team1Record = `${team1.wins || 0}-${team1.losses || 0}`;
                team2Record = `${team2.wins || 0}-${team2.losses || 0}`;
            }

            const team1_total = liveGameData.team1_lineup.reduce((sum, p) => sum + (p.final_score || 0), 0);
            const team2_total = liveGameData.team2_lineup.reduce((sum, p) => sum + (p.final_score || 0), 0);
            
            const isTeam1Winning = team1_total >= team2_total;
            const team1_bar_percent = (team1_total / maxScore) * 100;
            const team2_bar_percent = (team2_total / maxScore) * 100;

            let gameItem = gamesList.querySelector(`.game-item[data-game-id="${gameId}"]`);

            if (gameItem) { // UPDATE EXISTING
                const teamScores = gameItem.querySelectorAll('.team-score');
                const teamBars = gameItem.querySelectorAll('.team-bar');
                const teamRecords = gameItem.querySelectorAll('.team-record');
                const teamLogos = gameItem.querySelectorAll('.team-logo');
                
                if (teamLogos.length === 2) {
                    teamLogos[0].src = `../icons/${team1.id}.${team1LogoExt}`;
                    teamLogos[1].src = `../icons/${team2.id}.${team2LogoExt}`;
                }

                teamScores[0].textContent = formatInThousands(team1_total);
                teamScores[1].textContent = formatInThousands(team2_total);
                teamRecords[0].innerHTML = team1Record;
                teamRecords[1].innerHTML = team2Record;
                
                teamBars[0].style.width = `${team1_bar_percent}%`;
                teamBars[1].style.width = `${team2_bar_percent}%`;

                teamBars[0].classList.toggle('winner', isTeam1Winning);
                teamBars[0].classList.toggle('loser', !isTeam1Winning);
                teamBars[1].classList.toggle('winner', !isTeam1Winning);
                teamBars[1].classList.toggle('loser', isTeam1Winning);
            } else { // CREATE NEW
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = `
                    <div class="game-item" data-game-id="${gameId}" data-is-live="true">
                        <div class="game-matchup">
                            <div class="team">
                                <img src="../icons/${team1.id}.${team1LogoExt}" alt="${team1.team_name}" class="team-logo" onerror="this.style.display='none'">
                                <div class="team-info">
                                    <span class="team-name">${team1.team_name}</span>
                                    <span class="team-record">${team1Record}</span>
                                </div>
                                <div class="winner-indicator-placeholder"></div>
                                <div class="team-bar-container">
                                    <div class="team-bar ${isTeam1Winning ? 'winner' : 'loser'}" style="width: ${team1_bar_percent}%;"></div>
                                </div>
                                <span class="team-score">${formatInThousands(team1_total)}</span>
                            </div>
                            <div class="team">
                                <img src="../icons/${team2.id}.${team2LogoExt}" alt="${team2.team_name}" class="team-logo" onerror="this.style.display='none'">
                                <div class="team-info">
                                    <span class="team-name">${team2.team_name}</span>
                                    <span class="team-record">${team2Record}</span>
                                </div>
                                <div class="winner-indicator-placeholder"></div>
                                <div class="team-bar-container">
                                    <div class="team-bar ${!isTeam1Winning ? 'winner' : 'loser'}" style="width: ${team2_bar_percent}%;"></div>
                                </div>
                                <span class="team-score">${formatInThousands(team2_total)}</span>
                            </div>
                        </div>
                        <div class="game-status live">
                            <span class="live-indicator"></span>LIVE
                        </div>
                    </div>`.trim();
                gameItem = tempDiv.firstChild;
                gameItem.addEventListener('click', () => showGameDetails(gameItem.dataset.gameId, true));
                gamesList.appendChild(gameItem);
            }
        }

        gamesList.querySelectorAll('.game-item[data-is-live="true"]').forEach(item => {
            if (!activeGameIds.has(item.dataset.gameId)) {
                item.classList.add('fade-out');
                item.addEventListener('animationend', () => item.remove(), { once: true });
            }
        });

    }, (error) => {
        console.error("Error fetching live games:", error);
        gamesList.innerHTML = '<div class="error">Could not load live games.</div>';
    });
}

async function loadRecentGames() {
    const gamesList = document.getElementById('recent-games');
    const gamesHeader = document.getElementById('games-header-title');
    const infoIconContainer = document.getElementById('live-scoring-info-icon-container');
    if (!gamesList || !gamesHeader) return;

    if (infoIconContainer) {
        infoIconContainer.style.display = 'none';
    }

    // Hide daily leaderboard icon when not in live mode and clean up listener
    const leaderboardIcon = document.getElementById('daily-leaderboard-icon');
    const leaderboardView = document.getElementById('daily-leaderboard-view');
    if (leaderboardIcon) {
        leaderboardIcon.style.display = 'none';
        leaderboardIcon.classList.remove('active');
    }
    if (leaderboardView) {
        leaderboardView.style.display = 'none';
        leaderboardView.innerHTML = '';
    }
    // Clean up the leaderboard listener
    if (dailyLeaderboardUnsubscribe) {
        console.log('Cleaning up daily leaderboard listener (switched to recent games)');
        dailyLeaderboardUnsubscribe();
        dailyLeaderboardUnsubscribe = null;
    }

    gamesList.innerHTML = '<div class="loading">Loading recent games...</div>';

    try {
        // Fetch recent completed games from each collection, ordered by date descending
        const regularSeasonGamesQuery = query(
            collection(db, collectionNames.seasons, activeSeasonId, 'games'),
            where('completed', '==', 'TRUE'),
            orderBy('date', 'desc'),
            limit(1)
        );
        const postSeasonGamesQuery = query(
            collection(db, collectionNames.seasons, activeSeasonId, 'post_games'),
            where('completed', '==', 'TRUE'),
            orderBy('date', 'desc'),
            limit(1)
        );
        const exhibitionGamesQuery = query(
            collection(db, collectionNames.seasons, activeSeasonId, 'exhibition_games'),
            where('completed', '==', 'TRUE'),
            orderBy('date', 'desc'),
            limit(1)
        );

        const [regSnap, postSnap, exhSnap] = await Promise.all([
            getDocs(regularSeasonGamesQuery),
            getDocs(postSeasonGamesQuery),
            getDocs(exhibitionGamesQuery)
        ]);

        // Get the most recent game from each collection type
        const candidates = [];
        if (!regSnap.empty) candidates.push({ doc: regSnap.docs[0], collection: 'games' });
        if (!postSnap.empty) candidates.push({ doc: postSnap.docs[0], collection: 'post_games' });
        if (!exhSnap.empty) candidates.push({ doc: exhSnap.docs[0], collection: 'exhibition_games' });

        if (candidates.length === 0) {
            gamesList.innerHTML = '<div class="loading">No completed games yet.</div>';
            return;
        }

        // Find which collection has the most recent game
        candidates.sort((a, b) => new Date(b.doc.data().date) - new Date(a.doc.data().date));
        const mostRecentGameInfo = candidates[0];
        const mostRecentDate = mostRecentGameInfo.doc.data().date;
        const collectionToQuery = mostRecentGameInfo.collection;

        // Fetch all completed games from that date in the winning collection
        const gamesSnapshot = await getDocs(query(
            collection(db, collectionNames.seasons, activeSeasonId, collectionToQuery),
            where('date', '==', mostRecentDate),
            where('completed', '==', 'TRUE')
        ));
        const games = gamesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        if (games.length === 0) {
            gamesList.innerHTML = '<div class="loading">No completed games found.</div>';
            return;
        }
        
        const maxScore = Math.max(...games.flatMap(g => [g.team1_score || 0, g.team2_score || 0]), 1);

        gamesList.innerHTML = games.map(game => {
            const team1 = allTeams.find(t => t.id === game.team1_id);
            const team2 = allTeams.find(t => t.id === game.team2_id);
            if (!team1 || !team2) return '';

            const isThisGamePostseason = collectionToQuery.includes('post_games');
            if (game === games[0]) {
                if (isThisGamePostseason) {
                    gamesHeader.textContent = 'Recent Postseason Games';
                } else if (collectionToQuery.includes('exhibition_games')) {
                    gamesHeader.textContent = 'Recent Exhibition Games';
                } else {
                    gamesHeader.textContent = 'Recent Games';
                }
            }

            const team1NameHTML = escapeHTML(team1.team_name);
            const team2NameHTML = escapeHTML(team2.team_name);
            let team1Record, team2Record;
            
            if (isThisGamePostseason) {
                const team1SeedHTML = game.team1_seed ? `<strong>(${game.team1_seed})</strong> ` : '';
                const team2SeedHTML = game.team2_seed ? `<strong>(${game.team2_seed})</strong> ` : '';
                team1Record = `${team1SeedHTML}${game.team1_wins || 0}-${game.team2_wins || 0}`;
                team2Record = `${team2SeedHTML}${game.team2_wins || 0}-${game.team1_wins || 0}`;
            } else {
                team1Record = `${team1.wins || 0}-${team1.losses || 0}`;
                team2Record = `${team2.wins || 0}-${team2.losses || 0}`;
            }

            const winnerId = game.winner;
            const team1_total = game.team1_score || 0;
            const team2_total = game.team2_score || 0;
            const team1_bar_percent = (team1_total / maxScore) * 100;
            const team2_bar_percent = (team2_total / maxScore) * 100;
            const team1_indicator = winnerId === team1.id ? '<div class="winner-indicator"></div>' : '<div class="winner-indicator-placeholder"></div>';
            const team2_indicator = winnerId === team2.id ? '<div class="winner-indicator"></div>' : '<div class="winner-indicator-placeholder"></div>';

            const specialTeamIds = ["EAST", "WEST", "EGM", "WGM", "RSE", "RSW"];
            const team1LogoExt = team1.logo_ext || (specialTeamIds.includes(team1.id) ? 'png' : 'webp');
            const team2LogoExt = team2.logo_ext || (specialTeamIds.includes(team2.id) ? 'png' : 'webp');

            return `
                <div class="game-item completed" data-game-id="${game.id}" data-game-date="${game.date}" data-collection-name="${collectionToQuery}">
                    <div class="game-matchup">
                        <div class="team">
                            <img src="../icons/${team1.id}.${team1LogoExt}" alt="${team1.team_name}" class="team-logo" onerror="this.style.display='none'">
                            <div class="team-info">
                                <span class="team-name">${team1NameHTML}</span>
                                <span class="team-record">${team1Record}</span>
                            </div>
                            ${team1_indicator}
                            <div class="team-bar-container">
                                <div class="team-bar ${winnerId === team1.id ? 'winner' : 'loser'}" style="width: ${team1_bar_percent}%;"></div>
                            </div>
                            <span class="team-score ${winnerId === team1.id ? 'winner' : ''}">${formatInThousands(team1_total)}</span>
                        </div>
                        <div class="team">
                            <img src="../icons/${team2.id}.${team2LogoExt}" alt="${team2.team_name}" class="team-logo" onerror="this.style.display='none'">
                            <div class="team-info">
                                <span class="team-name">${team2NameHTML}</span>
                                <span class="team-record">${team2Record}</span>
                            </div>
                            ${team2_indicator}
                            <div class="team-bar-container">
                                <div class="team-bar ${winnerId === team2.id ? 'winner' : 'loser'}" style="width: ${team2_bar_percent}%;"></div>
                            </div>
                            <span class="team-score ${winnerId === team2.id ? 'winner' : ''}">${formatInThousands(team2_total)}</span>
                        </div>
                    </div>
                    <div class="game-status">
                        ${formatDate(game.date)}
                    </div>
                </div>`;
        }).join('');
        
        document.querySelectorAll('.game-item').forEach(item => {
            item.addEventListener('click', () => showGameDetails(item.dataset.gameId, false, item.dataset.gameDate, item.dataset.collectionName));
        });
    } catch (error) {
        console.error("Error fetching recent games:", error);
        gamesList.innerHTML = '<div class="error">Could not load recent games. See console for details.</div>';
    }
}


// js/RKL-S9.js

async function loadSeasonInfo(seasonData) {
    const currentWeekContainer = document.getElementById('current-week-container');
    const seasonStatsContainer = document.getElementById('season-stats');
    const playoffBtnContainer = document.getElementById('playoff-button-container');

    if (!currentWeekContainer || !seasonStatsContainer || !playoffBtnContainer) return;

    // Reset the current week container to its original structure
    // This is necessary because the champion display replaces the innerHTML
    currentWeekContainer.innerHTML = '<p><strong>Current Week:</strong> <span id="current-week">Loading...</span></p>';
    const currentWeekSpan = document.getElementById('current-week');

    const currentWeek = seasonData.current_week || '1';

    // Handle "End of Regular Season" - treat it as regular season, not postseason
    if (currentWeek === "End of Regular Season") {
        currentWeekSpan.textContent = currentWeek;
        playoffBtnContainer.style.display = 'none';
        seasonStatsContainer.innerHTML = `
            <p><strong>${seasonData.gp || 0} of ${seasonData.gs || 0}</strong> regular season games complete</p>
            <p><strong>${seasonData.season_trans || 0}</strong> transactions made</p>
            <p><strong>${Math.round(seasonData.season_karma || 0).toLocaleString()}</strong> total karma earned</p>
        `;
        return;
    }

    if (currentWeek === "Season Complete") {
        // Query only the Finals game to find the champion
        const finalsQuery = query(
            collection(db, collectionNames.seasons, activeSeasonId, 'post_games'),
            where('series_id', '==', 'Finals'),
            limit(1)
        );
        const finalsSnap = await getDocs(finalsQuery);
        const finalsWinnerId = !finalsSnap.empty ? finalsSnap.docs[0].data().series_winner : null;
        const winnerInfo = finalsWinnerId ? allTeams.find(t => t.id === finalsWinnerId) : null;

        if (winnerInfo) {
            const specialTeamIds = ["EAST", "WEST", "EGM", "WGM", "RSE", "RSW"];
            const logoExt = winnerInfo.logo_ext || (specialTeamIds.includes(winnerInfo.id) ? 'png' : 'webp');

            currentWeekContainer.innerHTML = `<p class="champion-display">🏆 League Champion: <img src="../icons/${winnerInfo.id}.${logoExt}" onerror="this.style.display='none'"/> ${escapeHTML(winnerInfo.team_name)} 🏆</p>`;
        } else {
            currentWeekSpan.textContent = "Season Complete";
        }

        playoffBtnContainer.style.display = 'block';
        seasonStatsContainer.innerHTML = `
            <p><strong>Season has concluded.</strong></p>
            <p><strong>${seasonData.season_trans || 0}</strong> transactions made</p>
            <p><strong>${Math.round(seasonData.season_karma || 0).toLocaleString()}</strong> total karma earned</p>
        `;

        return;
    }

    const isPostseason = isPostseasonWeek(currentWeek);

    currentWeekSpan.textContent = isPostseason ? currentWeek : `Week ${currentWeek}`;

    if (isPostseason) {
        playoffBtnContainer.style.display = 'block';

        // Query only incomplete postseason games to count remaining teams
        const incompleteQuery = query(
            collection(db, collectionNames.seasons, activeSeasonId, 'post_games'),
            where('completed', '!=', 'TRUE')
        );
        const incompleteSnap = await getDocs(incompleteQuery);
        const remainingTeamIds = new Set();
        incompleteSnap.forEach(doc => {
            const game = doc.data();
            if (game.team1_id && game.team1_id !== 'TBD') remainingTeamIds.add(game.team1_id);
            if (game.team2_id && game.team2_id !== 'TBD') remainingTeamIds.add(game.team2_id);
        });
        const remainingCount = remainingTeamIds.size;

        seasonStatsContainer.innerHTML = `
            <p><strong>${remainingCount} teams remaining</strong> in the hunt for the title</p>
            <p><strong>${seasonData.season_trans || 0}</strong> transactions made</p>
            <p><strong>${Math.round(seasonData.season_karma || 0).toLocaleString()}</strong> total karma earned</p>
        `;
    } else {
        playoffBtnContainer.style.display = 'none';
        seasonStatsContainer.innerHTML = `
            <p><strong>${seasonData.gp || 0} of ${seasonData.gs || 0}</strong> regular season games complete</p>
            <p><strong>${seasonData.season_trans || 0}</strong> transactions made</p>
            <p><strong>${Math.round(seasonData.season_karma || 0).toLocaleString()}</strong> total karma earned</p>
        `;
    }

    if (seasonData.status === 'completed') {
        const winnerInfo = allTeams.find(t => t.id === seasonData.champion_id);
        if (winnerInfo) {
            // Determine logo extension
            const specialTeamIds = ["EAST", "WEST", "EGM", "WGM", "RSE", "RSW"];
            const logoExt = winnerInfo.logo_ext || (specialTeamIds.includes(winnerInfo.id) ? 'png' : 'webp');

            currentWeekContainer.innerHTML = `<p class="champion-display">🏆 League Champion: <img src="../icons/${winnerInfo.id}.${logoExt}" onerror="this.style.display='none'"/> ${escapeHTML(winnerInfo.team_name)} 🏆</p>`;
        }
        playoffBtnContainer.style.display = 'block';
    }
}

async function showGameDetails(gameId, isLiveGame, gameDate = null, collectionName = null) {
    const modal = document.getElementById('game-modal');
    const modalTitle = document.getElementById('modal-title');
    const contentArea = document.getElementById('game-details-content-area');

    if (!modal || !modalTitle || !contentArea) {
        console.error("Modal elements not found. Was the modal component loaded correctly?");
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
    contentArea.innerHTML = '<div class="loading">Loading game details...</div>';

    // Track modal open event
    if (typeof gtag !== 'undefined') {
        gtag('event', 'modal_open', {
            event_category: 'Game Modal',
            event_label: `Game ID: ${gameId}`,
            game_id: gameId,
            is_live: isLiveGame
        });
    }

    try {
        let team1Lineups, team2Lineups, team1, team2;

        // Determine the collection name for the game document
        let effectiveCollectionName = collectionName;
        if (!effectiveCollectionName && isLiveGame) {
            // For live games, get the collectionName from the live_games document
            const liveGameRef = doc(db, collectionNames.liveGames, gameId);
            const liveGameSnap = await getDoc(liveGameRef);
            if (liveGameSnap.exists()) {
                effectiveCollectionName = liveGameSnap.data().collectionName || 'games';
            }
        }
        effectiveCollectionName = effectiveCollectionName || 'games';

        // Fetch the original game document on-demand
        const originalGame = await fetchGameDoc(gameId, effectiveCollectionName);
        if (!originalGame) throw new Error(`Game ${gameId} not found in ${effectiveCollectionName}`);

        const gameIsPostseason = isPostseasonWeek(originalGame.week);

        team1 = allTeams.find(t => t.id === originalGame.team1_id);
        team2 = allTeams.find(t => t.id === originalGame.team2_id);

        let titleTeam1Name = escapeHTML(team1.team_name);
        let titleTeam2Name = escapeHTML(team2.team_name);
        if (gameIsPostseason) {
            if (originalGame.team1_seed) titleTeam1Name = `(${originalGame.team1_seed}) ${titleTeam1Name}`;
            if (originalGame.team2_seed) titleTeam2Name = `(${originalGame.team2_seed}) ${titleTeam2Name}`;
        }

        const allPlayerIdsInGame = [];
        if (isLiveGame) {
            const gameRef = doc(db, collectionNames.liveGames, gameId);
            const gameSnap = await getDoc(gameRef);
            if (gameSnap.exists()) {
                const liveData = gameSnap.data();
                liveData.team1_lineup.forEach(p => allPlayerIdsInGame.push(p.player_id));
                liveData.team2_lineup.forEach(p => allPlayerIdsInGame.push(p.player_id));
            }
        } else {
            // Determine the correct lineups collection using the effectiveCollectionName.
            let lineupsCollectionName;
            if (effectiveCollectionName.includes('exhibition')) {
                lineupsCollectionName = 'exhibition_lineups';
            } else if (effectiveCollectionName.includes('post')) {
                lineupsCollectionName = 'post_lineups';
            } else {
                lineupsCollectionName = 'lineups';
            }

            const lineupsRef = collection(db, collectionNames.seasons, activeSeasonId, lineupsCollectionName);
            const lineupsQuery = query(lineupsRef, where('game_id', '==', gameId));
            const lineupsSnap = await getDocs(lineupsQuery);
            lineupsSnap.forEach(doc => allPlayerIdsInGame.push(doc.data().player_id));
        }

        const uniquePlayerIds = [...new Set(allPlayerIdsInGame)];
        const playerStatsPromises = uniquePlayerIds.map(playerId =>
            getDoc(doc(db, collectionNames.players, playerId, collectionNames.seasonalStats, activeSeasonId))
        );
        const playerStatsDocs = await Promise.all(playerStatsPromises);
        
        const playerSeasonalStats = new Map();
        playerStatsDocs.forEach((docSnap, index) => {
            if (docSnap.exists()) {
                playerSeasonalStats.set(uniquePlayerIds[index], docSnap.data());
            }
        });

        if (isLiveGame) {
            const gameRef = doc(db, collectionNames.liveGames, gameId);
            const gameSnap = await getDoc(gameRef);
            if (!gameSnap.exists()) throw new Error("Live game data not found.");

            const liveGameData = gameSnap.data();
            team1Lineups = liveGameData.team1_lineup.map(p => ({ ...p, ...playerSeasonalStats.get(p.player_id) })) || [];
            team2Lineups = liveGameData.team2_lineup.map(p => ({ ...p, ...playerSeasonalStats.get(p.player_id) })) || [];
            modalTitle.textContent = `${titleTeam1Name} vs ${titleTeam2Name} - Live`;
        } else {
            // Use effectiveCollectionName (already determined above) for consistency
            let lineupsCollectionName;
            if (effectiveCollectionName.includes('exhibition')) {
                lineupsCollectionName = 'exhibition_lineups';
            } else if (effectiveCollectionName.includes('post')) {
                lineupsCollectionName = 'post_lineups';
            } else {
                lineupsCollectionName = 'lineups';
            }

            const lineupsRef = collection(db, collectionNames.seasons, activeSeasonId, lineupsCollectionName);
            const lineupsQuery = query(lineupsRef, where('game_id', '==', gameId));
            const lineupsSnap = await getDocs(lineupsQuery);
            const allLineupsForGame = lineupsSnap.docs.map(d => {
                const lineupData = d.data();
                return { ...lineupData, ...playerSeasonalStats.get(lineupData.player_id) };
            });

            team1Lineups = allLineupsForGame.filter(l => l.team_id === team1.id && l.started === "TRUE");
            team2Lineups = allLineupsForGame.filter(l => l.team_id === team2.id && l.started === "TRUE");
            modalTitle.textContent = `${titleTeam1Name} vs ${titleTeam2Name} - ${formatDateShort(gameDate)}`;
        }

        let team1ForModal = { ...team1 };
        let team2ForModal = { ...team2 };

        if (gameIsPostseason) {
            team1ForModal.wins = originalGame.team1_wins || 0;
            team1ForModal.losses = originalGame.team2_wins || 0;
            team2ForModal.wins = originalGame.team2_wins || 0;
            team2ForModal.losses = originalGame.team1_wins || 0;
            team1ForModal.seed = originalGame.team1_seed;
            team2ForModal.seed = originalGame.team2_seed;
        }

        const winnerId = isLiveGame ? null : originalGame.winner;
        
        contentArea.innerHTML = `
            <div class="game-details-grid">
                ${generateLineupTable(team1Lineups, team1ForModal, !isLiveGame && winnerId === team1.id, isLiveGame)}
                ${generateLineupTable(team2Lineups, team2ForModal, !isLiveGame && winnerId === team2.id, isLiveGame)}
            </div>
        `;

        // Fetch and prepare game flow chart (if admin allows and data exists)
        const chartBtn = document.getElementById('game-flow-chart-btn');
        const flowData = await fetchGameFlowData(gameId);

        console.log(`[Game Flow] Game ID: ${gameId}`);
        console.log(`[Game Flow] Flow data exists:`, !!flowData);
        console.log(`[Game Flow] Flow data length:`, flowData?.length || 0);
        console.log(`[Game Flow] Show live features:`, showLiveFeatures);
        console.log(`[Game Flow] Chart button found:`, !!chartBtn);

        if (flowData && flowData.length > 0 && showLiveFeatures) {
            // Show chart button
            if (chartBtn) {
                console.log(`[Game Flow] ✓ Showing game flow chart button`);
                chartBtn.style.display = 'flex';
                chartBtn.onclick = () => toggleGameFlowChart();
            } else {
                console.warn(`[Game Flow] ✗ Chart button element not found!`);
            }

            // Pre-render the chart (hidden initially)
            renderGameFlowChart(flowData, team1, team2);
        } else {
            console.log(`[Game Flow] Not showing chart button. Reasons:`, {
                hasData: !!flowData,
                hasSnapshots: flowData?.length > 0,
                featuresEnabled: showLiveFeatures
            });
            if (chartBtn) {
                chartBtn.style.display = 'none';
            }
        }

    } catch (error) {
        console.error("Error loading game details:", error);
        contentArea.innerHTML = `<div class="error">Could not load game details.</div>`;

        // Track modal error event
        if (typeof gtag !== 'undefined') {
            gtag('event', 'modal_error', {
                event_category: 'Game Modal',
                event_label: `Error loading game ${gameId}`,
                game_id: gameId,
                error_message: error.message
            });
        }
    }
}


// --- GAME FLOW CHART FUNCTIONS ---
let gameFlowChartInstance = null;
let currentGameFlowData = null;
let currentChartType = 'cumulative'; // 'cumulative' or 'differential'
let currentTeam1 = null;
let currentTeam2 = null;

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

        // Track switch to traditional view
        if (typeof gtag !== 'undefined') {
            gtag('event', 'toggle_view', {
                event_category: 'Game Modal',
                event_label: 'Switched to traditional view',
                view_type: 'traditional'
            });
        }
    } else {
        // Switch to chart view
        contentArea.style.display = 'none';
        chartArea.style.display = 'block';
        chartBtn.classList.add('active');

        // Track switch to chart view
        if (typeof gtag !== 'undefined') {
            gtag('event', 'toggle_view', {
                event_category: 'Game Modal',
                event_label: 'Switched to chart view',
                view_type: 'chart'
            });
        }
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

    // Track chart type switch
    if (typeof gtag !== 'undefined') {
        gtag('event', 'chart_type_switch', {
            event_category: 'Game Modal',
            event_label: `Switched to ${currentChartType} view`,
            chart_type: currentChartType
        });
    }

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

function closeModal() {
    const modal = document.getElementById('game-modal');
    if (modal) {
        modal.style.display = 'none';

        // Track modal close event
        if (typeof gtag !== 'undefined') {
            gtag('event', 'modal_close', {
                event_category: 'Game Modal',
                event_label: 'User closed modal'
            });
        }
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

// --- DAILY LEADERBOARD FUNCTIONS ---
function processLeaderboardData(data) {
    // Handle both old format (players) and new format (all_players, top_3, bottom_3)
    if (data.players && !data.all_players) {
        console.log('Converting old leaderboard format to new format...');
        // Old format: just has 'players' array
        // Need to transform it to new format with top_3, bottom_3, all_players, median_score
        const players = data.players.map((p, index) => ({
            ...p,
            rank: index + 1 // Assuming already sorted
        }));

        // Calculate median
        const medianScore = players.length > 0 ?
            (players.length % 2 === 0
                ? (players[Math.floor(players.length / 2) - 1].score + players[Math.floor(players.length / 2)].score) / 2
                : players[Math.floor(players.length / 2)].score)
            : 0;

        // Add percent_vs_median to all players
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

function setupDailyLeaderboardListener(gameDate, onDataCallback, onErrorCallback) {
    try {
        const leaderboardRef = doc(db, getLeagueCollectionName('daily_leaderboards'), gameDate);

        console.log(`Setting up real-time listener for daily leaderboard: ${gameDate}`);

        const unsubscribe = onSnapshot(leaderboardRef, (leaderboardSnap) => {
            if (leaderboardSnap.exists()) {
                const data = leaderboardSnap.data();
                console.log('Daily leaderboard updated:', data);
                console.log('Document keys:', Object.keys(data));

                const processedData = processLeaderboardData(data);
                onDataCallback(processedData);
            } else {
                console.warn(`No daily leaderboard document found for date: ${gameDate}`);
                onDataCallback(null);
            }
        }, (error) => {
            console.error('Error in daily leaderboard listener:', error);
            if (onErrorCallback) {
                onErrorCallback(error);
            }
        });

        return unsubscribe;
    } catch (error) {
        console.error('Error setting up daily leaderboard listener:', error);
        if (onErrorCallback) {
            onErrorCallback(error);
        }
        return null;
    }
}

async function renderDailyLeaderboard(leaderboardData) {
    const leaderboardView = document.getElementById('daily-leaderboard-view');

    if (!leaderboardView) {
        console.error('Daily leaderboard view element not found');
        return;
    }

    if (!leaderboardData) {
        leaderboardView.innerHTML = '<div class="loading" style="padding: 2rem; text-align: center;">No leaderboard data available for today.</div>';
        return;
    }

    const { top_3, bottom_3, median_score, all_players } = leaderboardData;

    // Validate that all required fields exist
    if (!top_3 || !bottom_3 || !all_players || !Array.isArray(top_3) || !Array.isArray(bottom_3) || !Array.isArray(all_players)) {
        leaderboardView.innerHTML = '<div class="loading" style="padding: 2rem; text-align: center;">Leaderboard data is incomplete. Please try again later.</div>';
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
        // Determine team logo extension
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
                <div style="font-size: 0.75em; color: #888; margin-top: 2px;">Rank: ${player.global_rank >= 0 ? player.global_rank : 'N/A'}</div>
            </div>
        </div>
        `;
    }).join('');

    // Build Bottom 3 section
    const bottom3HTML = bottom_3.map(player => {
        // Determine team logo extension
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
                <div style="font-size: 0.75em; color: #888; margin-top: 2px;">Rank: ${player.global_rank >= 0 ? player.global_rank : 'N/A'}</div>
            </div>
        </div>
        `;
    }).join('');

    // Build Percent vs Median section
    const percentListHTML = all_players.map(player => {
        const percentClass = player.percent_vs_median >= 0 ? 'positive' : 'negative';
        const percentSign = player.percent_vs_median >= 0 ? '+' : '';

        // Determine team logo extension
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
                    <span class="leaderboard-score ${percentClass}">${percentSign}${player.percent_vs_median.toFixed(1)}%</span>
                    <div style="font-size: 0.75em; color: #888; margin-top: 2px;">${Math.round(player.score).toLocaleString()} | ${getOrdinal(player.global_rank)}</div>
                </div>
            </div>
        `;
    }).join('');

    leaderboardView.innerHTML = `
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
            <h4>📈 All Players (% vs Median)</h4>
            <div class="leaderboard-percent-list">
                ${percentListHTML}
            </div>
        </div>
    `;
}

async function toggleDailyLeaderboard() {
    const gamesList = document.getElementById('recent-games');
    const leaderboardView = document.getElementById('daily-leaderboard-view');
    const leaderboardIcon = document.getElementById('daily-leaderboard-icon');

    if (!gamesList || !leaderboardView || !leaderboardIcon) return;

    if (leaderboardView.style.display === 'none') {
        // Switch to leaderboard view
        gamesList.style.display = 'none';
        leaderboardView.style.display = 'block';
        leaderboardIcon.classList.add('active');

        // Set up real-time listener for leaderboard
        leaderboardView.innerHTML = '<div class="loading">Loading leaderboard...</div>';

        // Get the active game date from live scoring status
        try {
            const statusRef = doc(db, getLeagueCollectionName('live_scoring_status'), 'status');
            const statusSnap = await getDoc(statusRef);

            let gameDate;
            if (statusSnap.exists() && statusSnap.data().active_game_date) {
                gameDate = statusSnap.data().active_game_date;
                console.log(`Setting up daily leaderboard listener for game date: ${gameDate}`);
            } else {
                // Fallback to today's date in UTC
                gameDate = new Date().toISOString().split('T')[0];
                console.warn(`No active_game_date found, using current date: ${gameDate}`);
            }

            // Clean up existing listener if any
            if (dailyLeaderboardUnsubscribe) {
                dailyLeaderboardUnsubscribe();
                dailyLeaderboardUnsubscribe = null;
            }

            // Set up new real-time listener
            dailyLeaderboardUnsubscribe = setupDailyLeaderboardListener(
                gameDate,
                (leaderboardData) => {
                    // This callback is called whenever the leaderboard data changes
                    renderDailyLeaderboard(leaderboardData);
                },
                (error) => {
                    console.error('Error in daily leaderboard listener:', error);
                    leaderboardView.innerHTML = '<div class="error">Failed to load leaderboard. Please try again.</div>';
                }
            );
        } catch (error) {
            console.error('Error setting up daily leaderboard:', error);
            leaderboardView.innerHTML = '<div class="error">Failed to load leaderboard. Please try again.</div>';
        }
    } else {
        // Switch back to games list
        gamesList.style.display = 'block';
        leaderboardView.style.display = 'none';
        leaderboardIcon.classList.remove('active');

        // Clean up the leaderboard listener
        if (dailyLeaderboardUnsubscribe) {
            console.log('Cleaning up daily leaderboard listener');
            dailyLeaderboardUnsubscribe();
            dailyLeaderboardUnsubscribe = null;
        }

        // Clear the leaderboard view
        leaderboardView.innerHTML = '';
    }
}

// --- INITIALIZATION ---

async function initializePage() {
    try {
        const placeholder = document.getElementById('modal-placeholder');
        if (!placeholder) {
            throw new Error("Fatal: Modal placeholder div not found in RKL-S8.html.");
        }

        const response = await fetch('../common/game-modal-component.html');
        if (!response.ok) {
            throw new Error(`Failed to fetch modal component: ${response.status} ${response.statusText}`);
        }
        
        placeholder.innerHTML = await response.text();
        
        // Game Details Modal Listeners
        const closeModalBtn = document.getElementById('close-modal-btn');
        const gameModal = document.getElementById('game-modal');

        if (closeModalBtn && gameModal) {
            closeModalBtn.addEventListener('click', closeModal);
            gameModal.addEventListener('click', (event) => {
                if (event.target === gameModal) {
                    closeModal();
                }
            });
        } else {
            console.warn("Game modal component was loaded, but its internal elements were not found.");
        }

        // Live Scoring Info Modal Listeners
        const infoModal = document.getElementById('live-scoring-info-modal');
        const infoIcon = document.getElementById('live-scoring-info-icon-container');
        const closeInfoModalBtn = document.querySelector('.close-info-modal-btn');

        if (infoIcon && infoModal && closeInfoModalBtn) {
            const closeInfoModal = () => infoModal.style.display = 'none';

            infoIcon.addEventListener('click', (e) => {
                e.stopPropagation();
                infoModal.style.display = 'block';
            });
            closeInfoModalBtn.addEventListener('click', closeInfoModal);
            infoModal.addEventListener('click', (event) => {
                if (event.target === infoModal) {
                    closeInfoModal();
                }
            });
        } else {
            console.warn("Info modal elements not found. The info icon may not work.");
        }

        const seasonData = await getActiveSeason();
        await fetchAllTeams(activeSeasonId);

        loadStandingsPreview();
        initializeGamesSection(seasonData);
        await loadSeasonInfo(seasonData);

    } catch (error) {
        console.error("Failed to initialize page:", error);
        const mainContent = document.querySelector('main');
        if (mainContent) {
            mainContent.innerHTML = `<div class="error" style="padding: 2rem;">
                <h3>Oops! Something went wrong.</h3>
                <p>Could not load all page components. Please try refreshing the page.</p>
                <p style="font-size:0.8em; color: #666; margin-top: 1rem;">Error details: ${error.message}</p>
            </div>`;
        }
    }
}

// Clean up listeners when page is unloaded to prevent memory leaks and excessive reads
function cleanupListeners() {
    console.log('Cleaning up Firestore listeners...');
    if (statusUnsubscribe) {
        statusUnsubscribe();
        statusUnsubscribe = null;
    }
    if (liveGamesUnsubscribe) {
        liveGamesUnsubscribe();
        liveGamesUnsubscribe = null;
    }
    if (dailyLeaderboardUnsubscribe) {
        dailyLeaderboardUnsubscribe();
        dailyLeaderboardUnsubscribe = null;
    }
    if (usageStatsUnsubscribe) {
        usageStatsUnsubscribe();
        usageStatsUnsubscribe = null;
    }
}

function resetGamesSectionState() {
    const gamesList = document.getElementById('recent-games');
    if (gamesList) {
        gamesList.dataset.liveInitialized = 'false';
        gamesList.innerHTML = '<div class="loading">Loading games...</div>';
    }
}

document.addEventListener('DOMContentLoaded', initializePage);
window.addEventListener('beforeunload', cleanupListeners);
window.addEventListener('pagehide', cleanupListeners);

// Reload data when league changes
window.addEventListener('leagueChanged', async (event) => {
    const newLeague = event.detail.league;
    console.log('[RKL-S9] League changed to:', newLeague);

    // Clean up existing listeners
    cleanupListeners();

    // Clear game doc cache for new league
    gameDocCache.clear();

    // Ensure the games section can reinitialize listeners for the new league
    resetGamesSectionState();

    // Reset scoring status to force games refresh
    currentScoringStatus = null;

    // Add loading state - hide main content during transition
    const mainGrid = document.querySelector('.main-grid');
    const pageTitle = document.getElementById('page-title');
    const seasonInfo = document.querySelector('.season-info');

    if (mainGrid) mainGrid.style.opacity = '0';
    if (seasonInfo) seasonInfo.style.opacity = '0';

    // Reload the page data
    try {
        const seasonData = await getActiveSeason();
        await fetchAllTeams(activeSeasonId);

        // Update page title
        if (pageTitle) {
            pageTitle.textContent = (newLeague === 'minor' ? 'RKML' : 'RKL') + ' Season 9';
        }

        loadStandingsPreview();
        initializeGamesSection(seasonData);

        // Explicitly reload games after league switch to ensure they refresh immediately
        const statusRef = doc(db, getLeagueCollectionName('live_scoring_status'), 'status');
        try {
            const statusSnap = await getDoc(statusRef);
            const statusData = statusSnap.exists() ? statusSnap.data() : {};
            const status = statusData.status || 'stopped';
            showLiveFeatures = statusData.show_live_features !== false;
            currentScoringStatus = status;

            if (status === 'active' || status === 'paused') {
                loadLiveGames();
            } else {
                loadRecentGames();
            }
        } catch (error) {
            console.error('[RKL-S9] Error loading games after league change:', error);
            loadRecentGames(); // Fallback to recent games
        }

        await loadSeasonInfo(seasonData);

        // Small delay to ensure DOM updates complete, then show content
        setTimeout(() => {
            if (mainGrid) mainGrid.style.opacity = '1';
            if (seasonInfo) seasonInfo.style.opacity = '1';
        }, 100);
    } catch (error) {
        console.error('[RKL-S9] Error reloading data after league change:', error);
        // Restore visibility even on error
        if (mainGrid) mainGrid.style.opacity = '1';
        if (seasonInfo) seasonInfo.style.opacity = '1';
    }
});
