// /js/draft-lottery.js

import './main.js'; // Import main.js to run it first
import { db, collection, getDocs, doc, getDoc, query, where, collectionNames, getLeagueCollectionName, getConferenceNames, getCurrentLeague } from './firebase-init.js';

// Get season from path (/S8/ or /S9/), URL parameter, or default to S9
const urlParams = new URLSearchParams(window.location.search);
const pathMatch =  window.location.pathname.match(/\/S(\d+)\//);
const seasonFromPath = pathMatch ? `S${pathMatch[1]}` : null;
const urlSeasonId = seasonFromPath || urlParams.get('season');

// --- DATA AND CONFIGURATION ---
const PREVIOUS_SEASON_ID = urlSeasonId;
// Calculate the next season for draft (e.g., 'S9' -> 'S10')
const seasonNumber = parseInt(PREVIOUS_SEASON_ID.substring(1));
const DRAFT_SEASON_ID = `S${seasonNumber + 1}`;

const lotteryOdds = [
    { seed: 1, chances: 140, pct1st: 14.0, pctTop4: 52.14 }, { seed: 2, chances: 140, pct1st: 14.0, pctTop4: 52.14 },
    { seed: 3, chances: 140, pct1st: 14.0, pctTop4: 52.14 }, { seed: 4, chances: 125, pct1st: 12.5, pctTop4: 48.08 },
    { seed: 5, chances: 105, pct1st: 10.5, pctTop4: 42.13 }, { seed: 6, chances: 90, pct1st: 9.0, pctTop4: 37.23 },
    { seed: 7, chances: 75, pct1st: 7.5, pctTop4: 31.96 }, { seed: 8, chances: 60, pct1st: 6.0, pctTop4: 26.30 },
    { seed: 9, chances: 45, pct1st: 4.5, pctTop4: 20.27 }, { seed: 10, chances: 30, pct1st: 3.0, pctTop4: 13.88 },
    { seed: 11, chances: 20, pct1st: 2.0, pctTop4: 9.41 }, { seed: 12, chances: 15, pct1st: 1.5, pctTop4: 7.12 },
    { seed: 13, chances: 10, pct1st: 1.0, pctTop4: 4.79 }, { seed: 14, chances: 5, pct1st: 0.5, pctTop4: 2.41 },
];

// --- STATE MANAGEMENT ---
let initialLotteryTeams = [];
let teamDataMap = {};
let pickOwnership = {};
let finalLotteryResults = null;

// --- RENDERING FUNCTIONS ---
function renderTableHeader(isSimulatedView = false) {
    const pickOrSeed = isSimulatedView ? 'Pick' : 'Seed';
    document.getElementById('lottery-table-head').innerHTML = `
        <tr>
            <th scope="col">${pickOrSeed}</th>
            <th scope="col">Team</th>
            <th scope="col" class="text-center hidden-mobile">Record</th>
            <th scope="col" class="text-center">#1 Pick Odds</th>
            <th scope="col" class="text-center hidden-mobile">Top 4 Odds</th>
        </tr>
    `;
}

function getTeamCellHtml(ownerTeam, originalTeam, ownerId, isTraded) {
    const teamName = ownerTeam ? ownerTeam.team_name : 'Unknown';
    const originalTeamName = originalTeam ? originalTeam.team_name : 'Unknown';
    const teamLogoUrl = ownerId ? `../icons/${ownerId}.webp` : '';

    if (isTraded) {
        return `
            <a href="team.html?id=${ownerId}" class="team-cell">
                <img src="${teamLogoUrl}" alt="${teamName}" class="team-logo" onerror="this.style.display='none'">
                <div class="team-cell-content">
                    <span class="font-semibold">${teamName}</span>
                    <span class="original-team-traded">${originalTeamName}</span>
                </div>
            </a>
        `;
    } else {
        return `
            <a href="team.html?id=${ownerId}" class="team-cell">
                <img src="${teamLogoUrl}" alt="${teamName}" class="team-logo" onerror="this.style.display='none'">
                <span class="font-semibold whitespace-nowrap">${teamName}</span>
            </a>
        `;
    }
}

function renderLotteryOddsTable() {
    renderTableHeader(false);
    const tableBody = document.getElementById('lottery-table-body');
    let html = '';

    initialLotteryTeams.forEach(team => {
        const ownerId = pickOwnership[team.team_id] || team.team_id;
        const ownerTeam = teamDataMap[ownerId];
        const isTraded = team.team_id !== ownerId;
        const teamCellHtml = getTeamCellHtml(ownerTeam, team, ownerId, isTraded);

        html += `
            <tr>
                <td class="font-semibold">${team.seed}</td>
                <td>${teamCellHtml}</td>
                <td class="text-center hidden-mobile">${team.wins} - ${team.losses}</td>
                <td class="text-center">${team.pct1st.toFixed(2)}%</td>
                <td class="text-center hidden-mobile">${team.pctTop4.toFixed(2)}%</td>
            </tr>
        `;
    });
    tableBody.innerHTML = html;
}

function renderSimulatedResults(finalOrder) {
    renderTableHeader(true);
    const tableBody = document.getElementById('lottery-table-body');
    let html = '';

    finalOrder.forEach((originalTeam, index) => {
        if (!originalTeam) return; // Safeguard for missing team data
        const pickNumber = index + 1;
        const ownerId = pickOwnership[originalTeam.team_id] || originalTeam.team_id;
        const ownerTeam = teamDataMap[ownerId];
        const isTraded = originalTeam.team_id !== ownerId;
        const movement = originalTeam.seed - pickNumber;

        let movementHtml;
        if (movement > 0) {
            movementHtml = `<span class="move-up">▲ ${movement}</span>`;
        } else if (movement < 0) {
            movementHtml = `<span class="move-down">▼ ${Math.abs(movement)}</span>`;
        } else {
            movementHtml = ``;
        }

        const teamCellHtml = getTeamCellHtml(ownerTeam, originalTeam, ownerId, isTraded);

        html += `
            <tr class="fade-in" style="animation-delay: ${index * 50}ms;">
                <td class="font-semibold">
                    <div style="display: flex; align-items: center; white-space: nowrap;">
                        <span>${pickNumber}</span>
                        ${movementHtml}
                    </div>
                </td>
                <td>${teamCellHtml}</td>
                <td class="text-center hidden-mobile">${originalTeam.wins} - ${originalTeam.losses}</td>
                <td class="text-center">${originalTeam.pct1st.toFixed(2)}%</td>
                <td class="text-center hidden-mobile">${originalTeam.pctTop4.toFixed(2)}%</td>
            </tr>
        `;
    });
    tableBody.innerHTML = html;
}


// --- SIMULATION LOGIC ---
function runSimulation() {
    const combinations = [];
    initialLotteryTeams.forEach(team => {
        for (let i = 0; i < team.chances; i++) {
            combinations.push(team.seed);
        }
    });

    const top4WinningSeeds = [];
    while (top4WinningSeeds.length < 4) {
        const randomIndex = Math.floor(Math.random() * combinations.length);
        const winningSeed = combinations[randomIndex];
        if (!top4WinningSeeds.includes(winningSeed)) {
            top4WinningSeeds.push(winningSeed);
        }
    }

    const lotteryWinners = top4WinningSeeds.map(seed => initialLotteryTeams.find(t => t.seed === seed));
    const remainingTeams = initialLotteryTeams
        .filter(team => !top4WinningSeeds.includes(team.seed))
        .sort((a, b) => a.seed - b.seed);

    const finalOrder = [...lotteryWinners, ...remainingTeams];
    renderSimulatedResults(finalOrder);
}

// --- UI AND EVENT HANDLING ---
const buttonContainer = document.getElementById('button-container');

function renderInitialButtons() {
    buttonContainer.innerHTML = `<button id="simulateBtn" class="action-button">Simulate Lottery</button>`;
}

function renderSimulatedButtons() {
    buttonContainer.innerHTML = `
        <button id="simulateAgainBtn" class="action-button">Simulate Again</button>
        <button id="resetBtn" class="action-button">Reset</button>
    `;
}

function resetView() {
    document.getElementById('table-title').textContent = `${DRAFT_SEASON_ID} Lottery Odds`;
    document.getElementById('table-description').textContent = `${DRAFT_SEASON_ID} lottery odds for the 14 non-playoff teams.`;
    renderLotteryOddsTable();
    renderInitialButtons();
}

function handleFirstSimulation() {
    document.getElementById('table-title').textContent = 'Lottery Simulation';
    document.getElementById('table-description').textContent = 'Projected draft order based on the simulation.';
    runSimulation();
    renderSimulatedButtons();
}

function setupButtonListeners() {
    buttonContainer.addEventListener('click', (event) => {
        const button = event.target.closest('button');
        if (!button) return;

        if (button.id === 'simulateBtn') handleFirstSimulation();
        else if (button.id === 'simulateAgainBtn') runSimulation();
        else if (button.id === 'resetBtn') resetView();
    });
}

// --- INITIALIZATION ---
async function initializeApp() {
    const tableBody = document.getElementById('lottery-table-body');
    tableBody.innerHTML = `<tr><td colspan="5"><div class="loading">Loading Team Data...</div></td></tr>`;
    renderTableHeader();
    renderInitialButtons();
    document.getElementById('simulateBtn').disabled = true;

    // Update titles
    document.getElementById('table-title').textContent = `${DRAFT_SEASON_ID} Lottery Odds`;
    document.getElementById('table-description').textContent = `${DRAFT_SEASON_ID} lottery odds for the 14 non-playoff teams.`;

    try {
        // 1. Fetch official lottery results first
        const lotteryResultsRef = doc(db, getLeagueCollectionName('lottery_results'), `${DRAFT_SEASON_ID}_lottery_results`);
        const lotteryResultsSnap = await getDoc(lotteryResultsRef);
        if (lotteryResultsSnap.exists()) {
            finalLotteryResults = lotteryResultsSnap.data().final_order || null;
        }

        // 2. Fetch all necessary data in parallel
        const conferences = getConferenceNames();
        const teamsQuery = query(collection(db, collectionNames.teams), where('conference', 'in', [conferences.primary, conferences.secondary]));

        // Query for draft picks - major league uses strings, minor league uses numbers
        const currentLeague = getCurrentLeague();
        const seasonValue = currentLeague === 'minor' ? parseInt(DRAFT_SEASON_ID.replace('S','')) : DRAFT_SEASON_ID.replace('S','');
        const roundValue = currentLeague === 'minor' ? 1 : '1';
        const draftPicksQuery = query(
            collection(db, collectionNames.draftPicks),
            where('season', '==', seasonValue),
            where('round', '==', roundValue)
        );

        const postGamesQuery = collection(db, collectionNames.seasons, PREVIOUS_SEASON_ID, 'post_games');

        const [teamsSnap, draftPicksSnap, postseasonGamesSnap] = await Promise.all([
            getDocs(teamsQuery),
            getDocs(draftPicksQuery),
            getDocs(postGamesQuery)
        ]);

        // 3. Process Draft Picks
        draftPicksSnap.forEach(doc => {
            const pick = doc.data();
            pickOwnership[pick.original_team] = pick.current_owner;
        });

        // 4. Process all team records
        const teamRecordsPromises = teamsSnap.docs.map(async (teamDoc) => {
            const teamId = teamDoc.id;
            const teamBaseData = teamDoc.data();
            const recordRef = doc(db, collectionNames.teams, teamId, collectionNames.seasonalRecords, PREVIOUS_SEASON_ID);
            const recordSnap = await getDoc(recordRef);
            if (recordSnap.exists()) {
                return { team_id: teamId, ...teamBaseData, ...recordSnap.data() };
            }
            return null; // Should not happen for conference teams
        });

        const allTeamsWithRecords = (await Promise.all(teamRecordsPromises)).filter(Boolean);
        teamDataMap = allTeamsWithRecords.reduce((acc, team) => {
            acc[team.team_id] = team;
            return acc;
        }, {});

        // 5. Determine Playoff and Lottery Teams
        const postGames = postseasonGamesSnap.docs.map(doc => doc.data());
        const playoffTeamIds = new Set();
        
        // Add top 6 seeds from each conference
        allTeamsWithRecords.forEach(team => {
            if (team.postseed >= 1 && team.postseed <= 6) {
                playoffTeamIds.add(team.team_id);
            }
        });

        // Determine play-in winners
        const findGameWinner = (seriesId) => postGames.find(g => g.series_id === seriesId)?.winner || null;
        const playInWinners = ['E7vE8', 'W7vW8', 'E8thSeedGame', 'W8thSeedGame'].map(findGameWinner).filter(Boolean);
        playInWinners.forEach(id => playoffTeamIds.add(id));

        // Determine play-in losers for lottery
        const findGameLoser = (seriesId) => {
            const game = postGames.find(g => g.series_id === seriesId);
            if (!game || !game.winner) return null;
            return game.team1_id === game.winner ? game.team2_id : game.team1_id;
        };
        const lotteryLoserIds = new Set(['E9vE10', 'W9vE10', 'E8thSeedGame', 'W8thSeedGame'].map(findGameLoser).filter(Boolean));

        // 6. Finalize Lottery Team List
        const lotteryTeamsFromStandings = allTeamsWithRecords
            .filter(team => !playoffTeamIds.has(team.team_id) && !lotteryLoserIds.has(team.team_id))
            .sort((a, b) => (a.sortscore || 0) - (b.sortscore || 0));
        
        const lotteryLoserTeams = Array.from(lotteryLoserIds).map(id => allTeamsWithRecords.find(t => t.team_id === id));
        
        const combinedLotteryPool = [...lotteryLoserTeams, ...lotteryTeamsFromStandings];
        const sortedLotteryPool = combinedLotteryPool
                                    .sort((a,b) => (a.sortscore || 0) - (b.sortscore || 0))
                                    .slice(0, 14);

        initialLotteryTeams = sortedLotteryPool.map((team, index) => ({
            ...team,
            seed: index + 1,
            ...lotteryOdds[index]
        }));

        // 7. Render final view
        if (finalLotteryResults) {
            document.getElementById('table-title').textContent = `Official ${DRAFT_SEASON_ID} Lottery Results`;
            document.getElementById('table-description').textContent = `The official results of the Season ${seasonNumber + 1} Draft Lottery.`;
            const finalOrder = finalLotteryResults.map(teamId => initialLotteryTeams.find(t => t.team_id === teamId));
            renderSimulatedResults(finalOrder);
            buttonContainer.innerHTML = ''; // No buttons for official results
        } else {
            renderLotteryOddsTable();
            document.getElementById('simulateBtn').disabled = false;
            setupButtonListeners();
        }

    } catch (error) {
        console.error("Error initializing lottery page:", error);
        tableBody.innerHTML = `<tr><td colspan="5"><div class="error">Failed to load lottery data. Please check the console and try again later.</div></td></tr>`;
    }
}

initializeApp();
