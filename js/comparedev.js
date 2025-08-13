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
            // --- NEW: Added tREL stat to the comparison ---
            { label: 'tREL', field: 'tREL', higherIsBetter: true, format: (v) => v ? parseFloat(v).toFixed(3) : '-' },
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