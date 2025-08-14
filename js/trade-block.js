// /js/trade-block.js

// MODIFIED: Import new config and helpers from the centralized firebase-init.js
import { 
    auth, 
    db, 
    functions, 
    onAuthStateChanged, 
    collection,
    collectionGroup,
    doc, 
    getDoc, 
    getDocs, 
    httpsCallable,
    query,
    where,
    limit,
    documentId,
    orderBy, // NEW
    collectionNames // NEW
} from './firebase-init.js';

const container = document.getElementById('trade-blocks-container');
const adminControlsContainer = document.getElementById('admin-controls');
const excludedTeams = ["FREE_AGENT", "RETIRED", "EAST", "WEST", "EGM", "WGM", "RSE", "RSW"];

// NEW: Helper to get the active season ID
async function getActiveSeasonId() {
    const q = query(collection(db, collectionNames.seasons), where("status", "==", "active"), limit(1));
    const querySnapshot = await getDocs(q);
    if (querySnapshot.empty) {
        throw new Error("No active season found.");
    }
    return querySnapshot.docs[0].id;
}


document.addEventListener('DOMContentLoaded', () => {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            await displayAllTradeBlocks(user.uid);
        } else {
            container.innerHTML = '<div class="error">You must be logged in to view the trade block. Please <a href="../login.html">log in</a>.</div>';
        }
    });
});

async function displayAllTradeBlocks(currentUserId) {
    try {
        // This initial setup code remains the same
        const settingsDocRef = doc(db, 'settings', 'tradeBlock'); // Assuming 'settings' doesn't have a _dev version based on rules
        const settingsDoc = await getDoc(settingsDocRef);
        const tradeBlockStatus = settingsDoc.exists() ? settingsDoc.data().status : 'open';

        let isAdmin = false;
        if (currentUserId) {
            const adminDocRef = doc(db, collectionNames.users, currentUserId);
            const adminDoc = await getDoc(adminDocRef);
            isAdmin = adminDoc.exists() && adminDoc.data().role === 'admin';
        }
        
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

        const activeSeasonId = await getActiveSeasonId();

        const tradeBlocksQuery = query(collection(db, "tradeblocks"), orderBy("last_updated", "desc"));

        const [tradeBlocksSnap, teamsSnap, draftPicksSnap] = await Promise.all([
            getDocs(tradeBlocksQuery),
            getDocs(collection(db, collectionNames.teams)),
            getDocs(collection(db, collectionNames.draftPicks))
        ]);

        const allPlayerIds = [...new Set(tradeBlocksSnap.docs.flatMap(doc => doc.data().on_the_block || []))];

        // ===================================================================
        // MODIFIED SECTION TO FIX 'IN' QUERY LIMITATION
        // ===================================================================
        let playersMap = new Map();
        let statsMap = new Map();

        if (allPlayerIds.length > 0) {
            // Firestore 'in' queries are limited to 30 items. We must "chunk" the queries.
            const CHUNK_SIZE = 30;
            for (let i = 0; i < allPlayerIds.length; i += CHUNK_SIZE) {
                const chunk = allPlayerIds.slice(i, i + CHUNK_SIZE);

                // Create queries for the current chunk of players
                const playersQuery = query(collection(db, collectionNames.players), where(documentId(), 'in', chunk));
                const playerStatsPaths = chunk.map(id => `${collectionNames.players}/${id}/${collectionNames.seasonalStats}/${activeSeasonId}`);
                const statsQuery = query(collectionGroup(db, collectionNames.seasonalStats), where(documentId(), 'in', playerStatsPaths));

                // Execute queries for the chunk and merge the results into our maps
                const [playersDataSnap, statsDataSnap] = await Promise.all([getDocs(playersQuery), getDocs(statsQuery)]);

                playersDataSnap.forEach(doc => playersMap.set(doc.id, doc.data()));
                statsDataSnap.forEach(doc => statsMap.set(doc.ref.parent.parent.id, doc.data()));
            }
        }
        // ===================================================================
        // END OF MODIFIED SECTION
        // ===================================================================
        
        const teamsRecordSnap = await getDocs(query(collectionGroup(db, collectionNames.seasonalRecords), where('season', '==', activeSeasonId)));
        const teamsRecordMap = new Map(teamsRecordSnap.docs.map(doc => [doc.data().team_id, doc.data()]));
        
        const allTeamsMap = new Map(teamsSnap.docs.map(doc => {
            const staticData = doc.data();
            const seasonalData = teamsRecordMap.get(doc.id) || {};
            return [doc.id, { ...staticData, ...seasonalData }];
        }));

        const draftPicksMap = new Map(draftPicksSnap.docs.map(doc => [doc.id, doc.data()]));

        container.innerHTML = '';
        let currentUserTeamId = null;
        if (currentUserId) {
            for (const [teamId, teamData] of allTeamsMap.entries()) {
                if (teamData.gm_uid === currentUserId) currentUserTeamId = teamId;
            }
        }

        if (tradeBlocksSnap.empty) {
            handleEmptyState(isAdmin, currentUserTeamId, allTeamsMap);
        } else {
            handleExistingBlocks(tradeBlocksSnap, allTeamsMap, draftPicksMap, playersMap, statsMap, isAdmin, currentUserId, currentUserTeamId);
        }
        
        addUniversalClickListener(isAdmin);

    } catch (error) {
        console.error("Error displaying trade blocks:", error);
        container.innerHTML = `<div class="error">Could not load trade blocks. ${error.message}</div>`;
    }
}
// MODIFIED: Added statsMap to its signature
function handleEmptyState(isAdmin, currentUserTeamId, teamsMap) {
    container.innerHTML = '<p style="text-align: center; margin-bottom: 1.5rem;">No trade blocks have been set up yet.</p>';
    
    if (isAdmin) {
        let adminSetupHtml = '<div class="trade-blocks-container"><h4>Admin: Create a Trade Block for a Team</h4>';
        teamsMap.forEach((team, teamId) => {
            if (team.team_id && !excludedTeams.includes(team.team_id.toUpperCase())) {
                adminSetupHtml += `
                    <div class="admin-setup-item">
                        <span><img src="/icons/${teamId}.webp" class="team-logo" onerror="this.style.display='none'">${team.team_name}</span>
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

// MODIFIED: Rewritten to use new data structures (V2 players/teams and separated stats)
function handleExistingBlocks(tradeBlocksSnap, teamsMap, draftPicksMap, playersMap, statsMap, isAdmin, currentUserId, currentUserTeamId) {
    const existingBlockTeamIds = new Set();

    // The snapshot is already sorted by the Firestore query
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
                const ownerRecord = originalTeamInfo ? `(${(originalTeamInfo.wins || 0)}-${(originalTeamInfo.losses || 0)})` : '';
                const round = pickInfo.round;
                const roundSuffix = round == 1 ? 'st' : round == 2 ? 'nd' : round == 3 ? 'rd' : 'th';
                return `S${pickInfo.season} ${teamName} ${round}${roundSuffix} ${ownerRecord}`;
            }
            return `${pickId} (Unknown Pick)`;
        }).join('<br>') || 'N/A';

        // MODIFIED: Player data lookup is different now
        const playersWithStats = (blockData.on_the_block || []).map(playerId => {
            const pData = playersMap.get(playerId);
            const pStats = statsMap.get(playerId);
            if (!pData || !pStats) return `<li>Player data not found</li>`;
            return `<li><a href="/S7/player.html?id=${playerId}">${pData.player_handle}</a> (GP: ${pStats.games_played || 0}, REL: ${pStats.rel_median ? parseFloat(pStats.rel_median).toFixed(3) : 'N/A'}, WAR: ${pStats.WAR ? pStats.WAR.toFixed(2) : 'N/A'})</li>`;
        }).join('') || '<li>N/A</li>';

        const blockHtml = `
            <div class="trade-block-card" data-team-id="${teamId}">
                <div class="trade-block-header">
                    <a href="/S7/team.html?id=${teamId}">
                        <h4><img src="/icons/${teamId}.webp" class="team-logo" onerror="this.style.display='none'">${teamData.team_name}</h4>
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
                        <span><img src="/icons/${teamId}.webp" class="team-logo" onerror="this.style.display=\'none\'">${team.team_name}</span>
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
