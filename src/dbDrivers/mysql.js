/**
 * mysql.js
 *
 * MySQL/MariaDB database driver for the multi-database backup system.
 * Implements the standard driver interface for MySQL and MariaDB backup and restore operations.
 */

import { spawn } from 'child_process';

/**
 * Build mysqldump CLI arguments from a job configuration.
 * @param {object} jobConfig  Full BackupJob object
 * @returns {string[]}
 */
export function buildBackupArgs(jobConfig) {
  const {
    source,
  } = jobConfig;

  const args = [];

  // Connection args
  args.push('--host', source.host);
  args.push('--port', String(source.port || 3306));
  args.push('--user', source.user);

  // Database to backup
  args.push('--databases', source.database);

  // Use single-transaction for consistent backup without locking tables
  args.push('--single-transaction');

  // No password in args — use MYSQL_PWD env var
  return args;
}

/**
 * Build mysql CLI arguments for restore.
 * @param {object} target  { host, port, database, user, password }
 * @param {object} restoreOptions  { cleanBeforeRestore, createDatabase }
 * @param {object} record  Catalog record (contains format, compression, etc.)
 * @returns {string[]}
 */
export function buildRestoreArgs(target, restoreOptions = {}, record) {
  const args = [];

  args.push('--host', target.host);
  args.push('--port', String(target.port || 3306));
  args.push('--user', target.user || 'root');

  // For MySQL, the database is specified in the SQL dump itself (via USE statements)
  // We don't need to specify -D/--database unless we want to override it
  // The mysqldump --databases flag already includes CREATE DATABASE and USE statements

  // No password in args — use MYSQL_PWD env var
  return args;
}

/**
 * Test the MySQL/MariaDB database connection.
 * Uses mysqladmin ping to verify connectivity.
 * @param {object} config  Connection parameters { host, port, database, user, password }
 * @returns {Promise<{ ok: boolean, version?: string, error?: string }>}
 */
export async function testConnection(config) {
  return new Promise((resolve) => {
    const args = [
      '--host', config.host,
      '--port', String(config.port || 3306),
      '--user', config.user,
      'ping',
    ];

    const env = {
      ...process.env,
      MYSQL_PWD: config.password || '',
    };

    const proc = spawn('mysqladmin', args, { env });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      resolve({ ok: false, error: `mysqladmin not found: ${err.message}` });
    });

    proc.on('close', (code) => {
      if (code === 0) {
        // mysqladmin ping succeeded
        // Try to extract version info from stdout (typically "mysqld is alive")
        // We could also run a separate query to get version, but ping is sufficient for connection test
        resolve({ ok: true, version: stdout.trim() || 'MySQL/MariaDB server is alive' });
      } else {
        resolve({ ok: false, error: stderr.trim() || `mysqladmin ping failed with exit code ${code}` });
      }
    });
  });
}

/**
 * Return the default port number for MySQL/MariaDB.
 * @returns {number}
 */
export function getDefaultPort() {
  return 3306;
}

/**
 * Return the list of valid backup format strings for MySQL/MariaDB.
 * @returns {string[]}
 */
export function getSupportedFormats() {
  return ['sql'];
}

/**
 * Return the file extension for a backup artifact given format and compression.
 * @param {string} format
 * @param {{ type: string, level?: number }|null} compression
 * @returns {string}
 */
export function getArtifactExtension(format, compression) {
  // MySQL/MariaDB only supports sql format
  if (compression?.type === 'gzip') {
    return 'sql.gz';
  }
  return 'sql';
}
