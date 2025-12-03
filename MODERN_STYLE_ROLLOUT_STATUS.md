# Modern Style Rollout - Current Status

## Project Overview

Implementing a "modern style rollout" system that applies `/admin/admin-styles.css` sitewide when enabled through the admin portal. This gives all S9 pages the same comprehensive modern styling as admin/commish pages, with reversibility from the admin portal.

## Current Branch
`claude/fix-modern-style-rollout-014ggT15anuN5yfNtDtERpuL`

## System Architecture

### Style Rollout Mechanism
- **File**: `/home/user/real-karma-league/js/style-rollout.js`
- **How it works**:
  - Checks Firebase for page-specific rollout status
  - If enabled, injects `/admin/admin-styles.css` via `<link>` tag
  - Sets `data-style-rollout="modern"` or `"legacy"` on `<html>` element
  - Admin/commish pages automatically use modern styles (no injection needed)

### Key Function:
```javascript
function injectAdminStylesheet() {
    injectStylesheet({ id: 'modern-style-link', href: '/admin/admin-styles.css' });
}

export async function applyPageStyleRollout() {
    const path = window.location.pathname;
    if (path.startsWith('/admin') || path.startsWith('/commish')) {
        return; // Already has modern styles
    }
    const pageKey = getPageStyleKey(path);
    const rolloutRef = doc(db, STYLE_ROLLOUT_COLLECTION, pageKey);
    const rolloutSnap = await getDoc(rolloutRef);
    const isEnabled = rolloutSnap.exists() && rolloutSnap.data().enabled === true;
    if (isEnabled) {
        injectAdminStylesheet();
        document.documentElement.dataset.styleRollout = 'modern';
    } else {
        document.documentElement.dataset.styleRollout = 'legacy';
    }
}
```

## Main Stylesheet

**File**: `/home/user/real-karma-league/admin/admin-styles.css`

This file now contains ~2000+ lines including:
- Original admin/commish styling
- S9-specific component styling (teams, transactions, standings, schedule, compare, home)
- Comprehensive dark mode support
- Modal styling for game details

### Design System - Dark Mode Color Palette

**Gradients for visual depth:**
- Headers: `linear-gradient(135deg, #1e3a8a, #1e40af)` (blue gradient)
- Containers: `linear-gradient(135deg, #1a1f2e, #1e2433)` (subtle dark gradient)
- Cards: `linear-gradient(145deg, #0f1419, #111827)` (card gradient)
- Tables: `linear-gradient(135deg, #1f2937, #243244)` (table headers)

**Borders:**
- Main borders: `#2d3748`
- Card borders: `#2d3a50`
- Stat/detail borders: `#3d4d6a`

**Key principle**: Avoid flat colors - use gradients and blue-tinted borders for visual interest

## Completed Pages

### ✅ Teams Page (`/S9/teams.html`)
- Conference sections with gradient headers
- Team cards with hover effects
- Team stats with proper contrast
- Mobile centering fixed
- Full dark mode support

### ✅ Transactions Page (`/S9/transactions.html`)
- Transaction type badges with gradients (trade, rescission, waiver, etc.)
- Transaction items styled consistently
- Team logos and details modernized
- Full dark mode support

### ✅ Standings Page (`/S9/standings.html`)
- Playoff legend with gradient color indicators
- Clinch legend styled
- Conference sections modernized
- Table headers with gradients (no visible column lines in dark mode)
- Full dark mode support

### ✅ Other S9 Pages
- **RKL-S9.html**: Home page with season info, quick nav, standings preview, recent games
- **Schedule page**: Week selector, buttons, game cards, standouts
- **Compare page**: Type selector, selectors grid, compare button
- All with consistent modern color scheme

### ✅ Footer
- Consistent styling across all pages

## Current Work: Schedule Page & Game Detail Modals

### Recently Fixed
1. ✅ Removed dropdown triangle backgrounds (visual artifacts in dark mode)
2. ✅ Modernized game detail modal base styling
3. ✅ Added circular team logo styling
4. ✅ Reduced game card max-width to 400px on desktop
5. ✅ Dark mode support for modals

### 🔧 Current Issues (Need Fixing)

#### Game Detail Modal Issues:
1. **Square outline around circular team logos** - Still visible, needs better fix
2. **Team container outlines don't contour properly** - Awkward whitespace, containers should match shape
3. **Line graph emoji needs replacement** - Replace with professional line graph icon for gameflow chart button
4. **Dark mode table header choppy gradient** - Column lines visible in header row (player/points/rank) because gradient resets, making it look choppy

#### Schedule Page Issue:
5. **Game tile spacing on desktop** - Tiles were made smaller (max-width: 400px) but container space didn't shrink, leaving awkward gaps. **User wants to revert size change** - keep original size but only update coloration/presentation, not dimensions.

### Modal Component Location
**File**: `/home/user/real-karma-league/common/game-modal-component.html`
- Shared component used across multiple pages
- Contains modal HTML structure, team breakdowns, lineup tables, game flow chart area

### Relevant CSS Sections in admin-styles.css

**Modal styling (lines ~1850-2000):**
```css
.modal-content {
    background: var(--admin-surface);
    border: 1px solid var(--admin-border);
    border-radius: 14px;
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.3);
}

.modal-header {
    background: linear-gradient(135deg, var(--admin-text), #111d35);
    border-radius: 14px 14px 0 0;
}

.modal-team-header .team-logo {
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.3);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
}

.team-breakdown {
    background: var(--admin-surface-subtle);
    border: 1px solid var(--admin-border);
    border-radius: 14px;
    box-shadow: 0 8px 22px rgba(0, 0, 0, 0.08);
}

.dark-mode .modal-content {
    background: linear-gradient(135deg, #1a1f2e, #1e2433);
    border-color: #2d3748;
}

.dark-mode .modal-header {
    background: linear-gradient(135deg, #1e3a8a, #1e40af);
}

.dark-mode .lineup-table th {
    background: linear-gradient(135deg, #1f2937, #243244);
    border-bottom-color: #2d3748;
}

.dark-mode #game-flow-chart-area {
    background: linear-gradient(135deg, #1f2937, #243244);
}
```

**Game card sizing (needs removal/revision):**
```css
@media (min-width: 769px) {
    .game-card {
        max-width: 400px; /* REMOVE THIS - causing spacing issues */
    }
}
```

## Next Steps

1. **Fix circular logo outline** - Investigate why border-radius: 50% not working, may need to target parent container or use `overflow: hidden`
2. **Fix team container shape** - Ensure border matches content shape, check padding/margin
3. **Replace line graph emoji** - Find SVG or icon font for professional line graph icon
4. **Fix choppy table header gradient** - Apply gradient to entire `<tr>` or use `background-attachment` to prevent reset per cell
5. **Remove game card max-width** - Delete the desktop media query that limits game-card width
6. **Test all changes** - Verify on both mobile and desktop, light and dark modes
7. **Commit and push** - Once all issues resolved

## Important Files Reference

| File | Purpose |
|------|---------|
| `/home/user/real-karma-league/js/style-rollout.js` | Rollout logic, injects admin-styles.css |
| `/home/user/real-karma-league/admin/admin-styles.css` | Main stylesheet with all modern styling |
| `/home/user/real-karma-league/common/game-modal-component.html` | Shared game detail modal component |
| `/home/user/real-karma-league/S9/schedule.html` | Schedule page with game cards |
| `/home/user/real-karma-league/S9/teams.html` | Teams page |
| `/home/user/real-karma-league/S9/transactions.html` | Transactions page |
| `/home/user/real-karma-league/S9/standings.html` | Standings page |

## Testing Checklist

Before considering complete:
- [ ] All modal issues resolved (logos, containers, icon, table headers)
- [ ] Game card spacing fixed on schedule page
- [ ] Test in light mode (all pages)
- [ ] Test in dark mode (all pages)
- [ ] Test on mobile viewport (<769px)
- [ ] Test on desktop viewport (≥769px)
- [ ] Verify no regressions on previously fixed pages

## Git Status

**Last commit**: `a8b77f2` - "Fix schedule page modals and game cards styling"

**Current state**: Working on modal and schedule page refinements

## User Preferences

- No emojis unless explicitly requested
- Avoid over-engineering - only fix what's requested
- Keep solutions simple and focused
- Use gradients over flat colors for depth
- Consistent color palette across all pages
- Mobile-first responsive design
