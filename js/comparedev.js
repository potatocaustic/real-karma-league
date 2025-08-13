// /js/comparedev.js (merged)

// --- MODIFIED: Import functions from Firebase SDK via your init file ---
import {
    db,
    collection,
    getDocs,
    query,
    where,
    limit,
    collectionGroup
} from '../js/firebase-init.js';

document.addEventListener('DOMContentLoaded', () => {
    // --- Global State ---
    let allPlayersData = [];
    let allTeamsData = [];
    let currentComparisonType = 'players'; // 'players' or 'teams'

    // --- DOM Elements ---
    const selectorsContainer = document.getElementById('selectors-container');
    const compareBtnContainer = document.querySelector('.compare-btn-container');
    const compareBtn = document.getElementById('compare-btn');
    const resultsContainer = document.getElementById('results-container');
    const selectPlayersBtn = document.getElementById('select-players-btn');
    const selectTeamsBtn = document.getElementById('select-teams-btn');

    /**
     * Parses a string into a number. Returns 0 if invalid.
     * @param {*} value The value to parse.
     * @returns {number} The parsed number.
     */
    function parseNumber(value) {
        if (value === null || typeof value === 'undefined' || String(value).trim() === '') return 0;
        const cleaned = String(value).replace(/,/g, '');
        const parsed = parseFloat(cleaned);
        return isNaN(parsed) ? 0 : parsed;
    }

    /**
     * Renders the selection dropdowns based on the comparison type.
     * @param {string} type - 'players' or 'teams'.
     */
    function renderSelectors(type) {
        currentComparisonType = type;
        resultsContainer.classList.remove('visible');
        compareBtn.disabled = true;

        const data = type === 'players' ? allPlayersData : allTeamsData;
        const valueField = type === 'players' ? 'id' : 'team_id';
        const textField = type === 'players' ? 'player_handle' : 'team_name';

        const sortedData = [...data].sort((a, b) => a[textField].localeCompare(b[textField]));

        let optionsHTML = '<option value="">Select...</option>';
        optionsHTML += sortedData.map(item => `<option value="${item[valueField]}">${item[textField]}</option>`).join('');

        const selectorsHTML = `
            <div class="selectors-grid">
                <div class="selector-box">
                    <label for="select-1">${type === 'players' ? 'Player 1' : 'Team 1'}</label>
                    <select id="select-1">${optionsHTML}</select>
                </div>
                <div class="vs-separator">VS</div>
                <div class="selector-box">
                    <label for="select-2">${type === 'players' ? 'Player 2' : 'Team 2'}</label>
                    <select id="select-2">${optionsHTML}</select>
                </div>
            </div>
        `;

        selectorsContainer.innerHTML = selectorsHTML;
        compareBtnContainer.style.display = 'block';

        document.getElementById('select-1').addEventListener('change', checkSelections);
        document.getElementById('select-2').addEventListener('change', checkSelections);
    }

    /**
     * Checks if two different entities are selected to enable the compare button.
     */
    function checkSelections() {
        const val1 = document.getElementById('select-1').value;
        const val2 = document.getElementById('select-2').value;
        compareBtn.disabled = !(val1 && val2 && val1 !== val2);
        resultsContainer.classList.remove('visible');
    }

    /**
     * Displays the comparison results in a grid format.
     */
    function displayComparison() {
        const val1 = document.getElementById('select-1').value;
        const val2 = document.getElementById('select-2').value;

        const data1 = (currentComparisonType === 'players' ? allPlayersData : allTeamsData).find(d => d[currentComparisonType === 'players' ? 'id' : 'team_id'] === val1);
        const data2 = (currentComparisonType === 'players' ? allPlayersData : allTeamsData).find(d => d[currentComparisonType === 'players' ? 'id' : 'team_id'] === val2);

        if (!data1 || !data2) {
            resultsContainer.innerHTML = `<div class="error">Could not find data for one or more selections.</div>`;
            resultsContainer.classList.add('visible');
            return;
        }
        
        const nameText1 = currentComparisonType === 'players' ? data1.player_handle : data1.team_name;
        const nameText2 = currentComparisonType === 'players' ? data2.player_handle : data2.team_name;
        
        let badges1 = '';
        let badges2 = '';
        if (currentComparisonType === 'players') {
            const rookieBadge1 = data1.rookie === '1' ? `<span class="rookie-badge-compare">R</span>` : '';
            const allStarBadge1 = data1.all_star === '1' ? `<span class="all-star-badge-compare">★</span>` : '';
            badges1 = `<span class="badge-container">${rookieBadge1}${allStarBadge1}</span>`;

            const rookieBadge2 = data2.rookie === '1' ? `<span class="rookie-badge-compare">R</span>` : '';
            const allStarBadge2 = data2.all_star === '1' ? `<span class="all-star-badge-compare">★</span>` : '';
            badges2 = `<span class="badge-container">${rookieBadge2}${allStarBadge2}</span>`;
        }

        const icon1_id = currentComparisonType === 'players' ? data1.current_team_id : data1.team_id;
        const icon2_id = currentComparisonType === 'players' ? data2.current_team_id : data2.team_id;
        
        const icon1_src = `../icons/${icon1_id || 'FA'}.webp`;
        const icon2_src = `../icons/${icon2_id || 'FA'}.webp`;

        const link1 = currentComparisonType === 'players' ? `player.html?id=${data1.id}` : `team.html?id=${data1.team_id}`;
        const link2 = currentComparisonType === 'players' ? `player.html?id=${data2.id}` : `team.html?id=${data2.team_id}`;

        // --- MERGED: Metrics now point to pre-calculated Firestore fields and include tREL ---
        const metrics = currentComparisonType === 'players' ? 
            [
                { label: 'Games Played', field: 'games_played', higherIsBetter: true, format: (v) => v },
                { label: 'REL Median', field: 'rel_median', higherIsBetter: true, format: (v) => v.toFixed(3) },
                { label: 'WAR', field: 'WAR', higherIsBetter: true, format: (v) => v.toFixed(2) },
                { label: 'GEM', field: 'GEM', higherIsBetter: false, format: (v) => v > 0 ? v.toFixed(1) : '-' },
                { label: 'Median Gameday Rank', field: 'medrank', higherIsBetter: false, format: (v) => v === 0 ? '-' : Math.round(v) },
                { label: 'Games Above Median', field: 'aag_median', higherIsBetter: true, format: (v) => v },
                { label: 'Top 100 Finishes', field: 't100', higherIsBetter: true, format: (v) => v }
            ] : 
            [
                { label: 'Record', field: 'wins', higherIsBetter: true, format: (v, d) => `${d.wins}-${d.losses}` },
                { label: 'PAM', field: 'pam', higherIsBetter: true, format: (v) => Math.round(v).toLocaleString() },
                { label: 'apPAM', field: 'apPAM', higherIsBetter: true, format: (val) => val ? val.toFixed(3) : '-' },
                { label: 'tREL', field: 'tREL', higherIsBetter: true, format: (v) => v ? parseFloat(v).toFixed(3) : '-' }, // <-- This is the new stat
                { label: 'Median Starter Rank', field: 'med_starter_rank', higherIsBetter: false, format: (v) => v > 0 ? Math.round(v) : '-' },
            ];

        const metricRowsHTML = metrics.map(metric => {
            let metricVal1, metricVal2;
            let displayVal1, displayVal2;

            if (metric.field === 'wins') {
                metricVal1 = data1.wpct || 0; // Use pre-calculated win percentage
                metricVal2 = data2.wpct || 0;
                displayVal1 = metric.format(null, data1);
                displayVal2 = metric.format(null, data2);
            } else {
                metricVal1 = parseNumber(data1[metric.field]);
                metricVal2 = parseNumber(data2[metric.field]);
                displayVal1 = metric.format(metricVal1, data1);
                displayVal2 = metric.format(metricVal2, data2);
            }
            
            let isVal1Winner, isVal2Winner;
            const isTie = metricVal1 === metricVal2;

            if (!isTie) {
                if (metric.higherIsBetter) {
                    isVal1Winner = metricVal1 > metricVal2;
                    isVal2Winner = metricVal2 > metricVal1;
                } else { // Lower is better
                    const hasVal1 = metricVal1 > 0 && metricVal1 !== Infinity;
                    const hasVal2 = metricVal2 > 0 && metricVal2 !== Infinity;
                    isVal1Winner = hasVal1 && (!hasVal2 || metricVal1 < metricVal2);
                    isVal2Winner = hasVal2 && (!hasVal1 || metricVal2 < metricVal1);
                }
            }
            
            const class1 = isTie ? 'tie' : (isVal1Winner ? 'winner' : '');
            const class2 = isTie ? 'tie' : (isVal2Winner ? 'winner' : '');
            
            return `
                <div class="comparison-row">
                    <div class="metric-value value1 ${class1}">${displayVal1}</div>
                    <div class="metric-label">${metric.label}</div>
                    <div class="metric-value value2 ${class2}">${displayVal2}</div>
                </div>
            `;
        }).join('');

        const resultsHTML = `
            <div class="results-header-flex">
                <div class="entity-header entity1">
                   <a href="${link1}">
                        <div class="icon-name-wrapper">
                            <img src="${icon1_src}" class="entity-icon" onerror="this.onerror=null; this.src='../icons/FA.webp'">
                            <div>
                                <span class="entity-name-text">${nameText1}</span>${badges1}
                            </div>
                        </div>
                   </a>
                </div>
                <div class="results-vs-separator">VS</div>
                <div class="entity-header entity2">
                   <a href="${link2}">
                        <div class="icon-name-wrapper">
                            <div>
                                <span class="entity-name-text">${nameText2}</span>${badges2}
                            </div>
                            <img src="${icon2_src}" class="entity-icon" onerror="this.onerror=null; this.src='../icons/FA.webp'">
                        </div>
                   </a>
                </div>
            </div>
            <div class="comparison-grid">
                ${metricRowsHTML}
            </div>
        `;
        resultsContainer.innerHTML = resultsHTML;
        resultsContainer.classList.add('visible');
    }


    /**
     * Initializes the entire page, fetches data from Firestore, and sets up event listeners.
     */
    async function initializeApp() {
        selectorsContainer.innerHTML = `<div class="loading">Loading Season 8 data from Firestore...</div>`;
        
        try {
            // Get active season ID (e.g., "S8")
            // NOTE: Using _dev collections as configured in your index.js
            const seasonsQuery = query(collection(db, "seasons_dev"), where("status", "==", "active"), limit(1));
            const seasonsSnap = await getDocs(seasonsQuery);
            if (seasonsSnap.empty) {
                throw new Error("An active season could not be found.");
            }
            const activeSeasonId = seasonsSnap.docs[0].id;

            // Fetch all required data from Firestore in parallel
            const [
                playersSnap,
                teamsSnap,
                seasonalStatsSnap,
                seasonalRecordsSnap
            ] = await Promise.all([
                getDocs(collection(db, "v2_players_dev")),
                getDocs(query(collection(db, "v2_teams_dev"), where("conference", "in", ["Eastern", "Western"]))),
                getDocs(collectionGroup(db, 'seasonal_stats_dev')),
                getDocs(collectionGroup(db, 'seasonal_records_dev'))
            ]);

            // Create a map of seasonal stats { playerId: statsObject } for the active season
            const seasonalStatsMap = new Map();
            seasonalStatsSnap.forEach(doc => {
                const pathParts = doc.ref.path.split('/');
                if (pathParts.includes(activeSeasonId)) {
                    const playerId = pathParts[pathParts.length - 3];
                    seasonalStatsMap.set(playerId, doc.data());
                }
            });

            // Combine player data with their active seasonal stats
            allPlayersData = playersSnap.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(player => player.player_status === 'ACTIVE' && seasonalStatsMap.has(player.id))
                .map(player => ({...player, ...seasonalStatsMap.get(player.id)}));

            // Create a map of seasonal records { teamId: recordObject } for the active season
            const seasonalRecordsMap = new Map();
            seasonalRecordsSnap.forEach(doc => {
                const pathParts = doc.ref.path.split('/');
                if (pathParts.includes(activeSeasonId)) {
                    const teamId = pathParts[pathParts.length - 3];
                    seasonalRecordsMap.set(teamId, doc.data());
                }
            });

            // Combine team data with their active seasonal records
            allTeamsData = teamsSnap.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(team => seasonalRecordsMap.has(team.id))
                .map(team => ({...team, ...seasonalRecordsMap.get(team.id), team_id: team.id }));

            // Set up UI event listeners
            selectPlayersBtn.addEventListener('click', () => {
                selectPlayersBtn.classList.add('active');
                selectTeamsBtn.classList.remove('active');
                renderSelectors('players');
            });

            selectTeamsBtn.addEventListener('click', () => {
                selectTeamsBtn.classList.add('active');
                selectPlayersBtn.classList.remove('active');
                renderSelectors('teams');
            });

            compareBtn.addEventListener('click', displayComparison);

            // Initial render
            renderSelectors(currentComparisonType);

        } catch (error) {
            console.error("Error initializing from Firestore:", error);
            selectorsContainer.innerHTML = `<div class="error">Failed to load data from Firestore. Please check the console and ensure you are connected.</div>`;
        }
    }

    initializeApp();
});