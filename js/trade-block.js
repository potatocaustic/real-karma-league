// /js/trade-block.js

// CORRECTED: Import everything from the centralized firebase-init.js file
import { 
    auth, 
    db, 
    functions, 
    onAuthStateChanged, 
    collection, 
    doc, 
    getDoc, 
    getDocs, 
    httpsCallable 
} from './firebase-init.js';

const container = document.getElementById('trade-blocks-container');
const adminControlsContainer = document.getElementById('admin-controls');
const excludedTeams = ["FREE_AGENT", "RETIRED", "EAST", "WEST", "EGM", "WGM", "RSE", "RSW"];

document.addEventListener('DOMContentLoaded', () => {
    // CORRECTED: Use modular onAuthStateChanged syntax
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            await displayAllTradeBlocks(user.uid);
        } else {
            if (!window.location.pathname.endsWith('login.html')) {
                window.location.href = '/login.html';
            }
        }
    });
});

async function displayAllTradeBlocks(currentUserId) {
    try {
        // CORRECTED: Use modular syntax for all Firestore calls
        const settingsDocRef = doc(db, 'settings', 'tradeBlock');
        const settingsDoc = await getDoc(settingsDocRef);
        const tradeBlockStatus = settingsDoc.exists() ? settingsDoc.data().status : 'open';
        
        const adminDocRef = doc(db, "admins", currentUserId);
        const adminDoc = await getDoc(adminDocRef);
        const isAdmin = adminDoc.exists();
        
        if (isAdmin && adminControlsContainer) {
            adminControlsContainer.style.display = 'block';
            adminControlsContainer.innerHTML = `
                <div class="admin-controls-container">
                    <span>Admin Controls:</span>
                    <button id="deadline-btn" class="edit-btn deadline-btn">Activate Trade Deadline</button>
                    <button id="reopen-btn" class="edit-btn reopen-btn">Re-Open Trading</button>
                </div>
            `;
        }

        if (tradeBlockStatus === 'closed') {
            container.innerHTML = '<p style="text-align: center; font-weight: bold; font-size: 1.2rem;">Trade Deadline Passed - Trade Block Unavailable</p>';
            addUniversalClickListener(isAdmin);
            return;
        }

        const [tradeBlocksSnap, teamsSnap, draftPicksSnap, playersSnap] = await Promise.all([
            getDocs(collection(db, "tradeblocks")),
            getDocs(collection(db, "teams")),
            getDocs(collection(db, "draftPicks")),
            getDocs(collection(db, "players"))
        ]);

        const teamsMap = new Map(teamsSnap.docs.map(doc => [doc.id, doc.data()]));
        const draftPicksMap = new Map(draftPicksSnap.docs.map(doc => [doc.id, doc.data()]));
        const playersMap = new Map(playersSnap.docs.map(doc => [doc.id, doc.data()]));

        container.innerHTML = '';
        let currentUserTeamId = null;
        for (const [teamId, teamData] of teamsMap.entries()) {
            if (teamData.gm_uid === currentUserId) currentUserTeamId = teamId;
        }

        if (tradeBlocksSnap.empty) {
            handleEmptyState(isAdmin, currentUserTeamId, teamsMap);
        } else {
            handleExistingBlocks(tradeBlocksSnap, teamsMap, draftPicksMap, playersMap, isAdmin, currentUserId, currentUserTeamId);
        }
        
        addUniversalClickListener(isAdmin);

    } catch (error) {
        console.error("Error displaying trade blocks:", error);
        container.innerHTML = '<div class="error">Could not load trade blocks. Please try again later.</div>';
    }
}

// The following helper functions (handleEmptyState, handleExistingBlocks) have no syntax changes
// but are included for completeness.
function handleEmptyState(isAdmin, currentUserTeamId, teamsMap) {
    container.innerHTML = '<p style="text-align: center; margin-bottom: 1.5rem;">No trade blocks have been set up yet.</p>';
    
    if (isAdmin) {
        let adminSetupHtml = '<div class="trade-blocks-container"><h4>Admin: Create a Trade Block for a Team</h4>';
        teamsMap.forEach((team, teamId) => {
            if (team.team_id && !excludedTeams.includes(team.team_id.toUpperCase())) {
                adminSetupHtml += `
                    <div class="admin-setup-item">
                        <span><img src="/S7/icons/${teamId}.webp" class="team-logo" onerror="this.style.display='none'">${team.team_name}</span>
                        <button class="edit-btn" data-team-id="${teamId}" data-action="setup">Set Up Block</button>
                    </div>`;
            }
        });
        adminSetupHtml += '</div>';
        container.innerHTML += adminSetupHtml;
    } else if (currentUserTeamId) {
        const setupButtonHtml = `<div style="text-align: center; border-top: 2px solid #ddd; padding-top: 2rem;">
            <h4>Your trade block is empty.</h4>
            <button class="edit-btn" data-team-id="${currentUserTeamId}" data-action="setup">Set Up My Trade Block</button>
        </div>`;
        container.innerHTML += setupButtonHtml;
    }
}

function handleExistingBlocks(tradeBlocksSnap, teamsMap, draftPicksMap, playersMap, isAdmin, currentUserId, currentUserTeamId) {
    const existingBlockTeamIds = new Set();
    tradeBlocksSnap.forEach(doc => {
        const teamId = doc.id;
        existingBlockTeamIds.add(teamId);
        const blockData = doc.data();
        const teamData = teamsMap.get(teamId) || { team_name: teamId };
        
        const picksWithDescriptions = (blockData.picks_available_ids || []).map(pickId => {
            const pickInfo = draftPicksMap.get(pickId);
            if (pickInfo) {
                const originalTeamInfo = teamsMap.get(pickInfo.original_team);
                const teamName = originalTeamInfo ? originalTeamInfo.team_name : pickInfo.original_team;
                const ownerRecord = originalTeamInfo ? `(${originalTeamInfo.wins}-${originalTeamInfo.losses})` : '';
                const round = pickInfo.round;
                const roundSuffix = round == 1 ? 'st' : round == 2 ? 'nd' : round == 3 ? 'rd' : 'th';
                return `S${pickInfo.season} ${teamName} ${round}${roundSuffix} ${ownerRecord}`;
            }
            return `${pickId} (Unknown Pick)`;
        }).join('<br>') || 'N/A';

        const playersWithStats = (blockData.on_the_block || []).map(handle => {
            const p = playersMap.get(handle);
            if (!p) return `<li>${handle} (stats not found)</li>`;
            return `<li><a href="/S7/player.html?player=${handle}">${handle}</a> (GP: ${p.games_played || 0}, REL: ${p.rel_median ? parseFloat(p.rel_median).toFixed(3) : 'N/A'}, WAR: ${p.WAR ? p.WAR.toFixed(2) : 'N/A'})</li>`;
        }).join('') || '<li>N/A</li>';

        const blockHtml = `
            <div class="trade-block-card" data-team-id="${teamId}">
                <div class="trade-block-header">
                    <a href="/S7/team.html?id=${teamId}">
                        <h4><img src="/S7/icons/${teamId}.webp" class="team-logo" onerror="this.style.display='none'">${teamData.team_name}</h4>
                    </a>
                    <button class="edit-btn" data-team-id="${teamId}" data-action="edit" style="display: none;">Edit</button>
                </div>
                <div class="trade-block-content">
                    <p><strong>Players Available:</strong></p><ul class="player-list">${playersWithStats}</ul><hr>
                    <p><strong>Picks Available:</strong><br>${picksWithDescriptions}</p><hr>
                    <p><strong>Seeking:</strong><br>${blockData.seeking || 'N/A'}</p>
                </div>
            </div>`;
        container.innerHTML += blockHtml;
    });

    teamsMap.forEach((teamData, teamId) => {
        const editButton = container.querySelector(`button[data-action='edit'][data-team-id='${teamId}']`);
        if(editButton && (isAdmin || teamData.gm_uid === currentUserId)) {
            editButton.style.display = 'inline-block';
        }
    });

    const userBlockRendered = container.querySelector(`.trade-block-card[data-team-id="${currentUserTeamId}"]`);
    if (currentUserTeamId && !userBlockRendered) {
        const setupButtonHtml = `<div style="text-align: center; border-top: 2px solid #ddd; padding-top: 2rem;">
            <h4>Your trade block is empty.</h4>
            <button class="edit-btn" data-team-id="${currentUserTeamId}" data-action="setup">Set Up My Trade Block</button>
        </div>`;
        container.innerHTML += setupButtonHtml;
    }
    
    if (isAdmin) {
        let adminSetupHtml = '';
        const teamsWithoutBlocks = Array.from(teamsMap.entries()).filter(([teamId, team]) =>
            !existingBlockTeamIds.has(teamId) && team.team_id && !excludedTeams.includes(team.team_id.toUpperCase())
        );

        if (teamsWithoutBlocks.length > 0) {
            adminSetupHtml += '<div class="trade-blocks-container" style="margin-top: 2rem;"><h4>Admin: Create a Trade Block for a Team</h4>';
            teamsWithoutBlocks.forEach(([teamId, team]) => {
                adminSetupHtml += `
                    <div class="admin-setup-item">
                        <span><img src="/S7/icons/${teamId}.webp" class="team-logo" onerror="this.style.display=\'none\'">${team.team_name}</span>
                        <button class="edit-btn" data-team-id="${teamId}" data-action="setup">Set Up Block</button>
                    </div>`;
            });
            adminSetupHtml += '</div>';
        }
        container.innerHTML += adminSetupHtml;
    }
}

let isListenerAttached = false;
function addUniversalClickListener(isAdmin) {
    if (isListenerAttached) return;
    isListenerAttached = true;
    
    document.body.addEventListener('click', (event) => {
        const target = event.target.closest('button');
        if (!target) return;

        const teamIdToEdit = target.dataset.teamId;
        if (teamIdToEdit) {
            window.location.href = `/S7/edit-trade-block.html?team=${teamIdToEdit}`;
            return;
        }

        if (isAdmin) {
            const currentUser = auth.currentUser;
            if (!currentUser) {
                alert("Authentication error. Please refresh and log in again.");
                return;
            }

            const handleAdminAction = (callableName, confirmMsg, buttonText) => {
                if (confirm(confirmMsg)) {
                    target.textContent = 'Processing...';
                    target.disabled = true;
                    
                    const action = httpsCallable(functions, callableName);

                    currentUser.getIdToken(true).then(() => {
                        return action();
                    }).then(result => {
                        alert(result.data.message);
                        window.location.reload();
                    }).catch(error => {
                        console.error("Function call failed:", error);
                        alert(`Error: ${error.message}`);
                        target.textContent = buttonText;
                        target.disabled = false;
                    });
                }
            };

            if (target.id === 'deadline-btn') {
                handleAdminAction('clearAllTradeBlocks', 'Are you sure you want to CLEAR ALL trade blocks and activate the deadline? This cannot be undone.', 'Activate Trade Deadline');
            } else if (target.id === 'reopen-btn') {
                handleAdminAction('reopenTradeBlocks', 'Are you sure you want to re-open trading for all teams?', 'Re-Open Trading');
            }
        }
    });
}