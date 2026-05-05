# Implementation Plan: Database Backup

## Overview

Implement a full PostgreSQL backup subsystem for S3 Backup Studio. The work is sequenced in four layers: (1) foundational data/storage modules, (2) the core backup engine and scheduler, (3) the Express API routes wired into `server.js`, and (4) the frontend Backup tab in `public/index.html` and `public/app.js`. Property-based tests (fast-check) are placed close to the logic they validate so regressions are caught early.

## Tasks

- [x] 1. Install fast-check and set up the test environment
  - Add `fast-check` as a dev dependency in `package.json`
  - Confirm `vitest` is already configured (it is — `"test": "vitest run"`)
  - Create `tests/backup/` directory structure for all backup-related tests
  - _Requirements: (infrastructure for all property tests)_

- [x] 2. Implement `BackupJobStore` (`src/backupJobStore.js`)
  - [x] 2.1 Create `src/backupJobStore.js` mirroring the pattern of `src/jobStore.js`
    - Persist to `data/backup-jobs.json` using atomic write-to-temp-then-rename
    - Implement `listBackupJobs()` with secrets redacted (`password`, `secretAccessKey`, `passphrase` → `"***"`)
    - Implement `getBackupJob(id)` returning the full record including secrets
    - Implement `createBackupJob(data)` generating a UUID `id`, `createdAt`, and `updatedAt`
    - Implement `updateBackupJob(id, data)` updating `updatedAt`
    - Implement `deleteBackupJob(id)` returning boolean
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6_

  - [ ]* 2.2 Write property test for BackupJob CRUD round-trip
    - **Property 18: Backup job CRUD round-trip**
    - **Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.5**
    - Generate random valid `BackupJob` configs with fast-check; create → read → update → delete; assert field equality at each step

  - [ ]* 2.3 Write property test for secret redaction in list
    - **Property 10: Catalog list redacts secrets**
    - **Validates: Requirements 14.2, 7.2**
    - Generate jobs with arbitrary passphrase/password/secretAccessKey values; assert `listBackupJobs()` never returns those values

  - [ ]* 2.4 Write property test for missing required fields → HTTP 400
    - **Property 19: Missing required fields produce HTTP 400**
    - **Validates: Requirements 14.7**
    - Generate configs with each required field (`source.host`, `source.database`, `source.user`, `source.password`, `storageTargets`) removed; assert validation rejects them

- [x] 3. Implement `BackupCatalog` (`src/backupCatalog.js`)
  - [x] 3.1 Create `src/backupCatalog.js`
    - Persist to `data/backup-catalog.json` using atomic write-to-temp-then-rename
    - On load failure, rename corrupted file to `backup-catalog.json.bak.{timestamp}` and start empty
    - Implement `loadCatalog()`, `getCatalogRecord(backupId)`, `createCatalogRecord(record)`, `updateCatalogRecord(backupId, updates)`
    - Implement `listCatalog()` returning records sorted by `startedAt` descending with secrets redacted
    - Implement `pruneCatalog()` enforcing the 1000-record limit (keep most recent)
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [ ]* 3.2 Write property test for catalog persistence round-trip
    - **Property 9: Catalog persistence round-trip**
    - **Validates: Requirements 7.1, 7.3**
    - Generate random sets of `BackupCatalogRecord` objects; write to catalog; reload; assert deep equality and sort order

  - [ ]* 3.3 Write property test for catalog record completeness
    - **Property 2: Completed catalog records contain all required fields**
    - **Validates: Requirements 1.3, 7.4**
    - Generate random completed backup records; assert all required fields are non-null

  - [ ]* 3.4 Write property test for failed backup recording
    - **Property 3: Failed backups are recorded with error information**
    - **Validates: Requirements 1.4**
    - Generate random error messages and phases; create failed catalog records; assert `status: "failed"` and non-empty `errorMessage`

  - [ ]* 3.5 Write property test for catalog 1000-record limit
    - **Property 11: Catalog enforces 1000-record limit**
    - **Validates: Requirements 7.5**
    - Generate N > 1000 records with varying `startedAt` timestamps; call `pruneCatalog()`; assert exactly 1000 most-recent records remain

  - [ ]* 3.6 Write property test for secret redaction in catalog list
    - **Property 10: Catalog list redacts secrets**
    - **Validates: Requirements 7.2**
    - Generate catalog records with password/passphrase/secretAccessKey values; assert `listCatalog()` never exposes them

- [x] 4. Implement `BackupStore` (`src/backupStore.js`)
  - [x] 4.1 Create `src/backupStore.js`
    - Implement `buildArtifactPath(prefix, jobName, date, backupId, ext)` returning `{prefix}/{jobName}/{YYYY-MM-DD}/{backupId}.{ext}`
    - Implement `writeToTargets(targets, sourceStream, artifactName, encryption)` writing to S3 (via `s3Client.js`) and/or local filesystem
    - Implement `readFromTarget(storagePath, encryption)` returning a readable stream (decrypted if encrypted)
    - Implement `deleteFromTarget(storagePath)` returning `{ ok, error }`
    - For S3 targets, use `@aws-sdk/lib-storage` Upload for streaming multipart upload
    - For local targets, pipe to `fs.createWriteStream`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [ ]* 4.2 Write property test for artifact path pattern
    - **Property 8: Artifact storage path matches the required pattern**
    - **Validates: Requirements 6.6**
    - Generate random job names, dates, backupIds, and extensions; assert `buildArtifactPath` output matches `{prefix}/{jobName}/{YYYY-MM-DD}/{backupId}.{ext}`

- [x] 5. Implement encryption/decryption transforms (`src/backupCrypto.js`)
  - [x] 5.1 Create `src/backupCrypto.js`
    - Implement `createEncryptStream(passphrase)` returning a Transform stream
    - Write header: version byte `0x01` (offset 0), 16-byte PBKDF2 salt (offset 1), 12-byte AES-GCM IV (offset 17)
    - Use `crypto.pbkdf2Sync(passphrase, salt, 100_000, 32, 'sha256')` for key derivation
    - Use `crypto.createCipheriv('aes-256-gcm', key, iv)` for encryption
    - Append 16-byte auth tag after `cipher.final()`
    - Implement `createDecryptStream(passphrase)` reading the 45-byte header, deriving the key, and creating a `createDecipheriv` stream
    - On GCM auth tag mismatch, emit an error event — do not write partial data
    - _Requirements: 13.2, 13.3, 13.4_

  - [ ]* 5.2 Write property test for encryption round-trip
    - **Property 15: Encryption round-trip preserves plaintext**
    - **Validates: Requirements 13.2**
    - Generate random passphrases and arbitrary byte sequences; encrypt then decrypt; assert output is byte-for-byte identical to input

  - [ ]* 5.3 Write property test for encrypted artifact header structure
    - **Property 16: Encrypted artifact header has correct structure**
    - **Validates: Requirements 13.3**
    - Generate random data; encrypt; read first 29 bytes; assert version byte `0x01` at offset 0, 16-byte salt at offset 1, 12-byte IV at offset 17

  - [ ]* 5.4 Write property test for passphrase never in catalog
    - **Property 17: Catalog never stores passphrase**
    - **Validates: Requirements 13.4**
    - Generate random passphrases; create catalog records for encrypted backups; assert no field in the record contains the passphrase value

- [x] 6. Checkpoint — Ensure all foundational module tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement `BackupEngine` (`src/backupEngine.js`)
  - [x] 7.1 Create `src/backupEngine.js` with `initBackupEngine(io)` and internal state maps
    - `_activeBackups: Map<backupId, AbortController>`
    - `_activeRestores: Map<backupId, AbortController>`
    - Export `getActiveBackups()` and `getActiveRestores()` returning Map snapshots
    - _Requirements: 1.5, 8.8_

  - [x] 7.2 Implement `startBackup(jobConfig)` in `BackupEngine`
    - Generate a UUID `backupId`; reject duplicate `backupId` with HTTP 409
    - Create a `BackupCatalogRecord` with `status: "running"` via `BackupCatalog`
    - Emit `backup:started` WebSocket event
    - Build pg_dump arguments from `format`, `includeTables`, `excludeTables`, `includeSchemas`, `excludeSchemas`, `compression`
    - Spawn `pg_dump` child process; pipe stdout through optional compress transform → optional encrypt transform → `BackupStore.writeToTargets`
    - Emit `backup:progress` at ≤5-second intervals with `phase`, `bytesWritten`, `elapsedMs`
    - On success: compute SHA-256 checksum, update catalog record to `status: "completed"`, emit `backup:completed`
    - On failure: update catalog to `status: "failed"` with `errorMessage`, emit `backup:failed`
    - After success: call `applyRetention(jobId)` and dispatch notifications via `notifier.js`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 3.1–3.5, 4.2–4.5, 5.1–5.4, 6.2–6.5, 12.2, 12.3_

  - [ ]* 7.3 Write property test for backup ID uniqueness
    - **Property 1: Backup IDs are unique**
    - **Validates: Requirements 1.1**
    - Generate N random job configs; call the ID-generation logic N times; assert all returned IDs are distinct using a Set

  - [ ]* 7.4 Write property test for invalid format rejection
    - **Property 4: Invalid format values are rejected**
    - **Validates: Requirements 3.6**
    - Generate arbitrary strings not in `["custom","plain","directory","tar"]`; assert the validation function returns HTTP 400

  - [ ]* 7.5 Write property test for pg_dump argument construction
    - **Property 5: pg_dump arguments reflect filter configuration**
    - **Validates: Requirements 4.2, 4.3, 4.4, 4.5**
    - Generate random `includeTables`, `excludeTables`, `includeSchemas`, `excludeSchemas` arrays; assert the argument builder produces exactly one `--table`/`--schema`/`--exclude-table`/`--exclude-schema` per entry, includes before excludes

  - [ ]* 7.6 Write property test for filter preservation in catalog
    - **Property 6: Filter configuration is preserved in the catalog record**
    - **Validates: Requirements 4.6**
    - Generate random filter arrays; create a catalog record; assert stored arrays are deeply equal to inputs

  - [ ]* 7.7 Write property test for compression level validation
    - **Property 7: Compression level is validated and stored**
    - **Validates: Requirements 5.2, 5.5**
    - Generate levels in [1,9] and outside; assert in-range values are accepted and stored, out-of-range values are rejected with HTTP 400

  - [x] 7.8 Implement `startRestore(backupId, target, restoreOptions, passphrase)` in `BackupEngine`
    - Reject duplicate restore for same `backupId` with HTTP 409
    - Download artifact from `BackupStore.readFromTarget` (decrypt if encrypted)
    - For `custom`/`directory`/`tar` formats: invoke `pg_restore` with `--clean` / `--create` flags per `restoreOptions`
    - For `plain` format: pipe SQL to `psql`
    - Emit `restore:started`, `restore:progress` (≤5s intervals), `restore:completed` or `restore:failed`
    - Update catalog record with `lastRestoredAt` and `lastRestoreTarget` on success
    - On decryption failure: emit `restore:failed` with `"Decryption failed"`, write no partial data
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 13.5, 13.6_

  - [ ]* 7.9 Write property test for restore options → pg_restore flags
    - **Property 12: Restore options produce correct pg_restore flags**
    - **Validates: Requirements 8.4**
    - Generate all four boolean combinations of `cleanBeforeRestore` and `createDatabase`; assert `--clean` and `--create` appear if and only if the corresponding flag is `true`

  - [x] 7.10 Implement `verifyBackup(backupId)` in `BackupEngine`
    - Download artifact; compute SHA-256; compare to `sha256Checksum` in catalog
    - On match: update status to `"verified"`, set `lastVerifiedAt`
    - On mismatch: update status to `"corrupted"`, emit `backup:corrupted`
    - For `custom`/`directory` formats: additionally run `pg_restore --list` for structural validation
    - On download failure: set status to `"corrupted"` with `errorMessage`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

  - [ ]* 7.11 Write property test for checksum corruption detection
    - **Property 13: Checksum verification detects corruption**
    - **Validates: Requirements 9.1, 9.2, 9.3**
    - Generate random artifact bytes and their SHA-256; flip one or more bits; assert recomputed checksum differs and status becomes `"corrupted"`

  - [x] 7.12 Implement `applyRetention(jobId)` in `BackupEngine`
    - Load all completed/verified catalog records for the job
    - Evaluate `keepLast`, `keepDailyFor`, `keepWeeklyFor`, `keepMonthlyFor` rules
    - Delete artifacts from all storage paths for records not satisfying any rule
    - Update catalog status to `"deleted"` on success, `"delete_failed"` on S3 error
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

  - [ ]* 7.13 Write property test for retention policy evaluation
    - **Property 14: Retention policy correctly identifies records for deletion**
    - **Validates: Requirements 10.1, 10.2, 10.5**
    - Generate random sets of completed backup records and valid retention policy configs; assert the evaluation function identifies exactly the records that satisfy no rule for deletion

  - [x] 7.14 Implement `rotateKey(jobId, currentPassphrase, newPassphrase)` in `BackupEngine`
    - Load all `"completed"` or `"verified"` catalog records for the job
    - For each artifact: download → decrypt with `currentPassphrase` → re-encrypt with `newPassphrase` → upload back to same path
    - Update `encryption.passphrase` in `backup-jobs.json` via `BackupJobStore`
    - Process sequentially to limit memory/bandwidth usage
    - _Requirements: 13.7_

- [ ] 8. Implement `BackupScheduler` (`src/backupScheduler.js`)
  - [x] 8.1 Create `src/backupScheduler.js`
    - Maintain `Map<jobId, NodeJS.Timeout>` of active timers
    - Implement `initScheduler(io)` — load all jobs from `BackupJobStore` and schedule those with a non-null `schedule`
    - Implement `scheduleJob(job)` supporting cron strings (5-field) and interval seconds
    - Implement `unscheduleJob(jobId)` clearing the timer
    - Implement `rescheduleJob(job)` = unschedule + schedule
    - Implement `getScheduledJobs()` returning a Map snapshot
    - Guard against concurrent execution of the same job (skip trigger if already running)
    - Record `triggerSource: "scheduled"` in catalog records
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [x] 9. Checkpoint — Ensure all engine and scheduler tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Add backup API routes to `server.js`
  - [x] 10.1 Import and initialize `BackupEngine`, `BackupJobStore`, `BackupCatalog`, and `BackupScheduler` in `server.js`
    - Call `initBackupEngine(io)` and `initScheduler(io)` after existing engine inits
    - _Requirements: 1.1, 2.4, 14.1_

  - [x] 10.2 Add Backup_Job CRUD routes
    - `GET /api/backup/jobs` → `listBackupJobs()` (secrets redacted)
    - `POST /api/backup/jobs` → validate required fields, `createBackupJob(data)`, call `scheduleJob` if `schedule` is set; return HTTP 400 with field name on missing required field
    - `GET /api/backup/jobs/:id` → `getBackupJob(id)` (full record with secrets)
    - `PUT /api/backup/jobs/:id` → `updateBackupJob(id, data)`, call `rescheduleJob` if schedule changed
    - `DELETE /api/backup/jobs/:id` → `deleteBackupJob(id)`, call `unscheduleJob(id)`
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.7_

  - [x] 10.3 Add backup operation routes
    - `POST /api/backup/run` → validate config, call `startBackup(jobConfig)`, return `{ ok, backupId }`
    - `POST /api/backup/restore` → validate `backupId` and `target`; require `passphrase` for encrypted backups (HTTP 400 if absent); call `startRestore`
    - `POST /api/backup/verify/:backupId` → call `verifyBackup(backupId)`
    - `GET /api/backup/verify/:backupId` → return current verification status from catalog
    - `POST /api/backup/jobs/:id/apply-retention` → call `applyRetention(id)`
    - `POST /api/backup/jobs/:id/rotate-key` → call `rotateKey(id, currentPassphrase, newPassphrase)`
    - `POST /api/backup/test-notification` → send test notification using job's notification config
    - _Requirements: 1.1, 1.5, 8.1, 8.8, 9.1, 9.6, 10.6, 12.6, 13.5, 13.7_

  - [ ] 10.4 Add Backup_Catalog routes
    - `GET /api/backup/catalog` → `listCatalog()` (sorted by `startedAt` desc, secrets redacted)
    - `GET /api/backup/catalog/:backupId` → `getCatalogRecord(backupId)`
    - `DELETE /api/backup/catalog/:backupId` → delete artifact from storage + remove catalog record
    - _Requirements: 7.2, 7.3_

- [x] 11. Checkpoint — Ensure all API route tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Add the Backup tab to `public/index.html`
  - [x] 12.1 Add "Backup" tab button to the top navigation bar
    - Add `<button class="tab-btn" id="mode-backup">Backup</button>` alongside S3, Database, Cluster buttons
    - _Requirements: 15.1_

  - [x] 12.2 Add the Backup panel HTML structure with three sub-sections
    - Add `<div id="backup-panel" style="display:none;">` containing secondary tab buttons: Jobs, Catalog, Run
    - Add `<div id="backup-jobs-section">` with the full BackupJob editor form:
      - Source connection fields (host, port, database, user, password, SSL mode)
      - Storage targets (add/remove S3 or local targets)
      - Format selector (custom / plain / directory / tar)
      - Compression (none / gzip / lz4, level slider for gzip)
      - Selective tables/schemas (textarea, one per line)
      - Schedule (cron expression or interval seconds)
      - Retention policy (keepLast, keepDailyFor, keepWeeklyFor, keepMonthlyFor)
      - Encryption toggle + passphrase field
      - Notifications (reuse existing webhook/email field pattern)
      - Job list panel with Load, Run Now, Delete buttons
    - Add `<div id="backup-catalog-section">` with a sortable table (Job Name, Started At, Format, Size, Duration, Status, Actions)
    - Add `<div id="backup-run-section">` with phase indicator, progress bar, elapsed time, estimated remaining time, bytes written
    - Add restore modal HTML with target DB connection fields, restore options, and passphrase field
    - _Requirements: 15.2, 15.3, 15.4, 15.5, 15.7_

- [ ] 13. Add Backup tab JavaScript to `public/app.js`
  - [x] 13.1 Add mode switching for the Backup tab
    - Extend the existing mode-switching logic to handle `mode-backup` button
    - Show/hide `backup-panel` alongside existing `s3-panel`, `db-config-panel`, etc.
    - Add sub-tab switching for Jobs / Catalog / Run within the Backup panel
    - _Requirements: 15.1, 15.2_

  - [ ] 13.2 Implement Backup Job form functions
    - `getBackupJobConfig()` — collect all form field values into a `BackupJob` object
    - `applyBackupJobConfig(job)` — populate form fields from a loaded job
    - `saveBackupJob()` — POST or PUT to `/api/backup/jobs`
    - `loadBackupJob(id)` — GET `/api/backup/jobs/:id` and call `applyBackupJobConfig`
    - `deleteBackupJob(id)` — DELETE `/api/backup/jobs/:id`
    - `refreshBackupJobs()` — GET `/api/backup/jobs` and populate the job list panel
    - `runBackupNow(id)` — POST `/api/backup/run` with the loaded job config
    - _Requirements: 15.3_

  - [-] 13.3 Implement Backup Catalog table rendering
    - `loadBackupCatalog()` — GET `/api/backup/catalog` and render the sortable table
    - Render status badges with color coding (running=blue pulse, completed=green, verified=teal, failed/corrupted=red, deleted=gray)
    - Wire Restore button → open restore modal
    - Wire Verify button → POST `/api/backup/verify/:backupId`; update row status via WebSocket
    - Wire Delete button → DELETE `/api/backup/catalog/:backupId`; refresh table
    - `submitRestore()` — collect modal fields and POST `/api/backup/restore`
    - _Requirements: 15.4, 15.5, 15.6_

  - [ ] 13.4 Implement real-time progress panel via WebSocket events
    - Listen for `backup:started` → show Run sub-section, reset phase indicator and progress bar
    - Listen for `backup:progress` → update phase, bytes written, elapsed time, estimated remaining time
    - Listen for `backup:completed` → update panel with summary; reload catalog
    - Listen for `backup:failed` → show error state in panel
    - Listen for `backup:corrupted` → update catalog row status in real time
    - Listen for `restore:started`, `restore:progress`, `restore:completed`, `restore:failed` → equivalent updates for restore operations
    - When idle, display last completed operation summary
    - _Requirements: 15.7, 11.5, 11.6_

- [ ] 14. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Each task references specific requirements for traceability
- Property tests use `fast-check` (to be added as a dev dependency in Task 1)
- Checkpoints ensure incremental validation at each architectural layer
- The encryption module (`backupCrypto.js`) is kept separate from `backupEngine.js` so it can be unit-tested in isolation without spawning child processes
- `BackupJobStore` and `BackupCatalog` both use the atomic write-to-temp-then-rename pattern already established in `src/jobStore.js`
- The scheduler supports both cron strings and interval-in-seconds to match the `BackupJob.schedule` field type
