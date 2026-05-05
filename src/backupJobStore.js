import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const BACKUP_JOBS_FILE = path.join(DATA_DIR, 'backup-jobs.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(BACKUP_JOBS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function persist(jobs) {
  const tmp = BACKUP_JOBS_FILE + '.tmp';
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2));
  fs.renameSync(tmp, BACKUP_JOBS_FILE);
}

/**
 * Redact secrets from a single BackupJob for safe list/display.
 * Redacts: source.password, storageTargets[].secretAccessKey,
 *          encryption.passphrase, notifications.email.pass
 */
function redactSecrets(job) {
  const redacted = { ...job };

  // Redact source password
  if (redacted.source) {
    redacted.source = { ...redacted.source, password: '***' };
  }

  // Redact secretAccessKey on each S3 storage target
  if (Array.isArray(redacted.storageTargets)) {
    redacted.storageTargets = redacted.storageTargets.map((target) => {
      if (target.type === 's3' && 'secretAccessKey' in target) {
        return { ...target, secretAccessKey: '***' };
      }
      return target;
    });
  }

  // Redact encryption passphrase
  if (redacted.encryption) {
    redacted.encryption = { ...redacted.encryption, passphrase: '***' };
  }

  // Redact email password in notifications
  if (redacted.notifications?.email) {
    redacted.notifications = {
      ...redacted.notifications,
      email: { ...redacted.notifications.email, pass: '***' },
    };
  }

  return redacted;
}

/**
 * List all backup jobs with secrets redacted.
 * @returns {object[]}
 */
export function listBackupJobs() {
  return load().map(redactSecrets);
}

/**
 * Get a single backup job by ID, including secrets.
 * @param {string} id
 * @returns {object|null}
 */
export function getBackupJob(id) {
  return load().find((j) => j.id === id) || null;
}

/**
 * Create a new backup job. Generates id, createdAt, and updatedAt.
 * @param {object} data
 * @returns {object} The created job
 */
export function createBackupJob(data) {
  const jobs = load();
  const now = new Date().toISOString();
  const job = {
    id: crypto.randomUUID(),
    ...data,
    createdAt: now,
    updatedAt: now,
  };
  jobs.push(job);
  persist(jobs);
  return job;
}

/**
 * Update an existing backup job by ID. Updates updatedAt automatically.
 * @param {string} id
 * @param {object} data
 * @returns {object|null} The updated job, or null if not found
 */
export function updateBackupJob(id, data) {
  const jobs = load();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx < 0) return null;
  jobs[idx] = { ...jobs[idx], ...data, id, updatedAt: new Date().toISOString() };
  persist(jobs);
  return jobs[idx];
}

/**
 * Delete a backup job by ID.
 * @param {string} id
 * @returns {boolean} true if deleted, false if not found
 */
export function deleteBackupJob(id) {
  const jobs = load();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx < 0) return false;
  jobs.splice(idx, 1);
  persist(jobs);
  return true;
}
