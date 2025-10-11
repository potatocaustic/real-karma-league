// /admin/manage-reports.js

import { auth, db, functions, onAuthStateChanged, signOut, doc, getDoc, httpsCallable, collection, query, where, getDocs } from '/js/firebase-init.js';

const USE_DEV_COLLECTIONS = false;
const getCollectionName = (baseName) => USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;

document.addEventListener('DOMContentLoaded', () => {
    const loadingContainer = document.getElementById('loading-container');
    const adminContainer = document.getElementById('admin-container');
    const authStatusDiv = document.getElementById('auth-status');
    const reportOutputContainer = document.getElementById('report-output-container');
    const reportOutputEl = document.getElementById('report-output');

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
            } else {
                displayAccessDenied(authStatusDiv);
            }
        } else {
            window.location.href = '/login.html';
        }
    });

    function initializeReportButtons() {
        const today = new Date().toISOString().split('T')[0];
        document.getElementById('deadline-date').value = today;
        document.getElementById('gotd-date').value = today;

        document.getElementById('generate-deadline-report').addEventListener('click', generateDeadlineReport);
        document.getElementById('generate-gotd-report').addEventListener('click', generateVoteGotdReport);
        document.getElementById('generate-lineups-report').addEventListener('click', prepareLineupsReport);
        document.getElementById('copy-report-btn').addEventListener('click', copyReportToClipboard);
    }
    
    async function callGetReportData(reportType, options = {}) {
        try {
            const getReportData = httpsCallable(functions, 'getReportData');
            const result = await getReportData({ reportType, seasonId: activeSeasonId, ...options });
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

        const data = await callGetReportData('deadline', { date: firestoreDate });

        if (data && data.games && data.games.length > 0) {
            const dashes = '—'.repeat(12);
            const gameLines = data.games.map(g => `${g.team1_name} vs ${g.team2_name}`).join('\n');
            const output = `${formattedDate}\n${dashes}\n${gameLines}\n${dashes}\nSend me your lineups by ${timeInput}`;
            displayReport(output);
        } else {
             displayReport(`No games found for ${formattedDate}.`);
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
            
            const titleEl = document.createElement('div');
            titleEl.textContent = `Vote GOTD (${firestoreDate}):`;
            titleEl.style.fontWeight = 'bold';
            titleEl.style.marginBottom = '10px';
            reportContainer.appendChild(titleEl);

            data.games.forEach(g => {
                const gameText = `${g.team1_name} (${g.team1_record}) vs ${g.team2_name} (${g.team2_record})`;
                
                const gameContainer = document.createElement('div');
                gameContainer.className = 'report-item';
                
                const textSpan = document.createElement('span');
                textSpan.className = 'report-item-text';
                textSpan.textContent = gameText;

                const copyIcon = document.createElement('span');
                copyIcon.className = 'copy-icon';
                copyIcon.textContent = '📋';
                copyIcon.title = 'Copy game';
                copyIcon.onclick = () => {
                    navigator.clipboard.writeText(gameText).then(() => {
                        copyIcon.textContent = '✅';
                        setTimeout(() => { copyIcon.textContent = '📋'; }, 1500);
                    }).catch(err => console.error('Failed to copy text: ', err));
                };
                
                gameContainer.appendChild(textSpan);
                gameContainer.appendChild(copyIcon);
                reportContainer.appendChild(gameContainer);
            });

            displayReport(reportContainer);
        } else {
            displayReport(`No games found for ${firestoreDate}.`);
        }
    }

    async function prepareLineupsReport() {
        const data = await callGetReportData('lineups_prepare');
        if (data && data.games && data.games.length > 0) {
            const container = document.getElementById('gotd-selector-container');
            const list = document.getElementById('gotd-game-list');
            list.innerHTML = '';
            list.style.display = 'block';

            data.games.forEach(game => {
                const gameOption = document.createElement('div');
                gameOption.className = 'gotd-game-option';
                gameOption.textContent = `${game.team1_name} vs ${game.team2_name}`;
                gameOption.dataset.gameId = game.gameId;

                Object.assign(gameOption.style, {
                    padding: '10px',
                    margin: '5px 0',
                    border: '1px solid #555',
                    borderRadius: '5px',
                    cursor: 'pointer',
                    transition: 'background-color 0.2s, border-color 0.2s'
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
            submitButton.onclick = () => generateLineupsReport(data.games);
            list.appendChild(submitButton);

            container.style.display = 'block';
        } else {
            alert('No active live games found for today. Cannot generate lineups report.');
        }
    }

    function generateLineupsReport(gamesData) {
        const selectedGame = document.querySelector('.gotd-game-option.selected');
        if (!selectedGame) {
            alert("Please select a Game of the Day.");
            return;
        }
        
        const gotdId = selectedGame.dataset.gameId;
        const today = new Date();
        const formattedDate = `${today.getMonth() + 1}/${today.getDate()}`;
        
        const reportContainer = document.createDocumentFragment();
        const titleEl = document.createElement('div');
        titleEl.textContent = `Lineups ${formattedDate}`;
        titleEl.style.fontWeight = 'bold';
        titleEl.style.marginBottom = '10px';
        reportContainer.appendChild(titleEl);

        const captainEmojis = { 'Hornets': ' 🐝', 'Vipers': ' 🐍', 'MLB': ' 👼', 'Aces': ' ♠️', 'Otters': ' 🦦', 'Empire': ' 💤', 'Demons': ' 😈', 'Hounds': ' 🐶', 'Legion': ' 🥷', 'Kings': ' 👑', 'Donuts': ' 🍩' };
        const usa_diabetics = ['PJPB7G3y', 'QvDP2zgv', 'k3LgQL4v', 'rnejGZ2J', 'V3yAQ6Y3'];
        const can_diabetics = ['BJ0r9gL3', 'AnzRoOpn', 'kJwL5b8v'];

        const formatPlayerLine = (player, teamName) => {
            let line = '';
            if (teamName === 'Diabetics') {
                if (usa_diabetics.includes(player.player_id)) line += '🇺🇸 ';
                else if (can_diabetics.includes(player.player_id)) line += '🇨🇦 ';
            }
            line += `@${player.player_handle}`;
            if (player.is_captain) {
                line += captainEmojis[teamName] || ' (c)';
            }
            return line;
        };

        let gotdGameBlock = null;

        gamesData.forEach(game => {
            const team1Lineup = game.team1_lineup.map(p => formatPlayerLine(p, game.team1_name)).join('\n ');
            const team2Lineup = game.team2_lineup.map(p => formatPlayerLine(p, game.team2_name)).join('\n ');
            
            const gameBlockText = `${game.team1_name} (${game.team1_record})\n ${team1Lineup}\nvs \n${game.team2_name} (${game.team2_record})\n ${team2Lineup}`;

            const gameContainer = document.createElement('div');
            gameContainer.className = 'report-item';
            
            const textPre = document.createElement('pre');
            textPre.className = 'report-item-text';
            textPre.textContent = gameBlockText;

            const copyIcon = document.createElement('span');
            copyIcon.className = 'copy-icon';
            copyIcon.textContent = '📋';
            copyIcon.title = 'Copy matchup';
            copyIcon.onclick = () => {
                navigator.clipboard.writeText(gameBlockText).then(() => {
                    copyIcon.textContent = '✅';
                    setTimeout(() => { copyIcon.textContent = '📋'; }, 1500);
                }).catch(err => console.error('Failed to copy text: ', err));
            };
            
            gameContainer.appendChild(textPre);
            gameContainer.appendChild(copyIcon);

            if (game.gameId === gotdId) {
                gotdGameBlock = gameContainer;
            } else {
                reportContainer.appendChild(gameContainer);
            }
        });
        
        if (gotdGameBlock) {
            const gotdTitle = document.createElement('div');
            gotdTitle.textContent = `GOTD (${formattedDate})`;
            gotdTitle.style.fontWeight = 'bold';
            gotdTitle.style.marginTop = '20px';
            
            const separator = document.createElement('div');
            separator.textContent = '~~~~~~~~~~~~~~';
            separator.style.margin = '5px 0 10px 0';
            
            reportContainer.appendChild(gotdTitle);
            reportContainer.appendChild(separator);
            reportContainer.appendChild(gotdGameBlock);
        }

        displayReport(reportContainer);
        document.getElementById('gotd-selector-container').style.display = 'none';
    }

    function displayReport(content) {
        reportOutputContainer.style.display = 'block';
        reportOutputEl.innerHTML = ''; // Clear previous content

        if (typeof content === 'string') {
            reportOutputEl.textContent = content;
        } else {
            // Appends a DocumentFragment or a single DOM node
            reportOutputEl.appendChild(content);
        }
        reportOutputEl.scrollTop = 0; // Scroll to top
    }

    function copyReportToClipboard() {
        navigator.clipboard.writeText(reportOutputEl.textContent).then(() => {
            alert("Report copied to clipboard!");
        }).catch(err => {
            alert("Failed to copy report.");
            console.error('Clipboard copy error:', err);
        });
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
                    window.location.href = '/login.html';
                });
            });
        }
    }
    
    function handleError(message) {
        loadingContainer.innerHTML = `<div class="error">${message}</div>`;
        adminContainer.style.display = 'none';
    }
});