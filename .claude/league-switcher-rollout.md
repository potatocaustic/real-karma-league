# League Switcher Rollout Guide

## Overview
This document provides instructions for rolling out the admin-only league switcher feature to all public-facing /S9/ pages. The league switcher allows admins to toggle between Major League and Minor League views for testing purposes.

## Reference Implementation
The league switcher has been successfully implemented on `/S9/teams.html`. Use this as the reference implementation.

**Key commits:**
- `28b0ac4` - Add admin-only league switcher to /S9/teams.html
- `fb767d6` - Support minor league Northern/Southern conferences in teams view
- `56f81f9` - Fix conference header selector to ensure both headers update on league toggle

## Architecture

### League Context System
- **Storage:** `localStorage` with key `rkl_current_league`
- **Values:** `'major'` (default) or `'minor'`
- **Change Event:** Custom event `leagueChanged` dispatched when league changes
- **Collection Names:** Automatically prefixed based on league context via `getLeagueCollectionName()`

### League Switcher Component
- **Location:** `/common/league-switcher.js`
- **Styling:** `/css/league-switcher.css`
- **Function:** `createLeagueSwitcher()` - Returns a league switcher DOM element
- **Updates:** Header text and logo based on current league

### Admin Authentication
- **Check:** User document in `users` collection must have `role === 'admin'`
- **NOT:** The `admins` collection (that's only for display purposes in main.js)

## Key Differences: Major vs Minor League

| Aspect | Major League | Minor League |
|--------|-------------|--------------|
| Collections | `v2_teams`, `seasons`, etc. | `minor_v2_teams`, `minor_seasons`, etc. |
| Conferences | Eastern, Western | Northern, Southern |
| Team Seasonal Subcollections | `seasonal_stats`, `seasonal_records` | `minor_seasonal_stats`, `minor_seasonal_records` |
| Player Seasonal Subcollections | `seasonal_stats`, `seasonal_records` | `seasonal_stats`, `seasonal_records` (NO prefix!) |
| Header Logo | `/icons/RKL.webp` | `/icons/RKML.webp` |
| Header Text | "Real Karma League" | "Real Karma Minor League" |

## Implementation Steps for Each Page

### 1. Add CSS Link
In the `<head>` section, add the league-switcher CSS:

```html
<link rel="stylesheet" href="/css/league-switcher.css" />
```

### 2. Add Mount Point in Header
Add the league switcher mount point between the theme toggle button and the h1:

```html
<header>
    <button id="theme-toggle-btn" aria-label="Toggle Theme">
        <span class="sun-icon">☀️</span>
        <span class="moon-icon">🌙</span>
    </button>
    <div id="league-switcher-mount" style="display: none;">
        <!-- League switcher will be added here for admin users -->
    </div>
    <h1>
        <!-- existing h1 content -->
    </h1>
    <nav>
        <!-- existing nav -->
    </nav>
</header>
```

### 3. Add Admin-Only League Switcher Script
At the end of the HTML file, before `</body>`, add:

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

### 4. Update Page JavaScript to Support League Switching

#### A. Import `getCurrentLeague` from firebase-init.js

```javascript
import {
  db,
  // ... other imports
  getCurrentLeague
} from './firebase-init.js';
```

#### B. Add League Change Event Listener

At the end of your JavaScript file:

```javascript
// Reload data when league changes
window.addEventListener('leagueChanged', (event) => {
    const newLeague = event.detail.league;
    console.log('League changed to:', newLeague);
    loadData(); // Replace with your data loading function
});
```

#### C. Update Data Loading Logic

**For conference-based data (like teams):**
```javascript
async function loadData() {
  // Determine conference names based on current league
  const currentLeague = getCurrentLeague();
  const isMinorLeague = currentLeague === 'minor';
  const conference1 = isMinorLeague ? 'Northern' : 'Eastern';
  const conference2 = isMinorLeague ? 'Southern' : 'Western';

  // Update any conference headers dynamically
  const header1 = document.querySelector('#eastern-section .conference-header h3');
  const header2 = document.querySelector('#western-section .conference-header h3');
  if (header1) header1.textContent = `${conference1} Conference`;
  if (header2) header2.textContent = `${conference2} Conference`;

  // Filter by appropriate conferences
  const conf1Data = allData.filter(item => item.conference === conference1);
  const conf2Data = allData.filter(item => item.conference === conference2);

  // ... rest of logic
}
```

**For non-conference data:**
```javascript
async function loadData() {
  const currentLeague = getCurrentLeague();
  console.log("Loading data for league:", currentLeague);

  // Collection names are automatically prefixed via collectionNames
  const dataRef = collection(db, collectionNames.yourCollection);

  // ... rest of logic
}
```

#### D. Use `collectionNames` for Firestore Queries

Always use `collectionNames` from firebase-init.js instead of hardcoded collection names:

```javascript
// ✅ CORRECT
const teamsRef = collection(db, collectionNames.teams);
const seasonsRef = collection(db, collectionNames.seasons);

// ❌ WRONG
const teamsRef = collection(db, 'v2_teams');
const seasonsRef = collection(db, 'seasons');
```

### 5. Test the Implementation

1. **Deploy Firestore rules** (if not already done):
   ```bash
   firebase deploy --only firestore:rules
   ```

2. **Test as admin:**
   - Log in as admin
   - Visit the page
   - Verify league switcher appears
   - Toggle between leagues
   - Verify data loads correctly for both leagues
   - Check browser console for errors

3. **Test as non-admin:**
   - Log out or use incognito mode
   - Visit the page
   - Verify league switcher does NOT appear
   - Verify page still works normally (defaults to major league)

## Pages to Update

The following /S9/ pages should receive the league switcher:

- [ ] `/S9/RKL-S9.html` - Season home page
- [ ] `/S9/standings.html` - Standings & rankings
- [ ] `/S9/leaderboards.html` - Season leaderboards
- [ ] `/S9/historical-daily-leaderboards.html` - Daily leaderboards
- [ ] `/S9/compare.html` - Comparison tool
- [ ] `/S9/schedule.html` - Schedule
- [ ] `/S9/draft-capital.html` - Draft capital
- [ ] `/S9/draft-results.html` - Draft results
- [ ] `/S9/draft-lottery.html` - Draft lottery
- [ ] `/S9/draft-prospects.html` - Draft prospects
- [ ] `/S9/transactions.html` - Transactions
- [ ] `/S9/teams.html` - ✅ COMPLETED
- [ ] `/S9/team.html` - Individual team page
- [ ] `/S9/trophy-case.html` - Trophy case

## Making the League Switcher Public

When ready to make the league switcher available to all users (not just admins):

### Option 1: Simple Toggle (Recommended)
Replace the admin check script with a simpler version that shows it to everyone:

```html
<!-- Public league switcher -->
<script type="module">
  import { createLeagueSwitcher } from '/common/league-switcher.js';

  // Show league switcher to all users
  const mountPoint = document.getElementById('league-switcher-mount');
  if (mountPoint) {
    mountPoint.style.display = 'flex';
    const switcher = createLeagueSwitcher();
    mountPoint.appendChild(switcher);
  }
</script>
```

### Option 2: Remove the Hidden Mount Point
Change the mount point from:
```html
<div id="league-switcher-mount" style="display: none;">
```

To:
```html
<div id="league-switcher-mount">
```

And update the script to just create the switcher without the auth check.

### Option 3: Feature Flag
Add a feature flag in `/js/firebase-init.js`:

```javascript
export const LEAGUE_SWITCHER_PUBLIC = true; // Set to false to make admin-only
```

Then in each page:
```javascript
import { LEAGUE_SWITCHER_PUBLIC } from '/js/firebase-init.js';

if (LEAGUE_SWITCHER_PUBLIC) {
  // Show to everyone
  const mountPoint = document.getElementById('league-switcher-mount');
  if (mountPoint) {
    mountPoint.style.display = 'flex';
    const switcher = createLeagueSwitcher();
    mountPoint.appendChild(switcher);
  }
} else {
  // Admin-only logic (existing code)
  onAuthStateChanged(auth, async (user) => { /* ... */ });
}
```

## Troubleshooting

### Common Issues

1. **League switcher doesn't appear for admin**
   - Check browser console for errors
   - Verify user document has `role: 'admin'` in `users` collection
   - Verify admin is logged in (check auth status in header)

2. **Permissions errors when loading data**
   - Ensure Firestore rules are deployed: `firebase deploy --only firestore:rules`
   - Check that minor league collection rules exist (see firestore.rules)
   - Verify subcollection naming (teams use `minor_` prefix, players don't)

3. **Conference headers don't update**
   - Check that headers are being selected correctly (use `.closest()` for reliability)
   - Verify `loadData()` is being called on `leagueChanged` event
   - Add console logging to debug

4. **Data doesn't load after switching leagues**
   - Verify `collectionNames` is being used instead of hardcoded names
   - Check that `leagueChanged` event listener is registered
   - Ensure data loading function is async and handles both leagues

### Debug Logging

Add these logs to help debug issues:

```javascript
console.log('[Page Name] Current league:', getCurrentLeague());
console.log('[Page Name] Loading from collection:', collectionNames.yourCollection);
console.log('[Page Name] League changed to:', event.detail.league);
```

## Firestore Rules Reference

The following minor league collections have been added to `firestore.rules`:

### Production Collections
- `minor_v2_teams`, `minor_v2_players`
- `minor_seasons`, `minor_transactions`
- `minor_live_games`, `minor_live_scoring_status`
- `minor_draft_results`, `minor_draftPicks`
- `minor_awards`, `minor_power_rankings`, `minor_lottery_results`
- `minor_daily_scores`, `minor_leaderboards`, `minor_daily_leaderboards`
- And their `_post` and `_dev` variants

### Subcollections
- Teams: `minor_v2_teams/{teamId}/minor_seasonal_stats/{recordId}`
- Teams: `minor_v2_teams/{teamId}/minor_seasonal_records/{recordId}`
- Players: `minor_v2_players/{playerId}/seasonal_stats/{recordId}` (NO prefix!)
- Players: `minor_v2_players/{playerId}/seasonal_records/{recordId}` (NO prefix!)

All minor league collections allow public read access and admin-only write access, consistent with major league permissions.

## Notes

- The league switcher UI component automatically updates header text and logo
- All league switching is client-side - no server changes needed
- The league context persists in localStorage across page loads
- Shared collections (users, notifications, etc.) are NOT prefixed with league
- Always test both league views before marking a page as complete
- Conference names differ: Eastern/Western (major) vs Northern/Southern (minor)
- Player subcollections do NOT use the `minor_` prefix, but team subcollections DO

## Questions or Issues?

Refer to the reference implementation in:
- `/S9/teams.html` (HTML structure and admin check)
- `/js/teams.js` (JavaScript data loading with league support)
- `/common/league-switcher.js` (League switcher component)
- `/css/league-switcher.css` (Styling)

Check recent commits on branch `claude/add-league-switcher-public-01SUiuBqEdWM3THyBFF6USQo` for detailed implementation examples.
