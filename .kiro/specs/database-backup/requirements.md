# Requirements Document

## Introduction

This feature adds a full-featured PostgreSQL database backup subsystem to S3 Backup Studio. Unlike the existing database sync (which copies live data row-by-row between two running databases), this feature produces self-contained backup artifacts — comparable to what `pg_dump`/`pg_restore` provide — and stores them in S3 and/or the local filesystem. It covers the complete backup lifecycle: creation, storage, cataloging, verification, restoration, retention enforcement, and operational visibility through the existing web UI and notification channels.

## Glossary

- **Backup_Engine**: The server-side module responsible for orchestrating backup and restore operations.
- **Backup_Catalog**: The persistent store of backup metadata records (location, format, size, checksum, status, timestamps).
- **Backup_Job**: A named, persisted configuration that defines a backup source, storage destination, schedule, format, and retention policy.
- **Backup_Artifact**: The file or directory produced by a single backup run (e.g., a `.dump`, `.sql`, `.tar`, or directory tree).
- **Retention_Policy**: A set of rules that determine when old Backup_Artifacts are automatically deleted.
- **Restore_Job**: A one-time operation that reads a Backup_Artifact and applies it to a target PostgreSQL database.
- **Integrity_Check**: A verification pass that confirms a Backup_Artifact is structurally valid and matches its recorded checksum.
- **Scheduler**: The component that triggers Backup_Jobs on a cron or interval schedule.
- **Storage_Backend**: An abstraction over S3-compatible object storage or the local filesystem where Backup_Artifacts are written.
- **Encryption_Key**: A symmetric key (AES-256-GCM) used to encrypt a Backup_Artifact at rest.
- **Progress_Event**: A WebSocket message emitted by the Backup_Engine to report incremental backup or restore progress.
- **Notifier**: The existing `src/notifier.js` module that dispatches webhook and email notifications.
- **UI**: The single-page web application served from `public/`.

---

## Requirements

### Requirement 1: On-Demand Backup Execution

**User Story:** As an operator, I want to trigger a database backup immediately from the UI or API, so that I can capture a point-in-time snapshot before a risky deployment or data migration.

#### Acceptance Criteria

1. WHEN a valid Backup_Job configuration is submitted to `POST /api/backup/run`, THE Backup_Engine SHALL start a backup operation and return a unique `backupId` within 2 seconds.
2. WHEN a backup operation is in progress, THE Backup_Engine SHALL emit `backup:progress` Progress_Events over WebSocket at intervals no greater than 5 seconds, including `backupId`, `phase` (connecting, dumping, compressing, encrypting, uploading), `bytesWritten`, and `elapsedMs`.
3. WHEN a backup operation completes successfully, THE Backup_Engine SHALL write a record to the Backup_Catalog containing `backupId`, `jobId`, `source` (host, port, database, schema scope), `format`, `compressionLevel`, `encrypted`, `storagePath`, `sizeBytes`, `sha256Checksum`, `durationMs`, `status: "completed"`, `startedAt`, and `completedAt`.
4. IF a backup operation fails at any phase, THEN THE Backup_Engine SHALL set the Backup_Catalog record `status` to `"failed"`, record the `errorMessage`, and emit a `backup:failed` Progress_Event with the `backupId` and `errorMessage`.
5. WHILE a backup operation is running for a given `backupId`, THE Backup_Engine SHALL reject duplicate start requests for the same `backupId` with HTTP 409.

---

### Requirement 2: Scheduled Backup Jobs

**User Story:** As an operator, I want to configure recurring backup schedules using cron expressions or fixed intervals, so that backups run automatically without manual intervention.

#### Acceptance Criteria

1. THE Backup_Job SHALL accept a `schedule` field containing either a valid 5-field cron expression (e.g., `"0 2 * * *"`) or an interval in seconds (e.g., `3600`).
2. WHEN the Scheduler evaluates a Backup_Job whose `schedule` time has been reached, THE Scheduler SHALL trigger the Backup_Engine to start a backup and record the trigger source as `"scheduled"` in the Backup_Catalog.
3. WHILE a scheduled Backup_Job is executing, THE Scheduler SHALL not trigger a second concurrent execution of the same Backup_Job.
4. WHEN a Backup_Job `schedule` is updated via `PUT /api/backup/jobs/:id`, THE Scheduler SHALL apply the new schedule without requiring a server restart.
5. IF a scheduled backup fails, THEN THE Scheduler SHALL record the failure in the Backup_Catalog and continue scheduling future executions according to the configured schedule.

---

### Requirement 3: Backup Formats

**User Story:** As a database administrator, I want to choose the backup format (custom, plain SQL, directory, tar), so that I can match the format to my restore tooling and storage constraints.

#### Acceptance Criteria

1. THE Backup_Engine SHALL support four backup formats: `custom` (pg_dump `-Fc`), `plain` (pg_dump `-Fp`, plain SQL), `directory` (pg_dump `-Fd`), and `tar` (pg_dump `-Ft`).
2. WHEN `format` is set to `custom`, THE Backup_Engine SHALL produce a single binary file restorable with `pg_restore`.
3. WHEN `format` is set to `plain`, THE Backup_Engine SHALL produce a single `.sql` text file executable with `psql`.
4. WHEN `format` is set to `directory`, THE Backup_Engine SHALL produce a directory tree where each table's data is a separate file, compatible with parallel restore via `pg_restore -j`.
5. WHEN `format` is set to `tar`, THE Backup_Engine SHALL produce a single `.tar` archive restorable with `pg_restore`.
6. IF an unsupported `format` value is submitted, THEN THE Backup_Engine SHALL return HTTP 400 with a descriptive error listing the supported formats.

---

### Requirement 4: Selective Backup (Tables and Schemas)

**User Story:** As a database administrator, I want to back up specific tables or schemas rather than the entire database, so that I can reduce backup size and duration for large databases.

#### Acceptance Criteria

1. THE Backup_Job SHALL accept an `includeTables` array of table names and an `includeSchemas` array of schema names; when both are empty, THE Backup_Engine SHALL back up the entire database.
2. WHEN `includeTables` contains one or more table names, THE Backup_Engine SHALL pass a `--table` argument for each entry to the underlying dump process.
3. WHEN `includeSchemas` contains one or more schema names, THE Backup_Engine SHALL pass a `--schema` argument for each entry to the underlying dump process.
4. THE Backup_Job SHALL accept an `excludeTables` array and an `excludeSchemas` array; THE Backup_Engine SHALL pass corresponding `--exclude-table` and `--exclude-schema` arguments.
5. WHEN both `includeTables` and `excludeTables` are non-empty, THE Backup_Engine SHALL apply include filters first and exclude filters second, consistent with pg_dump precedence rules.
6. THE Backup_Catalog record SHALL store the resolved `includeTables`, `includeSchemas`, `excludeTables`, and `excludeSchemas` values used for the backup.

---

### Requirement 5: Compression

**User Story:** As an operator, I want to configure compression for backups, so that I can reduce storage costs and transfer time.

#### Acceptance Criteria

1. THE Backup_Job SHALL accept a `compression` field with values `none`, `gzip`, or `lz4`.
2. WHEN `compression` is `gzip`, THE Backup_Engine SHALL apply gzip compression at a configurable `compressionLevel` between 1 (fastest) and 9 (best), defaulting to 6.
3. WHEN `compression` is `lz4`, THE Backup_Engine SHALL apply lz4 compression for faster compression with lower CPU overhead than gzip.
4. WHEN `compression` is `none`, THE Backup_Engine SHALL write the Backup_Artifact without compression.
5. THE Backup_Catalog record SHALL store the `compression` type and `compressionLevel` used.
6. WHEN `format` is `custom`, THE Backup_Engine SHALL use pg_dump's built-in compression flag (`-Z`) rather than a separate compression step, to avoid double-compression.

---

### Requirement 6: Storage to S3 and Local Filesystem

**User Story:** As an operator, I want to store backup artifacts in S3 and/or on the local filesystem, so that I have flexibility in where backups are kept and can support air-gapped or cost-optimized storage strategies.

#### Acceptance Criteria

1. THE Backup_Job SHALL accept a `storageTargets` array containing one or more storage target objects, each with a `type` of `"s3"` or `"local"`.
2. WHEN a `storageTarget` has `type: "s3"`, THE Backup_Engine SHALL upload the completed Backup_Artifact to the specified S3 bucket and key prefix using the existing `src/s3Client.js` infrastructure.
3. WHEN a `storageTarget` has `type: "local"`, THE Backup_Engine SHALL write the Backup_Artifact to the specified `localPath` directory on the server filesystem.
4. WHEN `storageTargets` contains both `"s3"` and `"local"` entries, THE Backup_Engine SHALL write to both targets and record each storage path in the Backup_Catalog.
5. IF an S3 upload fails after 3 retry attempts, THEN THE Backup_Engine SHALL mark the S3 storage target as `"failed"` in the Backup_Catalog while preserving any successfully written local copy.
6. THE Backup_Engine SHALL organize Backup_Artifacts within the storage target using the path pattern `{prefix}/{jobName}/{YYYY-MM-DD}/{backupId}.{ext}`.

---

### Requirement 7: Backup Catalog and History

**User Story:** As an operator, I want a searchable catalog of all backup runs with metadata, so that I can audit backup history, find a specific restore point, and monitor backup health.

#### Acceptance Criteria

1. THE Backup_Catalog SHALL persist all backup records to `data/backup-catalog.json` and survive server restarts.
2. THE Backup_Engine SHALL expose `GET /api/backup/catalog` returning all catalog records sorted by `startedAt` descending, with secrets (passwords, access keys) redacted.
3. THE Backup_Engine SHALL expose `GET /api/backup/catalog/:backupId` returning the full metadata for a single backup record.
4. THE Backup_Catalog record SHALL include: `backupId`, `jobId`, `jobName`, `triggerSource` (`"manual"` or `"scheduled"`), `source` (host, port, database), `format`, `compression`, `encrypted`, `storagePaths`, `sizeBytes`, `sha256Checksum`, `durationMs`, `status` (`"running"`, `"completed"`, `"failed"`, `"verified"`, `"corrupted"`), `startedAt`, `completedAt`, `errorMessage`, `includeTables`, `includeSchemas`.
5. WHEN the Backup_Catalog contains more than 1000 records, THE Backup_Engine SHALL retain the 1000 most recent records and remove older entries from the JSON file.
6. THE UI SHALL display the Backup_Catalog in a dedicated "Backups" tab showing `jobName`, `startedAt`, `format`, `sizeBytes`, `status`, and available actions (Restore, Verify, Delete).

---

### Requirement 8: Restore from Backup

**User Story:** As a database administrator, I want to restore a database from a catalog entry, so that I can recover from data loss or roll back to a known-good state.

#### Acceptance Criteria

1. WHEN `POST /api/backup/restore` is called with a valid `backupId` and a `target` database connection, THE Backup_Engine SHALL download the Backup_Artifact from its recorded storage path and begin the restore operation.
2. WHEN restoring a `custom`, `directory`, or `tar` format backup, THE Backup_Engine SHALL invoke `pg_restore` with the appropriate flags against the target database.
3. WHEN restoring a `plain` format backup, THE Backup_Engine SHALL pipe the SQL file to `psql` against the target database.
4. THE Backup_Engine SHALL accept a `restoreOptions` object with `cleanBeforeRestore` (boolean, default `false`) and `createDatabase` (boolean, default `false`) flags, passing `--clean` and `--create` to `pg_restore` respectively.
5. WHEN a restore operation is in progress, THE Backup_Engine SHALL emit `restore:progress` Progress_Events over WebSocket at intervals no greater than 5 seconds, including `backupId`, `phase` (downloading, restoring, verifying), and `elapsedMs`.
6. WHEN a restore operation completes, THE Backup_Engine SHALL update the Backup_Catalog record with `lastRestoredAt` and `lastRestoreTarget` (host, database).
7. IF a restore operation fails, THEN THE Backup_Engine SHALL emit a `restore:failed` Progress_Event with the `backupId` and `errorMessage`, and record the failure in the Backup_Catalog.
8. WHILE a restore operation is running for a given `backupId`, THE Backup_Engine SHALL reject a second concurrent restore request for the same `backupId` with HTTP 409.

---

### Requirement 9: Backup Verification and Integrity Check

**User Story:** As an operator, I want to verify that a backup artifact is intact and uncorrupted, so that I can trust it will be restorable when needed.

#### Acceptance Criteria

1. WHEN `POST /api/backup/verify/:backupId` is called, THE Backup_Engine SHALL download the Backup_Artifact and compute its SHA-256 checksum.
2. WHEN the computed checksum matches the `sha256Checksum` stored in the Backup_Catalog, THE Backup_Engine SHALL update the record `status` to `"verified"` and record `lastVerifiedAt`.
3. WHEN the computed checksum does not match the stored `sha256Checksum`, THE Backup_Engine SHALL update the record `status` to `"corrupted"` and emit a `backup:corrupted` event over WebSocket with the `backupId`.
4. WHEN `format` is `custom` or `directory`, THE Backup_Engine SHALL additionally invoke `pg_restore --list` on the artifact to confirm structural validity beyond checksum matching.
5. IF the Backup_Artifact cannot be downloaded or read during verification, THEN THE Backup_Engine SHALL set the record `status` to `"corrupted"` and record the `errorMessage`.
6. THE Backup_Engine SHALL expose `GET /api/backup/verify/:backupId` to retrieve the current verification status without triggering a new verification pass.

---

### Requirement 10: Retention Policies

**User Story:** As an operator, I want to define retention policies that automatically delete old backups, so that storage costs are controlled without manual cleanup.

#### Acceptance Criteria

1. THE Backup_Job SHALL accept a `retentionPolicy` object with the following optional fields: `keepLast` (integer, keep the N most recent successful backups), `keepDailyFor` (integer days), `keepWeeklyFor` (integer weeks), `keepMonthlyFor` (integer months).
2. WHEN a backup operation completes successfully, THE Backup_Engine SHALL evaluate the `retentionPolicy` for the Backup_Job and identify Backup_Artifacts that no longer satisfy any retention rule.
3. WHEN a Backup_Artifact is identified for deletion by the retention policy, THE Backup_Engine SHALL delete the artifact from all recorded storage paths and update the Backup_Catalog record `status` to `"deleted"`.
4. IF deletion of a Backup_Artifact from S3 fails, THEN THE Backup_Engine SHALL log the error and retain the Backup_Catalog record with `status: "delete_failed"` for operator review.
5. WHEN `keepLast` is set to N, THE Backup_Engine SHALL retain exactly the N most recent `"completed"` or `"verified"` backups for the Backup_Job, regardless of age.
6. THE Backup_Engine SHALL expose `POST /api/backup/jobs/:id/apply-retention` to trigger retention evaluation on demand without running a new backup.

---

### Requirement 11: Progress Tracking

**User Story:** As an operator, I want real-time progress updates during backup and restore operations, so that I can monitor long-running operations and estimate completion time.

#### Acceptance Criteria

1. THE Backup_Engine SHALL emit `backup:started` over WebSocket when a backup begins, including `backupId`, `jobName`, `format`, `source`, and `estimatedSizeBytes` (if determinable).
2. THE Backup_Engine SHALL emit `backup:progress` over WebSocket at intervals no greater than 5 seconds during active backup, including `backupId`, `phase`, `bytesWritten`, `elapsedMs`, and `estimatedRemainingMs` (when calculable).
3. THE Backup_Engine SHALL emit `backup:completed` over WebSocket when a backup finishes, including `backupId`, `sizeBytes`, `durationMs`, and `storagePaths`.
4. THE Backup_Engine SHALL emit `restore:started`, `restore:progress`, and `restore:completed` WebSocket events with equivalent fields for restore operations.
5. THE UI SHALL display an active backup/restore progress panel showing the current phase, a progress bar (where total size is known), elapsed time, and estimated remaining time.
6. WHEN no backup or restore is active, THE UI SHALL display the last completed operation's summary in the progress panel.

---

### Requirement 12: Notifications on Completion and Failure

**User Story:** As an operator, I want to receive webhook and email notifications when backups complete or fail, so that I am alerted to backup health without monitoring the UI.

#### Acceptance Criteria

1. THE Backup_Job SHALL accept a `notifications` object with the same schema as the existing S3 sync notification configuration (`webhook.url`, `webhook.onComplete`, `webhook.onFailure`, `email.*`).
2. WHEN a backup operation completes successfully and `notifications.webhook.onComplete` is `true`, THE Notifier SHALL send a webhook payload containing `event: "backup_completed"`, `backupId`, `jobName`, `source`, `storagePaths`, `sizeBytes`, `durationMs`, and `timestamp`.
3. WHEN a backup operation fails and `notifications.webhook.onFailure` is `true`, THE Notifier SHALL send a webhook payload containing `event: "backup_failed"`, `backupId`, `jobName`, `source`, `errorMessage`, and `timestamp`.
4. WHEN a backup operation completes and email notification is configured, THE Notifier SHALL send an HTML email with the same fields as the webhook payload, formatted consistently with the existing sync completion email template.
5. WHEN a Backup_Artifact is marked `"corrupted"` by an integrity check, THE Notifier SHALL send a notification (webhook and/or email, per configuration) with `event: "backup_corrupted"` regardless of the `onComplete`/`onFailure` flags.
6. THE Backup_Engine SHALL expose `POST /api/backup/test-notification` to send a test notification using a Backup_Job's notification configuration without running a backup.

---

### Requirement 13: Encryption at Rest

**User Story:** As a security-conscious operator, I want backup artifacts to be encrypted before being written to storage, so that sensitive database contents are protected if the storage medium is compromised.

#### Acceptance Criteria

1. THE Backup_Job SHALL accept an `encryption` object with `enabled` (boolean) and `passphrase` (string) fields.
2. WHEN `encryption.enabled` is `true`, THE Backup_Engine SHALL encrypt the Backup_Artifact using AES-256-GCM with a key derived from `encryption.passphrase` via PBKDF2 (100,000 iterations, SHA-256) before writing to any Storage_Backend.
3. THE Backup_Engine SHALL prepend a fixed-size header to the encrypted artifact containing the PBKDF2 salt (16 bytes), the AES-GCM IV (12 bytes), and a format version byte, to enable decryption without external metadata.
4. WHEN `encryption.enabled` is `true`, THE Backup_Catalog record SHALL store `encrypted: true` but SHALL NOT store the passphrase or derived key.
5. WHEN `POST /api/backup/restore` is called for an encrypted backup, THE Backup_Engine SHALL require the `passphrase` field in the request body and SHALL return HTTP 400 if it is absent.
6. IF decryption fails due to an incorrect passphrase or corrupted header, THEN THE Backup_Engine SHALL return a `restore:failed` event with `errorMessage: "Decryption failed — incorrect passphrase or corrupted artifact"` and SHALL NOT write any partial data to the target database.
7. THE Backup_Engine SHALL expose `POST /api/backup/jobs/:id/rotate-key` accepting `currentPassphrase` and `newPassphrase`, which SHALL re-encrypt all `"completed"` or `"verified"` artifacts for the job with the new key.

---

### Requirement 14: Backup Job Management (CRUD)

**User Story:** As an operator, I want to create, read, update, and delete backup job configurations, so that I can manage multiple databases and backup strategies from a single interface.

#### Acceptance Criteria

1. THE Backup_Engine SHALL expose `POST /api/backup/jobs` to create a Backup_Job, returning the created job with a generated `id`.
2. THE Backup_Engine SHALL expose `GET /api/backup/jobs` to list all Backup_Jobs with secrets (passwords, access keys, passphrases) redacted.
3. THE Backup_Engine SHALL expose `GET /api/backup/jobs/:id` to retrieve a single Backup_Job including secrets (for use by the UI when loading a job for editing).
4. THE Backup_Engine SHALL expose `PUT /api/backup/jobs/:id` to update a Backup_Job; THE Scheduler SHALL apply any schedule changes immediately.
5. THE Backup_Engine SHALL expose `DELETE /api/backup/jobs/:id` to delete a Backup_Job; THE Backup_Engine SHALL NOT delete existing Backup_Artifacts or Backup_Catalog records when a job is deleted.
6. THE Backup_Engine SHALL persist Backup_Jobs to `data/backup-jobs.json` using the same atomic write pattern (write-to-temp, rename) as `src/jobStore.js`.
7. WHEN a required field (`source.host`, `source.database`, `source.user`, `source.password`, `storageTargets`) is missing from a create or update request, THE Backup_Engine SHALL return HTTP 400 with a descriptive error message identifying the missing field.

---

### Requirement 15: UI — Backup Tab

**User Story:** As an operator, I want a dedicated Backup section in the web UI, so that I can manage backup jobs, view the catalog, trigger operations, and monitor progress without using the API directly.

#### Acceptance Criteria

1. THE UI SHALL add a "Backup" tab to the top navigation alongside the existing S3, Database, and Cluster tabs.
2. WHEN the Backup tab is active, THE UI SHALL display three sub-sections: "Jobs" (Backup_Job list and editor), "Catalog" (Backup_Catalog table), and "Run" (active backup/restore progress).
3. THE UI SHALL provide a form to create and edit Backup_Jobs covering all fields: source connection, storage targets, format, compression, selective tables/schemas, schedule, retention policy, encryption, and notifications.
4. THE UI SHALL display the Backup_Catalog as a sortable table with columns: Job Name, Started At, Format, Size, Duration, Status, and action buttons (Restore, Verify, Delete).
5. WHEN the "Restore" action is clicked for a catalog entry, THE UI SHALL display a modal prompting for the target database connection and restore options (`cleanBeforeRestore`, `createDatabase`), and for encrypted backups, a passphrase field.
6. WHEN the "Verify" action is clicked for a catalog entry, THE UI SHALL call `POST /api/backup/verify/:backupId` and update the row status in real time via the WebSocket `backup:verified` or `backup:corrupted` event.
7. THE UI SHALL display a real-time progress panel that updates via WebSocket events during active backup and restore operations.
