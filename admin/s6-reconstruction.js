/**
 * S6 Season Reconstruction - Admin Module
 *
 * Runs in the browser to make API calls to real.vg and Supabase.
 * This avoids the CORS/origin issues that occur when running locally.
 */

import {
    auth, db,
    onAuthStateChanged,
    doc, getDoc,
    collectionNames
} from '/js/firebase-init.js';

// API endpoints
const RANKED_DAYS_API = 'https://api.real.vg/rankeddays';
const KARMA_RANKS_API = 'https://api.real.vg/userkarmaranks/day';

// State
let isRunning = false;
let shouldStop = false;
let supabaseClient = null;

// Data
let gamesData = [];
let handleToId = {};
let karmaCache = {};  // date -> user_id -> {amount, rank, username}
let usernameToId = {};  // username -> Set of user_ids
let rankedDaysCache = {};  // user_id -> [{day, karma, rank}]
let discoveries = {};  // handle -> {user_id, confidence, method}

// Stats
let stats = {
    directMatches: 0,
    usernameMatches: 0,
    rankDiscoveries: 0,
    outsideTop1000: 0,
    noMatch: 0
};

// DOM Elements
const elements = {};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    initializeElements();
    setupEventListeners();
    setupAuth();
});

function initializeElements() {
    elements.loadingContainer = document.getElementById('loading-container');
    elements.adminContainer = document.getElementById('admin-container');
    elements.authStatus = document.getElementById('auth-status');

    elements.supabaseUrl = document.getElementById('supabase-url');
    elements.supabaseKey = document.getElementById('supabase-key');
    elements.rankTolerance = document.getElementById('rank-tolerance');
    elements.apiDelay = document.getElementById('api-delay');

    elements.gamesFile = document.getElementById('games-file');
    elements.handlesFile = document.getElementById('handles-file');
    elements.gamesUploadArea = document.getElementById('games-upload-area');
    elements.handlesUploadArea = document.getElementById('handles-upload-area');
    elements.gamesFileStatus = document.getElementById('games-file-status');
    elements.handlesFileStatus = document.getElementById('handles-file-status');

    elements.btnRunFull = document.getElementById('btn-run-full');
    elements.btnFetchKarma = document.getElementById('btn-fetch-karma');
    elements.btnDiscoverIds = document.getElementById('btn-discover-ids');
    elements.btnStop = document.getElementById('btn-stop');

    elements.progressBar = document.getElementById('progress-bar');
    elements.currentPhase = document.getElementById('current-phase');
    elements.logContainer = document.getElementById('log-container');

    elements.statsGrid = document.getElementById('stats-grid');
    elements.statDirect = document.getElementById('stat-direct');
    elements.statUsername = document.getElementById('stat-username');
    elements.statRank = document.getElementById('stat-rank');
    elements.statOutside = document.getElementById('stat-outside');
    elements.statNomatch = document.getElementById('stat-nomatch');

    elements.resultsSection = document.getElementById('results-section');
    elements.resultsPreview = document.getElementById('results-preview');
    elements.btnDownloadGames = document.getElementById('btn-download-games');
    elements.btnDownloadDiscoveries = document.getElementById('btn-download-discoveries');
    elements.btnDownloadMerged = document.getElementById('btn-download-merged');
}

function setupEventListeners() {
    // File uploads
    elements.gamesUploadArea.addEventListener('click', () => elements.gamesFile.click());
    elements.handlesUploadArea.addEventListener('click', () => elements.handlesFile.click());

    elements.gamesFile.addEventListener('change', (e) => handleFileUpload(e, 'games'));
    elements.handlesFile.addEventListener('change', (e) => handleFileUpload(e, 'handles'));

    // Drag and drop
    setupDragDrop(elements.gamesUploadArea, elements.gamesFile, 'games');
    setupDragDrop(elements.handlesUploadArea, elements.handlesFile, 'handles');

    // Action buttons
    elements.btnRunFull.addEventListener('click', runFullReconstruction);
    elements.btnFetchKarma.addEventListener('click', runFetchKarmaOnly);
    elements.btnDiscoverIds.addEventListener('click', runDiscoverIdsOnly);
    elements.btnStop.addEventListener('click', stopProcessing);

    // Download buttons
    elements.btnDownloadGames.addEventListener('click', downloadEnhancedGames);
    elements.btnDownloadDiscoveries.addEventListener('click', downloadDiscoveries);
    elements.btnDownloadMerged.addEventListener('click', downloadMergedHandles);
}

function setupDragDrop(area, input, type) {
    area.addEventListener('dragover', (e) => {
        e.preventDefault();
        area.style.borderColor = '#3b82f6';
    });

    area.addEventListener('dragleave', () => {
        area.style.borderColor = '';
    });

    area.addEventListener('drop', (e) => {
        e.preventDefault();
        area.style.borderColor = '';
        const file = e.dataTransfer.files[0];
        if (file && file.name.endsWith('.json')) {
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);
            input.files = dataTransfer.files;
            handleFileUpload({ target: input }, type);
        }
    });
}

async function handleFileUpload(e, type) {
    const file = e.target.files[0];
    if (!file) return;

    try {
        const text = await file.text();
        const data = JSON.parse(text);

        if (type === 'games') {
            gamesData = data;
            elements.gamesFileStatus.textContent = `✓ ${file.name} (${data.length} games)`;
            elements.gamesUploadArea.classList.add('has-file');
            log(`Loaded ${data.length} games from ${file.name}`, 'success');
        } else {
            handleToId = data;
            elements.handlesFileStatus.textContent = `✓ ${file.name} (${Object.keys(data).length} mappings)`;
            elements.handlesUploadArea.classList.add('has-file');
            log(`Loaded ${Object.keys(data).length} handle mappings from ${file.name}`, 'success');
        }
    } catch (err) {
        log(`Error loading ${type} file: ${err.message}`, 'error');
    }
}

function setupAuth() {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            const userRef = doc(db, collectionNames.users, user.uid);
            const userDoc = await getDoc(userRef);

            if (userDoc.exists() && userDoc.data().role === 'admin') {
                elements.loadingContainer.style.display = 'none';
                elements.adminContainer.style.display = 'block';
                elements.authStatus.innerHTML = `Admin: ${user.email} | <a href="#" id="logout-btn">Logout</a>`;
                document.getElementById('logout-btn').addEventListener('click', (e) => {
                    e.preventDefault();
                    auth.signOut().then(() => window.location.href = '/login.html');
                });
                log('Admin authenticated', 'success');
            } else {
                elements.loadingContainer.innerHTML = '<div class="error">Access denied. Admin role required.</div>';
            }
        } else {
            window.location.href = '/login.html?target=admin';
        }
    });
}

// Logging
function log(message, type = 'info') {
    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;
    const timestamp = new Date().toLocaleTimeString();
    entry.textContent = `[${timestamp}] ${message}`;
    elements.logContainer.appendChild(entry);
    elements.logContainer.scrollTop = elements.logContainer.scrollHeight;
}

function updateProgress(percent, phase) {
    elements.progressBar.style.width = `${percent}%`;
    elements.progressBar.textContent = `${Math.round(percent)}%`;
    elements.currentPhase.textContent = phase;
}

function updateStats() {
    elements.statDirect.textContent = stats.directMatches;
    elements.statUsername.textContent = stats.usernameMatches;
    elements.statRank.textContent = stats.rankDiscoveries;
    elements.statOutside.textContent = stats.outsideTop1000;
    elements.statNomatch.textContent = stats.noMatch;
}

function resetStats() {
    stats = { directMatches: 0, usernameMatches: 0, rankDiscoveries: 0, outsideTop1000: 0, noMatch: 0 };
    updateStats();
}

// Supabase initialization
async function initSupabase() {
    const url = elements.supabaseUrl.value.trim();
    const key = elements.supabaseKey.value.trim();

    if (!url || !key) {
        throw new Error('Supabase URL and Key are required');
    }

    // Dynamic import of Supabase client
    const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2');
    supabaseClient = createClient(url, key);
    log('Connected to Supabase', 'success');
}

// API Functions
async function fetchKarmaForDate(dateStr) {
    if (karmaCache[dateStr]) {
        return karmaCache[dateStr];
    }

    if (!supabaseClient) {
        return {};
    }

    try {
        const { data, error } = await supabaseClient
            .from('karma_rankings')
            .select('user_id, username, amount, rank')
            .eq('scrape_date', dateStr);

        if (error) throw error;

        const karmaMap = {};
        for (const entry of data) {
            karmaMap[entry.user_id] = {
                amount: entry.amount,
                rank: entry.rank,
                username: entry.username || ''
            };

            // Build username index
            const username = (entry.username || '').toLowerCase().trim();
            if (username) {
                if (!usernameToId[username]) {
                    usernameToId[username] = new Set();
                }
                usernameToId[username].add(entry.user_id);
            }
        }

        karmaCache[dateStr] = karmaMap;
        return karmaMap;

    } catch (err) {
        log(`Error fetching karma for ${dateStr}: ${err.message}`, 'error');
        return {};
    }
}

async function fetchRankedDays(userId, limitDate = '2025-03-01') {
    if (rankedDaysCache[userId]) {
        return rankedDaysCache[userId];
    }

    const allData = [];
    let oldest = null;
    const delay = parseInt(elements.apiDelay.value) || 500;

    while (!shouldStop) {
        let url = `${RANKED_DAYS_API}/${userId}?sort=latest`;
        if (oldest) {
            url += `&before=${oldest}`;
        }

        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const data = await response.json();
            const days = data.days || [];

            if (days.length === 0) break;

            allData.push(...days);
            oldest = days[days.length - 1].day;

            if (oldest < limitDate) break;

            await sleep(delay);

        } catch (err) {
            log(`Error fetching ranked days for ${userId}: ${err.message}`, 'warning');
            break;
        }
    }

    rankedDaysCache[userId] = allData;
    return allData;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Matching functions
function matchDirect(playerId, gameDate) {
    const karma = karmaCache[gameDate] || {};
    return karma[playerId] || null;
}

function discoverByUsername(handle) {
    const handleLower = handle.toLowerCase();

    // Exact match
    if (usernameToId[handleLower]) {
        const ids = usernameToId[handleLower];
        if (ids.size === 1) {
            return { userId: [...ids][0], confidence: 'high' };
        }
    }

    // Fuzzy match
    let bestMatch = null;
    let bestRatio = 0;

    for (const [username, ids] of Object.entries(usernameToId)) {
        if (ids.size > 1) continue;

        const ratio = similarity(handleLower, username);
        if (ratio > 0.85 && ratio > bestRatio) {
            bestRatio = ratio;
            bestMatch = [...ids][0];
        }
    }

    if (bestMatch) {
        const confidence = bestRatio > 0.95 ? 'high' : (bestRatio > 0.9 ? 'medium' : 'low');
        return { userId: bestMatch, confidence };
    }

    return null;
}

function discoverByRank(handle, weeklyRanking, gameDate, excludedIds) {
    const karma = karmaCache[gameDate] || {};
    const tolerance = parseInt(elements.rankTolerance.value) || 50;
    const candidates = [];

    for (const [userId, data] of Object.entries(karma)) {
        if (excludedIds.has(userId)) continue;

        const rankDiff = Math.abs(data.rank - weeklyRanking);
        if (rankDiff <= tolerance) {
            candidates.push({ userId, data, rankDiff });
        }
    }

    if (candidates.length === 0) return null;

    // Sort by rank proximity
    candidates.sort((a, b) => a.rankDiff - b.rankDiff);

    // Prefer username match
    const handleLower = handle.toLowerCase();
    for (const c of candidates) {
        const username = (c.data.username || '').toLowerCase();
        if (username === handleLower || username.includes(handleLower) || handleLower.includes(username)) {
            return { userId: c.userId, data: c.data };
        }
    }

    // Single candidate
    if (candidates.length === 1) {
        return { userId: candidates[0].userId, data: candidates[0].data };
    }

    // Best match with uncertainty
    const best = candidates[0];
    return {
        userId: best.userId,
        data: { ...best.data, _uncertain: true, _candidates: candidates.length }
    };
}

function similarity(a, b) {
    if (a === b) return 1;
    if (a.length === 0 || b.length === 0) return 0;

    const matrix = [];
    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }

    const maxLen = Math.max(a.length, b.length);
    return 1 - matrix[b.length][a.length] / maxLen;
}

// Main processing functions
async function runFullReconstruction() {
    if (!validateInputs()) return;

    try {
        setRunning(true);
        resetStats();
        karmaCache = {};
        usernameToId = {};
        discoveries = {};

        await initSupabase();

        // Phase 1: Prefetch karma data
        log('=== PHASE 1: Fetching karma data ===', 'phase');
        await prefetchKarmaData();

        if (shouldStop) return;

        // Phase 2: Direct matching
        log('=== PHASE 2: Direct matching ===', 'phase');
        const matchedPerDate = await processDirectMatches();

        if (shouldStop) return;

        // Phase 3: Username discovery
        log('=== PHASE 3: Username matching ===', 'phase');
        await processUsernameDiscovery();

        if (shouldStop) return;

        // Phase 4: Rank-based discovery
        log('=== PHASE 4: Rank-based discovery ===', 'phase');
        await processRankDiscovery(matchedPerDate);

        if (shouldStop) return;

        // Phase 5: API verification (optional, for uncertain matches)
        log('=== PHASE 5: API verification ===', 'phase');
        await processApiVerification();

        showResults();
        log('=== RECONSTRUCTION COMPLETE ===', 'success');

    } catch (err) {
        log(`Error: ${err.message}`, 'error');
        console.error(err);
    } finally {
        setRunning(false);
    }
}

async function runFetchKarmaOnly() {
    if (!gamesData.length) {
        log('Please load games data first', 'error');
        return;
    }

    try {
        setRunning(true);
        await initSupabase();
        await prefetchKarmaData();
        log('Karma data fetched successfully', 'success');
    } catch (err) {
        log(`Error: ${err.message}`, 'error');
    } finally {
        setRunning(false);
    }
}

async function runDiscoverIdsOnly() {
    if (!gamesData.length) {
        log('Please load games data first', 'error');
        return;
    }

    if (Object.keys(karmaCache).length === 0) {
        log('Please fetch karma data first', 'error');
        return;
    }

    try {
        setRunning(true);
        discoveries = {};

        log('=== Username matching ===', 'phase');
        await processUsernameDiscovery();

        log('=== Rank-based discovery ===', 'phase');
        await processRankDiscovery(new Map());

        showResults();
        log('Discovery complete', 'success');
    } catch (err) {
        log(`Error: ${err.message}`, 'error');
    } finally {
        setRunning(false);
    }
}

function validateInputs() {
    if (!gamesData.length) {
        log('Please load games data first', 'error');
        return false;
    }

    if (!elements.supabaseUrl.value.trim() || !elements.supabaseKey.value.trim()) {
        log('Please enter Supabase credentials', 'error');
        return false;
    }

    return true;
}

function setRunning(running) {
    isRunning = running;
    shouldStop = false;

    elements.btnRunFull.disabled = running;
    elements.btnFetchKarma.disabled = running;
    elements.btnDiscoverIds.disabled = running;
    elements.btnStop.disabled = !running;
}

function stopProcessing() {
    shouldStop = true;
    log('Stopping...', 'warning');
}

async function prefetchKarmaData() {
    const dates = [...new Set(gamesData.map(g => g.game_date))].sort();
    log(`Fetching karma data for ${dates.length} unique dates...`, 'info');

    for (let i = 0; i < dates.length; i++) {
        if (shouldStop) break;

        const dateStr = dates[i];
        const data = await fetchKarmaForDate(dateStr);

        updateProgress((i + 1) / dates.length * 25, `Fetching karma: ${dateStr}`);
        log(`${dateStr}: ${Object.keys(data).length} entries`, 'info');
    }
}

async function processDirectMatches() {
    const matchedPerDate = new Map();
    let processed = 0;
    const total = gamesData.length;

    for (const game of gamesData) {
        if (shouldStop) break;

        const gameDate = game.game_date;
        if (!matchedPerDate.has(gameDate)) {
            matchedPerDate.set(gameDate, new Set());
        }

        for (const rosterKey of ['roster_a', 'roster_b']) {
            for (const player of game[rosterKey]) {
                const playerId = player.player_id;
                if (!playerId) continue;

                const karma = matchDirect(playerId, gameDate);
                if (karma) {
                    player.karma_amount = karma.amount;
                    player.karma_rank = karma.rank;
                    player.match_method = 'direct';
                    matchedPerDate.get(gameDate).add(playerId);
                    stats.directMatches++;
                } else {
                    player.match_method = 'outside_top_1000';
                    stats.outsideTop1000++;
                }
            }
        }

        processed++;
        updateProgress(25 + (processed / total * 25), `Direct matching: game ${processed}/${total}`);
    }

    updateStats();
    log(`Direct matches: ${stats.directMatches}, Outside top 1000: ${stats.outsideTop1000}`, 'success');
    return matchedPerDate;
}

async function processUsernameDiscovery() {
    let discovered = 0;

    for (const game of gamesData) {
        if (shouldStop) break;

        for (const rosterKey of ['roster_a', 'roster_b']) {
            for (const player of game[rosterKey]) {
                if (player.player_id) continue;

                const handle = player.handle;
                const result = discoverByUsername(handle);

                if (result) {
                    player.player_id = result.userId;
                    player.match_method = 'username';
                    player.match_confidence = result.confidence;

                    discoveries[handle.toLowerCase()] = {
                        user_id: result.userId,
                        confidence: result.confidence,
                        method: 'username'
                    };

                    stats.usernameMatches++;
                    discovered++;
                }
            }
        }
    }

    updateProgress(60, 'Username matching complete');
    updateStats();
    log(`Username discoveries: ${discovered}`, 'success');
}

async function processRankDiscovery(matchedPerDate) {
    let discovered = 0;
    let processed = 0;
    const total = gamesData.length;

    for (const game of gamesData) {
        if (shouldStop) break;

        const gameDate = game.game_date;
        const excluded = matchedPerDate.get(gameDate) || new Set();

        for (const rosterKey of ['roster_a', 'roster_b']) {
            for (const player of game[rosterKey]) {
                if (player.player_id) continue;

                const ranking = player.ranking;
                if (!ranking) continue;

                const handle = player.handle;

                // Check if already discovered
                if (discoveries[handle.toLowerCase()]) {
                    const userId = discoveries[handle.toLowerCase()].user_id;
                    const karma = matchDirect(userId, gameDate);
                    if (karma) {
                        player.player_id = userId;
                        player.karma_amount = karma.amount;
                        player.karma_rank = karma.rank;
                        player.match_method = 'previously_discovered';
                        excluded.add(userId);
                    }
                    continue;
                }

                const result = discoverByRank(handle, ranking, gameDate, excluded);
                if (result) {
                    player.player_id = result.userId;
                    player.karma_amount = result.data.amount;
                    player.karma_rank = result.data.rank;
                    player.match_method = 'rank_discovery';

                    if (result.data._uncertain) {
                        player.match_uncertain = true;
                    }

                    discoveries[handle.toLowerCase()] = {
                        user_id: result.userId,
                        confidence: result.data._uncertain ? 'low' : 'medium',
                        method: 'rank'
                    };

                    excluded.add(result.userId);
                    stats.rankDiscoveries++;
                    discovered++;
                } else {
                    stats.noMatch++;
                }
            }
        }

        processed++;
        updateProgress(60 + (processed / total * 30), `Rank discovery: game ${processed}/${total}`);
    }

    updateStats();
    log(`Rank discoveries: ${discovered}, No match: ${stats.noMatch}`, 'success');
}

async function processApiVerification() {
    let verified = 0;
    let checked = 0;
    const uncertainPlayers = [];

    // Collect uncertain matches
    for (const game of gamesData) {
        for (const rosterKey of ['roster_a', 'roster_b']) {
            for (const player of game[rosterKey]) {
                if (player.match_uncertain && player.player_id) {
                    uncertainPlayers.push({ player, gameDate: game.game_date });
                }
            }
        }
    }

    if (uncertainPlayers.length === 0) {
        log('No uncertain matches to verify', 'info');
        updateProgress(100, 'Complete');
        return;
    }

    log(`Verifying ${uncertainPlayers.length} uncertain matches via API...`, 'info');

    for (const { player, gameDate } of uncertainPlayers) {
        if (shouldStop) break;

        const rankedDays = await fetchRankedDays(player.player_id);

        for (const day of rankedDays) {
            if (day.day === gameDate) {
                if (Math.abs(day.rank - (player.karma_rank || 0)) <= 5) {
                    player.match_verified = true;
                    verified++;
                }
                break;
            }
        }

        checked++;
        updateProgress(90 + (checked / uncertainPlayers.length * 10), `Verifying: ${checked}/${uncertainPlayers.length}`);
    }

    log(`Verified: ${verified}/${checked}`, 'success');
    updateProgress(100, 'Complete');
}

function showResults() {
    elements.resultsSection.classList.remove('hidden');

    const summary = {
        stats,
        discoveries_count: Object.keys(discoveries).length,
        total_handles: Object.keys(handleToId).length + Object.keys(discoveries).length,
        sample_discoveries: Object.entries(discoveries).slice(0, 5)
    };

    elements.resultsPreview.textContent = JSON.stringify(summary, null, 2);
}

function downloadEnhancedGames() {
    downloadJson(gamesData, 's6-games-with-karma.json');
}

function downloadDiscoveries() {
    downloadJson(discoveries, 's6-discoveries.json');
}

function downloadMergedHandles() {
    const merged = { ...handleToId };
    for (const [handle, data] of Object.entries(discoveries)) {
        merged[handle] = data.user_id;
    }
    downloadJson(merged, 's6-handle-to-id-complete.json');
}

function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    log(`Downloaded ${filename}`, 'success');
}
