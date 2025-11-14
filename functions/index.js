// functions/index.js

const { onDocumentUpdated, onDocumentCreated, onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const { admin, db } = require("./utils/firebase-admin");
const { FieldValue } = require("firebase-admin/firestore");
const fetch = require("node-fetch");
const { CloudSchedulerClient } = require("@google-cloud/scheduler");
const schedulerClient = new CloudSchedulerClient();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { LEAGUES: LEAGUES_IMPORT, hasLeagueAccess, withLeagueContext } = require('./league-helpers');

// Import extracted game modules
const gameUpdates = require('./games/game-updates');
const exhibitionGames = require('./games/exhibition');
const legacyGames = require('./games/legacy');

// Import extracted season modules
const seasonCreation = require('./seasons/season-creation');
const seasonSchedules = require('./seasons/schedules');
const weekManagement = require('./seasons/week-management');

// Import extracted stats-rankings modules
const playerRankings = require('./stats-rankings/player-rankings');
const performanceRankings = require('./stats-rankings/performance-rankings');
const leaderboardForce = require('./stats-rankings/leaderboard-force');

// Import extracted playoff modules
const playoffBracket = require('./playoffs/bracket');
const playoffBracketTest = require('./playoffs/bracket-test');

// Import extracted transaction modules
const transactionHandlers = require('./transactions/transaction-handlers');
const transactionRelease = require('./transactions/transaction-release');

// Import extracted draft modules
const draftResults = require('./draft/draft-results');

// Import extracted lineup modules
const lineupDeadlines = require('./lineups/deadlines');
const lineupStaging = require('./lineups/staging');

// Import extracted live-scoring modules
const liveGames = require('./live-scoring/live-games');
const liveProcessor = require('./live-scoring/live-processor');
const liveStatus = require('./live-scoring/live-status');
const scoringScheduler = require('./live-scoring/scoring-scheduler');

// Import extracted admin modules
const adminPlayers = require('./admin/admin-players');
const adminTeams = require('./admin/admin-teams');
const adminTransactions = require('./admin/admin-transactions');
const adminActivity = require('./admin/admin-activity');
const adminAwards = require('./admin/admin-awards');
const adminTradeblocks = require('./admin/admin-tradeblocks');
const migrateAddSeasonIds = require('./admin/migrate-add-season-ids');

// Import extracted reporting modules
const writeups = require('./reporting/writeups');
const reports = require('./reporting/reports');

// Import extracted data sync modules
const sheetsSync = require('./data-sync/sheets-sync');

const USE_DEV_COLLECTIONS = false;

/**
 * League context constants
 */
const LEAGUES = {
  MAJOR: 'major',
  MINOR: 'minor'
};

// ============================================================================
// RE-EXPORTS
// ============================================================================

// Re-export game functions from extracted modules
exports.onRegularGameUpdate_V2 = gameUpdates.onRegularGameUpdate_V2;
exports.onPostGameUpdate_V2 = gameUpdates.onPostGameUpdate_V2;
exports.minor_onRegularGameUpdate_V2 = gameUpdates.minor_onRegularGameUpdate_V2;
exports.minor_onPostGameUpdate_V2 = gameUpdates.minor_onPostGameUpdate_V2;
exports.updateGamesScheduledCount = gameUpdates.updateGamesScheduledCount;
exports.minor_updateGamesScheduledCount = gameUpdates.minor_updateGamesScheduledCount;

exports.processCompletedExhibitionGame = exhibitionGames.processCompletedExhibitionGame;
exports.minor_processCompletedExhibitionGame = exhibitionGames.minor_processCompletedExhibitionGame;

exports.onLegacyGameUpdate = legacyGames.onLegacyGameUpdate;
exports.onTransactionCreate = legacyGames.onTransactionCreate;

// Re-export season functions from extracted modules
exports.createNewSeason = seasonCreation.createNewSeason;
exports.createHistoricalSeason = seasonCreation.createHistoricalSeason;

exports.generatePostseasonSchedule = seasonSchedules.generatePostseasonSchedule;

exports.updateCurrentWeek = weekManagement.updateCurrentWeek;
exports.minor_updateCurrentWeek = weekManagement.minor_updateCurrentWeek;
exports.forceWeekUpdate = weekManagement.forceWeekUpdate;

// Re-export stats-rankings functions from extracted modules
exports.updatePlayerRanks = playerRankings.updatePlayerRanks;
exports.minor_updatePlayerRanks = playerRankings.minor_updatePlayerRanks;

exports.updatePerformanceLeaderboards = performanceRankings.updatePerformanceLeaderboards;
exports.minor_updatePerformanceLeaderboards = performanceRankings.minor_updatePerformanceLeaderboards;

exports.forceLeaderboardRecalculation = leaderboardForce.forceLeaderboardRecalculation;

// Re-export playoff functions from extracted modules
exports.updatePlayoffBracket = playoffBracket.updatePlayoffBracket;
exports.minor_updatePlayoffBracket = playoffBracket.minor_updatePlayoffBracket;

exports.test_updatePlayoffBracket = playoffBracketTest.test_updatePlayoffBracket;
exports.test_autoFinalizeGames = playoffBracketTest.test_autoFinalizeGames;

// Re-export transaction functions from extracted modules
exports.onTransactionCreate_V2 = transactionHandlers.onTransactionCreate_V2;
exports.minor_onTransactionCreate_V2 = transactionHandlers.minor_onTransactionCreate_V2;
exports.onTransactionUpdate_V2 = transactionHandlers.onTransactionUpdate_V2;
exports.minor_onTransactionUpdate_V2 = transactionHandlers.minor_onTransactionUpdate_V2;

exports.releasePendingTransactions = transactionRelease.releasePendingTransactions;
exports.minor_releasePendingTransactions = transactionRelease.minor_releasePendingTransactions;

// Re-export draft functions from extracted modules
exports.onDraftResultCreate = draftResults.onDraftResultCreate;
exports.minor_onDraftResultCreate = draftResults.minor_onDraftResultCreate;

// Re-export lineup functions from extracted modules
exports.setLineupDeadline = lineupDeadlines.setLineupDeadline;
exports.getScheduledJobTimes = lineupDeadlines.getScheduledJobTimes;
exports.updateScheduledJobTimes = lineupDeadlines.updateScheduledJobTimes;

exports.stageLiveLineups = lineupStaging.stageLiveLineups;

// Re-export live-scoring functions from extracted modules
exports.activateLiveGame = liveGames.activateLiveGame;
exports.finalizeLiveGame = liveGames.finalizeLiveGame;
exports.getLiveKarma = liveGames.getLiveKarma;

exports.processPendingLiveGames = liveProcessor.processPendingLiveGames;
exports.minor_processPendingLiveGames = liveProcessor.minor_processPendingLiveGames;
exports.autoFinalizeGames = liveProcessor.autoFinalizeGames;
exports.minor_autoFinalizeGames = liveProcessor.minor_autoFinalizeGames;

exports.updateAllLiveScores = liveStatus.updateAllLiveScores;
exports.setLiveScoringStatus = liveStatus.setLiveScoringStatus;

exports.scheduledSampler = scoringScheduler.scheduledSampler;
exports.minor_scheduledSampler = scoringScheduler.minor_scheduledSampler;
exports.scheduledLiveScoringStart = scoringScheduler.scheduledLiveScoringStart;
exports.minor_scheduledLiveScoringStart = scoringScheduler.minor_scheduledLiveScoringStart;
exports.scheduledLiveScoringShutdown = scoringScheduler.scheduledLiveScoringShutdown;
exports.minor_scheduledLiveScoringShutdown = scoringScheduler.minor_scheduledLiveScoringShutdown;

// Re-export admin functions from extracted modules
exports.admin_recalculatePlayerStats = adminPlayers.admin_recalculatePlayerStats;
exports.admin_updatePlayerId = adminPlayers.admin_updatePlayerId;
exports.admin_updatePlayerDetails = adminPlayers.admin_updatePlayerDetails;

exports.rebrandTeam = adminTeams.rebrandTeam;

exports.admin_processTransaction = adminTransactions.admin_processTransaction;

exports.logScorekeeperActivity = adminActivity.logScorekeeperActivity;

exports.calculatePerformanceAwards = adminAwards.calculatePerformanceAwards;

exports.clearAllTradeBlocks = adminTradeblocks.clearAllTradeBlocks;
exports.reopenTradeBlocks = adminTradeblocks.reopenTradeBlocks;

exports.admin_migrateAddSeasonIds = migrateAddSeasonIds.admin_migrateAddSeasonIds;
exports.admin_verifySeasonIdMigration = migrateAddSeasonIds.admin_verifySeasonIdMigration;

// Re-export reporting functions from extracted modules
exports.generateGameWriteup = writeups.generateGameWriteup;
exports.getAiWriteup = writeups.getAiWriteup;
exports.scorekeeperFinalizeAndProcess = writeups.scorekeeperFinalizeAndProcess;

exports.getReportData = reports.getReportData;

// Re-export data sync functions from extracted modules
exports.syncSheetsToFirestore = sheetsSync.syncSheetsToFirestore;

module.exports = { ...module.exports, ...require('./draft-prospects') };
