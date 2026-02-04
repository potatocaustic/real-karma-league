// /js/season-utils.js
// Central helper to resolve season IDs in a safe, lock-first order.

export function getSeasonIdFromPage(options = {}) {
    const { fallback = null } = options;

    const explicitSeason = document.documentElement?.dataset?.season
        || document.body?.dataset?.season
        || window.SEASON_ID;

    const isActiveOverride = typeof explicitSeason === 'string' && explicitSeason.toLowerCase() == 'active';

    const urlParams = new URLSearchParams(window.location.search);
    const querySeason = urlParams.get('season');

    const pathMatch = window.location.pathname.match(/\/S(\d+)\//);
    const pathSeason = pathMatch ? `S${pathMatch[1]}` : null;

    const seasonId = isActiveOverride ? null : (explicitSeason || pathSeason || querySeason || fallback);
    const isLocked = isActiveOverride ? false : Boolean(explicitSeason || pathSeason || querySeason);

    return { seasonId, isLocked };
}
