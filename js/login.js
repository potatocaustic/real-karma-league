// js/login.js

const loginButton = document.getElementById('login-btn');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const errorDiv = document.getElementById('error-message');

loginButton.addEventListener('click', () => {
  // 1. Get the value from the 'username' input field.
  const username = usernameInput.value;
  const password = passwordInput.value;
  
  // 2. Define your "fake" domain for the email spoof.
  const FAKE_DOMAIN = '@rkl.league';

  // 3. Combine the username and domain to create the full email string for Firebase.
  const email = username + FAKE_DOMAIN;

  // 4. Call the sign-in function with the corrected email.
  auth.signInWithEmailAndPassword(email, password)
    .then((userCredential) => {
      // Sign-in successful. Redirect to the trade block page.
      console.log('Login successful! Redirecting...');
      window.location.href = '/S7/trade-block.html'; // Use root-relative path for reliability
    })
    .catch((error) => {
      console.error('Login failed:', error.code, error.message);
      errorDiv.textContent = 'Invalid username or password.'; // Display a generic error
    });
});