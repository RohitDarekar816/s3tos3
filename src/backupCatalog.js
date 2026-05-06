import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const CATALOG_FILE = path.join(DATA_DIR, 'backup-catalog.json');

const MAX_CATALOG_RECORDS = 1000;

/**
 * Load catalog records from disk.
 * On parse failure, renames the corrupted file to backup-catalog.json.bak.{timestamp}
 * and returns an empty array.
 * @returns {object[]}
 */
function load() {
  try {
    const raw = fs.readFileSync(CATALOG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    // File doesn't exist — normal on first run
    if (err.code === 'ENOENT') {
      return [];
    }
    // File exists but is corrupted — rename and start fresh
    try {
      const bak = CATALOG_FILE + '.bak.' + Date.now();
      fs.renameSync(CATALOG_FILE, bak);
    } catch {
      // Best-effort rename; ignore secondary errors
    }
    return [];
  }
}

/**
 * Persist catalog records to disk using atomic write-to-temp-then-rename.
 * @param {object[]} records
 */
function persist(records) {
  const tmp = CATALOG_FILE + '.tmp';
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2));
  fs.renameSync(tmp, CATALOG_FILE);
}

/**
 * Redact secrets from a single BackupCatalogRecord for safe list/display.
 * Redacts: any `password`, `passphrase`, or `secretAccessKey` fields at any depth.
 * The catalog schema does not store these, but this guard ensures they never leak
 * if a record is accidentally written with extra fields.
 */
function redactSecrets(record) {
  // Deep-clone via JSON round-trip then strip known secret field names
  const clone = JSON.parse(JSON.stringify(record));

  function scrub(obj) {
    if (obj === null || typeof obj !== 'object') return;
    for (const key of Object.keys(obj)) {
      if (key === 'password' || key === 'passphrase' || key === 'secretAccessKey') {
        obj[key] = '***';
      } else {
        scrub(obj[key]);
      }
    }
  }

  scrub(clone);
  return clone;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return all catalog records (unsorted, unredacted).
 * @returns {object[]}
 */
export function loadCatalog() {
  return load();
}

/**
 * Return a single catalog record by backupId, or null if not found.
 * @param {string} backupId
 * @returns {object|null}
 */
export function getCatalogRecord(backupId) {
  return load().find((r) => r.backupId === backupId) || null;
}

/**
 * Add a new record to the catalog and persist.
 * Accepts an optional `dbType` field. If not provided, defaults to 'postgresql'.
 * @param {object} record  A BackupCatalogRecord object
 * @returns {object} The stored record
 */
export function createCatalogRecord(record) {
  const records = load();
  // Ensure dbType is present, default to 'postgresql' for backward compatibility
  const recordWithDbType = {
    ...record,
    dbType: record.dbType || 'postgresql',
  };
  records.push(recordWithDbType);
  persist(records);
  return recordWithDbType;
}

/**
 * Merge `updates` into the existing record identified by `backupId`.
 * Persists the result and returns the updated record, or null if not found.
 * @param {string} backupId
 * @param {object} updates
 * @returns {object|null}
 */
export function updateCatalogRecord(backupId, updates) {
  const records = load();
  const idx = records.findIndex((r) => r.backupId === backupId);
  if (idx < 0) return null;
  records[idx] = { ...records[idx], ...updates, backupId };
  persist(records);
  return records[idx];
}

/**
 * Return all catalog records sorted by `startedAt` descending, with secrets redacted.
 * Ensures all records have a `dbType` field, defaulting to 'postgresql' for backward compatibility.
 * @returns {object[]}
 */
export function listCatalog() {
  const records = load();
  const sorted = [...records].sort((a, b) => {
    // Treat missing/null startedAt as oldest possible
    const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0;
    const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0;
    return tb - ta; // descending
  });
  return sorted.map((record) => {
    const redacted = redactSecrets(record);
    // Ensure dbType is present, default to 'postgresql' for backward compatibility
    return {
      ...redacted,
      dbType: redacted.dbType || 'postgresql',
    };
  });
}

/**
 * Enforce the 1000-record limit by keeping only the most recent records
 * (by `startedAt`) and persisting the pruned list.
 * No-op if the catalog has 1000 or fewer records.
 */
export function pruneCatalog() {
  const records = load();
  if (records.length <= MAX_CATALOG_RECORDS) return;

  // Sort descending by startedAt, keep the first MAX_CATALOG_RECORDS
  const pruned = [...records]
    .sort((a, b) => {
      const ta = a.startedAt ? new Date(a.startedAt).getTime() : 0;
      const tb = b.startedAt ? new Date(b.startedAt).getTime() : 0;
      return tb - ta;
    })
    .slice(0, MAX_CATALOG_RECORDS);

  persist(pruned);
}
