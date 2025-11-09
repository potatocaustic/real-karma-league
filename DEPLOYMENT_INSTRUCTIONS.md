# Multi-League Migration - Deployment Instructions

## Overview

This document provides step-by-step instructions to complete the multi-league migration deployment. The code changes have been completed and pushed to the `claude/update-firestore-rules-011CUwLQNDhqspYeDwNQsvuy` branch.

**Status**: Frontend integration complete. Manual deployment steps required.

---

## Prerequisites

- Firebase CLI installed (`npm install -g firebase-tools`)
- Authenticated with Firebase (`firebase login`)
- Project configured (`firebase use real-karma-league`)

---

## Deployment Steps

### Step 1: Deploy Firestore Security Rules

The updated `firestore.rules` file now includes rules for all minor league collections.

```bash
cd /path/to/real-karma-league
firebase deploy --only firestore:rules
```

**Expected Output:**
```
✔  Deploy complete!
```

**Verify:**
1. Open Firebase Console → Firestore Database → Rules tab
2. Confirm rules updated timestamp changed
3. Search for "minor_" in the rules to verify minor league rules are present

---

### Step 2: Add League Switcher to Pages

The league switcher component has been created but needs to be added to page headers.

#### Files to Update:

1. **admin/index.html**
2. **gm/index.html**
3. **scorekeeper/index.html**

#### For Each File:

**A. Add CSS to `<head>` section:**
```html
<link rel="stylesheet" href="../css/league-switcher.css">
```

**B. Add mount point in navigation area (inside header/nav):**
```html
<div id="league-switcher-mount"></div>
```

**C. Add initialization script before closing `</body>`:**
```html
<script type="module">
    import { createLeagueSwitcher } from '../common/league-switcher.js';
    const switcher = createLeagueSwitcher();
    document.getElementById('league-switcher-mount').appendChild(switcher);
</script>
```

#### Example Integration:

```html
<!DOCTYPE html>
<html>
<head>
    <title>Admin Dashboard</title>
    <link rel="stylesheet" href="../css/global-styles.css">
    <link rel="stylesheet" href="../css/league-switcher.css">
</head>
<body>
    <header>
        <h1>Admin Dashboard</h1>
        <div id="league-switcher-mount"></div>
        <!-- rest of header -->
    </header>

    <!-- page content -->

    <script type="module">
        import { createLeagueSwitcher } from '../common/league-switcher.js';
        const switcher = createLeagueSwitcher();
        document.getElementById('league-switcher-mount').appendChild(switcher);
    </script>
</body>
</html>
```

---

### Step 3: Add League Change Event Handlers

For pages that display league-specific data, add event listeners to reload data when the league changes.

#### Pattern:

```javascript
// Add this to pages that display league-specific data
window.addEventListener('leagueChanged', (event) => {
    const newLeague = event.detail.league;
    console.log('League changed to:', newLeague);

    // Reload data for new league
    loadPageData(); // Replace with your data loading function
});
```

#### Pages That Need Event Handlers:

- **admin/index.html** (dashboard) - reload stats/summary
- **admin/manage-games.js** - already handles via re-query
- **gm/index.html** (dashboard) - reload team stats
- **gm/submit-lineup.js** - already handles via re-query
- **scorekeeper/index.html** (dashboard) - reload live game status
- **js/standings.js** - reload standings table
- **js/leaderboards.js** - reload leaderboard data
- **js/schedule.js** - reload schedule
- **js/teams.js** - reload team list
- **js/player.js** - reload player data

---

### Step 4: Deploy Frontend (Optional)

If using Firebase Hosting:

```bash
firebase deploy --only hosting
```

If using another hosting provider, deploy your updated files to your web server.

---

### Step 5: Test League Switching

After deployment, test the following:

#### Basic Functionality:
1. Open admin dashboard
2. Click "Minor League" button
3. Verify button changes to active state
4. Check browser console for "League context switched to: minor" message
5. Click "Major League" button
6. Verify it switches back

#### Data Isolation:
1. Set league to Major
2. Load a page with data (e.g., standings)
3. Note the data shown
4. Switch to Minor League
5. Verify the page shows different data (or empty if no minor league data exists yet)
6. Switch back to Major
7. Verify original data is shown again

#### Network Requests:
1. Open browser DevTools → Network tab
2. Switch to Minor League
3. Trigger a Cloud Function (e.g., set lineup deadline)
4. Check the request payload includes `"league":"minor"`
5. Check Firestore requests target `minor_*` collections

---

## Verification Checklist

- [ ] Firestore rules deployed successfully
- [ ] League switcher appears on admin dashboard
- [ ] League switcher appears on GM dashboard
- [ ] League switcher appears on scorekeeper dashboard
- [ ] Clicking switcher changes active button state
- [ ] Console shows "League context switched to: [league]" message
- [ ] `leagueChanged` event fires when switching
- [ ] Firestore queries target correct collections (check Network tab)
- [ ] Cloud Function calls include league parameter (check Network tab)
- [ ] No JavaScript errors in console
- [ ] Data isolation works (major/minor show different data)

---

## Troubleshooting

### Issue: "Permission denied" on minor league queries

**Cause:** Firestore rules not deployed

**Solution:**
```bash
firebase deploy --only firestore:rules
```

### Issue: League switcher not appearing

**Cause:** HTML not updated with mount point or script

**Solution:**
- Verify `<div id="league-switcher-mount"></div>` exists in HTML
- Verify script tag with `createLeagueSwitcher()` exists before `</body>`
- Check browser console for import errors

### Issue: Clicking switcher does nothing

**Cause:** JavaScript error or event listener not working

**Solution:**
- Open browser console and check for errors
- Verify `getCurrentLeague()` and `setCurrentLeague()` are exported from firebase-init.js
- Try: `import { getCurrentLeague, setCurrentLeague } from './js/firebase-init.js';` in console

### Issue: Data doesn't change when switching leagues

**Cause:** Missing `leagueChanged` event listener

**Solution:**
- Add event listener to page's JavaScript file
- Ensure data reload function is called in the event handler

### Issue: Cloud Functions receiving wrong league parameter

**Cause:** Not all function calls updated, or using cached value

**Solution:**
- Search codebase for `httpsCallable` and verify all calls include `league: getCurrentLeague()`
- Clear browser cache and hard refresh (Ctrl+Shift+R)

---

## Rollback Procedure

If critical issues occur:

### 1. Rollback Code:
```bash
git checkout main
firebase deploy --only hosting
```

### 2. Rollback Firestore Rules:
```bash
git checkout main firestore.rules
firebase deploy --only firestore:rules
```

### 3. Keep Database:
Minor league collections can remain in Firestore without causing issues.

---

## Next Steps After Deployment

1. **Initialize Minor League Data** - Run the initialization script:
   ```bash
   node scripts/initialize-minor-league.js --with-sample-data
   ```

2. **Test End-to-End Workflows:**
   - Create a minor league season
   - Add teams and players
   - Schedule games
   - Submit lineups
   - Run live scoring

3. **Monitor for Issues:**
   - Check Firebase Console → Functions → Logs for errors
   - Monitor Firestore usage/quotas
   - Watch for any cross-league data contamination

4. **User Training:**
   - Document league switcher for admins/GMs
   - Explain major vs minor league separation
   - Provide guidelines for league-specific operations

---

## Support

For issues or questions:
- Review `MIGRATION_CONTINUATION_PROMPT.md` for detailed architecture
- Review `MIGRATION_GUIDE.md` for API documentation
- Check Firebase Console logs for function errors
- Review browser console for frontend errors

---

## Summary

**What Was Done:**
- ✅ Firestore rules updated with minor league collections
- ✅ League context management added to firebase-init.js
- ✅ League switcher component created
- ✅ All Cloud Function calls updated with league parameter
- ✅ All Firestore queries updated to use dynamic collection names
- ✅ Changes committed and pushed to branch

**What Remains:**
- ⏳ Deploy Firestore rules (Step 1)
- ⏳ Add league switcher to HTML pages (Step 2)
- ⏳ Add league change event handlers (Step 3)
- ⏳ Deploy frontend (Step 4)
- ⏳ Test league switching (Step 5)

The heavy lifting is complete. The remaining steps are straightforward deployment and integration tasks that can be completed in 1-2 hours.
