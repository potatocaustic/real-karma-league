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

        // --- NEW LOGIC: Find the team ID of the currently logged-in GM ---
        let currentUserTeamId = null;
        for (const [teamId, teamData] of teamsMap.entries()) {
            if (teamData.gm_uid === currentUserId) {
                currentUserTeamId = teamId;
                break; // Found the user's team, no need to loop further
            }
        }
        
        // --- NEW LOGIC: Keep track if we find the user's trade block ---
        let userBlockWasFound = false;

        if (tradeBlocksSnap.empty) {
            container.innerHTML = '<p style="text-align: center; margin-bottom: 1.5rem;">No trade blocks have been set up yet.</p>';
        } else {
            tradeBlocksSnap.forEach(doc => {
                const teamId = doc.id;
                const blockData = doc.data();
                const teamData = teamsMap.get(teamId) || { team_name: teamId };

                const picksWithDescriptions = blockData.picks_available_ids.map(pickId => {
                    const pickInfo = draftPicksMap.get(pickId);
                    return pickInfo ? pickInfo.description : `${pickId} (Unknown Pick)`;
                });

                const blockHtml = `
                    <div class="trade-block-card">
                        <div class="trade-block-header">
                            <h4>${teamData.team_name}</h4>
                            <button id="edit-btn-${teamId}" class="edit-btn" style="display: none;">Edit</button>
                        </div>
                        <div class="trade-block-content">
                            <p><strong>On The Block:</strong><br>${blockData.on_the_block.join('<br>') || 'N/A'}</p>
                            <hr>
                            <p><strong>Picks Available:</strong><br>${picksWithDescriptions.join('<br>') || 'N/A'}</p>
                            <hr>
                            <p><strong>Seeking:</strong><br>${blockData.seeking || 'N/A'}</p>
                        </div>
                    </div>
                `;
                container.innerHTML += blockHtml;

                const gm_uid = teamData.gm_uid;
                if (isAdmin || (gm_uid && gm_uid === currentUserId)) {
                    document.getElementById(`edit-btn-${teamId}`).style.display = 'inline-block';
                    if (!isAdmin) { // Don't count the admin as finding their "own" block unless they are also a GM
                        userBlockWasFound = true;
                    }
                }
            });
        }

        // --- NEW LOGIC: If the user is a GM and their block wasn't found, add a "Set Up" button ---
        if (currentUserTeamId && !userBlockWasFound && !isAdmin) {
            const setupButtonHtml = `
                <div style="text-align: center; border-top: 2px solid #ddd; padding-top: 2rem;">
                    <h4>Your trade block is empty.</h4>
                    <button id="setup-btn" class="edit-btn">Set Up My Trade Block</button>
                </div>
            `;
            container.innerHTML += setupButtonHtml;
        }

        // Add one event listener to the container to handle all clicks
        container.addEventListener('click', (event) => {
            const targetId = event.target.id;
            if (targetId && targetId.startsWith('edit-btn-')) {
                const teamIdToEdit = targetId.replace('edit-btn-', '');
                window.location.href = `/S7/edit-trade-block.html?team=${teamIdToEdit}`;
            }
            if (targetId === 'setup-btn' && currentUserTeamId) {
                window.location.href = `/S7/edit-trade-block.html?team=${currentUserTeamId}`;
            }
        });

    } catch (error) {
        console.error("Error displaying trade blocks:", error);
        container.innerHTML = '<div class="error">Could not load trade blocks. Please try again later.</div>';
    }
}