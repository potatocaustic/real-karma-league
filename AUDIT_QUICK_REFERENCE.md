# Real Karma League - Efficiency Audit Quick Reference

## Top 10 Issues by Impact

### 1. CRITICAL: Historical Season Code Duplication (6,143 lines, 99% identical)
- **Location:** `/js/legacy/S8/` (13 files)
- **Context:** NOT dead code - actively used by 18 HTML pages in `/S8/` for historical viewing
- **Files:** RKL-S8.js (666 lines), leaderboards-S8.js (666 lines), etc. - 99% identical to S9 versions
- **Issue:** Only 2 differences from S9: (1) season ID `'S8'` vs `'S9'`, (2) import paths
- **Action:** Refactor to season-agnostic code with season as URL parameter (NOT deletion)
- **Savings:** Eliminate 6,143 duplicate lines, single codebase for all seasons

### 2. CRITICAL: Collection Group Queries Loading All Data
- **Locations:** 
  - `/js/teams.js` (line 95)
  - `/js/standings.js` (line 42)
  - `/js/leaderboards.js` (line 197)
  - `/js/RKL-S9.js` (line 74)
  - 4+ other files
- **Problem:** `getDocs(collectionGroup(db, 'seasonal_records'))` fetches ALL seasons, then filters
- **Fix:** Add `.where('seasonId', '==', SEASON_ID)` to query
- **Savings:** 5-10 Firestore reads per page (40-50% of total reads)

### 3. HIGH: Duplicate compare.js vs comparedev.js
- **Locations:** 
  - `/js/compare.js` (395 lines)
  - `/js/comparedev.js` (355 lines)
- **Duplication:** ~70% identical code
- **Difference:** compare.js uses Google Sheets API; comparedev.js uses Firebase
- **Action:** Merge into one file with data source abstraction
- **Savings:** Eliminate duplicate maintenance burden

### 4. HIGH: N+1 Query Pattern for Team Data
- **Locations:**
  - `/js/team.js` (line 74-77): Gets all teams, then each team's seasonal record individually
  - `/js/player.js` (line 142-145): Gets all players, then each player's seasonal stats
  - `/js/postseason-team.js`, `/js/postseason-player.js`
- **Pattern:** `getDocs(collection)` then `.map(doc => getDoc(...))`
- **Impact:** ~31 reads for teams page instead of 2
- **Fix:** Use `.where()` queries or batch reads
- **Savings:** 10-15 Firestore reads per page

### 5. HIGH: Hardcoded Season IDs Across 9 Files (Prevents S8/S9 Consolidation)
- **Affected Files:**
  - `/js/leaderboards.js` (line 3): `const SEASON_ID = 'S9'`
  - `/js/player.js` (line 6): `const SEASON_ID = 'S9'`
  - `/js/team.js` (line 18): `const ACTIVE_SEASON_ID = 'S9'`
  - `/js/teams.js` (line 14): `const SEASON_ID = 'S9'`
  - `/js/postseason-leaderboards.js` (line 4): `const SEASON_ID = 'S8'`
  - `/js/postseason-team.js` (line 18): `const ACTIVE_SEASON_ID = 'S8'`
  - `/js/transactions.js` (line 16): `const ACTIVE_SEASON_ID = "S9"`
  - `/js/RKL-S9.js` (line 4)
  - `/js/draft-capital.js` (line 14): `let currentSeason = 10`
- **Problem:** Prevents season-agnostic code, causes S8/S9 duplication
- **Action:** Get season from URL parameter: `new URLSearchParams(window.location.search).get('season')`
- **Savings:** Enables S8/S9 consolidation (6,143 lines), easier maintenance

### 6. MEDIUM-HIGH: Duplicate Utility Functions (15+ instances)
- **escapeHTML()** defined in 4 places:
  - `/js/RKL-S9.js` (line 42-49)
  - `/js/schedule.js` (line 37)
  - `/js/draft-capital.js` (line 20-27)
  - `/js/leaderboards.js`
  
- **parseNumber()** defined in 3 places:
  - `/js/compare.js` (line 78-83)
  - `/js/comparedev.js` (line 30-35)
  - (implicit in leaderboards.js)
  
- **formatDate() / formatDateShort()** in 3 places:
  - `/js/RKL-S9.js` (line 22-35)
  - `/js/schedule.js` (line 23-35)
  - Various player.js files
  
- **formatKarma() / formatRank()** in multiple places
  
- **generateIconStylesheet()** in 3+ files
  
- **Action:** Create `/js/utils/formatters.js` with all utilities
- **Savings:** Centralize updates, reduce bundle size

### 7. HIGH: Excessive Edge Requests for Team Logos
- **Problem:** Team logos account for large % of Vercel edge requests
- **Statistics:** 47 logos (7.8 MB), 50-100+ requests per page, reload on every refresh
- **Missing Optimizations:**
  - No HTTP cache headers (logos reload every page refresh)
  - No lazy loading attributes
  - 2 large PNG files (EAST.png 1.1 MB, EGM.png 2.9 MB) not converted to WebP
  - Dynamic CSS injection instead of static stylesheet

- **Quick Wins:**
  1. Add `Cache-Control: public, max-age=31536000, immutable` to `/icons/`
  2. Add `loading="lazy"` to all img tags
  3. Convert PNG files to WebP (save 4 MB)
  4. Pre-generate team logo CSS

- **Savings:** 60-80% reduction in edge requests, 4 MB smaller assets

### 8. MEDIUM: Inconsistent Image Paths
- **Pattern 1:** `../icons/${teamId}.webp` (most files)
- **Pattern 2:** `icons/${teamId}.webp` (compare.js, line 252)
- **Pattern 3:** `/icons/${teamId}.webp` (homepage.js, transactions.js)
- **Problem:** Confusion about relative vs absolute paths
- **Action:** Standardize to single path format
- **File Examples:**
  - `/js/teams.js` (line 53)
  - `/js/leaderboards.js` (line 591)
  - `/js/compare.js` (line 252)
  - `/js/compare.js` (line 253)
  - `/js/draft-capital.js` (line 39)

### 9. MEDIUM: All-Star Icon Format Hardcoded
- **Location:** `/js/main.js` (line 147-148)
- **Code:**
  ```javascript
  const allStarTeamIds = ["EAST", "WEST", "EGM", "WGM", "RSE", "RSW"];
  const iconExt = team.id && allStarTeamIds.includes(team.id) ? 'png' : 'webp';
  ```
- **Redundancy:** This check happens in `generateLineupTable()` which is called many times
- **Action:** Pre-compute in firebase-init.js; export as constant
- **Savings:** Small but repeated optimization

### 10. MEDIUM: Large Table Rendering Without Caching
- **Location:** `/js/leaderboards.js` (~600 lines)
- **Issue:** Entire HTML table re-generated on tab switch
- **Example:** Switching between leaderboard categories regenerates 500+ rows
- **Action:** Cache DOM nodes, swap data instead of regenerating HTML
- **Savings:** 2-3x faster tab switches

---

## Quick Win Priority List

### Do This First (2-4 hours) - Immediate Impact
1. Add HTTP cache headers to `/icons/` directory in `vercel.json`
2. Add `loading="lazy"` to all img tags (31+ instances)
3. Convert EAST.png and EGM.png to WebP format
4. Fix collection group queries with `.where()` filters (8+ files)

### Do This This Week (3-5 days)
5. Create `/js/utils/` with shared utility functions
6. Refactor S8/S9 code to accept season as URL parameter
7. Update S8 HTML pages to use unified JS files with `?season=S8`
8. Delete `/js/legacy/S8/` folder after verification

### Do This This Sprint (1-2 weeks)
9. Merge compare.js and comparedev.js
10. Fix N+1 query patterns in team/player pages
11. Pre-generate team logo CSS (remove dynamic injection)

---

## Files Requiring Updates

### Refactor for Season Parameterization (Make S8/S9 Unified):
```
/js/RKL-S9.js → /js/RKL.js (accept season param)
/js/leaderboards.js (accept season param)
/js/standings.js (accept season param)
/js/team.js (accept season param)
/js/teams.js (accept season param)
/js/player.js (accept season param)
/js/postseason-team.js (accept season param)
/js/postseason-player.js (accept season param)
/js/postseason-leaderboards.js (accept season param)
/js/draft-lottery.js (accept season param)
/js/transactions.js (accept season param)
/js/schedule.js (accept season param)
```

### Delete AFTER Refactoring (Once S8 pages use unified JS):
```
/js/legacy/S8/ (entire directory - 13 files, 6,143 lines)
```

### Priority 1 - Query Optimization:
```
/js/teams.js
/js/standings.js
/js/leaderboards.js
/js/RKL-S9.js
/js/team.js
/js/player.js
/js/postseason-player.js
/js/postseason-team.js
/js/draft-capital.js
```

### Priority 2 - Image Optimization:
```
vercel.json (CREATE or UPDATE - add cache headers for /icons/)
/icons/EAST.png → /icons/EAST.webp (convert format)
/icons/EGM.png → /icons/EGM.webp (convert format)
/css/team-logos.css (CREATE - pre-generate team icon styles)
All JS files with img tags (add loading="lazy")
```

### Priority 3 - Consolidate Utilities:
```
/js/utils/formatters.js (CREATE NEW)
/js/utils/parsers.js (CREATE NEW)
/js/utils/sanitizers.js (CREATE NEW)
Update all files to import from /js/utils/ instead of local definitions
```

### Priority 4 - Merge Duplicates:
```
/js/compare.js (MERGE with comparedev.js into unified version)
/js/comparedev.js (DELETE after merge)
```

---

## Code Change Checklist

### Phase 1: Image Optimization (Quick Wins)
- [ ] Create or update `vercel.json` - add cache headers for `/icons/`
- [ ] Convert `/icons/EAST.png` to WebP
- [ ] Convert `/icons/EGM.png` to WebP
- [ ] Add `loading="lazy"` to all img tags (31+ instances)
- [ ] Create `/css/team-logos.css` - pre-generated team icon styles

### Phase 2: Query Optimization
- [ ] Fix `/js/teams.js` - add `.where()` filter to recordsQuery
- [ ] Fix `/js/standings.js` - add `.where()` filter to recordsQuery
- [ ] Fix `/js/leaderboards.js` - add `.where()` filter to statsQuery
- [ ] Fix `/js/RKL-S9.js` - add `.where()` filter to recordsQuery
- [ ] Fix `/js/team.js` - batch queries instead of N+1
- [ ] Fix `/js/player.js` - batch queries instead of N+1
- [ ] Fix 2+ other files with collection group queries

### Phase 3: S8/S9 Consolidation
- [ ] Refactor 13 JS files to accept season from URL parameter
- [ ] Update 18 S8 HTML pages to use unified JS files with `?season=S8`
- [ ] Test S8 pages thoroughly
- [ ] Test S9 pages thoroughly
- [ ] Delete `/js/legacy/S8/` folder (only after complete verification)

### Phase 4: Other Consolidations
- [ ] Create `/js/utils/formatters.js` - escapeHTML, formatKarma, formatRank, formatDate
- [ ] Create `/js/utils/parsers.js` - parseNumber, parseCSV
- [ ] Create `/js/utils/sanitizers.js` - HTML escaping
- [ ] Merge `/js/compare.js` and `/js/comparedev.js`
- [ ] Update all files to use centralized utilities

---

## Estimated Impact

| Fix | Firestore Reads | Page Speed | Code Size | Edge Requests | Maintenance |
|-----|-----------------|-----------|-----------|---------------|------------|
| Image caching + lazy loading | - | +15% | 0% | -70% | 0% |
| Convert PNG to WebP | - | +5% | -25% | -10% | 0% |
| Fix collection group queries | -40% | +10% | 0% | - | 0% |
| Fix N+1 queries | -15% | +8% | 0% | - | 0% |
| S8/S9 consolidation | 0% | 0% | -40% | - | -70% |
| Merge compare.js | 0% | +1% | -2% | - | -30% |
| Consolidate utilities | 0% | +1% | -3% | - | -20% |
| **TOTAL** | **-55% reads** | **+40%** | **-70%** | **-80%** | **-70%** |

