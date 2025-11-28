/**
 * Initialize league switcher based on public rollout status
 * This script checks if league switcher is public or admin-only
 */

import { auth, db, onAuthStateChanged, doc, getDoc } from '/js/firebase-init.js';
import { createLeagueSwitcher } from '/common/league-switcher.js';
import { isLeagueSwitcherPublic } from '/js/league-switcher-settings.js';

/**
 * Initialize the league switcher with appropriate visibility
 */
export async function initLeagueSwitcher() {
    const mountPoint = document.getElementById('league-switcher-mount');
    if (!mountPoint) {
        console.warn('[League Switcher] Mount point not found');
        return;
    }

    try {
        // Check if league switcher is available to public
        const isPublic = await isLeagueSwitcherPublic();

        // Cache public status in localStorage to prevent flash on subsequent page loads
        localStorage.setItem('rkl_league_switcher_public', isPublic ? 'true' : 'false');

        if (isPublic) {
            // Public rollout enabled - show to everyone
            console.log('[League Switcher] Public access enabled');
            mountPoint.style.display = 'flex';
            createLeagueSwitcher();
        } else {
            // Admin-only mode - check user authentication
            console.log('[League Switcher] Admin-only mode');
            onAuthStateChanged(auth, async (user) => {
                if (user) {
                    // Check if user is an admin (must check users collection role, not admins collection)
                    const userRef = doc(db, "users", user.uid);

                    try {
                        const userDoc = await getDoc(userRef);
                        const isAdmin = userDoc.exists() && userDoc.data().role === 'admin';

                        // Cache admin status in localStorage to prevent flash on subsequent page loads
                        localStorage.setItem('rkl_is_admin', isAdmin ? 'true' : 'false');

                        if (isAdmin) {
                            // User is admin - show and initialize league switcher
                            if (mountPoint) {
                                mountPoint.style.display = 'flex';
                                createLeagueSwitcher();
                            }
                        } else {
                            // User is not admin - ensure switcher is hidden
                            if (mountPoint) {
                                mountPoint.style.display = 'none';
                            }
                        }
                    } catch (error) {
                        console.error('[League Switcher] Error checking user role:', error);
                        // Hide switcher on error
                        if (mountPoint) {
                            mountPoint.style.display = 'none';
                        }
                    }
                } else {
                    // User is not logged in - clear admin status and hide switcher
                    localStorage.setItem('rkl_is_admin', 'false');
                    if (mountPoint) {
                        mountPoint.style.display = 'none';
                    }
                }
            });
        }
    } catch (error) {
        console.error('[League Switcher] Error initializing:', error);
        // Hide switcher on error
        if (mountPoint) {
            mountPoint.style.display = 'none';
        }
    }
}

// Auto-initialize when imported as a module script
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLeagueSwitcher);
} else {
    initLeagueSwitcher();
}
