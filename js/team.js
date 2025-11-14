// /js/team.js

import {
    db,
    collection,
    collectionGroup,
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
const ACTIVE_SEASON_ID = 'S9';


// --- STATE MANAGEMENT ---
let teamId = null;
let teamData = null; // For v2_teams/{id} root doc
let teamSeasonalData = null; // For v2_teams/{id}/seasonal_records/S8 doc
let rosterPlayers = []; // Array of combined player + seasonal_stats objects
let allScheduleData = [];
let allDraftPicks = [];
let allTransactions = [];
let allTeamsSeasonalRecords = new Map(); // Map of teamId -> seasonal_record for getTeamName()
let rosterSortState = { column: 'rel_median', direction: 'desc' };

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
        // ✅ EFFICIENT - Use collectionGroup to fetch all seasonal records in one query
        const allTeamsRecordsQuery = query(
            collectionGroup(db, collectionNames.seasonalRecords),
            where('seasonId', '==', ACTIVE_SEASON_ID)
        );

        const teamDocPromise = getDoc(doc(db, collectionNames.teams, teamId));
        const teamSeasonalPromise = getDoc(doc(db, collectionNames.teams, teamId, collectionNames.seasonalRecords, ACTIVE_SEASON_ID));

        const rosterQuery = query(collection(db, collectionNames.players), where("current_team_id", "==", teamId));
        const rosterPromise = getDocs(rosterQuery);

        const schedulePromise = getDocs(collection(db, collectionNames.seasons, ACTIVE_SEASON_ID, getLeagueCollectionName("games")));

        const draftPicksPromise = getDocs(collection(db, collectionNames.draftPicks));
        const transactionsPromise = getDocs(collection(db, collectionNames.transactions, "seasons", ACTIVE_SEASON_ID));

        // NEW: Fetch the active season document for postseason button logic
        const activeSeasonQuery = query(collection(db, collectionNames.seasons), where('status', '==', 'active'));
        const activeSeasonPromise = getDocs(activeSeasonQuery);


        // --- AWAIT ALL PROMISES ---
        const [
            allTeamsRecordsSnap,
            teamDocSnap,
            teamSeasonalSnap,
            rosterSnap,
            scheduleSnap,
            draftPicksSnap,
            transactionsSnap,
            activeSeasonSnap // NEW: Active season snapshot
        ] = await Promise.all([
            getDocs(allTeamsRecordsQuery),
            teamDocPromise,
            teamSeasonalPromise,
            rosterPromise,
            schedulePromise,
            draftPicksPromise,
            transactionsPromise,
            activeSeasonPromise // NEW: Active season promise
        ]);

        // --- PROCESS HELPERS & GLOBAL DATA (Must be done first) ---
        // Build map from collectionGroup results
        allTeamsRecordsSnap.forEach(snap => {
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
        allDraftPicks = draftPicksSnap.docs.map(d => d.data());
        allTransactions = transactionsSnap.docs.map(d => ({id: d.id, ...d.data()}));

        // --- PROCESS ROSTER & PLAYER SEASONAL STATS (EFFICIENT) ---
        // ✅ EFFICIENT - Fetch all player seasonal stats in one query using player IDs
        const playerDocs = rosterSnap.docs;
        const playerIds = playerDocs.map(pDoc => pDoc.id);

        // Fetch all seasonal stats for roster players in one query
        const playerStatsQuery = query(
            collectionGroup(db, collectionNames.seasonalStats),
            where('seasonId', '==', ACTIVE_SEASON_ID)
        );
        const playerStatsSnap = await getDocs(playerStatsQuery);

        // Build a map of playerId -> seasonal stats
        const playerStatsMap = new Map();
        playerStatsSnap.forEach(statDoc => {
            const playerId = statDoc.ref.parent.parent.id;
            if (playerIds.includes(playerId)) {
                playerStatsMap.set(playerId, statDoc.data());
            }
        });

        rosterPlayers = playerDocs.map(pDoc => {
            const seasonalStats = playerStatsMap.get(pDoc.id) || {};
            return {
                id: pDoc.id,
                ...pDoc.data(),
                ...seasonalStats
            };
        });

        // NEW: Set button visibility
        setPostseasonButtonVisibility(activeSeasonSnap);

        // --- RENDER ALL PAGE COMPONENTS ---
        displayTeamHeader();
        loadRoster();
        loadSchedule();
        loadDraftCapital();

    } catch (error) {
        console.error("A critical error occurred during data loading:", error);
        document.querySelector('main').innerHTML = `<div class="error">A critical error occurred while loading the page. Please check the console for details.</div>`;
    }
}

// --- RENDERING FUNCTIONS ---

function displayTeamHeader() {
    const teamName = teamSeasonalData.team_name || teamData.id;
    document.getElementById('page-title').textContent = `${teamName} - RKL Season 8`;

    const { wins = 0, losses = 0, pam = 0, total_transactions = 0, postseed = 0, pam_rank = 0, med_starter_rank = 0, msr_rank = 0 } = teamSeasonalData;

    const teamIdClassName = `icon-${teamData.id.replace(/[^a-zA-Z0-9]/g, '')}`;

    document.getElementById('team-main-info').innerHTML = `
        <div style="display: flex; align-items: center; gap: 1.5rem;">
            <div class="team-logo-css team-logo-large ${teamIdClassName}" role="img" aria-label="${teamName}"></div>
            <div class="team-details">
            <h2>${teamName}</h2>
            <div class="team-subtitle">${teamData.id} • ${teamData.conference} Conference</div>
            <div class="gm-info">General Manager: ${teamData.current_gm_handle}</div>
            </div>
        </div>`;

    const teamStatsContainer = document.getElementById('team-stats');
    teamStatsContainer.innerHTML = `
        <a href="standings.html" class="stat-card-link">
            <div class="stat-card">
                <div class="stat-value ${wins > losses ? 'positive' : losses > wins ? 'negative' : ''}">${wins}-${losses}</div>
                <div class="stat-label">Record</div>
                <div class="stat-rank">${getOrdinal(postseed)} in ${teamData.conference} Conference</div>
            </div>
        </a>
        <a href="standings.html?view=fullLeague&sortBy=pam&sortDirection=desc" class="stat-card-link">
            <div class="stat-card">
                <div class="stat-value ${pam > 0 ? 'positive' : pam < 0 ? 'negative' : ''}">${Math.round(pam).toLocaleString()}</div>
                <div class="stat-label">PAM</div>
                <div class="stat-rank">${getOrdinal(pam_rank)} Overall</div>
            </div>
        </a>
        <a href="standings.html?view=fullLeague&sortBy=med_starter_rank&sortDirection=asc" class="stat-card-link">
            <div class="stat-card">
                <div class="stat-value">${Math.round(med_starter_rank)}</div>
                <div class="stat-label">Median Starter Rank</div>
                <div class="stat-rank">${getOrdinal(msr_rank)} Overall</div>
            </div>
        </a>
        <a href="transactions.html?teamFilter=${teamData.id}" class="stat-card-link">
            <div class="stat-card">
                <div class="stat-value">${total_transactions}</div>
                <div class="stat-label">Transactions</div>
                <div class="stat-rank">&nbsp;</div>
            </div>
        </a>`;
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
            rel_median = 0,
            games_played = 0,
            all_star = '0',
            rookie = '0',
            WAR = 0,
            medrank = 0,
            player_handle,
            id: playerId
        } = player;

        const isAllStar = all_star === '1';
        const isRookie = rookie === '1';
        const medianRankDisplay = medrank > 0 ? medrank : '-';

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
                    <div class="player-stats">${games_played} games • ${medianRankDisplay} med rank</div>
                </div>
                <div class="player-rel">${parseFloat(rel_median).toFixed(3)}</div>
                <div class="player-war">${parseFloat(WAR).toFixed(2)}</div>
            </div>`;
    }).join('');

    const relSortIndicator = rosterSortState.column === 'rel_median' ? (rosterSortState.direction === 'desc' ? ' ▼' : ' ▲') : '';
    const warSortIndicator = rosterSortState.column === 'WAR' ? (rosterSortState.direction === 'desc' ? ' ▼' : ' ▲') : '';

    const finalHTML = `
        <div class="roster-header">
            <span class="roster-logo-header-col desktop-only-roster-logo"></span>
            <span class="header-player">Player</span>
            <span class="header-rel sortable" onclick="handleRosterSort('rel_median')">REL Median<span class="sort-indicator">${relSortIndicator}</span></span>
            <span class="header-war sortable" onclick="handleRosterSort('WAR')">WAR<span class="sort-indicator">${warSortIndicator}</span></span>
        </div>
        <div class="roster-content">${rosterHTML}</div>`;

    document.getElementById('roster-list').innerHTML = finalHTML;
}

function loadSchedule() {
    const teamGames = allScheduleData
        .filter(game => game.team1_id === teamId || game.team2_id === teamId)
        .sort((a, b) => new Date(normalizeDate(a.date)) - new Date(normalizeDate(b.date)));

    if (teamGames.length === 0) {
        document.getElementById('team-schedule').innerHTML = '<div style="text-align: center; padding: 2rem; color: #666;">No games scheduled</div>';
        return;
    }

    const gamesHTML = teamGames.map(game => {
        return generateGameItemHTML(game);
    }).join('');

    document.getElementById('team-schedule').innerHTML = gamesHTML;
}

function loadDraftCapital() {
    const teamPicks = allDraftPicks
        .filter(pick => pick.current_owner === teamId)
        .sort((a, b) => (parseInt(a.season || 0) - parseInt(b.season || 0)) || (parseInt(a.round || 0) - parseInt(b.round || 0)));

    if (teamPicks.length === 0) {
        document.getElementById('draft-picks').innerHTML = '<div style="text-align: center; padding: 2rem; color: #666;">No draft picks owned</div>';
        return;
    }

    const picksBySeason = teamPicks.reduce((acc, pick) => {
        (acc[pick.season] = acc[pick.season] || []).push(pick);
        return acc;
    }, {});

    const seasonsHTML = Object.keys(picksBySeason).sort((a,b) => a-b).map(season => {
        const picks = picksBySeason[season];
        const picksHTML = picks.map(pick => generatePickItemHTML(pick)).join('');
        const seasonColor = getSeasonColor(parseInt(season));
        
        return `<div class="season-group" style="margin-bottom: 1.5rem;">
            <div class="season-header" style="background-color: ${seasonColor}; color: white; padding: 1rem; border-radius: 6px 6px 0 0; font-weight: bold; display: flex; justify-content: space-between; align-items: center;">
                <span>Season ${season} Draft</span>
                <span class="season-pick-count-badge" style="background-color: rgba(255,255,255,0.2); padding: 0.3rem 0.6rem; border-radius: 12px;">
                    ${picks.length} pick${picks.length !== 1 ? "s" : ""}
                </span>
            </div>
            <div class="season-picks" style="border: 1px solid ${seasonColor}; border-top: none; border-radius: 0 0 6px 6px;">${picksHTML}</div>
        </div>`;
    }).join('');
    
    const totalPicks = teamPicks.length;
    const summaryPendingForfeitureCount = teamPicks.filter(p => p.notes && p.notes.toUpperCase() === 'PENDING FORFEITURE').length;
    const summaryOwnPicks = teamPicks.filter(p => p.original_team === teamId && !(p.notes && p.notes.toUpperCase() === 'PENDING FORFEITURE')).length;
    const summaryAcquiredPicks = teamPicks.filter(p => p.original_team !== teamId && !(p.notes && p.notes.toUpperCase() === 'PENDING FORFEITURE')).length;
    const summaryHTML = generateDraftSummaryHTML(totalPicks, summaryOwnPicks, summaryAcquiredPicks, summaryPendingForfeitureCount);

    document.getElementById('draft-picks').innerHTML = summaryHTML + seasonsHTML;
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
            collection(db, collectionNames.seasons, ACTIVE_SEASON_ID, getLeagueCollectionName("lineups")),
            where("date", "==", gameDate), // Query with the original M/D/YYYY date
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

        const team1Record = getTeamRecordAtDate(team1_id, gameDate).split('-').map(Number);
        const team2Record = getTeamRecordAtDate(team2_id, gameDate).split('-').map(Number);

        const team1Info = { id: team1_id, team_name: getTeamName(team1_id), wins: team1Record[0], losses: team1Record[1] };
        const team2Info = { id: team2_id, team_name: getTeamName(team2_id), wins: team2Record[0], losses: team2Record[1] };
        
        const gameDocId = allScheduleData.find(g => g.date === gameDate && g.team1_id === team1_id && g.team2_id === team2_id)?.id;
        
        if (!gameDocId) {
            throw new Error("Could not find game document ID.");
        }

        const gameSnap = await getDoc(doc(db, collectionNames.seasons, ACTIVE_SEASON_ID, getLeagueCollectionName("games"), gameDocId));
        const winnerId = gameSnap.exists() ? gameSnap.data().winner : null;

        modalContentEl.innerHTML = `
            <div class="game-details-grid">
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

// NEW: Function to control postseason button visibility
function setPostseasonButtonVisibility(activeSeasonSnap) {
    const postseasonBtn = document.getElementById('postseason-profile-btn');
    if (!postseasonBtn) return;

    if (!activeSeasonSnap.empty) {
        const currentWeek = activeSeasonSnap.docs[0].data().current_week;
        const postseasonWeeks = ['Play-In', 'Round 1', 'Round 2', 'Conf Finals', 'Finals', 'Season Complete'];

        if (postseasonWeeks.includes(currentWeek)) {
            postseasonBtn.style.display = 'inline-block';
            // Set the link to the postseason team page using the current teamId
            postseasonBtn.href = `postseason-team.html?id=${teamId}`;
        }
    }
}

function getTeamName(id) {
    return allTeamsSeasonalRecords.get(id)?.team_name || id;
}

function getTeamRecordAtDate(teamIdForRecord, targetDate) {
    const normalizedTargetDate = normalizeDate(targetDate);
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

    return `${wins}-${losses}`;
}

function generateGameItemHTML(game) {
    const isTeam1 = game.team1_id === teamId;
    const opponentId = isTeam1 ? game.team2_id : game.team1_id;
    const isCompleted = game.completed === 'TRUE';
    
    const teamName = getTeamName(teamId);
    const opponentName = getTeamName(opponentId);
    
    const teamRecord = getTeamRecordAtDate(teamId, game.date);
    const opponentRecord = getTeamRecordAtDate(opponentId, game.date);

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
            <div class="week-cell"><div class="week-badge">${game.week || 'TBD'}</div></div>
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
            <div class="week-badge">${game.week || 'TBD'}</div>
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

/**
 * **MODIFIED FUNCTION**
 * Generates the HTML for a single draft pick item, including refined logic for
 * creating links to S8 or legacy S7 transaction pages.
 */
function generatePickItemHTML(pick) {
    const isOriginalOwner = pick.original_team === teamId;
    const isForfeiture = pick.notes && pick.notes.toUpperCase() === 'PENDING FORFEITURE';
    const originalTeamName = getTeamName(pick.original_team);
    const originalTeamRecord = allTeamsSeasonalRecords.get(pick.original_team);
    const originalTeamIdClassName = `icon-${pick.original_team.replace(/[^a-zA-Z0-9]/g, '')}`;

    let statusText = 'Acquired';
    let containerClass = 'pick-item-enhanced';
    if (isForfeiture) {
        statusText = 'Pending Forfeiture';
        containerClass += ' pick-forfeiture';
    } else if (isOriginalOwner) {
        statusText = `<span class="pick-status-own">Own Pick</span>`;
    }

    let originHTML = `<div class="pick-origin">Original Pick</div>`;

    if (!isOriginalOwner && !isForfeiture) {
        // Find S8 transaction first
        const transactionS8 = allTransactions.find(t => t.involved_picks?.some(p => p.id === pick.pick_id));

        if (transactionS8) {
            // S8 Logic with refined verbiage
            const pickMoveData = transactionS8.involved_picks.find(p => p.id === pick.pick_id);
            const fromTeamId = pickMoveData ? pickMoveData.from : null;
            const fromTeamData = fromTeamId ? transactionS8.involved_teams.find(t => t.id === fromTeamId) : null;
            
            let viaText = `from ${originalTeamName}`; // Default verbiage
            if (fromTeamData && fromTeamData.id !== pick.original_team) {
                viaText = `via ${fromTeamData.team_name} (from ${originalTeamName})`;
            }

            let statsText = '';
            if (originalTeamRecord) {
                statsText = `(${originalTeamRecord.wins}-${originalTeamRecord.losses}, ${Math.round(originalTeamRecord.pam)} PAM)`;
            }

            const transactionLink = `/S8/transactions.html?id=${transactionS8.id}`;
            originHTML = `<div class="pick-origin"><a href="${transactionLink}">${viaText} <span class="pick-origin-stats">${statsText}</span></a></div>`;
        
        } else {
            // No S8 transaction found, handle as Legacy (S7 or pre-S7)
            let statsText = '';
            if (originalTeamRecord) {
                 statsText = `(${originalTeamRecord.wins}-${originalTeamRecord.losses}, ${Math.round(originalTeamRecord.pam)} PAM)`;
            }
            
            // Check for a trade_id to determine if it's a linkable S7 trade or a non-linkable pre-S7 trade.
            if (pick.trade_id) {
                // Has a trade_id, so it's a linkable S7 trade. Add teamFilter to the URL.
                const legacyLink = `/S7/transactions.html?pick_id=${pick.pick_id}`;
                const verbiage = `from ${originalTeamName} <span class="pick-origin-stats">${statsText}</span>`;
                originHTML = `<div class="pick-origin"><a href="${legacyLink}">${verbiage}</a></div>`;
            } else {
                // No trade_id, so it's pre-S7. Display text without a link and with a modified class for styling.
                const verbiage = `from ${originalTeamName} <span class="pick-origin-stats unlinked">${statsText}</span>`;
                originHTML = `<div class="pick-origin">${verbiage}</div>`;
            }
        }
    }

    return `
        <div class="${containerClass}">
            <div class="pick-main-info">
                <a href="team.html?id=${pick.original_team}">
                    <div class="team-logo-css pick-team-logo ${originalTeamIdClassName}"></div>
                </a>
                <div class="pick-text-content">
                    <span class="pick-description">${pick.pick_description}</span>
                    ${originHTML}
                </div>
            </div>
            <div class="pick-status">${statusText}</div>
        </div>`;
}

function generateDraftSummaryHTML(total, own, acquired, forfeiture) {
    return `<div class="draft-summary">
        <div class="draft-summary-grid">
            <div><div class="draft-summary-value total">${total}</div><div class="draft-summary-label">Total Picks</div></div>
            <div><div class="draft-summary-value own">${own}</div><div class="draft-summary-label">Own Picks</div></div>
            <div><div class="draft-summary-value acquired">${acquired}</div><div class="draft-summary-label">Acquired</div></div>
            ${forfeiture > 0 ? `<div><div class="draft-summary-value forfeiture">${forfeiture}</div><div class="draft-summary-label">Forfeiture</div></div>` : ''}
        </div>
    </div>`;
}

function normalizeDate(dateInput) {
    if (!dateInput) return null;
    let date;
    if (typeof dateInput.toDate === 'function') {
        date = dateInput.toDate();
    } else {
        const parts = dateInput.split('/');
        if (parts.length === 3) {
            // Assuming M/D/YYYY format
            date = new Date(Date.UTC(parts[2], parts[0] - 1, parts[1]));
        } else {
            return null; // Invalid format
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

function getSeasonColor(season) {
    const colors = { 8: '#0d6efd', 9: '#198754', 10: '#ffc107', 11: '#dc3545', 12: '#6c757d' };
    return colors[season] || '#6c757d';
}


// --- GLOBAL EXPORTS & INITIALIZATION ---
window.handleRosterSort = handleRosterSort;
window.showGameDetails = showGameDetails;
document.addEventListener('DOMContentLoaded', init);
