// /js/trade-block.js

const container = document.getElementById('trade-blocks-container');

auth.onAuthStateChanged(async (user) => {
    if (user) {
        await displayAllTradeBlocks(user.uid);
    } else {
        if (!window.location.pathname.endsWith('login.html')) {
            window.location.href = '/login.html';
        }
    }
});

async function displayAllTradeBlocks(currentUserId) {
    try {
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

        const adminDoc = await db.collection("admins").doc(currentUserId).get();
        const isAdmin = adminDoc.exists;

        let currentUserTeamId = null;
        for (const [teamId, teamData] of teamsMap.entries()) {
            if (teamData.gm_uid === currentUserId) currentUserTeamId = teamId;
        }

        if (tradeBlocksSnap.empty) {
            handleEmptyState(isAdmin, currentUserTeamId, teamsMap);
        } else {
            handleExistingBlocks(tradeBlocksSnap, teamsMap, draftPicksMap, playersMap, isAdmin, currentUserId, currentUserTeamId);
        }
        
        addUniversalClickListener(currentUserTeamId);

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
            if (teamId.toUpperCase() !== "FA") {
                adminSetupHtml += `
                    <div class="trade-block-card" style="padding: 1rem; display: flex; justify-content: space-between; align-items: center;">
                        <span><img src="/S7/icons/${teamId}.webp" class="team-logo" style="margin-right: 0.5rem;" onerror="this.style.display=\'none\'">${team.team_name}</span>
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
    tradeBlocksSnap.forEach(doc => {
        const teamId = doc.id;
        const blockData = doc.data();
        const teamData = teamsMap.get(teamId) || { team_name: teamId };
        
        const picksWithDescriptions = (blockData.picks_available_ids || []).map(pickId => {
            const pickInfo = draftPicksMap.get(pickId);
            return pickInfo ? pickInfo.description : `${pickId} (Unknown Pick)`;
        }).join('<br>') || 'N/A';

        const playersWithStats = (blockData.on_the_block || []).map(handle => {
            const p = playersMap.get(handle);
            if (!p) return `<li>${handle} (stats not found)</li>`;
            return `<li>${handle} (GP: ${p.games_played || 0}, REL: ${p.REL ? parseFloat(p.REL).toFixed(3) : 'N/A'}, WAR: ${p.WAR ? parseFloat(p.WAR).toFixed(2) : 'N/A'})</li>`;
        }).join('') || '<li>N/A</li>';

        const blockHtml = `
            <div class="trade-block-card" data-team-id="${teamId}">
                <div class="trade-block-header">
                    <h4><img src="/S7/icons/${teamId}.webp" class="team-logo" style="margin-right: 0.5rem;" onerror="this.style.display='none'">${teamData.team_name}</h4>
                    <button class="edit-btn" data-team-id="${teamId}" data-action="edit" style="display: none;">Edit</button>
                </div>
                <div class="trade-block-content">
                    <p><strong>On The Block:</strong></p><ul>${playersWithStats}</ul><hr>
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
}

function addUniversalClickListener() {
    container.addEventListener('click', (event) => {
        const target = event.target.closest('button');
        if (target && target.dataset.teamId) {
            const teamIdToEdit = target.dataset.teamId;
            window.location.href = `/S7/edit-trade-block.html?team=${teamIdToEdit}`;
        }
    });
}