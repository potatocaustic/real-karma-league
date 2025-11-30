# Firebase Data Model and Write Semantics

This document describes how the Real Karma League Firestore database is organized, how environments are separated, and how key values are produced or updated by backend Cloud Functions.

## Collection naming and environment boundaries

- **League prefixes:** Helpers build collection names with a `minor_` prefix for the minor league; major-league collections have no prefix. The helper is applied everywhere except for shared collections and internally structured subcollections (e.g., `games`, `lineups`).【F:functions/utils/firebase-helpers.js†L22-L62】
- **Shared collections:** `users`, `notifications`, and `scorekeeper_activity_log` are always unprefixed and therefore shared across leagues.【F:functions/utils/firebase-helpers.js†L22-L62】
- **Dev suffix:** A `_dev` suffix can be appended globally (controlled by `USE_DEV_COLLECTIONS`), and many rules explicitly expose parallel `_dev` collections for staging data (for example, `v2_players_dev`, `lineup_deadlines_dev`, `minor_live_games_dev`).【F:functions/utils/firebase-helpers.js†L22-L62】【F:firestore.rules†L57-L101】
- **Minor vs. major:** Every league-specific collection has a minor-league counterpart with the `minor_` prefix (e.g., `live_games` ↔ `minor_live_games`, `seasons` ↔ `minor_seasons`). Rules mirror the production structure for minor league access control.【F:firestore.rules†L203-L310】

## Access control and roles

- **Roles checked by rules:** The rules distinguish `admin`, `scorekeeper`, and `gm` roles stored on `users`/`users_dev` documents. Helper functions gate privileged writes and allow GMs to edit limited player fields when they manage that team.【F:firestore.rules†L6-L136】【F:firestore.rules†L179-L184】
- **Scorekeeper pathways:** Scorekeepers (or admins) can write live-scoring and lineup staging collections such as `live_games`, `pending_lineups`, and `live_scoring_status`; everyone can read live-game state.【F:firestore.rules†L73-L178】
- **Admin-only zones:** Administrative collections include `pending_transactions`, `activation_codes`, `notifications`, and all write access to roster/master data (`v2_players`, `v2_teams`, `draftPicks`, leaderboards, awards, lottery results, power rankings). End users can only read them.【F:firestore.rules†L64-L188】

## High-level collection map

- **Users & auth:** `users`/`users_dev` documents store role, `team_id`, and identity used by rules for authorization checks. Activation codes live in `activation_codes` and `activation_codes_dev` for gated onboarding.【F:firestore.rules†L6-L191】
- **Season containers:** `seasons` (and `minor_seasons`) hold one document per season with metadata like `status`, `current_week`, cumulative games/transactions/karma counters, and a child hierarchy (see below). Historical seasons are created with the same structure but a `completed` status.【F:functions/seasons/season-creation.js†L8-L90】
- **Master data:**
  - `v2_players` / `minor_v2_players`: One document per player, plus a `seasonal_stats` subcollection with season documents. In the minor league, the child subcollection itself is also prefixed (`minor_seasonal_stats`) even though it already lives under `minor_v2_players`. GMs may update `player_handle` for their own players; other edits are admin-only.【F:firestore.rules†L127-L137】【F:functions/utils/firebase-helpers.js†L22-L62】
  - `v2_teams` / `minor_v2_teams`: One document per franchise with a `seasonal_records` subcollection keyed by season. The minor branch uses `minor_seasonal_records` for those child collections, mirroring the parent prefixing behavior.【F:firestore.rules†L138-L140】【F:functions/seasons/structure.js†L55-L76】【F:functions/utils/firebase-helpers.js†L22-L62】
  - `draftPicks`, `draft_results`: Draft inventory and per-pick outcomes, including generated future picks during season rollovers.【F:firestore.rules†L142-L162】【F:functions/seasons/season-creation.js†L33-L85】
- **Scheduling and lineups:**
  - `lineup_deadlines` govern submission cutoffs; readable by authenticated users, writable by admins.【F:firestore.rules†L50-L63】
  - `pending_lineups` and season subcollections `lineups`, `post_lineups`, and `exhibition_lineups` hold in-progress or finalized lineup rows per game. Scorekeepers/admins write pending data; season subcollections are populated via lineup staging and game processing.【F:firestore.rules†L73-L101】【F:functions/seasons/structure.js†L35-L53】
- **Live scoring:** `live_games` documents contain the active scoreboard, while `live_scoring_status` tracks global scoring windows; finalized games are archived to `archived_live_games` for admins. Minor-league and `_dev` mirrors exist.【F:firestore.rules†L94-L178】
- **Transactions:** `transactions` (and `transactions/seasons/{seasonId}`) hold approved moves; `pending_transactions` is an admin queue. Minor and `_dev` copies follow the same pattern.【F:firestore.rules†L64-L158】
- **Leaderboards and reports:** `leaderboards`, `post_leaderboards`, `game_flow_snapshots`, `daily_scores`, `daily_averages`, and their postseason equivalents provide aggregated scoring outputs per season namespace created by the season scaffold.【F:firestore.rules†L193-L218】【F:functions/seasons/structure.js†L21-L33】
- **Awards & rankings:** `awards`, `power_rankings`, and `lottery_results` store end-of-period recognitions and odds; only admins may write them.【F:firestore.rules†L160-L174】
- **Trade ecosystem:** `tradeblocks` track GM trade availability, while `notifications` and `scorekeeper_activity_log` keep audit/event trails for admins.【F:firestore.rules†L70-L111】

## Season document layout

Each season document (`seasons/S{N}` or `minor_seasons/S{N}`) is created by backend functions with:
- Core fields: `season_name`, `status` (active or completed), `current_week`, cumulative `gp`, `gs`, `season_trans`, and `season_karma` counters.【F:functions/seasons/season-creation.js†L40-L54】
- Child collections: placeholders are seeded for `games`, `lineups`, `post_games`, `post_lineups`, `exhibition_games`, and `exhibition_lineups` under the season doc to keep queries/indexes stable.【F:functions/seasons/structure.js†L35-L41】
- Aggregation namespaces: For each season number `N`, top-level season-scoped docs are created under `daily_averages/season_N`, `daily_scores/season_N`, `post_daily_averages/season_N`, and `post_daily_scores/season_N`, each with a nested per-season collection (e.g., `S{N}_daily_scores`).【F:functions/seasons/structure.js†L21-L33】

## Player seasonal stats (per-player subcollection)

When a season is created, every player receives a `seasonal_stats/S{N}` document initialized to zero for all tracked metrics so downstream processors can write with merges. (In the minor league, these documents live under `minor_seasonal_stats` within `minor_v2_players`.) The seeded fields cover:

- **Game volume and participation:** Regular and postseason `games_played` and `post_games_played`, plus rookie/all-star string flags used for eligibility markers.【F:functions/seasons/structure.js†L43-L53】
- **Raw scoring and value:** Totals of adjusted points and single-game WAR for both season phases (`total_points`, `WAR`, and `post_` counterparts), plus geometric mean of ranks (`GEM`).【F:functions/seasons/structure.js†L43-L53】【F:functions/admin/admin-players.js†L55-L83】
- **Above-average/median performance:** Counts of days beating the daily mean/median (`aag_mean`, `aag_median`, `post_aag_mean`, `post_aag_median`) and percentage rates derived from games played (`*_pct`).【F:functions/seasons/structure.js†L43-L53】【F:functions/admin/admin-players.js†L84-L104】
- **Relative scoring to league baselines:** Sums of mean/median day scores (`meansum`, `medsum` and postseason equivalents) plus relative efficiency ratios (`rel_mean`, `rel_median`, `post_rel_mean`, `post_rel_median`).【F:functions/seasons/structure.js†L43-L53】【F:functions/admin/admin-players.js†L84-L104】
- **Ranking distribution:** Median/mean global ranks and geometric mean recorded for games played (`medrank`, `meanrank`, `GEM` and postseason versions).【F:functions/seasons/structure.js†L43-L53】【F:functions/admin/admin-players.js†L55-L83】
- **Top finishes:** Counts and rates for top-50/top-100 placements (`t50`, `t100`, `t50_pct`, `t100_pct` and postseason variants).【F:functions/seasons/structure.js†L43-L53】【F:functions/admin/admin-players.js†L84-L104】

These fields are later recomputed by `admin_recalculatePlayerStats`, which rebuilds the aggregates from lineup rows, daily averages, and postseason data before merging them back into the same document path.【F:functions/admin/admin-players.js†L38-L119】

### How stats are written

The `admin_recalculatePlayerStats` Cloud Function recomputes a player’s season metrics from lineup rows and daily averages, then merges the totals into the same `seasonal_stats` document:
- It queries regular and postseason lineup rows for the player where `started == "TRUE"`, then pulls the daily average docs for the matching dates.【F:functions/admin/admin-players.js†L38-L55】
- Calculated fields include games played, sum of `points_adjusted`, sum of `SingleGameWar`, AboveAvg/AboveMed counts, median/mean ranks, geometric mean, and top-50/top-100 finishes. Relative metrics divide totals by summed mean/median day scores, and percentages divide counts by games played.【F:functions/admin/admin-players.js†L66-L106】
- The function writes the aggregated object back to `v2_players/{playerId}/seasonal_stats/{seasonId}` with a merge, keeping non-overwritten fields intact.【F:functions/admin/admin-players.js†L109-L119】

## Team seasonal records (per-team subcollection)

For every team, `seasonal_records/S{N}` is created with zeroed competitive and bookkeeping fields so downstream calculations have a consistent schema. In the minor league those child collections are stored under `minor_seasonal_records`. Seeded fields include:

- **Results and progression:** Regular/postseason wins and losses, win percentage (`wpct`), and markers for play-in participation, playoff qualification, seeds, eliminations, and potential wins (`MaxPotWins`).【F:functions/seasons/structure.js†L55-L76】
- **Efficiency and rank metrics:** Pythagorean-style margin fields (`pam`, `apPAM`, `apPAM_total`, `apPAM_count`) and starter-rank aggregates (`med_starter_rank`, `msr_rank`, `post_med_starter_rank`, `post_msr_rank`, `pam_rank`, `post_pam_rank`).【F:functions/seasons/structure.js†L55-L76】
- **Transactions and ratings:** Total transaction count, tREL/post_tREL placeholders, overall sorting score, and copied metadata such as `team_name` from the active season record plus `gm_player_id` linkage back to the franchise owner.【F:functions/seasons/structure.js†L55-L76】

## Draft inventory lifecycle

Advancing a season automatically builds next-season documents and rolls draft assets forward:
- The active season is marked `completed`, a new `S{N+1}` doc is created with active status, and future draft picks (out to +5 seasons) are generated for each active team across three rounds with pick metadata (`pick_id`, `pick_description`, ownership fields).【F:functions/seasons/season-creation.js†L33-L85】
- Existing picks for the new season are deleted before regeneration to avoid duplication.【F:functions/seasons/season-creation.js†L56-L85】

## Live-scoring and game flow data

- **Live games:** `live_games` documents store in-progress scoring and are writable by scorekeepers/admins; archived results are copied to `archived_live_games` (readable by admins only).【F:firestore.rules†L94-L101】【F:firestore.rules†L146-L149】
- **Status controls:** `live_scoring_status` exposes flags and timing state that scorekeepers/admins can update to start or end live scoring windows.【F:firestore.rules†L175-L178】
- **Snapshots and leaderboards:** Aggregated per-game or per-day outputs are written into `game_flow_snapshots`, `leaderboards`, `post_leaderboards`, `daily_scores`, and `daily_averages`, all of which are admin-writable but publicly readable for consumption by clients.【F:firestore.rules†L193-L218】

## Trade, transaction, and roster workflows

- **Pending vs. finalized:** Incoming GM moves enter `pending_transactions` (admin-only) and, once processed, are stored in `transactions` plus season-scoped `transactions/seasons/{seasonId}` buckets. Minor and `_dev` branches mirror this shape.【F:firestore.rules†L64-L158】
- **Trade blocks:** GMs can publish their availability in `tradeblocks` documents keyed by `teamId`; writes are restricted to the owning GM UID or admins.【F:firestore.rules†L108-L111】
- **Team/GM cohesion:** Rules ensure GMs can only edit their own players’ `player_handle` fields by checking `users.team_id` against `v2_players.current_team_id`.【F:firestore.rules†L26-L137】
