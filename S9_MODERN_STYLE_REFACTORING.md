# S9 Pages Modern Style Refactoring Guide

## Project Overview

Refactoring S9 pages to use their original CSS files with modern color/gradient overrides instead of having styles in `admin-styles.css`. This ensures pages maintain their perfect original layout while allowing modern styling when the rollout is enabled.

## The Problem

When `admin-styles.css` is injected for modern style rollout, it was:
1. Overriding S9 page layouts with admin-specific styles
2. Changing spacing, padding, and structure (not just colors)
3. Causing layout issues that were hard to debug

## The Solution Pattern

### Step 1: Remove S9-Specific Styles from admin-styles.css

For each S9 page, remove ALL page-specific selectors from `admin-styles.css`:
- Main component selectors (`.week-selector`, `.game-card`, etc.)
- Dark mode variants (`.dark-mode .week-selector`, etc.)
- Media query overrides
- Any layout-related styles

**Important:** Also scope broad selectors to exclude S9 pages:
- `body` → `body:not(.s9-page)`
- `header` → `body:not(.s9-page) header`
- `footer` → `body:not(.s9-page) footer`
- `main` → Keep only `main#admin-container` (remove fallback `, main`)

### Step 2: Create/Update Page-Specific CSS File

For pages with inline `<style>` blocks:
1. Create `/css/[pagename].css` with the inline styles
2. Add modern overrides using `[data-style-rollout="modern"]` selectors
3. Update HTML to link to new CSS file

For pages with existing CSS files:
1. Keep all original styles as-is
2. Add modern overrides at the end using `[data-style-rollout="modern"]` selectors

### Step 3: Add Modern Color Overrides

Add these sections to each page's CSS file:

```css
/* ====================================================================== */
/* MODERN STYLE OVERRIDES (only apply when data-style-rollout="modern") */
/* ====================================================================== */

/* Light theme modern colors */
[data-style-rollout="modern"] .component {
    background: linear-gradient(135deg, #ffffff, #f8f9fa);
    border: 1px solid #e5e7eb;
    box-shadow: 0 10px 26px rgba(0, 0, 0, 0.08);
}

/* Header/Nav bar - Light theme */
[data-style-rollout="modern"] header {
    background: linear-gradient(135deg, #0f172a, #111d35);
    border-bottom: 1px solid #1f2937;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.16);
}

/* Footer - Light theme */
[data-style-rollout="modern"] footer {
    background: linear-gradient(135deg, #0f172a, #111d35);
    border-top: 1px solid #1f2937;
}

[data-style-rollout="modern"] footer a {
    color: #60a5fa;
}

[data-style-rollout="modern"] footer a:hover {
    color: #93c5fd;
}

/* Dark mode modern overrides */
[data-style-rollout="modern"].dark-mode .component {
    background: linear-gradient(135deg, #1a1f2e, #1e2433);
    border-color: #2d3748;
}

/* Footer - Dark theme */
[data-style-rollout="modern"].dark-mode footer {
    background: linear-gradient(135deg, #1a1f2e, #1e2433);
    border-top: 1px solid #2d3748;
}

[data-style-rollout="modern"].dark-mode footer a {
    color: #60a5fa;
}

[data-style-rollout="modern"].dark-mode footer a:hover {
    color: #93c5fd;
}
```

## Modern Color Palette

### Light Theme
- **Backgrounds**: `linear-gradient(135deg, #ffffff, #f8f9fa)`
- **Borders**: `#e5e7eb`
- **Headers**: `linear-gradient(135deg, #0f172a, #111d35)`
- **Cards**: `linear-gradient(145deg, #ffffff, #f8f9fa)`
- **Shadows**: `0 10px 26px rgba(0, 0, 0, 0.08)`
- **Links**: `#2563eb` (hover: `#1d4ed8`)
- **Accent Blue**: `#2563eb`
- **Success Green**: `#4ade80`
- **Error Red**: `#f87171`

### Dark Theme
- **Backgrounds**: `linear-gradient(135deg, #1a1f2e, #1e2433)`
- **Borders**: `#2d3748`
- **Headers**: `linear-gradient(135deg, #111827, #1b2435)`
- **Cards**: `linear-gradient(145deg, #0f1419, #111827)`
- **Shadows**: `0 16px 35px rgba(0, 0, 0, 0.35)`
- **Links**: `#60a5fa` (hover: `#93c5fd`)
- **Accent Blue**: `#60a5fa`
- **Success Green**: `#4ade80`
- **Error Red**: `#f87171`

## Completed Pages

### ✅ /S9/RKL-S9.html
- **CSS File**: `/css/RKL-S9.css` (already existed)
- **Removed from admin-styles.css**: `.season-info`, `.quick-nav`, `.nav-card`, `.standings-preview`, `.recent-games`, `.games-header`, `.conference-title`, `.games-list`, `.view-full`
- **Modern Overrides Added**: ✅
- **Header/Footer Fixed**: ✅
- **Special Notes**: Team icon sizes increased to offset shadow effect

### ✅ /S9/schedule.html
- **CSS File**: `/css/schedule.css` (created from inline styles)
- **Removed from admin-styles.css**: `.week-selector`, `.week-btn`, `.week-dropdown`, `.week-standouts-section`, `.standout-item`, `.games-container`, `.game-card`, `.date-header`, `.filter-container`
- **Modern Overrides Added**: ✅
- **Header/Footer Fixed**: ✅
- **Special Notes**: Fixed completed week button text to be white (was invisible)

### ✅ /S9/teams.html
- **CSS File**: `/css/teams.css` (created from inline styles)
- **Removed from admin-styles.css**: `.conference-section`, `.conference-header`, `.teams-grid`, `.team-card`, `.team-header`, `.team-logo`, `.team-info`, `.team-name`, `.team-id`, `.gm-name`, `.team-stats`, `.stat-item`, `.stat-value`, `.stat-label`, `.playoff-position`, `.playoff-seed`, `.playin-seed`, `.eliminated`, `.record-positive`, `.record-negative`, `.pam-positive`, `.pam-negative`
- **Modern Overrides Added**: ✅
- **Header/Footer Fixed**: ✅
- **Special Notes**: Conference section and header styles work for both teams and standings pages

### ✅ /S9/transactions.html
- **CSS File**: `/css/transactions.css` (created from inline styles)
- **Removed from admin-styles.css**: `.filter-controls`, `.filter-row`, `.filter-group`, `.transactions-container`, `.transactions-header`, `.transactions-list`, `.transaction-item`, `.transaction-header`, `.transaction-type`, `.transaction-date`, `.transaction-details`, `.player-name-link`, `.team-name-link`, `.player-stats-inline`, `.gm-name`, `.draft-pick`, `.multi-transaction`, `.multi-rescission`, `.trade-parts`, `.trade-side`, `.trade-arrow`, `.trade-team`, `.trade-assets`
- **Modern Overrides Added**: ✅
- **Header/Footer Fixed**: ✅
- **Special Notes**: Transaction badges use gradients, trade visualizations support 2-4 team trades

### ✅ /S9/standings.html
- **CSS File**: `/css/standings.css` (created from inline styles)
- **Removed from admin-styles.css**: `.standings-container`, `.page-buttons-container`, `.view-toggle-button`, `.pr-version-selector-container`, `.pr-version-select`, `.power-rankings-summary`, `.standings-table`, `.playoff-legend`, `.clinch-legend`, `.legend-title`, `.legend-items`, `.legend-color`, `.playoff-color`, `.playin-color`, `.eliminated-color`, `.clinch-badge`, `.clinch-playoff`, `.clinch-playin`, `.clinch-eliminated`
- **Modern Overrides Added**: ✅
- **Header/Footer Fixed**: ✅
- **Special Notes**: Supports conference, full league, and power rankings views with sortable tables and responsive layouts

### ✅ /S9/compare.html
- **CSS File**: `/css/compare.css` (created from inline styles)
- **Removed from admin-styles.css**: `.type-selector`, `.selectors-grid`, `.selector-box`, `.options-container`, `.option`, `.option-icon`, `.vs-separator`, `.compare-btn-container`, `.compare-btn`, `.results-container`, `.comparison-container`, `.comparison-grid`, `.comparison-row`, `.metric-value`, `.metric-label`, `.entity-header`, `.entity-icon`, `.rookie-badge-compare`, `.all-star-badge-compare`
- **Modern Overrides Added**: ✅
- **Header/Footer Fixed**: ✅
- **Special Notes**: Interactive comparison tool with autocomplete dropdowns, supports both player and team comparisons with winner highlighting

### ✅ /S9/leaderboards.html
- **CSS File**: `/css/leaderboards.css` (already existed)
- **Removed from admin-styles.css**: Scoped admin loading/shell styles away from S9 pages
- **Modern Overrides Added**: ✅
- **Header/Footer Fixed**: ✅
- **Special Notes**: Added gradient/card/button overrides for stat category tables while preserving original spacing

### ✅ /S9/postseason-leaderboards.html
- **CSS File**: `/css/postseason-leaderboards.css` (already existed)
- **Removed from admin-styles.css**: Scoped admin loading/shell styles away from S9 pages
- **Modern Overrides Added**: ✅
- **Header/Footer Fixed**: ✅
- **Special Notes**: Mirrors regular-season leaderboard theming for postseason stat views

### ✅ /S9/historical-daily-leaderboards.html
- **CSS File**: `/css/historical-daily-leaderboards.css` (already existed)
- **Removed from admin-styles.css**: Scoped shared `.page-header` and `.back-link` styles to `body:not(.s9-page)`
- **Modern Overrides Added**: ✅
- **Header/Footer Fixed**: ✅
- **Special Notes**: Modern gradients cover date selector, navigation buttons, modal, and stat tiles while keeping layout intact

## Remaining Pages to Refactor

### Priority Order (by complexity)

**Status:** All items below have been completed with modern overrides.

1. **draft-capital.html** - Draft picks tables
2. **draft-results.html** - Draft picks, player cards
3. **draft-lottery.html** - Lottery results
4. **draft-prospects.html** - Prospect cards
5. **trophy-case.html** - Trophy displays
6. **team.html** - Team details, stats tables
7. **player.html** - Player details, stats tables
8. **playoff-bracket.html** - Bracket visualization

## Progress Tracker

- [x] draft-capital.html — Added modern rollout overrides to `/css/draft-capital.css`, including header/footer gradients and light/dark component treatments.
- [x] draft-results.html — Moved inline styles to `/css/draft-results.css` and added modern gradients for quick links, tables, header, and footer.
- [x] draft-lottery.html — Added modern rollout gradients to `/css/draft-lottery.css` for cards, buttons, tables, and header/footer.
- [x] draft-prospects.html — Moved responsive inline styles into `/css/prospects-styles.css` and layered modern table/header/footer overrides.
- [x] trophy-case.html — Enhanced `/css/trophy-case.css` with modern gradients for award/all-star cards, modal, and header/footer colors.
- [x] team.html - Added modern gradients and borders in `/css/team.css` for team header, roster/schedule sections, draft capital tiles, and header/footer.
- [x] player.html — Added modern rollout treatments in `/css/player.css` covering player header, stat cards, performance tables, and header/footer.
- [x] playoff-bracket.html — Moved inline styles to `/css/playoff-bracket.css` and added modern gradients for play-in panels, teams, rounds, and header/footer.

## Common Issues to Fix on Every Page

### Issue 1: Nav Bar Color (Light Theme)
**Problem**: Nav bar has old washed-out gray color instead of modern blue gradient

**Fix**:
```css
[data-style-rollout="modern"] header {
    background: linear-gradient(135deg, #0f172a, #111d35);
    border-bottom: 1px solid #1f2937;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.16);
}
```

### Issue 2: Footer Color (Both Themes)
**Problem**: Footer has old colors instead of modern palette

**Fix** (always add both):
```css
/* Footer - Light theme */
[data-style-rollout="modern"] footer {
    background: linear-gradient(135deg, #0f172a, #111d35);
    border-top: 1px solid #1f2937;
}

[data-style-rollout="modern"] footer a {
    color: #60a5fa;
}

[data-style-rollout="modern"] footer a:hover {
    color: #93c5fd;
}

/* Footer - Dark theme */
[data-style-rollout="modern"].dark-mode footer {
    background: linear-gradient(135deg, #1a1f2e, #1e2433);
    border-top: 1px solid #2d3748;
}

[data-style-rollout="modern"].dark-mode footer a {
    color: #60a5fa;
}

[data-style-rollout="modern"].dark-mode footer a:hover {
    color: #93c5fd;
}
```

## Workflow for Each Page

1. **Identify the page's CSS**
   - Check if page has inline `<style>` block or references external CSS
   - Note all unique selectors used by the page

2. **Remove from admin-styles.css**
   - Search for page-specific selectors
   - Remove light mode styles
   - Remove dark mode styles (`.dark-mode .selector`)
   - Remove media query overrides
   - Test that nothing breaks on admin pages

3. **Create/Update page CSS file**
   - If inline styles: Create `/css/[pagename].css` and move them
   - If external CSS: Keep file as-is
   - Add link in HTML if needed

4. **Add modern overrides**
   - Copy pattern from RKL-S9.css or schedule.css
   - Update selectors for this page's components
   - **Always include header and footer overrides**
   - Test in both light and dark themes

5. **Commit and test**
   - Commit changes with clear message
   - Test page with modern rollout enabled
   - Test page with modern rollout disabled
   - Verify no layout changes, only colors/gradients

## Testing Checklist

For each refactored page, verify:

- [ ] Page loads without errors
- [ ] Layout identical to original (no spacing/padding changes)
- [ ] Modern colors apply when rollout enabled
- [ ] Old colors remain when rollout disabled
- [ ] Header has modern blue gradient (light theme)
- [ ] Footer has modern colors (both themes)
- [ ] All interactive elements (buttons, links) visible
- [ ] Dark mode works correctly
- [ ] Mobile responsive layout unchanged
- [ ] No admin pages broken

## Key Principles

1. **Only change colors, gradients, shadows** - Never change layout, spacing, or structure
2. **Use `[data-style-rollout="modern"]` for all overrides** - Ensures they only apply when enabled
3. **Always fix header and footer** - These are missed on every page by default
4. **Test both themes** - Light and dark mode must both work
5. **Keep original CSS intact** - Modern overrides should be additive only
6. **Scope admin-styles.css properly** - Use `:not(.s9-page)` to exclude S9 pages

## Branch

All work is being done on: `claude/fix-nav-card-height-01BCttnT4fz6YMMHEMJm27PW`

## References

- Main documentation: `/home/user/real-karma-league/MODERN_STYLE_ROLLOUT_STATUS.md`
- Admin styles: `/home/user/real-karma-league/admin/admin-styles.css`
- Example CSS files:
  - `/home/user/real-karma-league/css/RKL-S9.css` (lines 1001-1184)
  - `/home/user/real-karma-league/css/schedule.css` (lines 168-362)
