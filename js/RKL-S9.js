import { db, getDoc, getDocs, collection, doc, query, where, orderBy, limit, onSnapshot, collectionGroup, documentId } from '../js/firebase-init.js';
import { generateLineupTable } from './main.js';

const USE_DEV_COLLECTIONS = false; // Set to false for production
const getCollectionName = (baseName) => USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
let currentScoringStatus = null; // Tracks the current scoring status to prevent redundant re-renders.

let activeSeasonId = '';
let allTeams = [];
let allGamesCache = []; // Caches all games for the season
let liveGamesUnsubscribe = null; // To store the listener unsubscribe function
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


// --- DATA FETCHING FUNCTIONS ---

async function getActiveSeason() {
    const seasonsQuery = query(collection(db, getCollectionName('seasons')), where('status', '==', 'active'), limit(1));
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
    const teamsCollectionName = getCollectionName('v2_teams');
    const seasonalRecordsCollectionName = getCollectionName('seasonal_records');

    const teamsQuery = query(collection(db, teamsCollectionName));
    const recordsQuery = query(collectionGroup(db, seasonalRecordsCollectionName));
    
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
        if (doc.id === seasonId) {
            const teamId = doc.ref.parent.parent.id;
            seasonalRecordsMap.set(teamId, doc.data());
        }
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

async function fetchAllGames(seasonId) {
    if (!seasonId) {
        console.error("fetchAllGames was called without a seasonId.");
        return;
    }
    // Add a reference to the exhibition_games collection
    const gamesRef = collection(db, getCollectionName('seasons'), seasonId, getCollectionName('games'));
    const postGamesRef = collection(db, getCollectionName('seasons'), seasonId, getCollectionName('post_games'));
    const exhibitionGamesRef = collection(db, getCollectionName('seasons'), seasonId, getCollectionName('exhibition_games'));

    // Fetch all three collections simultaneously
    const [gamesSnap, postGamesSnap, exhibitionGamesSnap] = await Promise.all([
        getDocs(gamesRef),
        getDocs(postGamesRef),
        getDocs(exhibitionGamesRef),
    ]);

    // Combine the results from all three collections into the cache
    allGamesCache = [
        ...gamesSnap.docs.filter(doc => doc.id !== 'placeholder').map(d => ({ id: d.id, ...d.data() })),
        ...postGamesSnap.docs.filter(doc => doc.id !== 'placeholder').map(d => ({ id: d.id, ...d.data() })),
        ...exhibitionGamesSnap.docs.filter(doc => doc.id !== 'placeholder').map(d => ({ id: d.id, ...d.data() }))
    ];
    console.log(`Successfully cached ${allGamesCache.length} total games.`);
}


// --- DOM MANIPULATION & RENDERING ---

function loadStandingsPreview() {
    if (allTeams.length === 0) {
        document.getElementById('eastern-standings').innerHTML = '<tr><td colspan="4" class="error">Could not load standings.</td></tr>';
        document.getElementById('western-standings').innerHTML = '<tr><td colspan="4" class="error">Could not load standings.</td></tr>';
        return;
    }

    const standingsSort = (a, b) => (a.postseed || 99) - (b.postseed || 99);

    const easternTeams = allTeams
        .filter(t => t.conference && t.conference.toLowerCase() === 'eastern')
        .sort(standingsSort)
        .slice(0, 5);

    const westernTeams = allTeams
        .filter(t => t.conference && t.conference.toLowerCase() === 'western')
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
    const statusRef = doc(db, getCollectionName('live_scoring_status'), 'status');
    const gamesList = document.getElementById('recent-games');

    onSnapshot(statusRef, (statusSnap) => {
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

    const liveGamesQuery = query(collection(db, getCollectionName('live_games')));

    liveGamesUnsubscribe = onSnapshot(liveGamesQuery, (snapshot) => {
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

        snapshot.docs.forEach(gameDoc => {
            const gameId = gameDoc.id;
            const liveGameData = gameDoc.data();
            const originalGame = allGamesCache.find(g => g.id === gameId);
            
            // --- MODIFIED TEAM LOOKUP LOGIC ---
            // First, try to find the team based on the player's team_id in the live game data.
            let team1 = allTeams.find(t => t.id === liveGameData.team1_lineup[0]?.team_id);
            let team2 = allTeams.find(t => t.id === liveGameData.team2_lineup[0]?.team_id);

            // If that fails (e.g., for the GM game), fall back to using the IDs from the cached original game data.
            if ((!team1 || !team2) && originalGame) {
                team1 = allTeams.find(t => t.id === originalGame.team1_id);
                team2 = allTeams.find(t => t.id === originalGame.team2_id);
            }
            // ------------------------------------

            if (!team1 || !team2) {
                // If teams still not found, skip rendering this game tile to avoid errors.
                console.warn(`Could not find team data for live game ID: ${gameId}`);
                return;
            }

            // START OF FIX
            const specialTeamIds = ["EAST", "WEST", "EGM", "WGM", "RSE", "RSW"];
            const team1LogoExt = team1.logo_ext || (specialTeamIds.includes(team1.id) ? 'png' : 'webp');
            const team2LogoExt = team2.logo_ext || (specialTeamIds.includes(team2.id) ? 'png' : 'webp');
            // END OF FIX
            
            const gameIsPostseason = originalGame ? isPostseasonWeek(originalGame.week) : false;
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
        });
        
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

    // Hide daily leaderboard icon when not in live mode
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

    gamesList.innerHTML = '<div class="loading">Loading recent games...</div>';

    try {
        // --- THIS IS THE FIX ---
        // Fetch a larger pool of candidates to ensure the true most recent game is found,
        // compensating for non-chronological document IDs.
        const regularSeasonGamesQuery = query(collection(db, getCollectionName('seasons'), activeSeasonId, getCollectionName('games')), where('completed', '==', 'TRUE'), orderBy(documentId(), 'desc'), limit(15));
        const postSeasonGamesQuery = query(collection(db, getCollectionName('seasons'), activeSeasonId, getCollectionName('post_games')), where('completed', '==', 'TRUE'), orderBy(documentId(), 'desc'), limit(15));
        const exhibitionGamesQuery = query(collection(db, getCollectionName('seasons'), activeSeasonId, getCollectionName('exhibition_games')), where('completed', '==', 'TRUE'), orderBy(documentId(), 'desc'), limit(15));

        const [regSnap, postSnap, exhSnap] = await Promise.all([
            getDocs(regularSeasonGamesQuery),
            getDocs(postSeasonGamesQuery),
            getDocs(exhibitionGamesQuery)
        ]);

        const potentialGames = [];
        // Now we populate the array with all fetched games, not just one from each
        if (!regSnap.empty) regSnap.docs.forEach(doc => potentialGames.push({ doc, collection: getCollectionName('games') }));
        if (!postSnap.empty) postSnap.docs.forEach(doc => potentialGames.push({ doc, collection: getCollectionName('post_games') }));
        if (!exhSnap.empty) exhSnap.docs.forEach(doc => potentialGames.push({ doc, collection: getCollectionName('exhibition_games') }));


        if (potentialGames.length === 0) {
            gamesList.innerHTML = '<div class="loading">No completed games yet.</div>';
            return;
        }

        // This sort (from the previous fix) now works because the correct games are in the pool
        potentialGames.sort((a, b) => new Date(b.doc.data().date) - new Date(a.doc.data().date));
        
        const mostRecentGameInfo = potentialGames[0];
        
        const mostRecentDate = mostRecentGameInfo.doc.data().date;
        const collectionToQuery = mostRecentGameInfo.collection;

        const gamesSnapshot = await getDocs(query(collection(db, getCollectionName('seasons'), activeSeasonId, collectionToQuery), where('date', '==', mostRecentDate), where('completed', '==', 'TRUE')));
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

function loadSeasonInfo(seasonData) {
    const currentWeekSpan = document.getElementById('current-week');
    const seasonStatsContainer = document.getElementById('season-stats');
    const playoffBtnContainer = document.getElementById('playoff-button-container');

    if (!currentWeekSpan || !seasonStatsContainer || !playoffBtnContainer) return;

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
        // Find the champion from the cached games data
        const finalsGames = allGamesCache.filter(g => g.series_id === 'Finals');
        const finalsWinnerId = finalsGames.length > 0 ? finalsGames[0].series_winner : null; // Get winner from any Finals game doc
        const winnerInfo = finalsWinnerId ? allTeams.find(t => t.id === finalsWinnerId) : null;
        
        if (winnerInfo) {
            const specialTeamIds = ["EAST", "WEST", "EGM", "WGM", "RSE", "RSW"];
            const logoExt = winnerInfo.logo_ext || (specialTeamIds.includes(winnerInfo.id) ? 'png' : 'webp');
            
            currentWeekSpan.parentElement.innerHTML = `<p class="champion-display">🏆 League Champion: <img src="../icons/${winnerInfo.id}.${logoExt}" onerror="this.style.display='none'"/> ${escapeHTML(winnerInfo.team_name)} 🏆</p>`;
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

        // This logic is now fine, as it won't run if the week is "Season Complete"
        const incompletePostseasonGames = allGamesCache.filter(g =>
            isPostseasonWeek(g.week) && g.completed !== 'TRUE'
        );
        const remainingTeamIds = new Set(
            incompletePostseasonGames
                .flatMap(g => [g.team1_id, g.team2_id])
                .filter(id => id !== 'TBD')
        );
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
            
            currentWeekSpan.parentElement.innerHTML = `<p class="champion-display">🏆 League Champion: <img src="../icons/${winnerInfo.id}.${logoExt}" onerror="this.style.display='none'"/> ${escapeHTML(winnerInfo.team_name)} 🏆</p>`;
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

    modal.style.display = 'block';
    contentArea.innerHTML = '<div class="loading">Loading game details...</div>';

    try {
        let team1Lineups, team2Lineups, team1, team2;

        const originalGame = allGamesCache.find(g => g.id === gameId);
        if (!originalGame) throw new Error("Original game data not found in cache.");
        
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
            const gameRef = doc(db, getCollectionName('live_games'), gameId);
            const gameSnap = await getDoc(gameRef);
            if (gameSnap.exists()) {
                const liveData = gameSnap.data();
                liveData.team1_lineup.forEach(p => allPlayerIdsInGame.push(p.player_id));
                liveData.team2_lineup.forEach(p => allPlayerIdsInGame.push(p.player_id));
            }
        } else {
            // --- MODIFICATION START ---
            // 3. Determine the correct lineups collection using the passed-in collectionName.
            let lineupsCollectionName;
            if (collectionName && collectionName.includes('exhibition')) {
                lineupsCollectionName = getCollectionName('exhibition_lineups');
            } else if (collectionName && collectionName.includes('post')) {
                lineupsCollectionName = getCollectionName('post_lineups');
            } else {
                lineupsCollectionName = getCollectionName('lineups');
            }
            // --- MODIFICATION END ---
            
            const lineupsRef = collection(db, getCollectionName('seasons'), activeSeasonId, lineupsCollectionName);
            const lineupsQuery = query(lineupsRef, where('game_id', '==', gameId));
            const lineupsSnap = await getDocs(lineupsQuery);
            lineupsSnap.forEach(doc => allPlayerIdsInGame.push(doc.data().player_id));
        }

        const uniquePlayerIds = [...new Set(allPlayerIdsInGame)];
        const playerStatsPromises = uniquePlayerIds.map(playerId => 
            getDoc(doc(db, getCollectionName('v2_players'), playerId, getCollectionName('seasonal_stats'), activeSeasonId))
        );
        const playerStatsDocs = await Promise.all(playerStatsPromises);
        
        const playerSeasonalStats = new Map();
        playerStatsDocs.forEach((docSnap, index) => {
            if (docSnap.exists()) {
                playerSeasonalStats.set(uniquePlayerIds[index], docSnap.data());
            }
        });

        if (isLiveGame) {
            const gameRef = doc(db, getCollectionName('live_games'), gameId);
            const gameSnap = await getDoc(gameRef);
            if (!gameSnap.exists()) throw new Error("Live game data not found.");
            
            const liveGameData = gameSnap.data();
            team1Lineups = liveGameData.team1_lineup.map(p => ({ ...p, ...playerSeasonalStats.get(p.player_id) })) || [];
            team2Lineups = liveGameData.team2_lineup.map(p => ({ ...p, ...playerSeasonalStats.get(p.player_id) })) || [];
            modalTitle.textContent = `${titleTeam1Name} vs ${titleTeam2Name} - Live`;
        } else {
            let lineupsCollectionName;
            if (collectionName && collectionName.includes('exhibition')) {
                lineupsCollectionName = getCollectionName('exhibition_lineups');
            } else if (collectionName && collectionName.includes('post')) {
                lineupsCollectionName = getCollectionName('post_lineups');
            } else {
                lineupsCollectionName = getCollectionName('lineups');
            }

            const lineupsRef = collection(db, getCollectionName('seasons'), activeSeasonId, lineupsCollectionName);
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
            renderGameFlowChart(flowData, team1.team_name, team2.team_name);
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
    }
}


// --- GAME FLOW CHART FUNCTIONS ---
let gameFlowChartInstance = null;
let currentGameFlowData = null;

async function fetchGameFlowData(gameId) {
    try {
        const flowRef = doc(db, getCollectionName('game_flow_snapshots'), gameId);
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

    // Destroy existing chart if any
    if (gameFlowChartInstance) {
        gameFlowChartInstance.destroy();
        gameFlowChartInstance = null;
    }

    if (snapshots.length === 0) {
        chartArea.innerHTML = '<div class="loading" style="padding: 2rem; text-align: center;">No game flow data available for this matchup.</div>';
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

// --- DAILY LEADERBOARD FUNCTIONS ---
async function fetchDailyLeaderboard(gameDate) {
    try {
        const leaderboardRef = doc(db, getCollectionName('daily_leaderboards'), gameDate);
        const leaderboardSnap = await getDoc(leaderboardRef);

        if (leaderboardSnap.exists()) {
            return leaderboardSnap.data();
        }
        return null;
    } catch (error) {
        console.error('Error fetching daily leaderboard:', error);
        return null;
    }
}

function renderDailyLeaderboard(leaderboardData) {
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

    // Build Top 3 section
    const top3HTML = top_3.map(player => `
        <div class="leaderboard-stat">
            <div class="leaderboard-player-info">
                <span class="leaderboard-rank">#${player.rank}</span>
                <div>
                    <div class="leaderboard-player-name">${escapeHTML(player.handle || player.player_name)}</div>
                    <div class="leaderboard-team-name">${escapeHTML(player.team_name)}</div>
                </div>
            </div>
            <span class="leaderboard-score">${formatInThousands(player.score)}</span>
        </div>
    `).join('');

    // Build Bottom 3 section
    const bottom3HTML = bottom_3.map(player => `
        <div class="leaderboard-stat">
            <div class="leaderboard-player-info">
                <span class="leaderboard-rank">#${player.rank}</span>
                <div>
                    <div class="leaderboard-player-name">${escapeHTML(player.handle || player.player_name)}</div>
                    <div class="leaderboard-team-name">${escapeHTML(player.team_name)}</div>
                </div>
            </div>
            <span class="leaderboard-score">${formatInThousands(player.score)}</span>
        </div>
    `).join('');

    // Build Percent vs Median section
    const percentListHTML = all_players.map(player => {
        const percentClass = player.percent_vs_median >= 0 ? 'positive' : 'negative';
        const percentSign = player.percent_vs_median >= 0 ? '+' : '';
        return `
            <div class="leaderboard-stat">
                <div class="leaderboard-player-info">
                    <span class="leaderboard-rank">#${player.rank}</span>
                    <div>
                        <div class="leaderboard-player-name">${escapeHTML(player.handle || player.player_name)}</div>
                        <div class="leaderboard-team-name">${escapeHTML(player.team_name)}</div>
                    </div>
                </div>
                <span class="leaderboard-score ${percentClass}">${percentSign}${player.percent_vs_median.toFixed(1)}%</span>
            </div>
        `;
    }).join('');

    leaderboardView.innerHTML = `
        <div class="leaderboard-section">
            <h4>🏆 Top 3 Performers</h4>
            ${top3HTML}
        </div>

        <div class="leaderboard-section">
            <h4>📊 Median Daily Score</h4>
            <div class="leaderboard-median">${formatInThousands(median_score)}</div>
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

        // Fetch and render leaderboard if not already rendered
        if (leaderboardView.innerHTML === '') {
            leaderboardView.innerHTML = '<div class="loading">Loading leaderboard...</div>';

            // Get the active game date from live scoring status
            try {
                const statusRef = doc(db, getCollectionName('live_scoring_status'), 'status');
                const statusSnap = await getDoc(statusRef);

                let gameDate;
                if (statusSnap.exists() && statusSnap.data().active_game_date) {
                    gameDate = statusSnap.data().active_game_date;
                    console.log(`Fetching daily leaderboard for game date: ${gameDate}`);
                } else {
                    // Fallback to today's date in UTC
                    gameDate = new Date().toISOString().split('T')[0];
                    console.warn(`No active_game_date found, using current date: ${gameDate}`);
                }

                const leaderboardData = await fetchDailyLeaderboard(gameDate);
                renderDailyLeaderboard(leaderboardData);
            } catch (error) {
                console.error('Error loading daily leaderboard:', error);
                leaderboardView.innerHTML = '<div class="error">Failed to load leaderboard. Please try again.</div>';
            }
        }
    } else {
        // Switch back to games list
        gamesList.style.display = 'block';
        leaderboardView.style.display = 'none';
        leaderboardIcon.classList.remove('active');
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
        await fetchAllGames(activeSeasonId);

        loadStandingsPreview();
        initializeGamesSection(seasonData);
        loadSeasonInfo(seasonData);

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

document.addEventListener('DOMContentLoaded', initializePage);
