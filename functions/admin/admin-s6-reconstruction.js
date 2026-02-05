// functions/admin/admin-s6-reconstruction.js

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { db } = require('../utils/firebase-admin');
const { getCollectionName } = require('../utils/firebase-helpers');
const axios = require("axios");
const { buildHeaders, REAL_API_BASE, realAuthToken } = require('../utils/real-api-client');

// API configuration
const RANKED_DAYS_API = `${REAL_API_BASE}/rankeddays`;
const KARMA_RANKS_API = `${REAL_API_BASE}/userkarmaranks/day`;
const buildRealHeaders = () => buildHeaders({ deviceName: 'Chrome on Windows' });

/**
 * Fetches ranked days history for a player from RealSports API.
 * Proxies the request through Cloud Functions to avoid CORS issues.
 */
exports.admin_fetchRankedDays = onCall({
    region: "us-central1",
    timeoutSeconds: 120,
    memory: "256MiB",
    secrets: [realAuthToken]
}, async (request) => {
    // Security check
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    const { userId, beforeDate, limitDate } = request.data;
    if (!userId) {
        throw new HttpsError('invalid-argument', 'Missing userId.');
    }

    try {
        let url = `${RANKED_DAYS_API}/${userId}?sort=latest`;
        if (beforeDate) {
            url += `&before=${beforeDate}`;
        }

        console.log(`Fetching ranked days for ${userId}: ${url}`);

        const response = await axios.get(url, {
            headers: buildRealHeaders(),
            timeout: 30000
        });

        return {
            success: true,
            days: response.data.days || [],
            userId
        };

    } catch (error) {
        console.error(`Error fetching ranked days for ${userId}:`, error.message);
        throw new HttpsError('internal', `Failed to fetch ranked days: ${error.message}`);
    }
});

/**
 * Fetches all ranked days for a player, paginating through the full history.
 * Stops at limitDate or when no more data is available.
 */
exports.admin_fetchAllRankedDays = onCall({
    region: "us-central1",
    timeoutSeconds: 300,
    memory: "512MiB",
    secrets: [realAuthToken]
}, async (request) => {
    // Security check
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    const { userId, limitDate = "2025-03-01" } = request.data;
    if (!userId) {
        throw new HttpsError('invalid-argument', 'Missing userId.');
    }

    const allDays = [];
    let oldest = null;
    let iterations = 0;
    const maxIterations = 50; // Safety limit

    try {
        while (iterations < maxIterations) {
            let url = `${RANKED_DAYS_API}/${userId}?sort=latest`;
            if (oldest) {
                url += `&before=${oldest}`;
            }

            console.log(`Fetching ranked days page ${iterations + 1} for ${userId}`);

            const response = await axios.get(url, {
                headers: buildRealHeaders(),
                timeout: 30000
            });

            const days = response.data.days || [];
            if (days.length === 0) {
                break;
            }

            allDays.push(...days);
            oldest = days[days.length - 1].day;

            if (oldest < limitDate) {
                break;
            }

            iterations++;

            // Small delay between requests to be polite
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        console.log(`Fetched ${allDays.length} total days for ${userId}`);

        return {
            success: true,
            days: allDays,
            userId,
            totalDays: allDays.length
        };

    } catch (error) {
        console.error(`Error fetching all ranked days for ${userId}:`, error.message);
        throw new HttpsError('internal', `Failed to fetch ranked days: ${error.message}`);
    }
});

/**
 * Fetches karma rankings for a specific date from RealSports API.
 * Returns up to 1000 entries (the API limit).
 */
exports.admin_fetchKarmaRankings = onCall({
    region: "us-central1",
    timeoutSeconds: 300,
    memory: "512MiB",
    secrets: [realAuthToken]
}, async (request) => {
    // Security check
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    const { date, maxEntries = 1020 } = request.data;
    if (!date) {
        throw new HttpsError('invalid-argument', 'Missing date.');
    }

    const allEntries = [];
    let offset = 0;
    const entriesPerPage = 20;

    try {
        while (offset < maxEntries) {
            let url = `${KARMA_RANKS_API}?day=${date}`;
            if (offset > 0) {
                url += `&before=${offset}`;
            }

            console.log(`Fetching karma rankings for ${date}, offset ${offset}`);

            const response = await axios.get(url, {
                headers: buildRealHeaders(),
                timeout: 30000
            });

            const users = response.data.users || [];
            if (users.length === 0) {
                break;
            }

            for (const user of users) {
                allEntries.push({
                    user_id: user.userId,
                    username: user.userName,
                    amount: user.amount,
                    rank: user.rank
                });
            }

            if (users.length < entriesPerPage) {
                break;
            }

            offset += entriesPerPage;

            // Small delay between requests
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        console.log(`Fetched ${allEntries.length} karma entries for ${date}`);

        return {
            success: true,
            date,
            entries: allEntries,
            totalEntries: allEntries.length
        };

    } catch (error) {
        console.error(`Error fetching karma rankings for ${date}:`, error.message);
        throw new HttpsError('internal', `Failed to fetch karma rankings: ${error.message}`);
    }
});

/**
 * Batch fetch karma rankings for multiple dates.
 * More efficient than calling single-date function repeatedly.
 */
exports.admin_fetchKarmaRankingsBatch = onCall({
    region: "us-central1",
    timeoutSeconds: 540,
    memory: "1GiB",
    secrets: [realAuthToken]
}, async (request) => {
    // Security check
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    const { dates, maxEntriesPerDate = 1020 } = request.data;
    if (!dates || !Array.isArray(dates) || dates.length === 0) {
        throw new HttpsError('invalid-argument', 'Missing or invalid dates array.');
    }

    // Limit batch size
    if (dates.length > 10) {
        throw new HttpsError('invalid-argument', 'Maximum 10 dates per batch.');
    }

    const results = {};
    const entriesPerPage = 20;

    for (const date of dates) {
        const entries = [];
        let offset = 0;

        try {
            while (offset < maxEntriesPerDate) {
                let url = `${KARMA_RANKS_API}?day=${date}`;
                if (offset > 0) {
                    url += `&before=${offset}`;
                }

                const response = await axios.get(url, {
                    headers: buildRealHeaders(),
                    timeout: 30000
                });

                const users = response.data.users || [];
                if (users.length === 0) {
                    break;
                }

                for (const user of users) {
                    entries.push({
                        user_id: user.userId,
                        username: user.userName,
                        amount: user.amount,
                        rank: user.rank
                    });
                }

                if (users.length < entriesPerPage) {
                    break;
                }

                offset += entriesPerPage;
                await new Promise(resolve => setTimeout(resolve, 200));
            }

            results[date] = {
                success: true,
                entries,
                totalEntries: entries.length
            };

            console.log(`Fetched ${entries.length} entries for ${date}`);

        } catch (error) {
            console.error(`Error fetching karma for ${date}:`, error.message);
            results[date] = {
                success: false,
                error: error.message,
                entries: [],
                totalEntries: 0
            };
        }

        // Delay between dates
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    return {
        success: true,
        results,
        datesProcessed: dates.length
    };
});
