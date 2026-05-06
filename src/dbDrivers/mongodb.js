/**
 * mongodb.js
 *
 * MongoDB database driver for the multi-database backup system.
 * Implements the standard driver interface for MongoDB backup and restore operations.
 */

import { spawn } from 'child_process';

/**
 * Build mongodump CLI arguments from a job configuration.
 * @param {object} jobConfig  Full BackupJob object
 * @returns {string[]}
 */
export function buildBackupArgs(jobConfig) {
  const {
    source,
    format = 'archive',
    compression = { type: 'none', level: 6 },
  } = jobConfig;

  const args = [];

  // Connection URI (contains embedded credentials)
  if (source.connectionUri) {
    args.push('--uri', source.connectionUri);
  }

  // Format: archive produces a single-file BSON, directory produces multi-file BSON
  if (format === 'archive') {
    args.push('--archive');
  }

  // Compression: mongodump has built-in gzip support
  if (compression?.type === 'gzip') {
    args.push('--gzip');
  }

  return args;
}

/**
 * Build mongorestore CLI arguments for restore.
 * @param {object} target  { host, port, database, user, password, connectionUri }
 * @param {object} restoreOptions  { cleanBeforeRestore, createDatabase }
 * @param {object} record  Catalog record (contains format, compression, etc.)
 * @returns {string[]}
 */
export function buildRestoreArgs(target, restoreOptions = {}, record) {
  const args = [];
  const format = record.format || 'archive';

  // Connection URI
  if (target.connectionUri) {
    args.push('--uri', target.connectionUri);
  }

  // Format: archive requires --archive flag
  if (format === 'archive') {
    args.push('--archive');
  }

  // Compression: if the backup was compressed, mongorestore needs --gzip
  if (record.compression?.type === 'gzip') {
    args.push('--gzip');
  }

  return args;
}

/**
 * Test the MongoDB database connection.
 * Uses mongosh to run a ping command.
 * @param {object} config  Connection parameters { connectionUri }
 * @returns {Promise<{ ok: boolean, version?: string, error?: string }>}
 */
export async function testConnection(config) {
  return new Promise((resolve) => {
    const args = [
      '--eval',
      'db.runCommand({ping:1})',
    ];

    // Add connection URI if provided
    if (config.connectionUri) {
      args.unshift(config.connectionUri);
    }

    const proc = spawn('mongosh', args);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      resolve({ ok: false, error: `mongosh not found: ${err.message}` });
    });

    proc.on('close', (code) => {
      if (code === 0) {
        // mongosh ping succeeded
        // Try to extract version info from stdout
        resolve({ ok: true, version: 'MongoDB server is alive' });
      } else {
        resolve({ ok: false, error: stderr.trim() || `mongosh ping failed with exit code ${code}` });
      }
    });
  });
}

/**
 * Return the default port number for MongoDB.
 * @returns {number}
 */
export function getDefaultPort() {
  return 27017;
}

/**
 * Return the list of valid backup format strings for MongoDB.
 * @returns {string[]}
 */
export function getSupportedFormats() {
  return ['archive', 'directory'];
}

/**
 * Return the file extension for a backup artifact given format and compression.
 * @param {string} format
 * @param {{ type: string, level?: number }|null} compression
 * @returns {string}
 */
export function getArtifactExtension(format, compression) {
  // MongoDB archive format produces BSON
  if (format === 'archive') {
    return 'bson';
  }
  
  // Directory format with compression produces tar.gz
  if (format === 'directory' && compression?.type === 'gzip') {
    return 'tar.gz';
  }
  
  // Directory format without compression
  return 'bson';
}
