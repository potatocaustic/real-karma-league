// /admin/manage-live-scoring.js

import { auth, db, functions, onAuthStateChanged, doc, onSnapshot, httpsCallable, getDoc, setDoc, query, collection, getDocs, limit } from '/js/firebase-init.js';

// The entire script is wrapped in this event listener to ensure the HTML is fully loaded first.
window.addEventListener('load', () => {

    // --- Page Elements ---
    const loadingContainer = document.getElementById('loading-container');
    const adminContainer = document.getElementById('admin-container');
    const authStatusDiv = document.getElementById('auth-status');
    const statusDisplay = document.getElementById('system-status');
    const nextSampleDisplay = document.getElementById('next-sample-display');
    const lastUpdateDisplay = document.getElementById('last-update-display');
    const usageDisplay = document.getElementById('usage-stats-display');
    const logContainer = document.getElementById('last-sample-log');
    const sampleProgressContainer = document.getElementById('sample-progress-container');
    const sampleProgressBar = document.getElementById('sample-progress-bar');
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
    const progressModal = document.getElementById('progress-modal');
    const progressBar = document.getElementById('progress-bar');
    const progressCounter = document.getElementById('progress-counter');
    const progressTitle = document.getElementById('progress-title');
    const progressStatus = document.getElementById('progress-status');
    const progressCloseBtn = document.getElementById('progress-close-btn');

    // --- DEV ENVIRONMENT CONFIG ---
    const USE_DEV_COLLECTIONS = true;
    const getCollectionName = (baseName) => {
        if (baseName.includes('live_scoring_status') || baseName.includes('usage_stats') || baseName.includes('live_games')) {
            return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
        }
        return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
    };

    // --- Firebase Callable Functions ---
    const setLiveScoringStatus = httpsCallable(functions, 'setLiveScoringStatus');
    const updateAllLiveScores = httpsCallable(functions, 'updateAllLiveScores');

    // --- Global State ---
    let countdownIntervalId = null;
    let historicalChart = null;
    let currentDayChart = null;

    async function renderUsageCharts(currentDayId) {
        const usageQuery = query(collection(db, getCollectionName('usage_stats')));
        const usageSnap = await getDocs(usageQuery);

        const labels = [];
        const apiData = [];
        const gameCountData = [];

        usageSnap.docs.sort((a, b) => a.id.localeCompare(b.id)).forEach(doc => {
            const data = doc.data();
            labels.push(doc.id);
            apiData.push((data.api_requests_full_update || 0) + (data.api_requests_sample || 0));
            gameCountData.push(data.live_game_count || 0);
        });

        const histCtx = document.getElementById('historical-usage-chart').getContext('2d');
        if (historicalChart) historicalChart.destroy();
        historicalChart = new Chart(histCtx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Total API Requests',
                    data: apiData,
                    backgroundColor: 'rgba(0, 123, 255, 0.5)',
                    borderColor: 'rgba(0, 123, 255, 1)',
                    borderWidth: 1
                }, {
                    label: 'Games Scored',
                    data: gameCountData,
                    type: 'line',
                    yAxisID: 'y1',
                    borderColor: 'rgba(255, 193, 7, 1)',
                }]
            },
            options: { scales: { y: { beginAtZero: true, stacked: false }, y1: { type: 'linear', display: true, position: 'right', grid: { drawOnChartArea: false } } } }
        });

        const currentDayData = usageSnap.docs.find(doc => doc.id === currentDayId)?.data();
        const currentCtx = document.getElementById('current-day-chart').getContext('2d');
        if (currentDayChart) currentDayChart.destroy();
        if (currentDayData) {
            const totalRequests = (currentDayData.api_requests_full_update || 0) + (currentDayData.api_requests_sample || 0);
            currentDayChart = new Chart(currentCtx, {
                type: 'doughnut',
                data: {
                    labels: ['Full Updates', 'Sampler'],
                    datasets: [{
                        data: [currentDayData.api_requests_full_update || 0, currentDayData.api_requests_sample || 0],
                        backgroundColor: ['#17a2b8', '#ffc107']
                    }]
                },
                plugins: [{
                    id: 'doughnut-center-text',
                    beforeDraw: (chart) => {
                        const { ctx, width, height } = chart;
                        ctx.restore();
                        const fontSize = (height / 114).toFixed(2);
                        ctx.font = `${fontSize}em sans-serif`;
                        ctx.textBaseline = 'middle';
                        const text = `${totalRequests}`;
                        const textX = Math.round((width - ctx.measureText(text).width) / 2);
                        const textY = height / 2;
                        ctx.fillText(text, textX, textY);
                        ctx.save();
                    }
                }]
            });
        }
    }

    function startSampleCountdown(lastSampleTimestamp, intervalMinutes) {
        if (countdownIntervalId) clearInterval(countdownIntervalId);
        if (!lastSampleTimestamp) {
            nextSampleDisplay.textContent = "Waiting...";
            return;
        };

        const targetTime = lastSampleTimestamp.toDate().getTime() + (intervalMinutes * 60 * 1000);

        countdownIntervalId = setInterval(() => {
            const now = new Date().getTime();
            const distance = targetTime - now;

            if (distance < 0) {
                clearInterval(countdownIntervalId);
                nextSampleDisplay.textContent = "Sampling...";
                sampleProgressContainer.style.display = 'block';
                let progress = 0;
                const progressInterval = setInterval(() => {
                    progress += 10;
                    sampleProgressBar.style.width = `${progress}%`;
                    if (progress >= 100) clearInterval(progressInterval);
                }, 300);
                return;
            }

            const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((distance % (1000 * 60)) / 1000);
            nextSampleDisplay.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        }, 1000);
    }

    async function runFullUpdateWithProgress() {
        const liveGamesQuery = query(collection(db, getCollectionName('live_games')));
        const liveGamesSnap = await getDocs(liveGamesQuery);
        const playerCount = liveGamesSnap.docs.reduce((sum, doc) => sum + doc.data().team1_lineup.length + doc.data().team2_lineup.length, 0);

        if (playerCount === 0) {
            alert("No active live games found. Cannot run an update.");
            return;
        }

        progressModal.style.display = 'flex';
        progressBar.style.width = '0%';
        progressCounter.textContent = '';
        progressTitle.textContent = 'Performing Full Score Update...';
        progressStatus.textContent = `Fetching scores for ${playerCount} players.`;
        progressCloseBtn.style.display = 'none';

        const avgTimePerPlayer = 250;
        const totalTime = playerCount * avgTimePerPlayer;
        let elapsedTime = 0;

        const progressInterval = setInterval(() => {
            elapsedTime += 100;
            const progress = Math.min((elapsedTime / totalTime) * 100, 99);
            progressBar.style.width = `${progress}%`;
            const playersProcessed = Math.min(Math.floor((elapsedTime / totalTime) * playerCount), playerCount);
            progressCounter.textContent = `${playersProcessed} / ${playerCount} players processed...`;
        }, 100);

        try {
            await updateAllLiveScores();
        } catch (error) {
            throw error;
        } finally {
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

        onSnapshot(statusRef, (docSnap) => {
            if (docSnap.exists()) {
                const { status = 'stopped', interval_minutes = 5, last_full_update_completed, last_sample_results, active_game_date, last_sample_completed_at } = docSnap.data();
                
                sampleProgressContainer.style.display = 'none';
                sampleProgressBar.style.width = '0%';

                statusDisplay.textContent = status.toUpperCase();
                intervalInput.value = interval_minutes;

                if (last_full_update_completed) {
                    lastUpdateDisplay.textContent = last_full_update_completed.toDate().toLocaleString();
                }

                [stoppedControls, pausedControls, activeControls].forEach(el => el.style.display = 'none');
                if (status === 'active') {
                    statusDisplay.style.color = '#28a745';
                    activeControls.style.display = 'flex';
                    startSampleCountdown(last_sample_completed_at, interval_minutes);
                } else if (status === 'paused') {
                    statusDisplay.style.color = '#ffc107';
                    pausedControls.style.display = 'block';
                    if (countdownIntervalId) clearInterval(countdownIntervalId);
                    nextSampleDisplay.textContent = 'PAUSED';
                } else {
                    statusDisplay.style.color = '#dc3545';
                    stoppedControls.style.display = 'block';
                    if (countdownIntervalId) clearInterval(countdownIntervalId);
                    nextSampleDisplay.textContent = 'INACTIVE';
                }

                if (last_sample_results && last_sample_results.length > 0) {
                    logContainer.innerHTML = last_sample_results.map(res => {
                        const changeIndicator = res.changed ? '✓' : '✗';
                        const color = res.changed ? 'var(--accent-color)' : '#ffc107';
                        return `<p style="color: ${color};">[${changeIndicator}] ${res.handle}: ${res.oldScore.toFixed(2)} → ${res.newScore.toFixed(2)}</p>`;
                    }).join('');
                } else {
                    logContainer.innerHTML = `<p>No sample run yet.</p>`;
                }
                
                if (active_game_date) {
                    const todayUsageRef = doc(db, getCollectionName('usage_stats'), active_game_date);
                    onSnapshot(todayUsageRef, (usageSnap) => {
                        if (usageSnap.exists()) {
                            const { api_requests_full_update = 0, api_requests_sample = 0 } = usageSnap.data();
                            usageDisplay.textContent = `Full Update API Calls: ${api_requests_full_update} | Sampler API Calls: ${api_requests_sample}`;
                        } else {
                            usageDisplay.textContent = "No usage recorded yet for today.";
                        }
                    });
                    renderUsageCharts(active_game_date);
                }

            } else {
                statusDisplay.textContent = 'STOPPED';
                statusDisplay.style.color = '#dc3545';
                stoppedControls.style.display = 'block';
                pausedControls.style.display = 'none';
                activeControls.style.display = 'none';
                intervalInput.value = 5;
                if (countdownIntervalId) clearInterval(countdownIntervalId);
                nextSampleDisplay.textContent = 'INACTIVE';
                logContainer.innerHTML = `<p>System is stopped.</p>`;
            }
        });

        beginBtn.addEventListener('click', async () => {
            beginBtn.disabled = true;
            try {
                const liveGamesQuery = query(collection(db, getCollectionName('live_games')), limit(1));
                const liveGamesSnap = await getDocs(liveGamesQuery);
                if (liveGamesSnap.empty) {
                    throw new Error("Cannot begin live scoring without any active games.");
                }
                const gameData = liveGamesSnap.docs[0].data();
                const dateObj = gameData.activatedAt.toDate();
                const year = dateObj.getFullYear();
                const month = String(dateObj.getMonth() + 1).padStart(2, '0');
                const day = String(dateObj.getDate()).padStart(2, '0');
                const gameDate = `${year}-${month}-${day}`;

                await setLiveScoringStatus({
                    status: 'active',
                    interval: parseInt(intervalInput.value),
                    gameDate: gameDate
                });

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
                    await setDoc(doc(db, getCollectionName('live_scoring_status'), 'status'), { interval_minutes: interval }, { merge: true });
                    alert("Interval saved. Change will apply on next sample run.");
                } catch (error) {
                    alert(`Error saving interval: ${error.message}`);
                }
            } else {
                alert("Interval must be a positive number.");
            }
        });
    
        progressCloseBtn.addEventListener('click', () => {
            progressModal.style.display = 'none';
        });
    }

    // --- Main Authentication and Initialization Logic ---
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            const userRef = doc(db, getCollectionName("users"), user.uid);
            const userDoc = await getDoc(userRef);
            if (userDoc.exists() && userDoc.data().role === 'admin') {
                loadingContainer.style.display = 'none';
                adminContainer.style.display = 'block';
                authStatusDiv.innerHTML = `Welcome, Admin | <a href="#" id="logout-btn">Logout</a>`;
                const logoutBtn = document.getElementById('logout-btn');
                if (logoutBtn) {
                    logoutBtn.addEventListener('click', (e) => {
                        e.preventDefault();
                        auth.signOut().then(() => { window.location.href = '/login.html'; });
                    });
                }
                initializeControlPanel();
            } else {
                loadingContainer.innerHTML = '<div class="error">Access Denied.</div>';
            }
        } else {
            window.location.href = '/login.html';
        }
    });
});