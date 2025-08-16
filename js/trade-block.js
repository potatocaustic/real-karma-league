// /js/trade-block.js

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
    orderBy,
    collectionNames
} from './firebase-init.js';

const container = document.getElementById('trade-blocks-container');
const adminControlsContainer = document.getElementById('admin-controls');
const pageHeader = document.querySelector('.page-header');
const excludedTeams = ["FREE_AGENT", "RETIRED", "EAST", "WEST", "EGM", "WGM", "RSE", "RSW"];

// Inject CSS for new features
document.head.insertAdjacentHTML('beforeend', `
<style>
    .new-item-badge {
        display: inline-block;
        background-color: #28a745; /* MODIFIED: Changed to green */
        color: white;
        padding: 2px 6px;
        font-size: 0.7rem;
        font-weight: bold;
        border-radius: 4px;
        margin-left: 8px;
        vertical-align: middle;
        text-transform: uppercase;
    }
    /* NEW: Style to remove bullet points from lists */
    .trade-block-item-list {
        list-style-type: none;
        padding-left: 0;
    }
    .collapsible-content {
        position: relative;
        max-height: 110px;
        overflow: hidden;
        transition: max-height 0.3s ease-out;
    }
    .collapsible-content.expanded {
        max-height: 1000px;
        transition: max-height 0.5s ease-in;
    }
    .toggle-btn {
        display: block;
        text-align: center;
        padding: 8px;
        cursor: pointer;
        color: #007bff;
        font-weight: bold;
    }
    .edit-my-block-btn {
        display: block;
        width: fit-content;
        margin: 1rem auto 1.5rem auto;
        padding: 10px 20px;
        font-size: 1rem;
        text-align: center;
    }
    .dark-mode a.edit-my-block-btn {
        color: #fff !important;
    }
</style>
`);

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
            window.location.href = '../login.html?reason=unauthorized';
        }
    });
});

async function displayAllTradeBlocks(currentUserId) {
    try {
        const settingsDocRef = doc(db, 'settings', 'tradeBlock');
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

        // MODIFIED: Removed the inefficient fetching of all draft picks here.
        const [tradeBlocksSnap, teamsSnap] = await Promise.all([
            getDocs(tradeBlocksQuery),
            getDocs(collection(db, collectionNames.teams)),
        ]);

        // 1. Get all Player and Pick IDs from the trade blocks first.
        const allPlayerIds = [...new Set(tradeBlocksSnap.docs.flatMap(doc => (doc.data().on_the_block || []).map(p => p.id)))];
        const allPickIds = [...new Set(tradeBlocksSnap.docs.flatMap(doc => (doc.data().picks_available_ids || []).map(p => p.id)))];
        
        // 2. Fetch Player data on-demand in chunks (already efficient).
        let playersMap = new Map();
        let statsMap = new Map();
        if (allPlayerIds.length > 0) {
            const CHUNK_SIZE = 30;
            for (let i = 0; i < allPlayerIds.length; i += CHUNK_SIZE) {
                const chunk = allPlayerIds.slice(i, i + CHUNK_SIZE);
                const playersQuery = query(collection(db, collectionNames.players), where(documentId(), 'in', chunk));
                const playerStatsPaths = chunk.map(id => `${collectionNames.players}/${id}/${collectionNames.seasonalStats}/${activeSeasonId}`);
                const statsQuery = query(collectionGroup(db, collectionNames.seasonalStats), where(documentId(), 'in', playerStatsPaths));
                const [playersDataSnap, statsDataSnap] = await Promise.all([getDocs(playersQuery), getDocs(statsQuery)]);
                playersDataSnap.forEach(doc => playersMap.set(doc.id, doc.data()));
                statsDataSnap.forEach(doc => statsMap.set(doc.ref.parent.parent.id, doc.data()));
            }
        }
        
        // 3. NEW: Fetch Draft Pick data on-demand in chunks (now efficient).
        let draftPicksMap = new Map();
        if (allPickIds.length > 0) {
            const CHUNK_SIZE = 30;
             for (let i = 0; i < allPickIds.length; i += CHUNK_SIZE) {
                const chunk = allPickIds.slice(i, i + CHUNK_SIZE);
                const picksQuery = query(collection(db, collectionNames.draftPicks), where(documentId(), 'in', chunk));
                const picksDataSnap = await getDocs(picksQuery);
                picksDataSnap.forEach(doc => draftPicksMap.set(doc.id, doc.data()));
            }
        }

        // 4. The rest of the function proceeds as normal with the efficiently fetched data.
        const teamsRecordSnap = await getDocs(query(collectionGroup(db, collectionNames.seasonalRecords), where('season', '==', activeSeasonId)));
        const teamsRecordMap = new Map(teamsRecordSnap.docs.map(doc => [doc.data().team_id, doc.data()]));
        
        const allTeamsMap = new Map(teamsSnap.docs.map(doc => {
            const staticData = doc.data();
            const seasonalData = teamsRecordMap.get(doc.id) || {};
            return [doc.id, { ...staticData, ...seasonalData }];
        }));

        container.innerHTML = '';
        let currentUserTeamId = null;
        if (currentUserId) {
            for (const [teamId, teamData] of allTeamsMap.entries()) {
                if (teamData.gm_uid === currentUserId) currentUserTeamId = teamId;
            }
        }
        
        if (currentUserTeamId && !isAdmin) {
            const myTeamData = allTeamsMap.get(currentUserTeamId);
            const buttonHtml = `<a href="/common/edit-trade-block.html?team=${currentUserTeamId}" class="edit-btn edit-my-block-btn">Edit ${myTeamData.team_name} Trade Block</a>`;
            if (pageHeader) pageHeader.insertAdjacentHTML('afterend', buttonHtml);
        }

        if (tradeBlocksSnap.empty) {
            handleEmptyState(isAdmin, currentUserTeamId, allTeamsMap);
        } else {
            handleExistingBlocks(tradeBlocksSnap, allTeamsMap, draftPicksMap, playersMap, statsMap, isAdmin, currentUserId, currentUserTeamId, activeSeasonId);
        }
        
        addUniversalClickListener(isAdmin, activeSeasonId); 

    } catch (error) {
        console.error("Error displaying trade blocks:", error);
        container.innerHTML = `<div class="error">Could not load trade blocks. ${error.message}</div>`;
    }
}
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

function handleExistingBlocks(tradeBlocksSnap, teamsMap, draftPicksMap, playersMap, statsMap, isAdmin, currentUserId, currentUserTeamId, activeSeasonId) {
    const existingBlockTeamIds = new Set();
    const FORTY_EIGHT_HOURS_AGO = Date.now() - (48 * 60 * 60 * 1000);
    
    tradeBlocksSnap.forEach(doc => {
        const teamId = doc.id;
        const blockData = doc.data();
        const teamData = teamsMap.get(teamId) || { team_name: teamId, gm_uid: null };
        
        const playersOnBlock = (blockData.on_the_block || []).sort((a, b) => b.addedOn.toMillis() - a.addedOn.toMillis());
        const picksOnBlock = (blockData.picks_available_ids || []).sort((a, b) => b.addedOn.toMillis() - a.addedOn.toMillis());
        const seekingText = blockData.seeking || '';
        const isEmpty = playersOnBlock.length === 0 && picksOnBlock.length === 0 && (seekingText.trim() === '' || seekingText.toLowerCase() === 'n/a');
        
        if (isEmpty && teamData.gm_uid !== currentUserId) {
            return; 
        }

        existingBlockTeamIds.add(teamId);

        const renderCollapsibleSection = (content, type) => {
            if (!content || content.length === 0) {
                 return (type === 'seeking') ? 'N/A' : '<ul class="trade-block-item-list"><li>N/A</li></ul>';
            }
            
            const items = (type === 'seeking') ? content.split('\n').filter(l => l.trim() !== '') : content;
            const itemCount = items.length;
            const uniqueId = `collapse-${teamId}-${type}`;

            let listContent;
            if (type === 'seeking') {
                listContent = items.join('<br>');
            } else {
                listContent = `<ul class="trade-block-item-list">${items.map(item => `<li>${item}</li>`).join('')}</ul>`;
            }

            if (itemCount <= 5) {
                return listContent;
            }
            
            return `<div id="${uniqueId}" class="collapsible-content">${listContent}</div>
                    <div class="toggle-btn" data-action="toggle-collapse" data-target="#${uniqueId}">Show More...</div>`;
        };

        
        let playersHtml = '';
        if (playersOnBlock.length > 0) {
            const playersList = playersOnBlock.map(player => {
                const pData = playersMap.get(player.id);
                const pStats = statsMap.get(player.id);
                const isNew = player.addedOn.toDate().getTime() > FORTY_EIGHT_HOURS_AGO;
                const newBadge = isNew ? `<span class="new-item-badge">New</span>` : '';

                if (!pData || !pStats) return `Player data not found`;
                return `<a href="/${activeSeasonId}/player.html?id=${player.id}">${pData.player_handle}</a> (GP: ${pStats.games_played || 0}, REL: ${pStats.rel_median ? parseFloat(pStats.rel_median).toFixed(3) : 'N/A'}, WAR: ${pStats.WAR ? pStats.WAR.toFixed(2) : 'N/A'}) ${newBadge}`;
            });
            playersHtml = `<p><strong>Players Available:</strong></p>${renderCollapsibleSection(playersList, 'players')}<hr>`;
        }
        
        let picksHtml = '';
        if (picksOnBlock.length > 0) {
            const picksList = picksOnBlock.map(pick => {
                const pickInfo = draftPicksMap.get(pick.id);
                const isNew = pick.addedOn.toDate().getTime() > FORTY_EIGHT_HOURS_AGO;
                const newBadge = isNew ? `<span class="new-item-badge">New</span>` : '';

                if (pickInfo) {
                    const originalTeamInfo = teamsMap.get(pickInfo.original_team);
                    const teamName = originalTeamInfo ? originalTeamInfo.team_name : pickInfo.original_team;
                    const ownerRecord = originalTeamInfo ? `(${(originalTeamInfo.wins || 0)}-${(originalTeamInfo.losses || 0)})` : '';
                    const round = pickInfo.round;
                    const roundSuffix = round == 1 ? 'st' : round == 2 ? 'nd' : round == 3 ? 'rd' : 'th';
                    return `S${pickInfo.season} ${teamName} ${round}${roundSuffix} ${ownerRecord} ${newBadge}`;
                }
                return `${pick.id} (Unknown Pick) ${newBadge}`;
            });
            picksHtml = `<p><strong>Picks Available:</strong></p>${renderCollapsibleSection(picksList, 'picks')}<hr>`;
        }
        
        let seekingHtml = '';
        const seekingTextTrimmed = seekingText.trim();
        if (seekingTextTrimmed && seekingTextTrimmed.toLowerCase() !== 'n/a') {
            seekingHtml = `<p><strong>Seeking:</strong><br>${renderCollapsibleSection(seekingText, 'seeking')}</p>`;
        }

        const blockHtml = `
            <div class="trade-block-card" data-team-id="${teamId}">
                <div class="trade-block-header">
                    <a href="/S7/team.html?id=${teamId}">
                        <h4><img src="/icons/${teamId}.webp" class="team-logo" onerror="this.style.display='none'">${teamData.team_name}</h4>
                    </a>
                    <button class="edit-btn" data-team-id="${teamId}" data-action="edit" style="display: none;">Edit</button>
                </div>
                <div class="trade-block-content">
                    ${playersHtml}
                    ${picksHtml}
                    ${seekingHtml}
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
        const clickTarget = event.target;
        
        if (clickTarget.dataset.action === 'toggle-collapse') {
            const targetElement = document.querySelector(clickTarget.dataset.target);
            if (targetElement) {
                const isNowExpanded = targetElement.classList.toggle('expanded');
                clickTarget.textContent = isNowExpanded ? 'Show Less' : 'Show More...';
            }
            return;
        }

        const buttonTarget = clickTarget.closest('button');
        if (!buttonTarget) return;

        const teamIdToEdit = buttonTarget.dataset.teamId;
        if (teamIdToEdit) {
            window.location.href = `/common/edit-trade-block.html?team=${teamIdToEdit}`;
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
                    buttonTarget.textContent = 'Processing...';
                    buttonTarget.disabled = true;
                    const action = httpsCallable(functions, callableName);
                    currentUser.getIdToken(true).then(() => {
                        return action();
                    }).then(result => {
                        alert(result.data.message);
                        window.location.reload();
                    }).catch(error => {
                        console.error("Function call failed:", error);
                        alert(`Error: ${error.message}`);
                        buttonTarget.textContent = buttonText;
                        buttonTarget.disabled = false;
                    });
                }
            };

            if (buttonTarget.id === 'deadline-btn') {
                handleAdminAction('clearAllTradeBlocks', 'Are you sure you want to CLEAR ALL trade blocks and activate the deadline? This cannot be undone.', 'Activate Trade Deadline');
            } else if (buttonTarget.id === 'reopen-btn') {
                handleAdminAction('reopenTradeBlocks', 'Are you sure you want to re-open trading for all teams?', 'Re-Open Trading');
            }
        }
    });
}