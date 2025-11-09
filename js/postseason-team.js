// /js/postseason-team.js

import {
    db,
    collection,
    doc,
    getDoc,
    getDocs,
    query,
    where,
    collectionNames,
    getLeagueCollectionName
} from './firebase-init.js';

import { generateLineupTable } from './main.js';

// --- CONFIGURATION ---
const ACTIVE_SEASON_ID = 'S8';


// --- STATE MANAGEMENT ---
let teamId = null;
let teamData = null; // For v2_teams/{id} root doc
let teamSeasonalData = null; // For v2_teams/{id}/seasonal_records/S8 doc
let rosterPlayers = []; // Array of combined player + seasonal_stats objects
let allScheduleData = [];
let allTeamsSeasonalRecords = new Map(); // Map of teamId -> seasonal_record for getTeamName()
let rosterSortState = { column: 'post_rel_median', direction: 'desc' };

/**
 * Initializes the page, fetching and injecting the modal, and then loading all data.
 */
async function init() {
    try {
        // Dynamically load the modal component
        const modalResponse = await fetch('../common/game-modal-component.html');
        if (!modalResponse.ok) throw new Error('Failed to load modal component.');
        const modalHTML = await modalResponse.text();
        document.getElementById('modal-placeholder').innerHTML = modalHTML;

        // Add event listeners for the newly injected modal
        document.getElementById('close-modal-btn').addEventListener('click', closeGameModal);
        document.getElementById('game-modal').addEventListener('click', (event) => {
            if (event.target.id === 'game-modal') {
                closeGameModal();
            }
        });

        // Load all page data
        await loadPageData();

    } catch (error) {
        console.error("Initialization failed:", error);
        document.querySelector('main').innerHTML = `<div class="error">A critical error occurred during page initialization. Please check the console.</div>`;
    }
}

/**
 * Fetches all necessary data from Firestore for the team page.
 */
async function loadPageData() {
    try {
        const urlParams = new URLSearchParams(window.location.search);
        teamId = urlParams.get('id');

        if (!teamId) {
            document.getElementById('team-main-info').innerHTML = '<div class="error">No team specified in URL.</div>';
            return;
        }
        
        // --- DEFINE ALL DATA PROMISES ---
        const allTeamsSnap = await getDocs(collection(db, collectionNames.teams));
        const teamRecordPromises = allTeamsSnap.docs.map(teamDoc =>
            getDoc(doc(db, collectionNames.teams, teamDoc.id, collectionNames.seasonalRecords, ACTIVE_SEASON_ID))
        );
        const allTeamsRecordsPromise = Promise.all(teamRecordPromises);

        const teamDocPromise = getDoc(doc(db, collectionNames.teams, teamId));
        const teamSeasonalPromise = getDoc(doc(db, collectionNames.teams, teamId, collectionNames.seasonalRecords, ACTIVE_SEASON_ID));

        const rosterQuery = query(collection(db, collectionNames.players), where("current_team_id", "==", teamId));
        const rosterPromise = getDocs(rosterQuery);

        // Fetch POSTSEASON games instead of regular season
        const schedulePromise = getDocs(collection(db, collectionNames.seasons, ACTIVE_SEASON_ID, getLeagueCollectionName('post_games')));

        // --- AWAIT ALL PROMISES ---
        const [
            allTeamsRecordsSnaps,
            teamDocSnap,
            teamSeasonalSnap,
            rosterSnap,
            scheduleSnap
        ] = await Promise.all([
            allTeamsRecordsPromise,
            teamDocPromise,
            teamSeasonalPromise,
            rosterPromise,
            schedulePromise
        ]);

        // --- PROCESS HELPERS & GLOBAL DATA (Must be done first) ---
        allTeamsRecordsSnaps.forEach(snap => {
            if (snap.exists()) {
                const teamIdForRecord = snap.ref.parent.parent.id;
                allTeamsSeasonalRecords.set(teamIdForRecord, snap.data());
            }
        });
        
        generateIconStylesheet(Array.from(allTeamsSeasonalRecords.keys()));

        // --- PROCESS CORE TEAM DATA ---
        if (!teamDocSnap.exists() || !teamSeasonalSnap.exists()) {
            document.getElementById('team-main-info').innerHTML = `<div class="error">Team data not found for ID: ${teamId} in Season ${ACTIVE_SEASON_ID}.</div>`;
            return;
        }
        teamData = { id: teamDocSnap.id, ...teamDocSnap.data() };
        teamSeasonalData = teamSeasonalSnap.data();

        // --- PROCESS OTHER DATA ---
        allScheduleData = scheduleSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        
        // --- PROCESS ROSTER & PLAYER SEASONAL STATS (MULTI-STEP) ---
        const playerDocs = rosterSnap.docs;
        const playerSeasonalStatsPromises = playerDocs.map(pDoc =>
            getDoc(doc(db, collectionNames.players, pDoc.id, collectionNames.seasonalStats, ACTIVE_SEASON_ID))
        );
        const playerSeasonalStatsSnaps = await Promise.all(playerSeasonalStatsPromises);

        rosterPlayers = playerDocs.map((pDoc, index) => {
            const seasonalStats = playerSeasonalStatsSnaps[index].exists() ? playerSeasonalStatsSnaps[index].data() : {};
            return {
                id: pDoc.id,
                ...pDoc.data(),
                ...seasonalStats
            };
        });

        // --- RENDER ALL PAGE COMPONENTS ---
        displayTeamHeader();
        loadRoster();
        loadSchedule();

    } catch (error) {
        console.error("A critical error occurred during data loading:", error);
        document.querySelector('main').innerHTML = `<div class="error">A critical error occurred while loading the page. Please check the console for details.</div>`;
    }
}

// --- RENDERING FUNCTIONS ---

function displayTeamHeader() {
    const teamName = teamSeasonalData.team_name || teamData.id;
    document.getElementById('page-title').textContent = `${teamName} Postseason - RKL Season 8`;

    // Setup button to link back to regular season page
    const regularSeasonBtn = document.getElementById('regular-season-btn');
    regularSeasonBtn.href = `team.html?id=${teamId}`;
    regularSeasonBtn.style.display = 'inline-block';

    const { post_wins = 0, post_losses = 0, post_pam = 0, post_med_starter_rank = 0, post_msr_rank = 0, post_pam_rank = 0 } = teamSeasonalData;

    const teamIdClassName = `icon-${teamData.id.replace(/[^a-zA-Z0-9]/g, '')}`;

    document.getElementById('team-main-info').innerHTML = `
        <div style="display: flex; align-items: center; gap: 1.5rem;">
            <div class="team-logo-css team-logo-large ${teamIdClassName}" role="img" aria-label="${teamName}"></div>
            <div class="team-details">
                <h2>${teamName}</h2>
                <div class="postseason-subtitle">Postseason Profile</div>
                <div class="team-subtitle">${teamData.id} • ${teamData.conference} Conference</div>
                <div class="gm-info">General Manager: ${teamData.current_gm_handle}</div>
            </div>
        </div>`;

    const teamStatsContainer = document.getElementById('team-stats');
    teamStatsContainer.innerHTML = `
        <div class="stat-card">
            <div class="stat-value ${post_wins > post_losses ? 'positive' : post_losses > post_wins ? 'negative' : ''}">${post_wins}-${post_losses}</div>
            <div class="stat-label">Postseason Record</div>
        </div>
        <div class="stat-card">
            <div class="stat-value ${post_pam > 0 ? 'positive' : post_pam < 0 ? 'negative' : ''}">${Math.round(post_pam).toLocaleString()}</div>
            <div class="stat-label">Postseason PAM</div>
            <div class="stat-rank">${getOrdinal(post_pam_rank)} Overall</div>
        </div>
        <div class="stat-card">
            <div class="stat-value">${Math.round(post_med_starter_rank)}</div>
            <div class="stat-label">Median Starter Rank</div>
            <div class="stat-rank">${getOrdinal(post_msr_rank)} Overall</div>
        </div>`;
    teamStatsContainer.style.display = 'grid';
}

function loadRoster() {
    if (rosterPlayers.length === 0) {
        document.getElementById('roster-list').innerHTML = '<div style="text-align: center; padding: 2rem; color: #666;">No active players found</div>';
        return;
    }

    rosterPlayers.sort((a, b) => {
        const valA = parseFloat(a[rosterSortState.column] || 0);
        const valB = parseFloat(b[rosterSortState.column] || 0);
        const comparison = valA < valB ? -1 : (valA > valB ? 1 : 0);
        return rosterSortState.direction === 'desc' ? -comparison : comparison;
    });

    const teamIdClassName = `icon-${teamData.id.replace(/[^a-zA-Z0-9]/g, '')}`;
    const rosterHTML = rosterPlayers.map(player => {
        const {
            post_rel_median = 0,
            post_games_played = 0,
            all_star = '0',
            rookie = '0',
            post_WAR = 0,
            post_medrank = 0,
            player_handle,
            id: playerId
        } = player;

        const isAllStar = all_star === '1';
        const isRookie = rookie === '1';
        const medianRankDisplay = post_medrank > 0 ? post_medrank : '-';

        return `
            <div class="player-item">
                <div class="roster-player-logo-col desktop-only-roster-logo">
                    <div class="team-logo-css ${teamIdClassName}" style="width: 24px; height: 24px;"></div>
                </div>
                <div class="player-info">
                    <a href="player.html?id=${playerId}" class="player-name">
                        ${player_handle}
                        ${isRookie ? ` <span class="rookie-badge">R</span>` : ''}
                        ${isAllStar ? ' <span class="all-star-badge">★</span>' : ''}
                    </a>
                    <div class="player-stats">${post_games_played} games • ${medianRankDisplay} med rank</div>
                </div>
                <div class="player-rel">${parseFloat(post_rel_median).toFixed(3)}</div>
                <div class="player-war">${parseFloat(post_WAR).toFixed(2)}</div>
            </div>`;
    }).join('');

    const relSortIndicator = rosterSortState.column === 'post_rel_median' ? (rosterSortState.direction === 'desc' ? ' ▼' : ' ▲') : '';
    const warSortIndicator = rosterSortState.column === 'post_WAR' ? (rosterSortState.direction === 'desc' ? ' ▼' : ' ▲') : '';

    const finalHTML = `
        <div class="roster-header">
            <span class="roster-logo-header-col desktop-only-roster-logo"></span>
            <span class="header-player">Player</span>
            <span class="header-rel sortable" onclick="handleRosterSort('post_rel_median')">REL Median<span class="sort-indicator">${relSortIndicator}</span></span>
            <span class="header-war sortable" onclick="handleRosterSort('post_WAR')">WAR<span class="sort-indicator">${warSortIndicator}</span></span>
        </div>
        <div class="roster-content">${rosterHTML}</div>`;

    document.getElementById('roster-list').innerHTML = finalHTML;
}

function loadSchedule() {
    const teamGames = allScheduleData
        .filter(game => game.team1_id === teamId || game.team2_id === teamId)
        .sort((a, b) => new Date(normalizeDate(a.date)) - new Date(normalizeDate(b.date)));

    if (teamGames.length === 0) {
        document.getElementById('team-schedule').innerHTML = '<div style="text-align: center; padding: 2rem; color: #666;">No postseason games scheduled</div>';
        return;
    }

    const gamesHTML = teamGames.map(game => {
        return generateGameItemHTML(game);
    }).join('');

    document.getElementById('team-schedule').innerHTML = gamesHTML;
}

// --- MODAL & EVENT HANDLERS ---

async function showGameDetails(team1_id, team2_id, gameDate) {
    const modal = document.getElementById('game-modal');
    const modalTitle = document.getElementById('modal-title');
    const modalContentEl = document.getElementById('game-details-content-area');

    const normalizedDate = normalizeDate(gameDate);
    modal.style.display = 'block';
    modalTitle.textContent = `${getTeamName(team1_id)} vs ${getTeamName(team2_id)} - ${formatDateShort(normalizedDate)}`;
    modalContentEl.innerHTML = '<div class="loading">Loading game details...</div>';
    
    try {
        const q = query(
            collection(db, collectionNames.seasons, ACTIVE_SEASON_ID, getLeagueCollectionName('post_lineups')), // Query post_lineups
            where("date", "==", gameDate),
            where("team_id", "in", [team1_id, team2_id]),
            where("started", "==", "TRUE")
        );
        const lineupsSnap = await getDocs(q);
        
        const allPlayerIdsInGame = lineupsSnap.docs.map(doc => doc.data().player_id);
        const uniquePlayerIds = [...new Set(allPlayerIdsInGame)];

        const playerStatsPromises = uniquePlayerIds.map(playerId =>
            getDoc(doc(db, collectionNames.players, playerId, collectionNames.seasonalStats, ACTIVE_SEASON_ID))
        );
        const playerStatsDocs = await Promise.all(playerStatsPromises);
        
        const playerSeasonalStats = new Map();
        playerStatsDocs.forEach((docSnap, index) => {
            if (docSnap.exists()) {
                playerSeasonalStats.set(uniquePlayerIds[index], docSnap.data());
            }
        });

        const lineupsData = lineupsSnap.docs.map(d => {
            const lineupData = d.data();
            return { ...lineupData, ...playerSeasonalStats.get(lineupData.player_id) };
        });

        const team1Lineups = lineupsData.filter(l => l.team_id === team1_id);
        const team2Lineups = lineupsData.filter(l => l.team_id === team2_id);

        const team1Record = getTeamRecordAtDate(team1_id, gameDate, true);
        const team2Record = getTeamRecordAtDate(team2_id, gameDate, true);
        
        const team1Info = { id: team1_id, team_name: getTeamName(team1_id), wins: team1Record.wins, losses: team1Record.losses };
        const team2Info = { id: team2_id, team_name: getTeamName(team2_id), wins: team2Record.wins, losses: team2Record.losses };
        
        const gameDocId = allScheduleData.find(g => g.date === gameDate && g.team1_id === team1_id && g.team2_id === team2_id)?.id;
        
        if (!gameDocId) throw new Error("Could not find game document ID.");

        const gameSnap = await getDoc(doc(db, collectionNames.seasons, ACTIVE_SEASON_ID, getLeagueCollectionName("post_games"), gameDocId));
        const winnerId = gameSnap.exists() ? gameSnap.data().winner : null;

        modalContentEl.innerHTML = `
            <div class="game-details-grid">
                // FIX #2: Removed the incorrect final 'true' argument, which was triggering the 'live' indicator.
                ${generateLineupTable(team1Lineups, team1Info, winnerId === team1_id)}
                ${generateLineupTable(team2Lineups, team2Info, winnerId === team2_id)}
            </div>`;

    } catch(error) {
        console.error("Error fetching game details:", error);
        modalContentEl.innerHTML = `<div class="error">Could not load game details.</div>`;
    }
}

function closeGameModal() {
    document.getElementById('game-modal').style.display = 'none';
}

function handleRosterSort(column) {
    if (rosterSortState.column === column) {
        rosterSortState.direction = rosterSortState.direction === 'desc' ? 'asc' : 'desc';
    } else {
        rosterSortState.column = column;
        rosterSortState.direction = 'desc';
    }
    loadRoster();
}


// --- HELPER & UTILITY FUNCTIONS ---

function generateIconStylesheet(teamIdList) {
    const iconStyles = teamIdList.map(id => {
        if (!id) return '';
        const className = `icon-${id.replace(/[^a-zA-Z0-9]/g, '')}`;
        return `.${className} { background-image: url('../icons/${id}.webp'); }`;
    }).join('');

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

function getTeamName(id) {
    return allTeamsSeasonalRecords.get(id)?.team_name || id;
}

function getTeamRecordAtDate(teamIdForRecord, targetDate, isPostseason = false) {
    const normalizedTargetDate = normalizeDate(targetDate);
    const collection = isPostseason ? 'post_games' : 'games';

    const completedGames = allScheduleData.filter(game => {
        const normalizedGameDate = normalizeDate(game.date);
        return normalizedGameDate && normalizedGameDate <= normalizedTargetDate &&
            game.completed === 'TRUE' &&
            (game.team1_id === teamIdForRecord || game.team2_id === teamIdForRecord);
    });

    let wins = 0, losses = 0;
    completedGames.forEach(game => {
        if (game.winner === teamIdForRecord) wins++;
        else if (game.winner) losses++;
    });

    return { wins, losses, recordString: `${wins}-${losses}` };
}

// FIX #1: Added this helper function to get week abbreviations
function getWeekAbbreviation(weekName) {
    if (!weekName) return 'TBD';
    const lower = weekName.toLowerCase();
    if (lower.includes('play-in')) return 'PI';
    if (lower.includes('round 1')) return 'R1';
    if (lower.includes('round 2')) return 'R2';
    if (lower.includes('conf finals')) return 'CF';
    if (lower.includes('finals')) return 'F';
    return weekName.substring(0, 2).toUpperCase(); // Fallback for other potential rounds
}

function generateGameItemHTML(game) {
    const isTeam1 = game.team1_id === teamId;
    const opponentId = isTeam1 ? game.team2_id : game.team1_id;
    const isCompleted = game.completed === 'TRUE';
    
    const teamName = getTeamName(teamId);
    const opponentName = getTeamName(opponentId);
    
    const teamRecord = getTeamRecordAtDate(teamId, game.date, true).recordString;
    const opponentRecord = getTeamRecordAtDate(opponentId, game.date, true).recordString;

    let clickHandler = '', teamScoreText = '-', oppScoreText = '-', teamScoreClass = 'upcoming', oppScoreClass = 'upcoming';
    let teamWon = false, oppWon = false;

    if (isCompleted) {
        const teamScoreValue = parseFloat(isTeam1 ? game.team1_score : game.team2_score);
        const oppScoreValue = parseFloat(isTeam1 ? game.team2_score : game.team1_score);
        teamWon = teamScoreValue > oppScoreValue;
        oppWon = !teamWon && !!game.winner;
        teamScoreText = Math.round(teamScoreValue).toLocaleString();
        oppScoreText = Math.round(oppScoreValue).toLocaleString();
        teamScoreClass = teamWon ? 'win' : 'loss';
        oppScoreClass = oppWon ? 'win' : 'loss';
        clickHandler = `onclick="showGameDetails('${game.team1_id}', '${game.team2_id}', '${game.date}')" style="cursor: pointer;"`;
    }
    
    const teamIdClassName = `icon-${teamId.replace(/[^a-zA-Z0-9]/g, '')}`;
    const opponentIdClassName = `icon-${opponentId.replace(/[^a-zA-Z0-9]/g, '')}`;
    
    const desktopHTML = `
        <div class="game-info-table">
            <div class="week-cell"><div class="week-badge">${getWeekAbbreviation(game.week)}</div></div>
            <div class="date-cell"><div class="date-badge">${formatDateMMDD(normalizeDate(game.date))}</div></div>
        </div>
        <div class="game-content-table">
            <div class="team-section left">
                <div class="team-logo-css ${teamIdClassName}" style="width: 32px; height: 32px; border-radius: 50%;"></div>
                <div class="team-details"><div class="team-name-game">${teamName}</div><div class="team-record-game">${teamRecord}</div></div>
            </div>
            <div class="scores-section">
                <div class="score ${teamScoreClass}">${teamScoreText}</div>
                <div class="vs-text">vs</div>
                <div class="score ${oppScoreClass}">${oppScoreText}</div>
            </div>
            <div class="team-section right">
                <div class="team-logo-css ${opponentIdClassName}" style="width: 32px; height: 32px; border-radius: 50%;" onclick="window.location.href='team.html?id=${opponentId}'" style="cursor: pointer;"></div>
                <div class="team-details right"><div class="team-name-game">${opponentName}</div><div class="team-record-game">${opponentRecord}</div></div>
            </div>
        </div>`;
    
    const mobileHTML = `
        <div class="game-matchup">
            <div class="week-badge">${getWeekAbbreviation(game.week)}</div>
            <div class="team">
                <div class="team-logo-css ${teamIdClassName}" style="width: 32px; height: 32px;"></div>
                <div class="team-info"><span class="team-name ${teamWon ? 'win' : oppWon ? 'loss' : ''}">${teamName}</span><span class="team-record">${teamRecord}</span></div>
                <span class="team-score ${teamScoreClass}">${teamScoreText}</span>
            </div>
            <div class="team">
                <div class="team-logo-css ${opponentIdClassName}" style="width: 32px; height: 32px;" onclick="window.location.href='team.html?id=${opponentId}'" style="cursor: pointer;"></div>
                <div class="team-info"><span class="team-name ${oppWon ? 'win' : teamWon ? 'loss' : ''}">${opponentName}</span><span class="team-record">${opponentRecord}</span></div>
                <span class="team-score ${oppScoreClass}">${oppScoreText}</span>
            </div>
        </div>`;

    return `<div class="game-item" ${clickHandler}>${desktopHTML}${mobileHTML}</div>`;
}


function normalizeDate(dateInput) {
    if (!dateInput) return null;
    let date;
    if (typeof dateInput.toDate === 'function') {
        date = dateInput.toDate();
    } else {
        const parts = dateInput.split('/');
        if (parts.length === 3) {
            date = new Date(Date.UTC(parts[2], parts[0] - 1, parts[1]));
        } else {
            return null;
        }
    }
    if (isNaN(date.getTime())) return null;
    return date.toISOString().split('T')[0]; // YYYY-MM-DD
}

function formatDateMMDD(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString + 'T00:00:00Z');
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${month}-${day}`;
}

function formatDateShort(dateString) {
    if (!dateString) return '';
    const date = new Date(dateString + 'T00:00:00Z');
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const year = String(date.getUTCFullYear()).slice(-2);
    return `${month}/${day}/${year}`;
}

function getOrdinal(num) {
    const n = parseInt(num);
    if (isNaN(n) || n <= 0) return 'Unranked';
    const s = ["th", "st", "nd", "rd"], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// --- GLOBAL EXPORTS & INITIALIZATION ---
window.handleRosterSort = handleRosterSort;
window.showGameDetails = showGameDetails;
document.addEventListener('DOMContentLoaded', init);
