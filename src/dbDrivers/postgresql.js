/**
 * postgresql.js
 *
 * PostgreSQL database driver for the multi-database backup system.
 * Implements the standard driver interface for PostgreSQL backup and restore operations.
 */

import pg from 'pg';
const { Client } = pg;

/**
 * Build pg_dump CLI arguments from a job configuration.
 * @param {object} jobConfig  Full BackupJob object
 * @returns {string[]}
 */
export function buildBackupArgs(jobConfig) {
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

  // Compression: for custom format use pg_dump's built-in -Z flag
  if (format === 'custom' && compression?.type === 'gzip') {
    const level = compression.level ?? 6;
    args.push('-Z', String(level));
  }

  // Include filters first (includes before excludes)
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
 * @param {object} record  Catalog record (contains format, compression, etc.)
 * @returns {string[]}
 */
export function buildRestoreArgs(target, restoreOptions = {}, record) {
  const args = [];
  const format = record.format || 'custom';

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
 * Test the PostgreSQL database connection.
 * Uses the pg Node.js client to connect and run SELECT version().
 * @param {object} config  Connection parameters { host, port, database, user, password }
 * @returns {Promise<{ ok: boolean, version?: string, error?: string }>}
 */
export async function testConnection(config) {
  const client = new Client({
    host: config.host,
    port: parseInt(config.port) || 5432,
    database: config.database,
    user: config.user,
    password: config.password,
    connectionTimeoutMillis: 10000,
  });

  try {
    await client.connect();
    const result = await client.query('SELECT version()');
    await client.end();
    return { ok: true, version: result.rows[0].version };
  } catch (err) {
    await client.end().catch(() => {});
    return { ok: false, error: err.message };
  }
}

/**
 * Return the default port number for PostgreSQL.
 * @returns {number}
 */
export function getDefaultPort() {
  return 5432;
}

/**
 * Return the list of valid backup format strings for PostgreSQL.
 * @returns {string[]}
 */
export function getSupportedFormats() {
  return ['custom', 'plain', 'directory', 'tar'];
}

/**
 * Return the file extension for a backup artifact given format and compression.
 * @param {string} format
 * @param {{ type: string, level?: number }|null} compression
 * @returns {string}
 */
export function getArtifactExtension(format, compression) {
  const compExt = compression?.type === 'gzip' ? '.gz' : compression?.type === 'lz4' ? '.lz4' : '';
  switch (format) {
    case 'custom':    return 'dump';
    case 'plain':     return `sql${compExt}`;
    case 'directory': return 'dir';
    case 'tar':       return `tar${compExt}`;
    default:          return `dump${compExt}`;
  }
}
