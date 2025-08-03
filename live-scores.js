// /js/live-scores.js

import { db, auth, onAuthStateChanged, collection, onSnapshot, doc, getDoc } from '/js/firebase-init.js';

const liveGamesContainer = document.getElementById('live-games-container');
const loadingIndicator = document.getElementById('loading-indicator');
const noGamesIndicator = document.getElementById('no-games-indicator');

// IMPORTANT: Replace this with the actual URL of your Cloudflare worker
const WORKER_URL = 'https://rkl-karma-proxy.caustic.workers.dev/';

let activeGames = new Map(); // Store game data and intervals
const REFRESH_INTERVAL = 30000; // 30 seconds

// We still need auth to ensure Firebase read permissions are met,
// but the callable function is no longer needed here.
onAuthStateChanged(auth, (user) => {
    if (user) {
        listenForLiveGames();
    } else {
        loadingIndicator.textContent = "Authentication required to view scores.";
    }
});

function listenForLiveGames() {
    const liveGamesQuery = collection(db, "live_games");

    onSnapshot(liveGamesQuery, (snapshot) => {
        loadingIndicator.style.display = 'none';
        const currentGames = new Set();

        if (snapshot.empty) {
            noGamesIndicator.style.display = 'block';
        } else {
            noGamesIndicator.style.display = 'none';
        }

        snapshot.forEach(doc => {
            const gameId = doc.id;
            const gameData = doc.data();
            currentGames.add(gameId);

            if (!activeGames.has(gameId)) {
                createGameCard(gameId, gameData);
                const intervalId = setInterval(() => updateScores(gameId), REFRESH_INTERVAL);
                activeGames.set(gameId, { ...gameData, intervalId });
                updateScores(gameId); // Initial score fetch
            } else {
                activeGames.get(gameId).team1_lineup = gameData.team1_lineup;
                activeGames.get(gameId).team2_lineup = gameData.team2_lineup;
            }
        });

        // Clean up games that are no longer live
        for (const [gameId, game] of activeGames.entries()) {
            if (!currentGames.has(gameId)) {
                clearInterval(game.intervalId);
                document.getElementById(gameId)?.remove();
                activeGames.delete(gameId);
            }
        }
    });
}

function createGameCard(gameId, gameData) {
    const card = document.createElement('div');
    card.className = 'live-game-card';
    card.id = gameId;

    card.innerHTML = `
        <div class="live-game-header">
            <div id="${gameId}-team1-name" class="team-name">Team 1</div>
            <div id="${gameId}-team1-score" class="team-score">0</div>
            <div>vs</div>
            <div id="${gameId}-team2-score" class="team-score">0</div>
            <div id="${gameId}-team2-name" class="team-name">Team 2</div>
        </div>
        <div class="live-game-body">
            <div id="${gameId}-team1-roster"></div>
            <div id="${gameId}-team2-roster"></div>
        </div>
    `;
    liveGamesContainer.appendChild(card);
}

async function updateScores(gameId) {
    const game = activeGames.get(gameId);
    if (!game) return;

    const allPlayers = [...game.team1_lineup, ...game.team2_lineup];

    // Create an array of fetch promises, one for each player
    const scorePromises = allPlayers.map(player =>
        fetch(`${WORKER_URL}?userId=${encodeURIComponent(player.player_handle)}`)
            .then(res => {
                if (!res.ok) {
                    console.error(`Worker failed for ${player.player_handle}, status: ${res.status}`);
                    return { stats: { karmaDelta: 0 } }; // Return a default object on failure
                }
                return res.json();
            })
            .catch(err => {
                console.error(`Fetch failed for ${player.player_handle}:`, err);
                return { stats: { karmaDelta: 0 } }; // Return a default object on network error
            })
    );

    try {
        const scoreResults = await Promise.all(scorePromises);

        let team1Total = 0;
        let team2Total = 0;

        const team1RosterHtml = [`<div class="roster-title" id="${gameId}-team1-name-roster">Team 1 Roster</div>`];
        const team2RosterHtml = [`<div class="roster-title" id="${gameId}-team2-name-roster">Team 2 Roster</div>`];

        allPlayers.forEach((player, index) => {
            const liveScore = parseFloat(scoreResults[index]?.stats?.karmaDelta || 0);
            const deductions = player.deductions || 0;
            let finalScore = liveScore - deductions;

            if (player.is_captain) {
                finalScore *= 1.5;
            }

            const playerHtml = `
                <div class="player-row">
                    <div class="player-name">
                        ${player.player_handle || player.player_id}
                        ${player.is_captain ? '<span class="captain-badge">C</span>' : ''}
                    </div>
                    <div class="player-score">
                        ${finalScore.toFixed(2)}
                        ${deductions > 0 ? `<span class="deductions">(-${deductions})</span>` : ''}
                    </div>
                </div>
            `;

            if (game.team1_lineup.some(p => p.player_id === player.player_id)) {
                team1Total += finalScore;
                team1RosterHtml.push(playerHtml);
            } else {
                team2Total += finalScore;
                team2RosterHtml.push(playerHtml);
            }
        });

        // Update DOM elements
        document.getElementById(`${gameId}-team1-score`).textContent = team1Total.toFixed(0);
        document.getElementById(`${gameId}-team2-score`).textContent = team2Total.toFixed(0);
        document.getElementById(`${gameId}-team1-roster`).innerHTML = team1RosterHtml.join('');
        document.getElementById(`${gameId}-team2-roster`).innerHTML = team2RosterHtml.join('');

        const team1DocRef = doc(db, `v2_teams/${game.team1_lineup[0].team_id}/seasonal_records/${game.seasonId}`);
        const team2DocRef = doc(db, `v2_teams/${game.team2_lineup[0].team_id}/seasonal_records/${game.seasonId}`);

        const [team1Doc, team2Doc] = await Promise.all([getDoc(team1DocRef), getDoc(team2DocRef)]);

        const team1Name = team1Doc.exists() ? team1Doc.data().team_name : "Team 1";
        const team2Name = team2Doc.exists() ? team2Doc.data().team_name : "Team 2";

        document.getElementById(`${gameId}-team1-name`).textContent = team1Name;
        document.getElementById(`${gameId}-team2-name`).textContent = team2Name;
        document.getElementById(`${gameId}-team1-name-roster`).textContent = team1Name;
        document.getElementById(`${gameId}-team2-name-roster`).textContent = team2Name;

    } catch (error) {
        console.error(`Failed to process scores for game ${gameId}:`, error);
    }
}
