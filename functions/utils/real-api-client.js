// functions/utils/real-api-client.js
// Client for fetching data from Real Sports API

const fetch = require('node-fetch');
const { defineSecret } = require('firebase-functions/params');

// Define secret parameter (stored in Google Secret Manager)
const realAuthToken = defineSecret('REAL_AUTH_TOKEN');

// Real API base URL
const REAL_API_BASE = 'https://api.real.vg';

// Group IDs for transaction channels
const GROUP_IDS = {
    MAJOR_CHAT: '17515',      // Major league transaction chat
    MINOR_CHAT: '22162',      // Minor league transaction chat
    NEWS_CHANNEL: '25237'     // RKL News channel
};

/**
 * Simple Hashids-like encoder for request tokens
 * Based on pollbot.py pattern
 */
class SimpleHashids {
    constructor(salt, minLength) {
        this.salt = salt;
        this.minLength = minLength;
        this.alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
    }

    encode(number) {
        // Convert to base62-like encoding with salt
        const combined = `${this.salt}${number}`;
        let hash = 0;
        for (let i = 0; i < combined.length; i++) {
            const char = combined.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }

        // Use absolute value and convert to string
        hash = Math.abs(hash);

        // Build the encoded string
        let result = '';
        let n = hash;
        const alphabetLength = this.alphabet.length;

        while (n > 0 || result.length < this.minLength) {
            result = this.alphabet[n % alphabetLength] + result;
            n = Math.floor(n / alphabetLength);

            // Add some entropy from timestamp bits
            if (result.length < this.minLength) {
                const bit = (number >> result.length) & 1;
                result = this.alphabet[(bit * 26 + result.charCodeAt(0)) % alphabetLength] + result;
            }
        }

        return result.slice(0, this.minLength);
    }
}

/**
 * Generate a unique device UUID
 * Creates a consistent UUID for the function instance
 */
function generateDeviceUUID() {
    // Use a consistent UUID for the cloud function
    return 'cf-rkl-' + require('crypto').randomBytes(8).toString('hex');
}

// Cache the device UUID for this function instance
let cachedDeviceUUID = null;

/**
 * Generate a fresh request token using Hashids pattern
 * @returns {string} Fresh request token
 */
function generateRequestToken() {
    const hashids = new SimpleHashids('realwebapp', 16);
    return hashids.encode(Date.now());
}

/**
 * Get the auth token from environment/secret
 * @returns {string} Real API auth token
 */
function getAuthToken() {
    // Try secret manager first (production)
    try {
        const token = realAuthToken.value();
        if (token) {
            return token;
        }
    } catch (e) {
        // Secret not available, try env var
    }

    // Fallback to process.env (for local testing with .env file)
    if (process.env.REAL_AUTH_TOKEN) {
        return process.env.REAL_AUTH_TOKEN;
    }

    throw new Error('REAL_AUTH_TOKEN not configured. Set via: firebase functions:secrets:set REAL_AUTH_TOKEN');
}

/**
 * Build headers for Real API requests
 * @returns {Object} Headers object
 */
function buildHeaders() {
    if (!cachedDeviceUUID) {
        cachedDeviceUUID = generateDeviceUUID();
    }

    return {
        'real-auth-info': getAuthToken(),
        'real-device-uuid': cachedDeviceUUID,
        'real-request-token': generateRequestToken(),
        'real-version': '27',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    };
}

/**
 * Fetch group feed from Real API
 * @param {string} groupId - Group ID to fetch
 * @param {string|null} before - Timestamp for pagination (ISO format)
 * @param {number} limit - Number of items to fetch (default 50)
 * @returns {Promise<Object>} Feed response with groupFeedItems
 */
async function fetchGroupFeed(groupId, before = null, limit = 50) {
    let url = `${REAL_API_BASE}/groups/${groupId}/feedadvanced?limit=${limit}`;

    if (before) {
        // URL encode the timestamp for pagination
        url += `&before=${encodeURIComponent(before)}`;
    }

    console.log(`Fetching Real API: ${url}`);

    const response = await fetch(url, {
        method: 'GET',
        headers: buildHeaders()
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Real API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return data;
}

/**
 * Fetch all new comments from a group since a given comment ID
 * @param {string} groupId - Group ID to fetch
 * @param {string|null} sinceCommentId - Last processed comment ID (null for initial fetch)
 * @param {number} maxPages - Maximum pages to fetch to avoid runaway
 * @returns {Promise<Array>} Array of comment objects
 */
async function fetchNewComments(groupId, sinceCommentId = null, maxPages = 10) {
    const allComments = [];
    let before = null;
    let pageCount = 0;
    let foundSinceId = false;

    while (pageCount < maxPages && !foundSinceId) {
        const feedData = await fetchGroupFeed(groupId, before);
        const items = feedData.groupFeedItems || [];

        if (items.length === 0) {
            break;
        }

        for (const item of items) {
            // Skip non-comment items (player box scores, etc.)
            if (item.feedItemType !== 'comment' || !item.id) {
                continue;
            }

            // Stop if we've reached the last processed comment
            if (sinceCommentId && item.id === sinceCommentId) {
                foundSinceId = true;
                break;
            }

            allComments.push(item);
        }

        // Get timestamp of last item for pagination
        const lastItem = items[items.length - 1];
        if (lastItem && lastItem.createdAt) {
            before = lastItem.createdAt;
        } else {
            break;
        }

        pageCount++;
    }

    console.log(`Fetched ${allComments.length} new comments from group ${groupId} (${pageCount} pages)`);
    return allComments;
}

/**
 * Extract plain text from comment content nodes
 * @param {Object} content - Comment content object with nodes
 * @returns {string} Plain text representation
 */
function extractPlainText(content) {
    if (!content || !content.nodes) {
        return '';
    }

    const textParts = [];

    for (const node of content.nodes) {
        if (node.type === 'Paragraph' && node.children) {
            const paragraphParts = [];
            for (const child of node.children) {
                if (child.type === 'Text' && child.text) {
                    paragraphParts.push(child.text);
                } else if (child.type === 'Mention' && child.name) {
                    paragraphParts.push(`@${child.name}`);
                }
            }
            textParts.push(paragraphParts.join(''));
        }
    }

    return textParts.join('\n');
}

/**
 * Extract mentions from comment content nodes
 * @param {Object} content - Comment content object with nodes
 * @returns {Array} Array of mention objects {name, type}
 */
function extractMentions(content) {
    if (!content || !content.nodes) {
        return [];
    }

    const mentions = [];

    for (const node of content.nodes) {
        if (node.type === 'Paragraph' && node.children) {
            for (const child of node.children) {
                if (child.type === 'Mention' && child.name) {
                    mentions.push({
                        name: child.name,
                        type: child.mentionType || 'user'
                    });
                }
            }
        }
    }

    return mentions;
}

module.exports = {
    fetchGroupFeed,
    fetchNewComments,
    extractPlainText,
    extractMentions,
    GROUP_IDS,
    REAL_API_BASE,
    realAuthToken // Export secret for function declarations
};
