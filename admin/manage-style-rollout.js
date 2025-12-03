// /admin/manage-style-rollout.js
import {
    auth,
    db,
    onAuthStateChanged,
    signOut,
    doc,
    getDoc,
    getDocs,
    collection,
    setDoc,
    serverTimestamp
} from '/js/firebase-init.js';
import { STYLE_ROLLOUT_COLLECTION, getPageStyleKey } from '/js/style-rollout.js';

const loadingContainer = document.getElementById('loading-container');
const adminContainer = document.getElementById('admin-container');
const tableWrapper = document.getElementById('style-rollout-table');
const addPageBtn = document.getElementById('add-page-btn');
const pathInput = document.getElementById('new-page-path');
const labelInput = document.getElementById('new-page-label');

const defaultPages = [
    { path: '/', label: 'Homepage' },
    { path: '/login.html', label: 'Login' },
    { path: '/activate.html', label: 'Activate Account' },
    { path: '/S9/RKL-S9.html', label: 'S9 Home' },
    { path: '/S9/standings.html', label: 'S9 Standings' },
    { path: '/S9/leaderboards.html', label: 'S9 Leaderboards' },
    { path: '/S9/schedule.html', label: 'S9 Schedule' },
    { path: '/S9/draft-capital.html', label: 'S9 Draft Capital' },
    { path: '/S9/transactions.html', label: 'S9 Transactions' },
    { path: '/S9/teams.html', label: 'S9 Teams' }
];

const pageState = new Map();

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = '/login.html';
        return;
    }

    const userRef = doc(db, 'users', user.uid);
    const userDoc = await getDoc(userRef);

    if (userDoc.exists() && userDoc.data().role === 'admin') {
        loadingContainer.style.display = 'none';
        adminContainer.style.display = 'block';
        document.getElementById('auth-status').innerHTML = `Welcome, Admin | <a href="#" id="logout-btn">Logout</a>`;
        addLogoutListener();
        initializeRolloutTable();
    } else {
        loadingContainer.innerHTML = '<div class="error">Access Denied. You do not have permission to view this page.</div>';
        document.getElementById('auth-status').innerHTML = `Access Denied | <a href="#" id="logout-btn">Logout</a>`;
        addLogoutListener();
    }
});

function addLogoutListener() {
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            signOut(auth).then(() => window.location.href = '/login.html');
        });
    }
}

async function initializeRolloutTable() {
    try {
        const snapshot = await getDocs(collection(db, STYLE_ROLLOUT_COLLECTION));
        const configuredPages = new Map();
        snapshot.forEach((docSnap) => {
            const data = docSnap.data();
            configuredPages.set(docSnap.id, {
                path: data.path,
                label: data.label || data.path,
                enabled: data.enabled === true,
                updatedAt: data.updatedAt
            });
        });

        [...defaultPages, ...configuredPages.values()].forEach((page) => {
            const key = getPageStyleKey(page.path);
            if (!pageState.has(key)) {
                pageState.set(key, {
                    path: page.path,
                    label: page.label || page.path,
                    enabled: configuredPages.get(key)?.enabled || false,
                    updatedAt: configuredPages.get(key)?.updatedAt || null
                });
            } else {
                const existing = pageState.get(key);
                pageState.set(key, {
                    ...existing,
                    enabled: configuredPages.get(key)?.enabled ?? existing.enabled,
                    updatedAt: configuredPages.get(key)?.updatedAt ?? existing.updatedAt
                });
            }
        });

        renderTable();
    } catch (error) {
        tableWrapper.innerHTML = `<div class="error">Failed to load style rollout settings: ${error.message}</div>`;
    }
}

function renderTable() {
    const rows = [];

    const sortedPages = Array.from(pageState.values()).sort((a, b) => a.path.localeCompare(b.path));

    rows.push(`
        <table>
            <thead>
                <tr>
                    <th>Page</th>
                    <th>Path</th>
                    <th>Status</th>
                    <th>Last Updated</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                ${sortedPages.map(renderRow).join('')}
            </tbody>
        </table>
    `);

    tableWrapper.innerHTML = rows.join('');

    tableWrapper.querySelectorAll('[data-action]').forEach((btn) => {
        btn.addEventListener('click', handleRowAction);
    });
}

function renderRow(page) {
    const statusClass = page.enabled ? 'badge badge-success' : 'badge badge-muted';
    const statusLabel = page.enabled ? 'Modern styling active' : 'Legacy styling active';
    const updated = page.updatedAt?.toDate ? page.updatedAt.toDate().toLocaleString() : '–';

    const actionLabel = page.enabled ? 'Revert to Legacy' : 'Apply Modern Style';
    const actionIntent = page.enabled ? 'disable' : 'enable';
    const key = getPageStyleKey(page.path);

    return `
        <tr>
            <td><strong>${page.label}</strong></td>
            <td><code>${page.path}</code></td>
            <td><span class="${statusClass}">${statusLabel}</span></td>
            <td>${updated}</td>
            <td>
                <button data-action="${actionIntent}" data-key="${key}" class="btn-secondary">${actionLabel}</button>
            </td>
        </tr>
    `;
}

async function handleRowAction(event) {
    const button = event.currentTarget;
    const key = button.dataset.key;
    const intent = button.dataset.action;
    const page = pageState.get(key);
    if (!page) return;

    try {
        const enabled = intent === 'enable';
        await setDoc(doc(db, STYLE_ROLLOUT_COLLECTION, key), {
            path: page.path,
            label: page.label,
            enabled,
            updatedAt: serverTimestamp()
        });
        pageState.set(key, { ...page, enabled });
        renderTable();
    } catch (error) {
        alert(`Unable to update style setting: ${error.message}`);
    }
}

addPageBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    const path = (pathInput.value || '').trim();
    if (!path.startsWith('/')) {
        alert('Please enter a full path beginning with /');
        return;
    }

    const label = (labelInput.value || '').trim() || path;
    const key = getPageStyleKey(path);

    if (!pageState.has(key)) {
        pageState.set(key, { path, label, enabled: false, updatedAt: null });
        renderTable();
    }

    pathInput.value = '';
    labelInput.value = '';
});
