// /js/edit-trade-block.js

const formContainer = document.getElementById('form-container');
const editTitle = document.getElementById('edit-title');

const urlParams = new URLSearchParams(window.location.search);
const teamId = urlParams.get('team');

document.addEventListener('DOMContentLoaded', () => {
    if (!teamId) {
        formContainer.innerHTML = '<div class="error">No team specified.</div>';
    } else {
        auth.onAuthStateChanged(user => {
            if (user) {
                authorizeAndLoadForm(user, teamId);
            } else {
                window.location.href = '/login.html';
            }
        });
    }
});


async function authorizeAndLoadForm(user, teamId) {
    try {
        const [teamDoc, adminDoc, playersSnap, picksSnap, teamsSnap, blockDoc] = await Promise.all([
            db.collection("teams").doc(teamId).get(),
            db.collection("admins").doc(user.uid).get(),
            db.collection("players").where("current_team_id", "==", teamId).get(),
            db.collection("draftPicks").where("current_owner", "==", teamId).get(),
            db.collection("teams").get(), // Fetch all teams for record lookups
            db.collection("tradeblocks").doc(teamId).get()
        ]);

        const teamsMap = new Map(teamsSnap.docs.map(doc => [doc.id, doc.data()]));

        if (!teamDoc.exists) {
            formContainer.innerHTML = '<div class="error">Team not found.</div>';
            return;
        }

        const teamData = teamDoc.data();
        const hasPermission = adminDoc.exists || teamData.gm_uid === user.uid;

        if (!hasPermission) {
            formContainer.innerHTML = '<div class="error">You do not have permission to edit this trade block.</div>';
            return;
        }

        editTitle.textContent = `Edit ${teamData.team_name} Trade Block`;
        const blockData = blockDoc.exists ? blockDoc.data() : { on_the_block: [], picks_available_ids: [], seeking: '' };
        
        let availablePlayers = playersSnap.docs.map(doc => ({ handle: doc.id, ...doc.data() }));
        let availablePicks = picksSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // Sort players by WAR descending
        availablePlayers.sort((a, b) => (b.WAR || 0) - (a.WAR || 0));

        // Sort picks by season, then round
        availablePicks.sort((a, b) => {
            const seasonA = parseInt(a.season || 0);
            const seasonB = parseInt(b.season || 0);
            if (seasonA !== seasonB) {
                return seasonA - seasonB;
            }
            const roundA = parseInt(a.round || 0);
            const roundB = parseInt(b.round || 0);
            return roundA - roundB;
        });

        renderForm(blockData, availablePlayers, availablePicks, teamsMap);

    } catch (error) {
        console.error("Authorization or loading error:", error);
        formContainer.innerHTML = '<div class="error">Could not load editor.</div>';
    }
}

function renderForm(blockData, players, picks, teamsMap) {
    // Helper to format a pick description with full team name
    const formatPick = (pick) => {
        const originalTeamInfo = teamsMap.get(pick.original_team);
        const teamName = originalTeamInfo ? originalTeamInfo.team_name : pick.original_team;
        const round = pick.round;
        const roundSuffix = round == 1 ? 'st' : round == 2 ? 'nd' : round == 3 ? 'rd' : 'th';
        return `S${pick.season} ${teamName} ${round}${roundSuffix}`;
    };
    
    const playersHtml = players.map(p => `
        <tr>
            <td class="col-checkbox"><input type="checkbox" data-player-handle="${p.handle}" ${blockData.on_the_block.includes(p.handle) ? 'checked' : ''}></td>
            <td class="col-name">${p.handle}</td>
            <td class="col-stat-gp mobile-hide">${p.games_played || 0}</td>
            <td class="col-stat-small mobile-hide">${p.REL ? p.REL.toFixed(3) : 'N/A'}</td>
            <td class="col-stat-small">${p.WAR ? p.WAR.toFixed(2) : 'N/A'}</td>
        </tr>
    `).join('') || '<tr><td colspan="5" style="text-align:center;">No players on roster.</td></tr>';

    const picksHtml = picks.map(p => {
        const originalOwnerInfo = teamsMap.get(p.original_team);
        const ownerRecord = originalOwnerInfo ? `${originalOwnerInfo.wins}-${originalOwnerInfo.losses}` : 'N/A';
        
        return `
        <tr>
            <td class="col-checkbox"><input type="checkbox" data-pick-id="${p.id}" ${blockData.picks_available_ids.includes(p.id) ? 'checked' : ''}></td>
            <td class="col-name">${formatPick(p)}</td>
            <td class="col-record mobile-hide">${ownerRecord}</td>
        </tr>`
    }).join('') || '<tr><td colspan="3" style="text-align:center;">No draft picks owned.</td></tr>';

    const formHtml = `
        <form id="trade-block-form">
            <h4>Players on the Block</h4>
            <div style="max-height: 300px; overflow-y: auto; border: 1px solid #ddd; border-radius: 4px; margin-bottom: 1.5rem;">
                <table class="checklist-table">
                    <thead><tr>
                        <th class="col-checkbox">&nbsp;</th>
                        <th class="col-name">Player</th>
                        <th class="col-stat-gp mobile-hide">GP</th>
                        <th class="col-stat-small mobile-hide">REL</th>
                        <th class="col-stat-small">WAR</th>
                    </tr></thead>
                    <tbody>${playersHtml}</tbody>
                </table>
            </div>

            <h4>Draft Picks Available</h4>
            <div style="max-height: 300px; overflow-y: auto; border: 1px solid #ddd; border-radius: 4px; margin-bottom: 1.5rem;">
                <table class="checklist-table">
                     <thead><tr>
                        <th class="col-checkbox">&nbsp;</th>
                        <th class="col-name">Pick</th>
                        <th class="col-record mobile-hide">Record</th>
                     </tr></thead>
                     <tbody>${picksHtml}</tbody>
                </table>
            </div>

            <div class="form-group">
                <label for="seeking">Seeking:</label>
                <textarea id="seeking" rows="3">${blockData.seeking || ''}</textarea>
            </div>
            <button type="submit" class="edit-btn">Save Changes</button>
            <a href="/S7/trade-block.html" class="edit-btn cancel-btn">Cancel</a>
        </form>
    `;
    formContainer.innerHTML = formHtml;
    addSaveHandler();
}

function addSaveHandler() {
    const form = document.getElementById('trade-block-form');
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();

            const selectedPlayers = Array.from(document.querySelectorAll('input[data-player-handle]:checked')).map(cb => cb.dataset.playerHandle);
            const selectedPicks = Array.from(document.querySelectorAll('input[data-pick-id]:checked')).map(cb => cb.dataset.pickId);
            const seekingText = document.getElementById('seeking').value;

            const updatedData = {
                on_the_block: selectedPlayers,
                picks_available_ids: selectedPicks,
                seeking: seekingText,
                last_updated: firebase.firestore.FieldValue.serverTimestamp()
            };

            try {
                const saveButton = form.querySelector('button[type="submit"]');
                saveButton.textContent = 'Saving...';
                saveButton.disabled = true;

                await db.collection("tradeblocks").doc(teamId).set(updatedData, { merge: true });
                
                alert("Trade block saved successfully!");
                window.location.href = '/S7/trade-block.html';
            } catch (error) {
                console.error("Error saving trade block:", error);
                alert("Error: Could not save trade block. Check console for details.");
                const saveButton = form.querySelector('button[type="submit"]');
                saveButton.textContent = 'Save Changes';
                saveButton.disabled = false;
            }
        });
    }
}