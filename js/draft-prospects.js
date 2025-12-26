import { db, collection, getDocs, collectionNames } from '/js/firebase-init.js';

document.addEventListener('DOMContentLoaded', async () => {
    const tableBody = document.getElementById('prospects-table-body');
    const loadingDiv = document.getElementById('loading');
    let prospectsData = [];

    let currentSort = {
        key: 'monthly_rank',
        order: 'asc'
    };

    const renderTable = (data) => {
        if (!data || data.length === 0) {
            // MODIFICATION: Updated colspan to 5
            tableBody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 2rem;">No draft prospects have been declared yet.</td></tr>';
            return;
        }

        // MODIFICATION: Added index parameter to map() for numbering
        const tableHTML = data.map((prospect, index) => `
            <tr>
                <td>${index + 1}</td>
                <td>${prospect.player_handle}</td>
                <td>${prospect.monthly_rank !== null ? prospect.monthly_rank : 'N/A'}</td>
                <td class="mobile-hide">${prospect.karma.toLocaleString()}</td>
                <td>${prospect.ranked_days}</td>
            </tr>
        `).join('');

        tableBody.innerHTML = tableHTML;
    };

    const sortAndRender = () => {
        prospectsData.sort((a, b) => {
            const valA = a[currentSort.key];
            const valB = b[currentSort.key];

            if (valA === null) return 1;
            if (valB === null) return -1;

            if (valA < valB) return currentSort.order === 'asc' ? -1 : 1;
            if (valA > valB) return currentSort.order === 'asc' ? 1 : -1;
            
            return 0;
        });
        renderTable(prospectsData);
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
        const prospectsCollectionRef = collection(db, `${collectionNames.seasons}/S9/draft_prospects`);
        const querySnapshot = await getDocs(prospectsCollectionRef);

        prospectsData = querySnapshot.docs.map(doc => doc.data());
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
        console.error("Error fetching draft prospects:", error);
        loadingDiv.innerHTML = '<div class="error">Could not load draft prospect data.</div>';
    }
});
