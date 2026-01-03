# S6 Season Reconstruction - Handoff Document

## Overview

This document provides a comprehensive handoff for continuing work on the S6 season reconstruction module. The goal is to match historical game data with karma scores to fully reconstruct Season 6.

## Current State

### What's Been Built

The admin module at `/admin/s6-reconstruction.html` + `/admin/s6-reconstruction.js` currently:

1. **Phase 1: Fetch Karma Data** - Fetches daily karma rankings from either:
   - Supabase (pre-scraped data in `karma_rankings` table)
   - Cloud Functions (live API proxy to `api.real.vg/userkarmaranks/day`)

2. **Phase 2: Direct Matching** - For players with known `player_id` in the JSON, directly looks up their karma data

3. **Phase 3: Username Discovery** - Matches handles to Supabase/API usernames using fuzzy matching (85%+ similarity)

4. **Phase 4: Rank Discovery** - For players with weekly `ranking` but no `player_id`, finds candidates in karma data within ±tolerance of that rank

5. **Phase 5: API Verification** - Validates ALL discoveries (username AND rank) by:
   - Fetching each candidate's ranked days history from `api.real.vg/rankeddays/{user_id}`
   - Comparing their actual daily ranks to expected rankings from the `.json` across multiple dates
   - Requiring 70%+ of dates to match within tolerance
   - On failure, searching for alternative candidates and trying them

6. **Phase 6: CSV Weekly Pattern Matching** - ✅ IMPLEMENTED - For remaining unmatched handles:
   - Uses weekly rankings from CSV (W1-W15) as a unique "fingerprint"
   - Maps game dates to weeks (every 3 dates = 1 week)
   - Finds candidates whose daily ranks match the weekly pattern
   - Validates via ranked days API (70%+ weeks must match)
   - Handles player aliases in CSV (e.g., "verse (reversethev)")

### Cloud Functions Created

Located in `/functions/admin/admin-s6-reconstruction.js`:
- `admin_fetchRankedDays` - Single page of ranked days
- `admin_fetchAllRankedDays` - Full paginated history (stops at S6 start: 2025-03-06)
- `admin_fetchKarmaRankings` - Single date karma leaderboard
- `admin_fetchKarmaRankingsBatch` - Batch fetch for up to 10 dates

### Key Files

| File | Purpose |
|------|---------|
| `/admin/s6-reconstruction.html` | Admin UI with file uploads for games JSON, handle mappings, and CSV |
| `/admin/s6-reconstruction.js` | Client-side reconstruction logic (all 6 phases) |
| `/functions/admin/admin-s6-reconstruction.js` | Cloud Functions for API proxy |
| `/scripts/s6-games-enhanced.json` | Games with player handles, player_ids (some null), rankings |
| `/scripts/s6-handle-to-id.json` | Existing handle→player_id mappings |
| `/RKL History - S6 Averages.csv` | Weekly rankings W1-W15 for each player |

---

## Phase 6 Implementation Details

Phase 6 is now fully implemented. This section documents how it works for reference.

### The Problem It Solves

After Phases 1-5, there are still unmatched players - those who:
- Don't have a username match in the karma data
- Don't have enough dates within top 1000 for rank-based discovery
- Failed validation and no alternatives were found

### The Solution: Weekly Ranking Sequences

The CSV file `RKL History - S6 Averages.csv` contains weekly rankings (W1-W15) for each player. These create a unique "fingerprint" that can be matched against karma data.

### CSV Structure

```csv
#,PLAYER,AVERAGE,GEM,T100,T50,GP,W1,W2,W3,W4,W5,W6,W7,W8,W9,W10,W11,W12,W13,W14,W15,
1,supa,59.5,15.70,10,10,13,3,22,8,3,22,253,,49,34,238,1,23,4,1,172,
16,sweat,120.07,80.53,8,3,12,274,23,175,9,63,91,241,92,,275,68,54,168,,28,
```

- `PLAYER`: Handle (may include aliases in parentheses like "verse (reversethev)")
- `W1-W15`: Weekly ranking for each of 15 weeks (blank = didn't play)
- Rankings are averages/aggregates for that week

### Date-to-Week Mapping

```
Week 1:  2025-03-06, 2025-03-07, 2025-03-08
Week 2:  2025-03-09, 2025-03-10, 2025-03-11
Week 3:  2025-03-12, 2025-03-13, 2025-03-14
...
Week 15: 2025-04-24, 2025-04-25, 2025-04-26
Week 16-21: Postseason (dates continue pattern)
```

Every 3 consecutive unique game dates = 1 week.

### Algorithm for Phase 6

```
For each player in CSV (not starting from unmatched handles):
  1. Check if we already have an ID (from handleToId or earlier discoveries)
     - If yes, skip this player
  2. Look up their weekly rankings from CSV (W1-W15)
  3. Filter to weeks within top 1000 (require at least 3 validatable weeks)
  4. For each week, map to the 3 dates in that week

  5. Build candidate scores from karma data:
     For each user_id in karma data:
       For each week with CSV ranking <= 1000:
         For each date in that week:
           If user's daily rank is within tolerance of weekly ranking:
             Add to candidate's score

     Score = (weeks matched, avg deviation for matched dates)

  6. Take top candidates (those matching 3+ weeks, sorted by weeks then avg deviation)

  7. Validate via ranked days API:
     - Fetch candidate's full history
     - For each week in CSV, find best matching date in history
     - Count weeks where best date is within tolerance
     - Calculate avgDeviation only for matched weeks
     - TWO criteria must pass:
       a) 70%+ of weeks must match (within tolerance)
       b) avgDeviation of matched weeks must be <= tolerance

  8. If valid → assign player_id
     If not → try next candidate
```

### Why This Works

Weekly rankings create a unique pattern:
```
Player "sweat" in CSV:
  W1:  274
  W2:  23   ← big jump up
  W3:  175
  W4:  9    ← top 10!
  W5:  63
  ...
```

Very unlikely for two different players to have the same ranking pattern across 10+ weeks. This is essentially a "ranking fingerprint."

### Implementation Approach

1. **Add CSV Upload** to the admin UI:
   ```html
   <div class="config-field">
       <label>Weekly Averages CSV (optional)</label>
       <input type="file" id="csv-file" accept=".csv">
   </div>
   ```

2. **Parse CSV** into a map:
   ```javascript
   // handle -> { W1: 274, W2: 23, W3: 175, ... }
   function parseWeeklyRankingsCSV(csvText) {
       const lines = csvText.split('\n');
       const headers = lines[0].split(',');
       const weekColumns = headers.filter(h => h.match(/^W\d+$/));

       const rankings = {};
       for (let i = 1; i < lines.length; i++) {
           const cols = lines[i].split(',');
           const player = cols[1].toLowerCase().split('(')[0].trim();

           rankings[player] = {};
           for (const weekCol of weekColumns) {
               const idx = headers.indexOf(weekCol);
               const val = parseInt(cols[idx]);
               if (!isNaN(val)) {
                   rankings[player][weekCol] = val;
               }
           }
       }
       return rankings;
   }
   ```

3. **Build Date-to-Week Map**:
   ```javascript
   function buildDateToWeekMap(games) {
       const uniqueDates = [...new Set(games.map(g => g.game_date))].sort();
       const map = {};
       for (let i = 0; i < uniqueDates.length; i++) {
           map[uniqueDates[i]] = Math.floor(i / 3) + 1;  // Week 1, 2, 3...
       }
       return map;
   }

   function getWeekDates(weekNum, dateToWeekMap) {
       return Object.entries(dateToWeekMap)
           .filter(([_, w]) => w === weekNum)
           .map(([d, _]) => d);
   }
   ```

4. **Find Candidates by Weekly Pattern**:
   ```javascript
   function findCandidatesByWeeklyPattern(handle, csvRankings, dateToWeekMap, tolerance) {
       const weeklyRanks = csvRankings[handle];
       if (!weeklyRanks) return [];

       const candidateScores = {};  // user_id -> {weekMatches, totalDev, datesMatched}

       for (const [weekCol, expectedRank] of Object.entries(weeklyRanks)) {
           const weekNum = parseInt(weekCol.slice(1));  // "W3" -> 3
           const weekDates = getWeekDates(weekNum, dateToWeekMap);

           for (const date of weekDates) {
               const karma = karmaCache[date];
               if (!karma) continue;

               for (const [userId, data] of Object.entries(karma)) {
                   const diff = Math.abs(data.rank - expectedRank);
                   if (diff <= tolerance) {
                       if (!candidateScores[userId]) {
                           candidateScores[userId] = {
                               weekMatches: new Set(),
                               totalDev: 0,
                               datesMatched: 0,
                               username: data.username
                           };
                       }
                       candidateScores[userId].weekMatches.add(weekNum);
                       candidateScores[userId].totalDev += diff;
                       candidateScores[userId].datesMatched++;
                   }
               }
           }
       }

       // Convert and sort by weeks matched, then avg deviation
       return Object.entries(candidateScores)
           .map(([userId, s]) => ({
               userId,
               username: s.username,
               weeksMatched: s.weekMatches.size,
               avgDeviation: s.totalDev / s.datesMatched,
               datesMatched: s.datesMatched
           }))
           .filter(c => c.weeksMatched >= 3)  // Require at least 3 weeks matched
           .sort((a, b) => {
               if (b.weeksMatched !== a.weeksMatched) return b.weeksMatched - a.weeksMatched;
               return a.avgDeviation - b.avgDeviation;
           });
   }
   ```

5. **Validate Candidate Against Weekly Rankings**:
   ```javascript
   function validateCandidateAgainstWeeklyRankings(rankedDays, csvRankings, tolerance) {
       // Build date -> rank from history
       const historyByDate = {};
       for (const day of rankedDays) {
           historyByDate[day.day] = day.rank;
       }

       let matchedWeeks = 0;
       let totalWeeks = 0;
       let matchedDeviation = 0;  // Only sum deviations for matched weeks

       for (const [weekCol, expectedRank] of Object.entries(csvRankings)) {
           if (expectedRank > 1000) continue;  // Skip if outside top 1000

           const weekNum = parseInt(weekCol.slice(1));
           const weekDates = getWeekDates(weekNum);

           // Find best (lowest deviation) date in this week
           let bestDev = Infinity;
           let hasData = false;

           for (const date of weekDates) {
               if (historyByDate[date] !== undefined) {
                   hasData = true;
                   const dev = Math.abs(historyByDate[date] - expectedRank);
                   if (dev < bestDev) bestDev = dev;
               }
           }

           if (hasData) {
               totalWeeks++;
               if (bestDev <= tolerance) {
                   matchedWeeks++;
                   matchedDeviation += bestDev;
               }
           }
       }

       const avgDeviation = matchedWeeks > 0 ? matchedDeviation / matchedWeeks : Infinity;

       // Both criteria must pass:
       // 1. 70%+ weeks matched
       // 2. avgDeviation within tolerance
       return {
           valid: totalWeeks > 0 && (matchedWeeks / totalWeeks) >= 0.7 && avgDeviation <= tolerance,
           matchedWeeks,
           totalWeeks,
           avgDeviation
       };
   }
   ```

6. **Add Phase 6 to Main Flow**:
   ```javascript
   async function processPhase6CsvDiscovery() {
       // Start from CSV data - iterate through all players in CSV
       const csvHandles = Object.keys(csvRankings);
       const handlesToProcess = [];

       for (const handle of csvHandles) {
           // Skip if we already have an ID
           if (handleToId[handle]) continue;
           if (discoveries[handle]) continue;

           // This handle is in CSV but we don't have an ID - process it
           handlesToProcess.push(handle);
       }

       log(`Phase 6: Processing ${handlesToProcess.length} CSV players without IDs...`, 'phase');

       let discovered = 0;
       for (const handle of handlesToProcess) {
           if (shouldStop) break;

           const weeklyRanks = csvRankings[handle];

           // Require at least 3 weeks within top 1000
           const validWeeks = Object.values(weeklyRanks).filter(r => r <= 1000).length;
           if (validWeeks < 3) continue;

           // Find candidates by weekly pattern in karma data
           const candidates = findCandidatesByWeeklyPattern(handle, tolerance);
           if (candidates.length === 0) continue;

           log(`  ${handle}: Found ${candidates.length} candidates, validating...`, 'info');

           // Try top 3 candidates
           for (const candidate of candidates.slice(0, 3)) {
               const rankedDays = await fetchRankedDays(candidate.userId);
               await sleep(API_CALL_DELAY_MS);

               const result = validateCandidateAgainstWeeklyRankings(
                   rankedDays,
                   weeklyRanks,
                   tolerance
               );

               if (result.valid) {
                   log(`    ✓ MATCH: ${candidate.userId} (${result.matchedWeeks}/${result.totalWeeks} weeks, avgDev: ${result.avgDeviation.toFixed(1)})`, 'success');

                   discoveries[handle] = {
                       user_id: candidate.userId,
                       confidence: 'high',
                       method: 'csv_weekly_pattern',
                       verified: true
                   };

                   // Update player objects if handle exists in games
                   // ...

                   discovered++;
                   break;
               }
           }
       }

       log(`Phase 6 complete: ${discovered} new discoveries via CSV patterns`, 'success');
   }
   ```

---

## Key Considerations

### API Rate Limiting
- Current delay: 750ms between calls
- Phase 6 will add more API calls for CSV-based validation
- Consider increasing delay or implementing backoff if needed

### Tolerance Tuning
- Current default: ±50 ranks
- Weekly rankings in CSV are averages, daily ranks can vary more
- May need to experiment with tolerance (try ±30 to ±75)

### Edge Cases
- Players with aliases in CSV: `"verse (reversethev)"` - need to parse and check both
- Players ranked >1000 in some weeks (blank in karma data) - skip those weeks
- Players with very few weeks of data - require minimum 3 matching weeks

### Validation Criteria
- For weekly: Both conditions must be satisfied:
  1. 70%+ of weeks must have at least one date within tolerance
  2. Average deviation across matched weeks must be <= tolerance
- This prevents false positives where many weeks "match" but with high deviations

---

## Files Modified for Phase 6

1. **`/admin/s6-reconstruction.html`** ✅
   - Added CSV file upload input with drag-and-drop support
   - Added "CSV Pattern" stat card

2. **`/admin/s6-reconstruction.js`** ✅
   - Added `parseWeeklyRankingsCSV()` - parses CSV with alias support
   - Added `parseCSVLine()` - handles quoted CSV fields
   - Added `extractHandles()` - extracts handles and aliases from player field
   - Added `buildDateToWeekMap()` - maps dates to week numbers
   - Added `getWeekDates()` - gets all dates for a week number
   - Added `findCandidatesByWeeklyPattern()` - finds candidates by weekly ranking pattern
   - Added `validateCandidateAgainstWeeklyRankings()` - validates via ranked days API
   - Added `processPhase6CsvDiscovery()` - main Phase 6 processing function
   - Updated `runFullReconstruction()` to include Phase 6 after Phase 5
   - Added `csvDiscoveries` to stats tracking

---

## Testing Strategy

1. Run Phases 1-5 first
2. Note how many handles remain unmatched
3. Run Phase 6 with CSV
4. Verify discoveries by spot-checking:
   - Does the discovered user_id's username look related to the handle?
   - Do their ranked days match the expected weekly pattern?

---

## Git Branch

Current work is on: `claude/reconstruct-seasons-data-ygxfw`

Recent commits:
- Add Cloud Functions to proxy real.vg API calls
- Add S6 Reconstruction admin module
- Fix multi-date pattern matching verification
- Improve validation to check all discoveries with fallback matching

---

## Summary

The reconstruction pipeline is now **100% complete** with all 6 phases implemented:

1. ✅ Phase 1: Fetch Karma Data (Supabase or Cloud Functions)
2. ✅ Phase 2: Direct Matching (known player_ids)
3. ✅ Phase 3: Username Discovery (fuzzy matching)
4. ✅ Phase 4: Rank Discovery (rank-based candidate finding)
5. ✅ Phase 5: API Verification (multi-date pattern validation)
6. ✅ Phase 6: CSV Weekly Pattern Matching (weekly fingerprint matching)

### Remaining Work

1. **Test thoroughly**: Run on actual data, verify discoveries
2. **Output final data**: Enhanced games JSON with all karma scores populated
3. **Deploy Cloud Functions**: Ensure functions are deployed to production

### How to Use

1. Navigate to `/admin/s6-reconstruction.html`
2. Upload the games JSON file
3. Optionally upload handle mappings JSON
4. Upload the CSV weekly averages file (for Phase 6)
5. Select karma source (Cloud Function recommended)
6. Click "Run Full Reconstruction"
7. Download results when complete

The weekly pattern matching approach is powerful because it uses an independent data source (CSV weekly averages) and matches on a multi-week "fingerprint" that's unique to each player.
