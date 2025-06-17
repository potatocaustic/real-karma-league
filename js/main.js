// /js/main.js

// --- Authentication State Manager ---
const authStatusDiv = document.getElementById('auth-status');
auth.onAuthStateChanged(user => {
  if (user) {
    // User is signed in. Display their status and a logout button.
    db.collection("teams").where("gm_uid", "==", user.uid).get().then(snapshot => {
        let welcomeMsg = "Welcome, GM!";
        if (!snapshot.empty) {
            const teamData = snapshot.docs[0].data();
            welcomeMsg = `Logged in as ${teamData.team_name}`;
        }
        authStatusDiv.innerHTML = `<span>${welcomeMsg}</span> | <a id="logout-btn">Logout</a>`;

        // Add event listener for the new logout button
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => {
                auth.signOut().then(() => {
                    // Redirect to home page after logout
                    window.location.href = '/';
                });
            });
        }
    });

  } else {
    // User is signed out. Display a login link.
    authStatusDiv.innerHTML = '<a href="/login.html">GM Login</a>';
  }
});


// --- Theme Toggler Functionality ---
const themeToggleBtn = document.getElementById('theme-toggle-btn');
if(themeToggleBtn) {
    const currentTheme = localStorage.getItem('theme');
    if (currentTheme === 'dark') {
        document.documentElement.classList.add('dark-mode');
    }
    themeToggleBtn.addEventListener('click', () => {
        document.documentElement.classList.toggle('dark-mode');
        let theme = document.documentElement.classList.contains('dark-mode') ? 'dark' : 'light';
        localStorage.setItem('theme', theme);
    });
}


// --- Mobile Navigation Menu Toggle ---
const navToggle = document.querySelector('.nav-toggle');
const navMenu = document.getElementById('nav-menu');
const dropdownBtn = document.querySelector('.dropdown .dropbtn');

if (navToggle && navMenu) {
    navToggle.addEventListener('click', () => {
        navMenu.classList.toggle('active');
    });
}
if(dropdownBtn) {
    dropdownBtn.addEventListener('click', function(event) {
        if (window.getComputedStyle(navToggle).display !== 'none') {
            event.preventDefault();
            this.parentElement.classList.toggle('active');
        }
    });
}