// /admin/manage-access-codes.js

import {
    auth,
    db,
    functions,
    onAuthStateChanged,
    doc,
    getDoc,
    collection,
    getDocs,
    query,
    where,
    orderBy,
    collectionNames,
    getCurrentLeague,
    setCurrentLeague
} from '/js/firebase-init.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-functions.js';

// Cloud function references
const generateActivationCode = httpsCallable(functions, 'generateActivationCode');
const revokeActivationCode = httpsCallable(functions, 'revokeActivationCode');
const listActivationCodes = httpsCallable(functions, 'listActivationCodes');

let allCodes = [];
let teamsCache = { major: [], minor: [] };

document.addEventListener('DOMContentLoaded', () => {
    const loadingContainer = document.getElementById('loading-container');
    const mainContainer = document.getElementById('main-container');
    const leagueSelect = document.getElementById('league-select');
    const teamSelect = document.getElementById('team-select');
    const expiresDaysInput = document.getElementById('expires-days');
    const generateCodeBtn = document.getElementById('generate-code-btn');
    const filterLeague = document.getElementById('filter-league');
    const filterStatus = document.getElementById('filter-status');
    const refreshCodesBtn = document.getElementById('refresh-codes-btn');
    const generateMessage = document.getElementById('generate-message');

    // Initialize league switcher
    const leagueSwitcherBtn = document.getElementById('league-toggle-btn');
    if (leagueSwitcherBtn) {
        leagueSwitcherBtn.addEventListener('click', () => {
            const currentLeague = getCurrentLeague();
            const newLeague = currentLeague === 'major' ? 'minor' : 'major';
            setCurrentLeague(newLeague);
            window.location.reload();
        });
    }

    // Auth check
    onAuthStateChanged(auth, async (user) => {
        if (!user) {
            window.location.href = '/login.html?reason=unauthorized';
            return;
        }

        const userDoc = await getDoc(doc(db, collectionNames.users, user.uid));
        if (!userDoc.exists() || userDoc.data().role !== 'admin') {
            loadingContainer.innerHTML = '<div class="error">Access Denied. Admin privileges required.</div>';
            return;
        }

        loadingContainer.style.display = 'none';
        mainContainer.style.display = 'block';

        // Initialize
        await loadTeams();
        await loadCodes();
    });

    // Load teams for both leagues
    async function loadTeams() {
        try {
            for (const league of ['major', 'minor']) {
                const teamsCollectionName = league === 'minor' ? 'minor_v2_teams' : 'v2_teams';
                const teamsSnapshot = await getDocs(collection(db, teamsCollectionName));

                teamsCache[league] = teamsSnapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                })).sort((a, b) => {
                    const nameA = a.franchise_name || a.team_id;
                    const nameB = b.franchise_name || b.team_id;
                    return nameA.localeCompare(nameB);
                });
            }

            updateTeamSelect();
        } catch (error) {
            console.error('Error loading teams:', error);
            showMessage(generateMessage, 'Failed to load teams: ' + error.message, 'error');
        }
    }

    // Update team select dropdown based on selected league
    function updateTeamSelect() {
        const selectedLeague = leagueSelect.value;
        const teams = teamsCache[selectedLeague] || [];

        teamSelect.innerHTML = '';

        if (teams.length === 0) {
            teamSelect.innerHTML = '<option value="">No teams found</option>';
            return;
        }

        teamSelect.innerHTML = '<option value="">Select a team...</option>';
        teams.forEach(team => {
            const option = document.createElement('option');
            option.value = team.id;
            option.textContent = team.franchise_name || team.team_id;
            teamSelect.appendChild(option);
        });
    }

    // League select change handler
    leagueSelect.addEventListener('change', updateTeamSelect);

    // Generate code button handler
    generateCodeBtn.addEventListener('click', async () => {
        const league = leagueSelect.value;
        const teamId = teamSelect.value;
        const expiresDays = expiresDaysInput.value;

        if (!teamId) {
            showMessage(generateMessage, 'Please select a team', 'error');
            return;
        }

        generateCodeBtn.disabled = true;
        generateCodeBtn.textContent = 'Generating...';

        try {
            const params = {
                team_id: teamId,
                league: league
            };

            if (expiresDays) {
                params.expires_in_days = parseInt(expiresDays);
            }

            const result = await generateActivationCode(params);

            const code = result.data.code;
            const teamName = teamSelect.options[teamSelect.selectedIndex].text;

            showMessage(
                generateMessage,
                `<strong>Success!</strong> Generated code for ${teamName} (${league} league):<br>
                <div style="margin-top: 12px; font-size: 1.5rem;">
                    <span class="code-badge" onclick="copyCode('${code}')" title="Click to copy">${code}</span>
                </div>
                <div style="margin-top: 8px; font-size: 0.9rem; color: #666;">
                    ${expiresDays ? `Expires in ${expiresDays} days` : 'No expiration'}
                </div>`,
                'success'
            );

            // Reset form
            teamSelect.value = '';
            expiresDaysInput.value = '';

            // Reload codes list
            await loadCodes();
        } catch (error) {
            console.error('Error generating code:', error);
            showMessage(generateMessage, 'Failed to generate code: ' + error.message, 'error');
        } finally {
            generateCodeBtn.disabled = false;
            generateCodeBtn.textContent = 'Generate Code';
        }
    });

    // Load activation codes
    async function loadCodes() {
        try {
            const result = await listActivationCodes({ include_used: true });
            allCodes = result.data.codes;
            renderCodes();
        } catch (error) {
            console.error('Error loading codes:', error);
            document.getElementById('codes-list-container').innerHTML =
                '<div class="empty-state">Failed to load codes: ' + error.message + '</div>';
        }
    }

    // Render codes table with filters
    function renderCodes() {
        const leagueFilter = filterLeague.value;
        const statusFilter = filterStatus.value;

        let filteredCodes = allCodes.filter(code => {
            // League filter
            if (leagueFilter !== 'all' && code.league !== leagueFilter) {
                return false;
            }

            // Status filter
            if (statusFilter !== 'all') {
                const isUsed = !!code.used_by;
                const isExpired = code.expires_at && new Date(code.expires_at) < new Date();
                const isActive = !isUsed && !isExpired && code.is_active;

                if (statusFilter === 'active' && !isActive) return false;
                if (statusFilter === 'used' && !isUsed) return false;
                if (statusFilter === 'expired' && !isExpired) return false;
            }

            return true;
        });

        const container = document.getElementById('codes-list-container');

        if (filteredCodes.length === 0) {
            container.innerHTML = '<div class="empty-state">No codes found matching filters</div>';
            return;
        }

        const table = document.createElement('table');
        table.className = 'codes-table';
        table.innerHTML = `
            <thead>
                <tr>
                    <th>Code</th>
                    <th>League</th>
                    <th>Team</th>
                    <th>Status</th>
                    <th>Created</th>
                    <th>Used By</th>
                    <th>Expires</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody id="codes-tbody"></tbody>
        `;

        container.innerHTML = '';
        container.appendChild(table);

        const tbody = document.getElementById('codes-tbody');

        filteredCodes.forEach(code => {
            const row = document.createElement('tr');

            const isUsed = !!code.used_by;
            const isExpired = code.expires_at && new Date(code.expires_at) < new Date();
            const isActive = !isUsed && !isExpired && code.is_active;

            let statusBadge = '';
            if (isUsed) {
                statusBadge = '<span class="status-badge status-used">Used</span>';
            } else if (isExpired) {
                statusBadge = '<span class="status-badge status-expired">Expired</span>';
            } else if (isActive) {
                statusBadge = '<span class="status-badge status-active">Active</span>';
            } else {
                statusBadge = '<span class="status-badge status-expired">Revoked</span>';
            }

            const leagueBadge = `<span class="league-badge league-${code.league}">${code.league}</span>`;

            const createdDate = code.created_at ? new Date(code.created_at).toLocaleDateString() : 'N/A';
            const expiresDate = code.expires_at ? new Date(code.expires_at).toLocaleDateString() : 'Never';
            const usedBy = code.used_by ? `User ${code.used_by.substring(0, 8)}...` : '-';

            row.innerHTML = `
                <td>
                    <span class="code-badge" onclick="copyCode('${code.code}')" title="Click to copy">
                        ${code.code}
                    </span>
                </td>
                <td>${leagueBadge}</td>
                <td>${getTeamName(code.team_id, code.league)}</td>
                <td>${statusBadge}</td>
                <td>${createdDate}</td>
                <td>${usedBy}</td>
                <td>${expiresDate}</td>
                <td>
                    <div class="action-buttons">
                        ${isActive && !isUsed ?
                            `<button class="btn btn-danger btn-sm" onclick="revokeCode('${code.code}')">Revoke</button>` :
                            '-'}
                    </div>
                </td>
            `;

            tbody.appendChild(row);
        });
    }

    // Helper function to get team name
    function getTeamName(teamId, league) {
        const teams = teamsCache[league] || [];
        const team = teams.find(t => t.id === teamId);
        return team ? (team.franchise_name || team.team_id) : teamId;
    }

    // Filter change handlers
    filterLeague.addEventListener('change', renderCodes);
    filterStatus.addEventListener('change', renderCodes);
    refreshCodesBtn.addEventListener('click', loadCodes);

    // Global functions for inline onclick handlers
    window.copyCode = function(code) {
        navigator.clipboard.writeText(code).then(() => {
            showCopiedTooltip(event);
        }).catch(err => {
            console.error('Failed to copy:', err);
        });
    };

    window.revokeCode = async function(code) {
        if (!confirm(`Are you sure you want to revoke the code "${code}"? This action cannot be undone.`)) {
            return;
        }

        try {
            await revokeActivationCode({ code });
            showMessage(generateMessage, `Code "${code}" has been revoked.`, 'success');
            await loadCodes();
        } catch (error) {
            console.error('Error revoking code:', error);
            showMessage(generateMessage, 'Failed to revoke code: ' + error.message, 'error');
        }
    };

    function showCopiedTooltip(event) {
        const tooltip = document.getElementById('copied-tooltip');
        tooltip.style.left = event.pageX + 'px';
        tooltip.style.top = (event.pageY - 40) + 'px';
        tooltip.classList.add('show');

        setTimeout(() => {
            tooltip.classList.remove('show');
        }, 2000);
    }

    function showMessage(container, message, type) {
        container.innerHTML = `<div class="message message-${type}">${message}</div>`;
        setTimeout(() => {
            container.innerHTML = '';
        }, 8000);
    }
});
