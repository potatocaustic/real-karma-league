// /admin/admin.js

import { auth, db, onAuthStateChanged, doc, getDoc } from '/js/firebase-init.js';

document.addEventListener('DOMContentLoaded', () => {
    const loadingContainer = document.getElementById('loading-container');
    const adminContainer = document.getElementById('admin-container');
    const authStatusDiv = document.getElementById('auth-status');

    onAuthStateChanged(auth, async (user) => {
        if (user) {
            // User is signed in, check if they are an admin
            const userRef = doc(db, "users", user.uid);
            const userDoc = await getDoc(userRef);

            if (userDoc.exists() && userDoc.data().role === 'admin') {
                // User is an admin, show the portal
                loadingContainer.style.display = 'none';
                adminContainer.style.display = 'block';
                authStatusDiv.innerHTML = `Welcome, Admin | <a href="#" id="logout-btn">Logout</a>`;
                addLogoutListener();
            } else {
                // User is not an admin
                loadingContainer.innerHTML = '<div class="error">Access Denied. You do not have permission to view this page.</div>';
                authStatusDiv.innerHTML = `Access Denied | <a href="#" id="logout-btn">Logout</a>`;
                addLogoutListener();
            }
        } else {
            // No user is signed in, redirect to login
            window.location.href = '/login.html';
        }
    });

    function addLogoutListener() {
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', (e) => {
                e.preventDefault();
                auth.signOut().then(() => {
                    window.location.href = '/login.html';
                });
            });
        }
    }
});// JavaScript source code
