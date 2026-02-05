// /js/players.js
// Players search page for the active season

import { getSeasonIdFromPage } from './season-utils.js';
import {
    db,
    collection,
    getDocs,
    getDoc,
    doc,
    query,
    orderBy,
    startAt,
    endAt,
    limit,
    collectionNames,
    getCurrentLeague
} from '/js/firebase-init.js';

// --- Page Elements ---
const searchInput = document.getElementById('player-search-input');
const playersContainer = document.getElementById('players-container');

// --- State ---
let allTeams = new Map();
let searchDebounceId = null;
const { seasonId: SEASON_ID } = getSeasonIdFromPage({ fallback: 'S9' });
const seasonNumber = parseInt(SEASON_ID.substring(1), 10);
const previousSeasons = [seasonNumber - 1, seasonNumber - 2]
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => `S${value}`);

// --- Initialize ---
document.addEventListener('DOMContentLoaded', async () => {
    await loadTeams();
    setupSearchListener();

    // Listen for league changes
    window.addEventListener('leagueChanged', async (event) => {
        console.log('League changed to:', event.detail.league);
        await loadTeams();
        // Clear search and reset
        searchInput.value = '';
        showSearchPrompt();
    });
});

// --- Team Loading ---
async function loadTeams() {
    allTeams.clear();
    try {
        const teamsSnap = await getDocs(collection(db, collectionNames.teams));

        const teamPromises = teamsSnap.docs.map(async (teamDoc) => {
            if (!teamDoc.data().conference) {
                return null;
            }

            const teamData = { id: teamDoc.id, ...teamDoc.data() };
            const seasonRecordRef = doc(db, collectionNames.teams, teamDoc.id, collectionNames.seasonalRecords, SEASON_ID);
            const seasonRecordSnap = await getDoc(seasonRecordRef);

            if (seasonRecordSnap.exists()) {
                teamData.team_name = seasonRecordSnap.data().team_name;
            } else {
                teamData.team_name = teamData.team_abbreviation || "Unknown";
            }
            return teamData;
        });

        const teamsWithData = (await Promise.all(teamPromises)).filter(Boolean);
        teamsWithData.forEach(team => allTeams.set(team.id, team));
    } catch (error) {
        console.error("Error loading teams:", error);
    }
}

// --- Search Listener ---
function setupSearchListener() {
    searchInput.addEventListener('input', () => {
        if (searchDebounceId) {
            clearTimeout(searchDebounceId);
        }

        searchDebounceId = setTimeout(() => {
            handlePlayerSearch();
        }, 250);
    });
}

// --- Search Handler ---
async function handlePlayerSearch() {
    const searchTermRaw = searchInput.value.trim();

    if (!searchTermRaw) {
        showSearchPrompt();
        return;
    }

    playersContainer.innerHTML = '<div class="loading">Searching players...</div>';

    try {
        // Query players using prefix search
        const playersQuery = query(
            collection(db, collectionNames.players),
            orderBy('player_handle'),
            startAt(searchTermRaw),
            endAt(searchTermRaw + '\uf8ff'),
            limit(50)
        );

        const playersSnap = await getDocs(playersQuery);

        if (playersSnap.empty) {
            playersContainer.innerHTML = '<p class="placeholder-text">No players found.</p>';
            return;
        }

        // Fetch player data with seasonal stats
        const playerPromises = playersSnap.docs.map(async (playerDoc) => {
            const playerData = { id: playerDoc.id, ...playerDoc.data() };

            // Check for S9, S8, and S7 seasonal stats
            const seasonChecks = await Promise.all([
                checkSeasonalStats(playerDoc.id, 'S9'),
                checkSeasonalStats(playerDoc.id, 'S8'),
                checkSeasonalStats(playerDoc.id, 'S7')
            ]);

            playerData.hasS9 = seasonChecks[0];
            playerData.hasS8 = seasonChecks[1];
            playerData.hasS7 = seasonChecks[2];

            return playerData;
        });

        const players = await Promise.all(playerPromises);
        players.sort((a, b) => (a.player_handle || '').localeCompare(b.player_handle));

        displayPlayers(players);
    } catch (error) {
        console.error("Error searching players:", error);
        playersContainer.innerHTML = '<div class="error">Could not load player data.</div>';
    }
}

// --- Check if player has seasonal stats ---
async function checkSeasonalStats(playerId, seasonId) {
    try {
        const statsRef = doc(db, collectionNames.players, playerId, collectionNames.seasonalStats, seasonId);
        const statsSnap = await getDoc(statsRef);
        return statsSnap.exists();
    } catch (error) {
        console.error(`Error checking ${seasonId} stats for player ${playerId}:`, error);
        return false;
    }
}

// --- Display Players ---
function displayPlayers(players) {
    if (players.length === 0) {
        playersContainer.innerHTML = '<p class="placeholder-text">No players found.</p>';
        return;
    }

    const playersHTML = players.map(player => createPlayerCard(player)).join('');
    playersContainer.innerHTML = playersHTML;

    // Add click listeners to toggle dropdowns
    document.querySelectorAll('.player-card').forEach(card => {
        card.addEventListener('click', (e) => {
            // Don't toggle if clicking a link
            if (e.target.tagName === 'A') {
                return;
            }

            const dropdown = card.querySelector('.player-dropdown');
            const isExpanded = dropdown.style.display === 'block';

            // Close all other dropdowns
            document.querySelectorAll('.player-dropdown').forEach(dd => {
                dd.style.display = 'none';
            });

            // Toggle this dropdown
            dropdown.style.display = isExpanded ? 'none' : 'block';
        });
    });
}

// --- Create Player Card HTML ---
function createPlayerCard(player) {
    const team = allTeams.get(player.current_team_id);

    // Handle retired players
    let teamName;
    if (player.player_status === 'RETIRED') {
        teamName = 'Retired';
    } else {
        teamName = team?.team_name || 'Free Agent';
    }

    const teamIconPath = player.current_team_id === 'FREE_AGENT' || !team
        ? '/icons/RKL.webp'
        : `/icons/${team.id}.webp`;

    // Build profile links
    const profileLinks = [];

    profileLinks.push(`<a href="/${SEASON_ID}/player.html?id=${player.id}">${SEASON_ID} Profile</a>`);

    previousSeasons.forEach((seasonId) => {
        if (player.seasonChecks?.[seasonId]) {
            profileLinks.push(`<a href="/${seasonId}/player.html?id=${player.id}">${seasonId} Profile</a>`);
        }
    });

    return `
        <div class="player-card" data-player-id="${player.id}">
            <div class="player-card-main">
                <div class="player-card-icon">
                    <img src="${teamIconPath}" alt="${teamName}" onerror="this.src='/icons/RKL.webp'" loading="lazy" />
                </div>
                <div class="player-card-info">
                    <div class="player-card-handle">${player.player_handle}</div>
                    <div class="player-card-team">${teamName}</div>
                </div>
                <div class="player-card-arrow">▼</div>
            </div>
            <div class="player-dropdown" style="display: none;">
                ${profileLinks.join('')}
            </div>
        </div>
    `;
}

// --- Show Search Prompt ---
function showSearchPrompt() {
    playersContainer.innerHTML = '<p class="placeholder-text">Start typing a player handle to search.</p>';
}
