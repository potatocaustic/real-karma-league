// /admin/manage-live-scoring.js

import { auth, db, functions, onAuthStateChanged, doc, onSnapshot, httpsCallable, getDoc, setDoc, query, collection, where, getDocs, limit } from '/js/firebase-init.js';

// --- DEV ENVIRONMENT CONFIG ---
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
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const manualUpdateBtn = document.getElementById('manual-update-btn');
const intervalInput = document.getElementById('interval-input');
const saveIntervalBtn = document.getElementById('save-interval-btn');
const usageDisplay = document.getElementById('usage-stats-display');

// --- Firebase Callable Functions ---
const toggleLiveScoring = httpsCallable(functions, 'toggleLiveScoring');
const updateAllLiveScores = httpsCallable(functions, 'updateAllLiveScores');


// --- Auth Check & Initialization ---
document.addEventListener('DOMContentLoaded', () => {
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
});

function initializeControlPanel() {
    const statusRef = doc(db, getCollectionName('live_scoring_status'), 'status');
    const today = new Date().toISOString().split('T')[0];
    const usageRef = doc(db, getCollectionName('usage_stats'), today);

    // Listener for system status (active/inactive)
    onSnapshot(statusRef, (docSnap) => {
        if (docSnap.exists()) {
            const { is_active, interval_minutes } = docSnap.data();
            statusDisplay.textContent = is_active ? 'ACTIVE' : 'INACTIVE';
            statusDisplay.style.color = is_active ? '#28a745' : '#dc3545';
            intervalInput.value = interval_minutes || 5;
            startBtn.style.display = is_active ? 'none' : 'block';
            stopBtn.style.display = is_active ? 'block' : 'none';
        } else {
            statusDisplay.textContent = 'INACTIVE';
            statusDisplay.style.color = '#dc3545';
            startBtn.style.display = 'block';
            stopBtn.style.display = 'none';
        }
    });

    // Listener for today's usage stats
    onSnapshot(usageRef, (docSnap) => {
        if (docSnap.exists()) {
            const { api_requests_full_update = 0, api_requests_sample = 0 } = docSnap.data();
            usageDisplay.innerHTML = `
                <strong>Full Update API Calls:</strong> ${api_requests_full_update}<br>
                <strong>Sampler API Calls:</strong> ${api_requests_sample}
            `;
        } else {
            usageDisplay.textContent = "No usage recorded yet for today.";
        }
    });

    // --- Event Listeners for Buttons ---
    startBtn.addEventListener('click', async () => {
        startBtn.disabled = true;
        startBtn.textContent = 'Starting...';
        try {
            await toggleLiveScoring({ isActive: true, interval: parseInt(intervalInput.value) });
            alert('Live scoring system activated. Performing initial score fetch...');
            await updateAllLiveScores();
            alert('Initial scores fetched successfully.');
        } catch (error) {
            alert(`Error: ${error.message}`);
        } finally {
            startBtn.disabled = false;
            startBtn.textContent = 'Begin Live Scoring';
        }
    });

    stopBtn.addEventListener('click', async () => {
        try {
            await toggleLiveScoring({ isActive: false });
            alert('Live scoring system has been stopped.');
        } catch (error) {
            alert(`Error: ${error.message}`);
        }
    });

    manualUpdateBtn.addEventListener('click', async () => {
        manualUpdateBtn.disabled = true;
        manualUpdateBtn.textContent = 'Updating...';
        try {
            const result = await updateAllLiveScores();
            alert(result.data.message);
        } catch (error) {
            alert(`Error: ${error.message}`);
        } finally {
            manualUpdateBtn.disabled = false;
            manualUpdateBtn.textContent = 'Run Full Update Manually';
        }
    });

    saveIntervalBtn.addEventListener('click', async () => {
        const interval = parseInt(intervalInput.value);
        if (interval > 0) {
            try {
                await setDoc(statusRef, { interval_minutes: interval }, { merge: true });
                alert("Interval saved successfully.");
            } catch(error) {
                alert(`Error saving interval: ${error.message}`);
            }
        } else {
            alert("Interval must be a positive number.");
        }
    });
    
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            auth.signOut().then(() => { window.location.href = '/login.html'; });
        });
    }
}