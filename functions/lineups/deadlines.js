// functions/lineups/deadlines.js

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { admin, db } = require('../utils/firebase-admin');
const { FieldValue } = require("firebase-admin/firestore");
const { CloudSchedulerClient } = require("@google-cloud/scheduler");
const { getCollectionName, getLeagueFromRequest } = require('../utils/firebase-helpers');
const schedulerClient = new CloudSchedulerClient();

/**
 * Sets or updates a lineup submission deadline for a specific date.
 * Also schedules the automated start of live scoring for 15 minutes after the deadline.
 * Admin-only function.
 * @param {object} data - The data object from the client.
 * @param {string} data.date - The date for the deadline in 'M/D/YYYY' format.
 * @param {string} data.time - The time for the deadline in 'HH:MM' 24-hour format.
 * @param {string} data.timeZone - The IANA time zone name (e.g., 'America/Chicago').
 */
exports.setLineupDeadline = onCall({ region: "us-central1" }, async (request) => {
    // Add league context extraction
    const league = getLeagueFromRequest(request.data);

    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    const { date, time, timeZone } = request.data;
    if (!date || !time || !timeZone) {
        throw new HttpsError('invalid-argument', 'A valid date, time, and timezone are required.');
    }

    try {
        const [month, day, year] = date.split('/');
        const [hour, minute] = time.split(':');

        const intendedWallTimeAsUTC = new Date(Date.UTC(year, month - 1, day, hour, minute));
        const chicagoTimeString = intendedWallTimeAsUTC.toLocaleString("en-US", { timeZone: timeZone });
        const chicagoTimeAsUTC = new Date(chicagoTimeString);
        const offset = intendedWallTimeAsUTC.getTime() - chicagoTimeAsUTC.getTime();
        const deadlineDate = new Date(intendedWallTimeAsUTC.getTime() + offset);

        const deadlineId = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const deadlineRef = db.collection(getCollectionName('lineup_deadlines', league)).doc(deadlineId);

        await deadlineRef.set({
            deadline: admin.firestore.Timestamp.fromDate(deadlineDate),
            timeZone: timeZone,
            setBy: request.auth.uid,
            lastUpdated: FieldValue.serverTimestamp()
        });

        const triggerTime = new Date(deadlineDate.getTime() + 15 * 60 * 1000);
        const jobName = `start-live-scoring-${deadlineId}`;
        const projectId = process.env.GCLOUD_PROJECT;
        const location = 'us-central1';
        const topicName = 'start-live-scoring-topic';
        const pubSubTopic = `projects/${projectId}/topics/${topicName}`;
        const parent = `projects/${projectId}/locations/${location}`;
        const jobPath = schedulerClient.jobPath(projectId, location, jobName);
        try {
            await schedulerClient.deleteJob({ name: jobPath });
            console.log(`Deleted existing job ${jobName} to reschedule.`);
        } catch (error) {
            if (error.code !== 5) { // 5 = NOT_FOUND, which is an expected outcome if no job exists
                console.error(`Error deleting existing schedule job ${jobName}:`, error);
                throw new HttpsError('internal', 'Could not clear the existing schedule for the deadline.');
            }
        }
        const job = {
            name: jobPath,
            pubsubTarget: {
                topicName: pubSubTopic,
                data: Buffer.from(JSON.stringify({ gameDate: deadlineId })).toString('base64'),
            },
            schedule: `${triggerTime.getUTCMinutes()} ${triggerTime.getUTCHours()} ${triggerTime.getUTCDate()} ${triggerTime.getUTCMonth() + 1} *`,
            timeZone: 'UTC', // Schedule must be in UTC
        };

        await schedulerClient.createJob({ parent: parent, job: job });
        console.log(`Scheduled job ${jobName} to automatically start live scoring at ${triggerTime.toISOString()}`);

        return {
            success: true,
            league,
            message: `Deadline for ${date} set to ${time} ${timeZone}. Live scoring will start automatically 15 minutes later.`
        };

    } catch (error) {
        console.error("Error setting lineup deadline:", error);
        throw new HttpsError('internal', 'An unexpected error occurred while setting the deadline.');
    }
});

/**
 * Gets the scheduled job times for lineup-related jobs
 */
exports.getScheduledJobTimes = onCall({ region: "us-central1" }, async (request) => {
    // Add league context extraction
    const league = getLeagueFromRequest(request.data);

    // 1. Security Check
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    const projectId = process.env.GCLOUD_PROJECT;
    const location = 'us-central1';

    const parseCronSchedule = (schedule) => {
        if (!schedule) return null;
        const parts = schedule.split(' ');
        const minute = String(parts[0]).padStart(2, '0');
        const hour = String(parts[1]).padStart(2, '0');
        return `${hour}:${minute}`;
    };

    // Helper to try fetching a job, resilient to naming convention differences
    const getJobSchedule = async (baseName) => {
        try {
            // First, try the name as provided (e.g., camelCase)
            const jobName = `firebase-schedule-${baseName}-${location}`;
            const jobPath = schedulerClient.jobPath(projectId, location, jobName);
            const [jobResponse] = await schedulerClient.getJob({ name: jobPath });
            return parseCronSchedule(jobResponse.schedule);
        } catch (e) {
            // If not found (error code 5), try an all-lowercase version as a fallback
            if (e.code === 5) {
                console.log(`Job with name '${baseName}' not found, trying lowercase fallback.`);
                try {
                    const lowercaseJobName = `firebase-schedule-${baseName.toLowerCase()}-${location}`;
                    const lowercaseJobPath = schedulerClient.jobPath(projectId, location, lowercaseJobName);
                    const [jobResponse] = await schedulerClient.getJob({ name: lowercaseJobPath });
                    return parseCronSchedule(jobResponse.schedule);
                } catch (e2) {
                     console.error(`Could not fetch job for '${baseName}' with either camelCase or lowercase name.`, e2);
                     return null;
                }
            } else {
                 console.error(`An unexpected error occurred fetching job for '${baseName}'.`, e);
                 return null;
            }
        }
    };

    try {
        const autoFinalizeTime = await getJobSchedule('autoFinalizeGames');
        const statUpdateTime = await getJobSchedule('updatePlayerRanks');

        return { success: true, league, autoFinalizeTime, statUpdateTime };

    } catch (error) {
        console.error("A critical error occurred while fetching Cloud Scheduler job times:", error);
        throw new HttpsError('internal', `Failed to fetch schedule times: ${error.message}`);
    }
});

/**
 * Updates the scheduled job times for lineup-related automated tasks
 */
exports.updateScheduledJobTimes = onCall({ region: "us-central1" }, async (request) => {
    const league = getLeagueFromRequest(request.data);
    // 1. Security: Ensure the user is an admin
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
    const userDoc = await db.collection(getCollectionName('users')).doc(request.auth.uid).get();
    if (!userDoc.exists || userDoc.data().role !== 'admin') {
        throw new HttpsError('permission-denied', 'Must be an admin to run this function.');
    }

    // 2. Get and validate the times from the frontend
    const { autoFinalizeTime, statUpdateTime } = request.data;
    const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/; // Validates HH:MM format
    if (!autoFinalizeTime || !statUpdateTime || !timeRegex.test(autoFinalizeTime) || !timeRegex.test(statUpdateTime)) {
        throw new HttpsError('invalid-argument', 'Please provide valid times in HH:MM format.');
    }

    // 3. Define the jobs to be updated
    const projectId = process.env.GCLOUD_PROJECT;
    const location = 'us-central1';
    const timeZone = 'America/Chicago';

    const jobsToUpdate = {
        autoFinalize: {
            name: 'autoFinalizeGames',
            time: autoFinalizeTime
        },
        statUpdates: {
            names: [
                'scheduledLiveScoringShutdown',
                'updatePlayerRanks',
                'updatePerformanceLeaderboards',
                'updateCurrentWeek',
                'updatePlayoffBracket'
            ],
            time: statUpdateTime
        }
    };

    try {
        const updatePromises = [];

        const getCronSchedule = (time) => {
            const [hour, minute] = time.split(':');
            return `${parseInt(minute)} ${parseInt(hour)} * * *`;
        };

        const autoFinalizeJobName = `firebase-schedule-${jobsToUpdate.autoFinalize.name}-${location}`;
        const autoFinalizeJobPath = schedulerClient.jobPath(projectId, location, autoFinalizeJobName);
        updatePromises.push(schedulerClient.updateJob({
            job: {
                name: autoFinalizeJobPath,
                schedule: getCronSchedule(jobsToUpdate.autoFinalize.time),
                timeZone: timeZone,
            },
            updateMask: { paths: ['schedule', 'time_zone'] }
        }));

        jobsToUpdate.statUpdates.names.forEach(name => {
            const jobName = `firebase-schedule-${name}-${location}`;
            const jobPath = schedulerClient.jobPath(projectId, location, jobName);
            updatePromises.push(schedulerClient.updateJob({
                job: {
                    name: jobPath,
                    schedule: getCronSchedule(jobsToUpdate.statUpdates.time),
                    timeZone: timeZone,
                },
                updateMask: { paths: ['schedule', 'time_zone'] }
            }));
        });

        await Promise.all(updatePromises);

        console.log(`Successfully updated schedules. Finalize: ${autoFinalizeTime}, Stats: ${statUpdateTime}`);
        return { success: true, league, message: "Scheduled job times have been successfully updated!" };

    } catch (error) {
        console.error("Error updating Cloud Scheduler jobs:", error);
        throw new HttpsError('internal', `Failed to update schedules: ${error.message}`);
    }
});
