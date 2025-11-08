# Multi-League API Migration Guide

## Breaking Changes
**None.** All existing API calls default to major league, ensuring full backward compatibility.

## New Optional Parameter

All callable functions now accept an optional `league` parameter:

```javascript
// Major league (default, backward compatible)
const result = await setLineupDeadline({ date, time, timeZone });

// Minor league (new)
const result = await setLineupDeadline({
  date,
  time,
  timeZone,
  league: 'minor'
});
```

## Affected Functions

### Admin Functions
- `setLineupDeadline` - Set lineup deadlines for a specific league
- `admin_recalculatePlayerStats` - Recalculate player stats for a specific league
- `admin_updatePlayerId` - Update player ID across league-specific collections
- `admin_updatePlayerDetails` - Update player details for a specific league
- `rebrandTeam` - Rebrand a team in a specific league
- `createNewSeason` - Create a new season for a specific league
- `createHistoricalSeason` - Create a historical season for a specific league
- `generatePostseasonSchedule` - Generate postseason schedule for a specific league
- `calculatePerformanceAwards` - Calculate awards for a specific league
- `admin_processTransaction` - Process transactions for a specific league
- `forceLeaderboardRecalculation` - Force leaderboard recalculation for a specific league

### Scorekeeper Functions
- `stageLiveLineups` - Stage lineups for live games in a specific league
- `activateLiveGame` - Activate a live game for a specific league
- `finalizeLiveGame` - Finalize a live game for a specific league
- `scorekeeperFinalizeAndProcess` - Finalize and process game data for a specific league
- `generateGameWriteup` - Generate AI writeup for a game in a specific league
- `getReportData` - Get report data for a specific league
- `updateAllLiveScores` - Update all live scores for a specific league
- `setLiveScoringStatus` - Set live scoring status for a specific league

### Public Functions
- `getLiveKarma` - Get live karma data for a specific league

### Draft Functions
- `addDraftProspects` - Add draft prospects to a specific league

### Other Functions
- `getScheduledJobTimes` - Get scheduled job times (league-aware)
- `logScorekeeperActivity` - Log scorekeeper activity
- `updateScheduledJobTimes` - Update scheduled job times
- `clearAllTradeBlocks` - Clear all trade blocks for a specific league
- `reopenTradeBlocks` - Reopen trade blocks for a specific league
- `getAiWriteup` - Get AI-generated writeup

## Response Changes

All functions now return `league` in success responses:

```javascript
{
  success: true,
  league: 'minor',
  message: "Operation completed successfully"
}
```

## Frontend Implementation Example

### React Context for League Management

```javascript
// LeagueContext.js
import { createContext, useContext, useState } from 'react';

const LeagueContext = createContext();

export const LeagueProvider = ({ children }) => {
  const [currentLeague, setCurrentLeague] = useState('major'); // default to major

  return (
    <LeagueContext.Provider value={{ currentLeague, setCurrentLeague }}>
      {children}
    </LeagueContext.Provider>
  );
};

export const useLeague = () => useContext(LeagueContext);
```

### Using League Context in Components

```javascript
import { useLeague } from './LeagueContext';
import { httpsCallable } from 'firebase/functions';

const AdminPanel = () => {
  const { currentLeague } = useLeague();
  const functions = getFunctions();

  const handleSetDeadline = async (date, time, timeZone) => {
    const setLineupDeadline = httpsCallable(functions, 'setLineupDeadline');

    const result = await setLineupDeadline({
      date,
      time,
      timeZone,
      league: currentLeague // Pass current league context
    });

    console.log(`Deadline set for ${result.data.league} league`);
  };

  return (
    <div>
      {/* Your admin panel UI */}
    </div>
  );
};
```

### League Switcher Component

```javascript
import { useLeague } from './LeagueContext';

const LeagueSwitcher = () => {
  const { currentLeague, setCurrentLeague } = useLeague();

  return (
    <div className="league-switcher">
      <button
        className={currentLeague === 'major' ? 'active' : ''}
        onClick={() => setCurrentLeague('major')}
      >
        Major League
      </button>
      <button
        className={currentLeague === 'minor' ? 'active' : ''}
        onClick={() => setCurrentLeague('minor')}
      >
        Minor League
      </button>
    </div>
  );
};
```

### Firestore Query Examples

When querying Firestore directly from the frontend, use appropriate collection names:

```javascript
import { collection, query, where } from 'firebase/firestore';

const SeasonsView = () => {
  const { currentLeague } = useLeague();
  const db = getFirestore();

  useEffect(() => {
    // Construct collection name based on league
    const collectionName = currentLeague === 'minor' ? 'minor_seasons' : 'seasons';

    const seasonsRef = collection(db, collectionName);
    const q = query(seasonsRef, where('status', '==', 'active'));

    // Fetch and display seasons
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const seasons = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setSeasons(seasons);
    });

    return () => unsubscribe();
  }, [currentLeague]);

  return (
    <div>
      {/* Display seasons */}
    </div>
  );
};
```

## Collection Naming Convention

### League-Specific Collections
Collections that are separate per league use the `minor_` prefix for minor league:

- `seasons` (major) / `minor_seasons` (minor)
- `v2_players` (major) / `minor_v2_players` (minor)
- `v2_teams` (major) / `minor_v2_teams` (minor)
- `lineups` (major) / `minor_lineups` (minor)
- `games` (major) / `minor_games` (minor)
- `post_games` (major) / `minor_post_games` (minor)
- `live_games` (major) / `minor_live_games` (minor)
- `transactions` (major) / `minor_transactions` (minor)
- `lineup_deadlines` (major) / `minor_lineup_deadlines` (minor)
- `pending_lineups` (major) / `minor_pending_lineups` (minor)
- `pending_transactions` (major) / `minor_pending_transactions` (minor)

### Shared Collections
These collections are shared between both leagues (no prefix):

- `users` - User accounts and authentication
- `notifications` - System-wide notifications
- `scorekeeper_activity_log` - Activity logs for all scorekeepers

### Structured Collections
These collections have internal league organization:

- `daily_averages` - Contains league-specific subcollections
- `daily_scores` - Contains league-specific subcollections
- `leaderboards` - Contains league-specific subcollections
- `awards` - Contains league-specific subcollections
- `draft_results` - Contains league-specific subcollections

## Firestore Rules Update Required

Update your `firestore.rules` to handle minor league collections:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Helper function to check user role
    function isAdmin() {
      return request.auth != null &&
             get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
    }

    function isScorekeeper() {
      return request.auth != null &&
             get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'scorekeeper';
    }

    // Major league collections
    match /seasons/{season} {
      allow read: if request.auth != null;
      allow write: if isAdmin() || isScorekeeper();

      match /{document=**} {
        allow read: if request.auth != null;
        allow write: if isAdmin() || isScorekeeper();
      }
    }

    // Minor league collections - same rules as major
    match /minor_seasons/{season} {
      allow read: if request.auth != null;
      allow write: if isAdmin() || isScorekeeper();

      match /{document=**} {
        allow read: if request.auth != null;
        allow write: if isAdmin() || isScorekeeper();
      }
    }

    match /v2_players/{player} {
      allow read: if request.auth != null;
      allow write: if isAdmin();

      match /{document=**} {
        allow read: if request.auth != null;
        allow write: if isAdmin();
      }
    }

    match /minor_v2_players/{player} {
      allow read: if request.auth != null;
      allow write: if isAdmin();

      match /{document=**} {
        allow read: if request.auth != null;
        allow write: if isAdmin();
      }
    }

    match /v2_teams/{team} {
      allow read: if request.auth != null;
      allow write: if isAdmin();

      match /{document=**} {
        allow read: if request.auth != null;
        allow write: if isAdmin();
      }
    }

    match /minor_v2_teams/{team} {
      allow read: if request.auth != null;
      allow write: if isAdmin();

      match /{document=**} {
        allow read: if request.auth != null;
        allow write: if isAdmin();
      }
    }

    // Add similar rules for other minor_ collections as needed

    // Shared collections
    match /users/{userId} {
      allow read: if request.auth != null;
      allow write: if request.auth.uid == userId || isAdmin();
    }

    match /notifications/{notification} {
      allow read: if request.auth != null;
      allow write: if isAdmin();
    }
  }
}
```

## Testing Checklist

Before deploying to production:

- [ ] Test all admin functions with both `league: 'major'` and `league: 'minor'`
- [ ] Test all scorekeeper functions with both leagues
- [ ] Verify that omitting the `league` parameter defaults to major league
- [ ] Test league switcher UI component
- [ ] Verify Firestore queries use correct collection names
- [ ] Test that shared collections (users, notifications) work for both leagues
- [ ] Verify that scheduled functions are running for both leagues
- [ ] Test document triggers for both league-specific collections

## Migration Timeline

1. **Backend Deployment**: Deploy updated Cloud Functions with multi-league support
2. **Firestore Rules Update**: Update security rules to include minor league collections
3. **Frontend Update**: Add league context and update all function calls
4. **Data Setup**: Create initial minor league collections and test data
5. **User Training**: Train admins and scorekeepers on league parameter usage

## Support and Questions

For questions about this migration, please contact the development team.
