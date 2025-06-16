// In a global JS file (e.g., main.js)

auth.onAuthStateChanged(user => {
  const loginLink = document.getElementById('login-link'); // Assume you have a login/logout link
  const tradeBlockLink = document.getElementById('trade-block-link'); // Link to the trade block

  if (user) {
    // User is signed in.
    console.log("User is logged in:", user.uid);
    if (loginLink) loginLink.textContent = 'Logout';
    if (tradeBlockLink) tradeBlockLink.style.display = 'block'; // Show the link
  } else {
    // User is signed out.
    console.log("User is signed out.");
    if (loginLink) loginLink.textContent = 'GM Login';
    if (tradeBlockLink) tradeBlockLink.style.display = 'none'; // Hide the link
  }
});

// Add a logout functionality
if (loginLink) {
  loginLink.addEventListener('click', () => {
    if (auth.currentUser) {
      auth.signOut();
    } else {
      window.location.href = 'login.html';
    }
  });
}