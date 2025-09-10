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
        // Set default dates to today
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

        if (data && data.games) {
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

        if (data && data.games) {
            const title = `Vote GOTD (${firestoreDate}):`;
            const gameLines = data.games.map(g => `${g.team1_name} (${g.team1_record}) vs ${g.team2_name} (${g.team2_record})`).join('\n');
            displayReport(`${title}\n${gameLines}`);
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

            data.games.forEach(game => {
                const label = document.createElement('label');
                label.style.display = 'flex';
                label.style.alignItems = 'center';
                label.style.marginBottom = '8px';
                
                const radio = document.createElement('input');
                radio.type = 'radio';
                radio.name = 'gotd_game';
                radio.value = game.gameId;
                radio.dataset.team1Name = game.team1_name;
                radio.dataset.team2Name = game.team2_name;
                radio.style.marginRight = '10px';
                
                label.appendChild(radio);
                label.append(`${game.team1_name} vs ${game.team2_name}`);
                list.appendChild(label);
            });
            
            const submitButton = document.createElement('button');
            submitButton.textContent = 'Confirm GOTD & Generate';
            submitButton.className = 'standard-btn';
            submitButton.onclick = () => generateLineupsReport(data.games);
            list.appendChild(submitButton);

            container.style.display = 'block';
        } else {
            alert('No active live games found for today. Cannot generate lineups report.');
        }
    }

    function generateLineupsReport(gamesData) {
        const selectedRadio = document.querySelector('input[name="gotd_game"]:checked');
        if (!selectedRadio) {
            alert("Please select a Game of the Day.");
            return;
        }
        
        const gotdId = selectedRadio.value;
        const today = new Date();
        const formattedDate = `${today.getMonth() + 1}/${today.getDate()}`;
        
        let output = `Lineups ${formattedDate}\n\n`;
        let gotdOutput = '';

        const captainEmojis = {
            'Hornets': ' 🐝',
            'Vipers': ' 🐍',
            'MLB': ' 👼',
            'Aces': ' ♠️',
            'Otters': ' 🦦',
            'Empire': ' 💤',
            'Demons': ' 😈',
            'Hounds': ' 🐶',
            'Legion': ' 🥷'
        };

        const usa_diabetics = ['PJPB7G3y', 'QvDP2zgv', 'k3LgQL4v', 'rnejGZ2J', 'V3yAQ6Y3'];
        const can_diabetics = ['BJ0r9gL3', 'AnzRoOpn', 'kJwL5b8v'];

        const formatPlayerLine = (player, teamName) => {
            let line = '';
            if (teamName === 'Diabetics') {
                if (usa_diabetics.includes(player.player_id)) {
                    line += '🇺🇸 ';
                } else if (can_diabetics.includes(player.player_id)) {
                    line += '🇨🇦 ';
                }
            }
            line += `@${player.player_handle}`;
            if (player.is_captain) {
                const emoji = captainEmojis[teamName] || ' (c)';
                line += emoji;
            }
            return line;
        };

        gamesData.forEach(game => {
            const team1Lineup = game.team1_lineup.map(p => formatPlayerLine(p, game.team1_name)).join('\n ');
            const team2Lineup = game.team2_lineup.map(p => formatPlayerLine(p, game.team2_name)).join('\n ');
            
            const gameBlock = `${game.team1_name} (${game.team1_record})\n ${team1Lineup}\nvs \n${game.team2_name} (${game.team2_record})\n ${team2Lineup}\n\n`;

            if (game.gameId === gotdId) {
                gotdOutput = `GOTD (${formattedDate})\n~~~~~~~~~~~~~~\n${gameBlock}`;
            } else {
                output += gameBlock;
            }
        });
        
        output += gotdOutput;
        displayReport(output);
        document.getElementById('gotd-selector-container').style.display = 'none';
    }


    function displayReport(text) {
        reportOutputContainer.style.display = 'block';
        reportOutputEl.textContent = text;
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
