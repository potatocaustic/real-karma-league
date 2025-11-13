# Troubleshooting Guide: Game Flow Chart & Daily Leaderboard Issues

## 🔥 MAIN ISSUE IDENTIFIED: Missing Firestore Security Rules

**The primary cause of both issues was missing Firestore security rules!**

The collections `game_flow_snapshots` and `daily_leaderboards` were not defined in `firestore.rules`, causing permission denied errors when the frontend tried to read the data. The backend was successfully creating the data, but users couldn't access it.

**Fix:** Added read permissions for both collections in production and development environments.

## Issues Fixed in This Update

### 1. Daily Leaderboard Not Being Created
**Problem:** The `daily_leaderboards` collection is not being created in Firestore even after running manual updates.

**Root Causes:**
- Collection naming fix was committed but Cloud Functions may not have been deployed
- Date mismatch between backend (using `active_game_date`) and frontend (using current date)
- Silent error handling was hiding the actual error

**Fixes Applied:**
- ✅ Enhanced error logging in backend to identify issues
- ✅ Fixed frontend to use `active_game_date` from live scoring status instead of current date
- ✅ Added detailed console logs to track the entire process

### 2. Game Flow Chart Button Not Showing
**Problem:** The game flow chart button doesn't appear in the game details modal, even though `game_flow_snapshots` collection exists with data.

**Possible Causes:**
- `showLiveFeatures` flag may be disabled in admin settings
- Data fetch is failing silently
- Button element not being found in the DOM

**Fixes Applied:**
- ✅ Added comprehensive debugging logs to identify the exact cause
- ✅ Better error handling and console output

## Deployment Instructions

### Step 1: Deploy Firestore Security Rules (CRITICAL!)

**This was the main issue!** The new collections were missing from the Firestore security rules, causing permission denied errors.

```bash
# Install Firebase CLI if not already installed
npm install -g firebase-tools

# Login to Firebase (if not already logged in)
firebase login

# Deploy Firestore security rules
firebase deploy --only firestore:rules
```

**Note:** This is very fast (usually < 30 seconds) and takes effect immediately.

### Step 2: Deploy Cloud Functions

The enhanced logging will help with debugging:

```bash
# Deploy only the Cloud Functions (faster than full deploy)
firebase deploy --only functions
```

**Note:** Deployment can take 5-10 minutes. Wait for it to complete before testing.

### Step 3: Clear Old Data (Optional but Recommended)

If you want to start fresh:

1. Go to Firebase Console → Firestore Database
2. Delete any existing `game_flow_snapshots` documents (they will be recreated with new data)
3. The `daily_leaderboards` collection should appear after the next update

### Step 4: Test the Features

1. **Start or Resume Live Scoring:**
   - Go to Admin Portal → Manage Live Scoring
   - Make sure "Show Live Features" toggle is **ON** (checked)
   - Start live scoring or run a manual update

2. **Run a Full Manual Update:**
   - Click "Manual Full Update" button
   - Wait for the update to complete

3. **Check Cloud Function Logs:**
   ```bash
   # View logs for the updateAllLiveScores function
   firebase functions:log --only updateAllLiveScores
   ```

   Look for these log messages:
   - `[Daily Leaderboard] Starting calculation...`
   - `[Daily Leaderboard] Collected X unique players`
   - `[Daily Leaderboard] ✓ Successfully calculated and stored leaderboard...`

   If you see errors, they will be clearly marked with `✗ ERROR`

4. **Verify in Firestore:**
   - Check for `daily_leaderboards` collection
   - Check for `game_flow_snapshots` collection
   - Documents should be created/updated with today's date

5. **Test the Frontend:**
   - Open your RKL S9 homepage
   - Open browser DevTools Console (F12)
   - Click on a completed game with game flow data
   - Look for `[Game Flow]` debug messages showing:
     - Whether flow data was found
     - Whether features are enabled
     - Why the button is/isn't showing
   - Click the Daily Leaderboard icon (during live scoring)
   - Check console for `Fetching daily leaderboard for game date:` message

## Common Issues & Solutions

### Issue: "No active games to update"
**Solution:** Make sure you have games in the `live_games` collection. Check the Admin Portal → Manage Live Scoring to activate games.

### Issue: Game Flow Button Still Not Showing
**Checklist:**
1. Check browser console for `[Game Flow]` debug messages
2. Verify `show_live_features` is `true` in `live_scoring_status/status` document
3. Verify the game ID in `game_flow_snapshots` matches the game you're viewing
4. Check if `flowData.length` is > 0 (shown in console logs)

### Issue: Daily Leaderboard Shows "No data available"
**Checklist:**
1. Verify `daily_leaderboards` collection exists in Firestore
2. Check the document ID matches the date format: `YYYY-MM-DD`
3. Check browser console for the date being fetched
4. Verify `active_game_date` field exists in `live_scoring_status/status`

### Issue: Functions deployed but still not working
**Solution:**
1. Hard refresh the frontend (Ctrl+Shift+R or Cmd+Shift+R)
2. Wait a few minutes for Firebase to propagate changes
3. Check that you deployed to the correct project: `firebase use`

## Debugging Tips

### Backend (Cloud Functions)
```bash
# Stream live logs
firebase functions:log --only updateAllLiveScores

# Filter for daily leaderboard logs
firebase functions:log | grep "Daily Leaderboard"

# Filter for errors
firebase functions:log | grep ERROR
```

### Frontend (Browser Console)
Open DevTools Console (F12) and filter by:
- `[Game Flow]` - for game flow chart debugging
- `[Daily Leaderboard]` - for leaderboard issues
- `Error` - for any errors

## Admin Settings

Make sure the "Show Live Features" toggle is enabled:

1. Go to Admin Portal → Manage Live Scoring
2. Find the "Show Live Features" toggle
3. Ensure it is **checked/enabled**
4. This controls whether the game flow chart button and daily leaderboard icon are visible to users

## Need More Help?

If issues persist:

1. **Check Cloud Function Logs** for detailed error messages
2. **Check Browser Console** for frontend errors
3. **Verify Firestore Data** directly in Firebase Console
4. **Compare Collection Names** between frontend code and backend code (they should match exactly)

## Files Modified in This Fix

- `functions/index.js` - Added detailed logging to daily leaderboard calculation
- `js/RKL-S9.js` - Fixed date mismatch and added debugging for game flow button
- This troubleshooting guide

## Next Steps After Deployment

1. Deploy the functions using the commands above
2. Run a manual update from the admin portal
3. Check the logs and console output
4. Verify both collections are being created
5. Test the frontend features

If everything works correctly, you should see:
- ✅ `daily_leaderboards` collection with documents by date
- ✅ `game_flow_snapshots` collection with documents by game ID
- ✅ Game flow chart button appearing in game modals
- ✅ Daily leaderboard showing data when clicked
