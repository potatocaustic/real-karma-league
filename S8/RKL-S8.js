import { db, getDoc, getDocs, collection, doc, query, where, orderBy, limit } from '../js/firebase-init.js';

const USE_DEV_COLLECTIONS = true; // Set to false for production
const getCollectionName = (baseName) => USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;

let activeSeasonId = '';
let allTeams = []; // This will now store all teams with a seasonal record

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
    const teamsSnapshot = await getDocs(teamsQuery);

    if (teamsSnapshot.empty) {
        console.error(`No documents found in the '${teamsCollectionName}' collection.`);
        return;
    }

    const teamPromises = teamsSnapshot.docs.map(async (teamDoc) => {
        const teamData = { id: teamDoc.id, ...teamDoc.data() };
        const seasonalRecordRef = doc(db, teamsCollectionName, teamDoc.id, seasonalRecordsCollectionName, seasonId);
        const seasonalRecordSnap = await getDoc(seasonalRecordRef);

        if (seasonalRecordSnap.exists()) {
            return { ...teamData, ...seasonalRecordSnap.data() };
        }
        return null;
    });

    const teams = await Promise.all(teamPromises);
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

async function loadRecentGames() {
    const gamesList = document.getElementById('recent-games');
    if (!gamesList) return;

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

        gamesList.innerHTML = games.map(game => {
            const team1 = allTeams.find(t => t.id === game.team1_id);
            const team2 = allTeams.find(t => t.id === game.team2_id);
            if (!team1 || !team2) return ''; 

            const winnerId = game.winner;
            return `
                <div class="game-item" data-game-id="${game.id}" data-game-date="${game.date}">
                    <div class="game-matchup">
                        <div class="team ${winnerId === team1.id ? 'winner' : ''}">
                            <img src="../icons/${team1.id}.webp" alt="${team1.team_name}" class="team-logo" onerror="this.style.display='none'">
                            <div class="team-info">
                                <span class="team-name">${team1.team_name}</span>
                                <span class="team-record">${team1.wins || 0}-${team1.losses || 0}</span>
                            </div>
                            <span class="team-score ${winnerId === team1.id ? 'winner' : ''}">${formatInThousands(game.team1_score)}</span>
                        </div>
                        <span class="vs">vs</span>
                        <div class="team ${winnerId === team2.id ? 'winner' : ''}">
                            <img src="../icons/${team2.id}.webp" alt="${team2.team_name}" class="team-logo" onerror="this.style.display='none'">
                            <div class="team-info">
                                <span class="team-name">${team2.team_name}</span>
                                <span class="team-record">${team2.wins || 0}-${team2.losses || 0}</span>
                            </div>
                            <span class="team-score ${winnerId === team2.id ? 'winner' : ''}">${formatInThousands(game.team2_score)}</span>
                        </div>
                    </div>
                    <div class="game-date">${formatDate(game.date)}</div>
                </div>`;
        }).join('');

        document.querySelectorAll('.game-item').forEach(item => {
            item.addEventListener('click', () => showGameDetails(item.dataset.gameId, item.dataset.gameDate));
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

async function showGameDetails(gameId, gameDate) {
    const modal = document.getElementById('game-modal');
    const modalTitle = document.getElementById('modal-title');
    const contentArea = document.getElementById('game-details-content-area');

    modal.style.display = 'block';
    contentArea.innerHTML = '<div class="loading">Loading game details...</div>';

    try {
        const gamesCollectionName = getCollectionName('games');
        const lineupsCollectionName = getCollectionName('lineups');

        const gameRef = doc(db, getCollectionName('seasons'), activeSeasonId, gamesCollectionName, gameId);
        const gameSnap = await getDoc(gameRef);
        if (!gameSnap.exists()) throw new Error("Game not found");
        const game = gameSnap.data();
        
        const lineupsQuery = query(
            collection(db, getCollectionName('seasons'), activeSeasonId, lineupsCollectionName),
            where('date', '==', gameDate)
        );
        const lineupsSnapshot = await getDocs(lineupsQuery);
        const allLineupsForDate = lineupsSnapshot.docs.map(d => d.data());
        
        const team1 = allTeams.find(t => t.id === game.team1_id);
        const team2 = allTeams.find(t => t.id === game.team2_id);
        modalTitle.textContent = `${team1.team_name} vs ${team2.team_name} - ${formatDateShort(game.date)}`;
        
        const team1Lineups = allLineupsForDate.filter(l => l.team_id === game.team1_id && l.started === "TRUE").sort((a,b) => (b.is_captain === "TRUE" ? 1 : -1) || (b.final_score || 0) - (a.final_score || 0));
        const team2Lineups = allLineupsForDate.filter(l => l.team_id === game.team2_id && l.started === "TRUE").sort((a,b) => (b.is_captain === "TRUE" ? 1 : -1) || (b.final_score || 0) - (a.final_score || 0));

        contentArea.innerHTML = `
            <div class="game-details-grid">
                ${generateLineupTable(team1Lineups, team1, game.winner === team1.id)}
                ${generateLineupTable(team2Lineups, team2, game.winner === team2.id)}
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
            <div class="modal-team-header ${isWinner ? 'winner' : ''}" onclick="window.location.href='team.html?id=${team.id}'" style="cursor: pointer;">
                <img src="../icons/${team.id}.webp" alt="${team.team_name}" class="team-logo" onerror="this.style.display='none'">
                <div><h4>${team.team_name}</h4><div style="font-size: 0.9rem; opacity: 0.9;">(${team.wins}-${team.losses})</div></div>
            </div>
            <div class="team-total">Total: ${Math.round(totalPoints).toLocaleString()}</div>
            <table class="lineup-table">
                <thead><tr><th>Player</th><th>Points</th><th>Rank</th></tr></thead>
                <tbody>
                    ${lineups.map(p => {
                        const isCaptain = p.is_captain === "TRUE";
                        const baseScore = p.points_adjusted || 0;
                        const finalScore = p.final_score || 0;
                        const captainBonus = isCaptain ? finalScore - baseScore : 0;
                        // **This is the key fix**: Conditionally create the captain badge HTML
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
    document.getElementById('game-modal').style.display = 'none';
}

// --- INITIALIZATION ---

async function initializePage() {
    try {
        const seasonData = await getActiveSeason();
        await fetchAllTeams(activeSeasonId);

        loadStandingsPreview();
        loadRecentGames();
        loadSeasonInfo(seasonData);

        document.getElementById('close-modal-btn').addEventListener('click', closeModal);
        window.addEventListener('click', (event) => {
            if (event.target == document.getElementById('game-modal')) {
                closeModal();
            }
        });

    } catch (error) {
        console.error("Failed to initialize page:", error);
        document.querySelector('main').innerHTML = `<p style="text-align:center; color: red;">Error: Could not load league data. ${error.message}</p>`;
    }
}

document.addEventListener('DOMContentLoaded', initializePage);