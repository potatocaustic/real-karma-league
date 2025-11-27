
const API_BASE = 'https://schedule.tommyek67.workers.dev/';
const POLL_CHECK_API = 'https://has-polls.tomfconreal.workers.dev/';
const SPORTS = ['mlb', 'nfl', 'wnba', 'ufc', 'soccer', 'ncaaf', 'nhl', 'nba', 'ncaam'];
const DISPLAY_NAMES = { soccer: 'FC' , ncaaf: 'CFB', ncaam: 'CBB'};

let currentPreset = 'classic';
let currentTz = 'America/New_York';
let includePollCount = true;

document.getElementById('dateInput').valueAsDate = new Date();
document.getElementById('tzSelect').value = 'America/New_York';
document.getElementById('fetchBtn').addEventListener('click', fetchAllSchedules);
document.getElementById('dateInput').addEventListener('keypress', e => { if(e.key==='Enter') fetchAllSchedules(); });
document.getElementById('pollCheckbox').addEventListener('change', e => {
    includePollCount = e.target.checked;
    const container = document.getElementById('scheduleContainer');
    if (container.style.display === 'block') {
        fetchAllSchedules();
    }
});
document.getElementById('tzSelect').addEventListener('change', e => {
    currentTz = e.target.value;
    const container = document.getElementById('scheduleContainer');
    if (container.style.display === 'block') {
        fetchAllSchedules();
    }
});

// Preset menu functionality
const presetBtn = document.getElementById('presetBtn');
const presetDropdown = document.getElementById('presetDropdown');
const tzControl = document.getElementById('tzControl');

presetBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    presetDropdown.classList.toggle('show');
});

document.addEventListener('click', () => {
    presetDropdown.classList.remove('show');
});

document.querySelectorAll('.preset-option').forEach(option => {
    option.addEventListener('click', (e) => {
        e.stopPropagation();
        currentPreset = option.dataset.preset;
        const presetName = option.querySelector('h3').textContent.replace(' (Current)', '');
        presetBtn.textContent = presetName + ' ▼';
        presetDropdown.classList.remove('show');
        
        tzControl.classList.toggle('tz-hidden', false);
        
        const container = document.getElementById('scheduleContainer');
        if (container.style.display === 'block') {
            fetchAllSchedules();
        }
    });
});

async function fetchAllSchedules() {
    const selectedDate = document.getElementById('dateInput').value;
    if (!selectedDate) { showError('Please select a date'); return; }

    showLoading(true); hideError(); hideSchedule();

    try {
        const promises = SPORTS.map(sport => fetchSportSchedule(sport, selectedDate));
        const results = await Promise.allSettled(promises);

        const sportsData = {};
        results.forEach((result, index) => {
            const sport = SPORTS[index];
            if (result.status==='fulfilled' && result.value) sportsData[sport] = result.value;
            else { console.warn(`Failed to fetch ${sport}:`, result.reason); sportsData[sport] = { content: { games: [] } }; }
        });

        // Check for polls in CBB games
        if (includePollCount) {
            await checkCBBPolls(sportsData);
        }

        displayConsolidatedSchedule(sportsData, selectedDate);
    } catch(err) {
        console.error('Fetch error:', err);
        showError(`Failed to load schedules: ${err.message}`);
    } finally { showLoading(false); }
}

async function fetchSportSchedule(sport, date) {
    const url = `${API_BASE}?sport=${sport}&day=${date}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${sport}: ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    console.log(`${sport.toUpperCase()} API DATA:`, data);
    return data;
}

function getGamesFromData(data, sport) {
    if (!data) return [];
    if (data.content?.games) return data.content.games;
    if (Array.isArray(data.games)) return data.games;

    if (sport==='soccer') {
        const gamesArray = data.matches || data.events || data.content?.content?.games || [];
        return gamesArray.map(match => ({
            ...match,
            dateTime: match.dateTime || match.kickOffTime || match.start_time || match.startTime,
            homeTeam: match.homeTeam || { name: match.homeTeamName || 'Home' },
            awayTeam: match.awayTeam || { name: match.awayTeamName || 'Away' }
        }));
    }
    return [];
}

async function checkCBBPolls(sportsData) {
    if (!sportsData.ncaam) return;
    
    const cbbGames = getGamesFromData(sportsData.ncaam, 'ncaam');
    if (!cbbGames.length) return;

    console.log('Checking polls for CBB games...');
    
    const pollPromises = cbbGames.map(async (game) => {
        const gameId = game.id || game.gameId;
        if (!gameId) return { gameId: null, hasPolls: false };
        
        try {
            const url = `${POLL_CHECK_API}?game_id=${gameId}`;
            const res = await fetch(url);
            if (!res.ok) return { gameId, hasPolls: false };
            const hasPolls = await res.json();
            console.log(`Game ${gameId}: ${hasPolls ? 'HAS' : 'NO'} polls`);
            return { gameId, hasPolls };
        } catch (err) {
            console.warn(`Failed to check polls for game ${gameId}:`, err);
            return { gameId, hasPolls: false };
        }
    });

    const pollResults = await Promise.all(pollPromises);
    
    // Add poll status to each game
    cbbGames.forEach((game, index) => {
        game.hasPolls = pollResults[index].hasPolls;
    });
}

function displayConsolidatedSchedule(sportsData, selectedDate) {
    const container = document.getElementById('scheduleContainer');
    const summaryOutput = document.getElementById('summaryOutput');
    const breakdownOutput = document.getElementById('breakdownOutput');

    const allGames = [];
    const sportCounts = {};
    const sportPollCounts = {};
    let totalGames = 0;

    Object.entries(sportsData).forEach(([sport, data])=>{
        const games = getGamesFromData(data, sport);
        if (games.length>0) {
            sportCounts[sport] = games.length;
            totalGames += games.length;
            
            // Count games with polls for CBB
            if (sport === 'ncaam') {
                sportPollCounts[sport] = games.filter(g => g.hasPolls).length;
                console.log(`CBB: ${games.length} total games, ${sportPollCounts[sport]} with polls`);
                console.log('Games with polls:', games.filter(g => g.hasPolls).map(g => g.id || g.gameId));
            }
            
            games.forEach(game => allGames.push({ ...game, sport: DISPLAY_NAMES[sport]||sport.toUpperCase(), dateTime: game.dateTime, hasPolls: game.hasPolls }));
        }
    });

    if (currentPreset === 'detailed') {
        summaryOutput.textContent = generateDetailedBreakdown(allGames, selectedDate, sportPollCounts);
        breakdownOutput.textContent = generateDetailedFormat(sportCounts, totalGames, selectedDate, sportsData, sportPollCounts);
    } else {
        summaryOutput.textContent = generateSummary(sportCounts, totalGames, selectedDate, sportsData, sportPollCounts);
        breakdownOutput.textContent = generateFullBreakdown(allGames);
    }
    container.style.display = 'block';
}

function generateSummary(sportCounts, totalGames, selectedDate, sportsData, sportPollCounts) {
    const date = new Date(selectedDate+'T00:00:00');
    const dayName = date.toLocaleDateString('en-US',{weekday:'long'});
    const monthDay = date.toLocaleDateString('en-US',{month:'numeric',day:'numeric'});

    let summary = `Games on ${dayName} ${monthDay}\n———————————————\n`;

    if(totalGames===0) summary+='No games scheduled\n';
    else {
        const sortedSports = Object.entries(sportCounts).sort(([,a],[,b])=>b-a);
        sortedSports.forEach(([sport,count])=>{
            const times = getEarliestGameTimes(sport, sportsData);
            const displayName = DISPLAY_NAMES[sport]||sport.toUpperCase();
            
            // Add poll count for CBB
            let countDisplay = count;
            let pollSuffix = '';
            if (sport === 'ncaam' && sportPollCounts[sport] && includePollCount) {
                pollSuffix = ` (${sportPollCounts[sport]} w/ polls)`;
            }
            
            summary += times.pdt && times.est ? `${countDisplay} ${displayName}${pollSuffix} (${times.pdt}/${times.est})\n` : `${countDisplay} ${displayName}${pollSuffix}\n`;
        });
    }

    summary += '———————————————\n';
    summary += `${totalGames} total games\n———————————————`;

    const customMessage = document.getElementById('messageInput').value;
    if (customMessage) {
        summary += `\n❗️${customMessage}`;
    }

    return summary;
}

function generateDetailedFormat(sportCounts, totalGames, selectedDate, sportsData, sportPollCounts) {
    const date = new Date(selectedDate+'T00:00:00');
    const monthDay = date.toLocaleDateString('en-US',{month:'numeric',day:'numeric'});
    
    let summary = `Full Game Breakdown ${monthDay} (${getTimezoneName(currentTz)})\n.\n`;
    
    if(totalGames===0) {
        summary += 'No games scheduled';
    } else {
        summary += 'Sports: ';
        const sortedSports = Object.entries(sportCounts).sort(([,a],[,b])=>b-a);
        const sportsList = sortedSports.map(([sport,count])=>{
            const displayName = DISPLAY_NAMES[sport]||sport.toUpperCase();
            
            // Add poll count for CBB
            if (sport === 'ncaam' && sportPollCounts[sport] && includePollCount) {
                return `${count} ${displayName} (${sportPollCounts[sport]} w/ polls)`;
            }
            return `${count} ${displayName}`;
        });
        summary += sportsList.join(', ') + '\n.\n.\n';
        
        // Time breakdown
        const allGames = [];
        Object.entries(sportsData).forEach(([sport, data])=>{
            const games = getGamesFromData(data, sport);
            games.forEach(game => allGames.push({ sport: DISPLAY_NAMES[sport]||sport.toUpperCase(), dateTime: game.dateTime||game.kickOffTime||game.startTime }));
        });
        
        const gamesByTime = {};
        const timeDisplay = {};
        allGames.forEach(game => {
            let timeKey = 'TBD';
            if (game.dateTime) {
                try {
                    const dt = new Date(game.dateTime);
                    const hours = dt.toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit', hour12: false, timeZone: currentTz});
                    const [h, m] = hours.split(':');
                    timeKey = `${parseInt(h)}:${m}`;
                    timeDisplay[timeKey] = convertTo12Hour(hours);
                } catch (e) { timeKey = 'TBD'; }
            }
            if (!gamesByTime[timeKey]) gamesByTime[timeKey] = {};
            if (!gamesByTime[timeKey][game.sport]) gamesByTime[timeKey][game.sport] = 0;
            gamesByTime[timeKey][game.sport]++;
        });
        
        const sortedTimes = Object.keys(gamesByTime).sort((a, b) => {
            if (a === 'TBD') return 1;
            if (b === 'TBD') return -1;
            const [aH, aM] = a.split(':').map(Number);
            const [bH, bM] = b.split(':').map(Number);
            if (aH !== bH) return aH - bH;
            return aM - bM;
        });
        
        const timeLines = [];
        sortedTimes.forEach(time => {
            const sports = gamesByTime[time];
            const displayTime = timeDisplay[time] || time;
            const sportEntries = Object.entries(sports).map(([sport, count]) => 
                `${count} ${sport}`
            ).join(', ');
            timeLines.push(`${displayTime}: ${sportEntries}`);
        });
        
        summary += timeLines.join('\n');
    }
    
    const customMessage = document.getElementById('messageInput').value;
    if (customMessage) {
        summary += `\n.\n!--${customMessage}--!`;
    }
    
    return summary;
}

function generateDetailedBreakdown(allGames, selectedDate, sportPollCounts) {
    const date = new Date(selectedDate+'T00:00:00');
    const dayName = date.toLocaleDateString('en-US',{weekday:'long'});
    const monthDay = date.toLocaleDateString('en-US',{month:'numeric',day:'numeric'});
    
    let breakdown = `Games on ${dayName} ${monthDay}\n.\n`;
    
    if (!allGames.length) {
        breakdown += 'No games scheduled';
    } else {
        const sportCounts = {};
        allGames.forEach(game => {
            if (!sportCounts[game.sport]) sportCounts[game.sport] = { count: 0, earliest: null, pollCount: 0 };
            sportCounts[game.sport].count++;
            // Track poll count for CBB games
            if (game.sport === 'CBB' && game.hasPolls) {
                console.log('Found CBB game with polls:', game);
                sportCounts[game.sport].pollCount++;
            }
            const dt = game.dateTime || game.kickOffTime || game.startTime;
            if (dt) {
                const t = new Date(dt);
                if (!sportCounts[game.sport].earliest || t < sportCounts[game.sport].earliest) {
                    sportCounts[game.sport].earliest = t;
                }
            }
        });
        
        console.log('Sport counts in detailed breakdown:', sportCounts);
        
        const sortedSports = Object.entries(sportCounts).sort(([,a],[,b])=>b.count-a.count);
        sortedSports.forEach(([sport, data]) => {
            const displayName = sport; // Already converted to display name
            
            // Add poll count for CBB
            let countDisplay = data.count;
            let pollSuffix = '';
            if (sport === 'CBB' && data.pollCount > 0 && includePollCount) {
                console.log(`CBB has ${data.pollCount} games with polls`);
                pollSuffix = ` (${data.pollCount} w/ polls)`;
            }
            
            if (data.earliest) {
                const time = data.earliest.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:true,timeZone: currentTz});
                breakdown += `${countDisplay} ${displayName}${pollSuffix} (${time})\n`;
            } else {
                breakdown += `${countDisplay} ${displayName}${pollSuffix}\n`;
            }
        });
        
        breakdown += `.\n${allGames.length} total games`;
    }
    
    const customMessage = document.getElementById('messageInput').value;
    if (customMessage) {
        breakdown += `\n.\n!--${customMessage}--!`;
    }
    
    return breakdown;
}

function getTimezoneName(tz) {
    const names = {
        'America/New_York': 'EDT',
        'America/Chicago': 'CDT',
        'America/Denver': 'MDT',
        'America/Los_Angeles': 'PDT'
    };
    return names[tz] || 'EDT';
}

function getEarliestGameTimes(sport, sportsData) {
    const games = getGamesFromData(sportsData[sport], sport);
    if(!games.length) return { pdt:'TBD', est:'TBD' };

    let earliestTime = null;
    games.forEach(game=>{
        const dt = game.dateTime || game.kickOffTime || game.startTime;
        if(dt) { const t=new Date(dt); if(!earliestTime||t<earliestTime) earliestTime=t; }
    });

    if(!earliestTime) return { pdt:'TBD', est:'TBD' };
    const pdt = earliestTime.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:false,timeZone:'America/Los_Angeles'});
    const est = earliestTime.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',hour12:false,timeZone:'America/New_York'});
    return { pdt: convertTo12Hour(pdt), est: convertTo12Hour(est) };
}

function generateFullBreakdown(allGames) {
    if (!allGames.length) return 'Full Breakdown: (' + getTimezoneName(currentTz) + ')\nNo games scheduled';
    
    // Filter games based on poll status if needed
    let filteredGames = allGames;
    if (includePollCount) {
        filteredGames = allGames.filter(game => {
            // For CBB games, only include if they have polls
            if (game.sport === 'CBB') {
                return game.hasPolls === true;
            }
            // Include all non-CBB games
            return true;
        });
    }
    
    if (!filteredGames.length) return 'Full Breakdown: (' + getTimezoneName(currentTz) + ')\nNo games scheduled';
    
    let breakdown = 'Full Breakdown: (' + getTimezoneName(currentTz) + ')\n';
    const gamesByTime = {};

    filteredGames.forEach(game => {
        const dt = game.dateTime || game.kickOffTime || game.startTime;
        let timeKey = 'TBD';
        if (dt) {
            try {
                timeKey = new Date(dt).toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: false,
                    timeZone: currentTz
                });
            } catch (e) {
                timeKey = 'TBD';
            }
        }
        if (!gamesByTime[timeKey]) gamesByTime[timeKey] = {};
        if (!gamesByTime[timeKey][game.sport]) gamesByTime[timeKey][game.sport] = 0;
        gamesByTime[timeKey][game.sport]++;
    });

    const sortedTimes = Object.keys(gamesByTime).sort((a, b) => {
        if (a === 'TBD') return 1;
        if (b === 'TBD') return -1;
        return a.localeCompare(b);
    });
    const items = [];
    sortedTimes.forEach(time => {
        const sports = gamesByTime[time];
        Object.entries(sports).forEach(([sport, count]) => {
            const displayTime = convertTo12Hour(time);
            items.push(`${count} ${sport} - ${displayTime}`);
        });
    });

    breakdown += items.join('\n');

    return breakdown;
}

function convertTo12Hour(time24) {
    if(time24==='TBD') return 'TBD';
    try{
        const [h,m]=time24.split(':'); const hour=parseInt(h); const ampm=hour>=12?'PM':'AM'; const dh=hour===0?12:(hour>12?hour-12:hour);
        return `${dh}:${m}${ampm}`;
    }catch(e){ return time24; }
}

function copyToClipboard(id){
    const txt=document.getElementById(id).textContent;
    navigator.clipboard.writeText(txt).then(()=>{
        const btn=event.target; const orig=btn.textContent;
        btn.textContent='Copied'; setTimeout(()=>{btn.textContent=orig;},1500);
    }).catch(err=>console.error('Failed to copy:',err));
}

function showLoading(show){document.getElementById('loading').style.display=show?'block':'none';}
function showError(msg){const e=document.getElementById('error'); e.textContent=msg; e.style.display='block';}
function hideError(){document.getElementById('error').style.display='none';}
function hideSchedule(){document.getElementById('scheduleContainer').style.display='none';}

fetchAllSchedules();

const messageInput = document.getElementById('messageInput');
messageInput.addEventListener('input', () => {
    const container = document.getElementById('scheduleContainer');
    if (container.style.display === 'block') {
        fetchAllSchedules();
    }
});
