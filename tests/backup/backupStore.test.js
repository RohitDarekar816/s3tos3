import { describe, it, expect } from 'vitest';
import { buildArtifactPath } from '../../src/backupStore.js';

describe('buildArtifactPath', () => {
  it('returns the correct path pattern for a Date object', () => {
    const date = new Date('2024-03-15T10:30:00Z');
    const result = buildArtifactPath('backups', 'my-job', date, 'abc-123', 'dump');
    expect(result).toBe('backups/my-job/2024-03-15/abc-123.dump');
  });

  it('returns the correct path pattern for an ISO date string', () => {
    const result = buildArtifactPath('backups', 'prod-db', '2025-01-01T00:00:00Z', 'xyz-456', 'sql');
    expect(result).toBe('backups/prod-db/2025-01-01/xyz-456.sql');
  });

  it('uses UTC date components (not local time)', () => {
    // 2024-06-30T23:00:00Z — in UTC+2 this would be 2024-07-01, but UTC date is 2024-06-30
    const date = new Date('2024-06-30T23:00:00Z');
    const result = buildArtifactPath('prefix', 'job', date, 'id1', 'tar');
    expect(result).toBe('prefix/job/2024-06-30/id1.tar');
  });

  it('zero-pads month and day', () => {
    const date = new Date('2024-01-05T00:00:00Z');
    const result = buildArtifactPath('p', 'j', date, 'id', 'dump');
    expect(result).toBe('p/j/2024-01-05/id.dump');
  });

  it('handles nested prefix paths', () => {
    const date = new Date('2024-12-31T00:00:00Z');
    const result = buildArtifactPath('org/team/backups', 'weekly-job', date, 'backup-id', 'custom');
    expect(result).toBe('org/team/backups/weekly-job/2024-12-31/backup-id.custom');
  });

  it('handles job names with spaces and special characters', () => {
    const date = new Date('2024-07-04T00:00:00Z');
    const result = buildArtifactPath('backups', 'my job (prod)', date, 'id-99', 'sql');
    expect(result).toBe('backups/my job (prod)/2024-07-04/id-99.sql');
  });

  it('matches the pattern {prefix}/{jobName}/{YYYY-MM-DD}/{backupId}.{ext}', () => {
    const date = new Date('2024-08-20T12:00:00Z');
    const prefix = 'myprefix';
    const jobName = 'testjob';
    const backupId = 'test-backup-id';
    const ext = 'dump';

    const result = buildArtifactPath(prefix, jobName, date, backupId, ext);

    // Verify each component appears in the right position
    const parts = result.split('/');
    expect(parts[0]).toBe(prefix);
    expect(parts[1]).toBe(jobName);
    expect(parts[2]).toBe('2024-08-20');
    expect(parts[3]).toBe(`${backupId}.${ext}`);
  });
});
