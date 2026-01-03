/**
 * S6 Season Reconstruction - Admin Module
 *
 * Uses Cloud Functions to proxy API calls to real.vg (avoids CORS issues).
 * Supabase calls are made directly from the browser.
 */

import {
    auth, db, functions,
    onAuthStateChanged,
    doc, getDoc,
    httpsCallable,
    collectionNames
} from '/js/firebase-init.js';

// Cloud Functions for API proxy
const fetchRankedDaysFn = httpsCallable(functions, 'admin_fetchRankedDays');
const fetchAllRankedDaysFn = httpsCallable(functions, 'admin_fetchAllRankedDays');
const fetchKarmaRankingsFn = httpsCallable(functions, 'admin_fetchKarmaRankings');
const fetchKarmaRankingsBatchFn = httpsCallable(functions, 'admin_fetchKarmaRankingsBatch');

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

    elements.karmaSource = document.getElementById('karma-source');
    elements.supabaseConfig = document.getElementById('supabase-config');
    elements.supabaseUrl = document.getElementById('supabase-url');
    elements.supabaseKey = document.getElementById('supabase-key');
    elements.rankTolerance = document.getElementById('rank-tolerance');

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
    // Karma source selector
    elements.karmaSource.addEventListener('change', () => {
        const showSupabase = elements.karmaSource.value === 'supabase';
        elements.supabaseConfig.style.display = showSupabase ? 'flex' : 'none';
    });

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

// S6 earliest date - no need to fetch history before this
const S6_START_DATE = '2025-03-06';

async function fetchRankedDays(userId) {
    if (rankedDaysCache[userId]) {
        return rankedDaysCache[userId];
    }

    try {
        const result = await fetchAllRankedDaysFn({ userId, limitDate: S6_START_DATE });

        if (result.data.success) {
            rankedDaysCache[userId] = result.data.days;
            return result.data.days;
        } else {
            return [];
        }
    } catch (err) {
        log(`Error fetching ranked days for ${userId}: ${err.message}`, 'warning');
        return [];
    }
}

/**
 * Fetch karma rankings for a date via Cloud Function (bypasses CORS).
 * Use this if you don't have Supabase data.
 */
async function fetchKarmaViaCloudFunction(dateStr) {
    if (karmaCache[dateStr]) {
        return karmaCache[dateStr];
    }

    try {
        log(`Fetching karma for ${dateStr} via Cloud Function...`, 'info');
        const result = await fetchKarmaRankingsFn({ date: dateStr });

        if (result.data.success) {
            const karmaMap = {};
            for (const entry of result.data.entries) {
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
            log(`Fetched ${result.data.entries.length} karma entries for ${dateStr}`, 'success');
            return karmaMap;
        } else {
            log(`Failed to fetch karma for ${dateStr}`, 'warning');
            return {};
        }
    } catch (err) {
        log(`Error fetching karma for ${dateStr}: ${err.message}`, 'error');
        return {};
    }
}

/**
 * Fetch karma for multiple dates in a batch via Cloud Function.
 */
async function fetchKarmaBatchViaCloudFunction(dates) {
    const uncachedDates = dates.filter(d => !karmaCache[d]);
    if (uncachedDates.length === 0) {
        return;
    }

    // Process in batches of 10
    for (let i = 0; i < uncachedDates.length; i += 10) {
        if (shouldStop) break;

        const batch = uncachedDates.slice(i, i + 10);
        log(`Fetching karma batch ${Math.floor(i/10) + 1}/${Math.ceil(uncachedDates.length/10)} (${batch.length} dates)...`, 'info');

        try {
            const result = await fetchKarmaRankingsBatchFn({ dates: batch });

            if (result.data.success) {
                for (const [dateStr, dateResult] of Object.entries(result.data.results)) {
                    if (dateResult.success) {
                        const karmaMap = {};
                        for (const entry of dateResult.entries) {
                            karmaMap[entry.user_id] = {
                                amount: entry.amount,
                                rank: entry.rank,
                                username: entry.username || ''
                            };

                            const username = (entry.username || '').toLowerCase().trim();
                            if (username) {
                                if (!usernameToId[username]) {
                                    usernameToId[username] = new Set();
                                }
                                usernameToId[username].add(entry.user_id);
                            }
                        }
                        karmaCache[dateStr] = karmaMap;
                        log(`  ${dateStr}: ${dateResult.entries.length} entries`, 'info');
                    }
                }
            }
        } catch (err) {
            log(`Error fetching karma batch: ${err.message}`, 'error');
        }
    }
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

        // Only init Supabase if using it as data source
        if (elements.karmaSource.value === 'supabase') {
            await initSupabase();
        } else {
            log('Using Cloud Functions for API access (no Supabase required)', 'info');
        }

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

    // Only require Supabase credentials if using Supabase as data source
    if (elements.karmaSource.value === 'supabase') {
        if (!elements.supabaseUrl.value.trim() || !elements.supabaseKey.value.trim()) {
            log('Please enter Supabase credentials', 'error');
            return false;
        }
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
    const useCloudFunction = elements.karmaSource.value === 'cloud-function';

    log(`Fetching karma data for ${dates.length} unique dates via ${useCloudFunction ? 'Cloud Function' : 'Supabase'}...`, 'info');

    if (useCloudFunction) {
        // Use batch Cloud Function for efficiency
        await fetchKarmaBatchViaCloudFunction(dates);
        updateProgress(25, 'Karma data fetched via Cloud Function');
    } else {
        // Use Supabase
        for (let i = 0; i < dates.length; i++) {
            if (shouldStop) break;

            const dateStr = dates[i];
            const data = await fetchKarmaForDate(dateStr);

            updateProgress((i + 1) / dates.length * 25, `Fetching karma: ${dateStr}`);
            log(`${dateStr}: ${Object.keys(data).length} entries`, 'info');
        }
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

/**
 * Build a map of handle -> [{date, ranking}] from all games.
 * This gives us the expected rankings for each player across all their game dates.
 */
function buildHandleRankingsMap() {
    const handleRankings = {};  // handle -> [{date, ranking}]

    for (const game of gamesData) {
        const gameDate = game.game_date;

        for (const rosterKey of ['roster_a', 'roster_b']) {
            for (const player of game[rosterKey]) {
                const handle = player.handle.toLowerCase();
                const ranking = player.ranking;

                if (!ranking) continue;  // Skip players without ranking data

                if (!handleRankings[handle]) {
                    handleRankings[handle] = [];
                }

                // Avoid duplicates for same date
                if (!handleRankings[handle].some(r => r.date === gameDate)) {
                    handleRankings[handle].push({ date: gameDate, ranking });
                }
            }
        }
    }

    return handleRankings;
}

/**
 * Validate a candidate user_id against expected rankings from the .json.
 * Returns { valid: bool, matchedDates: n, totalDates: n, avgDeviation: n }
 */
function validateCandidateAgainstRankings(rankedDaysHistory, expectedRankings, tolerance) {
    // Build a map of date -> rank from the candidate's history
    const historyByDate = {};
    for (const day of rankedDaysHistory) {
        historyByDate[day.day] = day.rank;
    }

    let matchedDates = 0;
    let totalDeviation = 0;
    let datesWithHistory = 0;

    for (const { date, ranking } of expectedRankings) {
        if (historyByDate[date] !== undefined) {
            datesWithHistory++;
            const deviation = Math.abs(historyByDate[date] - ranking);
            totalDeviation += deviation;

            if (deviation <= tolerance) {
                matchedDates++;
            }
        }
    }

    return {
        valid: datesWithHistory > 0 && (matchedDates / datesWithHistory) >= 0.7,  // 70%+ dates must match
        matchedDates,
        totalDates: expectedRankings.length,
        datesWithHistory,
        avgDeviation: datesWithHistory > 0 ? totalDeviation / datesWithHistory : Infinity
    };
}

async function processApiVerification() {
    const tolerance = parseInt(elements.rankTolerance.value) || 50;

    // Build map of handle -> expected rankings from .json
    const handleRankings = buildHandleRankingsMap();

    // Collect uncertain matches, grouped by handle
    const uncertainByHandle = {};  // handle -> {player_id, players: [...]}

    for (const game of gamesData) {
        for (const rosterKey of ['roster_a', 'roster_b']) {
            for (const player of game[rosterKey]) {
                if (player.match_uncertain && player.player_id) {
                    const handle = player.handle.toLowerCase();
                    if (!uncertainByHandle[handle]) {
                        uncertainByHandle[handle] = {
                            player_id: player.player_id,
                            players: []  // All player objects with this handle (to update)
                        };
                    }
                    uncertainByHandle[handle].players.push(player);
                }
            }
        }
    }

    const handles = Object.keys(uncertainByHandle);
    if (handles.length === 0) {
        log('No uncertain matches to verify', 'info');
        updateProgress(100, 'Complete');
        return;
    }

    log(`Verifying ${handles.length} uncertain handles via multi-date pattern matching...`, 'info');

    let verified = 0;
    let rejected = 0;

    for (let i = 0; i < handles.length; i++) {
        if (shouldStop) break;

        const handle = handles[i];
        const { player_id, players } = uncertainByHandle[handle];
        const expectedRankings = handleRankings[handle] || [];

        if (expectedRankings.length < 2) {
            // Not enough dates to do meaningful pattern matching
            log(`  ${handle}: Only ${expectedRankings.length} date(s), skipping verification`, 'info');
            continue;
        }

        // Fetch candidate's ranked days history
        log(`  Checking ${handle} (${expectedRankings.length} dates)...`, 'info');
        const rankedDays = await fetchRankedDays(player_id);

        if (rankedDays.length === 0) {
            log(`    No history found for ${player_id}`, 'warning');
            continue;
        }

        // Validate against expected rankings
        const result = validateCandidateAgainstRankings(rankedDays, expectedRankings, tolerance);

        if (result.valid) {
            log(`    ✓ VERIFIED: ${result.matchedDates}/${result.datesWithHistory} dates matched (avg deviation: ${result.avgDeviation.toFixed(1)})`, 'success');
            // Mark all player objects for this handle as verified
            for (const player of players) {
                player.match_verified = true;
                delete player.match_uncertain;
            }
            // Update discovery confidence
            if (discoveries[handle]) {
                discoveries[handle].confidence = 'high';
                discoveries[handle].verified = true;
            }
            verified++;
        } else {
            log(`    ✗ REJECTED: Only ${result.matchedDates}/${result.datesWithHistory} dates matched (avg deviation: ${result.avgDeviation.toFixed(1)})`, 'warning');
            // Mark as rejected - the player_id assignment was likely wrong
            for (const player of players) {
                player.match_rejected = true;
                player.match_uncertain = true;
            }
            if (discoveries[handle]) {
                discoveries[handle].confidence = 'rejected';
                discoveries[handle].verified = false;
            }
            rejected++;
        }

        updateProgress(90 + ((i + 1) / handles.length * 10), `Verifying: ${i + 1}/${handles.length}`);
    }

    log(`Verification complete: ${verified} verified, ${rejected} rejected`, 'success');
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
