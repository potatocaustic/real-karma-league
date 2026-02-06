// /js/firestore-bundles.js

import { db, loadBundle } from './firebase-init.js';

const bundleLoaders = new Map();

function buildStandingsBundleUrl({ league, seasonId } = {}) {
    const params = new URLSearchParams();
    if (league) params.set('league', league);
    if (seasonId) params.set('season', seasonId);
    const query = params.toString();
    return query ? `/bundles/standings?${query}` : '/bundles/standings';
}

function buildSeasonBundleUrl({ league, seasonId } = {}) {
    const params = new URLSearchParams();
    if (league) params.set('league', league);
    if (seasonId) params.set('season', seasonId);
    const query = params.toString();
    return query ? `/bundles/season?${query}` : '/bundles/season';
}

function buildDraftPicksBundleUrl({ league } = {}) {
    const params = new URLSearchParams();
    if (league) params.set('league', league);
    const query = params.toString();
    return query ? `/bundles/draft-picks?${query}` : '/bundles/draft-picks';
}

function buildTransactionsBundleUrl({ league, seasonId } = {}) {
    const params = new URLSearchParams();
    if (league) params.set('league', league);
    if (seasonId) params.set('season', seasonId);
    const query = params.toString();
    return query ? `/bundles/transactions?${query}` : '/bundles/transactions';
}

function buildAwardsBundleUrl({ league, seasonId } = {}) {
    const params = new URLSearchParams();
    if (league) params.set('league', league);
    if (seasonId) params.set('season', seasonId);
    const query = params.toString();
    return query ? `/bundles/awards?${query}` : '/bundles/awards';
}

function buildDraftResultsBundleUrl({ league, seasonId } = {}) {
    const params = new URLSearchParams();
    if (league) params.set('league', league);
    if (seasonId) params.set('season', seasonId);
    const query = params.toString();
    return query ? `/bundles/draft-results?${query}` : '/bundles/draft-results';
}

export async function loadStandingsBundle({ league, seasonId } = {}) {
    const url = buildStandingsBundleUrl({ league, seasonId });
    if (bundleLoaders.has(url)) return bundleLoaders.get(url);

    const loader = (async () => {
        try {
            const response = await fetch(url, { cache: 'default' });
            if (!response.ok) {
                throw new Error(`Standings bundle fetch failed: ${response.status}`);
            }

            const bundleBuffer = await response.arrayBuffer();
            const loadTask = loadBundle(db, bundleBuffer);
            await loadTask;
            return true;
        } catch (error) {
            console.warn('Standings bundle unavailable; falling back to live Firestore.', error);
            return false;
        }
    })();

    bundleLoaders.set(url, loader);
    return loader;
}

export async function loadSeasonBundle({ league, seasonId } = {}) {
    const url = buildSeasonBundleUrl({ league, seasonId });
    if (bundleLoaders.has(url)) return bundleLoaders.get(url);

    const loader = (async () => {
        try {
            const response = await fetch(url, { cache: 'default' });
            if (!response.ok) {
                throw new Error(`Season bundle fetch failed: ${response.status}`);
            }

            const bundleBuffer = await response.arrayBuffer();
            const loadTask = loadBundle(db, bundleBuffer);
            await loadTask;
            return true;
        } catch (error) {
            console.warn('Season bundle unavailable; falling back to live Firestore.', error);
            return false;
        }
    })();

    bundleLoaders.set(url, loader);
    return loader;
}

export async function loadDraftPicksBundle({ league } = {}) {
    const url = buildDraftPicksBundleUrl({ league });
    if (bundleLoaders.has(url)) return bundleLoaders.get(url);

    const loader = (async () => {
        try {
            const response = await fetch(url, { cache: 'default' });
            if (!response.ok) {
                throw new Error(`Draft picks bundle fetch failed: ${response.status}`);
            }

            const bundleBuffer = await response.arrayBuffer();
            const loadTask = loadBundle(db, bundleBuffer);
            await loadTask;
            return true;
        } catch (error) {
            console.warn('Draft picks bundle unavailable; falling back to live Firestore.', error);
            return false;
        }
    })();

    bundleLoaders.set(url, loader);
    return loader;
}

export async function loadTransactionsBundle({ league, seasonId } = {}) {
    const url = buildTransactionsBundleUrl({ league, seasonId });
    if (bundleLoaders.has(url)) return bundleLoaders.get(url);

    const loader = (async () => {
        try {
            const response = await fetch(url, { cache: 'default' });
            if (!response.ok) {
                throw new Error(`Transactions bundle fetch failed: ${response.status}`);
            }

            const bundleBuffer = await response.arrayBuffer();
            const loadTask = loadBundle(db, bundleBuffer);
            await loadTask;
            return true;
        } catch (error) {
            console.warn('Transactions bundle unavailable; falling back to live Firestore.', error);
            return false;
        }
    })();

    bundleLoaders.set(url, loader);
    return loader;
}

export async function loadAwardsBundle({ league, seasonId } = {}) {
    const url = buildAwardsBundleUrl({ league, seasonId });
    if (bundleLoaders.has(url)) return bundleLoaders.get(url);

    const loader = (async () => {
        try {
            const response = await fetch(url, { cache: 'default' });
            if (!response.ok) {
                throw new Error(`Awards bundle fetch failed: ${response.status}`);
            }

            const bundleBuffer = await response.arrayBuffer();
            const loadTask = loadBundle(db, bundleBuffer);
            await loadTask;
            return true;
        } catch (error) {
            console.warn('Awards bundle unavailable; falling back to live Firestore.', error);
            return false;
        }
    })();

    bundleLoaders.set(url, loader);
    return loader;
}

export async function loadDraftResultsBundle({ league, seasonId } = {}) {
    const url = buildDraftResultsBundleUrl({ league, seasonId });
    if (bundleLoaders.has(url)) return bundleLoaders.get(url);

    const loader = (async () => {
        try {
            const response = await fetch(url, { cache: 'default' });
            if (!response.ok) {
                throw new Error(`Draft results bundle fetch failed: ${response.status}`);
            }

            const bundleBuffer = await response.arrayBuffer();
            const loadTask = loadBundle(db, bundleBuffer);
            await loadTask;
            return true;
        } catch (error) {
            console.warn('Draft results bundle unavailable; falling back to live Firestore.', error);
            return false;
        }
    })();

    bundleLoaders.set(url, loader);
    return loader;
}
