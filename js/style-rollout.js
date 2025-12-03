// /js/style-rollout.js
import { db, doc, getDoc, getLeagueCollectionName } from './firebase-init.js';

export const STYLE_ROLLOUT_COLLECTION = getLeagueCollectionName('style_rollout');

function sanitizePath(pathname) {
    const normalized = pathname.replace(/\/+$/, '') || '/';
    const withoutLeading = normalized.replace(/^\//, '') || 'index.html';
    return withoutLeading.replace(/\//g, '__');
}

export function getPageStyleKey(pathname = window.location.pathname) {
    return sanitizePath(pathname);
}

function injectStylesheet({ id, href }) {
    if (document.getElementById(id)) {
        return;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.id = id;
    document.head.appendChild(link);
}

function injectModernStylesheet() {
    injectStylesheet({ id: 'modern-style-link', href: '/css/site-refresh.css' });
}

function injectS9Stylesheet(pathname) {
    const isS9Page = pathname.startsWith('/S9/');
    if (!isS9Page) {
        return;
    }

    injectStylesheet({ id: 's9-style-link', href: '/css/s9-refresh.css' });
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
            injectS9Stylesheet(path);
            document.documentElement.dataset.styleRollout = 'modern';
        } else {
            document.documentElement.dataset.styleRollout = 'legacy';
        }
    } catch (error) {
        console.error('Unable to determine style rollout state for this page.', error);
        document.documentElement.dataset.styleRollout = 'legacy';
    }
}
