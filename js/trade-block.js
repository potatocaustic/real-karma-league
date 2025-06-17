// /js/trade-block.js

const container = document.getElementById('trade-blocks-container');
const adminControlsContainer = document.getElementById('admin-controls');

// Initialize Firebase Functions for the admin kill switch
const functions = firebase.functions();

// Define teams to exclude from trade block functionality
const excludedTeams = ["FREE_AGENT", "RETIRED", "EAST", "WEST", "EGM", "WGM", "RSE", "RSW"];

document.addEventListener('DOMContentLoaded', () => {
    auth.onAuthStateChanged(async (user) => {
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
        // First, check the trade deadline status from Firestore
        const settingsDoc = await db.collection('settings').doc('tradeBlock').get();
        const tradeBlockStatus = settingsDoc.exists ? settingsDoc.data().status : 'open';
        
        const adminDoc = await db.collection("admins").doc(currentUserId).get();
        const isAdmin = adminDoc.exists;
        
        // Show admin controls regardless of deadline status
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
            addUniversalClickListener(isAdmin); // Add listener even when closed so admin can re-open
            return; // Stop further execution
        }

        // Fetch all data only if the deadline has not passed
        const [tradeBlocksSnap, teamsSnap, draftPicksSnap, playersSnap] = await Promise.all([
            db.collection("tradeblocks").get(),
            db.collection("teams").get(),
            db.collection("draftPicks").get(),
            db.collection("players").get()
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
        
        addUniversalClickListener(isAdmin, currentUserTeamId);

    } catch (error) {
        console.error("Error displaying trade blocks:", error);
        container.innerHTML = '<div class="error">Could not load trade blocks. Please try again later.</div>';
    }
}

function handleEmptyState(isAdmin, currentUserTeamId, teamsMap) {
    container.innerHTML = '<p style="text-align: center; margin-bottom: 1.5rem;">No trade blocks have been set up yet.</p>';
    
    if (isAdmin) {
        let adminSetupHtml = '<div class="trade-blocks-container"><h4>Admin: Create a Trade Block for a Team</h4>';
        teamsMap.forEach((team, teamId) => {
            // Exclude specified teams
            if (team.team_id && !excludedTeams.includes(team.team_id.toUpperCase())) {
                adminSetupHtml += `
                    <div class="admin-setup-item">
                        <span><img src="/S7/icons/${teamId}.webp" class="team-logo" onerror="this.style.display=\'none\'">${team.team_name}</span>
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
        existingBlockTeamIds.add(teamId); // Keep track of teams that have a block
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
            // CORRECTED player link parameter from 'player_handle' to 'player'
            return `<li><a href="/S7/player.html?player=${handle}">${handle}</a> (GP: ${p.games_played || 0}, REL: ${p.REL ? p.REL.toFixed(3) : 'N/A'}, WAR: ${p.WAR ? p.WAR.toFixed(2) : 'N/A'})</li>`;
        }).join('') || '<li>N/A</li>';

        const blockHtml = `
            <div class="trade-block-card" data-team-id="${teamId}">
                <div class="trade-block-header">
                    {/* CORRECTED team link parameter from 'team_id' to 'id' */}
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
    
    // For Admins: Show teams that do NOT have a trade block yet
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

// Add one universal event listener to the body to handle all clicks
let isListenerAttached = false;
function addUniversalClickListener(isAdmin, currentUserTeamId) {
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
            if (target.id === 'deadline-btn') {
                if (confirm('Are you sure you want to CLEAR ALL trade blocks and activate the deadline? This cannot be undone.')) {
                    const clearBlocks = functions.httpsCallable('clearAllTradeBlocks');
                    target.textContent = 'Processing...';
                    target.disabled = true;
                    clearBlocks().then(result => {
                        alert(result.data.message);
                        window.location.reload();
                    }).catch(error => {
                        alert(`Error: ${error.message}`);
                        target.textContent = 'Activate Trade Deadline';
                        target.disabled = false;
                    });
                }
            } else if (target.id === 'reopen-btn') {
                const reopenBlocks = functions.httpsCallable('reopenTradeBlocks');
                target.textContent = 'Processing...';
                target.disabled = true;
                reopenBlocks().then(result => {
                    alert(result.data.message);
                    window.location.reload();
                }).catch(error => {
                    alert(`Error: ${error.message}`);
                    target.textContent = 'Re-Open Trading';
                    target.disabled = false;
                });
            }
        }
    });
}