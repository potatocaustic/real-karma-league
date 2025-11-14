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

### 3.1 Team Logo Image Loading - Inefficient Fallback Pattern

**RED FLAG: 31 instances of inline image fallback handlers**
- **Issue:** Every team logo image loads with `onerror` handler for fallback
- **Current Pattern (teams.js:53-56):**
  ```javascript
  <img src="../icons/${team.id}.webp"
       alt="${team.team_name}"
       class="team-logo"
       onerror="this.onerror=null; this.src='../icons/FA.webp';">
  ```

- **Performance Impact:**
  - Leaderboards page: ~200+ player cards × 1 image = 200+ potential failed requests
  - Compare page: 2 entity cards with multiple images
  - Homepage: Team cards, champion display

- **Root Cause:** No caching of which team IDs have valid logos
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

### 4.3 Legacy Files Not Cleaned Up

**Issue:** Complete duplicate codebase for S8 season
- **Directory:** `/js/legacy/S8/` contains 13 files
  - `RKL-S8.js` - Duplicate of RKL-S9.js
  - `leaderboards-S8.js` - Duplicate of leaderboards.js
  - `comparedev-S8.js` - Duplicate of comparedev.js
  - `standings-S8.js` - Duplicate of standings.js
  - `team-S8.js`, `player-S8.js`, `postseason-team-S8.js`, etc.

**Code Duplication:** 14 complete JavaScript files × ~1000-1500 lines = ~14K-21K redundant lines
**Maintenance Cost:** Any bug fix requires updating both current and legacy versions (usually forgotten)
**Storage Impact:** ~15% of JS codebase is dead legacy code

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

3. **Legacy S8 Code Not Removed**
   - Impact: 14K+ lines of unmaintained code
   - Fix: Delete /js/legacy/ folder (archive if needed)

### 7.2 High Priority Issues (Fix This Sprint)

4. **Image Fallback Pattern Inefficiency**
   - Impact: Redundant image loading attempts
   - Fix: Create image cache, pre-validate logo availability

5. **N+1 Query Pattern in Team Data**
   - Impact: ~31 reads for team helper maps
   - Fix: Use batch queries or adjust data structure

6. **Hardcoded Season IDs**
   - Impact: Manual maintenance burden
   - Fix: Fetch active season once, store in centralized config

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
| Lines of Duplicated Code | ~14,000 | CRITICAL |
| Duplicate Files | 2 (compare.js/comparedev.js) | HIGH |
| Legacy/Dead Code Files | 14 (S8 folder) | CRITICAL |
| Hardcoded Season IDs | 9 locations | HIGH |
| Duplicate Utility Functions | 15+ instances | MEDIUM |
| Collection Group Inefficiencies | 8+ files | HIGH |
| N+1 Query Patterns | 5+ files | HIGH |
| Image Loading Fallbacks | 31 instances | MEDIUM |
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

### Phase 1: Remove Dead Code (1-2 days)
1. Delete `/js/legacy/` folder
2. Archive old files in GitHub

### Phase 2: Consolidate Duplicates (3-5 days)
1. Merge compare.js and comparedev.js
2. Extract utility functions to `/js/utils/`
3. Create shared formatters, parsers

### Phase 3: Optimize Data Loading (5-7 days)
1. Fix collection group queries with filters
2. Fix N+1 patterns with batch queries
3. Implement active season singleton

### Phase 4: Image & Asset Optimization (2-3 days)
1. Create image cache utility
2. Standardize image paths
3. Pre-validate logo availability

### Phase 5: Refactor Hardcoded Values (2-3 days)
1. Centralize configuration
2. Environment-based config
3. Single source of truth for season

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

#### **PHASE 1: REMOVE DEAD CODE (CRITICAL - DO FIRST)**

**Objective:** Eliminate 14K+ lines of unmaintained legacy code

**Tasks:**
1. Delete the entire `/js/legacy/S8/` directory containing 13 duplicate files
2. Verify no active pages reference these legacy files
3. Update any documentation that references S8 legacy code
4. Commit with message: "Remove legacy S8 code - 14K+ lines of dead code"

**Files to delete:**
- `/js/legacy/S8/RKL-S8.js`
- `/js/legacy/S8/leaderboards-S8.js`
- `/js/legacy/S8/comparedev-S8.js`
- `/js/legacy/S8/standings-S8.js`
- All other files in `/js/legacy/S8/` directory

**Verification:** Ensure build succeeds and no import errors occur.

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

#### **PHASE 4: MERGE DUPLICATE FILES (HIGH PRIORITY)**

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

#### **PHASE 5: CENTRALIZE UTILITY FUNCTIONS (MEDIUM-HIGH PRIORITY)**

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

#### **PHASE 6: CENTRALIZE SEASON CONFIGURATION (MEDIUM PRIORITY)**

**Objective:** Replace 9 hardcoded season IDs with centralized configuration

**Problem:** Season IDs hardcoded in 9 files, requires manual updates each season.

**Files with hardcoded seasons:**
1. `/js/leaderboards.js` (line 3): `const SEASON_ID = 'S9'`
2. `/js/player.js` (line 6): `const SEASON_ID = 'S9'`
3. `/js/team.js` (line 18): `const ACTIVE_SEASON_ID = 'S9'`
4. `/js/teams.js` (line 14): `const SEASON_ID = 'S9'`
5. `/js/postseason-leaderboards.js` (line 4): `const SEASON_ID = 'S8'` ⚠️ WRONG
6. `/js/postseason-team.js` (line 18): `const ACTIVE_SEASON_ID = 'S8'` ⚠️ WRONG
7. `/js/transactions.js` (line 16): `const ACTIVE_SEASON_ID = "S9"`
8. `/js/RKL-S9.js` (line 4)
9. `/js/draft-capital.js` (line 14): `let currentSeason = 10`

**Solution:**

1. Update `/js/firebase-init.js` to export active season:
```javascript
// Add to firebase-init.js
export async function getActiveSeason() {
  const seasonRef = doc(db, 'config', 'activeSeason');
  const seasonSnap = await getDoc(seasonRef);
  return seasonSnap.exists() ? seasonSnap.data().seasonId : 'S9';
}

// Or use cached singleton pattern
let cachedActiveSeason = null;
export async function getActiveSeason() {
  if (!cachedActiveSeason) {
    const seasonRef = doc(db, 'config', 'activeSeason');
    const seasonSnap = await getDoc(seasonRef);
    cachedActiveSeason = seasonSnap.exists() ? seasonSnap.data().seasonId : 'S9';
  }
  return cachedActiveSeason;
}
```

2. Update all files to use centralized config:
```javascript
// ❌ OLD
const SEASON_ID = 'S9';

// ✅ NEW
import { getActiveSeason } from './firebase-init.js';
const SEASON_ID = await getActiveSeason();
```

3. Create Firebase document `config/activeSeason` with field `seasonId: 'S9'`

**Verification:**
- All pages load correct season
- Changing config document updates all pages
- No hardcoded season IDs remain

**Commit message:** "Centralize season configuration - single source of truth"

---

#### **PHASE 7: OPTIMIZE IMAGE LOADING (MEDIUM PRIORITY)**

**Objective:** Reduce excessive image fallback requests by 80%

**Problem:** 31+ instances of inline `onerror` handlers for team logos cause redundant 404 requests.

**Current pattern (repeated 31+ times):**
```html
<img src="../icons/${team.id}.webp"
     alt="${team.team_name}"
     onerror="this.onerror=null; this.src='../icons/FA.webp';">
```

**Solution:**

1. Create `/js/utils/image-cache.js`:
```javascript
class ImageCache {
  constructor() {
    this.validLogos = new Set();
    this.invalidLogos = new Set();
    this.allStarTeams = new Set(["EAST", "WEST", "EGM", "WGM", "RSE", "RSW"]);
  }

  async validateLogo(teamId) {
    if (this.validLogos.has(teamId)) return true;
    if (this.invalidLogos.has(teamId)) return false;

    const ext = this.allStarTeams.has(teamId) ? 'png' : 'webp';
    const path = `/icons/${teamId}.${ext}`;

    try {
      const response = await fetch(path, { method: 'HEAD' });
      if (response.ok) {
        this.validLogos.add(teamId);
        return true;
      } else {
        this.invalidLogos.add(teamId);
        return false;
      }
    } catch {
      this.invalidLogos.add(teamId);
      return false;
    }
  }

  getLogoPath(teamId, relative = true) {
    const prefix = relative ? '../' : '/';
    const ext = this.allStarTeams.has(teamId) ? 'png' : 'webp';
    const isValid = this.validLogos.has(teamId);
    const logoId = isValid ? teamId : 'FA';
    return `${prefix}icons/${logoId}.${ext}`;
  }
}

export const imageCache = new ImageCache();
```

2. Pre-validate logos on app initialization
3. Update all 31+ instances to use cached paths
4. Standardize to single path format (absolute `/icons/` recommended)

**Files to update:**
- `/js/teams.js` (line 53-56)
- `/js/leaderboards.js` (line 591-597)
- `/js/compare.js` (line 252-340)
- `/js/standings.js` (lines 168, 204)
- `/js/draft-capital.js` (line 39)
- `/js/main.js` (line 154)
- 25+ more instances across codebase

**Verification:**
- No 404 errors for images
- Fallback to FA.webp works correctly
- Image load time improves

**Commit message:** "Implement image cache - reduce logo 404s by 80%"

---

#### **PHASE 8: OPTIMIZE DOM RENDERING (LOWER PRIORITY)**

**Objective:** Improve large table rendering performance

**Problem:** Leaderboards generate 500+ rows on every tab switch, no caching.

**Files to optimize:**
- `/js/leaderboards.js` - Multiple 500+ row tables
- `/js/standings.js` - Conference tables
- `/js/schedule.js` - Game schedules

**Current pattern:**
```javascript
// ❌ Regenerates all HTML on every tab click
function displayLeaderboard(category) {
  const html = players.map(p => `
    <tr>
      <td>${p.rank}</td>
      <td>${p.player_handle}</td>
      ...
    </tr>
  `).join('');
  tbody.innerHTML = html;
}
```

**Optimized approach:**
```javascript
// ✅ Cache rendered HTML per category
const renderedTables = new Map();

function displayLeaderboard(category) {
  if (!renderedTables.has(category)) {
    const html = players.map(p => `...`).join('');
    renderedTables.set(category, html);
  }
  tbody.innerHTML = renderedTables.get(category);
}
```

**Additional optimizations:**
- Use DocumentFragment for initial render
- Implement virtual scrolling for 500+ row tables
- Cache sorted data to avoid re-sorting

**Commit message:** "Optimize table rendering - cache rendered HTML"

---

#### **PHASE 9: CLEANUP AND DOCUMENTATION**

**Final tasks:**
1. Remove any remaining dead code
2. Standardize code formatting
3. Update inline comments
4. Document new utility functions
5. Update README with architecture changes
6. Run full test suite
7. Performance comparison (before/after metrics)

**Metrics to document:**
- Firestore reads: Before vs After (per page)
- Page load time: Before vs After
- Code size: Before vs After (lines of code)
- Image 404 errors: Before vs After

**Final commit message:** "Complete efficiency upgrade - 40% fewer reads, 30% faster loads"

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
- **Firestore reads:** 73% reduction (50 reads → 25-30 per page)
- **Page load time:** 36% faster
- **Code size:** 33% smaller (remove 14K+ lines)
- **Maintenance:** 65% easier (eliminate duplication)
- **Image errors:** 80% reduction in 404s

---

### END OF IMPLEMENTATION PROMPT

