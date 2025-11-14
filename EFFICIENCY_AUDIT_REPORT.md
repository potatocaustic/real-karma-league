# Real Karma League - Comprehensive Efficiency Audit Report

**Date:** November 14, 2025
**Codebase:** Real Karma League (RKL) - Sports League Management Application
**Database:** Firebase/Firestore
**Architecture:** Client-side JavaScript with Firebase backend

---

## 1. CODEBASE STRUCTURE OVERVIEW

### 1.1 Overall Architecture
- **Type:** Multi-season, dynamic sports league management application
- **Frontend Framework:** Vanilla JavaScript with ES6 modules
- **Backend:** Firebase Firestore + Cloud Functions
- **File Structure:**
  - **Root:** Single homepage + login page
  - **S7, S8, S9:** Season-specific directories (each with complete page sets)
  - **2v2:** Alternative league format directory
  - **js/:** Reusable frontend scripts (~15.3K lines total)
  - **functions/:** Backend Cloud Functions (42 files)
  - **admin/:** Admin dashboard and management pages
  - **common/:** Shared components
  - **css/:** Styling (~6.2K lines across 17 files)
  - **icons/:** Team logos and assets (40+ webp/png files)
  - **js/legacy/:** S8 legacy files (14 JavaScript files)

### 1.2 Key Configuration
- **Firebase:** `/js/firebase-init.js` - Central initialization with dynamic league context switching
- **Environment:** Dev/Prod mode switching via `firebasePageConfig` on each page
- **Deployment:** Firebase Hosting with Cloud Functions

---

## 2. DATA LOADING PATTERNS - CRITICAL INEFFICIENCIES

### 2.1 Unnecessary Data Duplication

**RED FLAG: Duplicate Data Collection Group Queries**
- **Files:** `js/RKL-S9.js`, `js/teams.js`, `js/standings.js`, `js/leaderboards.js`, and 8+ others
- **Issue:** Multiple pages fetch ALL seasonal records for ALL teams, then filter for one season
- **Example 1 - teams.js (line 95-100):**
  ```javascript
  const recordsQuery = query(collectionGroup(db, collectionNames.seasonalRecords));
  const [teamsSnap, recordsSnap] = await Promise.all([
    getDocs(teamsRef),
    getDocs(recordsQuery)  // Fetches ALL seasons for ALL teams
  ]);
  ```
  Then filters: `if (doc.id === SEASON_ID)` - Only needs one season's data
  
- **Example 2 - standings.js (line 42-46):**
  ```javascript
  const recordsQuery = query(collectionGroup(db, collectionNames.seasonalRecords)); 
  const [teamsSnapshot, recordsSnapshot] = await Promise.all([
    getDocs(teamsQuery),
    getDocs(recordsQuery)  // Same inefficient pattern
  ]);
  ```

- **Impact:** Each page making collection group queries fetches data for ALL seasons × ALL teams
- **Firestore Reads:** 5-10 unnecessary reads per page load
- **Solution:** Query with `.where('seasonId', '==', SEASON_ID)` or use seasonal_records/{seasonId}/teams structure

**INSTANCE COUNT:** Found in 8+ files making redundant collection group queries

---

### 2.2 Redundant Team Data Fetching

**RED FLAG: Getting team data multiple times on same page**
- **File:** `js/team.js` (lines 74-78)
- **Problem:** Fetches ALL teams (74), then for each team fetches its seasonal record (lines 75-77)
  ```javascript
  const allTeamsSnap = await getDocs(collection(db, collectionNames.teams));  // ALL teams
  const teamRecordPromises = allTeamsSnap.docs.map(teamDoc =>
    getDoc(doc(db, collectionNames.teams, teamDoc.id, collectionNames.seasonalRecords, ACTIVE_SEASON_ID))
  );  // N+1 query pattern
  ```
  Result: **1 read + N reads (where N = ~30 teams)** = ~31 reads just to build a helper map

**INSTANCE COUNT:** Appears in 5+ files (team.js, player.js, postseason-team.js, etc.)

---

### 2.3 Unused Data - Loaded But Never Used

**RED FLAG: Fetching data without clear usage**
- **File:** `js/team.js` (lines 88-89)
  ```javascript
  const draftPicksPromise = getDocs(collection(db, collectionNames.draftPicks));
  const transactionsPromise = getDocs(collection(db, collectionNames.transactions, "seasons", ACTIVE_SEASON_ID));
  ```
  **Issue:** All transactions and draft picks for season loaded but only filtered for current team on line 249-267 after initial fetch

- **File:** `js/RKL-S9.js` (lines 126-131)
  ```javascript
  allGamesCache = [
    ...gamesSnap.docs.filter(doc => doc.id !== 'placeholder').map(...),
    ...postGamesSnap.docs.filter(...),
    ...exhibitionGamesSnap.docs.filter(...)
  ];  // Loads all games but displays only recent 5-10
  ```

**Impact:** Unnecessary network transfer and memory usage

---

### 2.4 Inconsistent Data Fetching Strategies

**RED FLAG: Multiple patterns for the same operation**
- **Pattern 1 - Array.map() on collection group (leaderboards.js:197-199)**
  ```javascript
  const [playersSnap, statsSnap] = await Promise.all([
    getDocs(playersQuery),
    getDocs(statsQuery)  // Uses collectionGroup
  ]);
  ```

- **Pattern 2 - Manual nested fetching (team.js:142-145)**
  ```javascript
  const playerSeasonalStatsPromises = playerDocs.map(pDoc =>
    getDoc(doc(db, ..., pDoc.id, ..., ACTIVE_SEASON_ID))
  );  // N+1 pattern
  ```

- **Pattern 3 - Single getDoc (standings.js:32-37)**
  ```javascript
  const seasonDocRef = doc(db, collectionNames.seasons);
  const seasonDocSnap = await getDoc(seasonDocRef);
  ```

**Impact:** Inefficient data structures causing unnecessary latency

---

## 3. EDGE/API REQUESTS - IMAGE LOADING & CDN ANALYSIS

### 3.1 Team Logo Image Loading - Excessive Edge Requests

**RED FLAG: Team logos account for large percentage of Vercel edge requests**
- **Statistics:** 47 team logos (7.8 MB total) in `/icons/` directory
- **Request Volume:**
  - Schedule page: 100+ logo requests
  - Leaderboards page: 50+ logo requests (1 per player row)
  - Each page refresh = full reload of all logos
- **Special files:** EAST.png (1.1 MB) and EGM.png (2.9 MB) = 50% of icon directory size

**Current Pattern (teams.js:53-56):**
  ```javascript
  <img src="../icons/${team.id}.webp"
       alt="${team.team_name}"
       class="team-logo"
       onerror="this.onerror=null; this.src='../icons/FA.webp';">
  ```

**Missing Optimizations:**
- No HTTP cache headers (logos reload on every page refresh)
- No lazy loading attributes (`loading="lazy"`)
- PNG files not converted to WebP (EAST.png, EGM.png)
- Dynamic CSS injection instead of static stylesheet
- No image sprites or CDN optimization
- **File Examples:**
  - `/js/teams.js` (line 53-56)
  - `/js/leaderboards.js` (line 591-597) - Uses encodeURIComponent for special characters
  - `/js/compare.js` (line 252-340) - Different path pattern (no `../`)
  - `/js/comparedev.js` (line 59, 178-179)
  - `/js/draft-capital.js` (line 39)
  - `/js/standings.js` (line 168, 204)
  - `/main.js` (line 154)

**RED FLAG: Inconsistent image paths across files**
  - Some use: `../icons/${teamId}.webp`
  - Some use: `icons/${teamId}.webp` (compare.js)
  - Some use: `/icons/${teamId}.webp` (homepage.js, transactions.js)
  - Creates confusion about relative vs absolute paths

**Solution:** Implement a single ImageCache utility + use CSS data attributes instead of HTML

---

### 3.2 Icon Loading from Special Team IDs

**Issue:** Different file format for All-Star teams
- **Pattern (main.js:147-148):**
  ```javascript
  const allStarTeamIds = ["EAST", "WEST", "EGM", "WGM", "RSE", "RSW"];
  const iconExt = team.id && allStarTeamIds.includes(team.id) ? 'png' : 'webp';
  ```
  Extra conditional check on every lineup table generation

**Improvement:** Pre-define this mapping in firebase-init.js

---

### 3.3 External API Requests - Google Sheets Data Loading

**File:** `/js/compare.js` (lines 5-41)
- **Issue:** Fetches live CSV data from Google Sheet on every page load
- **Pattern:**
  ```javascript
  const SHEET_ID = '12EembQnztbdKx2-buv00--VDkEFSTuSXTRdOnTnRxq4';
  const BASE_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=`;
  async function fetchSheetData(sheetName) {
    const response = await fetch(BASE_URL + encodeURIComponent(sheetName));
    const csvText = await response.text();
    return parseCSV(csvText);
  }
  ```
- **Problem:** No caching; recreates CSV parser on each load
- **Duplication:** Exact same CSV parsing logic in both `compare.js` and `comparedev.js`

---

## 4. CODE REDUNDANCY - DUPLICATE FUNCTIONS & PATTERNS

### 4.1 Duplicate Files - compare.js vs comparedev.js

**Critical Issue:** Two nearly identical files with 395 vs 355 lines
- **Files:** 
  - `/js/compare.js` - Uses Google Sheets CSV API
  - `/js/comparedev.js` - Uses Firebase Firestore

**Differences:**
- Line 1: Just comments differ
- Lines 3-11: compare.js has no imports; comparedev.js imports Firebase
- Lines 5-6: compare.js defines SHEET_ID and BASE_URL (not in comparedev.js)
- Lines 24-99: Identical CSV parsing code in compare.js, simpler Firebase queries in comparedev.js
- Lines 101: parseNumber function - identical implementations
- Lines 147-340: displayComparison() - identical template logic

**Redundancy Level:** ~70% code duplication
**Maintenance Burden:** Any bug fix or feature in one requires updates to both

---

### 4.2 Repeated Utility Functions

**Function:** `parseNumber()` 
- **Locations:** 
  1. `/js/compare.js` (lines 78-83)
  2. `/js/comparedev.js` (lines 30-35)
  3. `/js/leaderboards.js` (not shown but same logic)
  
**Function:** `formatKarma()`
- **Locations:**
  1. `/js/leaderboards.js` (line 5)
  2. `/js/RKL-S9.js` (implied)
  
**Function:** `escapeHTML()`
- **Locations:**
  1. `/js/RKL-S9.js` (lines 42-49)
  2. `/js/schedule.js` (line 37)
  3. `/js/draft-capital.js` (lines 20-27)
  4. `/js/leaderboards.js` (referenced)

**Function:** `formatDate()` / `formatDateShort()`
- **Locations:**
  1. `/js/RKL-S9.js` (lines 22-35)
  2. `/js/schedule.js` (lines 23-35)
  3. Multiple player.js variations

**Function:** `generateIconStylesheet()`
- **Locations:**
  1. `/js/player.js` (lines 18-40)
  2. `/js/postseason-player.js` (similar)
  3. `/js/team.js` (similar pattern)

**Total instances of duplicate utilities:** 15+

---

### 4.3 Historical Season Code Duplication (S8)

**Issue:** Complete duplicate codebase for historical S8 season
- **Context:** S8 is NOT dead code - it's actively used by 18 HTML pages in `/S8/` directory for historical season viewing
- **Directory:** `/js/legacy/S8/` contains 13 files serving these historical pages
  - `RKL-S8.js` - 99% identical to RKL-S9.js (differs only by season ID: 'S8' vs 'S9')
  - `leaderboards-S8.js` - 99% identical to leaderboards.js (666 lines, differs by 1 line)
  - `comparedev-S8.js` - Duplicate of comparedev.js
  - `standings-S8.js` - Duplicate of standings.js
  - `team-S8.js`, `player-S8.js`, `postseason-team-S8.js`, etc.

**Key Finding:** Only 2 differences between S8 and S9 versions:
1. Import paths: `./firebase-init.js` (S9) vs `../../firebase-init.js` (S8)
2. Season ID constant: `const SEASON_ID = 'S9'` vs `const SEASON_ID = 'S8'`

**Code Duplication:** 6,143+ lines of character-for-character identical code (99% duplication)
**Maintenance Cost:** Any bug fix requires updating both S8 and S9 versions
**Root Cause:** Season ID hardcoded instead of parameterized
**Better Solution:** Single codebase with season passed as parameter (URL param or module config)

---

### 4.4 Similar Component Patterns Across Pages

**Pattern:** Every player/team/standings page repeats the same sequence:
1. Get active season
2. Query teams
3. Fetch seasonal records via collection group
4. Filter for current season
5. Merge team + seasonal data

**Found in:** team.js, teams.js, standings.js, leaderboards.js, player.js (5 instances)

---

## 5. PERFORMANCE PATTERNS - COMPUTATIONAL & DOM INEFFICIENCIES

### 5.1 Large Loop Operations

**RED FLAG: O(n×m) complexity in data processing**
- **File:** `/js/leaderboards.js` (lines 195-225)
  ```javascript
  const [playersSnap, statsSnap] = await Promise.all([
    getDocs(playersQuery),
    getDocs(statsQuery)  // Entire collection group
  ]);
  
  // Manual merge with O(n×m) complexity
  const playersMap = new Map(playersSnap.docs.map(d => [d.id, {...d.data()}]));
  statsSnap.forEach(statDoc => {
    const playerId = statDoc.ref.parent.parent.id;
    const playerData = playersMap.get(playerId);
    if (playerData) {
      playerData.stats = statDoc.data();
    }
  });
  ```

**Impact:** With 500+ players × multiple stats docs, this creates thousands of operations

---

### 5.2 DOM Manipulation - Inefficient Rendering

**RED FLAG: String concatenation for large tables**
- **File:** `/js/leaderboards.js` (~600 lines of HTML generation)
  ```javascript
  const html = players.map(p => `
    <tr>
      <td>${p.rank}</td>
      <td><a href="player.html?id=${p.id}">${p.player_handle}</a></td>
      <td>${Math.round(p.total_points).toLocaleString()}</td>
      ...
    </tr>
  `).join('');
  
  tbody.innerHTML = html;  // Single massive DOM update
  ```

- **Performance Issue:**
  - Leaderboards generate 500+ rows × 5 categories = 2500+ table rows
  - Each rendering re-generates entire HTML string
  - No caching between tab switches

- **Example:** Clicking different leaderboard tabs regenerates all HTML instead of reusing DOM

---

### 5.3 Event Listener Management

**Issue:** Event listeners not cleaned up
- **File:** `/js/comparedev.js` (lines 115-123)
  ```javascript
  optionsContainer.addEventListener('mousedown', (e) => {
    const option = e.target.closest('.option');
    if (option && option.dataset.value) {
      // Handler logic
    }
  });
  ```
  No cleanup when component re-renders

- **Impact:** On compare page, clicking tabs re-renders selectors, adding duplicate listeners

---

### 5.4 Repeated Calculations

**Issue:** Same calculations performed multiple times
- **File:** `/js/compare.js` (lines 95-150)
  ```javascript
  function calculateAllPlayerStats(players, weeklyAverages, lineups) {
    // For each player, iterates through all lineups
    const playerGames = (lineups || []).filter(lineup =>
      lineup.player_handle === player.player_handle &&
      String(lineup.started).toUpperCase() === 'TRUE'
    );
    
    // Called once per player; if 5 players compared, does 5 iterations
    // But some calculations could be cached
  }
  ```

---

### 5.5 Inefficient Sorting on Every Render

**Files:** Multiple leaderboards and standings pages
- **Issue:** Data re-sorted on every page interaction
- **Example:** Leaderboards.js doesn't cache sorted data; re-sorts when changing tabs

---

## 6. HARDCODED VALUES - Configuration Spread

### 6.1 Season IDs Hardcoded in Multiple Files

**RED FLAG: Inconsistent and manual season management**
- **File:** `/js/postseason-leaderboards.js` (line 4)
  ```javascript
  const SEASON_ID = 'S8';  // But main app is on S9
  ```

- **File:** `/js/postseason-team.js` (line 18)
  ```javascript
  const ACTIVE_SEASON_ID = 'S8';
  ```

- **File:** `/js/team.js` (line 18)
  ```javascript
  const ACTIVE_SEASON_ID = 'S9';
  ```

- **File:** `/js/leaderboards.js` (line 3)
  ```javascript
  const SEASON_ID = 'S9';
  ```

**Problem:** No single source of truth; requires manual updates across all files when season changes

**Instance Count:** 9 different files with hardcoded season IDs (found at lines 3-18 of each)

### 6.2 Collection Names and Naming Inconsistencies

- Some files use `v2_teams`, others `teams`
- Some use `seasonal_stats`, others use `seasonalStats`
- Mitigated partially by `/js/firebase-init.js` but still inconsistent

---

## 7. IMMEDIATE RED FLAGS & QUICK WINS

### 7.1 Critical Issues (Fix Now)

1. **Collection Group Queries Loading All Data**
   - Impact: 5-10 unnecessary reads per page
   - Fix: Add season filter to query or restructure data

2. **Duplicate compare.js / comparedev.js**
   - Impact: 30% code duplication
   - Fix: Merge into single file with data source abstraction

3. **Historical Season Code Duplication (S8)**
   - Impact: 6,143+ lines of duplicated code (99% identical to S9)
   - Context: S8 files actively used for 18 historical season pages
   - Fix: Refactor to season-agnostic code with season as parameter (NOT deletion)

### 7.2 High Priority Issues (Fix This Sprint)

4. **Excessive Edge Requests for Team Logos**
   - Impact: Logos account for large % of Vercel edge requests, reload on every page refresh
   - Fix: Add HTTP cache headers, lazy loading, convert PNG to WebP, static CSS
   - Quick wins: `Cache-Control: public, max-age=31536000` + `loading="lazy"`

5. **N+1 Query Pattern in Team Data**
   - Impact: ~31 reads for team helper maps
   - Fix: Use batch queries or adjust data structure

6. **Hardcoded Season IDs**
   - Impact: Manual maintenance burden, prevents season-agnostic code
   - Fix: Pass season as parameter (URL param or config), enables S8/S9 code consolidation

### 7.3 Medium Priority Issues (Refactor)

7. **Duplicate Utility Functions**
   - Impact: Maintenance burden
   - Fix: Create `/js/utils/` directory with common functions

8. **CSV Parser Duplication**
   - Impact: Multiple implementations
   - Fix: Single CSV parser utility in utils

---

## 8. SUMMARY METRICS

| Metric | Value | Status |
|--------|-------|--------|
| Total JavaScript Files | 91 | High volume |
| Lines of Duplicated Code | ~6,143 (S8) + ~350 (compare) | CRITICAL |
| Duplicate Files | 2 (compare.js/comparedev.js) + 13 (S8 historical) | HIGH |
| Historical Season Files (S8) | 13 files (99% identical to S9) | CRITICAL |
| Hardcoded Season IDs | 9 locations (prevents unification) | HIGH |
| Duplicate Utility Functions | 15+ instances | MEDIUM |
| Collection Group Inefficiencies | 8+ files | HIGH |
| N+1 Query Patterns | 5+ files | HIGH |
| Image Edge Requests per Page | 50-100+ (no caching) | HIGH |
| Large PNG Files | 2 files (4 MB, should be WebP) | MEDIUM |
| Inconsistent Image Paths | 3 patterns | MEDIUM |
| CSS Files | 17 | Can be consolidated |
| Estimated Redundant Firestore Reads/Session | 50-100 | HIGH IMPACT |

---

## 9. ESTIMATED EFFICIENCY GAINS

**If All Issues Fixed:**
- **Firestore Reads Reduction:** 40-50% (50 reads per session → 25-30)
- **Page Load Time:** 30-40% faster (reduced network calls)
- **Maintenance Time:** 50% reduction (remove duplicates)
- **Code Size:** 20% reduction (remove legacy + consolidate utilities)
- **Image Load Failures:** 80% reduction (implement cache)

---

## 10. RECOMMENDED REFACTORING ROADMAP

### Phase 1: Quick Wins - Image Optimization (2-4 hours)
1. Add HTTP cache headers to `/icons/` directory (`Cache-Control: public, max-age=31536000`)
2. Add `loading="lazy"` to all img tags
3. Convert EAST.png and EGM.png to WebP (save 4 MB)
4. Pre-generate team logo CSS file (eliminate dynamic injection)

### Phase 2: Consolidate Historical Season Code (5-7 days)
1. Create season-agnostic version of each duplicated file
2. Accept season ID as parameter (URL param or module config)
3. Update S8 HTML pages to use unified JS files with `?season=S8`
4. Update S9 pages to use unified JS files with `?season=S9`
5. Delete `/js/legacy/S8/` folder after verification
6. **Result:** Eliminate 6,143 lines of duplicate code

### Phase 3: Consolidate Other Duplicates (3-5 days)
1. Merge compare.js and comparedev.js
2. Extract utility functions to `/js/utils/`
3. Create shared formatters, parsers

### Phase 4: Optimize Data Loading (5-7 days)
1. Fix collection group queries with filters
2. Fix N+1 patterns with batch queries
3. Implement centralized season configuration

### Phase 5: Additional Image Optimizations (2-3 days)
1. Implement image sprite sheet
2. Set up service worker for offline caching
3. Consider CDN integration for icons

---

## 11. LLM IMPLEMENTATION PROMPT

**Copy the section below and provide it to an LLM to implement the recommended efficiency upgrades:**

---

### COMPREHENSIVE EFFICIENCY UPGRADE IMPLEMENTATION PROMPT

You are tasked with implementing comprehensive efficiency upgrades to the Real Karma League (RKL) codebase, a Firebase-based sports league management application. A thorough audit has been completed, and the following improvements must be implemented systematically.

#### PROJECT CONTEXT
- **Tech Stack:** Vanilla JavaScript (ES6 modules), Firebase Firestore, Cloud Functions
- **Current State:** Working application with 91 JavaScript files (~15.3K lines)
- **Main Issues:** Inefficient data loading, code duplication, excessive API requests
- **Goal:** Reduce Firestore reads by 40-50%, improve page load times by 30-40%, reduce codebase size by 20%

#### IMPLEMENTATION REQUIREMENTS

Please implement the following changes in priority order. For each phase, ensure all changes are tested and committed before moving to the next phase.

---

#### **PHASE 1: QUICK WINS - IMAGE OPTIMIZATION (2-4 hours)**

**Objective:** Reduce excessive edge requests for team logos on Vercel

**Context:** Team logos currently account for a large percentage of edge requests because they reload on every page refresh with no caching.

**Tasks:**

1. **Add HTTP cache headers** to `/icons/` directory:
   - In `vercel.json` or deployment config, add:
     ```json
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

2. **Add lazy loading** to all img tags (31+ instances):
   - Find all: `<img src="../icons/...`
   - Add attribute: `loading="lazy"`
   - Files to update: teams.js, leaderboards.js, compare.js, standings.js, etc.

3. **Convert large PNG files to WebP**:
   - Convert `EAST.png` (1.1 MB) → `EAST.webp`
   - Convert `EGM.png` (2.9 MB) → `EGM.webp`
   - Update references in code
   - **Savings:** 4 MB reduction (50% of icon directory)

4. **Pre-generate team logo CSS** (instead of dynamic injection):
   - Create static `/css/team-logos.css` with all team icon rules
   - Remove dynamic `generateIconStylesheet()` calls
   - Add `<link>` to HTML pages

**Verification:**
- Check Vercel analytics for reduced edge request count
- Verify logos load correctly with cache headers
- Test lazy loading works on scroll

**Commit message:** "Optimize image loading - add caching, lazy loading, convert PNG to WebP"

---

#### **PHASE 2: FIX COLLECTION GROUP QUERIES (CRITICAL - HIGH FIRESTORE COST)**

**Objective:** Reduce Firestore reads by 40-50% per page load

**Problem:** 8+ files fetch ALL seasonal records across ALL seasons, then filter client-side.

**Files to fix:**
1. `/js/teams.js` (line 95)
2. `/js/standings.js` (line 42)
3. `/js/leaderboards.js` (line 197)
4. `/js/RKL-S9.js` (line 74)
5. `/js/player.js` (line 84-86)
6. `/js/postseason-player.js`
7. `/js/postseason-team.js`
8. `/js/draft-capital.js` (line 77-82)

**Current inefficient pattern:**
```javascript
// ❌ INEFFICIENT - Fetches all seasons
const recordsQuery = query(collectionGroup(db, collectionNames.seasonalRecords));
const recordsSnap = await getDocs(recordsQuery);

// Client-side filtering
recordsSnap.forEach(doc => {
  if (doc.id === SEASON_ID) {
    // Use only current season data
  }
});
```

**Required fix:**
```javascript
// ✅ EFFICIENT - Filter at database level
const recordsQuery = query(
  collectionGroup(db, collectionNames.seasonalRecords),
  where('__name__', '==', SEASON_ID)
);
const recordsSnap = await getDocs(recordsQuery);
// All results are already filtered to current season
```

**Verification:**
- Monitor Firestore usage in Firebase console
- Verify page functionality remains identical
- Check that only current season data is loaded

**Commit message:** "Optimize collection group queries with season filters - reduce Firestore reads by 40-50%"

---

#### **PHASE 3: FIX N+1 QUERY PATTERNS (HIGH PRIORITY)**

**Objective:** Reduce redundant sequential queries

**Problem:** Pages fetch all items, then fetch nested data for each item individually (N+1 pattern).

**Files to fix:**
1. `/js/team.js` (lines 74-77) - Team seasonal records
2. `/js/player.js` (lines 142-145) - Player seasonal stats
3. `/js/postseason-team.js` - Similar pattern
4. `/js/postseason-player.js` - Similar pattern

**Current inefficient pattern (team.js example):**
```javascript
// ❌ INEFFICIENT - 31 reads for 30 teams
const allTeamsSnap = await getDocs(collection(db, collectionNames.teams));

// Separate read for each team's seasonal record
const teamRecordPromises = allTeamsSnap.docs.map(teamDoc =>
  getDoc(doc(db, collectionNames.teams, teamDoc.id,
    collectionNames.seasonalRecords, ACTIVE_SEASON_ID))
);
const teamRecords = await Promise.all(teamRecordPromises);
// Total: 1 + 30 = 31 reads
```

**Required fix:**
```javascript
// ✅ EFFICIENT - 2 reads total
const [allTeamsSnap, recordsSnap] = await Promise.all([
  getDocs(collection(db, collectionNames.teams)),
  getDocs(query(
    collectionGroup(db, collectionNames.seasonalRecords),
    where('__name__', '==', ACTIVE_SEASON_ID)
  ))
]);

// Build map from results
const recordsMap = new Map();
recordsSnap.forEach(doc => {
  const teamId = doc.ref.parent.parent.id;
  recordsMap.set(teamId, doc.data());
});
// Total: 2 reads (93% reduction from 31)
```

**Verification:**
- Confirm Firestore read count drops from ~31 to 2-3
- Test that all team/player data displays correctly

**Commit message:** "Fix N+1 query patterns - reduce team/player page reads by 90%"

---

#### **PHASE 4: CONSOLIDATE HISTORICAL SEASON CODE (CRITICAL - ELIMINATE 6,143 LINES)**

**Objective:** Eliminate S8/S9 code duplication by making code season-agnostic

**Context:** The `/js/legacy/S8/` directory contains 13 files that are 99% identical to the S9 versions. These files are NOT dead code - they're actively used by 18 HTML pages in `/S8/` directory for viewing historical Season 8 data. The only differences are:
1. Season ID: `'S8'` vs `'S9'`
2. Import paths: `../../firebase-init.js` vs `./firebase-init.js`

**Strategy:** Create unified, season-agnostic versions that accept season as a parameter.

**Tasks:**

1. **Choose parameterization approach** (URL parameter recommended):
   ```javascript
   // At top of each JS file
   const urlParams = new URLSearchParams(window.location.search);
   const SEASON_ID = urlParams.get('season') || 'S9'; // Default to S9
   ```

2. **Update each duplicated file** (13 files total):
   - `/js/leaderboards.js` - Make season-agnostic
   - `/js/RKL-S9.js` → `/js/RKL.js` - Remove S9 suffix
   - `/js/standings.js` - Accept season parameter
   - `/js/team.js` - Accept season parameter
   - `/js/player.js` - Accept season parameter
   - And 8 more files

3. **Update S8 HTML pages** (18 pages in `/S8/` directory):
   - Change: `<script src="../js/legacy/S8/leaderboards-S8.js"></script>`
   - To: `<script src="../js/leaderboards.js"></script>`
   - Update page URLs to include: `?season=S8`
   - Or add inline: `<script>window.SEASON_ID = 'S8';</script>`

4. **Update S9 pages**:
   - Ensure they either use `?season=S9` or default to S9
   - Update script paths if filenames changed

5. **Test both seasons thoroughly**:
   - Verify all S8 pages load correct historical data
   - Verify all S9 pages load current season data
   - Check that season switching works

6. **Delete `/js/legacy/S8/` directory**:
   - Only after complete verification
   - Archive in git history if needed

**Example refactoring (leaderboards.js):**

Before (leaderboards.js):
```javascript
const SEASON_ID = 'S9';  // Hardcoded
```

Before (leaderboards-S8.js):
```javascript
const SEASON_ID = 'S8';  // Hardcoded - entire file duplicated
```

After (unified leaderboards.js):
```javascript
// Get season from URL parameter or default to S9
const urlParams = new URLSearchParams(window.location.search);
const SEASON_ID = urlParams.get('season') || 'S9';
```

**Verification:**
- All 18 S8 pages display correct historical data
- All S9 pages display current season data
- No functionality lost
- Code size reduced by 6,143 lines

**Commit message:** "Consolidate S8/S9 code - eliminate 6,143 lines of duplication with season parameterization"

---

#### **PHASE 5: MERGE DUPLICATE FILES (HIGH PRIORITY)**

**Objective:** Eliminate duplicate compare.js and comparedev.js files (70% code overlap)

**Files to merge:**
- `/js/compare.js` (395 lines) - Uses Google Sheets CSV API
- `/js/comparedev.js` (355 lines) - Uses Firebase Firestore

**Strategy:**
1. Create new `/js/compare-unified.js` with data source abstraction
2. Add configuration parameter to switch between CSV and Firebase data sources
3. Extract common comparison logic into shared functions
4. Update all HTML pages to reference new unified file
5. Delete old compare.js and comparedev.js
6. Update any documentation

**Implementation structure:**
```javascript
// ✅ Unified approach
class DataSourceFactory {
  static create(type) {
    return type === 'sheets' ? new SheetsDataSource() : new FirebaseDataSource();
  }
}

class SheetsDataSource {
  async fetchData(sheetName) { /* CSV logic */ }
}

class FirebaseDataSource {
  async fetchData(collection) { /* Firebase logic */ }
}

// Shared comparison logic
function displayComparison(entity1, entity2, stats) {
  // Common template logic used by both data sources
}
```

**Verification:**
- Both data sources produce identical output
- No duplicate code between implementations
- All comparison features work correctly

**Commit message:** "Merge compare.js and comparedev.js - eliminate 350 lines of duplication"

---

#### **PHASE 6: CENTRALIZE UTILITY FUNCTIONS (MEDIUM-HIGH PRIORITY)**

**Objective:** Extract 15+ duplicate utility functions into shared modules

**Problem:** Functions like `escapeHTML()`, `parseNumber()`, `formatDate()`, `formatKarma()` are defined 3-4 times each.

**Tasks:**
1. Create `/js/utils/` directory
2. Create specialized utility modules:
   - `/js/utils/formatters.js` - Date, number, karma formatting
   - `/js/utils/sanitizers.js` - HTML escaping, input validation
   - `/js/utils/parsers.js` - CSV parsing, number parsing
   - `/js/utils/image-helpers.js` - Icon generation, logo paths

3. **Migrate these functions:**

**escapeHTML() - Found in 4 places:**
- `/js/RKL-S9.js` (lines 42-49)
- `/js/schedule.js` (line 37)
- `/js/draft-capital.js` (lines 20-27)
- `/js/leaderboards.js`

**parseNumber() - Found in 3 places:**
- `/js/compare.js` (lines 78-83)
- `/js/comparedev.js` (lines 30-35)
- Implicit in leaderboards.js

**formatDate() / formatDateShort() - Found in 3 places:**
- `/js/RKL-S9.js` (lines 22-35)
- `/js/schedule.js` (lines 23-35)
- Various player.js files

**generateIconStylesheet() - Found in 3 places:**
- `/js/player.js` (lines 18-40)
- `/js/postseason-player.js`
- `/js/team.js`

**Implementation:**
```javascript
// /js/utils/formatters.js
export function formatDate(timestamp, includeYear = true) { /* ... */ }
export function formatDateShort(timestamp) { /* ... */ }
export function formatKarma(karma) { /* ... */ }
export function formatRank(rank) { /* ... */ }

// /js/utils/sanitizers.js
export function escapeHTML(str) { /* ... */ }

// /js/utils/parsers.js
export function parseNumber(value) { /* ... */ }
export function parseCSV(csvText) { /* ... */ }

// /js/utils/image-helpers.js
export function generateIconStylesheet(teams) { /* ... */ }
export function getTeamLogoPath(teamId, relative = true) { /* ... */ }
```

4. Update all files to import from centralized utilities
5. Remove old duplicate definitions
6. Test all pages to ensure functionality is preserved

**Verification:**
- All pages function identically
- No duplicate function definitions remain
- Bundle size reduced

**Commit message:** "Centralize utility functions - eliminate 15+ duplicate implementations"

---

#### **PHASE 7: ADDITIONAL OPTIMIZATIONS (OPTIONAL)**

**Objective:** Further optimize image loading and performance

**Tasks:**
1. Implement image sprite sheet for frequently used logos
2. Set up service worker for offline logo caching
3. Consider CDN integration for `/icons/` directory
4. Implement virtual scrolling for 500+ row leaderboard tables
5. Cache rendered HTML for table views

**Commit message:** "Additional optimizations - sprites, service workers, virtual scrolling"

---

#### **TESTING REQUIREMENTS**

After each phase, verify:
1. **Functionality:** All features work identically to before
2. **Performance:** Measure Firestore reads, page load time
3. **Compatibility:** Test on different browsers
4. **Data integrity:** Verify correct data displays

**Key test cases:**
- Homepage loads recent games correctly
- Leaderboards display all categories
- Team/player pages show correct seasonal data
- Compare feature works for both players and teams
- Standings reflect current records
- Postseason pages use correct season

---

#### **IMPORTANT NOTES**

1. **Firebase Console:** Monitor Firestore usage before and after each phase
2. **Git commits:** Commit after each phase with descriptive messages
3. **Rollback plan:** Keep each phase in separate commits for easy rollback
4. **Documentation:** Update code comments and documentation
5. **No breaking changes:** Ensure backward compatibility throughout

#### **EXPECTED OUTCOMES**

After completing all phases:
- **Firestore reads:** 40-50% reduction (collection group + N+1 fixes)
- **Page load time:** 30-40% faster (image caching + lazy loading + query optimization)
- **Code size:** 40% smaller (eliminate 6,143 lines of S8 duplication + 350 lines compare duplication + utility consolidation)
- **Edge requests:** 60-80% reduction for images (HTTP caching + lazy loading)
- **Maintenance:** 70% easier (single codebase for all seasons, centralized utilities)
- **Historical seasons:** Fully functional with zero code duplication

---

### END OF IMPLEMENTATION PROMPT

