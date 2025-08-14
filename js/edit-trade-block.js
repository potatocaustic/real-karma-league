// /js/edit-trade-block.js

// MODIFIED: Import new config and helpers from the centralized firebase-init.js
import { 
    auth, 
    db,
    onAuthStateChanged,
    collection,
    collectionGroup,
    doc,
    getDoc, 
    getDocs, 
    query, 
    where, 
    serverTimestamp, 
    setDoc, 
    deleteDoc,
    limit,
    documentId,
    collectionNames // NEW: import the collection name configuration
} from './firebase-init.js';

const formContainer = document.getElementById('form-container');
const editTitle = document.getElementById('edit-title');

const urlParams = new URLSearchParams(window.location.search);
const teamId = urlParams.get('team');

// NEW: Helper to get the active season ID
async function getActiveSeasonId() {
    const q = query(collection(db, collectionNames.seasons), where("status", "==", "active"), limit(1));
    const querySnapshot = await getDocs(q);
    if (querySnapshot.empty) {
        throw new Error("No active season found.");
    }
    return querySnapshot.docs[0].id;
}

document.addEventListener('DOMContentLoaded', () => {
    if (!teamId) {
        formContainer.innerHTML = '<div class="error">No team specified.</div>';
        return;
    }
    
    onAuthStateChanged(auth, user => {
        if (user) {
            authorizeAndLoadForm(user, teamId);
        } else {
            window.location.href = '/login.html';
        }
    });
});


// MODIFIED: This function is completely rewritten to use V2 data sources.
async function authorizeAndLoadForm(user, teamId) {
    try {
        const activeSeasonId = await getActiveSeasonId();

        // Define references to the new V2 collections
        const teamRef = doc(db, collectionNames.teams, teamId);
        const teamRecordRef = doc(teamRef, collectionNames.seasonalRecords, activeSeasonId);
        const userAdminRef = doc(db, collectionNames.users, user.uid);
        const playersQuery = query(collection(db, collectionNames.players), where("current_team_id", "==", teamId));
        const picksQuery = query(collection(db, collectionNames.draftPicks), where("current_owner", "==", teamId));
        const allTeamsQuery = collection(db, collectionNames.teams);
        const blockRef = doc(db, "tradeblocks", teamId);

        // Fetch all base data in parallel
        const [teamDoc, teamRecordDoc, adminDoc, playersSnap, picksSnap, allTeamsSnap, blockDoc] = await Promise.all([
            getDoc(teamRef),
            getDoc(teamRecordRef),
            getDoc(userAdminRef),
            getDocs(playersQuery),
            getDocs(picksSnap),
            getDocs(allTeamsQuery),
            getDoc(blockRef)
        ]);

        if (!teamDoc.exists()) {
            formContainer.innerHTML = '<div class="error">Team not found.</div>';
            return;
        }

        const teamData = teamDoc.data();
        const teamRecordData = teamRecordDoc.exists() ? teamRecordDoc.data() : {};
        const isAdmin = adminDoc.exists() && adminDoc.data().role === 'admin';
        const hasPermission = isAdmin || teamData.gm_uid === user.uid;

        if (!hasPermission) {
            formContainer.innerHTML = '<div class="error">You do not have permission to edit this trade block.</div>';
            return;
        }

        // Fetch seasonal records for all teams to build a map for pick formatting
        const teamsRecordSnap = await getDocs(query(collectionGroup(db, collectionNames.seasonalRecords), where('season', '==', activeSeasonId)));
        const teamsMap = new Map(teamsRecordSnap.docs.map(doc => [doc.data().team_id, doc.data()]));
        
        editTitle.textContent = `Edit ${teamRecordData.team_name || teamId} Trade Block`;
        const blockData = blockDoc.exists() ? blockDoc.data() : { on_the_block: [], picks_available_ids: [], seeking: '' };
        
        // Process players and fetch their seasonal stats
        const playerIds = playersSnap.docs.map(doc => doc.id);
        let availablePlayers = [];
        if (playerIds.length > 0) {
            const playerStatsPaths = playerIds.map(id => `${collectionNames.players}/${id}/${collectionNames.seasonalStats}/${activeSeasonId}`);
            const statsQuery = query(collectionGroup(db, collectionNames.seasonalStats), where(documentId(), 'in', playerStatsPaths));
            const statsSnap = await getDocs(statsQuery);
            const statsMap = new Map(statsSnap.docs.map(doc => [doc.ref.parent.parent.id, doc.data()]));
            
            availablePlayers = playersSnap.docs.map(playerDoc => {
                const pData = playerDoc.data();
                const pStats = statsMap.get(playerDoc.id) || {};
                return { id: playerDoc.id, ...pData, ...pStats };
            });
        }
        
        let availablePicks = picksSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        availablePlayers.sort((a, b) => (b.WAR || 0) - (a.WAR || 0));

        availablePicks.sort((a, b) => {
            const seasonA = parseInt(a.season || 0);
            const seasonB = parseInt(b.season || 0);
            if (seasonA !== seasonB) return seasonA - seasonB;
            
            const roundA = parseInt(a.round || 0);
            const roundB = parseInt(b.round || 0);
            return roundA - roundB;
        });

        // NEW: Pass the team's gm_uid to the render function so it can be saved with the block
        renderForm(blockData, availablePlayers, availablePicks, teamsMap, teamData.gm_uid);

    } catch (error) {
        console.error("Authorization or loading error:", error);
        formContainer.innerHTML = `<div class="error">Could not load editor. ${error.message}</div>`;
    }
}

// MODIFIED: Accepts gmUid to pass to the save handler
function renderForm(blockData, players, picks, teamsMap, gmUid) {
    const formatPick = (pick) => {
        const originalTeamInfo = teamsMap.get(pick.original_team);
        const teamName = originalTeamInfo ? originalTeamInfo.team_name : pick.original_team;
        const round = pick.round;
        const roundSuffix = round == 1 ? 'st' : round == 2 ? 'nd' : round == 3 ? 'rd' : 'th';
        return `S${pick.season} ${teamName} ${round}${roundSuffix}`;
    };
    
    // MODIFIED: Player data structure has changed (id, player_handle)
    const playersHtml = players.map(p => `
        <tr>
            <td class="col-checkbox"><input type="checkbox" data-player-id="${p.id}" ${blockData.on_the_block.includes(p.id) ? 'checked' : ''}></td>
            <td class="col-name">${p.player_handle}</td>
            <td class="col-stat-gp mobile-hide">${p.games_played || 0}</td>
            <td class="col-stat-small mobile-hide">${p.rel_median ? parseFloat(p.rel_median).toFixed(3) : 'N/A'}</td>
            <td class="col-stat-small">${p.WAR ? p.WAR.toFixed(2) : 'N/A'}</td>
        </tr>
    `).join('') || '<tr><td colspan="5" style="text-align:center;">No players on roster.</td></tr>';

    const picksHtml = picks.map(p => {
        const originalOwnerInfo = teamsMap.get(p.original_team);
        const ownerRecord = originalOwnerInfo ? `${originalOwnerInfo.wins || 0}-${originalOwnerInfo.losses || 0}` : 'N/A';
        
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
            <div class="form-buttons-container">
                <button type="submit" class="edit-btn">Save Changes</button>
                <a href="/S7/trade-block.html" class="edit-btn cancel-btn">Cancel</a>
            </div>
        </form>
    `;
    formContainer.innerHTML = formHtml;
    // MODIFIED: Pass gmUid to save handler
    addSaveHandler(gmUid);
}

// MODIFIED: Accepts gmUid to include in the saved document
function addSaveHandler(gmUid) {
    const form = document.getElementById('trade-block-form');
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();

            // MODIFIED: Selector now targets data-player-id
            const selectedPlayers = Array.from(document.querySelectorAll('input[data-player-id]:checked')).map(cb => cb.dataset.playerId);
            const selectedPicks = Array.from(document.querySelectorAll('input[data-pick-id]:checked')).map(cb => cb.dataset.pickId);
            const seekingText = document.getElementById('seeking').value.trim();

            const isBlockEmpty = selectedPlayers.length === 0 && selectedPicks.length === 0 && seekingText === '';

            const saveButton = form.querySelector('button[type="submit"]');
            saveButton.textContent = 'Saving...';
            saveButton.disabled = true;

            try {
                const tradeBlockRef = doc(db, "tradeblocks", teamId);

                if (isBlockEmpty) {
                    await deleteDoc(tradeBlockRef);
                    alert("Trade block cleared and removed successfully!");
                } else {
                    // MODIFIED: The data saved now includes the gm_uid to satisfy security rules
                    const updatedData = {
                        gm_uid: gmUid, // NEW
                        on_the_block: selectedPlayers,
                        picks_available_ids: selectedPicks,
                        seeking: seekingText,
                        last_updated: serverTimestamp()
                    };
                    await setDoc(tradeBlockRef, updatedData, { merge: true });
                    alert("Trade block saved successfully!");
                }
                
                window.location.href = '/S7/trade-block.html';

            } catch (error) {
                console.error("Error saving/deleting trade block:", error);
                alert("Error: Could not save trade block. Check console for details.");
                saveButton.textContent = 'Save Changes';
                saveButton.disabled = false;
            }
        });
    }
}
