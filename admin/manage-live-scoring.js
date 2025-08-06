// /admin/manage-live-scoring.js

import { auth, db, functions, onAuthStateChanged, doc, onSnapshot, httpsCallable, getDoc, setDoc, query, collection, getDocs } from '/js/firebase-init.js';

// ... (Standard Dev Config and Admin Auth Check) ...
const USE_DEV_COLLECTIONS = true;
const getCollectionName = (baseName) => {
    if (baseName.includes('live_scoring_status') || baseName.includes('usage_stats')) {
        return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
    }
    return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
};

// --- Page Elements ---
const loadingContainer = document.getElementById('loading-container');
const adminContainer = document.getElementById('admin-container');
const authStatusDiv = document.getElementById('auth-status');
const statusDisplay = document.getElementById('system-status');
const nextSampleDisplay = document.getElementById('next-sample-display');
const lastUpdateDisplay = document.getElementById('last-update-display');

// Control Buttons
const stoppedControls = document.getElementById('stopped-controls');
const pausedControls = document.getElementById('paused-controls');
const activeControls = document.getElementById('active-controls');
const beginBtn = document.getElementById('begin-btn');
const resumePausedBtn = document.getElementById('resume-paused-btn');
const pauseBtn = document.getElementById('pause-btn');
const stopBtn = document.getElementById('stop-btn');
const manualUpdateBtn = document.getElementById('manual-update-btn');
const intervalInput = document.getElementById('interval-input');
const saveIntervalBtn = document.getElementById('save-interval-btn');
const usageDisplay = document.getElementById('usage-stats-display');

// Progress Modal Elements
const progressModal = document.getElementById('progress-modal');
const progressBar = document.getElementById('progress-bar');
const progressCounter = document.getElementById('progress-counter');
const progressTitle = document.getElementById('progress-title');
const progressStatus = document.getElementById('progress-status');
const progressCloseBtn = document.getElementById('progress-close-btn');

// --- Firebase Callable Functions ---
const setLiveScoringStatus = httpsCallable(functions, 'setLiveScoringStatus');
const updateAllLiveScores = httpsCallable(functions, 'updateAllLiveScores');

let nextSampleIntervalId = null;

function updateNextSampleTime(intervalMinutes) {
    if (nextSampleIntervalId) clearInterval(nextSampleIntervalId);
    
    function update() {
        const now = new Date();
        const minutes = now.getMinutes();
        const seconds = now.getSeconds();
        const nextRunMinute = (Math.floor(minutes / intervalMinutes) + 1) * intervalMinutes;
        
        let diffMinutes = nextRunMinute - minutes - 1;
        let diffSeconds = 60 - seconds;

        if (diffSeconds === 60) {
            diffSeconds = 0;
            diffMinutes += 1;
        }

        if (diffMinutes < 0) { // Handle wrapping around the hour
            diffMinutes += 60;
        }
        
        nextSampleDisplay.textContent = `${String(diffMinutes).padStart(2, '0')}:${String(diffSeconds).padStart(2, '0')}`;
    }
    update();
    nextSampleIntervalId = setInterval(update, 1000);
}


async function runFullUpdateWithProgress() {
    // 1. Get player count to estimate time
    const liveGamesQuery = query(collection(db, getCollectionName('live_games')));
    const liveGamesSnap = await getDocs(liveGamesQuery);
    const playerCount = liveGamesSnap.docs.reduce((sum, doc) => sum + doc.data().team1_lineup.length + doc.data().team2_lineup.length, 0);

    if (playerCount === 0) {
        alert("No active live games found. Cannot run an update.");
        return;
    }
    
    // 2. Setup and show modal
    progressModal.style.display = 'flex';
    progressBar.style.width = '0%';
    progressCounter.textContent = '';
    progressTitle.textContent = 'Performing Full Score Update...';
    progressStatus.textContent = `Fetching scores for ${playerCount} players.`;
    progressCloseBtn.style.display = 'none';

    // 3. Simulate progress
    const avgTimePerPlayer = 250; // Average 250ms per player (API call + 100-300ms delay)
    const totalTime = playerCount * avgTimePerPlayer;
    let elapsedTime = 0;
    
    const progressInterval = setInterval(() => {
        elapsedTime += 100;
        const progress = Math.min((elapsedTime / totalTime) * 100, 99); // Cap at 99% until complete
        progressBar.style.width = `${progress}%`;
        const playersProcessed = Math.min(Math.floor((elapsedTime / totalTime) * playerCount), playerCount);
        progressCounter.textContent = `${playersProcessed} / ${playerCount} players processed...`;
    }, 100);

    // 4. Run the actual update function
    try {
        await updateAllLiveScores();
    } catch (error) {
        throw error; // Propagate error to be caught by the caller
    } finally {
        // 5. Finalize UI
        clearInterval(progressInterval);
        progressBar.style.width = '100%';
        progressTitle.textContent = "Processing Complete!";
        progressStatus.textContent = "All live game scores have been updated.";
        progressCounter.textContent = `${playerCount} / ${playerCount} players processed.`;
        progressCloseBtn.style.display = 'block';
    }
}


function initializeControlPanel() {
    const statusRef = doc(db, getCollectionName('live_scoring_status'), 'status');
    const today = new Date().toISOString().split('T')[0];
    const usageRef = doc(db, getCollectionName('usage_stats'), today);

    onSnapshot(statusRef, (docSnap) => {
        if (docSnap.exists()) {
            const { status = 'stopped', interval_minutes = 5, last_full_update_completed } = docSnap.data();
            
            statusDisplay.textContent = status.toUpperCase();
            intervalInput.value = interval_minutes;

            if (last_full_update_completed) {
                lastUpdateDisplay.textContent = last_full_update_completed.toDate().toLocaleString();
            }

            [stoppedControls, pausedControls, activeControls].forEach(el => el.style.display = 'none');
            if (status === 'active') {
                statusDisplay.style.color = '#28a745';
                activeControls.style.display = 'flex';
                updateNextSampleTime(interval_minutes);
            } else if (status === 'paused') {
                statusDisplay.style.color = '#ffc107';
                pausedControls.style.display = 'block';
                if(nextSampleIntervalId) clearInterval(nextSampleIntervalId);
                nextSampleDisplay.textContent = 'PAUSED';
            } else { // stopped
                statusDisplay.style.color = '#dc3545';
                stoppedControls.style.display = 'block';
                if(nextSampleIntervalId) clearInterval(nextSampleIntervalId);
                nextSampleDisplay.textContent = 'INACTIVE';
            }
        } else {
            statusDisplay.textContent = 'STOPPED';
            statusDisplay.style.color = '#dc3545';
            stoppedControls.style.display = 'block';
        }
    });

    onSnapshot(usageRef, (docSnap) => {
        if (docSnap.exists()) {
            const { api_requests_full_update = 0, api_requests_sample = 0 } = docSnap.data();
            usageDisplay.innerHTML = `<strong>Full Update API Calls:</strong> ${api_requests_full_update}<br><strong>Sampler API Calls:</strong> ${api_requests_sample}`;
        } else {
            usageDisplay.textContent = "No usage recorded yet for today.";
        }
    });

    // --- Event Listeners for Buttons ---
    beginBtn.addEventListener('click', async () => {
        beginBtn.disabled = true;
        try {
            await setLiveScoringStatus({ status: 'active', interval: parseInt(intervalInput.value) });
            await runFullUpdateWithProgress();
        } catch (error) {
            alert(`Error beginning live scoring: ${error.message}`);
        } finally {
            beginBtn.disabled = false;
        }
    });

    resumePausedBtn.addEventListener('click', async () => {
        try {
            await setLiveScoringStatus({ status: 'active' });
        } catch (error) {
            alert(`Error resuming: ${error.message}`);
        }
    });

    pauseBtn.addEventListener('click', async () => {
        try {
            await setLiveScoringStatus({ status: 'paused' });
        } catch (error) {
            alert(`Error pausing: ${error.message}`);
        }
    });
    
    stopBtn.addEventListener('click', async () => {
        if (confirm("Are you sure you want to stop the live scoring system entirely?")) {
            try {
                await setLiveScoringStatus({ status: 'stopped' });
            } catch (error) {
                alert(`Error stopping: ${error.message}`);
            }
        }
    });

    manualUpdateBtn.addEventListener('click', async () => {
        manualUpdateBtn.disabled = true;
        try {
            await runFullUpdateWithProgress();
        } catch (error) {
            alert(`Error during manual update: ${error.message}`);
        } finally {
            manualUpdateBtn.disabled = false;
        }
    });

    saveIntervalBtn.addEventListener('click', async () => {
        const interval = parseInt(intervalInput.value);
        if (interval > 0) {
            try {
                await setDoc(statusRef, { interval_minutes: interval }, { merge: true });
                alert("Interval saved. Change will apply on next sample run.");
            } catch(error) {
                alert(`Error saving interval: ${error.message}`);
            }
        } else {
            alert("Interval must be a positive number.");
        }
    });

    progressCloseBtn.addEventListener('click', () => {
        progressModal.style.display = 'none';
    });
    
    // Logout listener
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            auth.signOut().then(() => { window.location.href = '/login.html'; });
        });
    }
}


// --- Main Execution ---
onAuthStateChanged(auth, async (user) => {
    if (user) {
        const userRef = doc(db, getCollectionName("users"), user.uid);
        const userDoc = await getDoc(userRef);
        if (userDoc.exists() && userDoc.data().role === 'admin') {
            loadingContainer.style.display = 'none';
            adminContainer.style.display = 'block';
            authStatusDiv.innerHTML = `Welcome, Admin | <a href="#" id="logout-btn">Logout</a>`;
            initializeControlPanel();
        } else {
            loadingContainer.innerHTML = '<div class="error">Access Denied.</div>';
        }
    } else {
        window.location.href = '/login.html';
    }
});