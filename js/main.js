// js/main.js

// --- Authentication State Manager ---
// This part checks if a user is logged in and can be expanded later
// to change the text of a login/logout link in the nav bar.
auth.onAuthStateChanged(user => {
  if (user) {
    // User is signed in.
    console.log("User is logged in:", user.uid);
    // You could add logic here to change a "Login" link to "Logout"
  } else {
    // User is signed out.
    console.log("User is signed out.");
  }
});


// --- Theme Toggler Functionality ---
// This code is pulled directly from your other pages.
const themeToggleBtn = document.getElementById('theme-toggle-btn');
if(themeToggleBtn) {
    // Apply the saved theme on initial load
    const currentTheme = localStorage.getItem('theme');
    if (currentTheme === 'dark') {
        document.documentElement.classList.add('dark-mode');
    }

    // Add click listener to toggle theme
    themeToggleBtn.addEventListener('click', () => {
        document.documentElement.classList.toggle('dark-mode');
        
        let theme = 'light';
        if (document.documentElement.classList.contains('dark-mode')) {
            theme = 'dark';
        }
        localStorage.setItem('theme', theme);
    });
}


// --- Mobile Navigation Menu Toggle ---
// This code is also pulled from your other pages.
const navToggle = document.querySelector('.nav-toggle');
const navMenu = document.getElementById('nav-menu');
const dropdownBtn = document.querySelector('.dropdown .dropbtn');

if (navToggle && navMenu) {
    navToggle.addEventListener('click', () => {
        const isExpanded = navToggle.getAttribute('aria-expanded') === 'true' || false;
        navToggle.setAttribute('aria-expanded', !isExpanded);
        navMenu.classList.toggle('active');
    });
}

// Logic for mobile dropdowns
if(dropdownBtn) {
    dropdownBtn.addEventListener('click', function(event) {
        // Check if we are in mobile view (nav-toggle is visible)
        if (window.getComputedStyle(navToggle).display !== 'none') {
            event.preventDefault(); // Prevent link navigation
            this.parentElement.classList.toggle('active');
        }
    });
}