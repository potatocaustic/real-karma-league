// /js/activate.js

import { auth, db, functions, onAuthStateChanged, getCurrentLeague } from './firebase-init.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-functions.js';

const activateAccount = httpsCallable(functions, 'activateUserWithCode');

document.addEventListener('DOMContentLoaded', () => {
    const league = getCurrentLeague();
    const activationForm = document.getElementById('activation-form');
    const activationCodeInput = document.getElementById('activation-code');
    const errorMessageDiv = document.getElementById('error-message');
    const successMessageDiv = document.getElementById('success-message');
    const leagueIndicator = document.getElementById('league-indicator');
    const activationTitle = document.getElementById('activation-title');
    const userEmailSpan = document.getElementById('user-email');

    // Update UI based on league
    const leagueLabel = league === 'minor' ? 'Minor League' : 'Major League';
    leagueIndicator.textContent = `Activating for: Real Karma ${league === 'minor' ? 'Minor' : ''} League`;
    activationTitle.textContent = `Activate Your ${leagueLabel} GM Account`;

    // Check authentication state
    onAuthStateChanged(auth, (user) => {
        if (!user) {
            // Not logged in - redirect to login
            window.location.href = `/login.html?league=${league}`;
        } else {
            // Display user email
            userEmailSpan.textContent = user.email || user.uid;
        }
    });

    // Handle form submission
    activationForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const code = activationCodeInput.value.trim().toUpperCase();

        if (!code) {
            errorMessageDiv.textContent = 'Please enter an activation code.';
            successMessageDiv.textContent = '';
            return;
        }

        // Clear messages
        errorMessageDiv.textContent = '';
        successMessageDiv.textContent = '';

        // Disable form while processing
        const submitBtn = activationForm.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Activating...';

        try {
            const result = await activateAccount({ code, league });

            if (result.data.success) {
                successMessageDiv.textContent =
                    `Success! You've been linked to ${result.data.teamName} in the ${league} league.`;

                // Hide form
                activationForm.style.display = 'none';

                // Redirect after delay
                setTimeout(() => {
                    window.location.href = `/gm/dashboard.html?league=${league}`;
                }, 2000);
            } else {
                errorMessageDiv.textContent = 'Activation failed. Please check your code and try again.';
                submitBtn.disabled = false;
                submitBtn.textContent = 'Activate Account';
            }
        } catch (error) {
            console.error('Activation error:', error);

            // Handle specific error codes
            let errorMessage = 'Activation failed: ';

            if (error.code === 'functions/not-found') {
                errorMessage += 'Invalid or expired activation code for this league.';
            } else if (error.code === 'functions/already-exists') {
                errorMessage += 'This activation code has already been used.';
            } else if (error.code === 'functions/deadline-exceeded') {
                errorMessage += 'This activation code has expired.';
            } else if (error.code === 'functions/permission-denied') {
                errorMessage += 'You must be signed in to activate your account.';
            } else if (error.message) {
                errorMessage += error.message;
            } else {
                errorMessage += 'An unknown error occurred. Please try again.';
            }

            errorMessageDiv.textContent = errorMessage;
            submitBtn.disabled = false;
            submitBtn.textContent = 'Activate Account';
        }
    });

    // Auto-format activation code as user types
    activationCodeInput.addEventListener('input', (e) => {
        e.target.value = e.target.value.toUpperCase();
    });
});
