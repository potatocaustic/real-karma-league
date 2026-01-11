// /js/homepage.js

import {
    db,
    collection,
    doc,
    getDoc,
    getDocs,
    query,
    where,
    orderBy,
    limit,
    collectionNames,
    getLeagueCollectionName
} from './firebase-init.js';

// --- DOM ELEMENT REFERENCES ---
const currentSeasonContainer = document.getElementById('current-season-container');
const navGridContainer = document.getElementById('nav-grid-container');
const seasonsGridContainer = document.getElementById('seasons-grid-container');

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Main function to initialize the homepage.
 */
async function initHomepage() {
    try {
        // Fetch the active season first to determine context
        // Note: Removed orderBy to avoid requiring composite index (status + __name__)
        const activeSeasonQuery = query(
            collection(db, collectionNames.seasons),
            where("status", "==", "active"),
            limit(1)
        );
        const activeSeasonSnap = await getDocs(activeSeasonQuery);

        let activeSeasonId = null;

        if (!activeSeasonSnap.empty) {
            const activeSeasonDoc = activeSeasonSnap.docs[0];
            activeSeasonId = activeSeasonDoc.id; // e.g., "S8" or "S9"
            const activeSeasonData = activeSeasonDoc.data();
            const activeSeasonNum = parseInt(activeSeasonId.replace('S', ''));

            // Update current season banner and navigation
            updateCurrentSeasonBanner(activeSeasonId);
            updateNavGrid(activeSeasonId);
        } else {
            // No active season found - try to find the most recent season
            console.warn("No active season found, looking for most recent season...");
            const allSeasonsQuery = query(collection(db, collectionNames.seasons));
            const allSeasonsSnap = await getDocs(allSeasonsQuery);

            if (!allSeasonsSnap.empty) {
                // Sort seasons by ID (S1, S2, S3, etc.) and get the most recent
                const sortedSeasons = allSeasonsSnap.docs.sort((a, b) => {
                    const aNum = parseInt(a.id.replace('S', ''));
                    const bNum = parseInt(b.id.replace('S', ''));
                    return bNum - aNum;
                });
                activeSeasonId = sortedSeasons[0].id;

                // Show warning banner that no active season exists
                currentSeasonContainer.innerHTML = `
                    <div class="current-season" style="background: linear-gradient(135deg, #ffc107, #ff9800);">
                        <h3>No Active Season</h3>
                        <p>There is currently no active season. Showing most recent season: ${activeSeasonId.replace('S', '')}</p>
                        <a href="/${activeSeasonId}/RKL-${activeSeasonId}.html" class="cta-button">View Season ${activeSeasonId.replace('S', '')} Hub →</a>
                    </div>
                `;
                updateNavGrid(activeSeasonId);
            } else {
                // No seasons at all
                currentSeasonContainer.innerHTML = `
                    <div class="error">No seasons found in the database. Please check back later.</div>
                `;
                navGridContainer.innerHTML = '';
            }
        }

        // Always try to update league history, even if there's no active season
        await updateLeagueHistory(activeSeasonId);

    } catch (error) {
        console.error("Error initializing homepage:", error);
        currentSeasonContainer.innerHTML = `<div class="error">Failed to load page data: ${escapeHtml(error.message)}</div>`;
        navGridContainer.innerHTML = '';
        seasonsGridContainer.innerHTML = '';
    }
}

/**
 * Updates the "Current Season" banner with the active season's info.
 * @param {string} activeSeasonId - The ID of the active season (e.g., "S8").
 */
function updateCurrentSeasonBanner(activeSeasonId) {
    const seasonNum = activeSeasonId.replace('S', '');
    const html = `
        <div class="current-season">
          <h3>Season ${seasonNum} Now Active</h3>
          <p>Follow the current season with live standings, player stats, and weekly results</p>
          <a href="/${activeSeasonId}/RKL-${activeSeasonId}.html" class="cta-button">Enter Season ${seasonNum} Hub →</a>
        </div>
    `;
    currentSeasonContainer.innerHTML = html;
}

/**
 * Updates the "League Central" navigation links to point to the active season.
 * @param {string} activeSeasonId - The ID of the active season (e.g., "S8").
 */
function updateNavGrid(activeSeasonId) {
    const navLinks = [
        { href: `/${activeSeasonId}/standings.html`, icon: '📊', title: 'Current Standings', desc: 'Live conference standings and playoff picture' },
        { href: `/${activeSeasonId}/leaderboards.html`, icon: '🏆', title: 'Player Leaderboards', desc: 'Top performers across all statistical categories' },
        { href: `/${activeSeasonId}/schedule.html`, icon: '📅', title: 'Schedule & Results', desc: 'Complete game schedule and weekly standouts' },
        { href: `/${activeSeasonId}/teams.html`, icon: '👥', title: 'All Teams', desc: 'Team rosters and general manager information' },
        { href: `/${activeSeasonId}/transactions.html`, icon: '🔄', title: 'Transaction Log', desc: 'Complete trade history and roster moves' },
        { href: `/${activeSeasonId}/draft-capital.html`, icon: '📋', title: 'Draft Capital', desc: 'Future draft pick ownership and trades' }
    ];

    const html = navLinks.map(link => `
        <a href="${link.href}" class="nav-card">
            <div class="nav-card-icon">${link.icon}</div>
            <div class="nav-card-title">${link.title}</div>
            <div class="nav-card-description">${link.desc}</div>
        </a>
    `).join('');

    navGridContainer.innerHTML = html;
}

/**
 * Fetches all seasons and their champions to build the "League History" section.
 * @param {string} activeSeasonId - The ID of the active season to mark as "Current".
 */
async function updateLeagueHistory(activeSeasonId) {
    const seasonsQuery = query(collection(db, collectionNames.seasons), orderBy('__name__', 'desc'));
    const seasonsSnap = await getDocs(seasonsQuery);

    const seasonHistoryPromises = seasonsSnap.docs.map(async (seasonDoc) => {
        const seasonId = seasonDoc.id;
        const seasonData = seasonDoc.data();
        const seasonNum = seasonId.replace('S', '');
        const isCurrent = seasonId === activeSeasonId;

        let championHTML = `
            <div class="season-stat">
                <div class="season-stat-value">-</div>
                <div class="season-stat-label">Champion</div>
            </div>`;

        if (!isCurrent) {
            try {
                const champRef = doc(db, getLeagueCollectionName('awards'), `season_${seasonNum}`, `S${seasonNum}_awards`, 'league-champion');
                const champSnap = await getDoc(champRef);
                if (champSnap.exists()) {
                    const champData = champSnap.data();
                    championHTML = `
                        <div class="season-stat">
                            <div class="season-stat-value champion-info">
                                <img src="/icons/${champData.team_id}.webp" alt="${champData.team_name}" class="champion-logo" onerror="this.style.display='none'"/ loading="lazy">
                                <span>${champData.team_name}</span>
                            </div>
                            <div class="season-stat-label">Champion</div>
                        </div>`;
                }
            } catch (e) {
                console.warn(`Could not fetch champion for ${seasonId}:`, e.message);
            }
        }

        return `
            <a href="/${seasonId}/RKL-${seasonId}.html" class="season-card ${isCurrent ? 'current' : ''}">
                ${isCurrent ? '<div class="current-badge">Current</div>' : ''}
                <div class="season-title">Season ${seasonNum}</div>
                <div class="season-status">${seasonData.status === 'active' ? 'In Progress' : 'Completed'}</div>
                <div class="season-stats">
                    ${championHTML}
                    <div class="season-stat">
                        <div class="season-stat-value">${seasonData.gs || '-'}</div>
                        <div class="season-stat-label">Games</div>
                    </div>
                </div>
            </a>
        `;
    });

    const seasonsHTML = await Promise.all(seasonHistoryPromises);
    seasonsGridContainer.innerHTML = seasonsHTML.join('');
}

// --- INITIALIZE THE PAGE ---
document.addEventListener('DOMContentLoaded', initHomepage);
