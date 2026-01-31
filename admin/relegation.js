// /admin/relegation.js

import { auth, db, functions, onAuthStateChanged, signOut, doc, getDoc, httpsCallable } from '/js/firebase-init.js';

// --- Page Elements ---
let loadingContainer, adminContainer, authStatusDiv;
let majorSeasonIdEl, majorSeasonStatusEl, minorSeasonStatusEl, relegationStatusEl;
let matchupPanel, majorTeamNameEl, majorTeamRecordEl, majorTeamSortscoreEl;
let minorTeamNameEl, minorTeamInfoEl;
let gamePanel, gameDateEl, gameStatusEl, scheduleGameLink;
let resultPanel, winnerAnnouncementEl;
let executionPanel, executionInfoEl;
let detectActionPanel, detectMatchupBtn;
let executeActionPanel, executePromotionBtn;
let confirmModal, confirmPromotedTeamEl, confirmRelegatedTeamEl;
let cancelExecuteBtn, confirmExecuteBtn;
let errorDisplay;

// --- Global State ---
let currentRelegationData = null;

document.addEventListener('DOMContentLoaded', () => {
    loadingContainer = document.getElementById('loading-container');
    adminContainer = document.getElementById('admin-container');
    authStatusDiv = document.getElementById('auth-status');

    // Season status elements
    majorSeasonIdEl = document.getElementById('major-season-id');
    majorSeasonStatusEl = document.getElementById('major-season-status');
    minorSeasonStatusEl = document.getElementById('minor-season-status');
    relegationStatusEl = document.getElementById('relegation-status');

    // Matchup panel elements
    matchupPanel = document.getElementById('matchup-panel');
    majorTeamNameEl = document.getElementById('major-team-name');
    majorTeamRecordEl = document.getElementById('major-team-record');
    majorTeamSortscoreEl = document.getElementById('major-team-sortscore');
    minorTeamNameEl = document.getElementById('minor-team-name');
    minorTeamInfoEl = document.getElementById('minor-team-info');

    // Game panel elements
    gamePanel = document.getElementById('game-panel');
    gameDateEl = document.getElementById('game-date');
    gameStatusEl = document.getElementById('game-status');
    scheduleGameLink = document.getElementById('schedule-game-link');

    // Result panel elements
    resultPanel = document.getElementById('result-panel');
    winnerAnnouncementEl = document.getElementById('winner-announcement');

    // Execution panel elements
    executionPanel = document.getElementById('execution-panel');
    executionInfoEl = document.getElementById('execution-info');

    // Action buttons
    detectActionPanel = document.getElementById('detect-action-panel');
    detectMatchupBtn = document.getElementById('detect-matchup-btn');
    executeActionPanel = document.getElementById('execute-action-panel');
    executePromotionBtn = document.getElementById('execute-promotion-btn');

    // Modal elements
    confirmModal = document.getElementById('confirm-modal');
    confirmPromotedTeamEl = document.getElementById('confirm-promoted-team');
    confirmRelegatedTeamEl = document.getElementById('confirm-relegated-team');
    cancelExecuteBtn = document.getElementById('cancel-execute-btn');
    confirmExecuteBtn = document.getElementById('confirm-execute-btn');

    // Error display
    errorDisplay = document.getElementById('error-display');

    // Event listeners
    detectMatchupBtn.addEventListener('click', handleDetectMatchup);
    executePromotionBtn.addEventListener('click', openConfirmModal);
    cancelExecuteBtn.addEventListener('click', closeConfirmModal);
    confirmExecuteBtn.addEventListener('click', handleExecutePromotion);

    // Initialize with admin auth
    initAdminAuth();
});

function initAdminAuth() {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            // If the user is anonymous, sign them out and redirect to login
            if (user.isAnonymous) {
                await signOut(auth);
                window.location.href = '/login.html?target=admin';
                return;
            }

            const userRef = doc(db, "users", user.uid);
            const userDoc = await getDoc(userRef);

            if (userDoc.exists() && userDoc.data().role === 'admin') {
                loadingContainer.style.display = 'none';
                adminContainer.style.display = 'block';
                authStatusDiv.innerHTML = `Welcome, Admin | <a href="#" id="logout-btn">Logout</a>`;
                addLogoutListener();
                await initializePage();
            } else {
                loadingContainer.innerHTML = '<div class="error">Access Denied. You do not have permission to view this page.</div>';
                authStatusDiv.innerHTML = `Access Denied | <a href="#" id="logout-btn">Logout</a>`;
                addLogoutListener();
            }
        } else {
            window.location.href = '/login.html?target=admin';
        }
    });
}

function addLogoutListener() {
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            auth.signOut().then(() => {
                window.location.href = '/login.html?target=admin';
            });
        });
    }
}

async function initializePage() {
    try {
        await loadRelegationStatus();
    } catch (error) {
        showError(`Failed to initialize: ${error.message}`);
    }
}

async function loadRelegationStatus() {
    try {
        hideError();
        const getRelegationStatus = httpsCallable(functions, 'getRelegationStatus');
        const result = await getRelegationStatus({});
        currentRelegationData = result.data;
        renderStatus(currentRelegationData);
    } catch (error) {
        console.error('Error loading relegation status:', error);
        showError(`Failed to load relegation status: ${error.message}`);
    }
}

function renderStatus(data) {
    // Update season status
    majorSeasonIdEl.textContent = data.seasonId || '--';
    majorSeasonStatusEl.textContent = data.majorSeasonStatus || '--';
    minorSeasonStatusEl.textContent = data.minorSeasonStatus || '--';

    // Update relegation status badge
    const status = data.status || 'pending';
    relegationStatusEl.textContent = formatStatus(status);
    relegationStatusEl.className = `status-badge ${status}`;

    // Show/hide detect action
    if (data.canDetectMatchup && !data.exists) {
        detectActionPanel.style.display = 'block';
    } else {
        detectActionPanel.style.display = 'none';
    }

    // Show matchup panel if matchup is set
    if (data.major_team && data.minor_champion) {
        renderMatchup(data.major_team, data.minor_champion);
        matchupPanel.style.display = 'block';
    } else {
        matchupPanel.style.display = 'none';
    }

    // Show game panel if matchup is set
    if (data.status && ['matchup_set', 'scheduled', 'completed', 'executed', 'no_change'].includes(data.status)) {
        renderGamePanel(data);
        gamePanel.style.display = 'block';
    } else {
        gamePanel.style.display = 'none';
    }

    // Show result panel if completed
    if (data.status === 'completed' || data.status === 'executed' || data.status === 'no_change') {
        renderResultPanel(data);
        resultPanel.style.display = 'block';
    } else {
        resultPanel.style.display = 'none';
    }

    // Show execution panel if executed
    if (data.status === 'executed') {
        executionPanel.style.display = 'block';
        if (data.executed_at) {
            const executedDate = data.executed_at.toDate ? data.executed_at.toDate() : new Date(data.executed_at);
            executionInfoEl.textContent = `Promotion/relegation was executed on ${executedDate.toLocaleDateString()}.`;
        }
    } else {
        executionPanel.style.display = 'none';
    }

    // Show/hide execute action
    if (data.canExecutePromotion) {
        executeActionPanel.style.display = 'block';
    } else {
        executeActionPanel.style.display = 'none';
    }
}

function renderMatchup(majorTeam, minorChampion) {
    majorTeamNameEl.textContent = majorTeam.team_name || majorTeam.team_id;
    majorTeamRecordEl.textContent = majorTeam.record ? `${majorTeam.record} record` : '';
    majorTeamSortscoreEl.textContent = majorTeam.sortscore !== undefined
        ? `Sortscore: ${majorTeam.sortscore.toFixed(3)}`
        : '';

    minorTeamNameEl.textContent = minorChampion.team_name || minorChampion.team_id;
    minorTeamInfoEl.textContent = 'Minor League Champion';
}

function renderGamePanel(data) {
    if (data.game_date) {
        gameDateEl.textContent = data.game_date;
    } else {
        gameDateEl.textContent = 'Not Scheduled';
    }

    if (data.status === 'scheduled') {
        gameStatusEl.textContent = 'Scheduled (Pending)';
    } else if (data.status === 'completed' || data.status === 'executed' || data.status === 'no_change') {
        gameStatusEl.textContent = 'Completed';
    } else {
        gameStatusEl.textContent = 'Not Scheduled';
    }

    // Show/hide schedule link
    if (data.canScheduleGame) {
        scheduleGameLink.style.display = 'inline-block';
    } else {
        scheduleGameLink.style.display = 'none';
    }
}

function renderResultPanel(data) {
    if (data.promotion_required === true) {
        winnerAnnouncementEl.className = 'winner-announcement promotion-required';
        winnerAnnouncementEl.innerHTML = `
            <strong>${data.minor_champion?.team_name || 'Minor Champion'}</strong> won the relegation game!<br>
            <span style="font-size: 0.9rem;">Promotion/relegation ${data.status === 'executed' ? 'has been' : 'is required to be'} executed.</span>
        `;
    } else if (data.winner_league === 'major') {
        winnerAnnouncementEl.className = 'winner-announcement no-promotion';
        winnerAnnouncementEl.innerHTML = `
            <strong>${data.major_team?.team_name || 'Major Team'}</strong> won the relegation game!<br>
            <span style="font-size: 0.9rem;">No promotion/relegation required. Teams stay in their current leagues.</span>
        `;
    } else {
        winnerAnnouncementEl.className = 'winner-announcement';
        winnerAnnouncementEl.textContent = 'Awaiting result...';
    }
}

function formatStatus(status) {
    const statusMap = {
        'pending': 'Pending',
        'matchup_set': 'Matchup Set',
        'scheduled': 'Scheduled',
        'completed': 'Completed',
        'executed': 'Executed',
        'no_change': 'No Change Needed'
    };
    return statusMap[status] || status;
}

async function handleDetectMatchup() {
    detectMatchupBtn.disabled = true;
    detectMatchupBtn.textContent = 'Detecting...';

    try {
        hideError();
        const detectRelegationMatchup = httpsCallable(functions, 'detectRelegationMatchup');
        const result = await detectRelegationMatchup({});

        if (result.data.matchup) {
            currentRelegationData = result.data.relegationDoc;
            await loadRelegationStatus(); // Reload to get full status
        } else {
            showError('Could not detect matchup. Both seasons must be complete.');
        }
    } catch (error) {
        console.error('Error detecting matchup:', error);
        showError(`Failed to detect matchup: ${error.message}`);
    } finally {
        detectMatchupBtn.disabled = false;
        detectMatchupBtn.textContent = 'Detect Relegation Matchup';
    }
}

function openConfirmModal() {
    if (!currentRelegationData) return;

    confirmPromotedTeamEl.textContent = currentRelegationData.minor_champion?.team_name || '--';
    confirmRelegatedTeamEl.textContent = currentRelegationData.major_team?.team_name || '--';
    confirmModal.classList.add('is-visible');
}

function closeConfirmModal() {
    confirmModal.classList.remove('is-visible');
}

async function handleExecutePromotion() {
    if (!currentRelegationData) return;

    confirmExecuteBtn.disabled = true;
    confirmExecuteBtn.textContent = 'Executing...';

    try {
        hideError();
        const executePromotion = httpsCallable(functions, 'executePromotion');
        const result = await executePromotion({
            seasonId: currentRelegationData.season || currentRelegationData.seasonId
        });

        closeConfirmModal();

        if (result.data.success) {
            alert(`Promotion executed successfully!\n\n` +
                `Promoted: ${result.data.promotedTeam}\n` +
                `Relegated: ${result.data.relegatedTeam}\n` +
                `Players promoted: ${result.data.playersPromoted}\n` +
                `Players relegated: ${result.data.playersRelegated}\n` +
                `Draft picks swapped: ${result.data.picksSwapped}`);
            await loadRelegationStatus();
        }
    } catch (error) {
        console.error('Error executing promotion:', error);
        showError(`Failed to execute promotion: ${error.message}`);
    } finally {
        confirmExecuteBtn.disabled = false;
        confirmExecuteBtn.textContent = 'Confirm Promotion';
    }
}

function showError(message) {
    errorDisplay.textContent = message;
    errorDisplay.style.display = 'block';
}

function hideError() {
    errorDisplay.style.display = 'none';
    errorDisplay.textContent = '';
}
