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
    // ... (fetchSheetData, parseCSV, and parseNumber functions remain the same) ...
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
    function parseNumber(value) {
        if (value === null || typeof value === 'undefined' || String(value).trim() === '') return 0;
        const cleaned = String(value).replace(/,/g, '').replace(/%/g, '');
        const parsed = parseFloat(cleaned);
        return isNaN(parsed) ? 0 : parsed;
    }


    // --- Data Processing ---
    // ... (calculateAllPlayerStats function remains the same) ...
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
     * MODIFICATION: Populates the custom dropdown with filtered options.
     */
    function populateDropdown(index, searchTerm = '') {
        const optionsContainer = document.getElementById(`options-${index}`);
        const lowerCaseSearchTerm = searchTerm.toLowerCase();

        const data = currentComparisonType === 'players' ? allPlayersData : allTeamsData;
        const valueField = currentComparisonType === 'players' ? 'player_handle' : 'team_id';
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
                <img src="icons/${item[iconField] || 'FA'}.webp" class="option-icon" onerror="this.style.display='none'">
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
     * MODIFICATION: Sets up event listeners for a single custom select component.
     */
    function setupCustomSelect(index) {
        const input = document.getElementById(`input-${index}`);
        const optionsContainer = document.getElementById(`options-${index}`);

        input.addEventListener('focus', () => {
            populateDropdown(index, input.value);
            optionsContainer.classList.add('visible');
        });

        input.addEventListener('input', () => {
            // Clear selected value if user types
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

        const data = currentComparisonType === 'players' ? allPlayersData : allTeamsData;
        const valueField = currentComparisonType === 'players' ? 'player_handle' : 'team_id';

        const data1 = data.find(d => d[valueField] === val1);
        const data2 = data.find(d => d[valueField] === val2);
        
        // ... (The rest of the displayComparison function remains the same) ...
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
