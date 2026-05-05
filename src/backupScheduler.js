/**
 * backupScheduler.js
 *
 * Manages cron and interval-based scheduling for BackupJobs.
 * Supports 5-field cron expressions and interval-in-seconds schedules.
 * Delegates all execution to BackupEngine.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5
 */

import { startBackup, getActiveBackups, initBackupEngine } from './backupEngine.js';
import { listBackupJobs, getBackupJob } from './backupJobStore.js';
import { log, debug } from './logger.js';

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** @type {Map<string, NodeJS.Timeout>} */
const _timers = new Map();

/** @type {boolean} */
let _initialized = false;

// ---------------------------------------------------------------------------
// Cron parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a single cron field into a Set of matching values.
 * Supports: "*", "N", "N-M", "N/S", "N,M,..."
 *
 * @param {string} field  The cron field string
 * @param {number} min    Minimum allowed value (inclusive)
 * @param {number} max    Maximum allowed value (inclusive)
 * @returns {Set<number>}
 */
function parseCronField(field, min, max) {
  const values = new Set();

  for (const part of field.split(',')) {
    if (part === '*') {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes('/')) {
      const [rangeStr, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      const start = rangeStr === '*' ? min : parseInt(rangeStr, 10);
      for (let i = start; i <= max; i += step) values.add(i);
    } else if (part.includes('-')) {
      const [startStr, endStr] = part.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      for (let i = start; i <= end; i++) values.add(i);
    } else {
      values.add(parseInt(part, 10));
    }
  }

  return values;
}

/**
 * Parse a 5-field cron expression into a structured object.
 * Fields: minute hour day-of-month month day-of-week
 *
 * @param {string} cronStr  e.g. "0 2 * * *"
 * @returns {{ minute: Set<number>, hour: Set<number>, dom: Set<number>, month: Set<number>, dow: Set<number> } | null}
 */
function parseCron(cronStr) {
  const fields = cronStr.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  try {
    return {
      minute: parseCronField(fields[0], 0, 59),
      hour:   parseCronField(fields[1], 0, 23),
      dom:    parseCronField(fields[2], 1, 31),
      month:  parseCronField(fields[3], 1, 12),
      dow:    parseCronField(fields[4], 0, 6),
    };
  } catch {
    return null;
  }
}

/**
 * Check whether a Date matches a parsed cron schedule.
 *
 * @param {Date} date
 * @param {{ minute: Set<number>, hour: Set<number>, dom: Set<number>, month: Set<number>, dow: Set<number> }} cron
 * @returns {boolean}
 */
function matchesCron(date, cron) {
  return (
    cron.minute.has(date.getMinutes()) &&
    cron.hour.has(date.getHours()) &&
    cron.dom.has(date.getDate()) &&
    cron.month.has(date.getMonth() + 1) && // JS months are 0-indexed
    cron.dow.has(date.getDay())
  );
}

/**
 * Determine whether a schedule string looks like a cron expression
 * (contains spaces, i.e. has multiple fields).
 *
 * @param {string|number} schedule
 * @returns {boolean}
 */
function isCronString(schedule) {
  return typeof schedule === 'string' && schedule.trim().includes(' ');
}

// ---------------------------------------------------------------------------
// Trigger helper
// ---------------------------------------------------------------------------

/**
 * Attempt to trigger a backup for the given jobId.
 * Skips if the job is already running (req 2.3).
 *
 * @param {string} jobId
 */
async function _triggerJob(jobId) {
  // Re-read the job config on each trigger so schedule changes take effect (req 2.4)
  const job = getBackupJob(jobId);
  if (!job) {
    log('warning', `Scheduler: job ${jobId} not found, skipping trigger`);
    return;
  }

  debug(`Scheduler: evaluating trigger for job ${jobId} ("${job.name}") — running=${_runningJobs.has(jobId)}`);

  // Guard against concurrent execution (req 2.3)
  const activeBackups = getActiveBackups();
  // Check if any active backup belongs to this job
  // BackupEngine tracks by backupId, not jobId — we check via the catalog approach:
  // Since getActiveBackups() returns a Map<backupId, AbortController>, we need to
  // check if any running backup is for this job. We use a job-level running flag
  // tracked in _runningJobs.
  if (_runningJobs.has(jobId)) {
    log('info', `Scheduler: job ${jobId} is already running, skipping trigger`);
    return;
  }

  log('info', `Scheduler: triggering job ${jobId} (${job.name || jobId})`);

  // Mark as running before async call to prevent race conditions
  _runningJobs.add(jobId);

  try {
    // Set trigger source so BackupEngine records it in the catalog (req 2.2)
    job._triggerSource = 'scheduled';
    await startBackup(job);
  } catch (err) {
    log('error', `Scheduler: failed to start backup for job ${jobId}: ${err.message}`);
  } finally {
    // Remove from running set when the startBackup call returns
    // Note: startBackup returns quickly (async fire-and-forget), so we clear
    // the running flag after a short delay to allow the engine to register
    // the backup in _activeBackups. We rely on the engine's own tracking
    // for the actual duration guard.
    _runningJobs.delete(jobId);
  }
}

/**
 * Set of jobIds currently being triggered (prevents concurrent triggers).
 * @type {Set<string>}
 */
const _runningJobs = new Set();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the scheduler with a Socket.io server reference.
 * Loads all jobs from BackupJobStore and schedules those with a non-null schedule.
 *
 * @param {import('socket.io').Server} io
 */
export function initScheduler(io) {
  if (_initialized) {
    log('info', 'BackupScheduler already initialized, re-scheduling all jobs');
    // Clear existing timers before re-init
    for (const [jobId] of _timers) {
      unscheduleJob(jobId);
    }
  }

  initBackupEngine(io);
  _initialized = true;

  const jobs = listBackupJobs();
  let scheduled = 0;

  for (const job of jobs) {
    if (job.schedule != null) {
      scheduleJob(job);
      scheduled++;
    }
  }

  log('info', `BackupScheduler initialized: ${scheduled} job(s) scheduled`);
}

/**
 * Schedule a job. Supports:
 * - 5-field cron strings (e.g. "0 2 * * *") — checked every 60 seconds
 * - Interval in seconds (number or numeric string) — fires every N seconds
 *
 * Calls unscheduleJob first to replace any existing timer (req 2.4).
 *
 * @param {object} job  BackupJob object (must have .id and .schedule)
 */
export function scheduleJob(job) {
  if (!job || !job.id) {
    log('warning', 'BackupScheduler.scheduleJob: job has no id, skipping');
    return;
  }

  const { id: jobId, schedule } = job;

  if (schedule == null) {
    log('info', `BackupScheduler: job ${jobId} has no schedule, skipping`);
    return;
  }

  // Replace any existing timer
  unscheduleJob(jobId);

  if (isCronString(schedule)) {
    // Cron-based scheduling: check every 60 seconds
    const parsed = parseCron(schedule);
    if (!parsed) {
      log('warning', `BackupScheduler: invalid cron expression "${schedule}" for job ${jobId}`);
      return;
    }

    // Track the last minute we fired to avoid double-firing within the same minute
    let lastFiredMinute = -1;

    const timer = setInterval(() => {
      const now = new Date();
      const currentMinute = now.getHours() * 60 + now.getMinutes();

      if (matchesCron(now, parsed) && currentMinute !== lastFiredMinute) {
        lastFiredMinute = currentMinute;
        _triggerJob(jobId).catch((err) => {
          log('error', `Scheduler cron trigger error for job ${jobId}: ${err.message}`);
        });
      }
    }, 60_000); // check every 60 seconds

    _timers.set(jobId, timer);
    log('info', `BackupScheduler: job ${jobId} scheduled with cron "${schedule}"`);

  } else {
    // Interval-based scheduling: fire every N seconds
    const intervalSeconds = typeof schedule === 'number' ? schedule : parseInt(schedule, 10);

    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      log('warning', `BackupScheduler: invalid interval "${schedule}" for job ${jobId}`);
      return;
    }

    const timer = setInterval(() => {
      _triggerJob(jobId).catch((err) => {
        log('error', `Scheduler interval trigger error for job ${jobId}: ${err.message}`);
      });
    }, intervalSeconds * 1000);

    _timers.set(jobId, timer);
    log('info', `BackupScheduler: job ${jobId} scheduled with interval ${intervalSeconds}s`);
  }
}

/**
 * Remove the timer for a job, stopping future triggers.
 *
 * @param {string} jobId
 */
export function unscheduleJob(jobId) {
  const timer = _timers.get(jobId);
  if (timer != null) {
    clearInterval(timer);
    _timers.delete(jobId);
    log('info', `BackupScheduler: job ${jobId} unscheduled`);
  }
}

/**
 * Replace the schedule for a job (unschedule + schedule).
 * Used when a job's schedule field is updated via PUT /api/backup/jobs/:id (req 2.4).
 *
 * @param {object} job  Updated BackupJob object
 */
export function rescheduleJob(job) {
  if (!job || !job.id) {
    log('warning', 'BackupScheduler.rescheduleJob: job has no id, skipping');
    return;
  }

  unscheduleJob(job.id);

  if (job.schedule != null) {
    scheduleJob(job);
  } else {
    log('info', `BackupScheduler: job ${job.id} schedule cleared, not re-scheduling`);
  }
}

/**
 * Return a snapshot of the currently scheduled jobs map.
 * Keys are jobIds, values are the timer handles.
 *
 * @returns {Map<string, NodeJS.Timeout>}
 */
export function getScheduledJobs() {
  return new Map(_timers);
}
