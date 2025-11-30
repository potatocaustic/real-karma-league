// scripts/seed-minor-draft-capital.js
// Seeds minor league draft capital for seasons 10-14 based on minor-draft-capital.md

const admin = require('firebase-admin');
const { getCollectionName, LEAGUES } = require('../functions/utils/firebase-helpers');

admin.initializeApp({ projectId: 'real-karma-league' });
const db = admin.firestore();

const MINOR_SEASONS = [10, 11, 12, 13, 14];
const ROUNDS = [1, 2];

const MINOR_TEAMS = [
    { team_id: 'AVA', team_name: 'Avatars' },
    { team_id: 'BUF', team_name: 'Buffalos' },
    { team_id: 'CHF', team_name: 'Chiefs' },
    { team_id: 'CRO', team_name: 'Crows' },
    { team_id: 'BOI', team_name: 'Da Bois' },
    { team_id: 'DOG', team_name: 'Dogs' },
    { team_id: 'EGG', team_name: 'Eggheads' },
    { team_id: 'FRU', team_name: 'Fruit' },
    { team_id: 'GOAT', team_name: 'Goats' },
    { team_id: 'HIP', team_name: 'Hippos' },
    { team_id: 'HSK', team_name: 'Huskies' },
    { team_id: 'KNG', team_name: 'Kings' },
    { team_id: 'KNT', team_name: 'Knights' },
    { team_id: 'LEEK', team_name: 'Leeks' },
    { team_id: 'LGND', team_name: 'Legends' },
    { team_id: 'MAF', team_name: 'Mafia' },
    { team_id: 'MET', team_name: 'Methsters' },
    { team_id: 'MM', team_name: 'Minors' },
    { team_id: 'RAM', team_name: 'Rams' },
    { team_id: 'RAP', team_name: 'Raptors' },
    { team_id: 'SAV', team_name: 'Savages' },
    { team_id: 'SEA', team_name: 'Seagulls' },
    { team_id: 'STRP', team_name: 'Strips' },
    { team_id: 'SS', team_name: 'SuperSonics' },
    { team_id: 'TIG', team_name: 'Tigers' },
    { team_id: 'TTN', team_name: 'Titans' },
    { team_id: 'TWN', team_name: 'Twins' },
    { team_id: 'VEN', team_name: 'Venom' },
    { team_id: 'VUL', team_name: 'Vultures' },
    { team_id: 'WIZ', team_name: 'Wizards' }
];

const TEAM_NAME_TO_ID = MINOR_TEAMS.reduce((acc, team) => {
    acc[team.team_name] = team.team_id;
    acc[team.team_id] = team.team_id;
    return acc;
}, {});

function getTeamId(teamLabel) {
    const normalized = (teamLabel || '').trim();
    if (!TEAM_NAME_TO_ID[normalized]) {
        throw new Error(`Unknown team label: ${teamLabel}`);
    }
    return TEAM_NAME_TO_ID[normalized];
}

const DRAFT_CAPITAL = {
    10: {
        incoming: {
            Buffalos: ['SuperSonics S10 1RP'],
            Leeks: ['Tigers S10 1RP'],
            Methsters: ['Seagulls S10 1RP'],
            Rams: ['Wizards S10 1RP', 'Fruit S10 1RP'],
            Raptors: ['Hippos S10 1RP'],
            Seagulls: ['Twins S10 1RP'],
            SuperSonics: ['Buffalos S10 1RP'],
            Vultures: ['Raptors S10 1RP', 'Huskies S10 1RP'],
            Avatars: ['Goats S10 2RP'],
            Dogs: ['Strips S10 2RP', 'Venom S10 2RP', 'Tigers S10 2RP'],
            Goats: ['Huskies S10 2RP', 'Avatars S10 2RP'],
            Huskies: ['Leeks S10 2RP'],
            Kings: ['Wizards S10 2RP', 'Da Bois S10 2RP', 'Savages S10 2RP'],
            Leeks: ['Eggheads S10 2RP'],
            Minors: ['Raptors S10 2RP'],
            Seagulls: ['SuperSonics S10 2RP', 'Mafia S10 2RP'],
            Strips: ['Savages S10 2RP'],
            SuperSonics: ['Seagulls S10 2RP'],
            Twins: ['Rams S10 2RP'],
            Vultures: ['Minors S10 2RP'],
            Wizards: ['Hippos S10 2RP']
        },
        outgoing: {
            Avatars: ['S10 2RP'],
            Buffalos: ['S10 1RP'],
            'Da Bois': ['S10 2RP'],
            Huskies: ['S10 1RP', 'S10 2RP'],
            Knights: ['S10 1RP', 'S10 2RP'],
            Leeks: ['S10 2RP'],
            Mafia: ['S10 1RP', 'S10 2RP'],
            Minors: ['S10 2RP'],
            Rams: ['S10 2RP'],
            Raptors: ['S10 1RP', 'S10 2RP'],
            Savages: ['S10 2RP'],
            Seagulls: ['S10 1RP', 'S10 2RP'],
            Strips: ['S10 2RP'],
            SuperSonics: ['S10 1RP', 'S10 2RP'],
            Twins: ['S10 1RP'],
            Venom: ['S10 2RP'],
            Wizards: ['S10 1RP', 'S10 2RP'],
            Fruit: ['S10 1RP'],
            Hippos: ['S10 1RP', 'S10 2RP'],
            Tigers: ['S10 1RP', 'S10 2RP'],
            Goats: ['S10 2RP']
        }
    },
    11: {
        incoming: {
            Eggheads: ['Knights S11 1RP'],
            Kings: ['Wizards S11 1RP', 'Savages S11 1RP'],
            Leeks: ['Huskies S11 1RP'],
            Titans: ['Rams S11 1RP'],
            Chiefs: ['Huskies S11 2RP'],
            Crows: ['Vultures S11 2RP'],
            'Da Bois': ['Knights S11 2RP'],
            Methsters: ['Seagulls S11 2RP'],
            Rams: ['Wizards S11 2RP', 'Eggheads S11 2RP', 'Tigers S11 2RP'],
            Vultures: ['Venom S11 2RP', 'Raptors S11 2RP']
        },
        outgoing: {
            Huskies: ['S11 1RP', 'S11 2RP'],
            Knights: ['S11 1RP', 'S11 2RP'],
            Rams: ['S11 1RP'],
            Savages: ['S11 1RP'],
            Wizards: ['S11 1RP', 'S11 2RP'],
            Raptors: ['S11 2RP'],
            Seagulls: ['S11 2RP'],
            Venom: ['S11 2RP'],
            Vultures: ['S11 2RP'],
            Eggheads: ['S11 2RP'],
            Tigers: ['S11 2RP']
        }
    },
    12: {
        incoming: {
            'Da Bois': ['Knights S12 2RP'],
            Leeks: ['Huskies S12 2RP', 'Strips S12 2RP'],
            Raptors: ['Hippos S12 2RP']
        },
        outgoing: {
            Knights: ['S12 1RP', 'S12 2RP'],
            Huskies: ['S12 2RP'],
            Fruit: ['S12 2RP'],
            Hippos: ['S12 2RP']
        }
    },
    13: {
        incoming: {
            Kings: ['Knights S13 1RP'],
            Leeks: ['Huskies S13 1RP'],
            Crows: ['Wizards S13 2RP'],
            'Da Bois': ['Knights S13 2RP'],
            Wizards: ['Crows S13 2RP']
        },
        outgoing: {
            Huskies: ['S13 1RP'],
            Knights: ['S13 1RP'],
            Crows: ['S13 2RP'],
            Wizards: ['S13 2RP']
        }
    },
    14: {
        incoming: {},
        outgoing: {
            Knights: ['S14 2RP']
        }
    }
};

function parsePickRef(pickRef, fallbackTeam) {
    const normalized = pickRef.trim();
    const match = normalized.match(/^(?:(?<team>.+?)\s+)?S(?<season>\d+)\s+(?<round>[12])RP$/i);
    if (!match || !match.groups) {
        throw new Error(`Unable to parse pick reference: ${pickRef}`);
    }

    const team = getTeamId((match.groups.team || fallbackTeam).trim());
    return {
        team,
        season: Number(match.groups.season),
        round: Number(match.groups.round)
    };
}

function createPickId(season, team, round) {
    return `S${season}_${team}_${round}`;
}

function getRoundLabel(round) {
    return round === 1 ? '1st' : '2nd';
}

function buildBaseDraftPicks() {
    const pickMap = new Map();

    for (const season of MINOR_SEASONS) {
        for (const { team_id: teamId } of MINOR_TEAMS) {
            for (const round of ROUNDS) {
                const pick_id = createPickId(season, teamId, round);
                pickMap.set(pick_id, {
                    pick_id,
                    pick_description: `S${season} ${teamId} ${getRoundLabel(round)}`,
                    season,
                    round,
                    original_team: teamId,
                    current_owner: teamId,
                    acquired_week: null,
                    base_owner: null,
                    notes: null,
                    trade_id: null
                });
            }
        }
    }

    return pickMap;
}

function applyIncomingTrades(pickMap) {
    for (const [seasonKey, { incoming }] of Object.entries(DRAFT_CAPITAL)) {
        const season = Number(seasonKey);
        Object.entries(incoming).forEach(([owner, picks]) => {
            const ownerId = getTeamId(owner);
            picks.forEach((pickRef) => {
                const { team, season: pickSeason, round } = parsePickRef(pickRef, owner);

                if (pickSeason !== season) {
                    throw new Error(`Season mismatch for ${pickRef} (expected S${season})`);
                }

                const pickId = createPickId(pickSeason, team, round);
                const pick = pickMap.get(pickId);
                if (!pick) {
                    throw new Error(`Pick ${pickId} not found in base data.`);
                }

                pick.current_owner = ownerId;
                if (!pick.base_owner) {
                    pick.base_owner = pick.original_team;
                }
            });
        });
    }
}

function annotateUnresolvedOutgoing(pickMap) {
    for (const [seasonKey, { outgoing, incoming }] of Object.entries(DRAFT_CAPITAL)) {
        const incomingLookup = new Set(
            Object.values(incoming)
                .flat()
                .map((pickRef) => {
                    const parsed = parsePickRef(pickRef, '');
                    return createPickId(parsed.season, parsed.team, parsed.round);
                })
        );

        Object.entries(outgoing).forEach(([team, picks]) => {
            picks.forEach((pickRef) => {
                const { team: originTeam, season, round } = parsePickRef(pickRef, team);
                const pickId = createPickId(season, originTeam, round);
                const pick = pickMap.get(pickId);

                if (!pick) {
                    throw new Error(`Pick ${pickId} listed as outgoing for ${team} but not found.`);
                }

                if (incomingLookup.has(pickId)) return;
                if (pick.current_owner === pick.original_team) {
                    pick.notes = 'Marked as traded out in minor-draft-capital.md; destination not specified.';
                }
            });
        });
    }
}

async function deleteExistingPicks(collectionName) {
    const snapshot = await db.collection(collectionName).where('season', 'in', MINOR_SEASONS).get();
    if (snapshot.empty) return;

    console.log(`Deleting ${snapshot.size} existing minor draft picks for seasons ${MINOR_SEASONS.join(', ')}...`);
    let batch = db.batch();
    let count = 0;

    for (const doc of snapshot.docs) {
        batch.delete(doc.ref);
        count++;
        if (count % 400 === 0) {
            await batch.commit();
            batch = db.batch();
        }
    }

    if (count % 400 !== 0) {
        await batch.commit();
    }
}

async function seedMinorDraftPicks() {
    const collectionName = getCollectionName('draftPicks', LEAGUES.MINOR);
    const pickMap = buildBaseDraftPicks();

    applyIncomingTrades(pickMap);
    annotateUnresolvedOutgoing(pickMap);

    await deleteExistingPicks(collectionName);

    let batch = db.batch();
    let writeCount = 0;

    for (const pick of pickMap.values()) {
        const pickRef = db.collection(collectionName).doc(pick.pick_id);
        batch.set(pickRef, pick);
        writeCount++;

        if (writeCount % 400 === 0) {
            await batch.commit();
            batch = db.batch();
        }
    }

    if (writeCount % 400 !== 0) {
        await batch.commit();
    }

    console.log(`Seeded ${writeCount} minor draft picks to ${collectionName}.`);
}

seedMinorDraftPicks()
    .then(() => {
        console.log('Minor draft capital seeding complete.');
        process.exit(0);
    })
    .catch((error) => {
        console.error('Failed to seed minor draft capital:', error);
        process.exit(1);
    });
