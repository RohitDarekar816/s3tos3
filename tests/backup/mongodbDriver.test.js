/**
 * mongodbDriver.test.js
 *
 * Unit tests for the MongoDB database driver.
 */

import { describe, it, expect } from 'vitest';
import * as mongodbDriver from '../../src/dbDrivers/mongodb.js';

describe('MongoDB Driver', () => {
  describe('buildBackupArgs', () => {
    it('should include --uri flag with connection URI', () => {
      const jobConfig = {
        source: {
          connectionUri: 'mongodb://user:pass@host:27017/mydb',
        },
        format: 'archive',
      };

      const args = mongodbDriver.buildBackupArgs(jobConfig);

      expect(args).toContain('--uri');
      expect(args).toContain('mongodb://user:pass@host:27017/mydb');
    });

    it('should include --archive flag for archive format', () => {
      const jobConfig = {
        source: {
          connectionUri: 'mongodb://localhost:27017/testdb',
        },
        format: 'archive',
      };

      const args = mongodbDriver.buildBackupArgs(jobConfig);

      expect(args).toContain('--archive');
    });

    it('should not include --archive flag for directory format', () => {
      const jobConfig = {
        source: {
          connectionUri: 'mongodb://localhost:27017/testdb',
        },
        format: 'directory',
      };

      const args = mongodbDriver.buildBackupArgs(jobConfig);

      expect(args).not.toContain('--archive');
    });

    it('should include --gzip flag when compression is enabled', () => {
      const jobConfig = {
        source: {
          connectionUri: 'mongodb://localhost:27017/testdb',
        },
        format: 'archive',
        compression: { type: 'gzip', level: 6 },
      };

      const args = mongodbDriver.buildBackupArgs(jobConfig);

      expect(args).toContain('--gzip');
    });

    it('should not include --gzip flag when compression is disabled', () => {
      const jobConfig = {
        source: {
          connectionUri: 'mongodb://localhost:27017/testdb',
        },
        format: 'archive',
        compression: { type: 'none' },
      };

      const args = mongodbDriver.buildBackupArgs(jobConfig);

      expect(args).not.toContain('--gzip');
    });

    it('should default to archive format when format is not specified', () => {
      const jobConfig = {
        source: {
          connectionUri: 'mongodb://localhost:27017/testdb',
        },
      };

      const args = mongodbDriver.buildBackupArgs(jobConfig);

      expect(args).toContain('--archive');
    });
  });

  describe('buildRestoreArgs', () => {
    it('should include --uri flag with connection URI', () => {
      const target = {
        connectionUri: 'mongodb://user:pass@restore-host:27017/restoredb',
      };

      const restoreOptions = {};
      const record = { format: 'archive' };

      const args = mongodbDriver.buildRestoreArgs(target, restoreOptions, record);

      expect(args).toContain('--uri');
      expect(args).toContain('mongodb://user:pass@restore-host:27017/restoredb');
    });

    it('should include --archive flag for archive format', () => {
      const target = {
        connectionUri: 'mongodb://localhost:27017/testdb',
      };

      const record = { format: 'archive' };

      const args = mongodbDriver.buildRestoreArgs(target, {}, record);

      expect(args).toContain('--archive');
    });

    it('should not include --archive flag for directory format', () => {
      const target = {
        connectionUri: 'mongodb://localhost:27017/testdb',
      };

      const record = { format: 'directory' };

      const args = mongodbDriver.buildRestoreArgs(target, {}, record);

      expect(args).not.toContain('--archive');
    });

    it('should include --gzip flag when backup was compressed', () => {
      const target = {
        connectionUri: 'mongodb://localhost:27017/testdb',
      };

      const record = {
        format: 'archive',
        compression: { type: 'gzip', level: 6 },
      };

      const args = mongodbDriver.buildRestoreArgs(target, {}, record);

      expect(args).toContain('--gzip');
    });

    it('should not include --gzip flag when backup was not compressed', () => {
      const target = {
        connectionUri: 'mongodb://localhost:27017/testdb',
      };

      const record = {
        format: 'archive',
        compression: { type: 'none' },
      };

      const args = mongodbDriver.buildRestoreArgs(target, {}, record);

      expect(args).not.toContain('--gzip');
    });

    it('should default to archive format when format is not specified in record', () => {
      const target = {
        connectionUri: 'mongodb://localhost:27017/testdb',
      };

      const record = {};

      const args = mongodbDriver.buildRestoreArgs(target, {}, record);

      expect(args).toContain('--archive');
    });
  });

  describe('getDefaultPort', () => {
    it('should return 27017', () => {
      expect(mongodbDriver.getDefaultPort()).toBe(27017);
    });
  });

  describe('getSupportedFormats', () => {
    it('should return "archive" and "directory" formats', () => {
      const formats = mongodbDriver.getSupportedFormats();
      expect(formats).toEqual(['archive', 'directory']);
    });
  });

  describe('getArtifactExtension', () => {
    it('should return "bson" for archive format without compression', () => {
      const ext = mongodbDriver.getArtifactExtension('archive', null);
      expect(ext).toBe('bson');
    });

    it('should return "bson" for archive format with compression', () => {
      const ext = mongodbDriver.getArtifactExtension('archive', { type: 'gzip', level: 6 });
      expect(ext).toBe('bson');
    });

    it('should return "tar.gz" for directory format with gzip compression', () => {
      const ext = mongodbDriver.getArtifactExtension('directory', { type: 'gzip', level: 6 });
      expect(ext).toBe('tar.gz');
    });

    it('should return "bson" for directory format without compression', () => {
      const ext = mongodbDriver.getArtifactExtension('directory', null);
      expect(ext).toBe('bson');
    });

    it('should return "bson" for directory format with compression type "none"', () => {
      const ext = mongodbDriver.getArtifactExtension('directory', { type: 'none' });
      expect(ext).toBe('bson');
    });
  });

  describe('testConnection', () => {
    it('should be a function that returns a Promise', () => {
      expect(typeof mongodbDriver.testConnection).toBe('function');
      const result = mongodbDriver.testConnection({
        connectionUri: 'mongodb://localhost:27017/testdb',
      });
      expect(result).toBeInstanceOf(Promise);
    });
  });
});
