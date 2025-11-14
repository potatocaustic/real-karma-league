# Real Karma League - Efficiency Audit: Code Examples

This document provides exact code locations and the problematic patterns found.

---

## Issue 1: Collection Group Queries Fetching All Seasons

### Problem Pattern
Every page fetches ALL seasonal records for ALL seasons, then filters client-side.

### Example 1 - `/js/teams.js` (lines 94-120)
```javascript
// ❌ INEFFICIENT
async function loadTeams() {
  const teamsRef = collection(db, collectionNames.teams);
  const recordsQuery = query(collectionGroup(db, collectionNames.seasonalRecords));
  // ↑ This fetches ALL seasonal_records from ALL teams, ALL seasons

  const [teamsSnap, recordsSnap] = await Promise.all([
    getDocs(teamsRef),
    getDocs(recordsQuery)  // Massive unfiltered read
  ]);

  const seasonalRecordsMap = new Map();
  recordsSnap.forEach(doc => {
    // ↓ Client-side filtering AFTER all data loaded
    if (doc.id === SEASON_ID) {  // Only wants current season
      const teamId = doc.ref.parent.parent.id;
      seasonalRecordsMap.set(teamId, doc.data());
    }
  });
}
```

**Fix:** Add `.where()` filter to only fetch current season
```javascript
// ✅ EFFICIENT
const recordsQuery = query(
  collectionGroup(db, collectionNames.seasonalRecords),
  where('__name__', '==', SEASON_ID)  // Filter at database level
);
```

### Example 2 - `/js/standings.js` (lines 40-62)
```javascript
// ❌ INEFFICIENT - Same pattern repeated
async function fetchAllTeamsAndRecords() {
  const teamsQuery = query(collection(db, collectionNames.teams), 
    where('conference', 'in', ['Eastern', 'Western']));
  const recordsQuery = query(collectionGroup(db, collectionNames.seasonalRecords));
  // ↑ Fetches everything again

  const [teamsSnapshot, recordsSnapshot] = await Promise.all([
    getDocs(teamsQuery),
    getDocs(recordsQuery)  // Could have query filter
  ]);

  const seasonalRecordsMap = new Map();
  recordsSnapshot.forEach(doc => {
    if (doc.id === activeSeasonId) {  // Client-side filtering
      const teamId = doc.ref.parent.parent.id; 
      seasonalRecordsMap.set(teamId, doc.data());
    }
  });
}
```

### Example 3 - `/js/leaderboards.js` (lines 195-225)
```javascript
// ❌ INEFFICIENT
async function fetchAllPlayerStats(seasonId) {
  const playersQuery = query(collection(db, collectionNames.players));
  const statsQuery = query(collectionGroup(db, collectionNames.seasonalStats));
  // ↑ Fetches ALL player stats, all seasons

  const [playersSnap, statsSnap] = await Promise.all([
    getDocs(playersQuery),
    getDocs(statsQuery)  // Should filter to seasonId
  ]);

  // Client-side merging
  const playersMap = new Map(playersSnap.docs.map(d => [d.id, {...d.data()}]));
  statsSnap.forEach(statDoc => {
    const playerId = statDoc.ref.parent.parent.id;
    const playerData = playersMap.get(playerId);
    if (playerData) {
      playerData.stats = statDoc.data();
    }
  });
}
```

**Files with Same Issue:**
- `/js/RKL-S9.js` (line 74)
- `/js/teams.js` (line 95)
- `/js/standings.js` (line 42)
- `/js/leaderboards.js` (line 197)
- `/js/player.js` (line 84-86)
- `/js/postseason-player.js` (similar pattern)
- `/js/postseason-team.js` (similar pattern)
- `/js/draft-capital.js` (line 77-82)

---

## Issue 2: N+1 Query Pattern - One Query Per Item

### Problem Pattern
Fetch all items, then fetch nested data for each item individually.

### Example 1 - `/js/team.js` (lines 74-115)
```javascript
// ❌ INEFFICIENT - N+1 Pattern
async function loadPageData() {
  // First: Get ALL teams
  const allTeamsSnap = await getDocs(collection(db, collectionNames.teams));
  
  // Second: For EACH team, get its seasonal record separately
  const teamRecordPromises = allTeamsSnap.docs.map(teamDoc =>
    getDoc(doc(db, collectionNames.teams, teamDoc.id, collectionNames.seasonalRecords, ACTIVE_SEASON_ID))
  );
  // ↑ This creates 30 separate reads for 30 teams
  
  const allTeamsRecordsPromise = Promise.all(teamRecordPromises);
  
  // Result: 1 read for all teams + 30 reads for individual seasonal records = 31 reads
  // Just to build a helper map used in getTeamName()!
}
```

**Cost Analysis:**
- Get teams: 1 read
- Get seasonal records for team 1-30: 30 reads
- **Total: 31 reads** (could be 2-3 with proper queries)

**Fix Options:**

Option A: Use collection group with filter
```javascript
// ✅ BETTER - Use filtered collection group query
const allTeamsSnap = await getDocs(collection(db, collectionNames.teams));
const recordsQuery = query(
  collectionGroup(db, collectionNames.seasonalRecords),
  where('__name__', '==', ACTIVE_SEASON_ID)
);
const recordsSnap = await Promise.all([
  getDocs(allTeamsSnap),
  getDocs(recordsQuery)
]);
// Result: 2 reads instead of 31
```

Option B: Store seasonal data under seasons collection
```javascript
// ✅ BEST - Restructure data
// Change from: v2_teams/{teamId}/seasonal_records/{seasonId}
// To: seasons/{seasonId}/teams_snapshot/{teamId}
const seasonTeamsSnap = await getDocs(
  collection(db, collectionNames.seasons, ACTIVE_SEASON_ID, 'teams_snapshot')
);
// Result: 1 read instead of 31
```

### Example 2 - `/js/player.js` (lines 142-145)
```javascript
// ❌ INEFFICIENT - N+1 Pattern
const playerDocs = rosterSnap.docs;
const playerSeasonalStatsPromises = playerDocs.map(pDoc =>
  getDoc(doc(db, collectionNames.players, pDoc.id, collectionNames.seasonalStats, ACTIVE_SEASON_ID))
);
// ↑ For each player on team, fetch stats separately
const playerSeasonalStatsSnaps = await Promise.all(playerSeasonalStatsPromises);

// If team has 12 players: 1 read (get roster) + 12 reads (get stats) = 13 reads
```

**Files with Same Issue:**
- `/js/team.js` (line 74-77)
- `/js/player.js` (line 142-145)
- `/js/postseason-player.js` (similar)
- `/js/postseason-team.js` (similar)

---

## Issue 3: Duplicate Code - compare.js vs comparedev.js

### Side-by-Side Comparison

#### `/js/compare.js` (uses Google Sheets)
```javascript
// /js/compare.js
document.addEventListener('DOMContentLoaded', () => {
  const SHEET_ID = '12EembQnztbdKx2-buv00--VDkEFSTuSXTRdOnTnRxq4';
  const BASE_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=`;

  async function fetchSheetData(sheetName) {
    const response = await fetch(BASE_URL + encodeURIComponent(sheetName));
    const csvText = await response.text();
    return parseCSV(csvText);
  }

  function parseCSV(csvText) {
    const lines = csvText.trim().split('\n');
    const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
    // ... 68 lines of CSV parsing ...
  }

  function parseNumber(value) {
    if (value === null || typeof value === 'undefined' || String(value).trim() === '') return 0;
    const cleaned = String(value).replace(/,/g, '').replace(/%/g, '');
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
  }

  function displayComparison() {
    // ... 150+ lines of comparison rendering ...
  }
});
```

#### `/js/comparedev.js` (uses Firebase)
```javascript
// /js/comparedev.js
import {
  db, collection, getDocs, query, where, limit, collectionGroup
} from '../js/firebase-init.js';

document.addEventListener('DOMContentLoaded', () => {
  // NO Google Sheets configuration
  
  // NO CSV parsing code

  function parseNumber(value) {
    if (value === null || typeof value === 'undefined' || String(value).trim() === '') return 0;
    const cleaned = String(value).replace(/,/g, '');
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
  }  // ← Same function, slightly different (no % handling)

  function displayComparison() {
    // ... Identical 150+ lines of comparison rendering ...
  }
});
```

### Duplication Analysis
- **Total lines:** compare.js (395) vs comparedev.js (355)
- **Common code:** ~250 lines (displayComparison, parseNumber, etc.)
- **Duplication percentage:** ~70%
- **Different sections:**
  - compare.js: 60+ lines for Google Sheets API + CSV parsing
  - comparedev.js: 12 lines for Firebase imports

### The Real Problem
When updating comparison display logic, you must update BOTH files. Example: if you find a bug in line 250 (displayComparison), you need to fix it in TWO places.

---

## Issue 4: S8/S9 Historical Season Code Duplication (6,143 Lines)

### Context: NOT Dead Code

**IMPORTANT:** The `/js/legacy/S8/` directory is NOT dead code. It's actively used by 18 HTML pages in `/S8/` directory for viewing historical Season 8 data. These files CANNOT be simply deleted.

### The Duplication Problem

13 files in `/js/legacy/S8/` are **99% identical** to their S9 counterparts. Only 2 differences:

1. Season ID: `'S8'` vs `'S9'`
2. Import paths: `../../firebase-init.js` vs `./firebase-init.js`

### Example: leaderboards-S8.js vs leaderboards.js

#### `/js/legacy/S8/leaderboards-S8.js` (666 lines)
```javascript
// Line 1
import { db, collectionNames } from '../../firebase-init.js';  // Different path

// Line 3
const SEASON_ID = 'S8';  // Different season

// Lines 4-666: IDENTICAL to leaderboards.js
```

#### `/js/leaderboards.js` (666 lines)
```javascript
// Line 1
import { db, collectionNames } from './firebase-init.js';  // Different path

// Line 3
const SEASON_ID = 'S9';  // Different season

// Lines 4-666: IDENTICAL to leaderboards-S8.js
```

**Result:** 666 lines × 2 files = 1,332 lines for what should be 666 lines of unified code.

### Files Affected (All 99% Identical)

| S9 File | S8 File | Lines | Duplication |
|---------|---------|-------|-------------|
| `/js/leaderboards.js` | `/js/legacy/S8/leaderboards-S8.js` | 666 | 99% |
| `/js/RKL-S9.js` | `/js/legacy/S8/RKL-S8.js` | 580 | 99% |
| `/js/standings.js` | `/js/legacy/S8/standings-S8.js` | 450 | 99% |
| `/js/team.js` | `/js/legacy/S8/team-S8.js` | 425 | 99% |
| `/js/player.js` | `/js/legacy/S8/player-S8.js` | 380 | 99% |
| And 8 more... | And 8 more... | ~3,000 | 99% |

**Total:** 6,143 lines of duplicated code

### The Solution: Season Parameterization

Instead of duplicating files, make code season-agnostic:

#### Before (Requires Duplicate Files)
```javascript
// /js/leaderboards.js - For S9
const SEASON_ID = 'S9';  // Hardcoded

// /js/legacy/S8/leaderboards-S8.js - For S8
const SEASON_ID = 'S8';  // Hardcoded - entire file duplicated
```

#### After (Single Unified File)
```javascript
// /js/leaderboards.js - Works for ALL seasons
const urlParams = new URLSearchParams(window.location.search);
const SEASON_ID = urlParams.get('season') || 'S9';  // Default to current season

// Now S8 pages use: leaderboards.html?season=S8
// And S9 pages use: leaderboards.html?season=S9 (or default)
```

### Implementation Steps

1. **Refactor each duplicated file** to accept season parameter:
   ```javascript
   // Add at top of each JS file
   const urlParams = new URLSearchParams(window.location.search);
   const SEASON_ID = urlParams.get('season') || 'S9';
   ```

2. **Update S8 HTML pages** (18 pages in `/S8/` directory):
   ```html
   <!-- Before -->
   <script src="../js/legacy/S8/leaderboards-S8.js"></script>

   <!-- After -->
   <script src="../js/leaderboards.js"></script>
   <!-- And add to page URL: leaderboards.html?season=S8 -->
   ```

3. **Test thoroughly** - Verify S8 historical data still displays correctly

4. **Delete `/js/legacy/S8/`** - Only after complete verification

### Benefits

- **Code reduction:** Eliminate 6,143 duplicate lines
- **Maintenance:** Fix bugs once, not twice
- **Future seasons:** S10, S11, etc. work automatically with same codebase
- **Consistency:** All seasons use same logic, same features

---

## Issue 5: Hardcoded Season IDs Across Multiple Files

### Different Season Values in Different Files

| File | Line | Code | Status |
|------|------|------|--------|
| `/js/leaderboards.js` | 3 | `const SEASON_ID = 'S9'` | Current |
| `/js/player.js` | 6 | `const SEASON_ID = 'S9'` | Current |
| `/js/team.js` | 18 | `const ACTIVE_SEASON_ID = 'S9'` | Current |
| `/js/teams.js` | 14 | `const SEASON_ID = 'S9'` | Current |
| `/js/postseason-leaderboards.js` | 4 | `const SEASON_ID = 'S8'` | **WRONG - Behind!** |
| `/js/postseason-team.js` | 18 | `const ACTIVE_SEASON_ID = 'S8'` | **WRONG - Behind!** |
| `/js/transactions.js` | 16 | `const ACTIVE_SEASON_ID = "S9"` | Current |
| `/js/RKL-S9.js` | 4 | `const USE_DEV_COLLECTIONS = false` | Config |
| `/js/draft-capital.js` | 14 | `let currentSeason = 10` | Current |

### The Problem

When season changes from S9 to S10, you must update 9 different files. If you miss one:

```javascript
// Current state (after season change to S10)
// /js/leaderboards.js - Fixed ✓
const SEASON_ID = 'S10';

// /js/postseason-leaderboards.js - FORGOTTEN ✗
const SEASON_ID = 'S8';  // User sees old postseason data!

// /js/player.js - Fixed ✓
const SEASON_ID = 'S10';
```

### Solution

Create single source of truth in `/js/firebase-init.js`:

```javascript
// /js/firebase-init.js
let activeSeasonId = null;

async function fetchActiveSeason() {
  const query = query(collection(db, collectionNames.seasons), where('status', '==', 'active'), limit(1));
  const snap = await getDocs(query);
  activeSeasonId = snap.docs[0].id;
  return activeSeasonId;
}

export async function getActiveSeason() {
  if (!activeSeasonId) {
    await fetchActiveSeason();
  }
  return activeSeasonId;
}
```

Then in all other files:
```javascript
// ✅ Instead of hardcoded constant
import { getActiveSeason } from './firebase-init.js';

const activeSeasonId = await getActiveSeason();
// Now single source of truth - automatically uses current season
```

---

## Issue 6: Duplicate Utility Functions

### escapeHTML() - 4 Different Implementations

#### Location 1 - `/js/RKL-S9.js` (lines 42-49)
```javascript
function escapeHTML(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
```

#### Location 2 - `/js/schedule.js` (line 37)
```javascript
const escapeHTML = (str) => String(str)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');
```

#### Location 3 - `/js/draft-capital.js` (lines 20-27)
```javascript
function escapeHTML(str) {
  if (typeof str !== 'string') return str; 
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
}
```

#### Location 4 - `/js/leaderboards.js`
```javascript
// Referenced but implemented inline elsewhere
```

### Impact
If you find a bug in HTML escaping (e.g., not handling CDATA sections), you must fix it in 4 places.

### Solution: Create `/js/utils/formatters.js`

```javascript
// /js/utils/formatters.js
export function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function formatKarma(value) {
  return Math.round(parseFloat(value || 0)).toLocaleString();
}

export function formatRank(value) {
  if (value === null || typeof value === 'undefined' || String(value).trim() === '') return '-';
  const numValue = parseFloat(String(value));
  if (isNaN(numValue) || numValue <= 0) return '-';
  const rank = Math.round(numValue);
  return rank > 0 ? rank : '-';
}

export function parseNumber(value) {
  if (value === null || typeof value === 'undefined' || String(value).trim() === '') return 0;
  const cleaned = String(value).replace(/,/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? 0 : parsed;
}

export function formatDate(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function formatDateShort(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = String(date.getFullYear()).slice(-2);
  return `${month}/${day}/${year}`;
}
```

Then in all files:
```javascript
// Instead of defining locally
import { escapeHTML, formatKarma, formatRank, parseNumber, formatDate } from './utils/formatters.js';
```

---

## Issue 7: Image Loading - Excessive Edge Requests on Vercel

### The Problem

Team logos account for a **large percentage of Vercel edge requests** because:
1. No HTTP cache headers → logos reload on every page refresh
2. No lazy loading → all logos load immediately
3. Large PNG files not converted to WebP
4. Dynamic CSS injection instead of static files

### Statistics

- **47 team logos** in `/icons/` directory (7.8 MB total)
- **Schedule page:** 100+ logo requests
- **Leaderboards page:** 50+ logo requests (1 per player row)
- **Each page refresh:** Full reload of all logos (no caching)
- **EAST.png:** 1.1 MB (should be WebP)
- **EGM.png:** 2.9 MB (should be WebP)

### Missing Optimizations

#### 1. No HTTP Cache Headers
```javascript
// Current: No cache headers configured
// Logos reload on every page refresh, causing excessive edge requests

// ✅ Solution: Add to vercel.json
{
  "headers": [
    {
      "source": "/icons/(.*)",
      "headers": [
        {
          "key": "Cache-Control",
          "value": "public, max-age=31536000, immutable"
        }
      ]
    }
  ]
}
```

#### 2. No Lazy Loading
```javascript
// ❌ Current (all 31+ instances)
<img src="../icons/${team.id}.webp" alt="${team.team_name}" class="team-logo">

// ✅ With lazy loading
<img src="../icons/${team.id}.webp"
     alt="${team.team_name}"
     class="team-logo"
     loading="lazy">  // Only loads when scrolled into view
```

#### 3. Large PNG Files Not Optimized
```bash
# Current sizes:
/icons/EAST.png - 1.1 MB
/icons/EGM.png - 2.9 MB
Total: 4 MB (50% of icon directory)

# After converting to WebP:
/icons/EAST.webp - ~200 KB (80% reduction)
/icons/EGM.webp - ~500 KB (83% reduction)
Total: ~700 KB (82% reduction in 4 MB)
```

#### 4. Dynamic CSS Injection
```javascript
// ❌ Current - /js/player.js (lines 18-40)
function generateIconStylesheet(teams) {
  let styleContent = '<style>';
  teams.forEach(team => {
    styleContent += `.team-icon-${team.id} {
      background-image: url(../icons/${team.id}.webp);
    }`;
  });
  styleContent += '</style>';
  document.head.insertAdjacentHTML('beforeend', styleContent);
}
// This runs on every player page load, creating CSS dynamically

// ✅ Solution: Pre-generate /css/team-logos.css
/* Static file generated once */
.team-icon-FA { background-image: url(/icons/FA.webp); }
.team-icon-ATL { background-image: url(/icons/ATL.webp); }
/* ... all teams ... */
```

### Implementation Priority

**Quick Wins (2-4 hours):**
1. Add cache headers to `vercel.json`
2. Add `loading="lazy"` to all 31+ img tags
3. Convert EAST.png and EGM.png to WebP
4. Create static `/css/team-logos.css`

**Expected Impact:**
- **Edge requests:** 60-80% reduction (caching prevents reloads)
- **Page load:** 15-20% faster (lazy loading + WebP)
- **Bandwidth:** 4 MB saved per full site visit

---

## Issue 8: All-Star Icon Format Check Duplicated

### Problem Location - `/js/main.js` (lines 147-148)

```javascript
// ❌ This check happens EVERY time generateLineupTable() is called
export function generateLineupTable(lineups, team, isWinner, isLive = false) {
  if (!team) return '<div>Team data not found</div>';
  
  const allStarTeamIds = ["EAST", "WEST", "EGM", "WGM", "RSE", "RSW"];
  // ↑ Array recreation on every call
  
  const iconExt = team.id && allStarTeamIds.includes(team.id) ? 'png' : 'webp';
  // ↑ .includes() check on every call
  
  return `<img src="../icons/${team.id}.${iconExt}" ...>`;
}
```

### Usage Count
This function is called:
- Schedule page: 5-10 times per page load (recent games)
- Team page: 12+ times (for roster)
- Player page: Multiple times (for game lineups)
- **Total:** 50+ times per user session

So the allStarTeamIds array is created and the .includes() check happens 50+ times with identical results.

### Solution: Move to firebase-init.js

```javascript
// /js/firebase-init.js
export const ALL_STAR_TEAM_IDS = ["EAST", "WEST", "EGM", "WGM", "RSE", "RSW"];

export function getIconExtension(teamId) {
  return ALL_STAR_TEAM_IDS.includes(teamId) ? 'png' : 'webp';
}
```

Then in `/js/main.js`:
```javascript
import { getIconExtension } from './firebase-init.js';

export function generateLineupTable(lineups, team, isWinner, isLive = false) {
  if (!team) return '<div>Team data not found</div>';
  
  const iconExt = getIconExtension(team.id);  // Pre-computed
  
  return `<img src="../icons/${team.id}.${iconExt}" ...>`;
}
```

---

## Issue 9: Large Tables Regenerated on Tab Switch

### Problem Location - `/js/leaderboards.js` (~600 lines)

```javascript
// User clicks "REL Median" tab
function displayLeaderboard(categoryKey) {
  // This function:
  // 1. Filters data: O(n)
  // 2. Sorts data: O(n log n)
  // 3. Creates HTML string for 500 rows: O(n)
  // 4. Replaces entire tbody: O(n) DOM updates
  
  const filteredPlayers = allPlayersData.filter(p => p.category === categoryKey);
  
  const html = filteredPlayers.map(p => `
    <tr>
      <td>${p.rank}</td>
      <td><a href="player.html?id=${p.id}">${p.player_handle}</a></td>
      <td>${Math.round(p.total_points).toLocaleString()}</td>
      <td>${p.games_played}</td>
    </tr>
  `).join('');
  
  tbody.innerHTML = html;  // ← Full DOM replacement
}

// User clicks different tab → ENTIRE PROCESS REPEATS
// Every single row's HTML is regenerated, even though only data changed
```

### Impact
- Leaderboards page has 16 different categories
- Each category has 500+ rows
- User clicking between tabs causes 500+ row regenerations
- No caching of DOM structure

### Solution: Cache DOM, Update Data
```javascript
// Better approach:
const tableCache = {};  // Store created tbody references

function getOrCreateLeaderboardDOM(categoryKey) {
  if (tableCache[categoryKey]) {
    return tableCache[categoryKey];
  }
  
  // Create once
  const tbody = document.createElement('tbody');
  tableCache[categoryKey] = tbody;
  return tbody;
}

function updateLeaderboardData(categoryKey, players) {
  const tbody = getOrCreateLeaderboardDOM(categoryKey);
  
  // Update existing DOM instead of regenerating
  const rows = tbody.querySelectorAll('tr');
  players.forEach((p, index) => {
    if (rows[index]) {
      rows[index].cells[0].textContent = p.rank;
      rows[index].cells[1].textContent = p.player_handle;
      rows[index].cells[2].textContent = Math.round(p.total_points).toLocaleString();
    } else {
      // Only create missing rows
      const newRow = tbody.insertRow();
      // ... populate cells ...
    }
  });
}
```

---

## Summary: Total Code Issues Found

| Category | Count | Files | Example |
|----------|-------|-------|---------|
| Collection group queries unfiltered | 8+ | teams.js, standings.js, leaderboards.js | Load all seasons |
| N+1 query patterns | 5+ | team.js, player.js | 31 reads for helper map |
| Duplicate files | 2 | compare.js, comparedev.js | 70% same code |
| Hardcoded season IDs | 9 | Multiple files | Manual update needed |
| Duplicate utilities | 15+ | Multiple files | escapeHTML x4 |
| Image path inconsistencies | 20+ | Multiple files | 3 different patterns |
| Image loading onerror handlers | 31 | Multiple files | Inefficient fallbacks |
| Unused data fetched | 3+ | team.js, RKL-S9.js | Loads but doesn't use |

