// /js/main.js

document.addEventListener('DOMContentLoaded', () => {

    // --- Authentication State Manager ---
    const authStatusDiv = document.getElementById('auth-status');
    if (authStatusDiv) {
        auth.onAuthStateChanged(user => {
            if (user) {
                // User is signed in.
                // Check if the user is an admin first.
                db.collection("admins").doc(user.uid).get().then(adminDoc => {
                    let welcomeMsg = "Welcome!"; 
                    
                    if (adminDoc.exists) {
                        welcomeMsg = "Welcome, Admin!";
                        authStatusDiv.innerHTML = `<span>${welcomeMsg}</span> | <a id="logout-btn">Logout</a>`;
                        addLogoutListener();
                    } else {
                        // If not an admin, check if they are a GM.
                        db.collection("teams").where("gm_uid", "==", user.uid).limit(1).get().then(snapshot => {
                            if (!snapshot.empty) {
                                const teamData = snapshot.docs[0].data();
                                welcomeMsg = `Welcome, ${teamData.gm_handle}!`;
                            }
                            authStatusDiv.innerHTML = `<span>${welcomeMsg}</span> | <a id="logout-btn">Logout</a>`;
                            addLogoutListener();
                        });
                    }
                });

            } else {
                // User is signed out. Display a login link.
                authStatusDiv.innerHTML = '<a href="/login.html">GM Login</a>';
            }
        });
    }

    function addLogoutListener() {
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => {
                auth.signOut().then(() => {
                    console.log('User signed out successfully.');
                    window.location.href = '/'; // Redirect to home page after logout
                }).catch((error) => {
                    console.error('Sign out error:', error);
                });
            });
        }
    }


    // --- Theme Toggler Functionality ---
    const themeToggleBtn = document.getElementById('theme-toggle-btn');
    if(themeToggleBtn) {
        // Apply the saved theme on initial load
        (function() {
            const theme = localStorage.getItem('theme');
            if (theme === 'dark') {
                document.documentElement.classList.add('dark-mode');
            }
        })();

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
    const navToggle = document.querySelector('.nav-toggle');
    const navMenu = document.getElementById('nav-menu');
    const dropdowns = document.querySelectorAll('.dropdown');

    if (navToggle && navMenu) {
        navToggle.addEventListener('click', () => {
            navMenu.classList.toggle('active');
        });
    }

    // Logic for mobile dropdowns
    if (dropdowns.length > 0) {
        dropdowns.forEach(dropdown => {
            const btn = dropdown.querySelector('.dropbtn');
            if (btn) {
                btn.addEventListener('click', function(event) {
                    // Check if we are in mobile view (nav-toggle is visible)
                    if (window.getComputedStyle(navToggle).display !== 'none') {
                        event.preventDefault(); // Prevent link navigation
                        // Close other open dropdowns
                        dropdowns.forEach(d => {
                            if (d !== dropdown) {
                                d.classList.remove('active');
                            }
                        });
                        // Toggle the current one
                        dropdown.classList.toggle('active');
                    }
                });
            }
        });
    }
});