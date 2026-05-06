/**
 * mysqlDriver.test.js
 *
 * Unit tests for the MySQL/MariaDB database driver.
 */

import { describe, it, expect } from 'vitest';
import * as mysqlDriver from '../../src/dbDrivers/mysql.js';

describe('MySQL Driver', () => {
  describe('buildBackupArgs', () => {
    it('should include all required mysqldump flags', () => {
      const jobConfig = {
        source: {
          host: 'db.example.com',
          port: 3306,
          database: 'mydb',
          user: 'root',
          password: 'secret',
        },
      };

      const args = mysqlDriver.buildBackupArgs(jobConfig);

      expect(args).toContain('--host');
      expect(args).toContain('db.example.com');
      expect(args).toContain('--port');
      expect(args).toContain('3306');
      expect(args).toContain('--user');
      expect(args).toContain('root');
      expect(args).toContain('--databases');
      expect(args).toContain('mydb');
      expect(args).toContain('--single-transaction');
    });

    it('should not include password in args', () => {
      const jobConfig = {
        source: {
          host: 'localhost',
          port: 3306,
          database: 'testdb',
          user: 'admin',
          password: 'supersecret',
        },
      };

      const args = mysqlDriver.buildBackupArgs(jobConfig);
      const argsString = args.join(' ');

      expect(argsString).not.toContain('supersecret');
      expect(argsString).not.toContain('password');
    });

    it('should use default port 3306 when port is not specified', () => {
      const jobConfig = {
        source: {
          host: 'localhost',
          database: 'testdb',
          user: 'admin',
          password: 'secret',
        },
      };

      const args = mysqlDriver.buildBackupArgs(jobConfig);

      expect(args).toContain('--port');
      expect(args).toContain('3306');
    });
  });

  describe('buildRestoreArgs', () => {
    it('should include all required mysql CLI flags', () => {
      const target = {
        host: 'restore.example.com',
        port: 3307,
        database: 'restored_db',
        user: 'restore_user',
        password: 'restore_pass',
      };

      const restoreOptions = {};
      const record = { format: 'sql' };

      const args = mysqlDriver.buildRestoreArgs(target, restoreOptions, record);

      expect(args).toContain('--host');
      expect(args).toContain('restore.example.com');
      expect(args).toContain('--port');
      expect(args).toContain('3307');
      expect(args).toContain('--user');
      expect(args).toContain('restore_user');
    });

    it('should not include password in args', () => {
      const target = {
        host: 'localhost',
        port: 3306,
        database: 'testdb',
        user: 'admin',
        password: 'supersecret',
      };

      const args = mysqlDriver.buildRestoreArgs(target, {}, {});
      const argsString = args.join(' ');

      expect(argsString).not.toContain('supersecret');
      expect(argsString).not.toContain('password');
    });

    it('should use default user "root" when user is not specified', () => {
      const target = {
        host: 'localhost',
        port: 3306,
        database: 'testdb',
        password: 'secret',
      };

      const args = mysqlDriver.buildRestoreArgs(target, {}, {});

      expect(args).toContain('--user');
      expect(args).toContain('root');
    });
  });

  describe('getDefaultPort', () => {
    it('should return 3306', () => {
      expect(mysqlDriver.getDefaultPort()).toBe(3306);
    });
  });

  describe('getSupportedFormats', () => {
    it('should return only "sql" format', () => {
      const formats = mysqlDriver.getSupportedFormats();
      expect(formats).toEqual(['sql']);
    });
  });

  describe('getArtifactExtension', () => {
    it('should return "sql" for no compression', () => {
      const ext = mysqlDriver.getArtifactExtension('sql', null);
      expect(ext).toBe('sql');
    });

    it('should return "sql" for compression type "none"', () => {
      const ext = mysqlDriver.getArtifactExtension('sql', { type: 'none' });
      expect(ext).toBe('sql');
    });

    it('should return "sql.gz" for gzip compression', () => {
      const ext = mysqlDriver.getArtifactExtension('sql', { type: 'gzip', level: 6 });
      expect(ext).toBe('sql.gz');
    });
  });

  describe('testConnection', () => {
    it('should be a function that returns a Promise', () => {
      expect(typeof mysqlDriver.testConnection).toBe('function');
      const result = mysqlDriver.testConnection({
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: 'test',
      });
      expect(result).toBeInstanceOf(Promise);
    });
  });
});
