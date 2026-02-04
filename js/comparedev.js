// /js/comparedev.js

import {
import { getSeasonIdFromPage } from './season-utils.js';
    db,
    collection,
    getDocs,
    query,
    where,
    limit,
    collectionGroup,
    collectionNames,
    getLeagueCollectionName,
    getCurrentLeague,
    getConferenceNames
} from '../js/firebase-init.js';

// Get season from page lock (data-season, path, or ?season)
const { seasonId: urlSeasonId } = getSeasonIdFromPage({ fallback: 'S9' });

document.addEventListener('DOMContentLoaded', () => {
    // --- Global State ---
    let allPlayersData = [];
    let allTeamsData = [];
    let currentComparisonType = 'players';

    // --- DOM Elements ---
    const selectorsContainer = document.getElementById('selectors-container');
    const compareBtnContainer = document.querySelector('.compare-btn-container');
    const compareBtn = document.getElementById('compare-btn');
    const resultsContainer = document.getElementById('results-container');
    const selectPlayersBtn = document.getElementById('select-players-btn');
    const selectTeamsBtn = document.getElementById('select-teams-btn');

    /**
     * Parses a string into a number. Returns 0 if invalid.
     */
    function parseNumber(value) {
        if (value === null || typeof value === 'undefined' || String(value).trim() === '') return 0;
        const cleaned = String(value).replace(/,/g, '');
        const parsed = parseFloat(cleaned);
        return isNaN(parsed) ? 0 : parsed;
    }

    /**
     * Populates the custom dropdown with filtered options.
     */
    function populateDropdown(index, searchTerm = '') {
        const optionsContainer = document.getElementById(`options-${index}`);
        const lowerCaseSearchTerm = searchTerm.toLowerCase();

        const data = currentComparisonType === 'players' ? allPlayersData : allTeamsData;
        const valueField = currentComparisonType === 'players' ? 'id' : 'team_id';
        const textField = currentComparisonType === 'players' ? 'player_handle' : 'team_name';
        const iconField = currentComparisonType === 'players' ? 'current_team_id' : 'team_id';
        
        const filteredData = data.filter(item => item[textField].toLowerCase().includes(lowerCaseSearchTerm));
        const sortedData = [...filteredData].sort((a, b) => a[textField].localeCompare(b[textField]));

        if (sortedData.length === 0) {
            optionsContainer.innerHTML = `<div class="option" style="cursor:default;">No results found</div>`;
            return;
        }

        optionsContainer.innerHTML = sortedData.map(item => `
            <div class="option" data-value="${item[valueField]}" data-text="${item[textField]}">
                <img src="../icons/${item[iconField] || 'FA'}.webp" class="option-icon" onerror="this.style.display='none'" loading="lazy">
                <span>${item[textField]}</span>
            </div>
        `).join('');
    }

    /**
     * Renders the selection inputs based on the comparison type.
     */
    function renderSelectors(type) {
        currentComparisonType = type;
        resultsContainer.classList.remove('visible');
        compareBtn.disabled = true;

        const selectorsHTML = `
            <div class="selectors-grid">
                <div class="selector-box">
                    <label for="input-1">${type === 'players' ? 'Player 1' : 'Team 1'}</label>
                    <input type="text" id="input-1" placeholder="Search by name..." autocomplete="off">
                    <div class="options-container" id="options-1"></div>
                </div>
                <div class="vs-separator">VS</div>
                <div class="selector-box">
                    <label for="input-2">${type === 'players' ? 'Player 2' : 'Team 2'}</label>
                    <input type="text" id="input-2" placeholder="Search by name..." autocomplete="off">
                    <div class="options-container" id="options-2"></div>
                </div>
            </div>
        `;

        selectorsContainer.innerHTML = selectorsHTML;
        compareBtnContainer.style.display = 'block';

        setupCustomSelect(1);
        setupCustomSelect(2);
    }

    /**
     * Sets up event listeners for a single custom select component.
     */
    function setupCustomSelect(index) {
        const input = document.getElementById(`input-${index}`);
        const optionsContainer = document.getElementById(`options-${index}`);

        input.addEventListener('focus', () => {
            populateDropdown(index, input.value);
            optionsContainer.classList.add('visible');
        });

        input.addEventListener('input', () => {
            input.dataset.selectedValue = '';
            checkSelections();
            populateDropdown(index, input.value);
            optionsContainer.classList.add('visible');
        });

        optionsContainer.addEventListener('mousedown', (e) => {
            const option = e.target.closest('.option');
            if (option && option.dataset.value) {
                input.value = option.dataset.text;
                input.dataset.selectedValue = option.dataset.value;
                optionsContainer.classList.remove('visible');
                checkSelections();
            }
        });
    }

    // Hide dropdowns when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.selector-box')) {
            document.getElementById('options-1')?.classList.remove('visible');
            document.getElementById('options-2')?.classList.remove('visible');
        }
    });

    /**
     * Checks if two different entities are selected to enable the compare button.
     */
    function checkSelections() {
        const val1 = document.getElementById('input-1')?.dataset.selectedValue;
        const val2 = document.getElementById('input-2')?.dataset.selectedValue;
        compareBtn.disabled = !(val1 && val2 && val1 !== val2);
        if(!compareBtn.disabled) resultsContainer.classList.remove('visible');
    }

    /**
     * Displays the comparison results in a grid format.
     */
    function displayComparison() {
        const val1 = document.getElementById('input-1').dataset.selectedValue;
        const val2 = document.getElementById('input-2').dataset.selectedValue;

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
                { label: 'tREL', field: 'tREL', higherIsBetter: true, format: (v) => v ? parseFloat(v).toFixed(3) : '-' },
                { label: 'Median Starter Rank', field: 'med_starter_rank', higherIsBetter: false, format: (v) => v > 0 ? Math.round(v) : '-' },
            ];

        const metricRowsHTML = metrics.map(metric => {
            let metricVal1, metricVal2;
            let displayVal1, displayVal2;

            if (metric.field === 'wins') {
                metricVal1 = data1.wpct || 0;
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
                } else {
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
                            <img src="${icon1_src}" class="entity-icon" onerror="this.onerror=null; this.src='../icons/FA.webp'" loading="lazy">
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
                            <img src="${icon2_src}" class="entity-icon" onerror="this.onerror=null; this.src='../icons/FA.webp'" loading="lazy">
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
        selectorsContainer.innerHTML = `<div class="loading">Loading data from Firestore...</div>`;

        try {
            let activeSeasonId;

            // If season is specified via URL parameter, use it
            if (urlSeasonId) {
                activeSeasonId = urlSeasonId;
            } else {
                // Otherwise query for the active season
                const seasonsQuery = query(collection(db, collectionNames.seasons), where("status", "==", "active"), limit(1));
                const seasonsSnap = await getDocs(seasonsQuery);
                if (seasonsSnap.empty) {
                    throw new Error("An active season could not be found.");
                }
                activeSeasonId = seasonsSnap.docs[0].id;
            }

            // ✅ OPTIMIZED: Filter for ACTIVE players at database level instead of client-side
            const conferences = getConferenceNames();
            const [
                playersSnap,
                teamsSnap,
                seasonalStatsSnap,
                seasonalRecordsSnap
            ] = await Promise.all([
                getDocs(query(collection(db, collectionNames.players), where("player_status", "==", "ACTIVE"))),
                getDocs(query(collection(db, collectionNames.teams), where("conference", "in", [conferences.primary, conferences.secondary]))),
                getDocs(collectionGroup(db, collectionNames.seasonalStats)),
                getDocs(collectionGroup(db, collectionNames.seasonalRecords))
            ]);

            const seasonalStatsMap = new Map();
            seasonalStatsSnap.forEach(doc => {
                const pathParts = doc.ref.path.split('/');
                if (pathParts.includes(activeSeasonId)) {
                    const playerId = pathParts[pathParts.length - 3];
                    seasonalStatsMap.set(playerId, doc.data());
                }
            });

            allPlayersData = playersSnap.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(player => seasonalStatsMap.has(player.id)) // Already filtered for ACTIVE at DB level
                .map(player => ({...player, ...seasonalStatsMap.get(player.id)}));

            const seasonalRecordsMap = new Map();
            seasonalRecordsSnap.forEach(doc => {
                const pathParts = doc.ref.path.split('/');
                if (pathParts.includes(activeSeasonId)) {
                    const teamId = pathParts[pathParts.length - 3];
                    seasonalRecordsMap.set(teamId, doc.data());
                }
            });

            allTeamsData = teamsSnap.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(team => seasonalRecordsMap.has(team.id))
                .map(team => ({...team, ...seasonalRecordsMap.get(team.id), team_id: team.id }));

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

    // Reload data when league changes
    window.addEventListener('leagueChanged', async (event) => {
        const newLeague = event.detail.league;
        console.log('[Compare] League changed to:', newLeague);

        // Hide content during transition
        const mainElement = document.querySelector('main');
        if (mainElement) mainElement.style.opacity = '0';

        // Small delay before reloading to ensure fade-out completes
        setTimeout(async () => {
            // Reinitialize the app with new league data
            await initializeApp();

            // Show content after reload
            setTimeout(() => {
                if (mainElement) mainElement.style.opacity = '1';
            }, 100);
        }, 150);
    });
});
