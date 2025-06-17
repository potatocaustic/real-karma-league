// /js/trade-block.js

const container = document.getElementById('trade-blocks-container');

auth.onAuthStateChanged(async (user) => {
    if (user) {
        await displayAllTradeBlocks(user.uid);
    } else {
        // If not on login page, redirect
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
            db.collection("players").get() // Fetch all players for stats
        ]);

        const teamsMap = new Map(teamsSnap.docs.map(doc => [doc.id, doc.data()]));
        const draftPicksMap = new Map(draftPicksSnap.docs.map(doc => [doc.id, doc.data()]));
        const playersMap = new Map(playersSnap.docs.map(doc => [doc.id, doc.data()])); // Map players by handle

        container.innerHTML = '';

        const adminDoc = await db.collection("admins").doc(currentUserId).get();
        const isAdmin = adminDoc.exists;

        let currentUserTeamId = null;
        for (const [teamId, teamData] of teamsMap.entries()) {
            if (teamData.gm_uid === currentUserId) currentUserTeamId = teamId;
        }
        
        if (tradeBlocksSnap.empty) {
            // ... (empty state logic remains the same as before) ...
        } else {
            tradeBlocksSnap.forEach(doc => {
                const teamId = doc.id;
                const blockData = doc.data();
                const teamData = teamsMap.get(teamId) || { team_name: teamId };
                
                const picksWithDescriptions = (blockData.picks_available_ids || []).map(pickId => {
                    const pickInfo = draftPicksMap.get(pickId);
                    return pickInfo ? pickInfo.description : `${pickId} (Unknown Pick)`;
                });
                
                // NEW: Format players with their stats
                const playersWithStats = (blockData.on_the_block || []).map(handle => {
                    const p = playersMap.get(handle);
                    if (!p) return `<li>${handle} (stats not found)</li>`;
                    return `<li>${handle} (GP: ${p.games_played || 0}, REL: ${p.REL ? parseFloat(p.REL).toFixed(3) : 'N/A'}, WAR: ${p.WAR ? parseFloat(p.WAR).toFixed(2) : 'N/A'})</li>`;
                }).join('');

                const blockHtml = `
                    <div class="trade-block-card" data-team-id="${teamId}">
                        <div class="trade-block-header">
                            <h4><img src="/S7/icons/${teamId}.webp" class="team-logo" style="margin-right: 0.5rem;" onerror="this.style.display='none'">${teamData.team_name}</h4>
                            <button id="edit-btn-${teamId}" class="edit-btn" style="display: none;">Edit</button>
                        </div>
                        <div class="trade-block-content">
                            <p><strong>On The Block:</strong></p><ul>${playersWithStats || 'N/A'}</ul>
                            <hr>
                            <p><strong>Picks Available:</strong><br>${picksWithDescriptions.join('<br>') || 'N/A'}</p>
                            <hr>
                            <p><strong>Seeking:</strong><br>${blockData.seeking || 'N/A'}</p>
                        </div>
                    </div>
                `;
                container.innerHTML += blockHtml;
            });
            // ... (rest of the logic for showing buttons and adding event listeners remains the same) ...
        }
        // ... (rest of the function) ...

    } catch (error) {
        console.error("Error displaying trade blocks:", error);
        container.innerHTML = '<div class="error">Could not load trade blocks. Please try again later.</div>';
    }
}