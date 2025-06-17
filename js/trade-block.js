// js/trade-block.js

const container = document.getElementById('trade-blocks-container');

auth.onAuthStateChanged(async (user) => {
    if (user) {
        console.log("Logged in user:", user.uid);
        await displayAllTradeBlocks(user.uid);
    } else {
        console.log("No user logged in. Redirecting...");
        window.location.href = '/login.html';
    }
});

async function displayAllTradeBlocks(currentUserId) {
    try {
        const [tradeBlocksSnap, teamsSnap, draftPicksSnap] = await Promise.all([
            db.collection("tradeblocks").get(),
            db.collection("teams").get(),
            db.collection("draftPicks").get()
        ]);

        const teamsMap = new Map(teamsSnap.docs.map(doc => [doc.id, doc.data()]));
        const draftPicksMap = new Map(draftPicksSnap.docs.map(doc => [doc.id, doc.data()]));

        container.innerHTML = '';

        // --- STEP 1: Determine user's permission level upfront ---
        const adminDoc = await db.collection("admins").doc(currentUserId).get();
        const isAdmin = adminDoc.exists;
        console.log(`Is user admin? ${isAdmin}`);

        let currentUserTeamId = null;
        for (const [teamId, teamData] of teamsMap.entries()) {
            if (teamData.gm_uid === currentUserId) {
                currentUserTeamId = teamId;
                break;
            }
        }
        console.log(`User is GM of team: ${currentUserTeamId}`);

        // --- STEP 2: Render all trade blocks that exist ---
        if (tradeBlocksSnap.empty) {
            container.innerHTML = '<p style="text-align: center; margin-bottom: 1.5rem;">No trade blocks have been set up yet.</p>';
        } else {
            tradeBlocksSnap.forEach(doc => {
                const teamId = doc.id;
                const blockData = doc.data();
                const teamData = teamsMap.get(teamId) || { team_name: teamId };

                const picksWithDescriptions = (blockData.picks_available_ids || []).map(pickId => {
                    const pickInfo = draftPicksMap.get(pickId);
                    return pickInfo ? pickInfo.description : `${pickId} (Unknown Pick)`;
                });

                const blockHtml = `
                    <div class="trade-block-card" data-team-id="${teamId}">
                        <div class="trade-block-header">
                            <h4>${teamData.team_name}</h4>
                            <button id="edit-btn-${teamId}" class="edit-btn" style="display: none;">Edit</button>
                        </div>
                        <div class="trade-block-content">
                            <p><strong>On The Block:</strong><br>${(blockData.on_the_block || []).join('<br>') || 'N/A'}</p>
                            <hr>
                            <p><strong>Picks Available:</strong><br>${picksWithDescriptions.join('<br>') || 'N/A'}</p>
                            <hr>
                            <p><strong>Seeking:</strong><br>${blockData.seeking || 'N/A'}</p>
                        </div>
                    </div>
                `;
                container.innerHTML += blockHtml;
            });
        }
        
        // --- STEP 3: Show Edit buttons based on permissions ---
        // Loop through ALL teams, not just ones with trade blocks.
        teamsMap.forEach((teamData, teamId) => {
            // Find the button for this team IF a block was rendered for it.
            const editButton = document.getElementById(`edit-btn-${teamId}`);
            if(editButton) {
                // Show the button if the user is an admin OR if they are the designated GM for this team.
                if (isAdmin || teamData.gm_uid === currentUserId) {
                    editButton.style.display = 'inline-block';
                }
            }
        });
        
        // --- STEP 4: Show the "Set Up" button if the user is a GM without a block ---
        const userBlockRendered = document.querySelector(`.trade-block-card[data-team-id="${currentUserTeamId}"]`);
        if (currentUserTeamId && !userBlockRendered) {
             const setupButtonHtml = `
                <div style="text-align: center; border-top: 2px solid #ddd; padding-top: 2rem;">
                    <h4>Your trade block is empty.</h4>
                    <button id="setup-btn" class="edit-btn">Set Up My Trade Block</button>
                </div>
            `;
            container.innerHTML += setupButtonHtml;
        }

        // --- STEP 5: Add a single event listener for all buttons ---
        container.addEventListener('click', (event) => {
            const target = event.target;
            if (target.id && target.id.startsWith('edit-btn-')) {
                const teamIdToEdit = target.id.replace('edit-btn-', '');
                window.location.href = `/S7/edit-trade-block.html?team=${teamIdToEdit}`;
            }
            if (target.id === 'setup-btn' && currentUserTeamId) {
                window.location.href = `/S7/edit-trade-block.html?team=${currentUserTeamId}`;
            }
        });

    } catch (error) {
        console.error("Error displaying trade blocks:", error);
        container.innerHTML = '<div class="error">Could not load trade blocks. Please try again later.</div>';
    }
}