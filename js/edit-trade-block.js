// edit-trade-block.js

const formContainer = document.getElementById('form-container');
const editTitle = document.getElementById('edit-title');

// Get the team ID from the URL (e.g., from "?team=AVI")
const urlParams = new URLSearchParams(window.location.search);
const teamId = urlParams.get('team');

// Immediately check if a team ID was provided in the URL
if (!teamId) {
    formContainer.innerHTML = '<div class="error">No team specified.</div>';
} else {
    // Check for logged-in user
    auth.onAuthStateChanged(user => {
        if (user) {
            // Verify this user has permission to edit this specific block
            authorizeAndLoadForm(user, teamId);
        } else {
            // Not logged in, redirect to login
            window.location.href = 'login.html';
        }
    });
}

async function authorizeAndLoadForm(user, teamId) {
    try {
        // Check for admin or correct GM
        const teamDoc = await db.collection("teams").doc(teamId).get();
        const adminDoc = await db.collection("admins").doc(user.uid).get();

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

        // Permission granted! Now, fetch the trade block data
        editTitle.textContent = `Edit ${teamData.team_name} Trade Block`;
        const blockDoc = await db.collection("tradeblocks").doc(teamId).get();
        const blockData = blockDoc.exists ? blockDoc.data() : { on_the_block: [], picks_available_ids: [], seeking: '' };

        // Render the form and pre-fill it with data
        renderForm(blockData);

    } catch (error) {
        console.error("Authorization or loading error:", error);
        formContainer.innerHTML = '<div class="error">Could not load editor.</div>';
    }
}

function renderForm(data) {
    // Using .join('\n') to put each item on a new line in the textarea
    const formHtml = `
        <form id="trade-block-form">
            <div class="filter-group">
                <label for="on-the-block">Players on the Block (one per line):</label>
                <textarea id="on-the-block" rows="5">${data.on_the_block.join('\n')}</textarea>
            </div>
            <div class="filter-group">
                <label for="picks-available">Pick IDs Available (one per line):</label>
                <textarea id="picks-available" rows="5">${data.picks_available_ids.join('\n')}</textarea>
            </div>
            <div class="filter-group">
                <label for="seeking">Seeking:</label>
                <textarea id="seeking" rows="3">${data.seeking}</textarea>
            </div>
            <button type="submit" class="toggle-btn active">Save Changes</button>
            <a href="trade-block.html" class="toggle-btn">Cancel</a>
        </form>
    `;
    formContainer.innerHTML = formHtml;

    // Add the save logic after the form is on the page
    addSaveHandler();
}

function addSaveHandler() {
    const form = document.getElementById('trade-block-form');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        // Convert the textarea text back into clean arrays
        const players = document.getElementById('on-the-block').value.split('\n').map(s => s.trim()).filter(Boolean);
        const picks = document.getElementById('picks-available').value.split('\n').map(s => s.trim()).filter(Boolean);
        const seekingText = document.getElementById('seeking').value;

        const updatedData = {
            on_the_block: players,
            picks_available_ids: picks,
            seeking: seekingText,
            last_updated: firebase.firestore.FieldValue.serverTimestamp()
        };

        try {
            // Attempt to save the data. Firestore security rules will do the final validation.
            await db.collection("tradeblocks").doc(teamId).set(updatedData, { merge: true });
            alert("Trade block saved successfully!");
            window.location.href = 'trade-block.html';
        } catch (error) {
            console.error("Error saving trade block:", error);
            alert("Error: Could not save trade block. You may not own one of the assets listed. Please check your entries and try again.");
        }
    });
}