# S10 Season Pages

These pages are pre-built for Season 10. They read data from Firestore using the season
ID inferred from the URL path (e.g. `/S10/`).

## Data placeholders
To create Firestore placeholders (season doc, team records, player stats, and empty
subcollections), run:

```
node scripts/prepare-upcoming-season.js --season 10 --league major --status upcoming
node scripts/prepare-upcoming-season.js --season 10 --league minor --status upcoming
```

## Schedule source
If you have a local schedule CSV, keep a copy alongside the season pages for reference.
