// /admin/manage-reports.js

import { auth, db, functions, onAuthStateChanged, signOut, doc, getDoc, httpsCallable, collection, query, where, getDocs, getCurrentLeague, getShortConferenceNames } from '/js/firebase-init.js';

const USE_DEV_COLLECTIONS = false;
const getCollectionName = (baseName) => USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;

document.addEventListener('DOMContentLoaded', () => {
    const loadingContainer = document.getElementById('loading-container');
    const adminContainer = document.getElementById('admin-container');
    const authStatusDiv = document.getElementById('auth-status');
    const reportOutputContainer = document.getElementById('report-output-container');
    const reportOutputEl = document.getElementById('report-output');

    let currentReportType = null;

    let activeSeasonId = null;

    onAuthStateChanged(auth, async (user) => {
        if (user) {
            const userRef = doc(db, getCollectionName("users"), user.uid);
            const userDoc = await getDoc(userRef);

            if (userDoc.exists() && (userDoc.data().role === 'admin' || userDoc.data().role === 'scorekeeper')) {
                const activeSeasonQuery = query(collection(db, getCollectionName("seasons")), where("status", "==", "active"));
                const activeSeasonSnap = await getDocs(activeSeasonQuery);
                if (!activeSeasonSnap.empty) {
                    activeSeasonId = activeSeasonSnap.docs[0].id;
                } else {
                    handleError("Could not determine active season.");
                    return;
                }

                loadingContainer.style.display = 'none';
                adminContainer.style.display = 'block';
                authStatusDiv.innerHTML = `Welcome! | <a href="#" id="logout-btn">Logout</a>`;
                addLogoutListener();
                initializeReportButtons();
                setupReportPreviews();

                // Listen for league changes and reload the active season
                window.addEventListener('leagueChanged', async (event) => {
                    console.log('League changed to:', event.detail.league);
                    // Reload active season for the new league
                    const activeSeasonQuery = query(collection(db, getCollectionName("seasons")), where("status", "==", "active"));
                    const activeSeasonSnap = await getDocs(activeSeasonQuery);
                    if (!activeSeasonSnap.empty) {
                        activeSeasonId = activeSeasonSnap.docs[0].id;
                        console.log('Active season updated to:', activeSeasonId);
                    }
                    // Refresh the deadline time for the new league
                    autoPopulateDeadlineTime();
                });
            } else {
                displayAccessDenied(authStatusDiv);
            }
        } else {
            window.location.href = '/login.html?target=admin';
        }
    });

    function initializeReportButtons() {
        const today = new Date().toISOString().split('T')[0];
        document.getElementById('deadline-date').value = today;
        document.getElementById('gotd-date').value = today;

        // Add event listener to auto-populate deadline time when date changes
        document.getElementById('deadline-date').addEventListener('change', autoPopulateDeadlineTime);

        addGenerateHandler('generate-deadline-report', generateDeadlineReport);
        addGenerateHandler('generate-gotd-report', generateVoteGotdReport);
        addGenerateHandler('generate-lineups-report', prepareLineupsReport);
        document.getElementById('copy-report-btn').addEventListener('click', copyReportToClipboard);

        // Auto-populate deadline time for today on page load
        autoPopulateDeadlineTime();
    }

    function setupReportPreviews() {
        const previewButtons = document.querySelectorAll('[data-report-toggle]');
        previewButtons.forEach(button => {
            const targetKey = button.dataset.reportToggle;
            const body = document.querySelector(`[data-report-body="${targetKey}"]`);

            if (!body) return;

            button.addEventListener('click', () => {
                const isOpen = button.classList.toggle('open');
                body.hidden = !isOpen;
                body.classList.toggle('open', isOpen);
                button.setAttribute('aria-expanded', String(isOpen));
            });
        });
    }

    function addGenerateHandler(buttonId, handler) {
        const button = document.getElementById(buttonId);
        if (!button) return;

        button.dataset.defaultText = button.textContent;
        button.addEventListener('click', async () => {
            setButtonLoadingState(button, true);
            try {
                await handler();
            } finally {
                setButtonLoadingState(button, false);
            }
        });
    }

    function setButtonLoadingState(button, isLoading) {
        if (!button) return;
        button.disabled = isLoading;
        button.textContent = isLoading ? 'Generating...' : (button.dataset.defaultText || 'Generate Report');
    }

    async function autoPopulateDeadlineTime() {
        const dateInput = document.getElementById('deadline-date').value;
        const timeInput = document.getElementById('deadline-time');

        if (!dateInput) {
            timeInput.value = '';
            return;
        }

        try {
            // Convert YYYY-MM-DD to the format used in Firestore
            const dateString = dateInput; // Already in YYYY-MM-DD format

            // Get league-specific collection name
            const league = getCurrentLeague();
            const collectionName = league === 'minor' ? 'minor_lineup_deadlines' : 'lineup_deadlines';

            const deadlineRef = doc(db, collectionName, dateString);
            const deadlineSnap = await getDoc(deadlineRef);

            if (deadlineSnap.exists()) {
                const data = deadlineSnap.data();
                const deadline = data.deadline.toDate();

                // Convert from Central Time to Eastern Time (add 1 hour)
                const easternDeadline = new Date(deadline.getTime() + (60 * 60 * 1000));

                // Format time as "12:05p ET" format
                let hours = easternDeadline.getHours();
                const minutes = String(easternDeadline.getMinutes()).padStart(2, '0');
                const ampm = hours >= 12 ? 'p' : 'a';
                hours = hours % 12 || 12; // Convert to 12-hour format

                const formattedTime = `${hours}:${minutes}${ampm} ET`;
                timeInput.value = formattedTime;
            } else {
                // No deadline set for this date
                timeInput.value = '';
                timeInput.placeholder = 'No deadline set for this date';
            }
        } catch (error) {
            console.error("Error fetching deadline:", error);
            timeInput.value = '';
            timeInput.placeholder = 'Error fetching deadline';
        }
    }
    
    async function callGetReportData(reportType, options = {}) {
        try {
            // Note: We're assuming the 'getReportData' cloud function in index.js
            // has been updated to return the necessary extra fields like team seeds,
            // series info, and game types, as the backend file was not provided.
            const getReportData = httpsCallable(functions, 'getReportData');
            const result = await getReportData({ reportType, seasonId: activeSeasonId, ...options, league: getCurrentLeague() });
            if (result.data.success) {
                return result.data;
            } else {
                throw new Error(result.data.message || 'The cloud function reported an error.');
            }
        } catch (error) {
            console.error(`Error fetching data for ${reportType} report:`, error);
            alert(`Could not generate report: ${error.message}`);
            return null;
        }
    }

    function getDayColorDot(date) {
        // Color mapping for days of the week
        const dayColors = {
            0: '🔴', // Sunday - Red
            1: '🟡', // Monday - Yellow
            2: '🟤', // Tuesday - Brown
            3: '🟢', // Wednesday - Green
            4: '🟠', // Thursday - Orange
            5: '🔵', // Friday - Blue
            6: '🟣'  // Saturday - Purple
        };

        const dayOfWeek = date.getDay();
        return dayColors[dayOfWeek] || '';
    }

    async function generateDeadlineReport() {
        const dateInput = document.getElementById('deadline-date').value;
        const timeInput = document.getElementById('deadline-time').value;

        if (!dateInput || !timeInput) {
            alert("Please provide both a date and a deadline time.");
            return;
        }

        const date = new Date(dateInput + 'T00:00:00');
        const formattedDate = date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
        const firestoreDate = `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;

        // Get the colored dot for the day of the week
        const colorDot = getDayColorDot(date);

        const data = await callGetReportData('deadline', { date: firestoreDate });

        if (data && data.games && data.games.length > 0) {
            const dashes = '—'.repeat(12);
            // 1b & 1c: Check for seeds and format accordingly
            const gameLines = data.games.map(g => {
                const team1Name = g.team1_seed ? `(${g.team1_seed}) ${g.team1_name}` : g.team1_name;
                const team2Name = g.team2_seed ? `(${g.team2_seed}) ${g.team2_name}` : g.team2_name;
                return `${team1Name} vs ${team2Name}`;
            }).join('\n');

            // 1a: Update final verbiage and link
            const league = getCurrentLeague();
            const recipient = league === 'minor' ? '@det' : 'me';
            const finalVerbiage = `Submit your lineup to ${recipient} OR through the website by ${timeInput} https://www.realkarmaleague.com/gm/dashboard.html?league=${league}`;

            // Add the colored dot before the day name
            const output = `${colorDot} ${formattedDate}\n${dashes}\n${gameLines}\n${dashes}\n${finalVerbiage}`;
            displayReport(output, { reportType: 'deadline' });
        } else {
             displayReport(`${colorDot} No games found for ${formattedDate}.`, { reportType: 'deadline' });
        }
    }

    async function generateVoteGotdReport() {
        const dateInput = document.getElementById('gotd-date').value;
        if (!dateInput) {
            alert("Please provide a date.");
            return;
        }
        const date = new Date(dateInput + 'T00:00:00');
        const firestoreDate = `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;

        const data = await callGetReportData('voteGOTD', { date: firestoreDate });

        if (data && data.games && data.games.length > 0) {
            const reportContainer = document.createDocumentFragment();

            const headerTitle = `Vote GOTD ${firestoreDate}`;
            const header = buildReportHeader(headerTitle, {
                copyLabel: 'Copy header'
            });
            reportContainer.appendChild(header);

            data.games.forEach(g => {
                const gameText = `${g.team1_name} (${g.team1_record}) vs ${g.team2_name} (${g.team2_record})`;
                
                const gameContainer = document.createElement('div');
                gameContainer.className = 'report-item';
                
                const textSpan = document.createElement('span');
                textSpan.className = 'report-item-text';
                textSpan.textContent = gameText;

                const copyIcon = createCopyButton(() => gameText, { label: 'Copy game' });

                gameContainer.appendChild(textSpan);
                gameContainer.appendChild(copyIcon);
                reportContainer.appendChild(gameContainer);
            });

            displayReport(reportContainer, { reportType: 'gotd' });
        } else {
            displayReport(`No games found for ${firestoreDate}.`, { reportType: 'gotd' });
        }
    }

    async function prepareLineupsReport() {
        const data = await callGetReportData('lineups_prepare');
        if (data && data.games && data.games.length > 0) {
            // 2a: Check if there are any regular season games. If not, skip GOTD selection.
            const regularSeasonGames = data.games.filter(game => game.collectionName === getCollectionName('games'));
            const hasRegularSeasonGames = regularSeasonGames.length > 0;

            if (!hasRegularSeasonGames) {
                generateLineupsReport(data.games, true); // Pass true to indicate no GOTD
                return;
            }

            const container = document.getElementById('gotd-selector-container');
            const list = document.getElementById('gotd-game-list');
            list.innerHTML = '';
            list.style.display = 'block';

            // Only show regular season games in GOTD selector
            regularSeasonGames.forEach(game => {
                const gameOption = document.createElement('div');
                gameOption.className = 'gotd-game-option';
                gameOption.textContent = `${game.team1_name} vs ${game.team2_name}`;
                gameOption.dataset.gameId = game.gameId;

                Object.assign(gameOption.style, {
                    padding: '10px', margin: '5px 0', border: '1px solid #555',
                    borderRadius: '5px', cursor: 'pointer', transition: 'background-color 0.2s, border-color 0.2s'
                });

                gameOption.addEventListener('click', () => {
                    document.querySelectorAll('.gotd-game-option').forEach(opt => {
                        opt.classList.remove('selected');
                        opt.style.backgroundColor = '';
                        opt.style.borderColor = '#555';
                    });
                    gameOption.classList.add('selected');
                    gameOption.style.backgroundColor = '#004a7c';
                    gameOption.style.borderColor = '#007bff';
                });
                list.appendChild(gameOption);
            });
            
            const submitButton = document.createElement('button');
            submitButton.textContent = 'Confirm GOTD & Generate';
            submitButton.className = 'btn-admin-edit';
            submitButton.style.marginTop = '15px';
            submitButton.onclick = () => generateLineupsReport(data.games, false);
            list.appendChild(submitButton);

            container.style.display = 'block';
        } else {
            alert('No active live games found for today. Cannot generate lineups report.');
        }
    }

    function getPostseasonGameLabel(seriesName) {
        if (!seriesName) return seriesName;

        const gameNumberMatch = seriesName.match(/Game \d+$/);
        const gameNumberString = gameNumberMatch ? gameNumberMatch[0] : '';
        const baseSeriesId = seriesName.replace(/ Game \d+$/, '').trim();

        // Get conference names dynamically based on league type
        const shortConferences = getShortConferenceNames();
        const primaryConf = shortConferences.primary; // North for minor, East for major
        const secondaryConf = shortConferences.secondary; // South for minor, West for major

        const seriesTypeMap = {
            'W7vW8': `${secondaryConf} Play-In Stage 1`, 'E7vE8': `${primaryConf} Play-In Stage 1`,
            'W9vW10': `${secondaryConf} Play-In Stage 1`, 'E9vE10': `${primaryConf} Play-In Stage 1`,
            'W8thSeedGame': `${secondaryConf} Play-In Stage 2`, 'E8thSeedGame': `${primaryConf} Play-In Stage 2`,
            'W1vW8': `${secondaryConf} Round 1 - ${gameNumberString}`, 'W4vW5': `${secondaryConf} Round 1 - ${gameNumberString}`,
            'W3vW6': `${secondaryConf} Round 1 - ${gameNumberString}`, 'W2vW7': `${secondaryConf} Round 1 - ${gameNumberString}`,
            'E1vE8': `${primaryConf} Round 1 - ${gameNumberString}`, 'E4vE5': `${primaryConf} Round 1 - ${gameNumberString}`,
            'E3vE6': `${primaryConf} Round 1 - ${gameNumberString}`, 'E2vE7': `${primaryConf} Round 1 - ${gameNumberString}`,
            'W-R2-T': `${secondaryConf} Round 2 - ${gameNumberString}`, 'W-R2-B': `${secondaryConf} Round 2 - ${gameNumberString}`,
            'E-R2-T': `${primaryConf} Round 2 - ${gameNumberString}`, 'E-R2-B': `${primaryConf} Round 2 - ${gameNumberString}`,
            'WCF': `${secondaryConf}CF ${gameNumberString}`, 'ECF': `${primaryConf}CF ${gameNumberString}`,
            'Finals': `RKL Finals ${gameNumberString}`,
        };
        const label = seriesTypeMap[baseSeriesId];
        return label ? label.trim() : seriesName;
    }

    function generateLineupsReport(gamesData, isNoGotd) {
        const selectedGame = document.querySelector('.gotd-game-option.selected');
        // If there's a GOTD, we need one to be selected
        if (!isNoGotd && !selectedGame) {
            alert("Please select a Game of the Day.");
            return;
        }
        
        const gotdId = isNoGotd ? null : selectedGame.dataset.gameId;
        const today = new Date();
        const formattedDate = `${today.getMonth() + 1}/${today.getDate()}`;
        
        const reportContainer = document.createDocumentFragment();
        const headerTitle = `Lineups ${formattedDate}`;
        const header = buildReportHeader(headerTitle, {
            copyLabel: 'Copy header'
        });
        reportContainer.appendChild(header);

        const captainEmojis = { 'Penguins': ' 🐧', 'Hornets': ' 🐝', 'Vipers': ' 🐍', 'MLB': ' 👼', 'Aces': ' ♠️', 'Otters': ' 🦦', 'Empire': ' 💤', 'Demons': ' 😈', 'Hounds': ' 🐶', 'Kings': ' 👑', 'Donuts': ' 🍩', 'Tacos': ' 🌮', 'Flames': ' 🔥', 'Fruit': ' 🍑', 'Goats': ' 🐐', 'Eggheads': ' 🥚', 'Crows': ' 🐦‍⬛', 'Wizards': ' 🧙‍♂️', 'Knights': ' 🤺', 'Rams': ' 🐏', 'Horses': ' 🐴' };
        const usa_diabetics = ['PJPB7G3y', 'QvDP2zgv', 'k3LgQL4v', 'rnejGZ2J', 'V3yAQ6Y3', 'Anzoj9LJ', 'BJ0VQoY3', 'wJpX8ALJ', 'kJw08M1v', 'R3XWePMv'];
        const can_diabetics = ['BJ0r9gL3', 'AnzRoOpn', 'kJwL5b8v', 'jvbLzKrn'];

        const formatPlayerLine = (player, teamName) => {
            let line = '';
            if (teamName === 'Diabetics') {
                if (usa_diabetics.includes(player.player_id)) line += '🇺🇸 ';
                else if (can_diabetics.includes(player.player_id)) line += '🇨🇦 ';
            }
            line += `@${player.player_handle}`;
            if (player.is_captain) {
                // 2c: Diabetics captain emoji rule
                if (teamName === 'Diabetics') {
                    line += ' 👑';
                } else {
                    line += captainEmojis[teamName] || ' (c)';
                }
            }
            return line;
        };

        let gotdGameBlock = null;

        gamesData.forEach(game => {
            let gameBlockText = '';
            const isGotd = game.gameId === gotdId;

            // 2c: Freaks special font rule
            const team1Name = game.team1_name === 'Freaks' ? '𝓕𝓻𝓮𝓪𝓴𝓼' : game.team1_name;
            const team2Name = game.team2_name === 'Freaks' ? '𝓕𝓻𝓮𝓪𝓴𝓼' : game.team2_name;

            // Sort lineups to put captain first
            const sortedTeam1Lineup = [...game.team1_lineup].sort((a, b) => {
                if (a.is_captain && !b.is_captain) return -1;
                if (!a.is_captain && b.is_captain) return 1;
                return 0;
            });
            const sortedTeam2Lineup = [...game.team2_lineup].sort((a, b) => {
                if (a.is_captain && !b.is_captain) return -1;
                if (!a.is_captain && b.is_captain) return 1;
                return 0;
            });

            const team1Lineup = sortedTeam1Lineup.map(p => formatPlayerLine(p, game.team1_name)).join('\n ');
            const team2Lineup = sortedTeam2Lineup.map(p => formatPlayerLine(p, game.team2_name)).join('\n ');

            // 2b: Check for postseason game and format accordingly
            if (game.collectionName === getCollectionName('post_games')) {
                const seriesLabel = getPostseasonGameLabel(game.series_name);
                const separator = '~'.repeat(14);
                const team1Record = `(${game.team1_wins || 0}-${game.team2_wins || 0})`;
                const team2Record = `(${game.team2_wins || 0}-${game.team1_wins || 0})`;
                gameBlockText = `${seriesLabel}\n${separator}\n(${game.team1_seed}) ${team1Name} ${team1Record}\n ${team1Lineup}\n---------- \nvs.\n---------- \n(${game.team2_seed}) ${team2Name} ${team2Record}\n ${team2Lineup}`;
            } else {
                gameBlockText = `${team1Name} (${game.team1_record})\n ${team1Lineup}\n---------- \nvs.\n----------\n${team2Name} (${game.team2_record})\n ${team2Lineup}`;
            }

            // If this is the GOTD, prepend the GOTD header
            if (isGotd) {
                gameBlockText = `💠GOTD ${formattedDate}💠\n~~~~~~~~~~~~\n${gameBlockText}`;
            }

            const gameContainer = document.createElement('div');
            gameContainer.className = 'report-item';

            const textPre = document.createElement('pre');
            textPre.className = 'report-item-text';
            textPre.textContent = gameBlockText;

            const copyIcon = createCopyButton(() => gameBlockText, { label: 'Copy matchup' });

            gameContainer.appendChild(textPre);
            gameContainer.appendChild(copyIcon);

            if (isGotd) {
                gotdGameBlock = gameContainer;
            } else {
                reportContainer.appendChild(gameContainer);
            }
        });

        if (gotdGameBlock) {
            reportContainer.appendChild(gotdGameBlock);
        }

        displayReport(reportContainer, { reportType: 'lineups' });
        document.getElementById('gotd-selector-container').style.display = 'none';
    }

    function displayReport(content, options = {}) {
        reportOutputContainer.style.display = 'block';
        reportOutputEl.innerHTML = ''; // Clear previous content

        if (typeof content === 'string') {
            reportOutputEl.textContent = content;
        } else {
            // Appends a DocumentFragment or a single DOM node
            reportOutputEl.appendChild(content);
        }
        reportOutputEl.scrollTop = 0; // Scroll to top

        currentReportType = options.reportType || null;
        const copyBtn = document.getElementById('copy-report-btn');
        if (copyBtn) {
            const shouldShowCopyBtn = currentReportType === 'deadline';
            copyBtn.style.display = shouldShowCopyBtn ? 'inline-flex' : 'none';
            copyBtn.textContent = 'Copy to Clipboard';
            if (shouldShowCopyBtn) {
                copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span>Copy to Clipboard</span>`;
            }
        }
    }

    function copyReportToClipboard() {
        const reportText = buildReportText();
        const copyBtn = document.getElementById('copy-report-btn');
        const defaultContent = copyBtn ? copyBtn.innerHTML : '';

        navigator.clipboard.writeText(reportText).then(() => {
            if (copyBtn) {
                copyBtn.textContent = 'Copied!';
                copyBtn.classList.add('copied');
                setTimeout(() => {
                    copyBtn.innerHTML = defaultContent || 'Copy to Clipboard';
                    copyBtn.classList.remove('copied');
                }, 1200);
            }
        }).catch(err => {
            if (copyBtn) {
                copyBtn.textContent = 'Copy failed';
                setTimeout(() => {
                    copyBtn.innerHTML = defaultContent || 'Copy to Clipboard';
                }, 1200);
            }
            console.error('Clipboard copy error:', err);
        });
    }

    const headerClipboardIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

    function createCopyButton(getText, { label = 'Copy to clipboard' } = {}) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'copy-icon';
        const defaultContent = headerClipboardIcon;
        button.innerHTML = defaultContent;
        button.title = label;
        button.setAttribute('aria-label', label);

        button.addEventListener('click', () => {
            const text = typeof getText === 'function' ? getText() : '';
            if (!text) return;

            navigator.clipboard.writeText(text).then(() => {
                button.innerHTML = '✅';
                button.classList.add('copied');
                setTimeout(() => {
                    button.innerHTML = defaultContent;
                    button.classList.remove('copied');
                }, 1200);
            }).catch(err => console.error('Failed to copy text: ', err));
        });

        return button;
    }

    function buildReportHeader(title, { copyLabel = 'Copy header', getCopyText } = {}) {
        const header = document.createElement('div');
        header.className = 'report-header';

        const titleSpan = document.createElement('span');
        titleSpan.className = 'report-title';
        titleSpan.textContent = title;

        const copyBtn = createCopyButton(() => {
            if (typeof getCopyText === 'function') {
                return getCopyText(title);
            }
            return title;
        }, { label: copyLabel });
        copyBtn.classList.add('header-copy-btn');

        header.appendChild(titleSpan);
        header.appendChild(copyBtn);
        return header;
    }

    function buildReportText() {
        const segments = [];

        Array.from(reportOutputEl.childNodes).forEach(node => {
            if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent.trim();
                if (text) segments.push(text);
                return;
            }

            if (node.classList && node.classList.contains('report-header')) {
                const title = node.querySelector('.report-title');
                if (title?.textContent) segments.push(title.textContent.trim());
                return;
            }

            if (node.classList && node.classList.contains('report-item')) {
                const text = node.querySelector('.report-item-text');
                if (text?.textContent) segments.push(text.textContent.trim());
                return;
            }

            if (node.textContent) {
                const text = node.textContent.trim();
                if (text) segments.push(text);
            }
        });

        if (!segments.length) {
            const fallback = reportOutputEl.textContent.trim();
            if (fallback) return fallback;
            return '';
        }

        return segments.join('\n\n');
    }

    function displayAccessDenied(authStatusDiv) {
        loadingContainer.innerHTML = '<div class="error">Access Denied. You do not have permission to view this page.</div>';
        authStatusDiv.innerHTML = `Access Denied | <a href="#" id="logout-btn">Logout</a>`;
        addLogoutListener();
    }

    function addLogoutListener() {
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', (e) => {
                e.preventDefault();
                signOut(auth).then(() => {
                    window.location.href = '/login.html?target=admin';
                });
            });
        }
    }
    
    function handleError(message) {
        loadingContainer.innerHTML = `<div class="error">${message}</div>`;
        adminContainer.style.display = 'none';
    }
});
