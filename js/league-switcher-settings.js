/**
 * League Switcher Public Rollout Settings
 * Manages the feature flag for making the league switcher available to all users
 */

import { db, doc, getDoc, setDoc } from '/js/firebase-init.js';

const SETTINGS_DOC_ID = 'league_switcher_public';

/**
 * Check if league switcher should be shown to all users (public rollout enabled)
 * @returns {Promise<boolean>} True if public rollout is enabled, false if admin-only
 */
export async function isLeagueSwitcherPublic() {
    try {
        const settingsRef = doc(db, 'settings', SETTINGS_DOC_ID);
        const settingsDoc = await getDoc(settingsRef);

        if (settingsDoc.exists()) {
            return settingsDoc.data().enabled === true;
        }

        // Default to false (admin-only) if setting doesn't exist
        return false;
    } catch (error) {
        console.error('[League Switcher Settings] Error checking public rollout status:', error);
        return false; // Fail safe to admin-only
    }
}

/**
 * Enable or disable public rollout of league switcher
 * @param {boolean} enabled - True to enable public access, false for admin-only
 * @returns {Promise<boolean>} True if successful
 */
export async function setLeagueSwitcherPublic(enabled) {
    try {
        const settingsRef = doc(db, 'settings', SETTINGS_DOC_ID);
        await setDoc(settingsRef, {
            enabled: enabled,
            lastModified: new Date().toISOString(),
            description: 'Controls whether the league switcher is available to all users (true) or admin-only (false)'
        });

        console.log(`[League Switcher Settings] Public rollout ${enabled ? 'enabled' : 'disabled'}`);
        return true;
    } catch (error) {
        console.error('[League Switcher Settings] Error updating public rollout status:', error);
        return false;
    }
}
