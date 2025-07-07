// In /js/login.js

import { auth } from './firebase-init.js';
import { signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js";

const loginButton = document.getElementById('login-btn');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const errorDiv = document.getElementById('error-message');

loginButton.addEventListener('click', () => {
  const username = usernameInput.value;
  const password = passwordInput.value;
  const FAKE_DOMAIN = '@rkl.league';
  const email = username + FAKE_DOMAIN;

  signInWithEmailAndPassword(auth, email, password)
    .then((userCredential) => {
      console.log('Login successful! Redirecting...');
      window.location.href = '/S7/trade-block.html';
    })
    .catch((error) => {
      console.error('Login failed:', error.code, error.message);
      errorDiv.textContent = 'Invalid username or password.';
    });
});