// /js/main.js

import { 
    auth, 
    db, 
    onAuthStateChanged, 
    signOut, 
    collection, 
    doc, 
    getDoc, 
    where, 
    query, 
    limit, 
    getDocs 
} from './firebase-init.js';

document.addEventListener('DOMContentLoaded', () => {
    // --- Authentication State Manager ---
    const authStatusDiv = document.getElementById('auth-status');
    if (authStatusDiv) {
        onAuthStateChanged(auth, user => {
            if (user) {
                // User is signed in.
                const adminRef = doc(db, "admins", user.uid);
                getDoc(adminRef).then(adminDoc => {
                    let welcomeMsg = "Welcome!"; 
                    
                    if (adminDoc.exists()) {
                        welcomeMsg = "Welcome, Admin!";
                        authStatusDiv.innerHTML = `<span>${welcomeMsg}</span> | <a id="logout-btn">Logout</a>`;
                        addLogoutListener();
                    } else {
                        // If not an admin, check if they are a GM.
                        const teamsQuery = query(collection(db, "teams"), where("gm_uid", "==", user.uid), limit(1));
                        getDocs(teamsQuery).then(snapshot => {
                            if (!snapshot.empty) {
                                const teamData = snapshot.docs[0].data();
                                welcomeMsg = `Welcome, ${teamData.gm_handle}!`;
                            }
                            authStatusDiv.innerHTML = `<span>${welcomeMsg}</span> | <a id="logout-btn">Logout</a>`;
                            addLogoutListener();
                        });
                    }
                });
            } else {
                // User is signed out. Display a login link.
                authStatusDiv.innerHTML = '<a href="/login.html">GM Login</a>';
            }
        });
    }

    function addLogoutListener() {
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => {
                signOut(auth).then(() => {
                    console.log('User signed out successfully.');
                    window.location.href = '/'; // Redirect to home page after logout
                }).catch((error) => {
                    console.error('Sign out error:', error);
                });
            });
        }
    }


    // --- Theme Toggler Functionality ---
    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    if(themeToggleBtn) {
        // Apply the saved theme on initial load
        (function() {
            const theme = localStorage.getItem('theme');
            if (theme === 'dark') {
                document.documentElement.classList.add('dark-mode');
            }
        })();

        // Add click listener to toggle theme
        themeToggleBtn.addEventListener('click', () => {
            document.documentElement.classList.toggle('dark-mode');
            let theme = 'light';
            if (document.documentElement.classList.contains('dark-mode')) {
                theme = 'dark';
            }
            localStorage.setItem('theme', theme);
        });
    }


    // --- Mobile Navigation Menu Toggle ---
    const navToggle = document.querySelector('.nav-toggle');
    const navMenu = document.getElementById('nav-menu');
    const dropdowns = document.querySelectorAll('.dropdown');

    if (navToggle && navMenu) {
        navToggle.addEventListener('click', () => {
            navMenu.classList.toggle('active');
        });
    }

    // Logic for mobile dropdowns
    if (dropdowns.length > 0) {
        dropdowns.forEach(dropdown => {
            const btn = dropdown.querySelector('.dropbtn');
            if (btn) {
                btn.addEventListener('click', function(event) {
                    // Check if we are in mobile view (nav-toggle is visible)
                    if (window.getComputedStyle(navToggle).display !== 'none') {
                        event.preventDefault(); // Prevent link navigation
                        // Close other open dropdowns
                        dropdowns.forEach(d => {
                            if (d !== dropdown) {
                                d.classList.remove('active');
                            }
                        });
                        // Toggle the current one
                        dropdown.classList.toggle('active');
                    }
                });
            }
        });
    }
});

/**
 * Generates the HTML for a single team's breakdown in the modal.
 * This is now a global, reusable function.
 * @param {Array} lineups - The array of player lineup objects.
 * @param {Object} team - The team's data object.
 * @param {boolean} isWinner - Whether this team is the winner.
 * @returns {string} The HTML string for the team breakdown.
 */
export function generateLineupTable(lineups, team, isWinner, isLive = false) {
    if (!team) return '<div>Team data not found</div>';
    const totalPoints = lineups.reduce((sum, p) => sum + (p.final_score || 0), 0);
    const winnerCheck = isWinner ? '✅ ' : '';
    
    const liveIndicator = isLive ? '<span class="live-indicator-modal"></span>' : '';

    const captain = lineups.find(p => p.is_captain === "TRUE" || p.is_captain === true);
    const otherPlayers = lineups.filter(p => !(p.is_captain === "TRUE" || p.is_captain === true));
    otherPlayers.sort((a, b) => (b.final_score || 0) - (a.final_score || 0));
    const sortedLineups = captain ? [captain, ...otherPlayers] : otherPlayers;

    const teamNameWithSeed = team.seed ? `(${team.seed}) ${team.team_name}` : team.team_name;
    
    // MODIFIED: Use the correct list of All-Star team IDs to determine the file extension.
    const allStarTeamIds = ["EAST", "WEST", "EGM", "WGM", "RSE", "RSW"];
    const iconExt = team.id && allStarTeamIds.includes(team.id) ? 'png' : 'webp';

    return `
        <div class="team-breakdown ${isWinner ? 'winner' : ''}">
            <div class="modal-team-header ${isWinner ? 'winner' : ''}" onclick="window.location.href='team.html?id=${team.id}'">
                <div class="modal-team-info-wrapper">
                    <img src="../icons/${team.id}.${iconExt}" alt="${team.team_name}" class="team-logo" onerror="this.style.display='none'">
                    <h4>${teamNameWithSeed}</h4>
                    <span class="modal-team-record">(${team.wins}-${team.losses})</span>
                </div>
            </div>
            <div class="team-total">${winnerCheck}Total: ${Math.round(totalPoints).toLocaleString()}${liveIndicator}</div>
            <table class="lineup-table">
                <thead><tr><th>Player</th><th>Points</th><th>Rank</th></tr></thead>
                <tbody>
                    ${sortedLineups.map(p => {
                        const isCaptain = p.is_captain === "TRUE" || p.is_captain === true;
                        const baseScore = p.points_adjusted || 0;
                        const finalScore = p.final_score || 0;
                        const captainBonus = isCaptain ? finalScore - baseScore : 0;
                        const captainBadge = isCaptain ? '<span class="captain-badge">C</span>' : '';
                        return `
                            <tr class="${isCaptain ? 'captain-row' : ''}">
                                <td class="player-name-cell"><a href="player.html?id=${encodeURIComponent(p.player_id)}" class="player-link">${p.player_handle}</a>${captainBadge}</td>
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
