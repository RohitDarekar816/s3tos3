/**
 * restoreDriverDispatch.test.js
 *
 * Unit tests to verify that _runRestore uses the driver dispatcher correctly.
 * Tests that the correct driver's buildRestoreArgs is called based on dbType.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as BackupEngine from '../../src/backupEngine.js';
import * as BackupCatalog from '../../src/backupCatalog.js';
import * as BackupStore from '../../src/backupStore.js';
import { Readable } from 'stream';

// Mock the dependencies
vi.mock('../../src/backupCatalog.js');
vi.mock('../../src/backupStore.js');
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

describe('Restore Driver Dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    
    // Initialize BackupEngine with a mock Socket.io server
    const mockIo = {
      emit: vi.fn(),
    };
    BackupEngine.initBackupEngine(mockIo);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('PostgreSQL restore', () => {
    it('should use PostgreSQL driver for records with dbType=postgresql', async () => {
      const backupId = 'test-backup-pg';
      const mockRecord = {
        backupId,
        jobId: 'job-1',
        jobName: 'Test PostgreSQL Backup',
        dbType: 'postgresql',
        format: 'custom',
        compression: { type: 'none' },
        encrypted: false,
        storagePaths: [{ path: 's3://bucket/backup.dump', status: 'ok' }],
      };

      const target = {
        host: 'localhost',
        port: 5432,
        database: 'testdb',
        user: 'postgres',
        password: 'secret',
      };

      // Mock BackupCatalog.getCatalogRecord to return our test record
      vi.mocked(BackupCatalog.getCatalogRecord).mockReturnValue(mockRecord);

      // Mock BackupStore.readFromTarget to return a readable stream
      const mockBuffer = Buffer.from('mock backup data');
      vi.mocked(BackupStore.readFromTarget).mockResolvedValue(Readable.from(mockBuffer));

      // Mock BackupCatalog.updateCatalogRecord
      vi.mocked(BackupCatalog.updateCatalogRecord).mockReturnValue(undefined);

      // Mock spawn to simulate successful restore
      const { spawn } = await import('child_process');
      const mockProcess = {
        stdin: { write: vi.fn(), end: vi.fn() },
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn((event, callback) => {
          if (event === 'data') {
            // Simulate empty stderr
          }
        }) },
        on: vi.fn((event, callback) => {
          if (event === 'close') {
            // Simulate successful exit
            setTimeout(() => callback(0), 10);
          }
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockProcess);

      // Start the restore
      const result = await BackupEngine.startRestore(backupId, target, {}, null);

      expect(result.ok).toBe(true);

      // Wait a bit for the async restore to start
      await new Promise(resolve => setTimeout(resolve, 50));

      // Verify that spawn was called with pg_restore (for custom format)
      expect(spawn).toHaveBeenCalled();
      const spawnCalls = vi.mocked(spawn).mock.calls;
      expect(spawnCalls.length).toBeGreaterThan(0);
      expect(spawnCalls[0][0]).toBe('pg_restore');
    });

    it('should use psql for PostgreSQL plain format', async () => {
      const backupId = 'test-backup-pg-plain';
      const mockRecord = {
        backupId,
        jobId: 'job-2',
        jobName: 'Test PostgreSQL Plain Backup',
        dbType: 'postgresql',
        format: 'plain',
        compression: { type: 'none' },
        encrypted: false,
        storagePaths: [{ path: 's3://bucket/backup.sql', status: 'ok' }],
      };

      const target = {
        host: 'localhost',
        port: 5432,
        database: 'testdb',
        user: 'postgres',
        password: 'secret',
      };

      vi.mocked(BackupCatalog.getCatalogRecord).mockReturnValue(mockRecord);
      const mockBuffer = Buffer.from('SELECT 1;');
      vi.mocked(BackupStore.readFromTarget).mockResolvedValue(Readable.from(mockBuffer));
      vi.mocked(BackupCatalog.updateCatalogRecord).mockReturnValue(undefined);

      const { spawn } = await import('child_process');
      const mockProcess = {
        stdin: { write: vi.fn(), end: vi.fn() },
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn((event, callback) => {}) },
        on: vi.fn((event, callback) => {
          if (event === 'close') {
            setTimeout(() => callback(0), 10);
          }
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockProcess);

      const result = await BackupEngine.startRestore(backupId, target, {}, null);
      expect(result.ok).toBe(true);

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(spawn).toHaveBeenCalled();
      const spawnCalls = vi.mocked(spawn).mock.calls;
      expect(spawnCalls[0][0]).toBe('psql');
    });
  });

  describe('MySQL restore', () => {
    it('should use MySQL driver for records with dbType=mysql', async () => {
      const backupId = 'test-backup-mysql';
      const mockRecord = {
        backupId,
        jobId: 'job-3',
        jobName: 'Test MySQL Backup',
        dbType: 'mysql',
        format: 'sql',
        compression: { type: 'none' },
        encrypted: false,
        storagePaths: [{ path: 's3://bucket/backup.sql', status: 'ok' }],
      };

      const target = {
        host: 'localhost',
        port: 3306,
        database: 'testdb',
        user: 'root',
        password: 'secret',
      };

      vi.mocked(BackupCatalog.getCatalogRecord).mockReturnValue(mockRecord);
      const mockBuffer = Buffer.from('CREATE TABLE test (id INT);');
      vi.mocked(BackupStore.readFromTarget).mockResolvedValue(Readable.from(mockBuffer));
      vi.mocked(BackupCatalog.updateCatalogRecord).mockReturnValue(undefined);

      const { spawn } = await import('child_process');
      const mockProcess = {
        stdin: { write: vi.fn(), end: vi.fn() },
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn((event, callback) => {}) },
        on: vi.fn((event, callback) => {
          if (event === 'close') {
            setTimeout(() => callback(0), 10);
          }
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockProcess);

      const result = await BackupEngine.startRestore(backupId, target, {}, null);
      expect(result.ok).toBe(true);

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(spawn).toHaveBeenCalled();
      const spawnCalls = vi.mocked(spawn).mock.calls;
      expect(spawnCalls[0][0]).toBe('mysql');
    });
  });

  describe('MongoDB restore', () => {
    it('should use MongoDB driver for records with dbType=mongodb', async () => {
      const backupId = 'test-backup-mongo';
      const mockRecord = {
        backupId,
        jobId: 'job-4',
        jobName: 'Test MongoDB Backup',
        dbType: 'mongodb',
        format: 'archive',
        compression: { type: 'gzip' },
        encrypted: false,
        storagePaths: [{ path: 's3://bucket/backup.bson', status: 'ok' }],
      };

      const target = {
        connectionUri: 'mongodb://localhost:27017/testdb',
      };

      vi.mocked(BackupCatalog.getCatalogRecord).mockReturnValue(mockRecord);
      const mockBuffer = Buffer.from('mock bson data');
      vi.mocked(BackupStore.readFromTarget).mockResolvedValue(Readable.from(mockBuffer));
      vi.mocked(BackupCatalog.updateCatalogRecord).mockReturnValue(undefined);

      const { spawn } = await import('child_process');
      const mockProcess = {
        stdin: { write: vi.fn(), end: vi.fn() },
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn((event, callback) => {}) },
        on: vi.fn((event, callback) => {
          if (event === 'close') {
            setTimeout(() => callback(0), 10);
          }
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockProcess);

      const result = await BackupEngine.startRestore(backupId, target, {}, null);
      expect(result.ok).toBe(true);

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(spawn).toHaveBeenCalled();
      const spawnCalls = vi.mocked(spawn).mock.calls;
      expect(spawnCalls[0][0]).toBe('mongorestore');
    });
  });

  describe('Backward compatibility', () => {
    it('should default to PostgreSQL driver when dbType is missing', async () => {
      const backupId = 'test-backup-legacy';
      const mockRecord = {
        backupId,
        jobId: 'job-5',
        jobName: 'Legacy Backup',
        // dbType is missing - should default to postgresql
        format: 'custom',
        compression: { type: 'none' },
        encrypted: false,
        storagePaths: [{ path: 's3://bucket/backup.dump', status: 'ok' }],
      };

      const target = {
        host: 'localhost',
        port: 5432,
        database: 'testdb',
        user: 'postgres',
        password: 'secret',
      };

      vi.mocked(BackupCatalog.getCatalogRecord).mockReturnValue(mockRecord);
      const mockBuffer = Buffer.from('mock backup data');
      vi.mocked(BackupStore.readFromTarget).mockResolvedValue(Readable.from(mockBuffer));
      vi.mocked(BackupCatalog.updateCatalogRecord).mockReturnValue(undefined);

      const { spawn } = await import('child_process');
      const mockProcess = {
        stdin: { write: vi.fn(), end: vi.fn() },
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn((event, callback) => {}) },
        on: vi.fn((event, callback) => {
          if (event === 'close') {
            setTimeout(() => callback(0), 10);
          }
        }),
      };
      vi.mocked(spawn).mockReturnValue(mockProcess);

      const result = await BackupEngine.startRestore(backupId, target, {}, null);
      expect(result.ok).toBe(true);

      await new Promise(resolve => setTimeout(resolve, 50));

      expect(spawn).toHaveBeenCalled();
      const spawnCalls = vi.mocked(spawn).mock.calls;
      // Should use pg_restore for custom format (PostgreSQL default)
      expect(spawnCalls[0][0]).toBe('pg_restore');
    });
  });
});
