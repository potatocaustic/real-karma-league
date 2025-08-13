// /js/compare.js

document.addEventListener('DOMContentLoaded', () => {
    // --- Global State ---
    const SHEET_ID = '12EembQnztbdKx2-buv00--VDkEFSTuSXTRdOnTnRxq4';
    const BASE_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=`;

    let allPlayersData = [];
    let allTeamsData = [];
    let allLineupsData = [];
    let allWeeklyAverages = [];
    let currentComparisonType = 'players'; // 'players' or 'teams'

    // --- DOM Elements ---
    const selectorsContainer = document.getElementById('selectors-container');
    const compareBtnContainer = document.querySelector('.compare-btn-container');
    const compareBtn = document.getElementById('compare-btn');
    const resultsContainer = document.getElementById('results-container');
    const selectPlayersBtn = document.getElementById('select-players-btn');
    const selectTeamsBtn = document.getElementById('select-teams-btn');

    // --- Data Fetching & Parsing ---
    
    /**
     * Fetches and parses CSV data from a Google Sheet.
     * @param {string} sheetName The name of the sheet to fetch.
     * @returns {Promise<Array<Object>|null>} A promise that resolves to an array of objects representing the sheet data.
     */
    async function fetchSheetData(sheetName) {
        try {
            const response = await fetch(BASE_URL + encodeURIComponent(sheetName));
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const csvText = await response.text();
            return parseCSV(csvText);
        } catch (error) {
            console.error(`Error fetching sheet "${sheetName}":`, error);
            selectorsContainer.innerHTML = `<div class="error">Failed to load critical data from sheet: ${sheetName}. Please try again later.</div>`;
            return null;
        }
    }

    /**
     * Parses a CSV string into an array of objects, handling quoted fields.
     * @param {string} csvText The CSV string to parse.
     * @returns {Array<Object>} The parsed data.
     */
    function parseCSV(csvText) {
        const lines = csvText.trim().split('\n');
        const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
        const data = [];

        for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            
            if (values.length === headers.length) {
                const row = {};
                headers.forEach((header, index) => {
                    let value = (values[index] || '').trim();
                    if (value.startsWith('"') && value.endsWith('"')) {
                        value = value.slice(1, -1);
                    }
                    row[header] = value;
                });
                data.push(row);
            }
        }
        return data;
    }


    /**
     * Parses a string into a number, handling commas and percentage signs.
     * @param {*} value The value to parse.
     * @returns {number} The parsed number, or 0 if invalid.
     */
    function parseNumber(value) {
        if (value === null || typeof value === 'undefined' || String(value).trim() === '') return 0;
        const cleaned = String(value).replace(/,/g, '').replace(/%/g, '');
        const parsed = parseFloat(cleaned);
        return isNaN(parsed) ? 0 : parsed;
    }


    // --- Data Processing ---
    
    /**
     * Calculates advanced statistics for all players.
     * @param {Array<Object>} players - Raw player data.
     * @param {Array<Object>} weeklyAverages - Data for weekly average scores.
     * @param {Array<Object>} lineups - All lineup data for the season.
     * @returns {Array<Object>} The players array with added calculated stats.
     */
    function calculateAllPlayerStats(players, weeklyAverages, lineups) {
        const weeklyAveragesMap = {};
        (weeklyAverages || []).forEach(week => {
            if (week.date) {
                weeklyAveragesMap[week.date] = {
                    mean_score: parseNumber(week.mean_score),
                    median_score: parseNumber(week.median_score)
                };
            }
        });

        return (players || []).map(player => {
            const playerGames = (lineups || []).filter(lineup =>
                lineup.player_handle === player.player_handle &&
                String(lineup.started).toUpperCase() === 'TRUE'
            );

            let totalPlayerKarmaRawForREL = 0;
            let totalMedianKarma = 0;
            let validGamesForREL = 0;
            const ranks = [];
            let gamesAboveMedian = 0;
            let t100_finishes = 0;

            playerGames.forEach(game => {
                const gameDate = game.date;
                const playerKarmaRaw = parseNumber(game.points_raw);
                const globalRank = parseNumber(game.global_rank);

                if (weeklyAveragesMap[gameDate]) {
                    totalPlayerKarmaRawForREL += playerKarmaRaw;
                    totalMedianKarma += weeklyAveragesMap[gameDate].median_score;
                    validGamesForREL++;
                    if (playerKarmaRaw > weeklyAveragesMap[gameDate].median_score) {
                        gamesAboveMedian++;
                    }
                }
                if (globalRank > 0) {
                    ranks.push(globalRank);
                    if (globalRank <= 100) {
                        t100_finishes++;
                    }
                }
            });

            const avgPlayerRawKarmaForREL = validGamesForREL > 0 ? totalPlayerKarmaRawForREL / validGamesForREL : 0;
            const avgMedianKarma = validGamesForREL > 0 ? totalMedianKarma / validGamesForREL : 0;

            const calculated_rel_median = avgMedianKarma > 0 ? (avgPlayerRawKarmaForREL / avgMedianKarma) : 0;

            let calculated_median_rank = Infinity;
            if (ranks.length > 0) {
                ranks.sort((a, b) => a - b);
                const mid = Math.floor(ranks.length / 2);
                calculated_median_rank = ranks.length % 2 === 0 ? (ranks[mid - 1] + ranks[mid]) / 2 : ranks[mid];
            }

            return {
                ...player,
                calculated_rel_median: calculated_rel_median,
                calculated_median_rank: calculated_median_rank,
                aag_median: gamesAboveMedian,
                t100_finishes: t100_finishes,
                games_played: parseNumber(player.games_played),
                WAR: parseNumber(player.WAR),
                GEM: parseNumber(player.GEM),
                rookie: player.rookie,
                all_star: player.all_star
            };
        });
    }

    // --- UI Rendering ---

    /**
     * Renders the selection dropdowns based on the comparison type.
     * @param {string} type - 'players' or 'teams'.
     */
    function renderSelectors(type) {
        currentComparisonType = type;
        resultsContainer.classList.remove('visible');
        compareBtn.disabled = true;

        const data = type === 'players' ? allPlayersData : allTeamsData;
        const valueField = type === 'players' ? 'player_handle' : 'team_id';
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

        const data1 = (currentComparisonType === 'players' ? allPlayersData : allTeamsData).find(d => d[currentComparisonType === 'players' ? 'player_handle' : 'team_id'] === val1);
        const data2 = (currentComparisonType === 'players' ? allPlayersData : allTeamsData).find(d => d[currentComparisonType === 'players' ? 'player_handle' : 'team_id'] === val2);

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
        
        const icon1_src = `icons/${icon1_id || 'FA'}.webp`;
        const icon2_src = `icons/${icon2_id || 'FA'}.webp`;

        const link1 = currentComparisonType === 'players' ? `player.html?player=${encodeURIComponent(data1.player_handle)}` : `team.html?id=${data1.team_id}`;
        const link2 = currentComparisonType === 'players' ? `player.html?player=${encodeURIComponent(data2.player_handle)}` : `team.html?id=${data2.team_id}`;

        const metrics = currentComparisonType === 'players' ? 
            [
                { label: 'Games Played', field: 'games_played', higherIsBetter: true, format: (v) => v },
                { label: 'REL Median', field: 'calculated_rel_median', higherIsBetter: true, format: (v) => v.toFixed(3) },
                { label: 'WAR', field: 'WAR', higherIsBetter: true, format: (v) => v.toFixed(2) },
                { label: 'GEM', field: 'GEM', higherIsBetter: false, format: (v) => v > 0 ? v.toFixed(1) : '-' },
                { label: 'Median Gameday Rank', field: 'calculated_median_rank', higherIsBetter: false, format: (v) => v === Infinity ? '-' : Math.round(v) },
                { label: 'Games Above Median', field: 'aag_median', higherIsBetter: true, format: (v) => v },
                { label: 'T100 Finishes', field: 't100_finishes', higherIsBetter: true, format: (v) => v }
            ] : 
            [
                { label: 'Record', field: 'wins', higherIsBetter: true, format: (v, d) => `${d.wins}-${d.losses}` },
                { label: 'PAM', field: 'pam', higherIsBetter: true, format: (v) => Math.round(v).toLocaleString() },
                { label: 'apPAM', field: 'apPAM', higherIsBetter: true, format: (val) => val ? val : '-' },
                { label: 'Median Starter Rank', field: 'med_starter_rank', higherIsBetter: false, format: (v) => v > 0 ? Math.round(v) : '-' },
                { label: 'tREL', field: 'tREL', higherIsBetter: true, format: (v) => v ? parseFloat(v).toFixed(3) : '-' }
            ];

        const metricRowsHTML = metrics.map(metric => {
            let metricVal1, metricVal2;
            let displayVal1, displayVal2;

            if (metric.field === 'wins') {
                const totalGames1 = parseNumber(data1.wins) + parseNumber(data1.losses);
                const totalGames2 = parseNumber(data2.wins) + parseNumber(data2.losses);
                metricVal1 = totalGames1 > 0 ? parseNumber(data1.wins) / totalGames1 : 0;
                metricVal2 = totalGames2 > 0 ? parseNumber(data2.wins) / totalGames2 : 0;
                displayVal1 = metric.format(null, data1);
                displayVal2 = metric.format(null, data2);
            } else {
                metricVal1 = parseNumber(data1[metric.field]);
                metricVal2 = parseNumber(data2[metric.field]);
                displayVal1 = metric.format(data1[metric.field], data1);
                displayVal2 = metric.format(data2[metric.field], data2);
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
                            <img src="${icon1_src}" class="entity-icon" onerror="this.onerror=null; this.src='icons/FA.webp'">
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
                            <img src="${icon2_src}" class="entity-icon" onerror="this.onerror=null; this.src='icons/FA.webp'">
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


    // --- Initialization and Event Handling ---
    
    /**
     * Initializes the entire page, fetches data, and sets up event listeners.
     */
    async function initializeApp() {
        const [players, teams, lineups, weeklyAverages] = await Promise.all([
            fetchSheetData('Players'),
            fetchSheetData('Teams'),
            fetchSheetData('Lineups'),
            fetchSheetData('Weekly_Averages')
        ]);

        if (!players || !teams || !lineups || !weeklyAverages) {
            return;
        }
        
        allPlayersData = calculateAllPlayerStats(players, weeklyAverages, lineups)
            .filter(p => p.player_status === 'ACTIVE');
        
        allTeamsData = teams.filter(t => t.team_id && t.conference && t.team_id.toUpperCase() !== 'FA' && t.team_id.toUpperCase() !== 'RETIRED');

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
    }

    initializeApp();
});