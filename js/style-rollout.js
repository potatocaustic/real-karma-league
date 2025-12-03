// /js/style-rollout.js
import { db, doc, getDoc } from './firebase-init.js';

export const STYLE_ROLLOUT_COLLECTION = 'style_rollout';

function sanitizePath(pathname) {
    const normalized = pathname.replace(/\/+$/, '') || '/';
    const withoutLeading = normalized.replace(/^\//, '') || 'index.html';
    return withoutLeading.replace(/\//g, '__');
}

export function getPageStyleKey(pathname = window.location.pathname) {
    return sanitizePath(pathname);
}

function injectModernStylesheet() {
    if (document.getElementById('modern-style-link')) {
        return;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/css/site-refresh.css';
    link.id = 'modern-style-link';
    document.head.appendChild(link);
}

export async function applyPageStyleRollout() {
    const path = window.location.pathname;
    if (path.startsWith('/admin') || path.startsWith('/commish')) {
        return;
    }

    const pageKey = getPageStyleKey(path);

    try {
        const rolloutRef = doc(db, STYLE_ROLLOUT_COLLECTION, pageKey);
        const rolloutSnap = await getDoc(rolloutRef);
        const isEnabled = rolloutSnap.exists() && rolloutSnap.data().enabled === true;

        if (isEnabled) {
            injectModernStylesheet();
            document.documentElement.dataset.styleRollout = 'modern';
        } else {
            document.documentElement.dataset.styleRollout = 'legacy';
        }
    } catch (error) {
        console.error('Unable to determine style rollout state for this page.', error);
        document.documentElement.dataset.styleRollout = 'legacy';
    }
}
