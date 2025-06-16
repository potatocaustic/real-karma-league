// trade-block.js

// Get a reference to the container element
const container = document.getElementById('trade-blocks-container');

// First, check if a user is logged in.
auth.onAuthStateChanged(async (user) => {
    if (user) {
        // User is logged in, proceed to fetch and display data.
        console.log("Logged in user:", user.uid);
        await displayAllTradeBlocks(user.uid);
    } else {
        // No user is signed in. Redirect to the login page.
        console.log("No user logged in. Redirecting...");
        window.location.href = 'login.html';
    }
});

async function displayAllTradeBlocks(currentUserId) {
    try {
        // Fetch all necessary data in parallel for efficiency
        const [tradeBlocksSnap, teamsSnap, draftPicksSnap] = await Promise.all([
            db.collection("tradeblocks").get(),
            db.collection("teams").get(),
            db.collection("draftPicks").get()
        ]);

        // Convert snapshots to easy-to-use Maps for quick lookups
        const teamsMap = new Map(teamsSnap.docs.map(doc => [doc.id, doc.data()]));
        const draftPicksMap = new Map(draftPicksSnap.docs.map(doc => [doc.id, doc.data()]));

        // Clear the "Loading..." message
        container.innerHTML = '';

        if (tradeBlocksSnap.empty) {
            container.innerHTML = '<p>No trade blocks have been set up yet.</p>';
            return;
        }

        // Check if the current user is an admin
        const adminDoc = await db.collection("admins").doc(currentUserId).get();
        const isAdmin = adminDoc.exists;

        // Loop through each team's trade block document
        tradeBlocksSnap.forEach(doc => {
            const teamId = doc.id;
            const blockData = doc.data();
            const teamData = teamsMap.get(teamId) || { team_name: teamId };

            // For each pick ID, look up its description
            const picksWithDescriptions = blockData.picks_available_ids.map(pickId => {
                const pickInfo = draftPicksMap.get(pickId);
                return pickInfo ? pickInfo.description : `${pickId} (Unknown Pick)`;
            });

            // Build the HTML for this team's block
            const blockHtml = `
                <div class="team-card" style="margin-bottom: 2rem;">
                    <div class="team-header">
                        <h4>${teamData.team_name}</h4>
                        <button id="edit-btn-${teamId}" class="toggle-btn" style="display: none;">Edit</button>
                    </div>
                    <div class="team-picks" style="padding: 1rem;">
                        <p><strong>On The Block:</strong><br>${blockData.on_the_block.join('<br>') || 'N/A'}</p>
                        <hr style="margin: 1rem 0;">
                        <p><strong>Picks Available:</strong><br>${picksWithDescriptions.join('<br>') || 'N/A'}</p>
                        <hr style="margin: 1rem 0;">
                        <p><strong>Seeking:</strong><br>${blockData.seeking || 'N/A'}</p>
                    </div>
                </div>
            `;
            container.innerHTML += blockHtml;

            // Now, check if we should show the "Edit" button for this block
            const gm_uid = teamData.gm_uid;
            if (isAdmin || (gm_uid && gm_uid === currentUserId)) {
                document.getElementById(`edit-btn-${teamId}`).style.display = 'inline-block';
            }
        });

        // Add one event listener to the container to handle all edit clicks
        container.addEventListener('click', (event) => {
            if (event.target.id && event.target.id.startsWith('edit-btn-')) {
                const teamIdToEdit = event.target.id.replace('edit-btn-', '');
                // Redirect to the edit page with the team ID in the URL
                window.location.href = `edit-trade-block.html?team=${teamIdToEdit}`;
            }
        });

    } catch (error) {
        console.error("Error displaying trade blocks:", error);
        container.innerHTML = '<div class="error">Could not load trade blocks. Please try again later.</div>';
    }
}