// functions/utils/transaction-text-parser.js
// Parser for transaction text from Real app posts

const { extractMentions, extractPlainText } = require('./real-api-client');

/**
 * Transaction types we can detect
 */
const TRANSACTION_TYPES = {
    RETIREMENT: 'RETIREMENT',
    UNRETIREMENT: 'UNRETIREMENT',
    SIGN: 'SIGN',
    CUT: 'CUT',
    TRADE: 'TRADE'
};

/**
 * Keywords to filter out (not transactions)
 */
const FILTER_KEYWORDS = [
    'gm', 'co-gm', 'co gm', 'appointed', 'manager',
    'suspended', 'suspension', 'penalty', 'ban',
    'rebrand', 'renamed', 'rebranding',
    'trade request', 'rescinds', 'rescind',
    'interested in', 'looking for'
];

/**
 * Patterns for detecting transaction types
 * Each pattern returns { type, confidence } if matched
 */
const TRANSACTION_PATTERNS = [
    // Retirement patterns
    {
        regex: /@(\w+)\s+retir(?:es?|ing)\s+(?:from\s+)?(\w+)/i,
        type: TRANSACTION_TYPES.RETIREMENT,
        extract: (match) => ({
            players: [{ handle: match[1], to: 'RETIRED' }],
            teamName: match[2]
        })
    },
    {
        // "Player retires" without team name (simpler pattern)
        regex: /@(\w+)\s+retir(?:es?|ing)/i,
        type: TRANSACTION_TYPES.RETIREMENT,
        extract: (match) => ({
            players: [{ handle: match[1], to: 'RETIRED' }],
            teamName: null
        })
    },

    // Unretirement patterns
    {
        regex: /@(\w+)\s+unretir(?:es?|ing)\s+to\s+(\w+)/i,
        type: TRANSACTION_TYPES.UNRETIREMENT,
        extract: (match) => ({
            players: [{ handle: match[1] }],
            teamName: match[2]
        })
    },

    // Cut patterns
    {
        // "Team cuts/cut/cutting @player"
        regex: /(\w+)\s+cut(?:s|ting)?\s+@(\w+)/i,
        type: TRANSACTION_TYPES.CUT,
        extract: (match) => ({
            teamName: match[1],
            players: [{ handle: match[2], to: 'FREE_AGENT' }]
        })
    },
    {
        // Multiple cuts: "Team cuts @player1 and @player2"
        regex: /(\w+)\s+cut(?:s|ting)?\s+@(\w+)\s+and\s+@(\w+)/i,
        type: TRANSACTION_TYPES.CUT,
        extract: (match) => ({
            teamName: match[1],
            players: [
                { handle: match[2], to: 'FREE_AGENT' },
                { handle: match[3], to: 'FREE_AGENT' }
            ]
        })
    },

    // Sign patterns
    {
        // "Team signs/sign @player"
        regex: /(\w+)\s+sign(?:s|ing)?\s+@(\w+)/i,
        type: TRANSACTION_TYPES.SIGN,
        extract: (match) => ({
            teamName: match[1],
            players: [{ handle: match[2] }]
        })
    },

    // Trade patterns (basic - "Trade between X and Y")
    {
        regex: /trade\s+between\s+(\w+)\s+and\s+(\w+)/i,
        type: TRANSACTION_TYPES.TRADE,
        extract: (match) => ({
            teamNames: [match[1], match[2]],
            players: [] // Will be extracted separately
        })
    },
    {
        // "X receives @player from Y" pattern
        regex: /(\w+)\s+receives?\s+@(\w+)\s+from\s+(\w+)/i,
        type: TRANSACTION_TYPES.TRADE,
        extract: (match) => ({
            teamNames: [match[1], match[3]],
            players: [{ handle: match[2], from: match[3], to: match[1] }]
        })
    }
];

/**
 * Parse a single line of transaction text
 * @param {string} line - Single line of text
 * @param {Array} mentions - Mentions extracted from content
 * @returns {Object|null} Parsed transaction or null
 */
function parseTransactionLine(line, mentions) {
    // Check for filter keywords first
    const lowerLine = line.toLowerCase();
    for (const keyword of FILTER_KEYWORDS) {
        if (lowerLine.includes(keyword)) {
            return null;
        }
    }

    // Try each pattern
    for (const pattern of TRANSACTION_PATTERNS) {
        const match = line.match(pattern.regex);
        if (match) {
            const extracted = pattern.extract(match);
            return {
                type: pattern.type,
                ...extracted,
                rawLine: line
            };
        }
    }

    return null;
}

/**
 * Parse a comment for transactions
 * @param {Object} comment - Comment object from Real API
 * @returns {Object} Parsed result with transactions array
 */
function parseComment(comment) {
    // Use plainText if available, otherwise extract from nodes
    const plainText = comment.plainText || extractPlainText(comment.content);
    const mentions = extractMentions(comment.content);

    // Split into lines for potential composite transactions
    const lines = plainText.split('\n').filter(line => line.trim());

    const transactions = [];
    const errors = [];

    for (const line of lines) {
        try {
            const parsed = parseTransactionLine(line, mentions);
            if (parsed) {
                transactions.push(parsed);
            }
        } catch (error) {
            errors.push({ line, error: error.message });
        }
    }

    // Determine overall confidence
    let confidence = 'low';
    if (transactions.length > 0) {
        const hasTeam = transactions.some(t => t.teamName || (t.teamNames && t.teamNames.length > 0));
        const hasPlayer = transactions.some(t => t.players && t.players.length > 0);

        if (hasTeam && hasPlayer) {
            confidence = 'high';
        } else if (hasTeam || hasPlayer) {
            confidence = 'medium';
        }
    }

    return {
        commentId: comment.id,
        groupId: comment.groupId,
        author: comment.user?.userName || 'unknown',
        timestamp: comment.createdAt,
        rawText: plainText,
        mentions: mentions.map(m => m.name),
        transactions,
        errors,
        confidence,
        hasTransactions: transactions.length > 0
    };
}

/**
 * Parse trade block transactions (multi-line trade format)
 * @param {string} text - Full text of the comment
 * @param {Array} mentions - Mentions in the comment
 * @returns {Object|null} Parsed trade or null
 */
function parseTradeBlock(text, mentions) {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    // Look for "Trade between X and Y" header
    const headerMatch = text.match(/trade\s+between\s+(\w+)\s+and\s+(\w+)/i);
    if (!headerMatch) {
        return null;
    }

    const team1 = headerMatch[1];
    const team2 = headerMatch[2];

    const team1Receives = [];
    const team2Receives = [];

    let currentReceiver = null;

    for (const line of lines) {
        // Check for "X receives:" line
        const receivesMatch = line.match(/(\w+)\s+receives?:?/i);
        if (receivesMatch) {
            const receiver = receivesMatch[1].toLowerCase();
            if (receiver.includes(team1.toLowerCase())) {
                currentReceiver = 'team1';
            } else if (receiver.includes(team2.toLowerCase())) {
                currentReceiver = 'team2';
            }
            continue;
        }

        // Extract assets (players and picks) from current line
        const playerMatches = line.match(/@(\w+)/g);
        const pickMatch = line.match(/S\d+\s+\w+\s+(?:1st|2nd|3rd)/i);

        if (currentReceiver === 'team1') {
            if (playerMatches) {
                team1Receives.push(...playerMatches.map(p => ({ handle: p.replace('@', ''), type: 'player' })));
            }
            if (pickMatch) {
                team1Receives.push({ pick: pickMatch[0], type: 'pick' });
            }
        } else if (currentReceiver === 'team2') {
            if (playerMatches) {
                team2Receives.push(...playerMatches.map(p => ({ handle: p.replace('@', ''), type: 'player' })));
            }
            if (pickMatch) {
                team2Receives.push({ pick: pickMatch[0], type: 'pick' });
            }
        }
    }

    if (team1Receives.length === 0 && team2Receives.length === 0) {
        return null;
    }

    // Build player moves
    const players = [];
    for (const asset of team1Receives) {
        if (asset.type === 'player') {
            players.push({ handle: asset.handle, from: team2, to: team1 });
        }
    }
    for (const asset of team2Receives) {
        if (asset.type === 'player') {
            players.push({ handle: asset.handle, from: team1, to: team2 });
        }
    }

    // Build pick moves
    const picks = [];
    for (const asset of team1Receives) {
        if (asset.type === 'pick') {
            picks.push({ description: asset.pick, from: team2, to: team1 });
        }
    }
    for (const asset of team2Receives) {
        if (asset.type === 'pick') {
            picks.push({ description: asset.pick, from: team1, to: team2 });
        }
    }

    return {
        type: TRANSACTION_TYPES.TRADE,
        teamNames: [team1, team2],
        players,
        picks,
        rawLine: text
    };
}

/**
 * Enhanced comment parser that handles complex trades
 * @param {Object} comment - Comment object from Real API
 * @returns {Object} Parsed result with transactions array
 */
function parseCommentEnhanced(comment) {
    // First try basic parsing
    const basicResult = parseComment(comment);

    // If we found a trade header, try enhanced trade parsing
    const plainText = comment.plainText || extractPlainText(comment.content);

    if (plainText.toLowerCase().includes('trade between')) {
        const mentions = extractMentions(comment.content);
        const tradeResult = parseTradeBlock(plainText, mentions);

        if (tradeResult) {
            // Replace or add the trade transaction
            const nonTradeTransactions = basicResult.transactions.filter(t => t.type !== TRANSACTION_TYPES.TRADE);
            basicResult.transactions = [...nonTradeTransactions, tradeResult];
            basicResult.confidence = 'high';
        }
    }

    return basicResult;
}

/**
 * Check if a comment looks like a transaction post
 * Quick filter before detailed parsing
 * @param {Object} comment - Comment object
 * @returns {boolean} True if might be a transaction
 */
function mightBeTransaction(comment) {
    const plainText = (comment.plainText || '').toLowerCase();

    // Must have at least one mention
    const mentions = extractMentions(comment.content);
    if (mentions.length === 0) {
        return false;
    }

    // Check for transaction keywords
    const transactionKeywords = [
        'retire', 'unretire', 'sign', 'cut', 'trade',
        'receive', 'from', 'to'
    ];

    for (const keyword of transactionKeywords) {
        if (plainText.includes(keyword)) {
            return true;
        }
    }

    return false;
}

module.exports = {
    parseComment,
    parseCommentEnhanced,
    parseTransactionLine,
    parseTradeBlock,
    mightBeTransaction,
    extractMentions,
    extractPlainText,
    TRANSACTION_TYPES,
    FILTER_KEYWORDS
};
