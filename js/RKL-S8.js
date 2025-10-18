import { db, getDoc, getDocs, collection, doc, query, where, orderBy, limit, onSnapshot, collectionGroup, documentId } from '../js/firebase-init.js';
import { generateLineupTable } from './main.js';

const USE_DEV_COLLECTIONS = false; // Set to false for production
const getCollectionName = (baseName) => USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
let currentScoringStatus = null; // Tracks the current scoring status to prevent redundant re-renders.

let activeSeasonId = '';
let allTeams = [];
let allGamesCache = []; // Caches all games for the season
let liveGamesUnsubscribe = null; // To store the listener unsubscribe function

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
        const newStatus = statusSnap.exists() ? statusSnap.data().status : 'stopped';

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


function loadSeasonInfo(seasonData) {
    const currentWeekSpan = document.getElementById('current-week');
    const seasonStatsContainer = document.getElementById('season-stats');
    const playoffBtnContainer = document.getElementById('playoff-button-container');

    if (!currentWeekSpan || !seasonStatsContainer || !playoffBtnContainer) return;

    const currentWeek = seasonData.current_week || '1';
    const isPostseason = isPostseasonWeek(currentWeek);

    currentWeekSpan.textContent = isPostseason ? currentWeek : `Week ${currentWeek}`;

    if (isPostseason) {
        playoffBtnContainer.style.display = 'block';

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
            currentWeekSpan.parentElement.innerHTML = `<p class="champion-display">🏆 League Champion: <img src="../icons/${winnerInfo.id}.webp" onerror="this.style.display='none'"/> ${winnerInfo.team_name} 🏆</p>`;
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

    } catch (error) {
        console.error("Error loading game details:", error);
        contentArea.innerHTML = `<div class="error">Could not load game details.</div>`;
    }
}


function closeModal() {
    const modal = document.getElementById('game-modal');
    if (modal) {
        modal.style.display = 'none';
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