import {
    auth,
    db,
    functions,
    httpsCallable,
    onAuthStateChanged,
    doc,
    getDoc,
    collection,
    getDocs,
    writeBatch,
    query,
    where,
    updateDoc,
    orderBy,
    getCurrentLeague,
    getConferenceNames,
    collectionNames,
    getLeagueCollectionName
} from '/js/firebase-init.js';

// --- Page Elements ---
const loadingContainer = document.getElementById('loading-container');
const adminContainer = document.getElementById('admin-container');
const authStatusDiv = document.getElementById('auth-status');
const seasonSelect = document.getElementById('season-select');
const draftTableBody = document.getElementById('draft-table-body');
const draftForm = document.getElementById('draft-form');
const prospectsForm = document.getElementById('prospects-form');

// --- Global Data Cache ---
let allTeams = [];
let currentSeasonId = null;
const TOTAL_PICKS = 90;

// --- Auto-Save Cache ---
const CACHE_KEY_PREFIX = 'draft_entries_cache_';
let autoSaveTimeout = null;

// --- Cache Helper Functions ---
function getCacheKey() {
    return `${CACHE_KEY_PREFIX}${currentSeasonId}`;
}

function saveDraftCache() {
    if (!currentSeasonId) return;

    const cacheData = {};
    for (let i = 1; i <= TOTAL_PICKS; i++) {
        const row = document.getElementById(`pick-row-${i}`);
        if (!row) continue;

        const teamId = row.querySelector('.team-select')?.value || '';
        const playerHandle = row.querySelector('.player-handle-input')?.value.trim() || '';
        const isForfeited = row.querySelector('.forfeit-checkbox')?.checked || false;

        // Only cache if there's actual data
        if (teamId || playerHandle || isForfeited) {
            cacheData[i] = { teamId, playerHandle, isForfeited };
        }
    }

    try {
        localStorage.setItem(getCacheKey(), JSON.stringify(cacheData));
        updateAutoSaveIndicator('Saved');
        console.log('Draft entries cached locally');
    } catch (error) {
        console.error('Error saving draft cache:', error);
        updateAutoSaveIndicator('Error saving');
    }
}

function loadDraftCache() {
    if (!currentSeasonId) return null;

    try {
        const cached = localStorage.getItem(getCacheKey());
        return cached ? JSON.parse(cached) : null;
    } catch (error) {
        console.error('Error loading draft cache:', error);
        return null;
    }
}

function clearDraftCache() {
    if (!currentSeasonId) return;

    try {
        localStorage.removeItem(getCacheKey());
        updateAutoSaveIndicator('Cache cleared');
        console.log('Draft cache cleared');
    } catch (error) {
        console.error('Error clearing draft cache:', error);
    }
}

function debouncedSave() {
    updateAutoSaveIndicator('Saving...');
    if (autoSaveTimeout) clearTimeout(autoSaveTimeout);
    autoSaveTimeout = setTimeout(() => {
        saveDraftCache();
    }, 500); // Save 500ms after last change
}

function updateAutoSaveIndicator(status) {
    const indicator = document.getElementById('auto-save-indicator');
    if (indicator) {
        indicator.textContent = status;
        indicator.style.opacity = '1';

        // Fade out after 2 seconds
        setTimeout(() => {
            indicator.style.opacity = '0.5';
        }, 2000);
    }
}

// --- Primary Auth Check & Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            const userRef = doc(db, "users", user.uid);
            const userDoc = await getDoc(userRef);
            if (userDoc.exists() && userDoc.data().role === 'admin') {
                loadingContainer.style.display = 'none';
                adminContainer.style.display = 'block';
                authStatusDiv.innerHTML = `Welcome, Admin | <a href="#" id="logout-btn">Logout</a>`;
                addLogoutListener();
                await initializePage();
            } else {
                loadingContainer.innerHTML = '<div class="error">Access Denied.</div>';
            }
        } else {
            window.location.href = '/login.html';
        }
    });
});

async function initializePage() {
    try {
        // Fetch active season for team name context
        const seasonsQuery = query(collection(db, collectionNames.seasons), where("status", "==", "active"));
        const activeSeasonsSnap = await getDocs(seasonsQuery);
        const activeSeasonIdForTeams = !activeSeasonsSnap.empty ? activeSeasonsSnap.docs[0].id : null;

        if (!activeSeasonIdForTeams) {
            throw new Error("Could not determine the active season to fetch team names.");
        }

        // Fetch team data filtered by current league's conferences
        const conferences = getConferenceNames();
        const validConferences = [conferences.primary, conferences.secondary];

        const teamsSnap = await getDocs(collection(db, collectionNames.teams));
        const teamPromises = teamsSnap.docs.map(async (teamDoc) => {
            const conference = teamDoc.data().conference;
            if (!conference || !validConferences.includes(conference)) return null;

            const teamData = { id: teamDoc.id, ...teamDoc.data() };
            const seasonRecordRef = doc(db, collectionNames.teams, teamDoc.id, collectionNames.seasonalRecords, activeSeasonIdForTeams);
            const seasonRecordSnap = await getDoc(seasonRecordRef);

            teamData.team_name = seasonRecordSnap.exists() ? seasonRecordSnap.data().team_name : "Name Not Found";
            return teamData;
        });

        allTeams = (await Promise.all(teamPromises))
            .filter(Boolean)
            .sort((a, b) => (a.team_name || '').localeCompare(b.team_name || ''));

        // Load and display notifications
        await loadAndDisplayNotifications();
        
        // Populate season dropdown and load initial draft board
        await populateSeasons();

        // Add event listeners
        seasonSelect.addEventListener('change', () => {
            currentSeasonId = seasonSelect.value;
            loadDraftBoard();
        });
        draftForm.addEventListener('submit', handleDraftSubmit);
        prospectsForm.addEventListener('submit', handleProspectsSubmit);

        document.getElementById('progress-close-btn').addEventListener('click', () => {
            document.getElementById('progress-modal').style.display = 'none';
        });

        document.getElementById('clear-cache-btn').addEventListener('click', () => {
            if (confirm('Are you sure you want to clear the cached draft entries? This cannot be undone.')) {
                clearDraftCache();
                loadDraftBoard(); // Reload the board from database
            }
        });

        // Listen for league changes and reload the page data
        window.addEventListener('leagueChanged', async (event) => {
            console.log('League changed to:', event.detail.league);
            // Reload all data for the new league
            await initializePage();
        });

    } catch (error) {
        console.error("Error initializing draft page:", error);
        draftTableBody.innerHTML = `<tr><td colspan="5" class="error">Could not load required league data.</td></tr>`;
    }
}

// ===============================================
// Notification Management Logic
// ===============================================
async function loadAndDisplayNotifications() {
    const notificationsSection = document.getElementById('notifications-section');
    const notificationsList = document.getElementById('notifications-list');

    const q = query(
        collection(db, 'notifications'),
        where('module', '==', 'manage-draft'),
        where('status', '==', 'unread'),
        orderBy('createdAt', 'desc')
    );

    try {
        const querySnapshot = await getDocs(q);
        if (querySnapshot.empty) {
            notificationsSection.style.display = 'none';
            return;
        }

        notificationsSection.style.display = 'block';
        notificationsList.innerHTML = ''; // Clear previous list

        querySnapshot.forEach(doc => {
            const notification = doc.data();
            const notificationId = doc.id;

            const item = document.createElement('div');
            item.className = 'notification-item';
            item.innerHTML = `
                <span>${notification.message}</span>
                <button class="btn-admin-secondary" data-id="${notificationId}">Resolve</button>
            `;
            notificationsList.appendChild(item);
        });

        // Add event listeners to the new "Resolve" buttons
        notificationsList.querySelectorAll('button').forEach(button => {
            button.addEventListener('click', async (e) => {
                const id = e.target.dataset.id;
                e.target.disabled = true;
                e.target.textContent = 'Resolving...';

                const notifDocRef = doc(db, 'notifications', id);
                await updateDoc(notifDocRef, { status: 'read' });

                // Remove the item from the UI
                e.target.closest('.notification-item').remove();

                // Hide the whole section if no notifications are left
                if (notificationsList.children.length === 0) {
                    notificationsSection.style.display = 'none';
                }
            });
        });

    } catch (error) {
        console.error("Error fetching notifications:", error);
        notificationsList.innerHTML = '<p class="error">Could not load notifications.</p>';
        notificationsSection.style.display = 'block';
    }
}


// ===============================================
// Prospect Management Logic
// ===============================================
async function handleProspectsSubmit(e) {
    e.preventDefault();
    const handlesTextarea = document.getElementById('prospects-handles');
    const handles = handlesTextarea.value.trim();
    const submitBtn = e.target.querySelector('button[type="submit"]');

    if (!handles) {
        alert('Please enter at least one player handle.');
        return;
    }

    if (!confirm('Are you sure you want to add these players as draft prospects? This will trigger the scraping process.')) {
        return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Adding...';

    try {
        const addDraftProspects = httpsCallable(functions, 'addDraftProspects');
        const result = await addDraftProspects({ handles, league: getCurrentLeague() });
        alert(result.data.message);
        handlesTextarea.value = ''; // Clear textarea on success
    } catch (error) {
        console.error('Error adding draft prospects:', error);
        alert(`An error occurred: ${error.message}`);
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Add Prospects';
    }
}


// ===============================================
// Draft Results Logic
// ===============================================
async function populateSeasons() {
    const seasonsSnap = await getDocs(query(collection(db, collectionNames.seasons)));
    let activeSeasonId = null;
    const sortedDocs = seasonsSnap.docs.sort((a, b) => b.id.localeCompare(a.id));

    seasonSelect.innerHTML = sortedDocs.map(doc => {
        const seasonData = doc.data();
        if (seasonData.status === 'active') {
            activeSeasonId = doc.id;
        }
        const seasonNum = parseInt(doc.id.replace('S', ''), 10);
        return `<option value="S${seasonNum}">S${seasonNum} Draft</option>`;
    }).join('');

    if (activeSeasonId) {
        seasonSelect.value = activeSeasonId;
    }

    currentSeasonId = seasonSelect.value;
    await loadDraftBoard();
}

async function loadDraftBoard() {
    if (!currentSeasonId) {
        draftTableBody.innerHTML = `<tr><td colspan="5" class="placeholder-text">Please select a draft season.</td></tr>`;
        return;
    }
    draftTableBody.innerHTML = `<tr><td colspan="5" class="loading">Loading draft board...</td></tr>`;

    const seasonNumber = currentSeasonId.replace('S', '');
    const currentLeague = getCurrentLeague();
    const draftResultsParent = currentLeague === 'minor' ? 'minor_draft_results' : 'draft_results';
    const draftResultsCollectionRef = collection(db, `${draftResultsParent}/season_${seasonNumber}/S${seasonNumber}_draft_results`);
    const existingPicksSnap = await getDocs(draftResultsCollectionRef);
    const existingPicksMap = new Map();
    existingPicksSnap.forEach(doc => {
        existingPicksMap.set(doc.data().overall, doc.data());
    });

    let tableHTML = '';
    const teamOptionsHTML = `<option value="">-- Select Team --</option>` + allTeams.map(t => `<option value="${t.id}">${t.team_name}</option>`).join('');

    for (let i = 1; i <= TOTAL_PICKS; i++) {
        const overall = i;
        const round = Math.ceil(overall / 30);
        const existingPick = existingPicksMap.get(overall);

        const selectedTeam = existingPick?.team_id || '';
        const playerHandle = existingPick?.player_handle || '';
        const isForfeited = existingPick?.forfeit || false;

        tableHTML += `
            <tr id="pick-row-${overall}" class="${isForfeited ? 'is-forfeited' : ''}">
                <td class="read-only">${overall}</td>
                <td class="read-only">${round}</td>
                <td>
                    <select data-overall="${overall}" class="team-select" ${isForfeited ? 'disabled' : ''}>
                        ${teamOptionsHTML.replace(`value="${selectedTeam}"`, `value="${selectedTeam}" selected`)}
                    </select>
                </td>
                <td>
                    <input type="text" data-overall="${overall}" class="player-handle-input" value="${playerHandle}" placeholder="Enter player handle..." ${isForfeited ? 'disabled' : ''}>
                </td>
                <td style="text-align: center;">
                    <input type="checkbox" data-overall="${overall}" class="forfeit-checkbox" ${isForfeited ? 'checked' : ''}>
                </td>
            </tr>
        `;
    }
    draftTableBody.innerHTML = tableHTML;

    // Load cached data (takes precedence over database data)
    const cachedData = loadDraftCache();
    if (cachedData && Object.keys(cachedData).length > 0) {
        console.log('Loading cached draft entries...');
        for (const [overall, data] of Object.entries(cachedData)) {
            const row = document.getElementById(`pick-row-${overall}`);
            if (!row) continue;

            const teamSelect = row.querySelector('.team-select');
            const playerInput = row.querySelector('.player-handle-input');
            const forfeitCheckbox = row.querySelector('.forfeit-checkbox');

            if (data.teamId) teamSelect.value = data.teamId;
            if (data.playerHandle) playerInput.value = data.playerHandle;
            if (data.isForfeited !== undefined) forfeitCheckbox.checked = data.isForfeited;

            // Update row state
            const isDisabled = data.isForfeited;
            row.classList.toggle('is-forfeited', isDisabled);
            teamSelect.disabled = isDisabled;
            playerInput.disabled = isDisabled;
        }
        updateAutoSaveIndicator('Loaded from cache');
    }

    // Add auto-save event listeners
    draftTableBody.querySelectorAll('.team-select, .player-handle-input').forEach(input => {
        input.addEventListener('input', debouncedSave);
    });

    draftTableBody.querySelectorAll('.forfeit-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            const overall = e.target.dataset.overall;
            const row = document.getElementById(`pick-row-${overall}`);
            const isDisabled = e.target.checked;

            row.classList.toggle('is-forfeited', isDisabled);
            row.querySelector('.team-select').disabled = isDisabled;
            row.querySelector('.player-handle-input').disabled = isDisabled;

            // Trigger auto-save
            debouncedSave();
        });
    });
}

async function handleDraftSubmit(e) {
    e.preventDefault();
    const saveButton = e.target.querySelector('button[type="submit"]');
    saveButton.disabled = true;
    saveButton.textContent = 'Saving...';

    // Progress Bar Logic remains the same...

    try {
        const batch = writeBatch(db);
        const seasonNumber = currentSeasonId.replace('S', '');
        const currentLeague = getCurrentLeague();
        const draftResultsParent = currentLeague === 'minor' ? 'minor_draft_results' : 'draft_results';
        const draftResultsCollectionRef = collection(db, `${draftResultsParent}/season_${seasonNumber}/S${seasonNumber}_draft_results`);

        const parentDocRef = doc(db, draftResultsParent, `season_${seasonNumber}`);
        batch.set(parentDocRef, { description: `Container for ${currentSeasonId} draft results.` });

        for (let i = 1; i <= TOTAL_PICKS; i++) {
            const row = document.getElementById(`pick-row-${i}`);
            const round = Math.ceil(i / 30);
            const teamId = row.querySelector('.team-select').value;
            const playerHandle = row.querySelector('.player-handle-input').value.trim();
            const isForfeited = row.querySelector('.forfeit-checkbox').checked;

            const docId = `round-${round}-pick-${i}`;
            const docRef = doc(draftResultsCollectionRef, docId);

            const draftData = {
                overall: i, round, team_id: isForfeited ? null : teamId, player_handle: isForfeited ? null : playerHandle, forfeit: isForfeited, season: currentSeasonId
            };

            batch.set(docRef, draftData);
        }

        await batch.commit();

        // Clear the cache after successful submission
        clearDraftCache();

        alert('Draft results submitted successfully! Player creation is now processing in the background.');

    } catch (error) {
        console.error("Error saving draft results:", error);
        alert('An error occurred while saving. Please check the console.');
    } finally {
        saveButton.disabled = false;
        saveButton.textContent = 'Save Draft Results';
    }
}

function addLogoutListener() {
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            auth.signOut().then(() => { window.location.href = '/login.html'; });
        });
    }
}