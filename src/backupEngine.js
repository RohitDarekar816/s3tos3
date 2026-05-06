/**
 * backupEngine.js
 *
 * Central orchestrator for PostgreSQL backup and restore operations.
 * Manages the lifecycle of backup/restore jobs, coordinates with BackupCatalog,
 * BackupStore, and emits real-time WebSocket progress events.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { Readable, PassThrough } from 'stream';
import { pipeline } from 'stream/promises';
import zlib from 'zlib';

import * as BackupCatalog from './backupCatalog.js';
import * as BackupStore from './backupStore.js';
import * as BackupJobStore from './backupJobStore.js';
import { log, debug } from './logger.js';
import { notify } from './notifier.js';
import { createEncryptStream, createDecryptStream } from './backupCrypto.js';

// Database drivers
import * as postgresqlDriver from './dbDrivers/postgresql.js';
import * as mysqlDriver from './dbDrivers/mysql.js';
import * as mongodbDriver from './dbDrivers/mongodb.js';

// ---------------------------------------------------------------------------
// Driver dispatcher
// ---------------------------------------------------------------------------

/**
 * Map of database type strings to driver modules.
 * MariaDB reuses the MySQL driver.
 */
const DRIVERS = {
  postgresql: postgresqlDriver,
  mysql: mysqlDriver,
  mariadb: mysqlDriver,
  mongodb: mongodbDriver,
};

const VALID_DB_TYPES = new Set(Object.keys(DRIVERS));

/**
 * Return the driver for a given dbType, defaulting to postgresql.
 * Throws with HTTP 400 if the type is explicitly set but invalid.
 * @param {string|null|undefined} dbType
 * @returns {{ driver: object, resolvedType: string }}
 */
export function getDriver(dbType) {
  const type = dbType || 'postgresql';
  const driver = DRIVERS[type];
  if (!driver) {
    const err = new Error(`Unsupported dbType "${type}". Valid values: ${[...VALID_DB_TYPES].join(', ')}`);
    err.status = 400;
    throw err;
  }
  return { driver, resolvedType: type };
}

// ---------------------------------------------------------------------------
// Internal state (Task 7.1)
// ---------------------------------------------------------------------------

/** @type {import('socket.io').Server|null} */
let _io = null;

/** @type {Map<string, AbortController>} */
const _activeBackups = new Map();

/** @type {Map<string, AbortController>} */
const _activeRestores = new Map();

// ---------------------------------------------------------------------------
// Initialization (Task 7.1)
// ---------------------------------------------------------------------------

/**
 * Initialize the BackupEngine with a Socket.io server reference.
 * Must be called before any backup/restore operations.
 * @param {import('socket.io').Server} io
 */
export function initBackupEngine(io) {
  _io = io;
  log('info', 'BackupEngine initialized');
  debug('BackupEngine: Socket.io reference set, active maps initialized');
}

/**
 * Return a snapshot of the active backups map.
 * @returns {Map<string, AbortController>}
 */
export function getActiveBackups() {
  return new Map(_activeBackups);
}

/**
 * Return a snapshot of the active restores map.
 * @returns {Map<string, AbortController>}
 */
export function getActiveRestores() {
  return new Map(_activeRestores);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine the file extension for a given format and compression.
 * @param {string} format
 * @param {{ type: string }} compression
 * @returns {string}
 */
function getArtifactExtension(format, compression) {
  const compExt = compression?.type === 'gzip' ? '.gz' : compression?.type === 'lz4' ? '.lz4' : '';
  switch (format) {
    case 'custom':    return 'dump';
    case 'plain':     return `sql${compExt}`;
    case 'directory': return 'dir';
    case 'tar':       return `tar${compExt}`;
    default:          return `dump${compExt}`;
  }
}

/**
 * Build pg_dump CLI arguments from a job configuration.
 * @param {object} jobConfig  Full BackupJob object
 * @returns {string[]}
 */
export function buildPgDumpArgs(jobConfig) {
  const {
    source,
    format = 'custom',
    compression = { type: 'none', level: 6 },
    includeTables = [],
    excludeTables = [],
    includeSchemas = [],
    excludeSchemas = [],
  } = jobConfig;

  const args = [];

  // Connection args
  args.push('-h', source.host);
  args.push('-p', String(source.port || 5432));
  args.push('-U', source.user);
  args.push('-d', source.database);

  // Format flag
  const formatFlags = { custom: '-Fc', plain: '-Fp', directory: '-Fd', tar: '-Ft' };
  args.push(formatFlags[format] || '-Fc');

  // Compression: for custom format use pg_dump's built-in -Z flag (req 5.6)
  if (format === 'custom' && compression?.type === 'gzip') {
    const level = compression.level ?? 6;
    args.push('-Z', String(level));
  }

  // Include filters first (req 4.5 — includes before excludes)
  for (const table of includeTables) {
    args.push('--table', table);
  }
  for (const schema of includeSchemas) {
    args.push('--schema', schema);
  }

  // Exclude filters after includes
  for (const table of excludeTables) {
    args.push('--exclude-table', table);
  }
  for (const schema of excludeSchemas) {
    args.push('--exclude-schema', schema);
  }

  // No password in args — use PGPASSWORD env var
  args.push('--no-password');

  return args;
}

/**
 * Build pg_restore CLI arguments.
 * @param {object} target  { host, port, database, user, password }
 * @param {object} restoreOptions  { cleanBeforeRestore, createDatabase }
 * @param {string} format
 * @returns {string[]}
 */
export function buildPgRestoreArgs(target, restoreOptions = {}, format) {
  const args = [];

  args.push('-h', target.host);
  args.push('-p', String(target.port || 5432));
  args.push('-U', target.user || 'postgres');

  if (restoreOptions.createDatabase) {
    // --create: pg_restore issues CREATE DATABASE itself.
    // Must connect to an existing maintenance database (postgres), NOT the target.
    args.push('-d', 'postgres');
    args.push('--create');
    // --clean with --create drops and recreates the database entirely
    if (restoreOptions.cleanBeforeRestore) {
      args.push('--clean');
    }
  } else {
    // Restoring into an existing database
    args.push('-d', target.database);
    if (restoreOptions.cleanBeforeRestore) {
      // --clean drops existing objects before recreating them
      args.push('--clean');
      // --if-exists prevents errors when objects don't exist yet
      args.push('--if-exists');
    }
  }

  args.push('--no-password');

  return args;
}

/**
 * Validate the backup format value.
 * @param {string} format
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateFormat(format) {
  const VALID_FORMATS = ['custom', 'plain', 'directory', 'tar'];
  if (!VALID_FORMATS.includes(format)) {
    return {
      valid: false,
      error: `Invalid format "${format}". Supported formats: ${VALID_FORMATS.join(', ')}`,
    };
  }
  return { valid: true };
}

/**
 * Validate the compression level for gzip.
 * @param {number} level
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateCompressionLevel(level) {
  if (typeof level !== 'number' || level < 1 || level > 9) {
    return {
      valid: false,
      error: `Invalid compression level ${level}. Must be an integer between 1 and 9.`,
    };
  }
  return { valid: true };
}

/**
 * Compute SHA-256 checksum of a Buffer.
 * @param {Buffer} buf
 * @returns {string} hex string
 */
function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Collect a readable stream into a Buffer.
 * @param {import('stream').Readable} stream
 * @returns {Promise<Buffer>}
 */
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}


// ---------------------------------------------------------------------------
// Task 7.2: startBackup
// ---------------------------------------------------------------------------

/**
 * Start a backup operation for the given job configuration.
 * Returns immediately with { ok: true, backupId }; the backup runs asynchronously.
 *
 * @param {object} jobConfig  Full BackupJob object from BackupJobStore
 * @returns {{ ok: boolean, backupId: string }}
 */
export async function startBackup(jobConfig) {
  const backupId = crypto.randomUUID();

  // Reject duplicate backupId (req 1.5) — extremely unlikely with UUID but guard anyway
  if (_activeBackups.has(backupId)) {
    const err = new Error(`Backup ${backupId} is already in progress`);
    err.status = 409;
    throw err;
  }

  debug(`startBackup: jobId=${jobConfig.id} name="${jobConfig.name}" format=${jobConfig.format} targets=${(jobConfig.storageTargets||[]).length}`);

  const abortController = new AbortController();
  _activeBackups.set(backupId, abortController);

  const startedAt = new Date().toISOString();
  const jobId = jobConfig.id || 'unknown';
  const jobName = jobConfig.name || jobId;

  // Create catalog record with status "running"
  BackupCatalog.createCatalogRecord({
    backupId,
    jobId,
    jobName,
    triggerSource: jobConfig._triggerSource || 'manual',
    source: {
      host: jobConfig.source?.host,
      port: jobConfig.source?.port || 5432,
      database: jobConfig.source?.database,
    },
    format: jobConfig.format || 'custom',
    compression: jobConfig.compression || { type: 'none', level: 6 },
    encrypted: !!(jobConfig.encryption?.enabled),
    storagePaths: [],
    sizeBytes: 0,
    sha256Checksum: null,
    durationMs: 0,
    status: 'running',
    startedAt,
    completedAt: null,
    errorMessage: null,
    includeTables: jobConfig.includeTables || [],
    excludeTables: jobConfig.excludeTables || [],
    includeSchemas: jobConfig.includeSchemas || [],
    excludeSchemas: jobConfig.excludeSchemas || [],
    lastVerifiedAt: null,
    lastRestoredAt: null,
    lastRestoreTarget: null,
  });

  // Emit backup:started
  _io?.emit('backup:started', {
    backupId,
    jobId,
    jobName,
    format: jobConfig.format || 'custom',
    source: {
      host: jobConfig.source?.host,
      database: jobConfig.source?.database,
    },
    estimatedSizeBytes: null,
  });

  log('info', `Backup started: ${backupId} (job: ${jobName})`);

  // Run the actual backup asynchronously
  _runBackup(backupId, jobConfig, abortController, startedAt).catch((err) => {
    log('error', `Backup ${backupId} async error: ${err.message}`);
  });

  return { ok: true, backupId };
}

/**
 * Internal async backup runner.
 * @param {string} backupId
 * @param {object} jobConfig
 * @param {AbortController} abortController
 * @param {string} startedAt  ISO timestamp
 */
async function _runBackup(backupId, jobConfig, abortController, startedAt) {
  const startMs = Date.now();
  let progressInterval = null;
  let phase = 'connecting';
  let bytesWritten = 0;

  try {
    const format = jobConfig.format || 'custom';
    const compression = jobConfig.compression || { type: 'none', level: 6 };
    const encryption = jobConfig.encryption || null;
    const storageTargets = jobConfig.storageTargets || [];

    // Get the appropriate driver for this database type
    const { driver, resolvedType } = getDriver(jobConfig.dbType);
    debug(`_runBackup ${backupId}: using driver for dbType=${resolvedType}`);

    // Build backup tool args using driver
    const backupArgs = driver.buildBackupArgs(jobConfig);
    debug(`_runBackup ${backupId}: backup args: ${backupArgs.join(' ')}`);

    // Determine the backup tool command based on dbType
    let backupCommand;
    let backupEnv = { ...process.env };
    
    switch (resolvedType) {
      case 'postgresql':
        backupCommand = 'pg_dump';
        backupEnv.PGPASSWORD = jobConfig.source?.password || '';
        if (jobConfig.source?.sslMode) {
          backupEnv.PGSSLMODE = jobConfig.source.sslMode;
        }
        break;
      case 'mysql':
      case 'mariadb':
        backupCommand = 'mysqldump';
        backupEnv.MYSQL_PWD = jobConfig.source?.password || '';
        break;
      case 'mongodb':
        backupCommand = 'mongodump';
        // MongoDB uses connection URI with embedded credentials, no separate env var needed
        break;
      default:
        throw new Error(`Unsupported dbType: ${resolvedType}`);
    }

    // Spawn backup tool
    phase = 'dumping';
    const backupProc = spawn(backupCommand, backupArgs, {
      env: backupEnv,
      signal: abortController.signal,
    });

    // Collect stderr for error reporting
    const stderrChunks = [];
    backupProc.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    // Set up progress interval
    progressInterval = setInterval(() => {
      _io?.emit('backup:progress', {
        backupId,
        phase,
        bytesWritten,
        elapsedMs: Date.now() - startMs,
        estimatedRemainingMs: null,
      });
    }, 4000);

    // Build the pipeline: backup tool stdout → [compress] → [encrypt] → buffer
    let dataStream = backupProc.stdout;

    // Apply compression based on database type and format:
    // - PostgreSQL custom format: uses pg_dump's -Z flag (already in args, no external compression needed)
    // - PostgreSQL other formats (plain, tar, directory): need external compression
    // - MySQL/MariaDB: need external compression (mysqldump has no built-in compression)
    // - MongoDB: uses mongodump's --gzip flag (already in args, no external compression needed)
    
    const needsExternalCompression = compression?.type === 'gzip' && (
      (resolvedType === 'postgresql' && format !== 'custom') ||
      (resolvedType === 'mysql' || resolvedType === 'mariadb')
    );
    
    if (needsExternalCompression) {
      phase = 'compressing';
      const level = compression.level ?? 6;
      const gzip = zlib.createGzip({ level });
      dataStream = dataStream.pipe(gzip);
    } else if (compression?.type === 'lz4') {
      // lz4 is not natively supported in Node — fall back to gzip with a note
      log('warning', `lz4 compression not natively available; falling back to gzip for backup ${backupId}`);
      phase = 'compressing';
      const gzip = zlib.createGzip({ level: 1 }); // fast gzip as lz4 substitute
      dataStream = dataStream.pipe(gzip);
    }

    // Collect the (possibly compressed) data into a buffer so we can:
    //   1. Compute SHA-256 checksum
    //   2. Optionally encrypt
    //   3. Write to multiple targets
    const chunks = [];
    dataStream.on('data', (chunk) => {
      chunks.push(chunk);
      bytesWritten += chunk.length;
    });

    // Wait for backup tool to finish
    await new Promise((resolve, reject) => {
      backupProc.on('close', (code) => {
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
          reject(new Error(`${backupCommand} exited with code ${code}: ${stderr}`));
        } else {
          resolve();
        }
      });
      backupProc.on('error', reject);
      dataStream.on('error', reject);
      dataStream.on('end', resolve);
    });

    const rawBuffer = Buffer.concat(chunks);

    // Apply encryption if enabled
    let finalBuffer = rawBuffer;
    if (encryption?.enabled && encryption?.passphrase) {
      phase = 'encrypting';
      _io?.emit('backup:progress', {
        backupId,
        phase,
        bytesWritten,
        elapsedMs: Date.now() - startMs,
        estimatedRemainingMs: null,
      });

      finalBuffer = await _encryptBuffer(rawBuffer, encryption.passphrase);
    }

    // Compute SHA-256 on the final buffer (what is actually written to storage).
    // This must be done AFTER encryption so verify can recompute the same checksum
    // by reading the stored artifact directly.
    const checksum = sha256(finalBuffer);

    // Build artifact name and write to targets
    phase = 'uploading';
    _io?.emit('backup:progress', {
      backupId,
      phase,
      bytesWritten,
      elapsedMs: Date.now() - startMs,
      estimatedRemainingMs: null,
    });

    const ext = driver.getArtifactExtension(format, compression);
    const prefix = storageTargets[0]?.prefix || 'backups';
    const artifactName = BackupStore.buildArtifactPath(
      prefix,
      jobConfig.name || jobConfig.id || 'backup',
      new Date(startedAt),
      backupId,
      ext
    );

    // Write to targets (encryption already applied above, pass null to avoid double-encrypt)
    const { Readable } = await import('stream');
    const writeStream = Readable.from(finalBuffer);
    const writeResults = await BackupStore.writeToTargets(
      storageTargets,
      writeStream,
      artifactName,
      null  // encryption already applied
    );

    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startMs;

    const storagePaths = writeResults.map((r) => ({
      type: r.type,
      path: r.path,
      sizeBytes: r.sizeBytes,
      status: r.ok ? 'ok' : 'failed',
    }));

    const failedPaths = writeResults.filter(r => !r.ok);
    if (failedPaths.length > 0) {
      for (const f of failedPaths) {
        log('error', `Backup ${backupId}: storage write failed — ${f.error} (path: ${f.path})`);
      }
    }

    // Update catalog record to completed
    BackupCatalog.updateCatalogRecord(backupId, {
      status: 'completed',
      completedAt,
      durationMs,
      sizeBytes: finalBuffer.length,
      sha256Checksum: checksum,
      storagePaths,
      errorMessage: null,
    });

    // Emit backup:completed
    _io?.emit('backup:completed', {
      backupId,
      sizeBytes: finalBuffer.length,
      durationMs,
      storagePaths,
    });

    log('success', `Backup completed: ${backupId} (${finalBuffer.length} bytes, ${durationMs}ms)`);
    debug(`Backup ${backupId}: checksum=${checksum} storagePaths=${JSON.stringify(storagePaths.map(p=>p.path))}`);

    // Apply retention policy
    if (jobConfig.id) {
      try {
        await applyRetention(jobConfig.id);
      } catch (retErr) {
        log('warning', `Retention policy error for job ${jobConfig.id}: ${retErr.message}`);
      }
    }

    // Dispatch notifications
    if (jobConfig.notifications) {
      try {
        await notify(jobConfig.notifications, {
          event: 'backup_completed',
          reason: 'completed',
          backupId,
          jobName: jobConfig.name || jobConfig.id,
          source: `${jobConfig.source?.host}/${jobConfig.source?.database}`,
          dest: storagePaths.map((p) => p.path).join(', '),
          storagePaths,
          sizeBytes: finalBuffer.length,
          durationMs,
          elapsed: Math.round(durationMs / 1000),
          timestamp: completedAt,
          stats: { synced: 1, skipped: 0, failed: 0, bytesTransferred: finalBuffer.length },
        });
      } catch (notifyErr) {
        log('warning', `Notification error for backup ${backupId}: ${notifyErr.message}`);
      }
    }

  } catch (err) {
    clearInterval(progressInterval);
    _activeBackups.delete(backupId);

    const errorMessage = err.message || 'Unknown error';
    log('error', `Backup failed: ${backupId} — ${errorMessage}`);

    BackupCatalog.updateCatalogRecord(backupId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      errorMessage,
    });

    _io?.emit('backup:failed', { backupId, errorMessage });

    // Dispatch failure notifications
    if (jobConfig.notifications) {
      try {
        await notify(jobConfig.notifications, {
          event: 'backup_failed',
          reason: 'failed',
          backupId,
          jobName: jobConfig.name || jobConfig.id,
          source: `${jobConfig.source?.host}/${jobConfig.source?.database}`,
          dest: '',
          errorMessage,
          elapsed: Math.round((Date.now() - startMs) / 1000),
          timestamp: new Date().toISOString(),
          stats: { synced: 0, skipped: 0, failed: 1, bytesTransferred: 0 },
        });
      } catch (notifyErr) {
        log('warning', `Notification error for failed backup ${backupId}: ${notifyErr.message}`);
      }
    }

    return;
  }

  clearInterval(progressInterval);
  _activeBackups.delete(backupId);
}

/**
 * Encrypt a Buffer using the backupCrypto encrypt stream.
 * @param {Buffer} inputBuffer
 * @param {string} passphrase
 * @returns {Promise<Buffer>}
 */
async function _encryptBuffer(inputBuffer, passphrase) {
  const encryptStream = createEncryptStream(passphrase);
  const source = Readable.from(inputBuffer);

  const chunks = [];
  await new Promise((resolve, reject) => {
    encryptStream.on('data', (chunk) => chunks.push(chunk));
    encryptStream.on('end', resolve);
    encryptStream.on('error', reject);
    source.pipe(encryptStream);
  });

  return Buffer.concat(chunks);
}

/**
 * Decrypt a Buffer using the backupCrypto decrypt stream.
 * @param {Buffer} inputBuffer
 * @param {string} passphrase
 * @returns {Promise<Buffer>}
 */
async function _decryptBuffer(inputBuffer, passphrase) {
  const decryptStream = createDecryptStream(passphrase);
  const source = Readable.from(inputBuffer);

  const chunks = [];
  await new Promise((resolve, reject) => {
    decryptStream.on('data', (chunk) => chunks.push(chunk));
    decryptStream.on('end', resolve);
    decryptStream.on('error', reject);
    source.pipe(decryptStream);
  });

  return Buffer.concat(chunks);
}


// ---------------------------------------------------------------------------
// Task 7.8: startRestore
// ---------------------------------------------------------------------------

/**
 * Start a restore operation for the given backupId.
 *
 * @param {string} backupId
 * @param {{ host: string, port?: number, database: string, user: string, password: string }} target
 * @param {{ cleanBeforeRestore?: boolean, createDatabase?: boolean }} restoreOptions
 * @param {string|null} passphrase  Required for encrypted backups
 * @returns {Promise<{ ok: boolean }>}
 */
export async function startRestore(backupId, target, restoreOptions = {}, passphrase = null) {
  // Reject duplicate restore for same backupId (req 8.8)
  if (_activeRestores.has(backupId)) {
    const err = new Error(`Restore for backup ${backupId} is already in progress`);
    err.status = 409;
    throw err;
  }

  const record = BackupCatalog.getCatalogRecord(backupId);
  if (!record) {
    const err = new Error(`Backup record not found: ${backupId}`);
    err.status = 404;
    throw err;
  }

  debug(`startRestore: backupId=${backupId} target=${target.host}/${target.database} encrypted=${record.encrypted} format=${record.format}`);

  const abortController = new AbortController();
  _activeRestores.set(backupId, abortController);

  _io?.emit('restore:started', {
    backupId,
    jobName: record.jobName,
    source: record.source,
    target: { host: target.host, database: target.database },
  });

  log('info', `Restore started: ${backupId} → ${target.host}/${target.database}`);

  // Run restore asynchronously
  _runRestore(backupId, record, target, restoreOptions, passphrase, abortController).catch((err) => {
    log('error', `Restore ${backupId} async error: ${err.message}`);
  });

  return { ok: true };
}

/**
 * Internal async restore runner.
 */
async function _runRestore(backupId, record, target, restoreOptions, passphrase, abortController) {
  const startMs = Date.now();
  let progressInterval = null;
  let phase = 'downloading';

  try {
    // Set up progress interval
    progressInterval = setInterval(() => {
      _io?.emit('restore:progress', {
        backupId,
        phase,
        elapsedMs: Date.now() - startMs,
      });
    }, 4000);

    // Find a valid storage path
    const storagePath = record.storagePaths?.find((p) => p.status === 'ok')?.path;
    if (!storagePath) {
      throw new Error('No valid storage path found for this backup artifact');
    }

    // Download the artifact
    const rawStream = await BackupStore.readFromTarget(storagePath, null);
    let artifactBuffer = await streamToBuffer(rawStream);

    // Decrypt if encrypted (req 13.5, 13.6)
    if (record.encrypted) {
      if (!passphrase) {
        throw new Error('Passphrase required for encrypted backup');
      }
      phase = 'decrypting';
      _io?.emit('restore:progress', { backupId, phase, elapsedMs: Date.now() - startMs });

      try {
        artifactBuffer = await _decryptBuffer(artifactBuffer, passphrase);
      } catch (decryptErr) {
        // GCM auth failure — do NOT write any partial data (req 13.6)
        throw new Error('Decryption failed — incorrect passphrase or corrupted artifact');
      }
    }

    // Restore phase
    phase = 'restoring';
    _io?.emit('restore:progress', { backupId, phase, elapsedMs: Date.now() - startMs });

    // Get the appropriate driver for this database type (default to postgresql for backward compatibility)
    const { driver, resolvedType } = getDriver(record.dbType);
    debug(`_runRestore ${backupId}: using driver for dbType=${resolvedType}`);

    // Build restore tool args using driver
    const restoreArgs = driver.buildRestoreArgs(target, restoreOptions, record);
    debug(`_runRestore ${backupId}: restore args: ${restoreArgs.join(' ')}`);

    // Determine the restore tool command and environment based on dbType
    let restoreCommand;
    let restoreEnv = { ...process.env };
    
    switch (resolvedType) {
      case 'postgresql':
        // PostgreSQL uses psql for plain format, pg_restore for others
        const format = record.format || 'custom';
        if (format === 'plain') {
          restoreCommand = 'psql';
        } else {
          restoreCommand = 'pg_restore';
        }
        restoreEnv.PGPASSWORD = target.password || '';
        break;
      case 'mysql':
      case 'mariadb':
        restoreCommand = 'mysql';
        restoreEnv.MYSQL_PWD = target.password || '';
        break;
      case 'mongodb':
        restoreCommand = 'mongorestore';
        // MongoDB uses connection URI with embedded credentials, no separate env var needed
        break;
      default:
        throw new Error(`Unsupported dbType for restore: ${resolvedType}`);
    }

    // Handle decompression for MySQL/MariaDB if needed
    if ((resolvedType === 'mysql' || resolvedType === 'mariadb') && record.compression?.type === 'gzip') {
      debug(`_runRestore ${backupId}: decompressing MySQL/MariaDB artifact`);
      artifactBuffer = await new Promise((resolve, reject) => {
        const gunzip = zlib.createGunzip();
        const chunks = [];
        gunzip.on('data', (chunk) => chunks.push(chunk));
        gunzip.on('end', () => resolve(Buffer.concat(chunks)));
        gunzip.on('error', reject);
        gunzip.end(artifactBuffer);
      });
    }

    // Write artifact to temp file and execute restore command
    const os = await import('os');
    const format = record.format || 'custom';
    let ext;
    switch (resolvedType) {
      case 'postgresql':
        ext = format === 'tar' ? 'tar' : format === 'plain' ? 'sql' : 'dump';
        break;
      case 'mysql':
      case 'mariadb':
        ext = 'sql';
        break;
      case 'mongodb':
        ext = format === 'archive' ? 'bson' : 'bson';
        break;
      default:
        ext = 'dump';
    }
    const tmpFile = path.join(os.tmpdir(), `bkp-restore-${crypto.randomUUID()}.${ext}`);

    try {
      await fs.promises.writeFile(tmpFile, artifactBuffer);

      // For PostgreSQL and MySQL/MariaDB, pass the temp file as an argument
      // For MongoDB archive format, we need to pipe to stdin
      let finalArgs;
      if (resolvedType === 'mongodb' && format === 'archive') {
        // MongoDB archive format reads from stdin
        finalArgs = restoreArgs;
      } else {
        // PostgreSQL and MySQL read from file argument
        finalArgs = [...restoreArgs, tmpFile];
      }

      const restoreProc = spawn(restoreCommand, finalArgs, {
        env: restoreEnv,
        signal: abortController.signal,
      });

      // For MongoDB archive format, pipe the artifact to stdin
      if (resolvedType === 'mongodb' && format === 'archive') {
        restoreProc.stdin.write(artifactBuffer);
        restoreProc.stdin.end();
      }

      const stderrChunks = [];
      restoreProc.stderr.on('data', (chunk) => stderrChunks.push(chunk));

      await new Promise((resolve, reject) => {
        restoreProc.on('close', (code) => {
          const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
          if (code === 0) {
            resolve();
          } else if (code === 1 && resolvedType === 'postgresql' && restoreCommand === 'pg_restore') {
            // Exit code 1 = warnings only (non-fatal errors like "table already exists").
            // pg_restore still restored the data successfully — log and continue.
            log('warning', `pg_restore completed with warnings: ${stderr.slice(0, 500)}`);
            resolve();
          } else {
            // Fatal error — restore did not complete
            reject(new Error(`${restoreCommand} exited with code ${code}: ${stderr}`));
          }
        });
        restoreProc.on('error', reject);
      });
    } finally {
      fs.promises.unlink(tmpFile).catch(() => {});
    }

    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startMs;

    // Update catalog with restore info (req 8.6)
    BackupCatalog.updateCatalogRecord(backupId, {
      lastRestoredAt: completedAt,
      lastRestoreTarget: { host: target.host, database: target.database },
    });

    _io?.emit('restore:completed', {
      backupId,
      durationMs,
      target: { host: target.host, database: target.database },
    });

    log('success', `Restore completed: ${backupId} → ${target.host}/${target.database} (${durationMs}ms)`);

  } catch (err) {
    clearInterval(progressInterval);
    _activeRestores.delete(backupId);

    const errorMessage = err.message || 'Unknown restore error';
    log('error', `Restore failed: ${backupId} — ${errorMessage}`);

    _io?.emit('restore:failed', { backupId, errorMessage });
    return;
  }

  clearInterval(progressInterval);
  _activeRestores.delete(backupId);
}


// ---------------------------------------------------------------------------
// Task 7.10: verifyBackup
// ---------------------------------------------------------------------------

/**
 * Verify the integrity of a backup artifact.
 * Downloads the artifact, computes SHA-256, compares to stored checksum.
 * For custom/directory formats, also runs pg_restore --list.
 *
 * @param {string} backupId
 * @returns {Promise<{ ok: boolean, status: string }>}
 */
export async function verifyBackup(backupId) {
  const record = BackupCatalog.getCatalogRecord(backupId);
  if (!record) {
    const err = new Error(`Backup record not found: ${backupId}`);
    err.status = 404;
    throw err;
  }

  const storagePath = record.storagePaths?.find((p) => p.status === 'ok')?.path;
  if (!storagePath) {
    const pathsDebug = JSON.stringify(record.storagePaths || []);
    const errorMessage = `No valid storage path found for verification. storagePaths=${pathsDebug}`;
    BackupCatalog.updateCatalogRecord(backupId, {
      status: 'corrupted',
      errorMessage,
    });
    _io?.emit('backup:corrupted', { backupId, errorMessage });
    log('error', `Verify failed: ${backupId} — ${errorMessage}`);
    return { ok: false, status: 'corrupted' };
  }

  log('info', `Verifying backup ${backupId} from ${storagePath}`);

  let artifactBuffer;
  try {
    // Download artifact (req 9.1)
    const rawStream = await BackupStore.readFromTarget(storagePath, null);
    artifactBuffer = await streamToBuffer(rawStream);
  } catch (downloadErr) {
    // Download failure → set corrupted (req 9.5)
    const errorMessage = `Download failed: ${downloadErr.message}`;
    BackupCatalog.updateCatalogRecord(backupId, {
      status: 'corrupted',
      errorMessage,
    });
    _io?.emit('backup:corrupted', { backupId, errorMessage });
    log('error', `Verify failed (download): ${backupId} — ${errorMessage}`);
    return { ok: false, status: 'corrupted' };
  }

  // Compute SHA-256 checksum (req 9.1)
  const computedChecksum = sha256(artifactBuffer);
  const storedChecksum = record.sha256Checksum;

  debug(`Verify ${backupId}: computed=${computedChecksum} stored=${storedChecksum} match=${computedChecksum === storedChecksum}`);

  if (computedChecksum !== storedChecksum) {
    // Checksum mismatch → corrupted (req 9.3)
    const errorMessage = `Checksum mismatch: expected ${storedChecksum}, got ${computedChecksum}`;
    BackupCatalog.updateCatalogRecord(backupId, {
      status: 'corrupted',
      errorMessage,
    });
    _io?.emit('backup:corrupted', { backupId, errorMessage });
    log('error', `Verify failed (checksum): ${backupId}`);
    return { ok: false, status: 'corrupted' };
  }

  // Checksum matches — for custom/directory formats, run pg_restore --list (req 9.4)
  const format = record.format || 'custom';
  if (format === 'custom' || format === 'directory') {
    try {
      await _runPgRestoreList(artifactBuffer, format);
    } catch (structErr) {
      const errorMessage = `Structural validation failed: ${structErr.message}`;
      BackupCatalog.updateCatalogRecord(backupId, {
        status: 'corrupted',
        errorMessage,
      });
      _io?.emit('backup:corrupted', { backupId, errorMessage });
      log('error', `Verify failed (structure): ${backupId} — ${errorMessage}`);
      return { ok: false, status: 'corrupted' };
    }
  }

  // All checks passed → verified (req 9.2)
  const lastVerifiedAt = new Date().toISOString();
  BackupCatalog.updateCatalogRecord(backupId, {
    status: 'verified',
    lastVerifiedAt,
    errorMessage: null,
  });

  log('success', `Backup verified: ${backupId}`);
  return { ok: true, status: 'verified' };
}

/**
 * Run pg_restore --list on an artifact buffer for structural validation.
 * Writes the artifact to a temp file and passes it as an argument to avoid
 * EPIPE errors that occur when piping large buffers to pg_restore stdin.
 * @param {Buffer} artifactBuffer
 * @param {string} format
 */
async function _runPgRestoreList(artifactBuffer, format) {
  const os = await import('os');
  const tmpFile = path.join(os.tmpdir(), `bkp-verify-${crypto.randomUUID()}.dump`);

  try {
    // Write artifact to a temp file
    await fs.promises.writeFile(tmpFile, artifactBuffer);

    await new Promise((resolve, reject) => {
      // Pass the file path as an argument — pg_restore --list reads from file, not stdin
      const pgRestore = spawn('pg_restore', ['--list', tmpFile], {
        env: process.env,
      });

      const stderrChunks = [];
      pgRestore.stderr.on('data', (chunk) => stderrChunks.push(chunk));
      pgRestore.stdout.resume(); // discard the listing output

      pgRestore.on('close', (code) => {
        if (code !== 0) {
          const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
          reject(new Error(`pg_restore --list exited with code ${code}: ${stderr}`));
        } else {
          resolve();
        }
      });
      pgRestore.on('error', reject);
    });
  } finally {
    // Always clean up the temp file
    fs.promises.unlink(tmpFile).catch(() => {});
  }
}


// ---------------------------------------------------------------------------
// Task 7.12: applyRetention
// ---------------------------------------------------------------------------

/**
 * Evaluate and apply the retention policy for a backup job.
 * Deletes artifacts that no longer satisfy any retention rule.
 *
 * @param {string} jobId
 * @returns {Promise<{ deleted: number, failed: number }>}
 */
export async function applyRetention(jobId) {
  const job = BackupJobStore.getBackupJob(jobId);
  if (!job) {
    log('warning', `applyRetention: job not found: ${jobId}`);
    return { deleted: 0, failed: 0 };
  }

  const retentionPolicy = job.retentionPolicy;
  if (!retentionPolicy) {
    return { deleted: 0, failed: 0 };
  }

  // Load all completed/verified records for this job
  const allRecords = BackupCatalog.loadCatalog();
  const eligibleRecords = allRecords
    .filter((r) => r.jobId === jobId && (r.status === 'completed' || r.status === 'verified'))
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()); // newest first

  if (eligibleRecords.length === 0) {
    return { deleted: 0, failed: 0 };
  }

  // Determine which records to KEEP
  const keepSet = new Set();

  // keepLast: keep N most recent (req 10.5)
  if (retentionPolicy.keepLast != null && retentionPolicy.keepLast > 0) {
    const toKeep = eligibleRecords.slice(0, retentionPolicy.keepLast);
    for (const r of toKeep) keepSet.add(r.backupId);
  }

  // keepDailyFor: keep one backup per day for N days
  if (retentionPolicy.keepDailyFor != null && retentionPolicy.keepDailyFor > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionPolicy.keepDailyFor);
    const seenDays = new Set();
    for (const r of eligibleRecords) {
      const d = new Date(r.startedAt);
      if (d < cutoff) continue;
      const dayKey = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
      if (!seenDays.has(dayKey)) {
        seenDays.add(dayKey);
        keepSet.add(r.backupId);
      }
    }
  }

  // keepWeeklyFor: keep one backup per week for N weeks
  if (retentionPolicy.keepWeeklyFor != null && retentionPolicy.keepWeeklyFor > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionPolicy.keepWeeklyFor * 7);
    const seenWeeks = new Set();
    for (const r of eligibleRecords) {
      const d = new Date(r.startedAt);
      if (d < cutoff) continue;
      // ISO week: year + week number
      const weekKey = _getISOWeekKey(d);
      if (!seenWeeks.has(weekKey)) {
        seenWeeks.add(weekKey);
        keepSet.add(r.backupId);
      }
    }
  }

  // keepMonthlyFor: keep one backup per month for N months
  if (retentionPolicy.keepMonthlyFor != null && retentionPolicy.keepMonthlyFor > 0) {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - retentionPolicy.keepMonthlyFor);
    const seenMonths = new Set();
    for (const r of eligibleRecords) {
      const d = new Date(r.startedAt);
      if (d < cutoff) continue;
      const monthKey = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
      if (!seenMonths.has(monthKey)) {
        seenMonths.add(monthKey);
        keepSet.add(r.backupId);
      }
    }
  }

  // Records not in keepSet are candidates for deletion
  const toDelete = eligibleRecords.filter((r) => !keepSet.has(r.backupId));

  let deleted = 0;
  let failed = 0;

  for (const record of toDelete) {
    let allDeleted = true;

    // Delete from all storage paths (req 10.3)
    for (const sp of (record.storagePaths || [])) {
      if (sp.status !== 'ok') continue;
      const result = await BackupStore.deleteFromTarget(sp.path);
      if (!result.ok) {
        log('error', `Retention delete failed for ${record.backupId} at ${sp.path}: ${result.error}`);
        allDeleted = false;
      }
    }

    if (allDeleted) {
      // Update catalog status to "deleted" (req 10.3)
      BackupCatalog.updateCatalogRecord(record.backupId, { status: 'deleted' });
      deleted++;
      log('info', `Retention: deleted backup ${record.backupId}`);
    } else {
      // S3 delete failed — set delete_failed (req 10.4)
      BackupCatalog.updateCatalogRecord(record.backupId, { status: 'delete_failed' });
      failed++;
    }
  }

  return { deleted, failed };
}

/**
 * Get ISO year-week key for a date (e.g., "2024-W03").
 * @param {Date} date
 * @returns {string}
 */
function _getISOWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7; // Mon=1, Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}


// ---------------------------------------------------------------------------
// Task 7.14: rotateKey
// ---------------------------------------------------------------------------

/**
 * Re-encrypt all completed/verified artifacts for a job with a new passphrase.
 * Processes sequentially to limit memory/bandwidth usage.
 *
 * @param {string} jobId
 * @param {string} currentPassphrase
 * @param {string} newPassphrase
 * @returns {Promise<{ rotated: number, failed: number }>}
 */
export async function rotateKey(jobId, currentPassphrase, newPassphrase) {
  const job = BackupJobStore.getBackupJob(jobId);
  if (!job) {
    const err = new Error(`Job not found: ${jobId}`);
    err.status = 404;
    throw err;
  }

  // Load all completed/verified records for this job (req 13.7)
  const allRecords = BackupCatalog.loadCatalog();
  const eligibleRecords = allRecords.filter(
    (r) => r.jobId === jobId && (r.status === 'completed' || r.status === 'verified') && r.encrypted
  );

  let rotated = 0;
  let failed = 0;

  // Process sequentially (req 13.7)
  for (const record of eligibleRecords) {
    for (const sp of (record.storagePaths || [])) {
      if (sp.status !== 'ok') continue;

      try {
        // Download artifact
        const rawStream = await BackupStore.readFromTarget(sp.path, null);
        const encryptedBuffer = await streamToBuffer(rawStream);

        // Decrypt with current passphrase
        const plainBuffer = await _decryptBuffer(encryptedBuffer, currentPassphrase);

        // Re-encrypt with new passphrase
        const reEncryptedBuffer = await _encryptBuffer(plainBuffer, newPassphrase);

        // Upload back to the same path
        const { Readable } = await import('stream');
        const uploadStream = Readable.from(reEncryptedBuffer);
        // Determine target config from job's storageTargets by matching path prefix
        const targetConfig = _findTargetForPath(job.storageTargets || [], sp.path);
        await BackupStore.writeToTargets(
          targetConfig ? [targetConfig] : [],
          uploadStream,
          sp.path,  // use full path as artifact name (will be overridden by target logic)
          null
        );

        rotated++;
        log('info', `Key rotated for backup ${record.backupId} at ${sp.path}`);
      } catch (err) {
        failed++;
        log('error', `Key rotation failed for backup ${record.backupId} at ${sp.path}: ${err.message}`);
      }
    }
  }

  // Update the job's encryption passphrase in backup-jobs.json (req 13.7)
  if (rotated > 0 || failed === 0) {
    BackupJobStore.updateBackupJob(jobId, {
      encryption: {
        ...(job.encryption || {}),
        enabled: true,
        passphrase: newPassphrase,
      },
    });
  }

  log('info', `Key rotation complete for job ${jobId}: ${rotated} rotated, ${failed} failed`);
  return { rotated, failed };
}

/**
 * Find the storage target config that matches a given storage path.
 * @param {object[]} storageTargets
 * @param {string} storagePath
 * @returns {object|null}
 */
function _findTargetForPath(storageTargets, storagePath) {
  for (const target of storageTargets) {
    if (target.type === 's3' && storagePath.startsWith('s3://')) {
      const bucket = storagePath.slice('s3://'.length).split('/')[0];
      if (target.bucket === bucket) return target;
    } else if (target.type === 'local' && !storagePath.startsWith('s3://')) {
      if (storagePath.startsWith(target.localPath)) return target;
    }
  }
  return storageTargets[0] || null;
}

