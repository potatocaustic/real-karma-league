// /js/edit-trade-block.js

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
    collectionNames,
    Timestamp
} from './firebase-init.js';

const formContainer = document.getElementById('form-container');
const editTitle = document.getElementById('edit-title');

const urlParams = new URLSearchParams(window.location.search);
const teamId = urlParams.get('team');

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
            window.location.href = '../login.html';
        }
    });
});

async function authorizeAndLoadForm(user, teamId) {
    try {
        const activeSeasonId = await getActiveSeasonId();

        // Define references to the new V2 collections
        const teamRef = doc(db, collectionNames.teams, teamId);
        const teamRecordRef = doc(teamRef, collectionNames.seasonalRecords, activeSeasonId);
        const userAdminRef = doc(db, collectionNames.users, user.uid);
        const playersQuery = query(collection(db, collectionNames.players), where("current_team_id", "==", teamId));
        const picksQuery = query(collection(db, collectionNames.draftPicks), where("current_owner", "==", teamId));
        // MODIFIED: Removed the inefficient 'allTeamsQuery'
        const blockRef = doc(db, collectionNames.tradeblocks, teamId);

        // MODIFIED: Removed 'getDocs(allTeamsQuery)' and 'allTeamsSnap' to make the data fetch more efficient
        const [teamDoc, teamRecordDoc, adminDoc, playersSnap, picksSnap, blockDoc] = await Promise.all([
            getDoc(teamRef),
            getDoc(teamRecordRef),
            getDoc(userAdminRef),
            getDocs(playersQuery),
            getDocs(picksQuery),
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

        // Fetch seasonal records for all teams (this is necessary to format pick descriptions)
        const teamsRecordSnap = await getDocs(query(collectionGroup(db, collectionNames.seasonalRecords), where('season', '==', activeSeasonId)));
        const teamsMap = new Map(teamsRecordSnap.docs.map(doc => [doc.data().team_id, doc.data()]));
        
        editTitle.textContent = `Edit ${teamRecordData.team_name || teamId} Trade Block`;
        const blockData = blockDoc.exists() ? blockDoc.data() : { on_the_block: [], picks_available_ids: [], seeking: '' };
        
        const playerIds = playersSnap.docs.map(doc => doc.id);
        let availablePlayers = [];
        if (playerIds.length > 0) {
            // Firestore 'in' query is limited to 30, but a team roster will not exceed this.
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

        renderForm(blockData, availablePlayers, availablePicks, teamsMap, teamData.gm_uid);

    } catch (error) {
        console.error("Authorization or loading error:", error);
        formContainer.innerHTML = `<div class="error">Could not load editor. ${error.message}</div>`;
    }
}

function renderForm(blockData, players, picks, teamsMap, gmUid) {
    const formatPick = (pick) => {
        const originalTeamInfo = teamsMap.get(pick.original_team);
        const teamName = originalTeamInfo ? originalTeamInfo.team_name : pick.original_team;
        const round = pick.round;
        const roundSuffix = round == 1 ? 'st' : round == 2 ? 'nd' : round == 3 ? 'rd' : 'th';
        return `S${pick.season} ${teamName} ${round}${roundSuffix}`;
    };
    
    // MODIFIED: Read from the new data structure {id, addedOn}
    const playersOnBlockIds = (blockData.on_the_block || []).map(item => item.id);
    const picksOnBlockIds = (blockData.picks_available_ids || []).map(item => item.id);

    const playersHtml = players.map(p => `
        <tr>
            <td class="col-checkbox"><input type="checkbox" data-player-id="${p.id}" ${playersOnBlockIds.includes(p.id) ? 'checked' : ''}></td>
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
            <td class="col-checkbox"><input type="checkbox" data-pick-id="${p.id}" ${picksOnBlockIds.includes(p.id) ? 'checked' : ''}></td>
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
                        <th class="col-checkbox">&nbsp;</th><th class="col-name">Player</th><th class="col-stat-gp mobile-hide">GP</th><th class="col-stat-small mobile-hide">REL</th><th class="col-stat-small">WAR</th>
                    </tr></thead>
                    <tbody>${playersHtml}</tbody>
                </table>
            </div>

            <h4>Draft Picks Available</h4>
            <div style="max-height: 300px; overflow-y: auto; border: 1px solid #ddd; border-radius: 4px; margin-bottom: 1.5rem;">
                <table class="checklist-table">
                     <thead><tr>
                        <th class="col-checkbox">&nbsp;</th><th class="col-name">Pick</th><th class="col-record mobile-hide">Record</th>
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
                <a href="/common/trade-block.html" class="edit-btn cancel-btn">Cancel</a>
            </div>
        </form>
    `;
    formContainer.innerHTML = formHtml;
    addSaveHandler(gmUid);
}
function addSaveHandler(gmUid) {
    const form = document.getElementById('trade-block-form');
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();

            const selectedPlayerIds = new Set(Array.from(document.querySelectorAll('input[data-player-id]:checked')).map(cb => cb.dataset.playerId));
            const selectedPickIds = new Set(Array.from(document.querySelectorAll('input[data-pick-id]:checked')).map(cb => cb.dataset.pickId));
            const seekingText = document.getElementById('seeking').value.trim();

            const saveButton = form.querySelector('button[type="submit"]');
            saveButton.textContent = 'Saving...';
            saveButton.disabled = true;

            try {
                const tradeBlockRef = doc(db, collectionNames.tradeblocks, teamId);
                
                const existingBlockDoc = await getDoc(tradeBlockRef);
                const oldBlockData = existingBlockDoc.exists() ? existingBlockDoc.data() : { on_the_block: [], picks_available_ids: [], recently_removed: [] };

                const now = Timestamp.now();
                const NINETY_SIX_HOURS_AGO_MS = now.toMillis() - (96 * 60 * 60 * 1000);

                let recently_removed = (oldBlockData.recently_removed || []).filter(item => item.removedOn.toMillis() > NINETY_SIX_HOURS_AGO_MS);
                
                const oldPlayers = oldBlockData.on_the_block || [];
                oldPlayers.forEach(player => {
                    if (!selectedPlayerIds.has(player.id)) {
                        recently_removed.push({ id: player.id, type: 'player', originalAddedOn: player.addedOn, removedOn: now });
                    }
                });

                const oldPicks = oldBlockData.picks_available_ids || [];
                oldPicks.forEach(pick => {
                    if (!selectedPickIds.has(pick.id)) {
                        recently_removed.push({ id: pick.id, type: 'pick', originalAddedOn: pick.addedOn, removedOn: now });
                    }
                });
                
                const removedMap = new Map(recently_removed.map(item => [item.id, item]));

                const oldPlayersMap = new Map(oldPlayers.map(p => [p.id, p.addedOn]));
                const newPlayers = Array.from(selectedPlayerIds).map(id => {
                    if (oldPlayersMap.has(id)) return { id, addedOn: oldPlayersMap.get(id) };
                    if (removedMap.has(id)) {
                        const removedItem = removedMap.get(id);
                        if (removedItem.removedOn.toMillis() > NINETY_SIX_HOURS_AGO_MS) {
                            return { id, addedOn: removedItem.originalAddedOn };
                        }
                    }
                    return { id, addedOn: now };
                });

                const oldPicksMap = new Map(oldPicks.map(p => [p.id, p.addedOn]));
                 const newPicks = Array.from(selectedPickIds).map(id => {
                    if (oldPicksMap.has(id)) return { id, addedOn: oldPicksMap.get(id) };
                    if (removedMap.has(id)) {
                        const removedItem = removedMap.get(id);
                        if (removedItem.removedOn.toMillis() > NINETY_SIX_HOURS_AGO_MS) {
                            return { id, addedOn: removedItem.originalAddedOn };
                        }
                    }
                    return { id, addedOn: now };
                });

                const hasNewPlayer = newPlayers.some(p => p.addedOn === now);
                const hasNewPick = newPicks.some(p => p.addedOn === now);
                const isNewAddition = hasNewPlayer || hasNewPick;

                const updatedData = {
                    gm_uid: gmUid,
                    on_the_block: newPlayers,
                    picks_available_ids: newPicks,
                    seeking: seekingText,
                    recently_removed: recently_removed
                };
                
                if (isNewAddition) {
                    updatedData.last_updated = serverTimestamp();
                } else if (oldBlockData.last_updated) {
                    updatedData.last_updated = oldBlockData.last_updated;
                } else {
                    updatedData.last_updated = serverTimestamp();
                }
                
                await setDoc(tradeBlockRef, updatedData);
                
                saveButton.textContent = 'Success!';
                saveButton.style.backgroundColor = '#28a745'; // Green color

                setTimeout(() => {
                    window.location.href = '/common/trade-block.html';
                }, 1000); // 1 second delay

            } catch (error) {
                console.error("Error saving/deleting trade block:", error);
                alert(`Error: ${error.message}`);
                saveButton.textContent = 'Save Changes';
                saveButton.disabled = false;
            }
        });
    }
}
