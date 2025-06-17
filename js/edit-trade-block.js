// /js/edit-trade-block.js

const formContainer = document.getElementById('form-container');
const editTitle = document.getElementById('edit-title');

const urlParams = new URLSearchParams(window.location.search);
const teamId = urlParams.get('team');

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

async function authorizeAndLoadForm(user, teamId) {
    try {
        const [teamDoc, adminDoc, playersSnap, picksSnap, blockDoc] = await Promise.all([
            db.collection("teams").doc(teamId).get(),
            db.collection("admins").doc(user.uid).get(),
            db.collection("players").where("current_team_id", "==", teamId).get(),
            db.collection("draftPicks").where("current_owner", "==", teamId).get(),
            db.collection("tradeblocks").doc(teamId).get()
        ]);

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
        
        const availablePlayers = playersSnap.docs.map(doc => ({ handle: doc.id, ...doc.data() }));
        const availablePicks = picksSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        renderForm(blockData, availablePlayers, availablePicks);

    } catch (error) {
        console.error("Authorization or loading error:", error);
        formContainer.innerHTML = '<div class="error">Could not load editor.</div>';
    }
}

function renderForm(blockData, players, picks) {
    // Helper to format a pick description
    const formatPick = (pick) => {
        const teamName = pick.original_team; // In this context, showing original owner is good
        const round = pick.round;
        return `S${pick.season} ${teamName} ${round}${round == 1 ? 'st' : round == 2 ? 'nd' : round == 3 ? 'rd' : 'th'}`;
    };
    
    const playersHtml = players.map(p => `
        <tr>
            <td><input type="checkbox" data-player-handle="${p.handle}" ${blockData.on_the_block.includes(p.handle) ? 'checked' : ''}></td>
            <td>${p.handle}</td>
            <td class="mobile-hide">${p.games_played || 0}</td>
            <td class="mobile-hide">${p.REL ? parseFloat(p.REL).toFixed(3) : 'N/A'}</td>
            <td>${p.WAR ? parseFloat(p.WAR).toFixed(2) : 'N/A'}</td>
        </tr>
    `).join('');

    const picksHtml = picks.map(p => `
        <tr>
            <td><input type="checkbox" data-pick-id="${p.id}" ${blockData.picks_available_ids.includes(p.id) ? 'checked' : ''}></td>
            <td>${formatPick(p)}</td>
        </tr>
    `).join('');

    const formHtml = `
        <form id="trade-block-form">
            <h4>Players on the Block</h4>
            <div style="max-height: 300px; overflow-y: auto; border: 1px solid #ddd; border-radius: 4px; margin-bottom: 1.5rem;">
                <table class="checklist-table">
                    <thead><tr><th>&nbsp;</th><th>Player</th><th class="mobile-hide">GP</th><th class="mobile-hide">REL</th><th>WAR</th></tr></thead>
                    <tbody>${playersHtml}</tbody>
                </table>
            </div>

            <h4>Draft Picks Available</h4>
            <div style="max-height: 300px; overflow-y: auto; border: 1px solid #ddd; border-radius: 4px; margin-bottom: 1.5rem;">
                <table class="checklist-table">
                     <thead><tr><th>&nbsp;</th><th>Pick</th></tr></thead>
                     <tbody>${picksHtml}</tbody>
                </table>
            </div>

            <div class="form-group">
                <label for="seeking">Seeking:</label>
                <textarea id="seeking" rows="3">${blockData.seeking}</textarea>
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
            await db.collection("tradeblocks").doc(teamId).set(updatedData, { merge: true });
            alert("Trade block saved successfully!");
            window.location.href = '/S7/trade-block.html';
        } catch (error) {
            console.error("Error saving trade block:", error);
            alert("Error: Could not save trade block.");
        }
    });
}