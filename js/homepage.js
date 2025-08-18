// /js/homepage.js

import {
    db,
    collection,
    doc,
    getDoc,
    getDocs,
    query,
    where,
    orderBy
} from './firebase-init.js';

// --- CONFIGURATION ---
const USE_DEV_COLLECTIONS = false; 
const getCollectionName = (baseName) => USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;

// --- DOM ELEMENT REFERENCES ---
const currentSeasonContainer = document.getElementById('current-season-container');
const navGridContainer = document.getElementById('nav-grid-container');
const seasonsGridContainer = document.getElementById('seasons-grid-container');

/**
 * Main function to initialize the homepage.
 */
async function initHomepage() {
    try {
        // Fetch the active season first to determine context
        const activeSeasonQuery = query(collection(db, getCollectionName('seasons')), where("status", "==", "active"), orderBy("__name__", "desc"));
        const activeSeasonSnap = await getDocs(activeSeasonQuery);

        if (activeSeasonSnap.empty) {
            throw new Error("No active season found in the database.");
        }
        
        const activeSeasonDoc = activeSeasonSnap.docs[0];
        const activeSeasonId = activeSeasonDoc.id; // e.g., "S8"
        const activeSeasonData = activeSeasonDoc.data();
        const activeSeasonNum = parseInt(activeSeasonId.replace('S', ''));

        // Update all dynamic sections of the page
        updateCurrentSeasonBanner(activeSeasonId);
        updateNavGrid(activeSeasonId);
        await updateLeagueHistory(activeSeasonId);

    } catch (error) {
        console.error("Error initializing homepage:", error);
        currentSeasonContainer.innerHTML = `<div class="error">Failed to load page data.</div>`;
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
    const seasonsQuery = query(collection(db, getCollectionName('seasons')), orderBy('__name__', 'desc'));
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
                const champRef = doc(db, getCollectionName('awards'), `season_${seasonNum}`, getCollectionName(`S${seasonNum}_awards`), 'league-champion');
                const champSnap = await getDoc(champRef);
                if (champSnap.exists()) {
                    const champData = champSnap.data();
                    championHTML = `
                        <div class="season-stat">
                            <div class="season-stat-value champion-info">
                                <img src="/icons/${champData.team_id}.webp" alt="${champData.team_name}" class="champion-logo" onerror="this.style.display='none'"/>
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
