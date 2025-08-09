import { db, getDoc, getDocs, collection, doc, query, where, orderBy, limit, onSnapshot, collectionGroup } from '../js/firebase-init.js';

const USE_DEV_COLLECTIONS = true; // Set to false for production
const getCollectionName = (baseName) => USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;

let activeSeasonId = '';
let allTeams = []; // This will now store all teams with a seasonal record
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

            return `
                <tr>
                    <td>
                        <a href="team.html?id=${team.id}" class="team-link">
                            <img src="../icons/${team.id}.webp" alt="${team.team_name}" class="team-logo" onerror="this.style.display='none'">
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

function initializeGamesSection() {
    const statusRef = doc(db, getCollectionName('live_scoring_status'), 'status');

    onSnapshot(statusRef, (statusSnap) => {
        if (liveGamesUnsubscribe) {
            liveGamesUnsubscribe();
            liveGamesUnsubscribe = null;
        }

        const status = statusSnap.exists() ? statusSnap.data().status : 'stopped';

        if (status === 'active' || status === 'paused') {
            loadLiveGames();
        } else {
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
    if (!gamesList || !gamesHeader) return;

    gamesHeader.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="24" height="24" style="vertical-align: -6px; margin-right: 8px;">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/>
            <circle cx="12" cy="12" r="5" fill="#dc3545"/>
        </svg>
        Live Games`;
    gamesList.innerHTML = '<div class="loading">Connecting to live games...</div>';

    const liveGamesQuery = query(collection(db, getCollectionName('live_games')));

    liveGamesUnsubscribe = onSnapshot(liveGamesQuery, (snapshot) => {
        if (snapshot.empty) {
            gamesList.innerHTML = '<div class="loading">No live games are currently active.</div>';
            return;
        }

        const allScores = snapshot.docs.map(doc => {
            const game = doc.data();
            const team1_total = game.team1_lineup.reduce((sum, p) => sum + (p.final_score || 0), 0);
            const team2_total = game.team2_lineup.reduce((sum, p) => sum + (p.final_score || 0), 0);
            return { team1_total, team2_total };
        });
        const maxScore = Math.max(...allScores.flatMap(g => [g.team1_total, g.team2_total]), 1);

        gamesList.innerHTML = snapshot.docs.map(gameDoc => {
            const game = gameDoc.data();
            const team1 = allTeams.find(t => t.id === game.team1_lineup[0]?.team_id);
            const team2 = allTeams.find(t => t.id === game.team2_lineup[0]?.team_id);
            if (!team1 || !team2) return '';

            const team1_total = game.team1_lineup.reduce((sum, p) => sum + (p.final_score || 0), 0);
            const team2_total = game.team2_lineup.reduce((sum, p) => sum + (p.final_score || 0), 0);
            
            const isTeam1Winning = team1_total >= team2_total;
            const team1_bar_percent = (team1_total / maxScore) * 100;
            const team2_bar_percent = (team2_total / maxScore) * 100;
            
            return `
                <div class="game-item" data-game-id="${gameDoc.id}" data-is-live="true">
                    <div class="game-matchup">
                        <div class="team">
                            <img src="../icons/${team1.id}.webp" alt="${team1.team_name}" class="team-logo" onerror="this.style.display='none'">
                            <div class="team-info">
                                <span class="team-name">${team1.team_name}</span>
                                <span class="team-record">${team1.wins || 0}-${team1.losses || 0}</span>
                            </div>
                            <div class="team-bar-container">
                                <div class="team-bar ${isTeam1Winning ? 'winner' : 'loser'}" style="width: ${team1_bar_percent}%;"></div>
                            </div>
                            <span class="team-score">${formatInThousands(team1_total)}</span>
                        </div>
                        <div class="team">
                            <img src="../icons/${team2.id}.webp" alt="${team2.team_name}" class="team-logo" onerror="this.style.display='none'">
                            <div class="team-info">
                                <span class="team-name">${team2.team_name}</span>
                                <span class="team-record">${team2.wins || 0}-${team2.losses || 0}</span>
                            </div>
                            <div class="team-bar-container">
                                <div class="team-bar ${!isTeam1Winning ? 'winner' : 'loser'}" style="width: ${team2_bar_percent}%;"></div>
                            </div>
                            <span class="team-score">${formatInThousands(team2_total)}</span>
                        </div>
                    </div>
                    <div class="game-status live">
                        <span class="live-indicator"></span>LIVE
                    </div>
                </div>`;
        }).join('');

        document.querySelectorAll('.game-item[data-is-live="true"]').forEach(item => {
            item.addEventListener('click', () => showGameDetails(item.dataset.gameId, true));
        });

    }, (error) => {
        console.error("Error fetching live games:", error);
        gamesList.innerHTML = '<div class="error">Could not load live games.</div>';
    });
}

async function loadRecentGames() {
    const gamesList = document.getElementById('recent-games');
    const gamesHeader = document.getElementById('games-header-title');
    if (!gamesList || !gamesHeader) return;

    gamesHeader.textContent = 'Recent Games';
    gamesList.innerHTML = '<div class="loading">Loading recent games...</div>';

    try {
        const gamesCollectionName = getCollectionName('games');

        const mostRecentQuery = query(
            collection(db, getCollectionName('seasons'), activeSeasonId, gamesCollectionName),
            where('completed', '==', 'TRUE'),
            orderBy('date', 'desc'),
            limit(1)
        );
        const mostRecentSnapshot = await getDocs(mostRecentQuery);
        if (mostRecentSnapshot.empty) {
            gamesList.innerHTML = '<div class="loading">No completed games yet.</div>';
            return;
        }
        const mostRecentDate = mostRecentSnapshot.docs[0].data().date;

        const gamesOnDateQuery = query(
            collection(db, getCollectionName('seasons'), activeSeasonId, gamesCollectionName),
            where('date', '==', mostRecentDate),
            where('completed', '==', 'TRUE')
        );

        const gamesSnapshot = await getDocs(gamesOnDateQuery);
        const games = gamesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        if (games.length === 0) {
            gamesList.innerHTML = '<div class="loading">No completed games yet.</div>';
            return;
        }

        const maxScore = Math.max(...games.flatMap(g => [g.team1_score || 0, g.team2_score || 0]), 1);

        gamesList.innerHTML = games.map(game => {
            const team1 = allTeams.find(t => t.id === game.team1_id);
            const team2 = allTeams.find(t => t.id === game.team2_id);
            if (!team1 || !team2) return '';

            const winnerId = game.winner;
            const team1_total = game.team1_score || 0;
            const team2_total = game.team2_score || 0;

            const team1_bar_percent = (team1_total / maxScore) * 100;
            const team2_bar_percent = (team2_total / maxScore) * 100;

            // MODIFIED for Request 2: Added 'completed' class to the game item
            return `
                <div class="game-item completed" data-game-id="${game.id}" data-game-date="${game.date}">
                    <div class="game-matchup">
                        <div class="team">
                            <img src="../icons/${team1.id}.webp" alt="${team1.team_name}" class="team-logo" onerror="this.style.display='none'">
                            <div class="team-info">
                                <span class="team-name">${team1.team_name}</span>
                                <span class="team-record">${team1.wins || 0}-${team1.losses || 0}</span>
                            </div>
                            <div class="team-bar-container">
                                <div class="team-bar ${winnerId === team1.id ? 'winner' : 'loser'}" style="width: ${team1_bar_percent}%;"></div>
                            </div>
                            <span class="team-score ${winnerId === team1.id ? 'winner' : ''}">${formatInThousands(team1_total)}</span>
                        </div>
                        <div class="team">
                            <img src="../icons/${team2.id}.webp" alt="${team2.team_name}" class="team-logo" onerror="this.style.display='none'">
                            <div class="team-info">
                                <span class="team-name">${team2.team_name}</span>
                                <span class="team-record">${team2.wins || 0}-${team2.losses || 0}</span>
                            </div>
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
            item.addEventListener('click', () => showGameDetails(item.dataset.gameId, false, item.dataset.gameDate));
        });
    } catch (error) {
        console.error("Error fetching recent games:", error);
        gamesList.innerHTML = '<div class="error">Could not load recent games. See console for details.</div>';
    }
}

function loadSeasonInfo(seasonData) {
    const currentWeekSpan = document.getElementById('current-week');
    const seasonStatsContainer = document.getElementById('season-stats');
    if (!currentWeekSpan || !seasonStatsContainer) return;

    currentWeekSpan.textContent = `Week ${seasonData.current_week || '1'}`;

    if (seasonData.status === 'postseason') {
        currentWeekSpan.textContent = seasonData.current_stage || 'Postseason';
        document.getElementById('playoff-button-container').style.display = 'block';
    }
    if (seasonData.status === 'completed') {
        const winnerInfo = allTeams.find(t => t.id === seasonData.champion_id);
        if (winnerInfo) {
            currentWeekSpan.parentElement.innerHTML = `<p class="champion-display">🏆 League Champion: <img src="../icons/${winnerInfo.id}.webp" onerror="this.style.display='none'"/> ${winnerInfo.team_name} 🏆</p>`;
        } else {
            currentWeekSpan.parentElement.innerHTML = `<p><strong>Season Complete!</strong></p>`;
        }
        document.getElementById('playoff-button-container').style.display = 'block';
    }

    seasonStatsContainer.innerHTML = `
        <p><strong>${seasonData.gp || 0} of ${seasonData.gs || 0}</strong> regular season games complete</p>
        <p><strong>${seasonData.season_trans || 0}</strong> transactions made</p>
        <p><strong>${Math.round(seasonData.season_karma || 0).toLocaleString()}</strong> total karma earned</p>
    `;
}

async function showGameDetails(gameId, isLiveGame, gameDate = null) {
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
        const gameCollectionPath = isLiveGame 
            ? getCollectionName('live_games') 
            : `${getCollectionName('seasons')}/${activeSeasonId}/${getCollectionName('games')}`;

        const gameRef = doc(db, gameCollectionPath, gameId);
        const gameSnap = await getDoc(gameRef);
        if (!gameSnap.exists()) throw new Error("Game not found");
        const game = gameSnap.data();

        let team1Lineups, team2Lineups;

        if (isLiveGame) {
            team1Lineups = game.team1_lineup || [];
            team2Lineups = game.team2_lineup || [];
        } else {
            const lineupsCollectionName = getCollectionName('lineups');
            const lineupsQuery = query(
                collection(db, getCollectionName('seasons'), activeSeasonId, lineupsCollectionName),
                where('date', '==', gameDate)
            );
            const lineupsSnapshot = await getDocs(lineupsQuery);
            const allLineupsForDate = lineupsSnapshot.docs.map(d => d.data());
            
            team1Lineups = allLineupsForDate.filter(l => l.team_id === game.team1_id && l.started === "TRUE");
            team2Lineups = allLineupsForDate.filter(l => l.team_id === game.team2_id && l.started === "TRUE");
        }

        const team1Id = isLiveGame ? game.team1_lineup[0]?.team_id : game.team1_id;
        const team2Id = isLiveGame ? game.team2_lineup[0]?.team_id : game.team2_id;

        const team1 = allTeams.find(t => t.id === team1Id);
        const team2 = allTeams.find(t => t.id === team2Id);
        
        const displayDate = isLiveGame ? 'Live' : formatDateShort(game.date);
        modalTitle.textContent = `${team1.team_name} vs ${team2.team_name} - ${displayDate}`;

        team1Lineups.sort((a, b) => (b.is_captain ? 1 : -1) || (b.final_score || 0) - (a.final_score || 0));
        team2Lineups.sort((a, b) => (b.is_captain ? 1 : -1) || (b.final_score || 0) - (a.final_score || 0));
        
        contentArea.innerHTML = `
            <div class="game-details-grid">
                ${generateLineupTable(team1Lineups, team1, !isLiveGame && game.winner === team1.id)}
                ${generateLineupTable(team2Lineups, team2, !isLiveGame && game.winner === team2.id)}
            </div>
        `;

    } catch (error) {
        console.error("Error loading game details:", error);
        contentArea.innerHTML = '<div class="error">Could not load game details.</div>';
    }
}

function generateLineupTable(lineups, team, isWinner) {
    if (!team) return '<div>Team data not found</div>';
    const totalPoints = lineups.reduce((sum, p) => sum + (p.final_score || 0), 0);
    return `
        <div class="team-breakdown ${isWinner ? 'winner' : ''}">
            <div class="modal-team-header ${isWinner ? 'winner' : ''}" onclick="window.location.href='team.html?id=${team.id}'">
                <div class="modal-team-info-wrapper">
                    <img src="../icons/${team.id}.webp" alt="${team.team_name}" class="team-logo" onerror="this.style.display='none'">
                    <h4>${team.team_name}</h4>
                    <span class="modal-team-record">(${team.wins}-${team.losses})</span>
                </div>
            </div>
            <div class="team-total">Total: ${Math.round(totalPoints).toLocaleString()}</div>
            <table class="lineup-table">
                <thead><tr><th>Player</th><th>Points</th><th>Rank</th></tr></thead>
                <tbody>
                    ${lineups.map(p => {
                        const isCaptain = p.is_captain === "TRUE" || p.is_captain === true;
                        const baseScore = p.points_adjusted || 0;
                        const finalScore = p.final_score || 0;
                        const captainBonus = isCaptain ? finalScore - baseScore : 0;
                        const captainBadge = isCaptain ? '<span class="captain-badge">C</span>' : '';
                        return `
                            <tr class="${isCaptain ? 'captain-row' : ''}">
                                <td class="player-name-cell"><a href="player.html?player=${encodeURIComponent(p.player_handle)}" class="player-link">${p.player_handle}</a>${captainBadge}</td>
                                <td class="points-cell">${Math.round(baseScore).toLocaleString()}${isCaptain ? `<div class="captain-bonus">+${Math.round(captainBonus)}</div>` : ''}</td>
                                <td class="rank-cell">${p.global_rank || '-'}</td>
                            </tr>
                        `
                    }).join('')}
                </tbody>
            </table>
        </div>
    `;
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
            console.warn("Modal component was loaded, but its internal elements (like the close button) were not found. Clicks inside the modal may not work correctly.");
        }

        const seasonData = await getActiveSeason();
        await fetchAllTeams(activeSeasonId);

        loadStandingsPreview();
        initializeGamesSection();
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
