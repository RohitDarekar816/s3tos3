/**
 * Tests for src/backupJobStore.js
 *
 * Covers:
 *  - New field persistence (dbType, connectionUri, authDatabase)
 *  - Secret redaction (password, connectionUri)
 *  - Round-trip for all database types
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  listBackupJobs,
  getBackupJob,
  createBackupJob,
  updateBackupJob,
  deleteBackupJob,
} from '../../src/backupJobStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const BACKUP_JOBS_FILE = path.join(DATA_DIR, 'backup-jobs.json');
const BACKUP_FILE = BACKUP_JOBS_FILE + '.test-backup';

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Backup existing file if it exists
  if (fs.existsSync(BACKUP_JOBS_FILE)) {
    fs.copyFileSync(BACKUP_JOBS_FILE, BACKUP_FILE);
  }
  // Start with empty store
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(BACKUP_JOBS_FILE, '[]');
});

afterEach(() => {
  // Restore original file
  if (fs.existsSync(BACKUP_FILE)) {
    fs.renameSync(BACKUP_FILE, BACKUP_JOBS_FILE);
  } else {
    // Clean up test file
    if (fs.existsSync(BACKUP_JOBS_FILE)) {
      fs.unlinkSync(BACKUP_JOBS_FILE);
    }
  }
});

// ---------------------------------------------------------------------------
// Unit tests for new field persistence
// ---------------------------------------------------------------------------

describe('BackupJobStore - New field persistence', () => {
  it('persists dbType field for PostgreSQL', () => {
    const job = createBackupJob({
      name: 'Test PostgreSQL Job',
      dbType: 'postgresql',
      source: {
        host: 'localhost',
        port: 5432,
        database: 'testdb',
        user: 'testuser',
        password: 'secret123',
      },
    });

    const retrieved = getBackupJob(job.id);
    expect(retrieved.dbType).toBe('postgresql');
    expect(retrieved.source.host).toBe('localhost');
    expect(retrieved.source.password).toBe('secret123');
  });

  it('persists dbType field for MySQL', () => {
    const job = createBackupJob({
      name: 'Test MySQL Job',
      dbType: 'mysql',
      source: {
        host: 'mysql.example.com',
        port: 3306,
        database: 'mydb',
        user: 'root',
        password: 'mysql-pass',
      },
    });

    const retrieved = getBackupJob(job.id);
    expect(retrieved.dbType).toBe('mysql');
    expect(retrieved.source.host).toBe('mysql.example.com');
    expect(retrieved.source.port).toBe(3306);
  });

  it('persists dbType field for MariaDB', () => {
    const job = createBackupJob({
      name: 'Test MariaDB Job',
      dbType: 'mariadb',
      source: {
        host: 'mariadb.example.com',
        port: 3306,
        database: 'mariadb',
        user: 'admin',
        password: 'mariadb-pass',
      },
    });

    const retrieved = getBackupJob(job.id);
    expect(retrieved.dbType).toBe('mariadb');
  });

  it('persists connectionUri and authDatabase for MongoDB', () => {
    const job = createBackupJob({
      name: 'Test MongoDB Job',
      dbType: 'mongodb',
      source: {
        connectionUri: 'mongodb://user:pass@mongo.example.com:27017/mydb',
        authDatabase: 'admin',
      },
    });

    const retrieved = getBackupJob(job.id);
    expect(retrieved.dbType).toBe('mongodb');
    expect(retrieved.source.connectionUri).toBe('mongodb://user:pass@mongo.example.com:27017/mydb');
    expect(retrieved.source.authDatabase).toBe('admin');
  });

  it('persists all PostgreSQL-specific fields', () => {
    const job = createBackupJob({
      name: 'PostgreSQL with filters',
      dbType: 'postgresql',
      source: {
        host: 'pg.example.com',
        port: 5432,
        database: 'proddb',
        user: 'pguser',
        password: 'pgpass',
        schema: 'public',
      },
      includeTables: ['users', 'orders'],
      excludeTables: ['logs'],
      includeSchemas: ['public'],
      excludeSchemas: ['temp'],
    });

    const retrieved = getBackupJob(job.id);
    expect(retrieved.source.schema).toBe('public');
    expect(retrieved.includeTables).toEqual(['users', 'orders']);
    expect(retrieved.excludeTables).toEqual(['logs']);
    expect(retrieved.includeSchemas).toEqual(['public']);
    expect(retrieved.excludeSchemas).toEqual(['temp']);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for secret redaction
// ---------------------------------------------------------------------------

describe('BackupJobStore - Secret redaction', () => {
  it('redacts password in listBackupJobs for PostgreSQL', () => {
    createBackupJob({
      name: 'PG Job',
      dbType: 'postgresql',
      source: {
        host: 'localhost',
        port: 5432,
        database: 'testdb',
        user: 'testuser',
        password: 'secret123',
      },
    });

    const jobs = listBackupJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0].source.password).toBe('***');
  });

  it('redacts connectionUri in listBackupJobs for MongoDB', () => {
    createBackupJob({
      name: 'Mongo Job',
      dbType: 'mongodb',
      source: {
        connectionUri: 'mongodb://user:secretpass@mongo.example.com:27017/mydb',
        authDatabase: 'admin',
      },
    });

    const jobs = listBackupJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0].source.connectionUri).toBe('***');
    expect(jobs[0].source.authDatabase).toBe('admin'); // authDatabase is not a secret
  });

  it('redacts both password and connectionUri when both are present', () => {
    createBackupJob({
      name: 'Mixed Job',
      dbType: 'mongodb',
      source: {
        password: 'some-password',
        connectionUri: 'mongodb://user:pass@host:27017/db',
      },
    });

    const jobs = listBackupJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0].source.password).toBe('***');
    expect(jobs[0].source.connectionUri).toBe('***');
  });

  it('does not redact password in getBackupJob (returns raw job)', () => {
    const job = createBackupJob({
      name: 'Raw Job',
      dbType: 'postgresql',
      source: {
        host: 'localhost',
        port: 5432,
        database: 'testdb',
        user: 'testuser',
        password: 'actual-secret',
      },
    });

    const retrieved = getBackupJob(job.id);
    expect(retrieved.source.password).toBe('actual-secret');
  });

  it('does not redact connectionUri in getBackupJob (returns raw job)', () => {
    const job = createBackupJob({
      name: 'Raw Mongo Job',
      dbType: 'mongodb',
      source: {
        connectionUri: 'mongodb://user:actual-secret@host:27017/db',
      },
    });

    const retrieved = getBackupJob(job.id);
    expect(retrieved.source.connectionUri).toBe('mongodb://user:actual-secret@host:27017/db');
  });

  it('redacts all secret fields together', () => {
    createBackupJob({
      name: 'Full Job',
      dbType: 'postgresql',
      source: {
        host: 'localhost',
        port: 5432,
        database: 'testdb',
        user: 'testuser',
        password: 'db-password',
      },
      storageTargets: [
        {
          type: 's3',
          bucket: 'my-bucket',
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 's3-secret-key',
        },
      ],
      encryption: {
        enabled: true,
        passphrase: 'encryption-passphrase',
      },
      notifications: {
        email: {
          enabled: true,
          to: 'admin@example.com',
          user: 'smtp-user',
          pass: 'smtp-password',
        },
      },
    });

    const jobs = listBackupJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0].source.password).toBe('***');
    expect(jobs[0].storageTargets[0].secretAccessKey).toBe('***');
    expect(jobs[0].encryption.passphrase).toBe('***');
    expect(jobs[0].notifications.email.pass).toBe('***');
  });

  it('handles missing source object gracefully', () => {
    createBackupJob({
      name: 'No Source Job',
      dbType: 'postgresql',
    });

    const jobs = listBackupJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0].source).toBeUndefined();
  });

  it('handles source object without password or connectionUri', () => {
    createBackupJob({
      name: 'No Secrets Job',
      dbType: 'postgresql',
      source: {
        host: 'localhost',
        port: 5432,
        database: 'testdb',
        user: 'testuser',
      },
    });

    const jobs = listBackupJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0].source.password).toBeUndefined();
    expect(jobs[0].source.connectionUri).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unit tests for round-trip persistence
// ---------------------------------------------------------------------------

describe('BackupJobStore - Round-trip persistence', () => {
  it('round-trips PostgreSQL job with all fields', () => {
    const original = {
      name: 'PostgreSQL Full',
      dbType: 'postgresql',
      format: 'custom',
      compression: { type: 'gzip', level: 6 },
      source: {
        host: 'pg.example.com',
        port: 5432,
        database: 'proddb',
        user: 'pguser',
        password: 'pgpass',
        schema: 'public',
      },
      includeTables: ['users'],
      excludeTables: ['logs'],
    };

    const job = createBackupJob(original);
    const retrieved = getBackupJob(job.id);

    expect(retrieved.dbType).toBe(original.dbType);
    expect(retrieved.format).toBe(original.format);
    expect(retrieved.compression).toEqual(original.compression);
    expect(retrieved.source.host).toBe(original.source.host);
    expect(retrieved.source.port).toBe(original.source.port);
    expect(retrieved.source.database).toBe(original.source.database);
    expect(retrieved.source.user).toBe(original.source.user);
    expect(retrieved.source.password).toBe(original.source.password);
    expect(retrieved.source.schema).toBe(original.source.schema);
    expect(retrieved.includeTables).toEqual(original.includeTables);
    expect(retrieved.excludeTables).toEqual(original.excludeTables);
  });

  it('round-trips MySQL job with all fields', () => {
    const original = {
      name: 'MySQL Full',
      dbType: 'mysql',
      format: 'sql',
      compression: { type: 'gzip', level: 9 },
      source: {
        host: 'mysql.example.com',
        port: 3306,
        database: 'mydb',
        user: 'root',
        password: 'mysql-secret',
      },
    };

    const job = createBackupJob(original);
    const retrieved = getBackupJob(job.id);

    expect(retrieved.dbType).toBe(original.dbType);
    expect(retrieved.format).toBe(original.format);
    expect(retrieved.source.host).toBe(original.source.host);
    expect(retrieved.source.port).toBe(original.source.port);
    expect(retrieved.source.database).toBe(original.source.database);
    expect(retrieved.source.user).toBe(original.source.user);
    expect(retrieved.source.password).toBe(original.source.password);
  });

  it('round-trips MongoDB job with connectionUri and authDatabase', () => {
    const original = {
      name: 'MongoDB Full',
      dbType: 'mongodb',
      format: 'archive',
      compression: { type: 'gzip', level: 6 },
      source: {
        connectionUri: 'mongodb://admin:secret@mongo.example.com:27017/mydb?authSource=admin',
        authDatabase: 'admin',
      },
    };

    const job = createBackupJob(original);
    const retrieved = getBackupJob(job.id);

    expect(retrieved.dbType).toBe(original.dbType);
    expect(retrieved.format).toBe(original.format);
    expect(retrieved.source.connectionUri).toBe(original.source.connectionUri);
    expect(retrieved.source.authDatabase).toBe(original.source.authDatabase);
  });

  it('updates job and preserves new fields', () => {
    const job = createBackupJob({
      name: 'Original Job',
      dbType: 'postgresql',
      source: {
        host: 'localhost',
        port: 5432,
        database: 'testdb',
        user: 'testuser',
        password: 'original-pass',
      },
    });

    const updated = updateBackupJob(job.id, {
      name: 'Updated Job',
      dbType: 'mysql',
      source: {
        host: 'mysql.example.com',
        port: 3306,
        database: 'newdb',
        user: 'newuser',
        password: 'new-pass',
      },
    });

    expect(updated.name).toBe('Updated Job');
    expect(updated.dbType).toBe('mysql');
    expect(updated.source.host).toBe('mysql.example.com');
    expect(updated.source.password).toBe('new-pass');
  });

  it('deletes job successfully', () => {
    const job = createBackupJob({
      name: 'Job to Delete',
      dbType: 'postgresql',
      source: { host: 'localhost', port: 5432, database: 'testdb', user: 'user', password: 'pass' },
    });

    const deleted = deleteBackupJob(job.id);
    expect(deleted).toBe(true);

    const retrieved = getBackupJob(job.id);
    expect(retrieved).toBeNull();
  });
});
