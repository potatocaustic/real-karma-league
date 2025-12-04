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
const draftConfigSection = document.getElementById('draft-config-section');
const totalPicksInput = document.getElementById('total-picks-input');
const compRoundsInput = document.getElementById('comp-rounds-input');
const applyConfigBtn = document.getElementById('apply-config-btn');
const resetConfigBtn = document.getElementById('reset-config-btn');

// --- Global Data Cache ---
let allTeams = [];
let currentSeasonId = null;

// --- Draft Configuration ---
let draftConfig = {
    totalPicks: 90,
    compRounds: [] // Array of {start, end, roundName} objects
};

function getDefaultDraftConfig() {
    const currentLeague = getCurrentLeague();
    if (currentLeague === 'minor') {
        return {
            totalPicks: 60,
            compRounds: []
        };
    } else {
        return {
            totalPicks: 90,
            compRounds: []
        };
    }
}

function getRoundInfo(overall) {
    const currentLeague = getCurrentLeague();

    if (currentLeague === 'minor') {
        // Check if in a comp round
        for (let i = 0; i < draftConfig.compRounds.length; i++) {
            const comp = draftConfig.compRounds[i];
            if (overall >= comp.start && overall <= comp.end) {
                return {
                    round: Math.ceil(overall / 30), // Keep overall round number for ordering
                    roundName: comp.roundName
                };
            }
        }

        // For main rounds, count how many non-comp picks have come before this one
        let nonCompPickCount = 0;
        for (let i = 1; i <= overall; i++) {
            // Check if pick i is a comp pick
            let isCompPick = false;
            for (const comp of draftConfig.compRounds) {
                if (i >= comp.start && i <= comp.end) {
                    isCompPick = true;
                    break;
                }
            }
            if (!isCompPick) {
                nonCompPickCount++;
            }
        }

        // First 30 non-comp picks = Round 1, next 30 = Round 2
        const round = Math.ceil(nonCompPickCount / 30);
        return {
            round: round,
            roundName: String(round)
        };
    } else {
        // Major league: 3 rounds of 30 picks each
        const round = Math.ceil(overall / 30);
        return {
            round: round,
            roundName: String(round)
        };
    }
}

// --- Auto-Save Cache ---
const CACHE_KEY_PREFIX = 'draft_entries_cache_';
const CONFIG_CACHE_KEY_PREFIX = 'draft_config_cache_';
let autoSaveTimeout = null;

// --- Cache Helper Functions ---
function getCacheKey() {
    return `${CACHE_KEY_PREFIX}${currentSeasonId}`;
}

function getConfigCacheKey() {
    return `${CONFIG_CACHE_KEY_PREFIX}${currentSeasonId}`;
}

function saveDraftConfig() {
    if (!currentSeasonId) return;

    const configData = {
        totalPicks: draftConfig.totalPicks,
        compRoundsStr: compRoundsInput.value.trim()
    };

    try {
        localStorage.setItem(getConfigCacheKey(), JSON.stringify(configData));
        console.log('Draft config cached locally');
    } catch (error) {
        console.error('Error saving draft config:', error);
    }
}

function loadDraftConfig() {
    if (!currentSeasonId) return null;

    try {
        const cached = localStorage.getItem(getConfigCacheKey());
        return cached ? JSON.parse(cached) : null;
    } catch (error) {
        console.error('Error loading draft config:', error);
        return null;
    }
}

function clearDraftConfig() {
    if (!currentSeasonId) return;

    try {
        localStorage.removeItem(getConfigCacheKey());
        console.log('Draft config cache cleared');
    } catch (error) {
        console.error('Error clearing draft config:', error);
    }
}

function parseCompRoundsConfig(configString) {
    if (!configString || !configString.trim()) return [];

    const compRounds = [];
    const ranges = configString.split(',');

    for (let i = 0; i < ranges.length; i++) {
        const range = ranges[i].trim();
        const match = range.match(/^(\d+)-(\d+)$/);
        if (match) {
            const start = parseInt(match[1], 10);
            const end = parseInt(match[2], 10);
            compRounds.push({
                start: start,
                end: end,
                roundName: `C${i + 1}`
            });
        }
    }

    return compRounds;
}

function applyDraftConfig() {
    const totalPicks = parseInt(totalPicksInput.value, 10);
    const compRoundsStr = compRoundsInput.value.trim();

    if (isNaN(totalPicks) || totalPicks < 1) {
        alert('Please enter a valid number of total picks.');
        return;
    }

    draftConfig.totalPicks = totalPicks;
    draftConfig.compRounds = parseCompRoundsConfig(compRoundsStr);

    // Save config to cache
    saveDraftConfig();

    console.log('Draft config applied:', draftConfig);
    loadDraftBoard();
}

function resetDraftConfig() {
    if (!confirm('Are you sure you want to reset the draft configuration? This will clear the cached configuration and reload with defaults.')) {
        return;
    }

    // Clear cached config
    clearDraftConfig();

    // Reset to defaults
    const defaults = getDefaultDraftConfig();
    draftConfig.totalPicks = defaults.totalPicks;
    draftConfig.compRounds = [];

    // Update UI
    totalPicksInput.value = defaults.totalPicks;
    compRoundsInput.value = '';

    console.log('Draft config reset to defaults');
    loadDraftBoard();
}

function saveDraftCache() {
    if (!currentSeasonId) return;

    const cacheData = {};
    for (let i = 1; i <= draftConfig.totalPicks; i++) {
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
            window.location.href = '/login.html?target=admin';
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

        // Initialize draft config based on league
        draftConfig = getDefaultDraftConfig();
        const currentLeague = getCurrentLeague();
        if (currentLeague === 'minor') {
            draftConfigSection.style.display = 'flex';
            totalPicksInput.value = draftConfig.totalPicks;
        } else {
            draftConfigSection.style.display = 'none';
        }

        // Add event listeners
        seasonSelect.addEventListener('change', () => {
            currentSeasonId = seasonSelect.value;
            loadDraftBoard();
        });
        draftForm.addEventListener('submit', handleDraftSubmit);
        prospectsForm.addEventListener('submit', handleProspectsSubmit);
        applyConfigBtn.addEventListener('click', applyDraftConfig);
        resetConfigBtn.addEventListener('click', resetDraftConfig);

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

    const currentLeague = getCurrentLeague();

    // Load cached config if available (minor league only)
    if (currentLeague === 'minor') {
        const cachedConfig = loadDraftConfig();
        if (cachedConfig) {
            console.log('Loading cached draft config:', cachedConfig);
            draftConfig.totalPicks = cachedConfig.totalPicks;
            draftConfig.compRounds = parseCompRoundsConfig(cachedConfig.compRoundsStr);

            // Update UI
            totalPicksInput.value = cachedConfig.totalPicks;
            compRoundsInput.value = cachedConfig.compRoundsStr;
        }
    }

    const seasonNumber = currentSeasonId.replace('S', '');
    const draftResultsParent = currentLeague === 'minor' ? 'minor_draft_results' : 'draft_results';
    const draftResultsCollectionRef = collection(db, `${draftResultsParent}/season_${seasonNumber}/S${seasonNumber}_draft_results`);
    const existingPicksSnap = await getDocs(draftResultsCollectionRef);
    const existingPicksMap = new Map();
    existingPicksSnap.forEach(doc => {
        existingPicksMap.set(doc.data().overall, doc.data());
    });

    let tableHTML = '';
    const teamOptionsHTML = `<option value="">-- Select Team --</option>` + allTeams.map(t => `<option value="${t.id}">${t.team_name}</option>`).join('');

    for (let i = 1; i <= draftConfig.totalPicks; i++) {
        const overall = i;
        const roundInfo = getRoundInfo(overall);
        const existingPick = existingPicksMap.get(overall);

        const selectedTeam = existingPick?.team_id || '';
        const playerHandle = existingPick?.player_handle || '';
        const isForfeited = existingPick?.forfeit || false;

        tableHTML += `
            <tr id="pick-row-${overall}" class="${isForfeited ? 'is-forfeited' : ''}" data-round-name="${roundInfo.roundName}">
                <td class="read-only">${overall}</td>
                <td class="read-only">${roundInfo.roundName}</td>
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

        // Count actual rows in the table instead of relying on cached config
        const allRows = draftTableBody.querySelectorAll('tr[id^="pick-row-"]');
        const actualTotalPicks = allRows.length;

        console.log(`Saving ${actualTotalPicks} draft picks (draftConfig.totalPicks: ${draftConfig.totalPicks})`);

        for (let i = 1; i <= actualTotalPicks; i++) {
            const row = document.getElementById(`pick-row-${i}`);
            if (!row) {
                console.warn(`Row ${i} not found, skipping`);
                continue;
            }

            const roundInfo = getRoundInfo(i);
            const teamId = row.querySelector('.team-select').value;
            const playerHandle = row.querySelector('.player-handle-input').value.trim();
            const isForfeited = row.querySelector('.forfeit-checkbox').checked;

            const docId = `round-${roundInfo.roundName}-pick-${i}`;
            const docRef = doc(draftResultsCollectionRef, docId);

            const draftData = {
                overall: i,
                round: roundInfo.round,
                round_name: roundInfo.roundName,
                team_id: isForfeited ? null : teamId,
                player_handle: isForfeited ? null : playerHandle,
                forfeit: isForfeited,
                season: currentSeasonId
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
            auth.signOut().then(() => { window.location.href = '/login.html?target=admin'; });
        });
    }
}