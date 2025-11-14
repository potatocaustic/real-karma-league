import { db, getDoc, getDocs, collection, doc, query, where, orderBy, limit, collectionGroup, collectionNames, getLeagueCollectionName } from './firebase-init.js';

// --- GLOBAL STATE ---
let activeSeasonId = '';
let allTeamsData = [];
let allPowerRankingsData = {}; // Key: "v1", Value: [team, team, ...]
let latestPRVersion = null;
let currentView = 'conferences'; // 'conferences', 'fullLeague', or 'powerRankings'

const sortState = {
    Eastern: { column: 'postseed', direction: 'asc' },
    Western: { column: 'postseed', direction: 'asc' },
    FullLeague: { column: 'sortscore', direction: 'desc' }
};

// --- DOM ELEMENTS ---
const viewToggleButton1 = document.getElementById('viewToggleButton1');
const viewToggleButton2 = document.getElementById('viewToggleButton2');
const conferenceViewContainer = document.getElementById('conferenceViewContainer');
const fullLeagueViewContainer = document.getElementById('fullLeagueViewContainer');
const powerRankingsViewContainer = document.getElementById('powerRankingsViewContainer');
const standingsPageTitle = document.getElementById('standingsPageTitle');
const pageDescription = document.getElementById('pageDescription');
const playoffLegend = document.querySelector('.playoff-legend');
const playoffBracketBtn = document.querySelector('button[onclick*="playoff-bracket.html"]');
const prVersionSelect = document.getElementById('pr-version-select');


// --- DATA FETCHING ---

async function getActiveSeason() {
    const seasonsQuery = query(collection(db, collectionNames.seasons), where('status', '==', 'active'), limit(1));
    const seasonsSnapshot = await getDocs(seasonsQuery);
    if (seasonsSnapshot.empty) throw new Error("No active season found.");
    const seasonDoc = seasonsSnapshot.docs[0];
    activeSeasonId = seasonDoc.id;
    return seasonDoc.data();
}

async function fetchAllTeamsAndRecords() {
    const teamsQuery = query(collection(db, collectionNames.teams), where('conference', 'in', ['Eastern', 'Western']));
    const recordsQuery = query(collectionGroup(db, collectionNames.seasonalRecords));

    const [teamsSnapshot, recordsSnapshot] = await Promise.all([
        getDocs(teamsQuery),
        getDocs(recordsQuery)
    ]);

    const seasonalRecordsMap = new Map();
    recordsSnapshot.forEach(doc => {
        // Client-side filtering by season ID
        if (doc.id === activeSeasonId) {
            const teamId = doc.ref.parent.parent.id;
            seasonalRecordsMap.set(teamId, doc.data());
        }
    });

    const teams = teamsSnapshot.docs.map(teamDoc => {
        const teamData = { id: teamDoc.id, ...teamDoc.data() };
        const seasonalRecord = seasonalRecordsMap.get(teamDoc.id);
        return seasonalRecord ? { ...teamData, ...seasonalRecord } : null;
    });

    allTeamsData = teams.filter(t => t !== null);
}

async function fetchAllPowerRankings() {
    const seasonDocName = `season_${activeSeasonId.replace('S', '')}`;
    const seasonDocRef = doc(db, getLeagueCollectionName('power_rankings'), seasonDocName);
    const seasonDocSnap = await getDoc(seasonDocRef);

    if (!seasonDocSnap.exists() || !seasonDocSnap.data().latest_version) {
        console.warn(`No 'latest_version' field found for ${seasonDocName}.`);
        return;
    }

    latestPRVersion = seasonDocSnap.data().latest_version;
    const latestVersionNumber = parseInt(latestPRVersion.replace('v', ''), 10);

    if (isNaN(latestVersionNumber)) return;

    const fetchPromises = [];
    for (let i = 0; i <= latestVersionNumber; i++) {
        const versionString = `v${i}`;
        const prCollectionRef = collection(db, getLeagueCollectionName('power_rankings'), seasonDocName, versionString);
        fetchPromises.push(getDocs(prCollectionRef));
    }

    const allSnapshots = await Promise.all(fetchPromises);

    allSnapshots.forEach((snapshot, index) => {
        if (!snapshot.empty) {
            const versionString = `v${index}`;
            const prDocsData = snapshot.docs.map(doc => doc.data());
            
            const combinedData = prDocsData
                .map(prTeam => {
                    const teamRecord = allTeamsData.find(t => t.id === prTeam.team_id);
                    return teamRecord ? { ...prTeam, ...teamRecord } : null;
                })
                .filter(t => t !== null)
                .sort((a, b) => (a.rank || 99) - (b.rank || 99));
            
            allPowerRankingsData[versionString] = combinedData;
        }
    });
}


// --- RENDERING LOGIC ---

function renderStandings() {
    const sortFunction = (tableType) => (a, b) => {
        const { column, direction } = sortState[tableType];
        const asc = direction === 'asc';
        let valA, valB;

        switch (column) {
            case 'record':
                valA = (a.wins || 0) / ((a.wins || 0) + (a.losses || 0) || 1);
                valB = (b.wins || 0) / ((b.wins || 0) + (b.losses || 0) || 1);
                if (valA === valB) return (b.pam || 0) - (a.pam || 0);
                break;
            case 'pam':
                valA = a.pam || 0;
                valB = b.pam || 0;
                break;
            case 'med_starter_rank':
                valA = a.med_starter_rank || 99;
                valB = b.med_starter_rank || 99;
                break;
            case 'postseed':
                valA = a.postseed || 99;
                valB = b.postseed || 99;
                break;
            case 'sortscore':
                valA = a.sortscore || 0;
                valB = b.sortscore || 0;
                break;
            default:
                return 0;
        }
        return asc ? valA - valB : valB - valA;
    };

    const easternTeams = allTeamsData.filter(t => t.conference === 'Eastern').sort(sortFunction('Eastern'));
    const westernTeams = allTeamsData.filter(t => t.conference === 'Western').sort(sortFunction('Western'));
    const fullLeagueTeams = [...allTeamsData].sort(sortFunction('FullLeague'));

    document.getElementById('eastern-standings').innerHTML = generateStandingsRows(easternTeams);
    document.getElementById('western-standings').innerHTML = generateStandingsRows(westernTeams);
    document.getElementById('full-league-standings').innerHTML = generateStandingsRows(fullLeagueTeams, true);

    updateSortIndicators();
}

function generateStandingsRows(teams, isFullLeague = false) {
    if (!teams || teams.length === 0) return '<tr><td colspan="5">No teams to display.</td></tr>';
    return teams.map((team, index) => {
        const rank = isFullLeague ? index + 1 : team.postseed;
        // NEW: Conditionally display colored badges or the plain rank number
        const rankDisplay = isFullLeague ? rank : getPlayoffIndicator(rank);
        const clinchBadge = getClinchBadge(team);
        return `
            <tr class="${team.elim === 1 ? 'eliminated' : ''}">
                <td class="rank-cell">${rankDisplay}</td>
                <td>
                    <div class="team-cell" onclick="window.location.href='team.html?id=${team.id}'">
                        <img src="../icons/${team.id}.webp" alt="${team.team_name}" class="team-logo" onerror="this.style.display='none'" loading="lazy">
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

function renderPowerRankings(version) {
    const tableBody = document.getElementById('power-rankings-standings');
    const versionData = allPowerRankingsData[version];

    if (!versionData || versionData.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="5" class="loading">No power rankings available for this version.</td></tr>';
        document.getElementById('powerRankingsSummary').innerHTML = '';
        return;
    }

    const versionNumber = parseInt(version.replace('v', ''), 10);
    const label = versionNumber === 0 ? 'v0 (Preseason)' : `v${versionNumber} (After Week ${versionNumber * 3})`;
    const prHeader = document.querySelector('#powerRankingsViewContainer .conference-header h3');
    if (prHeader) {
        prHeader.textContent = `Power Rankings: ${label}`;
    }

    tableBody.innerHTML = versionData.map(team => {
        const clinchBadge = getClinchBadge(team);
        return `
            <tr>
                <td class="rank-cell">${getRankDisplay(team.rank)}</td>
                <td>
                    <div class="team-cell" onclick="window.location.href='team.html?id=${team.id}'">
                        <img src="../icons/${team.id}.webp" alt="${team.team_name}" class="team-logo" onerror="this.style.display='none'" loading="lazy">
                        <span class="team-name">${team.team_name}</span>
                        ${clinchBadge}
                    </div>
                </td>
                <td class="record-cell">${team.power_wins || 0}-${team.power_losses || 0}</td>
                <td class="rank-cell prev-rank-col">${team.previous_rank || '–'}</td>
                <td class="record-cell">${getChangeIndicator(team.change)}</td>
            </tr>`;
    }).join('');
    
    renderPowerRankingsSummary(versionData);
}

function renderPowerRankingsSummary(versionData) {
    const summaryContainer = document.getElementById('powerRankingsSummary');
    if (!summaryContainer || !versionData || versionData.length === 0) {
        summaryContainer.innerHTML = '';
        return;
    }

    const biggestRiser = versionData.reduce((prev, curr) => ((curr.change || 0) > (prev.change || 0) ? curr : prev), { change: -Infinity });
    const biggestFaller = versionData.reduce((prev, curr) => ((curr.change || 0) < (prev.change || 0) ? curr : prev), { change: Infinity });

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

/**
 * Checks if a given week string represents a postseason round.
 * @param {string} weekString The week value from a season or game document.
 * @returns {boolean} True if it's a postseason week.
 */
function isPostseasonWeek(weekString) {
    if (!weekString) return false;
    return isNaN(parseInt(weekString, 10));
}

function handleSort(tableType, column) {
    const currentSort = sortState[tableType];
    let newDirection;

    if (currentSort.column === column) {
        newDirection = currentSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
        newDirection = (column === 'med_starter_rank' || column === 'postseed') ? 'asc' : 'desc';
    }
    sortState[tableType] = { column, direction: newDirection };
    renderStandings();
}
window.handleSort = handleSort;

function updateSortIndicators() {
    ['Eastern', 'Western', 'FullLeague'].forEach(tableType => {
        let tableId;
        if (tableType === 'Eastern') tableId = 'eastern-standings';
        else if (tableType === 'Western') tableId = 'western-standings';
        else tableId = 'full-league-standings';

        const table = document.getElementById(tableId)?.closest('table');
        if (!table) return;

        table.querySelectorAll('thead th[data-sort-column]').forEach(th => {
            const column = th.dataset.sortColumn;
            const indicator = th.querySelector('.sort-indicator');
            if (indicator) {
                if (sortState[tableType].column === column) {
                    indicator.textContent = sortState[tableType].direction === 'asc' ? '▲' : '▼';
                } else {
                    indicator.textContent = '';
                }
            }
        });
    });
}

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
        pageDescription.textContent = 'Teams sorted by playoff seeding. Click headers to sort.';
        viewToggleButton1.textContent = 'Show Full League';
        viewToggleButton2.textContent = 'Show Power Rankings';
    } else if (isFullLeague) {
        standingsPageTitle.textContent = 'Full League Standings';
        pageDescription.textContent = 'All teams sorted by overall record and point differential. Click headers to sort.';
        viewToggleButton1.textContent = 'Show Conferences';
        viewToggleButton2.textContent = 'Show Power Rankings';
    } else if (isPowerRankings) {
        standingsPageTitle.textContent = 'Power Rankings';
        pageDescription.textContent = 'Subjective rankings based on team performance and outlook, made by a committee of volunteers.';
        viewToggleButton1.textContent = 'Show Conferences';
        viewToggleButton2.textContent = 'Show Full League';
    }
}

function setupPowerRankingsSelector() {
    const versions = Object.keys(allPowerRankingsData).sort((a, b) => {
        return parseInt(a.replace('v', '')) - parseInt(b.replace('v', ''));
    });

    if (versions.length <= 1) {
        prVersionSelect.parentElement.style.display = 'none';
        return;
    }

    prVersionSelect.parentElement.style.display = 'block';
    prVersionSelect.innerHTML = versions.map(v => {
        const versionNumber = parseInt(v.replace('v', ''), 10);
        const label = versionNumber === 0 ? 'v0 (Preseason)' : `v${versionNumber} (After Week ${versionNumber * 3})`;
        return `<option value="${v}">${label}</option>`;
    }).join('');

    prVersionSelect.value = latestPRVersion;

    prVersionSelect.addEventListener('change', () => {
        renderPowerRankings(prVersionSelect.value);
    });
}

function getClinchBadge(team) {
    if (team.playoffs === 1 || team.playoffs === "1") return '<span class="clinch-badge clinch-playoff">x</span>';
    if (team.playin === 1 || team.playin === "1") return '<span class="clinch-badge clinch-playin">p</span>';
    if (team.elim === 1 || team.elim === "1") return '<span class="clinch-badge clinch-eliminated">e</span>';
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
        const urlParams = new URLSearchParams(window.location.search);
        const viewParam = urlParams.get('view');

        const seasonData = await getActiveSeason();
        await fetchAllTeamsAndRecords();
        await fetchAllPowerRankings();

        renderStandings();
        setupPowerRankingsSelector();
        renderPowerRankings(latestPRVersion);
        
        if (playoffBracketBtn) {
            const isPostseason = isPostseasonWeek(seasonData.current_week);
            playoffBracketBtn.style.display = isPostseason ? 'inline-block' : 'none';
        }

        viewToggleButton1.addEventListener('click', () => {
            let targetView;
            if (currentView === 'conferences') {
                targetView = 'fullLeague';
            } else { 
                targetView = 'conferences';
            }
            switchView(targetView);
        });

        viewToggleButton2.addEventListener('click', () => {
            let targetView;
            if (currentView === 'powerRankings') {
                targetView = 'fullLeague';
            } else { 
                targetView = 'powerRankings';
            }
            switchView(targetView);
        });
        
        if (viewParam === 'powerRankings') {
            switchView('powerRankings');
        } else if (viewParam === 'fullLeague') {
            switchView('fullLeague');
        } else {
            switchView('conferences');
        }

    } catch (error) {
        console.error("Failed to initialize standings page:", error);
        document.querySelector('main').innerHTML = `<div class="error">Could not load standings data. Please try again later.</div>`;
    }
}

document.addEventListener('DOMContentLoaded', initializePage);

// Reload standings when league changes
window.addEventListener('leagueChanged', (event) => {
    const newLeague = event.detail.league;
    console.log('League changed to:', newLeague);
    initializePage();
});
