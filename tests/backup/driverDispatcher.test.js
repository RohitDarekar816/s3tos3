/**
 * driverDispatcher.test.js
 *
 * Unit tests for the driver dispatcher in backupEngine.
 * Tests the getDriver function and DRIVERS mapping.
 */

import { describe, it, expect } from 'vitest';

// We need to test the internal getDriver function, but it's not exported.
// For now, we'll test indirectly by importing the drivers and verifying they exist.
import * as postgresqlDriver from '../../src/dbDrivers/postgresql.js';
import * as mysqlDriver from '../../src/dbDrivers/mysql.js';
import * as mongodbDriver from '../../src/dbDrivers/mongodb.js';

describe('Driver Dispatcher', () => {
  describe('Driver modules', () => {
    it('should have postgresql driver with required functions', () => {
      expect(typeof postgresqlDriver.buildBackupArgs).toBe('function');
      expect(typeof postgresqlDriver.buildRestoreArgs).toBe('function');
      expect(typeof postgresqlDriver.testConnection).toBe('function');
      expect(typeof postgresqlDriver.getDefaultPort).toBe('function');
      expect(typeof postgresqlDriver.getSupportedFormats).toBe('function');
      expect(typeof postgresqlDriver.getArtifactExtension).toBe('function');
    });

    it('should have mysql driver with required functions', () => {
      expect(typeof mysqlDriver.buildBackupArgs).toBe('function');
      expect(typeof mysqlDriver.buildRestoreArgs).toBe('function');
      expect(typeof mysqlDriver.testConnection).toBe('function');
      expect(typeof mysqlDriver.getDefaultPort).toBe('function');
      expect(typeof mysqlDriver.getSupportedFormats).toBe('function');
      expect(typeof mysqlDriver.getArtifactExtension).toBe('function');
    });

    it('should have mongodb driver with required functions', () => {
      expect(typeof mongodbDriver.buildBackupArgs).toBe('function');
      expect(typeof mongodbDriver.buildRestoreArgs).toBe('function');
      expect(typeof mongodbDriver.testConnection).toBe('function');
      expect(typeof mongodbDriver.getDefaultPort).toBe('function');
      expect(typeof mongodbDriver.getSupportedFormats).toBe('function');
      expect(typeof mongodbDriver.getArtifactExtension).toBe('function');
    });
  });

  describe('Driver interface consistency', () => {
    it('should have consistent default ports', () => {
      expect(postgresqlDriver.getDefaultPort()).toBe(5432);
      expect(mysqlDriver.getDefaultPort()).toBe(3306);
      expect(mongodbDriver.getDefaultPort()).toBe(27017);
    });

    it('should have valid supported formats', () => {
      const pgFormats = postgresqlDriver.getSupportedFormats();
      expect(pgFormats).toContain('custom');
      expect(pgFormats).toContain('plain');
      expect(pgFormats).toContain('directory');
      expect(pgFormats).toContain('tar');

      const mysqlFormats = mysqlDriver.getSupportedFormats();
      expect(mysqlFormats).toContain('sql');

      const mongoFormats = mongodbDriver.getSupportedFormats();
      expect(mongoFormats).toContain('archive');
      expect(mongoFormats).toContain('directory');
    });
  });
});
