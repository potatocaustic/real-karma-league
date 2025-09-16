// /admin/manage-awards.js

import { auth, db, functions, onAuthStateChanged, signOut, doc, getDoc, collection, getDocs, writeBatch, httpsCallable, query, where } from '/js/firebase-init.js';

// --- DEV ENVIRONMENT CONFIG ---
const USE_DEV_COLLECTIONS = false;
const getCollectionName = (baseName) => {
    // This logic is simplified as all relevant collections follow the same dev/prod pattern
    return USE_DEV_COLLECTIONS ? `${baseName}_dev` : baseName;
};


// --- Page Elements ---
const loadingContainer = document.getElementById('loading-container');
const adminContainer = document.getElementById('admin-container');
const seasonSelect = document.getElementById('season-select');
const awardsForm = document.getElementById('awards-form');
const playerDatalist = document.getElementById('player-datalist');
const gmDatalist = document.getElementById('gm-datalist');
const calculateBtn = document.getElementById('calculate-awards-btn');

// --- Global Data Cache ---
let allPlayers = new Map();
let allGms = new Map();
let allTeams = [];
let currentSeasonId = null;

// --- Helper Functions ---
function calculateMedian(numbers) {
    if (!numbers || numbers.length === 0) return 0;
    const sorted = [...numbers].filter(n => typeof n === 'number').sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}


// --- Primary Auth Check & Initialization ---
document.addEventListener('DOMContentLoaded', () => {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            if (user.isAnonymous) {
                await signOut(auth);
                window.location.href = '/login.html';
                return;
            }

            const userRef = doc(db, getCollectionName("users"), user.uid);
            const userDoc = await getDoc(userRef);
            if (userDoc.exists() && userDoc.data().role === 'admin') {
                await initializePage();
                loadingContainer.style.display = 'none';
                adminContainer.style.display = 'block';
            } else {
                loadingContainer.innerHTML = '<div class="error">Access Denied.</div>';
            }
        } else {
            window.location.href = '/login.html';
        }
    });
});

async function initializePage() {
    try {
        const playersSnap = await getDocs(collection(db, getCollectionName("v2_players")));
        playersSnap.docs.forEach(doc => {
            if (doc.data().player_status === 'ACTIVE') {
                allPlayers.set(doc.data().player_handle, { id: doc.id, ...doc.data() });
            }
        });

        await populateSeasons();

        seasonSelect.addEventListener('change', async () => {
            currentSeasonId = seasonSelect.value;
            await updateTeamCache(currentSeasonId);
            populateDatalistAndSelects();
            loadExistingAwards();
        });

        awardsForm.addEventListener('submit', handleFormSubmit);
        calculateBtn.addEventListener('click', handleCalculationTrigger);

    } catch (error) {
        console.error("Error initializing awards page:", error);
        adminContainer.innerHTML = `<div class="error">Could not load required league data.</div>`;
    }
}

async function updateTeamCache(seasonId) {
    const teamsSnap = await getDocs(collection(db, getCollectionName("v2_teams")));
    const teamPromises = teamsSnap.docs.map(async (teamDoc) => {
        if (!teamDoc.data().conference) return null;

        const teamData = { id: teamDoc.id, ...teamDoc.data() };
        const seasonRecordRef = doc(db, getCollectionName("v2_teams"), teamDoc.id, getCollectionName("seasonal_records"), seasonId);
        const seasonRecordSnap = await getDoc(seasonRecordRef);

        teamData.team_name = seasonRecordSnap.exists() ? seasonRecordSnap.data().team_name : "Name Not Found";
        return teamData;
    });

    allTeams = (await Promise.all(teamPromises))
        .filter(Boolean)
        .sort((a, b) => a.team_name.localeCompare(b.team_name));
}

async function populateSeasons() {
    const seasonsSnap = await getDocs(query(collection(db, getCollectionName("seasons"))));
    let activeSeasonId = null;
    const sortedDocs = seasonsSnap.docs.sort((a, b) => b.id.localeCompare(a.id));

    seasonSelect.innerHTML = sortedDocs.map(doc => {
        const seasonData = doc.data();
        if (seasonData.status === 'active') {
            activeSeasonId = doc.id;
        }
        return `<option value="${doc.id}">${seasonData.season_name}</option>`;
    }).join('');

    if (activeSeasonId) {
        seasonSelect.value = activeSeasonId;
    }

    currentSeasonId = seasonSelect.value;

    await updateTeamCache(currentSeasonId);
    populateDatalistAndSelects();
    await loadExistingAwards();
}

function populateDatalistAndSelects() {
    playerDatalist.innerHTML = Array.from(allPlayers.keys()).map(handle => `<option value="${handle}"></option>`).join('');

    allGms.clear();
    allTeams.forEach(team => {
        if (team.current_gm_handle) {
            allGms.set(team.current_gm_handle, { team_id: team.id, team_name: team.team_name });
        }
    });

    gmDatalist.innerHTML = Array.from(allGms.keys()).map(handle => `<option value="${handle}"></option>`).join('');

    const teamOptions = `<option value="">-- Select Team --</option>` + allTeams.map(t => `<option value="${t.id}">${t.team_name}</option>`).join('');
    document.querySelectorAll('.team-select').forEach(select => select.innerHTML = teamOptions);

    document.getElementById('all-stars-eastern').innerHTML = '';
    document.getElementById('all-stars-western').innerHTML = '';
    document.getElementById('rising-stars-eastern').innerHTML = '';
    document.getElementById('rising-stars-western').innerHTML = '';

    for (let i = 1; i <= 8; i++) {
        document.getElementById('all-stars-eastern').innerHTML += `<input type="text" list="player-datalist" placeholder="East All-Star #${i}" autocomplete="off">`;
        document.getElementById('all-stars-western').innerHTML += `<input type="text" list="player-datalist" placeholder="West All-Star #${i}" autocomplete="off">`;
        document.getElementById('rising-stars-eastern').innerHTML += `<input type="text" list="player-datalist" placeholder="East Rising Star #${i}" autocomplete="off">`;
        document.getElementById('rising-stars-western').innerHTML += `<input type="text" list="player-datalist" placeholder="West Rising Star #${i}" autocomplete="off">`;
    }
}

async function loadExistingAwards() {
    awardsForm.reset();

    if (!currentSeasonId) return;
    const seasonNumber = currentSeasonId.replace('S', '');
    const awardsCollectionRef = collection(db, `${getCollectionName('awards')}/season_${seasonNumber}/${getCollectionName(`S${seasonNumber}_awards`)}`);
    const awardsSnap = await getDocs(awardsCollectionRef);
    const awardsParentDocRef = doc(db, `${getCollectionName('awards')}/season_${seasonNumber}`);
    
    if (awardsSnap.empty) {
        console.log("No existing awards found for this season.");
        document.getElementById('best-player-performance-display').textContent = 'Not yet calculated.';
        document.getElementById('best-team-performance-display').textContent = 'Not yet calculated.';
        return;
    }

    const awardsData = new Map();
    awardsSnap.forEach(doc => awardsData.set(doc.id, doc.data()));

    const singleAwards = ['finals-mvp', 'mvp', 'rookie-of-the-year', 'sixth-man', 'most-improved', 'lvp'];
    singleAwards.forEach(id => {
        const award = awardsData.get(id);
        const element = document.getElementById(`award-${id}`);
        if (element) element.value = award?.player_handle || '';
    });

    const gmAward = awardsData.get('gm-of-the-year');
    const gmElement = document.getElementById('award-gm-of-the-year');
    if (gmElement) gmElement.value = gmAward?.gm_handle || '';

    const teamAwards = ['league-champion', 'regular-season-title'];
    teamAwards.forEach(id => {
        const award = awardsData.get(id);
        const element = document.getElementById(`award-${id}`);
        if (element) element.value = award?.team_id || '';
    });

    const listAwards = ['all-stars-eastern', 'all-stars-western', 'rising-stars-eastern', 'rising-stars-western'];
    listAwards.forEach(id => {
        const award = awardsData.get(id);
        if (award && award.players) {
            const inputs = document.getElementById(id).querySelectorAll('input');
            award.players.forEach((player, i) => {
                if (inputs[i]) inputs[i].value = player.player_handle;
            });
        }
    });

    const bestPlayer = awardsData.get('best_performance_player');
    const bestPlayerDisplay = document.getElementById('best-player-performance-display');
    if (bestPlayer && bestPlayerDisplay) {
        bestPlayerDisplay.textContent = `${bestPlayer.player_handle} (${(bestPlayer.value * 100).toFixed(2)}% above median)`;
    } else if (bestPlayerDisplay) {
        bestPlayerDisplay.textContent = 'Not yet calculated.';
    }

    const bestTeam = awardsData.get('best_performance_team');
    const bestTeamDisplay = document.getElementById('best-team-performance-display');
    if (bestTeam && bestTeamDisplay) {
        bestTeamDisplay.textContent = `${bestTeam.team_name} (${(bestTeam.value * 100).toFixed(2)}% above median)`;
    } else if (bestTeamDisplay) {
        bestTeamDisplay.textContent = 'Not yet calculated.';
    }
}


async function handleFormSubmit(e) {
    e.preventDefault();
    const saveButton = e.target.querySelector('button[type="submit"]');
    saveButton.disabled = true;
    saveButton.textContent = 'Saving...';

    try {
        const seasonNumber = currentSeasonId.replace('S', '');
        const awardsCollectionRef = collection(db, `${getCollectionName('awards')}/season_${seasonNumber}/${getCollectionName(`S${seasonNumber}_awards`)}`);

        // --- PRE-CALCULATIONS (READS) ---
        let championExtraStats = {};
        const championTeamId = document.getElementById('award-league-champion').value;
        if (championTeamId) {
            const recordRef = doc(db, getCollectionName("v2_teams"), championTeamId, getCollectionName("seasonal_records"), currentSeasonId);
            const recordSnap = await getDoc(recordRef);
            if (recordSnap.exists()) {
                const rec = recordSnap.data();
                championExtraStats.champ_wins = (rec.wins || 0) + (rec.post_wins || 0);
                championExtraStats.champ_losses = (rec.losses || 0) + (rec.post_losses || 0);
                championExtraStats.champ_pam = (rec.pam || 0) + (rec.post_pam || 0);
            }

            const lineupsRef = collection(db, getCollectionName("seasons"), currentSeasonId, getCollectionName("lineups"));
            const postLineupsRef = collection(db, getCollectionName("seasons"), currentSeasonId, getCollectionName("post_lineups"));
            const [regLineupsSnap, postLineupsSnap] = await Promise.all([
                getDocs(query(lineupsRef, where("team_id", "==", championTeamId))),
                getDocs(query(postLineupsRef, where("team_id", "==", championTeamId)))
            ]);
            const allRanks = [...regLineupsSnap.docs.map(d => d.data().global_rank), ...postLineupsSnap.docs.map(d => d.data().global_rank)].filter(rank => rank > 0);
            championExtraStats.champ_medrank = calculateMedian(allRanks);
        }

        let fmvpExtraStats = {};
        const fmvpHandle = document.getElementById('award-finals-mvp').value;
        if (fmvpHandle && allPlayers.has(fmvpHandle)) {
            const player = allPlayers.get(fmvpHandle);
            const postGamesRef = collection(db, getCollectionName("seasons"), currentSeasonId, getCollectionName("post_games"));
            const finalsGamesSnap = await getDocs(query(postGamesRef, where("series_id", "==", "Finals")));
            const finalsDates = finalsGamesSnap.docs.map(d => d.data().date);

            if (finalsDates.length > 0) {
                const postLineupsRef = collection(db, getCollectionName("seasons"), currentSeasonId, getCollectionName("post_lineups"));
                const fmvpLineupsSnap = await getDocs(query(postLineupsRef, where("player_id", "==", player.id), where("date", "in", finalsDates)));
                const fmvpLineups = fmvpLineupsSnap.docs.map(d => d.data());
                const fmvpRanks = fmvpLineups.map(l => l.global_rank).filter(r => r > 0);
                fmvpExtraStats.fmvp_medrank = calculateMedian(fmvpRanks);

                const totalPoints = fmvpLineups.reduce((sum, l) => sum + (l.points_adjusted || 0), 0);
                const dailyAveragesRef = collection(db, `${getCollectionName('post_daily_averages')}/season_${seasonNumber}/${getCollectionName(`S${seasonNumber}_post_daily_averages`)}`);
                let totalMedianScore = 0;
                const dailyAvgPromises = finalsDates.map(date => {
                    const yyyymmdd = date.split('/').reverse().join('-').replace(/(\d{2})-(\d{2})-(\d{4})/, '$3-$1-$2');
                    return getDoc(doc(dailyAveragesRef, yyyymmdd));
                });
                const dailyAvgSnaps = await Promise.all(dailyAvgPromises);
                dailyAvgSnaps.forEach(snap => { if(snap.exists()) totalMedianScore += snap.data().median_score || 0; });
                fmvpExtraStats.fmvp_rel_median = totalMedianScore > 0 ? totalPoints / totalMedianScore : 0;
            }
        }

        // --- BATCH WRITES ---
        const batch = writeBatch(db);
        batch.set(awardsParentDocRef, {
            description: `Awards for Season ${seasonNumber}`
        }, { merge: true });
        const allStarPlayerIds = new Set();

        const singleAwards = ['finals-mvp', 'mvp', 'rookie-of-the-year', 'sixth-man', 'most-improved', 'lvp'];
        for (const id of singleAwards) {
            const handle = document.getElementById(`award-${id}`).value;
            const docRef = doc(awardsCollectionRef, id);
            if (handle && allPlayers.has(handle)) {
                const player = allPlayers.get(handle);
                let data = { award_name: id.replace(/-/g, ' '), player_handle: player.player_handle, player_id: player.id, team_id: player.current_team_id };
                if(id === 'finals-mvp') {
                    data = { ...data, ...fmvpExtraStats };
                }
                batch.set(docRef, data);
            } else {
                batch.delete(docRef);
            }
        }

        const gmHandle = document.getElementById('award-gm-of-the-year').value;
        const gmDocRef = doc(awardsCollectionRef, 'gm-of-the-year');
        if (gmHandle && allGms.has(gmHandle)) {
            const gm = allGms.get(gmHandle);
            batch.set(gmDocRef, { award_name: 'GM of the Year', gm_handle: gmHandle, team_id: gm.team_id });
        } else {
            batch.delete(gmDocRef);
        }
        
        const teamAwards = ['league-champion', 'regular-season-title'];
        for (const id of teamAwards) {
            const teamId = document.getElementById(`award-${id}`).value;
            const docRef = doc(, id);
            if (teamId) {
                const team = allTeams.find(t => t.id === teamId);
                let data = { award_name: id.replace(/-/g, ' '), team_id: team.id, team_name: team.team_name };
                 if(id === 'league-champion') {
                    data = { ...data, ...championExtraStats };
                }
                batch.set(docRef, data);
            } else {
                batch.delete(docRef);
            }
        }

        const listAwards = ['all-stars-eastern', 'all-stars-western', 'rising-stars-eastern', 'rising-stars-western'];
        for (const id of listAwards) {
            const players = [];
            const inputs = document.getElementById(id).querySelectorAll('input');
            inputs.forEach(input => {
                const handle = input.value.trim();
                if (handle && allPlayers.has(handle)) {
                    const player = allPlayers.get(handle);
                    players.push({ player_handle: player.player_handle, player_id: player.id, team_id: player.current_team_id });
                    if (id.startsWith('all-star')) {
                        allStarPlayerIds.add(player.id);
                    }
                }
            });
            const docRef = doc(, id);
            if (players.length > 0) {
                batch.set(docRef, { award_name: id.replace(/-/g, ' '), players: players });
            } else {
                batch.delete(docRef);
            }
        }

        for (const playerId of allStarPlayerIds) {
            const playerStatsRef = doc(db, getCollectionName("v2_players"), playerId, getCollectionName("seasonal_stats"), currentSeasonId);
            batch.set(playerStatsRef, { all_star: '1' }, { merge: true });
        }

        await batch.commit();
        alert('Manual awards saved successfully!');

    } catch (error) {
        console.error("Error saving awards:", error);
        alert('An error occurred. Check the console.');
    } finally {
        saveButton.disabled = false;
        saveButton.textContent = 'Save All Manual Awards';
    }
}

async function handleCalculationTrigger() {
    calculateBtn.disabled = true;
    calculateBtn.textContent = 'Calculating...';
    try {
        const calculatePerformanceAwards = httpsCallable(functions, 'calculatePerformanceAwards');
        const result = await calculatePerformanceAwards({ seasonId: currentSeasonId });
        alert(result.data.message);
        await loadExistingAwards();
    } catch (error) {
        console.error("Error triggering award calculation:", error);
        alert(`Error: ${error.message}`);
    } finally {
        calculateBtn.disabled = false;
        calculateBtn.textContent = 'Run Performance Calculation';
    }
}
