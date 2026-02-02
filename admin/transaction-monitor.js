// admin/transaction-monitor.js
// Transaction monitor page logic

import {
    auth,
    db,
    functions,
    onAuthStateChanged,
    doc,
    getDoc,
    collection,
    getDocs,
    query,
    where,
    orderBy,
    limit,
    httpsCallable,
    collectionNames
} from '/js/firebase-init.js';

// State
let currentLeague = 'major';
let transactions = { major: [], minor: [] };
let isLoading = false;

// DOM Elements
const adminContainer = document.getElementById('admin-container');
const loadingContainer = document.getElementById('loading-container');
const scanBtn = document.getElementById('scan-btn');
const scanFeedback = document.getElementById('scan-feedback');
const transactionsList = document.getElementById('transactions-list');
const statusFilter = document.getElementById('status-filter');
const confidenceFilter = document.getElementById('confidence-filter');
const leagueTabs = document.querySelectorAll('.league-tab');

// Stats elements
const statPending = document.getElementById('stat-pending');
const statApproved = document.getElementById('stat-approved');
const statRejected = document.getElementById('stat-rejected');

// Cloud Functions
const getPendingParsedTransactions = httpsCallable(functions, 'admin_getPendingParsedTransactions');
const triggerTransactionParser = httpsCallable(functions, 'admin_triggerTransactionParser');
const approveParsedTransaction = httpsCallable(functions, 'admin_approveParsedTransaction');
const rejectParsedTransaction = httpsCallable(functions, 'admin_rejectParsedTransaction');

/**
 * Initialize the page
 */
function init() {
    // Check authentication
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            await checkAdminAccess(user);
        } else {
            window.location.href = '/login.html';
        }
    });

    // Setup event listeners
    setupEventListeners();
}

/**
 * Check if user has admin access
 */
async function checkAdminAccess(user) {
    try {
        const userRef = doc(db, collectionNames.users, user.uid);
        const userDoc = await getDoc(userRef);
        const userData = userDoc.data();

        if (!userData?.role || !['admin', 'commish', 'scorekeeper'].includes(userData.role)) {
            alert('Access denied. Admin privileges required.');
            window.location.href = '/';
            return;
        }

        // Show admin container
        loadingContainer.style.display = 'none';
        adminContainer.style.display = 'block';

        // Load initial data
        await loadTransactions();
    } catch (error) {
        console.error('Error checking admin access:', error);
        alert('Error checking permissions');
    }
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
    // Scan button
    if (scanBtn) {
        scanBtn.addEventListener('click', handleScan);
    }

    // Filters
    if (statusFilter) {
        statusFilter.addEventListener('change', renderTransactions);
    }
    if (confidenceFilter) {
        confidenceFilter.addEventListener('change', renderTransactions);
    }

    // League tabs
    leagueTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            currentLeague = tab.dataset.league;
            leagueTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            renderTransactions();
        });
    });
}

/**
 * Load transactions from Firestore
 */
async function loadTransactions() {
    try {
        isLoading = true;
        renderLoadingState();

        const result = await getPendingParsedTransactions({
            status: statusFilter?.value || null,
            limit: 100
        });

        transactions = result.data;
        updateStats();
        renderTransactions();
    } catch (error) {
        console.error('Error loading transactions:', error);
        showFeedback('Error loading transactions: ' + error.message, 'error');
    } finally {
        isLoading = false;
    }
}

/**
 * Handle scan button click
 */
async function handleScan() {
    try {
        setScanLoading(true);
        showFeedback('Scanning for new transactions...', 'info');

        const result = await triggerTransactionParser();

        const { totalStored, totalProcessed, totalErrors } = result.data;

        if (totalStored > 0) {
            showFeedback(`Found ${totalStored} new transaction(s)! Processed ${totalProcessed} posts.`, 'success');
            await loadTransactions();
        } else if (totalErrors > 0) {
            showFeedback(`Scan complete with ${totalErrors} error(s). No new transactions found.`, 'warning');
        } else {
            showFeedback('Scan complete. No new transactions found.', 'info');
        }
    } catch (error) {
        console.error('Error running scan:', error);
        showFeedback('Error running scan: ' + error.message, 'error');
    } finally {
        setScanLoading(false);
    }
}

/**
 * Set scan button loading state
 */
function setScanLoading(loading) {
    const scanText = scanBtn?.querySelector('.scan-text');
    const scanSpinner = scanBtn?.querySelector('.scan-spinner');

    if (scanBtn) scanBtn.disabled = loading;
    if (scanText) scanText.style.display = loading ? 'none' : 'inline';
    if (scanSpinner) scanSpinner.style.display = loading ? 'inline-flex' : 'none';
}

/**
 * Handle approve button click
 */
async function handleApprove(transactionId, league) {
    if (!confirm('Approve this transaction and add to the database?')) {
        return;
    }

    try {
        const btn = document.querySelector(`[data-approve-id="${transactionId}"]`);
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Approving...';
        }

        await approveParsedTransaction({
            parsedTransactionId: transactionId,
            league
        });

        showFeedback('Transaction approved and processed!', 'success');
        await loadTransactions();
    } catch (error) {
        console.error('Error approving transaction:', error);
        showFeedback('Error approving: ' + error.message, 'error');

        const btn = document.querySelector(`[data-approve-id="${transactionId}"]`);
        if (btn) {
            btn.disabled = false;
            btn.textContent = 'Approve';
        }
    }
}

/**
 * Handle reject button click
 */
async function handleReject(transactionId, league) {
    const card = document.querySelector(`[data-transaction-id="${transactionId}"]`);
    const btn = document.querySelector(`[data-reject-id="${transactionId}"]`);

    // Immediately fade out the card for instant feedback
    if (card) {
        card.style.transition = 'opacity 0.2s ease-out, transform 0.2s ease-out';
        card.style.opacity = '0.5';
        card.style.pointerEvents = 'none';
    }
    if (btn) {
        btn.disabled = true;
    }

    try {
        await rejectParsedTransaction({
            parsedTransactionId: transactionId,
            league
        });

        // Remove from local data
        if (transactions[league]) {
            transactions[league] = transactions[league].filter(t => t.id !== transactionId);
        }

        // Animate card removal
        if (card) {
            card.style.opacity = '0';
            card.style.transform = 'translateX(-20px)';
            setTimeout(() => card.remove(), 200);
        }

        // Update stats without full reload
        updateStats();

    } catch (error) {
        console.error('Error rejecting transaction:', error);
        showFeedback('Error rejecting: ' + error.message, 'error');

        // Restore card on error
        if (card) {
            card.style.opacity = '1';
            card.style.pointerEvents = '';
        }
        if (btn) {
            btn.disabled = false;
        }
    }
}

/**
 * Update stats display
 */
function updateStats() {
    const allTransactions = [...(transactions.major || []), ...(transactions.minor || [])];

    const pending = allTransactions.filter(t => t.status === 'pending_review').length;
    const today = new Date().toISOString().split('T')[0];

    const approvedToday = allTransactions.filter(t =>
        t.status === 'approved' &&
        t.reviewed_at?.startsWith(today)
    ).length;

    const rejectedToday = allTransactions.filter(t =>
        t.status === 'rejected' &&
        t.reviewed_at?.startsWith(today)
    ).length;

    if (statPending) statPending.textContent = pending;
    if (statApproved) statApproved.textContent = approvedToday;
    if (statRejected) statRejected.textContent = rejectedToday;
}

/**
 * Render loading state
 */
function renderLoadingState() {
    if (transactionsList) {
        transactionsList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">⏳</div>
                <p>Loading transactions...</p>
            </div>
        `;
    }
}

/**
 * Render transactions list
 */
function renderTransactions() {
    if (!transactionsList) return;

    const leagueTransactions = currentLeague === 'major' ?
        (transactions.major || []) : (transactions.minor || []);

    // Apply filters
    let filtered = leagueTransactions;

    const statusFilterValue = statusFilter?.value;
    if (statusFilterValue) {
        filtered = filtered.filter(t => t.status === statusFilterValue);
    }

    const confidenceFilterValue = confidenceFilter?.value;
    if (confidenceFilterValue) {
        filtered = filtered.filter(t => t.confidence === confidenceFilterValue);
    }

    if (filtered.length === 0) {
        transactionsList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">✅</div>
                <p>No transactions to review!</p>
                <p style="font-size: 0.875rem; margin-top: 0.5rem;">
                    ${statusFilterValue === 'pending_review' ?
                        'All caught up. Click "Scan for New Transactions" to check for more.' :
                        'No transactions match the current filters.'
                    }
                </p>
            </div>
        `;
        return;
    }

    transactionsList.innerHTML = filtered.map(t => renderTransactionCard(t)).join('');

    // Attach event handlers
    document.querySelectorAll('[data-approve-id]').forEach(btn => {
        btn.addEventListener('click', () => {
            handleApprove(btn.dataset.approveId, btn.dataset.league);
        });
    });

    document.querySelectorAll('[data-reject-id]').forEach(btn => {
        btn.addEventListener('click', () => {
            handleReject(btn.dataset.rejectId, btn.dataset.league);
        });
    });
}

/**
 * Render a single transaction card
 */
function renderTransactionCard(t) {
    const trans = t.transactions?.[0] || {};
    const typeName = trans.type || 'Unknown';
    const league = t.league || 'major';

    // Format timestamp
    const timestamp = t.source_timestamp ?
        new Date(t.source_timestamp).toLocaleString() : 'Unknown time';

    // Build player moves display
    const playerMoves = (trans.players || []).map(p => {
        const from = p.from || '?';
        const to = p.to || '?';
        return `<span class="player-move">@${p.handle}: ${from} → ${to}</span>`;
    }).join(' ');

    // Build teams display
    const teamsDisplay = (trans.teams || []).map(team =>
        team.name || team.id
    ).join(', ') || 'No teams identified';

    // Build validation errors
    const errors = t.validation_errors || [];
    const errorsHtml = errors.length > 0 ? `
        <div class="validation-errors">
            ${errors.map(e => `<div class="validation-error-item">⚠️ ${e}</div>`).join('')}
        </div>
    ` : '';

    // Determine if actions should be shown
    const showActions = t.status === 'pending_review';

    return `
        <div class="transaction-card confidence-${t.confidence}" data-transaction-id="${t.id}">
            <div class="transaction-header">
                <div>
                    <h3 class="transaction-title">${typeName}</h3>
                    <div class="transaction-meta">
                        From @${t.source_author || 'unknown'} • ${timestamp} •
                        Group ${t.source_group_id || '?'}
                    </div>
                </div>
                <div style="display: flex; gap: 0.5rem; align-items: center;">
                    <span class="confidence-badge confidence-${t.confidence}">${t.confidence}</span>
                    <span class="status-badge status-${t.status}">${(t.status || '').replace('_', ' ')}</span>
                </div>
            </div>

            <div class="transaction-raw">${escapeHtml(t.raw_text || '')}</div>

            <div class="transaction-parsed">
                <div class="parsed-detail">
                    <span class="parsed-label">Type:</span>
                    <span class="transaction-type">${typeName}</span>
                </div>
                <div class="parsed-detail">
                    <span class="parsed-label">Players:</span>
                    <span>${playerMoves || 'None identified'}</span>
                </div>
                <div class="parsed-detail">
                    <span class="parsed-label">Teams:</span>
                    <span>${teamsDisplay}</span>
                </div>
            </div>

            ${errorsHtml}

            ${showActions ? `
                <div class="transaction-actions">
                    <button class="btn-approve" data-approve-id="${t.id}" data-league="${league}">
                        ✓ Approve
                    </button>
                    <button class="btn-reject" data-reject-id="${t.id}" data-league="${league}">
                        ✗ Reject
                    </button>
                </div>
            ` : `
                <div class="transaction-actions" style="color: var(--text-muted); font-size: 0.875rem;">
                    ${t.status === 'approved' ? `Approved by ${t.reviewed_by || 'admin'}` :
                        t.status === 'rejected' ? `Rejected: ${t.rejection_reason || 'No reason given'}` :
                        ''}
                </div>
            `}
        </div>
    `;
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Show feedback message
 */
function showFeedback(message, type = 'info') {
    if (!scanFeedback) return;

    scanFeedback.textContent = message;
    scanFeedback.hidden = false;
    scanFeedback.className = `admin-feedback feedback-${type}`;

    // Auto-hide after 5 seconds for non-errors
    if (type !== 'error') {
        setTimeout(() => {
            scanFeedback.hidden = true;
        }, 5000);
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', init);
