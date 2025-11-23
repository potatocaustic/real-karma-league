# League Switcher Implementation - Remaining Pages

## Completed Pages
✅ standings.html + standings.js
✅ leaderboards.html + leaderboards.js
✅ historical-daily-leaderboards.html + historical-daily-leaderboards.js
✅ compare.html + comparedev.js
✅ schedule.html (HTML only - JS still needs update)
✅ draft-capital.html (HTML only - JS still needs update)

## Remaining HTML Files to Update
The following files need the same 3 HTML changes:
- [ ] draft-results.html
- [ ] draft-lottery.html
- [ ] draft-prospects.html
- [ ] transactions.html
- [ ] team.html
- [ ] trophy-case.html

### HTML Template for All Remaining Files

For each HTML file, make these 3 changes:

#### 1. Add CSS Link (after existing CSS links)
```html
<link rel="stylesheet" href="/css/league-switcher.css" />
```

#### 2. Add Mount Point (in header, between theme-toggle-btn and h1)
```html
<div id="league-switcher-mount" style="display: none;">
    <!-- League switcher will be added here for admin users -->
</div>
```

#### 3. Add Admin Script (before </body>)
```html
<!-- Admin-only league switcher -->
<script type="module">
  import { auth, db, onAuthStateChanged, doc, getDoc } from '/js/firebase-init.js';
  import { createLeagueSwitcher } from '/common/league-switcher.js';

  // Check if user is admin and show league switcher accordingly
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      // Check if user is an admin (must check users collection role, not admins collection)
      const userRef = doc(db, "users", user.uid);

      try {
        const userDoc = await getDoc(userRef);

        if (userDoc.exists() && userDoc.data().role === 'admin') {
          // User is admin - show and initialize league switcher
          const mountPoint = document.getElementById('league-switcher-mount');
          if (mountPoint) {
            mountPoint.style.display = 'flex';
            const switcher = createLeagueSwitcher();
            mountPoint.appendChild(switcher);
          }
        }
      } catch (error) {
        console.error('[League Switcher] Error checking user role:', error);
      }
    }
  });
</script>
```

## Remaining JS Files to Update

### JS File Update Template

For each corresponding JS file, make these changes:

#### 1. Update Imports
Add to existing imports:
```javascript
import {
  // ... existing imports
  collectionNames,
  getLeagueCollectionName,
  getCurrentLeague,
  getConferenceNames
} from './firebase-init.js';
```

#### 2. Replace Collection References
- Replace `getCollectionName('v2_teams')` → `collectionNames.teams`
- Replace `getCollectionName('v2_players')` → `collectionNames.players`
- Replace `getCollectionName('seasons')` → `collectionNames.seasons`
- Replace `getCollectionName('seasonal_stats')` → `collectionNames.seasonalStats`
- Replace `getCollectionName('seasonal_records')` → `collectionNames.seasonalRecords`
- Replace hardcoded `'v2_teams'` → `collectionNames.teams`
- Replace hardcoded `'seasons'` → `collectionNames.seasons`
- For league-specific collections (like 'power_rankings', 'transactions', 'draft_results', etc.) → `getLeagueCollectionName('collection_name')`

#### 3. Replace Hardcoded Conference Names
Find and replace:
```javascript
// OLD:
where("conference", "in", ["Eastern", "Western"])
// or
team.conference === 'Eastern' || team.conference === 'Western'

// NEW:
const conferences = getConferenceNames();
where("conference", "in", [conferences.primary, conferences.secondary])
// or
team.conference === conferences.primary || team.conference === conferences.secondary
```

#### 4. Add League Change Event Listener (at end of file)
```javascript
// Reload data when league changes
window.addEventListener('leagueChanged', async (event) => {
    const newLeague = event.detail.league;
    console.log('[PageName] League changed to:', newLeague);
    // Reload the page data - replace with actual function name
    await initializePage(); // or loadData(), or whatever the main loading function is
});
```

## Collection Name Mappings

| Old Pattern | New Pattern | Notes |
|------------|-------------|-------|
| `getCollectionName('v2_teams')` | `collectionNames.teams` | Team collection |
| `getCollectionName('v2_players')` | `collectionNames.players` | Player collection |
| `getCollectionName('seasons')` | `collectionNames.seasons` | Seasons collection |
| `getCollectionName('seasonal_stats')` | `collectionNames.seasonalStats` | Player seasonal stats subcollection |
| `getCollectionName('seasonal_records')` | `collectionNames.seasonalRecords` | Team seasonal records subcollection |
| `getCollectionName('transactions')` | `getLeagueCollectionName('transactions')` | League-specific |
| `getCollectionName('draft_picks')` | `collectionNames.draftPicks` | Draft picks |
| `getCollectionName('draft_results')` | `getLeagueCollectionName('draft_results')` | League-specific |
| `getCollectionName('power_rankings')` | `getLeagueCollectionName('power_rankings')` | League-specific |
| `getCollectionName('trophy_case')` | `getLeagueCollectionName('trophy_case')` | League-specific |

## Conference Name Handling

### For Queries
```javascript
const conferences = getConferenceNames();
// conferences.primary = 'Eastern' (major) or 'Northern' (minor)
// conferences.secondary = 'Western' (major) or 'Southern' (minor)

// Use in queries:
query(collection(db, collectionNames.teams), where("conference", "in", [conferences.primary, conferences.secondary]))
```

### For Filters
```javascript
const conferences = getConferenceNames();
const activeTeams = allTeams.filter(team =>
  team.conference === conferences.primary || team.conference === conferences.secondary
);
```

### For Dynamic UI Headers
```javascript
const conferences = getConferenceNames();
easternHeader.textContent = `${conferences.primary} Conference`;
westernHeader.textContent = `${conferences.secondary} Conference`;
```

## Specific JS Files Status

### ✅ Completed
- standings.js
- leaderboards.js
- historical-daily-leaderboards.js
- comparedev.js

### ⏳ Remaining to Update
- [ ] schedule.js
- [ ] draft-capital.js
- [ ] draft-results.js
- [ ] draft-lottery.js
- [ ] draft-prospects.js
- [ ] transactions.js
- [ ] team.js
- [ ] trophy-case.js

## Quick Implementation Checklist

For each remaining page:

### HTML File
- [ ] Add league-switcher.css link
- [ ] Add league-switcher-mount div in header
- [ ] Add admin script before </body>

### JS File
- [ ] Add imports: collectionNames, getLeagueCollectionName, getCurrentLeague, getConferenceNames
- [ ] Remove old `getCollectionName` function if it exists
- [ ] Replace all collection references with new pattern
- [ ] Replace hardcoded conference names with getConferenceNames()
- [ ] Add leagueChanged event listener at end
- [ ] Test the page switches correctly between major/minor leagues

## Testing Checklist

After implementation:
- [ ] Admin users can see the league switcher
- [ ] Non-admin users cannot see the league switcher
- [ ] Switching leagues updates the page data correctly
- [ ] Conference names change (Eastern/Western vs Northern/Southern)
- [ ] All data loads correctly for both leagues
- [ ] No console errors when switching leagues
