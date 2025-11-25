// /admin/manage-live-scoring.js

import { auth, db, functions, onAuthStateChanged, doc, onSnapshot, httpsCallable, getDoc, setDoc, query, collection, getDocs, limit, getCurrentLeague } from '/js/firebase-init.js';

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
    const testAutofinalizeBtn = document.getElementById('test-autofinalize-btn');
    const autofinalizeTimeInput = document.getElementById('autofinalize-time-input');
    const statUpdateTimeInput = document.getElementById('stat-update-time-input');
    const saveScheduleBtn = document.getElementById('save-schedule-btn');


    // --- DEV ENVIRONMENT CONFIG ---
    const USE_DEV_COLLECTIONS = false;
    const getCollectionName = (baseName) => {
        if (baseName.includes('live_scoring_status') || baseName.includes('usage_stats') || baseName.includes('live_games')) {
            return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
        }
        return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
    };

    // --- Firebase Callable Functions ---
    const setLiveScoringStatus = httpsCallable(functions, 'setLiveScoringStatus');
    const updateAllLiveScores = httpsCallable(functions, 'updateAllLiveScores');
    const forceLeaderboardRecalculation = httpsCallable(functions, 'forceLeaderboardRecalculation');
    const test_autoFinalizeGames = httpsCallable(functions, 'test_autoFinalizeGames');
    const updateScheduledJobTimes = httpsCallable(functions, 'updateScheduledJobTimes');
    const getScheduledJobTimes = httpsCallable(functions, 'getScheduledJobTimes');


    // --- Global State ---
    let countdownIntervalId = null;
    let historicalChart = null;
    let currentDayChart = null;

    async function populateScheduleTimes() {
        try {
            const result = await getScheduledJobTimes({ league: getCurrentLeague() });

            if (result.data && result.data.success) {
                // Only update the input's value if the fetched time is a valid, non-empty string.
                if (result.data.autoFinalizeTime && typeof result.data.autoFinalizeTime === 'string') {
                    console.log("PASSED: Setting Auto-Finalize time input.");
                    autofinalizeTimeInput.value = result.data.autoFinalizeTime;
                } else {
                    console.log("SKIPPED: Condition failed for Auto-Finalize time. Input will not be changed from its default.");
                }

                if (result.data.statUpdateTime && typeof result.data.statUpdateTime === 'string') {
                    console.log("PASSED: Setting Stat Update time input.");
                    statUpdateTimeInput.value = result.data.statUpdateTime;
                } else {
                    console.log("SKIPPED: Condition failed for Stat Update time. Input will not be changed from its default.");
                }
                 console.log("------------------------------------");
            } else {
                console.error("Failed to fetch schedule times from server:", result.data?.error);
                alert("Could not retrieve current schedule times. Displaying default values. Error: " + (result.data?.error || 'Unknown failure.'));
            }
        } catch (error) {
            console.error("An error occurred while calling getScheduledJobTimes. Displaying defaults.", error);
            alert("A critical error occurred while fetching schedule times. Displaying default values.");
        }
    }

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
            options: { scales: { y: { beginAtZero: true, stacked: false }, y1: { type: 'linear', display: true, position: 'right', grid: { drawOnChartArea: false }, ticks: {precision: 0, stepSize: 1} } } }
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
            await updateAllLiveScores({ league: getCurrentLeague() });
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
        
        populateScheduleTimes();

        onSnapshot(statusRef, (docSnap) => {
            if (docSnap.exists()) {
                const { status = 'stopped', interval_minutes = 5, last_full_update_completed, last_sample_results, active_game_date, last_sample_completed_at, show_live_features = true } = docSnap.data();

                // Update the toggle checkbox
                const featuresToggle = document.getElementById('show-live-features-toggle');
                if (featuresToggle) {
                    featuresToggle.checked = show_live_features;
                }
                
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
                        // Check if either karma or rank has changed to determine the overall status.
                        const overallChange = res.karmaChanged || res.rankChanged;
                        const changeIndicator = overallChange ? '✓' : '✗';
                        const color = overallChange ? '#28a745' : '#555'; // Green for changed, dark gray for no change

                        // Format the karma string, making it bold if it changed.
                        let karmaString = `Karma: ${res.oldScore.toFixed(2)} → ${res.newScore.toFixed(2)}`;
                        if (res.karmaChanged) {
                            karmaString = `<strong>${karmaString}</strong>`;
                        }

                        // Format the rank string, making it bold if it changed.
                        let rankString = `Rank: ${res.oldRank} → ${res.newRank}`;
                        if (res.rankChanged) {
                            rankString = `<strong>${rankString}</strong>`;
                        }

                        // Return the combined, formatted string for the log entry.
                        return `<p style="color: ${color}; margin-bottom: 0.25rem; line-height: 1.5;">
                                    <span style="font-weight: bold;">[${changeIndicator}] ${res.handle}:</span>
                                    <span style="margin-left: 8px;">${karmaString}</span>
                                    <span style="margin-left: 8px;">|</span>
                                    <span style="margin-left: 8px;">${rankString}</span>
                                </p>`;
                    }).join('');
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
                    gameDate: gameDate,
                    league: getCurrentLeague()
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
                await setLiveScoringStatus({ status: 'active', league: getCurrentLeague() });
            } catch (error) {
                alert(`Error resuming: ${error.message}`);
            }
        });
    
        pauseBtn.addEventListener('click', async () => {
            try {
                await setLiveScoringStatus({ status: 'paused', league: getCurrentLeague() });
            } catch (error) {
                alert(`Error pausing: ${error.message}`);
            }
        });
    
        stopBtn.addEventListener('click', async () => {
            if (confirm("Are you sure you want to stop the live scoring system entirely?")) {
                try {
                    await setLiveScoringStatus({ status: 'stopped', league: getCurrentLeague() });
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

        const recalcBtn = document.getElementById('force-recalc-btn');
        if (recalcBtn) {
            recalcBtn.addEventListener('click', async () => {
                if (!confirm("Are you sure you want to force a full recalculation of all leaderboards? This can be a resource-intensive operation.")) {
                    return;
                }
                recalcBtn.disabled = true;
                recalcBtn.textContent = 'Recalculating...';
                try {
                    await forceLeaderboardRecalculation({ league: getCurrentLeague() });
                    alert("Leaderboard recalculation completed successfully!");
                } catch (error) {
                    console.error("Error forcing leaderboard recalculation:", error);
                    alert(`An error occurred: ${error.message}`);
                } finally {
                    recalcBtn.disabled = false;
                    recalcBtn.textContent = 'Force Leaderboard Recalc';
                }
            });
        }
        
        if (saveScheduleBtn) {
            saveScheduleBtn.addEventListener('click', async () => {
                const autoFinalizeTime = autofinalizeTimeInput.value;
                const statUpdateTime = statUpdateTimeInput.value;

                if (!autoFinalizeTime || !statUpdateTime) {
                    alert("Please select a valid time for both fields.");
                    return;
                }

                if (!confirm(`Are you sure you want to set these times?\n\nAuto-Finalize: ${autoFinalizeTime} CT\nStat Updates: ${statUpdateTime} CT`)) {
                    return;
                }
                
                saveScheduleBtn.disabled = true;
                saveScheduleBtn.textContent = 'Saving...';

                try {
                    const result = await updateScheduledJobTimes({ autoFinalizeTime, statUpdateTime, league: getCurrentLeague() });
                    alert(result.data.message);
                } catch (error) {
                    console.error("Error updating schedule times:", error);
                    alert(`An error occurred: ${error.message}`);
                } finally {
                    saveScheduleBtn.disabled = false;
                    saveScheduleBtn.textContent = 'Save Schedule Times';
                }
            });
        }

        if (testAutofinalizeBtn) {
            testAutofinalizeBtn.addEventListener('click', async () => {
                if (!confirm("This will finalize ALL active live games, just like the 3 AM scheduled job. This is for testing only. Are you sure you want to proceed?")) {
                    return;
                }
                testAutofinalizeBtn.disabled = true;
                testAutofinalizeBtn.textContent = 'Processing...';
                try {
                    const result = await test_autoFinalizeGames({ league: getCurrentLeague() });
                    alert(result.data.message); // Display the success message from the function
                } catch (error) {
                    console.error("Error testing auto-finalize:", error);
                    alert(`An error occurred: ${error.message}`);
                } finally {
                    testAutofinalizeBtn.disabled = false;
                    testAutofinalizeBtn.textContent = 'Test Auto-Finalize Overnight Process';
                }
            });
        }

        progressCloseBtn.addEventListener('click', () => {
            progressModal.style.display = 'none';
        });

        // Live features toggle handler
        const featuresToggle = document.getElementById('show-live-features-toggle');
        if (featuresToggle) {
            featuresToggle.addEventListener('change', async () => {
                try {
                    const currentLeague = getCurrentLeague();
                    await setDoc(doc(db, getCollectionName('live_scoring_status', currentLeague), 'status'), {
                        show_live_features: featuresToggle.checked
                    }, { merge: true });
                    console.log('Live features visibility updated:', featuresToggle.checked);
                } catch (error) {
                    console.error('Error updating live features toggle:', error);
                    alert(`Error updating setting: ${error.message}`);
                    // Revert the checkbox on error
                    featuresToggle.checked = !featuresToggle.checked;
                }
            });
        }

        // Listen for league changes and reload the page data
        window.addEventListener('leagueChanged', async (event) => {
            console.log('League changed to:', event.detail.league);
            // Reload all data for the new league
            initializeControlPanel();
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