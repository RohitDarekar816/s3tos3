import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createCatalogRecord,
  listCatalog,
  getCatalogRecord,
  updateCatalogRecord,
  loadCatalog,
} from '../../src/backupCatalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const TEST_CATALOG_FILE = path.join(TEST_DATA_DIR, 'backup-catalog.json');

describe('backupCatalog - dbType support', () => {
  beforeEach(() => {
    // Clean up test catalog file before each test
    if (fs.existsSync(TEST_CATALOG_FILE)) {
      fs.unlinkSync(TEST_CATALOG_FILE);
    }
  });

  afterEach(() => {
    // Clean up test catalog file after each test
    try {
      if (fs.existsSync(TEST_CATALOG_FILE)) {
        fs.unlinkSync(TEST_CATALOG_FILE);
      }
    } catch (err) {
      // Ignore cleanup errors
    }
  });

  describe('createCatalogRecord', () => {
    it('accepts and stores dbType field when provided', () => {
      const record = {
        backupId: 'test-backup-1',
        jobId: 'job-1',
        jobName: 'Test Job',
        dbType: 'mysql',
        format: 'sql',
        status: 'completed',
        startedAt: new Date().toISOString(),
      };

      const result = createCatalogRecord(record);

      expect(result.dbType).toBe('mysql');
      expect(result.backupId).toBe('test-backup-1');
    });

    it('defaults dbType to postgresql when not provided', () => {
      const record = {
        backupId: 'test-backup-2',
        jobId: 'job-2',
        jobName: 'Legacy Job',
        format: 'custom',
        status: 'completed',
        startedAt: new Date().toISOString(),
      };

      const result = createCatalogRecord(record);

      expect(result.dbType).toBe('postgresql');
      expect(result.backupId).toBe('test-backup-2');
    });

    it('stores mongodb dbType correctly', () => {
      const record = {
        backupId: 'test-backup-3',
        jobId: 'job-3',
        jobName: 'MongoDB Job',
        dbType: 'mongodb',
        format: 'archive',
        status: 'completed',
        startedAt: new Date().toISOString(),
      };

      const result = createCatalogRecord(record);

      expect(result.dbType).toBe('mongodb');
    });

    it('stores mariadb dbType correctly', () => {
      const record = {
        backupId: 'test-backup-4',
        jobId: 'job-4',
        jobName: 'MariaDB Job',
        dbType: 'mariadb',
        format: 'sql',
        status: 'completed',
        startedAt: new Date().toISOString(),
      };

      const result = createCatalogRecord(record);

      expect(result.dbType).toBe('mariadb');
    });
  });

  describe('listCatalog', () => {
    it('includes dbType field in returned records', () => {
      createCatalogRecord({
        backupId: 'test-backup-5',
        jobId: 'job-5',
        jobName: 'MySQL Job',
        dbType: 'mysql',
        format: 'sql',
        status: 'completed',
        startedAt: new Date().toISOString(),
      });

      const records = listCatalog();

      expect(records).toHaveLength(1);
      expect(records[0].dbType).toBe('mysql');
      expect(records[0].backupId).toBe('test-backup-5');
    });

    it('defaults dbType to postgresql for records without dbType (backward compatibility)', () => {
      // Manually create a record without dbType to simulate legacy data
      const legacyRecord = {
        backupId: 'legacy-backup-1',
        jobId: 'legacy-job-1',
        jobName: 'Legacy PostgreSQL Job',
        format: 'custom',
        status: 'completed',
        startedAt: new Date().toISOString(),
      };

      // Write directly to file to bypass createCatalogRecord's default
      fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
      fs.writeFileSync(TEST_CATALOG_FILE, JSON.stringify([legacyRecord], null, 2));

      const records = listCatalog();

      expect(records).toHaveLength(1);
      expect(records[0].dbType).toBe('postgresql');
      expect(records[0].backupId).toBe('legacy-backup-1');
    });

    it('includes dbType for multiple records with different database types', () => {
      createCatalogRecord({
        backupId: 'backup-pg',
        jobId: 'job-pg',
        jobName: 'PostgreSQL Job',
        dbType: 'postgresql',
        format: 'custom',
        status: 'completed',
        startedAt: '2024-01-01T10:00:00Z',
      });

      createCatalogRecord({
        backupId: 'backup-mysql',
        jobId: 'job-mysql',
        jobName: 'MySQL Job',
        dbType: 'mysql',
        format: 'sql',
        status: 'completed',
        startedAt: '2024-01-02T10:00:00Z',
      });

      createCatalogRecord({
        backupId: 'backup-mongo',
        jobId: 'job-mongo',
        jobName: 'MongoDB Job',
        dbType: 'mongodb',
        format: 'archive',
        status: 'completed',
        startedAt: '2024-01-03T10:00:00Z',
      });

      const records = listCatalog();

      expect(records).toHaveLength(3);
      
      // Records should be sorted by startedAt descending
      expect(records[0].backupId).toBe('backup-mongo');
      expect(records[0].dbType).toBe('mongodb');
      
      expect(records[1].backupId).toBe('backup-mysql');
      expect(records[1].dbType).toBe('mysql');
      
      expect(records[2].backupId).toBe('backup-pg');
      expect(records[2].dbType).toBe('postgresql');
    });
  });

  describe('getCatalogRecord', () => {
    it('returns record with dbType when it exists', () => {
      createCatalogRecord({
        backupId: 'test-backup-6',
        jobId: 'job-6',
        jobName: 'Test Job',
        dbType: 'mysql',
        format: 'sql',
        status: 'completed',
        startedAt: new Date().toISOString(),
      });

      const record = getCatalogRecord('test-backup-6');

      expect(record).not.toBeNull();
      expect(record.dbType).toBe('mysql');
    });

    it('returns record without dbType for legacy records', () => {
      // Manually create a legacy record
      const legacyRecord = {
        backupId: 'legacy-backup-2',
        jobId: 'legacy-job-2',
        jobName: 'Legacy Job',
        format: 'custom',
        status: 'completed',
        startedAt: new Date().toISOString(),
      };

      fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
      fs.writeFileSync(TEST_CATALOG_FILE, JSON.stringify([legacyRecord], null, 2));

      const record = getCatalogRecord('legacy-backup-2');

      expect(record).not.toBeNull();
      // getCatalogRecord returns raw record without defaulting
      expect(record.dbType).toBeUndefined();
    });
  });

  describe('updateCatalogRecord', () => {
    it('preserves dbType when updating other fields', () => {
      createCatalogRecord({
        backupId: 'test-backup-7',
        jobId: 'job-7',
        jobName: 'Test Job',
        dbType: 'mongodb',
        format: 'archive',
        status: 'running',
        startedAt: new Date().toISOString(),
      });

      const updated = updateCatalogRecord('test-backup-7', {
        status: 'completed',
        completedAt: new Date().toISOString(),
      });

      expect(updated).not.toBeNull();
      expect(updated.dbType).toBe('mongodb');
      expect(updated.status).toBe('completed');
    });

    it('allows updating dbType if needed', () => {
      createCatalogRecord({
        backupId: 'test-backup-8',
        jobId: 'job-8',
        jobName: 'Test Job',
        dbType: 'mysql',
        format: 'sql',
        status: 'completed',
        startedAt: new Date().toISOString(),
      });

      const updated = updateCatalogRecord('test-backup-8', {
        dbType: 'mariadb',
      });

      expect(updated).not.toBeNull();
      expect(updated.dbType).toBe('mariadb');
    });
  });

  describe('backward compatibility', () => {
    it('handles mixed catalog with legacy and new records', () => {
      // Create a legacy record without dbType
      const legacyRecord = {
        backupId: 'legacy-backup-3',
        jobId: 'legacy-job-3',
        jobName: 'Legacy Job',
        format: 'custom',
        status: 'completed',
        startedAt: '2024-01-01T10:00:00Z',
      };

      fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
      fs.writeFileSync(TEST_CATALOG_FILE, JSON.stringify([legacyRecord], null, 2));

      // Add a new record with dbType
      createCatalogRecord({
        backupId: 'new-backup-1',
        jobId: 'new-job-1',
        jobName: 'New MySQL Job',
        dbType: 'mysql',
        format: 'sql',
        status: 'completed',
        startedAt: '2024-01-02T10:00:00Z',
      });

      const records = listCatalog();

      expect(records).toHaveLength(2);
      
      // New record should have mysql
      const newRecord = records.find(r => r.backupId === 'new-backup-1');
      expect(newRecord.dbType).toBe('mysql');
      
      // Legacy record should default to postgresql
      const legacyRecordResult = records.find(r => r.backupId === 'legacy-backup-3');
      expect(legacyRecordResult.dbType).toBe('postgresql');
    });
  });
});
