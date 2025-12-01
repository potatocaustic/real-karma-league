// /commish/dashboard.js

import { auth, db, functions, onAuthStateChanged, signOut, doc, getDoc, httpsCallable, collection, query, where, getDocs, getCurrentLeague } from '/js/firebase-init.js';
import { initCommishAuth } from '/commish/commish.js';

document.addEventListener('DOMContentLoaded', () => {
    const loadingContainer = document.getElementById('loading-container');
    const adminContainer = document.getElementById('admin-container');
    const authStatusDiv = document.getElementById('auth-status');
    const dashboardSubtitle = document.getElementById('dashboard-subtitle');

    initCommishAuth(() => {
        // Update subtitle based on league
        const currentLeague = getCurrentLeague();
        const leagueDisplay = currentLeague === 'minor' ? 'Minor League' : 'Major League';
        dashboardSubtitle.textContent = `Select a management task below for the ${leagueDisplay}.`;

        // Listen for league changes
        window.addEventListener('leagueChanged', (event) => {
            const newLeague = event.detail.league;
            const newLeagueDisplay = newLeague === 'minor' ? 'Minor League' : 'Major League';
            dashboardSubtitle.textContent = `Select a management task below for the ${newLeagueDisplay}.`;
        });
    });
});
