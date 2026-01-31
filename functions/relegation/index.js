// functions/relegation/index.js

/**
 * Relegation/Promotion Module
 *
 * Automates the end-of-season promotion/relegation process between Major and Minor leagues:
 * - Detect when both leagues complete their postseasons
 * - Identify the matchup (worst Major team vs Minor champion)
 * - Track the relegation game result
 * - If Minor team wins: swap teams between leagues, preserving players, swapping draft capital
 */

const detection = require('./detection');
const execution = require('./execution');
const triggers = require('./triggers');

// Callable functions for detection and status
exports.detectRelegationMatchup = detection.detectRelegationMatchup;
exports.getRelegationStatus = detection.getRelegationStatus;

// Callable function for executing promotion (admin-only)
exports.executePromotion = execution.executePromotion;

// Firestore triggers for game completion tracking
exports.onRelegationGameComplete = triggers.onRelegationGameComplete;
exports.onRelegationGameScheduled = triggers.onRelegationGameScheduled;
