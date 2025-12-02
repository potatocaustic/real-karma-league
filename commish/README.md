# Commish Portal

The Commish Portal provides league commissioners with a subset of admin tools for managing their respective leagues.

## Overview

The Commish Portal allows users to be designated as commissioners (commish) for specific leagues. This role is **league-specific**, meaning:
- Being a commish for the Major League does NOT grant access to Minor League tools
- Being a commish for the Minor League does NOT grant access to Major League tools
- Users can have different roles in different leagues (e.g., commish in Minor, GM in Major)

## Access & Permissions

### Commish Tools
Commish users have access to the following management tools:

1. **Manage Games & Scores** - Enter weekly scores and lineups (without auto-deadline setter)
2. **Manage Transactions** - Log trades, signings, and roster moves
3. **Manage Players** - Edit player details and team assignments (without player ID migration)
4. **Manage Teams** - Update team information (without GM User ID and GM Player ID fields)
5. **Reports** - Generate lineups, deadlines, and GOTD reports

### Restricted Features
The following admin features are NOT available to commish users:
- Auto-deadline setter tool
- Player ID migration (danger zone)
- GM User ID and Player ID field editing in team management
- Creating new seasons
- Managing access codes
- Draft lottery management
- And other admin-only features

## Firebase User Roles Structure

### Role Fields in `users` Collection

Each user document in the `users` collection can have the following role-related fields:

```javascript
{
  uid: "user_firebase_uid",
  email: "user@example.com",
  role: "admin",              // Global admin role (optional)
  role_major: "commish",      // Role for major league (optional)
  role_minor: "gm",           // Role for minor league (optional)
  // ... other user fields
}
```

### Role Values

- `role: "admin"` - Global admin with access to everything in both leagues
- `role_major: "commish"` - Commissioner for the Major League only
- `role_minor: "commish"` - Commissioner for the Minor League only
- `role_major: "gm"` or `role_minor: "gm"` - GM for the respective league

### Examples

**Example 1: User who is commish for both leagues**
```javascript
{
  uid: "abc123",
  role_major: "commish",
  role_minor: "commish"
}
```

**Example 2: User who is commish for minor league and GM for major league**
```javascript
{
  uid: "def456",
  role_major: "gm",
  role_minor: "commish"
}
```

**Example 3: Global admin (has access to everything)**
```javascript
{
  uid: "xyz789",
  role: "admin"
}
```

## Assigning Commish Roles

To appoint a user as commish for a league:

1. Go to Firebase Console
2. Navigate to Firestore Database
3. Find the `users` collection
4. Locate the user's document (by UID)
5. Add or update the appropriate field:
   - For Major League commish: Set `role_major` to `"commish"`
   - For Minor League commish: Set `role_minor` to `"commish"`
6. Save the changes

The user will immediately have access to the Commish Portal for that league upon their next page load or login.

## Technical Implementation

### Authentication Logic

The commish authentication is handled by `/commish/commish.js`, which exports:

- `isCommishForLeague(userData, league)` - Checks if a user has commish access for a specific league
- `initCommishAuth(onSuccess)` - Initializes authentication for commish pages

### League Context

The system uses `getCurrentLeague()` from `firebase-init.js` to determine which league the user is currently viewing. The league switcher in the UI allows users to toggle between leagues, and the authentication checks are performed based on the current league context.

## File Structure

```
/commish/
├── README.md                    # This file
├── tutorial.html                # Comprehensive tutorial and guide
├── commish.js                   # Shared authentication utilities
├── dashboard.html               # Main commish portal dashboard
├── dashboard.js                 # Dashboard logic
├── manage-games.html            # Game management (no auto-deadline)
├── manage-games.js
├── manage-transactions.html     # Transaction management
├── manage-transactions.js
├── manage-players.html          # Player management (no danger zone)
├── manage-players.js
├── manage-teams.html            # Team management (restricted fields)
├── manage-teams.js
├── manage-reports.html          # Report generation
└── manage-reports.js
```

## URL Access

Commish users can access the portal at:
- **Main Dashboard**: `/commish/dashboard.html`
- **Tutorial & Guide**: `/commish/tutorial.html`
- The dashboard provides links to all available commish tools

## Notes

- Admins (users with `role: "admin"`) automatically have access to all commish tools as well as admin-only features
- The league switcher on each page allows switching between Major and Minor leagues
- Access is checked on page load and when switching leagues
- Users without appropriate permissions will see an "Access Denied" message specific to the league they're trying to access
