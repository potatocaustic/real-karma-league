// /js/style-rollout.js
import { getLeagueCollectionName } from './firebase-init.js';

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

function injectAdminStylesheet() {
    injectStylesheet({ id: 'modern-style-link', href: '/admin/admin-styles.css' });
}

function enableModernStyles() {
    injectAdminStylesheet();
    document.documentElement.dataset.styleRollout = 'modern';
}

export function applyPageStyleRollout() {
    const path = window.location.pathname;
    if (path.startsWith('/admin') || path.startsWith('/commish')) {
        return;
    }

    enableModernStyles();
}
