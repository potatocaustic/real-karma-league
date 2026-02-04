import { db, collection, getDocs, collectionNames } from '/js/firebase-init.js';
import { getSeasonIdFromPage } from './season-utils.js';

const { seasonId: SEASON_ID } = getSeasonIdFromPage({ fallback: 'S9' });

document.addEventListener('DOMContentLoaded', async () => {
    const tableBody = document.getElementById('free-agents-table-body');
    const loadingDiv = document.getElementById('loading');
    let freeAgentsData = [];

    let currentSort = {
        key: 'monthly_rank',
        order: 'asc'
    };

    const renderTable = (data) => {
        if (!data || data.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 2rem;">No free agents currently available.</td></tr>';
            return;
        }

        const tableHTML = data.map((freeAgent, index) => `
            <tr>
                <td>${index + 1}</td>
                <td>${freeAgent.player_handle}</td>
                <td>${freeAgent.monthly_rank != null ? freeAgent.monthly_rank : 'N/A'}</td>
                <td class="mobile-hide">${freeAgent.karma != null ? freeAgent.karma.toLocaleString() : 'N/A'}</td>
                <td>${freeAgent.ranked_days != null ? freeAgent.ranked_days : 'N/A'}</td>
            </tr>
        `).join('');

        tableBody.innerHTML = tableHTML;
    };

    const sortAndRender = () => {
        freeAgentsData.sort((a, b) => {
            const valA = a[currentSort.key];
            const valB = b[currentSort.key];

            if (valA === null) return 1;
            if (valB === null) return -1;

            if (valA < valB) return currentSort.order === 'asc' ? -1 : 1;
            if (valA > valB) return currentSort.order === 'asc' ? 1 : -1;

            return 0;
        });
        renderTable(freeAgentsData);
    };

    const updateSortHeaders = () => {
        document.querySelectorAll('.sortable').forEach(header => {
            header.classList.remove('sorted-asc', 'sorted-desc');
            if (header.dataset.sort === currentSort.key) {
                header.classList.add(currentSort.order === 'asc' ? 'sorted-asc' : 'sorted-desc');
            }
        });
    };

    try {
        const freeAgentsCollectionRef = collection(db, `${collectionNames.seasons}/${SEASON_ID}/free_agents`);
        const querySnapshot = await getDocs(freeAgentsCollectionRef);

        freeAgentsData = querySnapshot.docs.map(doc => doc.data());
        loadingDiv.style.display = 'none';

        sortAndRender();
        updateSortHeaders();

        document.querySelectorAll('.sortable').forEach(header => {
            header.addEventListener('click', () => {
                const sortKey = header.dataset.sort;
                if (currentSort.key === sortKey) {
                    currentSort.order = currentSort.order === 'asc' ? 'desc' : 'asc';
                } else {
                    currentSort.key = sortKey;
                    currentSort.order = header.dataset.order || 'asc';
                }
                sortAndRender();
                updateSortHeaders();
            });
        });

    } catch (error) {
        console.error("Error fetching free agents:", error);
        loadingDiv.innerHTML = '<div class="error">Could not load free agent data.</div>';
    }
});
