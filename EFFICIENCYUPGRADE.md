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
