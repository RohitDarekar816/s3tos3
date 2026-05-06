import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createCatalogRecord,
  listCatalog,
} from '../../src/backupCatalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const TEST_CATALOG_FILE = path.join(TEST_DATA_DIR, 'backup-catalog.json');

describe('backupCatalog - integration tests for dbType', () => {
  beforeEach(() => {
    // Ensure data directory exists
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    if (fs.existsSync(TEST_CATALOG_FILE)) {
      fs.unlinkSync(TEST_CATALOG_FILE);
    }
  });

  afterEach(() => {
    try {
      if (fs.existsSync(TEST_CATALOG_FILE)) {
        fs.unlinkSync(TEST_CATALOG_FILE);
      }
    } catch (err) {
      // Ignore cleanup errors
    }
  });

  it('simulates backupEngine creating records with different dbTypes', () => {
    // Simulate PostgreSQL backup (current behavior - no dbType passed)
    const pgRecord = createCatalogRecord({
      backupId: 'pg-backup-1',
      jobId: 'pg-job-1',
      jobName: 'PostgreSQL Backup',
      source: {
        host: 'localhost',
        port: 5432,
        database: 'mydb',
      },
      format: 'custom',
      status: 'completed',
      startedAt: '2024-01-01T10:00:00Z',
    });

    // Verify it defaults to postgresql
    expect(pgRecord.dbType).toBe('postgresql');

    // Simulate MySQL backup (future behavior - dbType passed)
    const mysqlRecord = createCatalogRecord({
      backupId: 'mysql-backup-1',
      jobId: 'mysql-job-1',
      jobName: 'MySQL Backup',
      dbType: 'mysql',
      source: {
        host: 'localhost',
        port: 3306,
        database: 'mydb',
      },
      format: 'sql',
      status: 'completed',
      startedAt: '2024-01-02T10:00:00Z',
    });

    expect(mysqlRecord.dbType).toBe('mysql');

    // Simulate MongoDB backup (future behavior - dbType passed)
    const mongoRecord = createCatalogRecord({
      backupId: 'mongo-backup-1',
      jobId: 'mongo-job-1',
      jobName: 'MongoDB Backup',
      dbType: 'mongodb',
      source: {
        host: null,
        port: null,
        database: null,
      },
      format: 'archive',
      status: 'completed',
      startedAt: '2024-01-03T10:00:00Z',
    });

    expect(mongoRecord.dbType).toBe('mongodb');

    // List all records and verify dbType is present
    const allRecords = listCatalog();
    
    expect(allRecords).toHaveLength(3);
    
    // All records should have dbType
    allRecords.forEach(record => {
      expect(record.dbType).toBeDefined();
      expect(['postgresql', 'mysql', 'mongodb']).toContain(record.dbType);
    });

    // Verify specific records
    const pgFromList = allRecords.find(r => r.backupId === 'pg-backup-1');
    expect(pgFromList.dbType).toBe('postgresql');

    const mysqlFromList = allRecords.find(r => r.backupId === 'mysql-backup-1');
    expect(mysqlFromList.dbType).toBe('mysql');

    const mongoFromList = allRecords.find(r => r.backupId === 'mongo-backup-1');
    expect(mongoFromList.dbType).toBe('mongodb');
  });

  it('handles upgrade scenario: existing catalog without dbType + new records with dbType', () => {
    // Simulate existing catalog with legacy records (no dbType)
    const legacyRecords = [
      {
        backupId: 'legacy-1',
        jobId: 'job-1',
        jobName: 'Old Backup 1',
        format: 'custom',
        status: 'completed',
        startedAt: '2023-12-01T10:00:00Z',
      },
      {
        backupId: 'legacy-2',
        jobId: 'job-2',
        jobName: 'Old Backup 2',
        format: 'plain',
        status: 'completed',
        startedAt: '2023-12-02T10:00:00Z',
      },
    ];

    // Write legacy records directly to file
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    fs.writeFileSync(TEST_CATALOG_FILE, JSON.stringify(legacyRecords, null, 2));

    // Now add new records with dbType (simulating post-upgrade backups)
    createCatalogRecord({
      backupId: 'new-mysql-1',
      jobId: 'mysql-job-1',
      jobName: 'New MySQL Backup',
      dbType: 'mysql',
      format: 'sql',
      status: 'completed',
      startedAt: '2024-01-01T10:00:00Z',
    });

    createCatalogRecord({
      backupId: 'new-mongo-1',
      jobId: 'mongo-job-1',
      jobName: 'New MongoDB Backup',
      dbType: 'mongodb',
      format: 'archive',
      status: 'completed',
      startedAt: '2024-01-02T10:00:00Z',
    });

    // List all records
    const allRecords = listCatalog();

    expect(allRecords).toHaveLength(4);

    // Legacy records should default to postgresql
    const legacy1 = allRecords.find(r => r.backupId === 'legacy-1');
    expect(legacy1.dbType).toBe('postgresql');

    const legacy2 = allRecords.find(r => r.backupId === 'legacy-2');
    expect(legacy2.dbType).toBe('postgresql');

    // New records should have their specified dbType
    const newMysql = allRecords.find(r => r.backupId === 'new-mysql-1');
    expect(newMysql.dbType).toBe('mysql');

    const newMongo = allRecords.find(r => r.backupId === 'new-mongo-1');
    expect(newMongo.dbType).toBe('mongodb');

    // All records should have dbType defined
    allRecords.forEach(record => {
      expect(record.dbType).toBeDefined();
      expect(record.dbType).toBeTruthy();
    });
  });
});
