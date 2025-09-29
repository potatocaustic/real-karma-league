import { db, collection, getDocs } from '/js/firebase-init.js';

document.addEventListener('DOMContentLoaded', async () => {
    const tableBody = document.getElementById('prospects-table-body');
    const loadingDiv = document.getElementById('loading');
    let prospectsData = [];

    // --- State for sorting ---
    let currentSort = {
        key: 'monthly_rank',
        order: 'asc' // asc or desc
    };

    /**
     * Renders the table with the provided data array.
     * @param {Array} data The array of prospect objects to render.
     */
    const renderTable = (data) => {
        if (!data || data.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 2rem;">No draft prospects have been declared yet.</td></tr>';
            return;
        }

        const tableHTML = data.map(prospect => `
            <tr>
                <td><a href="https://real.app.vg/user/${prospect.player_id}" target="_blank" rel="noopener noreferrer">${prospect.player_handle}</a></td>
                <td>${prospect.monthly_rank !== null ? prospect.monthly_rank : 'N/A'}</td>
                <td>${prospect.karma.toLocaleString()}</td>
                <td>${prospect.ranked_days}</td>
            </tr>
        `).join('');

        tableBody.innerHTML = tableHTML;
    };

    /**
     * Sorts the prospects data based on the currentSort state and re-renders the table.
     */
    const sortAndRender = () => {
        prospectsData.sort((a, b) => {
            const valA = a[currentSort.key];
            const valB = b[currentSort.key];

            // Handle nulls by sorting them to the bottom
            if (valA === null) return 1;
            if (valB === null) return -1;

            if (valA < valB) {
                return currentSort.order === 'asc' ? -1 : 1;
            }
            if (valA > valB) {
                return currentSort.order === 'asc' ? 1 : -1;
            }
            return 0;
        });
        renderTable(prospectsData);
    };

    /**
     * Updates the sort arrows in the table headers.
     */
    const updateSortHeaders = () => {
        document.querySelectorAll('.sortable').forEach(header => {
            header.classList.remove('sorted-asc', 'sorted-desc');
            const arrow = header.querySelector('.sort-arrow');
            if (header.dataset.sort === currentSort.key) {
                header.classList.add(currentSort.order === 'asc' ? 'sorted-asc' : 'sorted-desc');
            }
        });
    };

    try {
        // Assuming 'S8' is the active season for this context
        const prospectsCollectionRef = collection(db, 'seasons/S8/draft_prospects');
        const querySnapshot = await getDocs(prospectsCollectionRef);

        prospectsData = querySnapshot.docs.map(doc => doc.data());

        loadingDiv.style.display = 'none';

        // Initial sort and render
        sortAndRender();
        updateSortHeaders();

        // Add click listeners to sortable headers
        document.querySelectorAll('.sortable').forEach(header => {
            header.addEventListener('click', () => {
                const sortKey = header.dataset.sort;

                if (currentSort.key === sortKey) {
                    // Flip order if clicking the same header
                    currentSort.order = currentSort.order === 'asc' ? 'desc' : 'asc';
                } else {
                    // Change sort key
                    currentSort.key = sortKey;
                    currentSort.order = header.dataset.order || 'asc'; // Use default order from data attribute
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