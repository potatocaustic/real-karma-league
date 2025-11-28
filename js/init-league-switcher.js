/**
 * Initialize league switcher - publicly available to all users
 */

import { createLeagueSwitcher } from '/common/league-switcher.js';

/**
 * Initialize the league switcher
 */
export async function initLeagueSwitcher() {
    const mountPoint = document.getElementById('league-switcher-mount');
    if (!mountPoint) {
        console.warn('[League Switcher] Mount point not found');
        return;
    }

    // League switcher is now public - show to everyone
    console.log('[League Switcher] Initializing public league switcher');
    mountPoint.style.display = 'flex';
    createLeagueSwitcher();
}

// Auto-initialize when imported as a module script
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLeagueSwitcher);
} else {
    initLeagueSwitcher();
}
