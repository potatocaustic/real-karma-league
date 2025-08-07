import { db, getDoc, getDocs, collection, doc, query, where, orderBy, limit } from './firebase-init.js';

// --- CONFIGURATION ---
const USE_DEV_COLLECTIONS = true; // Set to false for production
const getCollectionName = (baseName) => USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;

// --- GLOBAL STATE ---
let activeSeasonId = '';
let allTeamsData = [];
let powerRankingsData = [];
let currentView = 'conferences'; // 'conferences', 'fullLeague', or 'powerRankings'

// --- DOM ELEMENTS ---
const viewToggleButton1 = document.getElementById('viewToggleButton1');
const viewToggleButton2 = document.getElementById('viewToggleButton2');
const conferenceViewContainer = document.getElementById('conferenceViewContainer');
const fullLeagueViewContainer = document.getElementById('fullLeagueViewContainer');
const powerRankingsViewContainer = document.getElementById('powerRankingsViewContainer');
const standingsPageTitle = document.getElementById('standingsPageTitle');
const pageDescription = document.getElementById('pageDescription');
const playoffLegend = document.querySelector('.playoff-legend');

// --- DATA FETCHING ---

/**
 * Finds the currently active season ID.
 */
async function getActiveSeason() {
    const seasonsQuery = query(collection(db, getCollectionName('seasons')), where('status', '==', 'active'), limit(1));
    const seasonsSnapshot = await getDocs(seasonsQuery);
    if (seasonsSnapshot.empty) throw new Error("No active season found.");
    activeSeasonId = seasonsSnapshot.docs[0].id;
}

/**
 * Fetches all teams and their corresponding seasonal records, merging them into one array.
 */
async function fetchAllTeamsAndRecords() {
    const teamsCollectionName = getCollectionName('v2_teams');
    const seasonalRecordsCollectionName = getCollectionName('seasonal_records');

    const teamsQuery = query(collection(db, teamsCollectionName), where('conference', 'in', ['Eastern', 'Western']));
    const teamsSnapshot = await getDocs(teamsQuery);

    const teamPromises = teamsSnapshot.docs.map(async (teamDoc) => {
        const teamData = { id: teamDoc.id, ...teamDoc.data() };
        const seasonalRecordRef = doc(db, teamsCollectionName, teamDoc.id, seasonalRecordsCollectionName, activeSeasonId);
        const seasonalRecordSnap = await getDoc(seasonalRecordRef);
        return seasonalRecordSnap.exists() ? { ...teamData, ...seasonalRecordSnap.data() } : null;
    });

    const teams = await Promise.all(teamPromises);
    allTeamsData = teams.filter(t => t !== null);
}

/**
 * Fetches the most recent power rankings document.
 * It assumes versions are named 'v0', 'v1', etc., and finds the highest one.
 */
async function fetchLatestPowerRankings() {
    // TODO: This logic currently hardcodes 'v0'. To make this dynamic,
    // you could store the name of the latest version (e.g., "v2") in the
    // parent 'season_8' document and fetch that value first.
    const latestVersionName = 'v0';
    const seasonDocName = `season_${activeSeasonId.replace('S', '')}`;

    const prCollectionRef = collection(db, getCollectionName('power_rankings'), seasonDocName, latestVersionName);
    const prSnapshot = await getDocs(prCollectionRef);

    if (prSnapshot.empty) {
        console.warn(`No power rankings documents found in ${seasonDocName}/${latestVersionName}.`);
        powerRankingsData = [];
        return;
    }
    
    // The snapshot now contains all the individual team documents from the latest version.
    const prDocsData = prSnapshot.docs.map(doc => doc.data());

    // Update header with dynamic version and week (assuming it's on one of the docs, or you could fetch the parent)
    // For now, we'll just make a generic title.
    const prHeader = document.querySelector('#powerRankingsViewContainer .conference-header h3');
    if (prHeader) {
        // This would need a more robust way to get version_name and week if it's not on team docs.
        prHeader.textContent = `Power Rankings`;
    }

    // Combine power ranking data with team records
    powerRankingsData = prDocsData
        .map(prTeam => {
            const teamRecord = allTeamsData.find(t => t.id === prTeam.team_id);
            return teamRecord ? { ...prTeam, ...teamRecord } : null;
        })
        .filter(t => t !== null)
        .sort((a, b) => (a.rank || 99) - (b.rank || 99));
}


// --- RENDERING LOGIC ---

/**
 * Renders the standings tables for conferences or the full league.
 */
function renderStandings() {
    const easternTeams = allTeamsData.filter(t => t.conference === 'Eastern').sort((a, b) => (a.postseed || 99) - (b.postseed || 99));
    const westernTeams = allTeamsData.filter(t => t.conference === 'Western').sort((a, b) => (a.postseed || 99) - (b.postseed || 99));
    const fullLeagueTeams = [...allTeamsData].sort((a, b) => (a.sortscore || 0) > (b.sortscore || 0) ? -1 : 1);

    document.getElementById('eastern-standings').innerHTML = generateStandingsRows(easternTeams);
    document.getElementById('western-standings').innerHTML = generateStandingsRows(westernTeams);
    document.getElementById('full-league-standings').innerHTML = generateStandingsRows(fullLeagueTeams, true);
}

function generateStandingsRows(teams, isFullLeague = false) {
    if (!teams || teams.length === 0) return '<tr><td colspan="5">No teams to display.</td></tr>';
    return teams.map((team, index) => {
        const rank = isFullLeague ? index + 1 : team.postseed;
        const clinchBadge = getClinchBadge(team);
        return `
            <tr class="${team.elim === 1 ? 'eliminated' : ''}">
                <td class="rank-cell">${getPlayoffIndicator(rank)}</td>
                <td>
                    <div class="team-cell" onclick="window.location.href='team.html?id=${team.id}'">
                        <img src="../icons/${team.id}.webp" alt="${team.team_name}" class="team-logo" onerror="this.style.display='none'">
                        <span class="team-name">${team.team_name}</span>
                        ${clinchBadge}
                    </div>
                </td>
                <td class="record-cell">${team.wins || 0}-${team.losses || 0}</td>
                <td class="pam-cell ${getPAMClass(team.pam)}">${Math.round(team.pam || 0).toLocaleString()}</td>
                <td class="rank-cell">${Math.round(team.med_starter_rank) || '-'}</td>
            </tr>`;
    }).join('');
}

/**
 * Renders the power rankings table.
 */
function renderPowerRankings() {
    const tableBody = document.getElementById('power-rankings-standings');
    if (!powerRankingsData || powerRankingsData.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="5" class="loading">No power rankings available.</td></tr>';
        return;
    }
    tableBody.innerHTML = powerRankingsData.map(team => {
        const clinchBadge = getClinchBadge(team);
        return `
            <tr>
                <td class="rank-cell">${getRankDisplay(team.rank)}</td>
                <td>
                    <div class="team-cell" onclick="window.location.href='team.html?id=${team.id}'">
                        <img src="../icons/${team.id}.webp" alt="${team.team_name}" class="team-logo" onerror="this.style.display='none'">
                        <span class="team-name">${team.team_name}</span>
                        ${clinchBadge}
                    </div>
                </td>
                <td class="record-cell">${team.wins || 0}-${team.losses || 0}</td>
                <td class="rank-cell prev-rank-col">${team.previous_rank || '–'}</td>
                <td class="record-cell">${getChangeIndicator(team.change)}</td>
            </tr>`;
    }).join('');
    
    renderPowerRankingsSummary();
}

function renderPowerRankingsSummary() {
    const summaryContainer = document.getElementById('powerRankingsSummary');
    if (!summaryContainer || !powerRankingsData || powerRankingsData.length === 0) return;

    const biggestRiser = powerRankingsData.reduce((prev, curr) => ((curr.change || 0) > (prev.change || 0) ? curr : prev), { change: -Infinity });
    const biggestFaller = powerRankingsData.reduce((prev, curr) => ((curr.change || 0) < (prev.change || 0) ? curr : prev), { change: Infinity });

    let summaryHTML = '';
    if (biggestRiser.change > 0) {
        summaryHTML += `
            <div class="summary-item">
                <span>Biggest Riser: 
                    <strong class="pam-positive"><a href="team.html?id=${biggestRiser.id}" class="summary-team-link">${biggestRiser.team_name}</a></strong> (+${biggestRiser.change}) 📈
                </span>
            </div>`;
    }
    if (biggestFaller.change < 0) {
        summaryHTML += `
            <div class="summary-item">
                <span>Biggest Faller: 
                    <strong class="pam-negative"><a href="team.html?id=${biggestFaller.id}" class="summary-team-link">${biggestFaller.team_name}</a></strong> (${biggestFaller.change}) 📉
                </span>
            </div>`;
    }
    summaryContainer.innerHTML = summaryHTML || 'No major changes this period.';
}


// --- UI LOGIC & HELPERS ---

function switchView(view) {
    currentView = view;
    const isConference = view === 'conferences';
    const isFullLeague = view === 'fullLeague';
    const isPowerRankings = view === 'powerRankings';

    conferenceViewContainer.classList.toggle('hidden', !isConference);
    fullLeagueViewContainer.classList.toggle('hidden', !isFullLeague);
    powerRankingsViewContainer.classList.toggle('hidden', !isPowerRankings);
    playoffLegend.classList.toggle('hidden', !isConference);

    if (isConference) {
        standingsPageTitle.textContent = 'Conference Standings';
        pageDescription.textContent = 'Teams sorted by playoff seeding.';
        viewToggleButton1.textContent = 'Show Full League';
        viewToggleButton2.textContent = 'Show Power Rankings';
    } else if (isFullLeague) {
        standingsPageTitle.textContent = 'Full League Standings';
        pageDescription.textContent = 'All teams sorted by overall record and point differential.';
        viewToggleButton1.textContent = 'Show Conferences';
        viewToggleButton2.textContent = 'Show Power Rankings';
    } else if (isPowerRankings) {
        standingsPageTitle.textContent = 'Power Rankings';
        pageDescription.textContent = 'Subjective rankings based on team performance and outlook.';
        viewToggleButton1.textContent = 'Show Conferences';
        viewToggleButton2.textContent = 'Show Full League';
    }
}

function getClinchBadge(team) {
    if (team.playoffs === 1) return '<span class="clinch-badge clinch-playoff">x</span>';
    if (team.playin === 1) return '<span class="clinch-badge clinch-playin">p</span>';
    if (team.elim === 1) return '<span class="clinch-badge clinch-eliminated">e</span>';
    return '';
}

function getPlayoffIndicator(rank) {
    if (!rank || rank <= 0) return '-';
    if (rank <= 6) return `<div class="playoff-seed">${rank}</div>`;
    if (rank <= 10) return `<div class="playin-seed">${rank}</div>`;
    return `<div class="eliminated-seed">${rank}</div>`;
}

function getPAMClass(pam) {
    if (pam > 0) return 'pam-positive';
    if (pam < 0) return 'pam-negative';
    return '';
}

function getChangeIndicator(change) {
    const delta = parseInt(change);
    if (isNaN(delta) || delta === 0) return `<span>–</span>`;
    if (delta > 0) return `<span class="pam-positive">▲ ${delta}</span>`;
    return `<span class="pam-negative">▼ ${Math.abs(delta)}</span>`;
}

function getRankDisplay(rank) {
    if (rank === 1) return `<span class="rank-badge gold-badge">1</span>`;
    if (rank === 2) return `<span class="rank-badge silver-badge">2</span>`;
    if (rank === 3) return `<span class="rank-badge bronze-badge">3</span>`;
    return rank;
}

// --- INITIALIZATION ---

async function initializePage() {
    try {
        await getActiveSeason();
        await fetchAllTeamsAndRecords();
        await fetchLatestPowerRankings();

        renderStandings();
        renderPowerRankings();

        // Set up button listeners
        viewToggleButton1.addEventListener('click', () => {
            const targetView = currentView === 'conferences' ? 'fullLeague' : 'conferences';
            switchView(targetView);
        });
        viewToggleButton2.addEventListener('click', () => {
            const targetView = currentView === 'powerRankings' ? 'conferences' : 'powerRankings';
            switchView(targetView);
        });
        
        // Default to conference view
        switchView('conferences');

    } catch (error) {
        console.error("Failed to initialize standings page:", error);
        document.querySelector('main').innerHTML = `<div class="error">Could not load standings data. Please try again later.</div>`;
    }
}

document.addEventListener('DOMContentLoaded', initializePage);
