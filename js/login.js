// In /js/login.js

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
    const emailInput = document.getElementById('username'); // Your form uses 'username' for the email field
    const passwordInput = document.getElementById('password');
    const errorMessageDiv = document.getElementById('error-message');

    loginBtn.addEventListener('click', () => {
        const email = emailInput.value.trim();
        const password = passwordInput.value;
        
        errorMessageDiv.textContent = ''; // Clear previous errors

        if (!email || !password) {
            errorMessageDiv.textContent = 'Please enter both username and password.';
            return;
        }

        // Sign in with Firebase Auth
        signInWithEmailAndPassword(auth, email, password)
            .then((userCredential) => {
                // Signed in successfully
                console.log('Login successful for:', userCredential.user.email);
                // Redirect to the GM portal or another appropriate page
                window.location.href = '/S7/trade-block.html';
            })
            .catch((error) => {
                // Handle errors
                console.error('Login failed:', error.code);
                switch (error.code) {
                    case 'auth/invalid-credential':
                        errorMessageDiv.textContent = 'Invalid username or password. Please try again.';
                        break;
                    case 'auth/invalid-email':
                        errorMessageDiv.textContent = 'Please enter a valid email address.';
                        break;
                    default:
                        errorMessageDiv.textContent = 'An error occurred. Please try again later.';
                        break;
                }
            });
    });
});