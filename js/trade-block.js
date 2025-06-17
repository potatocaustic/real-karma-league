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

        // --- NEW: Logic for an empty trade block collection ---
        if (tradeBlocksSnap.empty) {
            container.innerHTML = '<p style="text-align: center; margin-bottom: 1.5rem;">No trade blocks have been set up yet.</p>';
            
            if (isAdmin) {
                // If user is an admin, show a list of all teams with a "Set Up" button for each.
                let adminSetupHtml = '<div class="trade-blocks-container"><h4>Admin: Create a Trade Block</h4>';
                teamsMap.forEach((team, teamId) => {
                    if (teamId !== "FA") { // Exclude Free Agents team if it exists
                        adminSetupHtml += `
                            <div class="trade-block-card" style="padding: 1rem; display: flex; justify-content: space-between; align-items: center;">
                                <span>${team.team_name}</span>
                                <button class="edit-btn" id="setup-btn-${teamId}">Set Up Block</button>
                            </div>
                        `;
                    }
                });
                adminSetupHtml += '</div>';
                container.innerHTML += adminSetupHtml;

            } else if (currentUserTeamId) {
                // If user is a regular GM, show only one button for their own team.
                const setupButtonHtml = `
                    <div style="text-align: center; border-top: 2px solid #ddd; padding-top: 2rem;">
                        <h4>Your trade block is empty.</h4>
                        <button id="setup-btn-${currentUserTeamId}" class="edit-btn">Set Up My Trade Block</button>
                    </div>
                `;
                container.innerHTML += setupButtonHtml;
            }
            
        } else {
            // --- This logic runs if trade blocks DO exist ---
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

            // Show "Edit" buttons based on permissions
            teamsMap.forEach((teamData, teamId) => {
                const editButton = document.getElementById(`edit-btn-${teamId}`);
                if(editButton) {
                    if (isAdmin || teamData.gm_uid === currentUserId) {
                        editButton.style.display = 'inline-block';
                    }
                }
            });

            // Show "Set Up" button if the GM's block doesn't exist but others do
            const userBlockRendered = document.querySelector(`.trade-block-card[data-team-id="${currentUserTeamId}"]`);
            if (currentUserTeamId && !userBlockRendered) {
                const setupButtonHtml = `...`; // Same as before
                container.innerHTML += setupButtonHtml;
            }
        }
        
        // Add a single event listener for all dynamically created buttons
        container.addEventListener('click', (event) => {
            const target = event.target;
            if (target.tagName === 'BUTTON') {
                const targetId = target.id;
                let teamIdToEdit = null;

                if (targetId.startsWith('edit-btn-')) {
                    teamIdToEdit = targetId.replace('edit-btn-', '');
                } else if (targetId.startsWith('setup-btn-')) {
                    teamIdToEdit = targetId.replace('setup-btn-', '');
                }

                if (teamIdToEdit) {
                    window.location.href = `/S7/edit-trade-block.html?team=${teamIdToEdit}`;
                }
            }
        });

    } catch (error) {
        console.error("Error displaying trade blocks:", error);
        container.innerHTML = '<div class="error">Could not load trade blocks. Please try again later.</div>';
    }
}