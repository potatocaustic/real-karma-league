// /js/login.js

import { auth, onAuthStateChanged } from './firebase-init.js';
import { signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";

document.addEventListener('DOMContentLoaded', () => {
    // Redirect if user is already logged in
    onAuthStateChanged(auth, (user) => {
        if (user) {
            // User is signed in, redirect to the main page or GM portal.
            console.log('User already signed in, redirecting...');
            window.location.href = '/S7/trade-block.html'; 
        }
    });

    const loginBtn = document.getElementById('login-btn');
    const usernameInput = document.getElementById('username');
    const passwordInput = document.getElementById('password');
    const errorMessageDiv = document.getElementById('error-message');

    loginBtn.addEventListener('click', () => {
        const username = usernameInput.value.trim();
        const password = passwordInput.value;
        
        errorMessageDiv.textContent = ''; // Clear previous errors

        if (!username || !password) {
            errorMessageDiv.textContent = 'Please enter both username and password.';
            return;
        }

        // MODIFIED: Append domain to username to create the full email
        const email = username + '@rkl.league';

        // Sign in with Firebase Auth using the constructed email
        signInWithEmailAndPassword(auth, email, password)
            .then((userCredential) => {
                // Signed in successfully
                console.log('Login successful for:', userCredential.user.email);
                // Redirect to the GM portal or another appropriate page
                window.location.href = '/common/trade-block.html';
            })
            .catch((error) => {
                // Handle errors
                console.error('Login failed:', error.code);
                switch (error.code) {
                    case 'auth/invalid-credential':
                        errorMessageDiv.textContent = 'Invalid username or password. Please try again.';
                        break;
                    case 'auth/invalid-email':
                        errorMessageDiv.textContent = 'Please enter a valid username.';
                        break;
                    default:
                        errorMessageDiv.textContent = 'An error occurred. Please try again later.';
                        break;
                }
            });
    });
});
