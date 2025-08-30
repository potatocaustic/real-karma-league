// /scorekeeper/live-scoring.js

import { auth, db, functions, onAuthStateChanged, doc, onSnapshot, httpsCallable, getDoc, query, collection, getDocs } from '/js/firebase-init.js';

window.addEventListener('load', () => {

    // --- Page Elements ---
    const loadingContainer = document.getElementById('loading-container');
    const scorekeeperContainer = document.getElementById('scorekeeper-container');
    const authStatusDiv = document.getElementById('auth-status');
    const statusDisplay = document.getElementById('system-status');
    const nextSampleDisplay = document.getElementById('next-sample-display');
    const lastUpdateDisplay = document.getElementById('last-update-display');
    const logContainer = document.getElementById('last-sample-log');
    const sampleProgressContainer = document.getElementById('sample-progress-container');
    const sampleProgressBar = document.getElementById('sample-progress-bar');
    const manualUpdateBtn = document.getElementById('manual-update-btn');
    const finalizeContainer = document.getElementById('finalize-container');
    const finalizeBtn = document.getElementById('finalize-btn');
    const progressModal = document.getElementById('progress-modal');
    const progressBar = document.getElementById('progress-bar');
    const progressCounter = document.getElementById('progress-counter');
    const progressTitle = document.getElementById('progress-title');
    const progressStatus = document.getElementById('progress-status');
    const progressCloseBtn = document.getElementById('progress-close-btn');

    // --- DEV ENVIRONMENT CONFIG ---
    const pageConfig = window.firebasePageConfig || {};
    const USE_DEV_COLLECTIONS = !pageConfig.useProdCollections;
    const getCollectionName = (baseName) => {
        if (baseName.includes('live_scoring_status') || baseName.includes('usage_stats') || baseName.includes('live_games')) {
            return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
        }
        return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
    };

    // --- Firebase Callable Functions ---
    const updateAllLiveScores = httpsCallable(functions, 'updateAllLiveScores');
    const scorekeeperFinalizeAndProcess = httpsCallable(functions, 'scorekeeperFinalizeAndProcess');

    // --- Global State ---
    let countdownIntervalId = null;
    let finalizeCountdownInterval = null;

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
    
    async function runFullUpdateWithProgress(isFinalizing = false) {
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
        progressTitle.textContent = isFinalizing ? 'Finalizing Games & Recalculating Stats...' : 'Performing Full Score Update...';
        progressStatus.textContent = isFinalizing ? 'This process includes backup, game processing, and stat recalculations. It may take several minutes.' : `Fetching scores for ${playerCount} players.`;
        progressCloseBtn.style.display = 'none';

        if (!isFinalizing) {
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
        } else {
            // For finalization, just show a generic "in progress" state
            progressBar.style.width = '50%';
            progressCounter.textContent = 'Processing... Please wait.';
            try {
                const result = await scorekeeperFinalizeAndProcess();
                progressBar.style.width = '100%';
                progressTitle.textContent = "Finalization Complete!";
                progressStatus.textContent = result.data.message;
                progressCounter.textContent = '';
                progressCloseBtn.style.display = 'block';
            } catch (error) {
                 throw error;
            }
        }
    }

    function initializeControlPanel() {
        const statusRef = doc(db, getCollectionName('live_scoring_status'), 'status');

        onSnapshot(statusRef, (docSnap) => {
            if (docSnap.exists()) {
                const { status = 'stopped', last_full_update_completed, last_sample_results, last_sample_completed_at, interval_minutes = 5 } = docSnap.data();
                
                sampleProgressContainer.style.display = 'none';
                sampleProgressBar.style.width = '0%';

                statusDisplay.textContent = status.toUpperCase();

                if (last_full_update_completed) {
                    lastUpdateDisplay.textContent = last_full_update_completed.toDate().toLocaleString();
                }

                if (status === 'active') {
                    statusDisplay.style.color = '#28a745';
                    startSampleCountdown(last_sample_completed_at, interval_minutes);
                } else {
                    statusDisplay.style.color = '#dc3545';
                    if (countdownIntervalId) clearInterval(countdownIntervalId);
                    nextSampleDisplay.textContent = 'INACTIVE';
                }

                if (last_sample_results && last_sample_results.length > 0) {
                     logContainer.innerHTML = last_sample_results.map(res => {
                        const overallChange = res.karmaChanged || res.rankChanged;
                        const changeIndicator = overallChange ? '✓' : '✗';
                        const color = overallChange ? '#28a745' : '#555';
                        let karmaString = `Karma: ${res.oldScore.toFixed(2)} → ${res.newScore.toFixed(2)}`;
                        if (res.karmaChanged) karmaString = `<strong>${karmaString}</strong>`;
                        let rankString = `Rank: ${res.oldRank} → ${res.newRank}`;
                        if (res.rankChanged) rankString = `<strong>${rankString}</strong>`;
                        return `<p style="color: ${color}; margin-bottom: 0.25rem; line-height: 1.5;"><span style="font-weight: bold;">[${changeIndicator}] ${res.handle}:</span><span style="margin-left: 8px;">${karmaString}</span><span style="margin-left: 8px;">|</span><span style="margin-left: 8px;">${rankString}</span></p>`;
                    }).join('');
                } else {
                     logContainer.innerHTML = `<p>No sample run yet or system is stopped.</p>`;
                }

            } else {
                statusDisplay.textContent = 'STOPPED';
                statusDisplay.style.color = '#dc3545';
                if (countdownIntervalId) clearInterval(countdownIntervalId);
                nextSampleDisplay.textContent = 'INACTIVE';
                logContainer.innerHTML = `<p>System is stopped.</p>`;
            }
        });
    
        manualUpdateBtn.addEventListener('click', async () => {
            manualUpdateBtn.disabled = true;
            try {
                await runFullUpdateWithProgress(false);
            } catch (error) {
                alert(`Error during manual update: ${error.message}`);
            } finally {
                manualUpdateBtn.disabled = false;
            }
        });

        const setupFinalizeListener = () => {
            const currentFinalizeBtn = document.getElementById('finalize-btn');
            if(currentFinalizeBtn) {
                currentFinalizeBtn.addEventListener('click', () => {
                    let secondsLeft = 30;
                    finalizeContainer.innerHTML = `
                        <button id="cancel-finalize-btn" class="btn-admin-secondary" style="width: 100%;">
                            Cancel <span class="countdown-timer">${secondsLeft}s</span>
                        </button>
                    `;
                    
                    finalizeCountdownInterval = setInterval(async () => {
                        secondsLeft--;
                        if (secondsLeft < 0) {
                            clearInterval(finalizeCountdownInterval);
                            finalizeContainer.innerHTML = `<button class="btn-admin-delete" style="width:100%;" disabled>Processing...</button>`;
                            try {
                                await runFullUpdateWithProgress(true);
                            } catch (error) {
                                alert(`Error during finalization: ${error.message}`);
                                // Reset button on error
                                finalizeContainer.innerHTML = `<button id="finalize-btn" class="btn-admin-delete" style="width:100%;">Stop Scoring and Process Games</button>`;
                                setupFinalizeListener();
                            }
                        } else {
                            const timerSpan = finalizeContainer.querySelector('.countdown-timer');
                            if (timerSpan) timerSpan.textContent = `${secondsLeft}s`;
                        }
                    }, 1000);

                    document.getElementById('cancel-finalize-btn').addEventListener('click', () => {
                        clearInterval(finalizeCountdownInterval);
                        finalizeContainer.innerHTML = `<button id="finalize-btn" class="btn-admin-delete" style="width:100%;">Stop Scoring and Process Games</button>`;
                        setupFinalizeListener();
                    }, { once: true });
                }, { once: true });
            }
        };

        setupFinalizeListener();


        progressCloseBtn.addEventListener('click', () => {
            progressModal.style.display = 'none';
        });
    }

    // --- Main Authentication and Initialization Logic ---
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            const userRef = doc(db, getCollectionName("users"), user.uid);
            const userDoc = await getDoc(userRef);
            if (userDoc.exists() && (userDoc.data().role === 'admin' || userDoc.data().role === 'scorekeeper')) {
                loadingContainer.style.display = 'none';
                scorekeeperContainer.style.display = 'block';
                 const userRole = userDoc.data().role;
                 const roleDisplay = userRole.charAt(0).toUpperCase() + userRole.slice(1);
                authStatusDiv.innerHTML = `Welcome, ${roleDisplay} | <a href="#" id="logout-btn">Logout</a>`;
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
