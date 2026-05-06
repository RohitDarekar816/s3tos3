# Implementation Plan: Multi-Database Backup Support

## Overview

This implementation extends S3 Backup Studio's backup system to support MySQL/MariaDB and MongoDB alongside the existing PostgreSQL support. The approach uses a driver pattern where each database type is implemented as a pluggable module that exports a standard interface. The BackupEngine acts as a dispatcher, selecting the appropriate driver based on the `dbType` field in the BackupJob configuration.

All implementation is in JavaScript (Node.js with ES modules). The existing PostgreSQL backup logic is refactored into a driver module, and new drivers are added for MySQL/MariaDB and MongoDB. The frontend adapts the connection form based on the selected database type, and the Docker image is extended to include all required database client tools.

---

## Tasks

- [x] 1. Create PostgreSQL driver module
  - [x] 1.1 Extract existing PostgreSQL logic into `src/dbDrivers/postgresql.js`
    - Create `src/dbDrivers/` directory
    - Move `buildPgDumpArgs` from `backupEngine.js` to `postgresql.js` and rename to `buildBackupArgs`
    - Move `buildPgRestoreArgs` from `backupEngine.js` to `postgresql.js` and rename to `buildRestoreArgs`
    - Move `validateFormat` logic from `backupEngine.js` to `getSupportedFormats()` in `postgresql.js`
    - Move `getArtifactExtension` logic from `backupEngine.js` to `postgresql.js`
    - Implement `testConnection(config)` using the existing `pg` Node.js client (same logic as `/api/db/test-connection`)
    - Implement `getDefaultPort()` returning `5432`
    - Export all six required driver interface functions
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 13.3_

  - [ ]* 1.2 Write property test for PostgreSQL driver
    - **Property 6: PostgreSQL connection args contain all source parameters**
    - **Validates: Requirements 3.1, 3.5**
    - Use `fc.record()` to generate arbitrary source configs with host, port, database, user, password
    - Assert returned args contain `-h`, `-p`, `-U`, `-d` with correct values
    - Assert password does NOT appear in args array
    - _Requirements: 3.1, 3.5_

  - [ ]* 1.3 Write property test for PostgreSQL format support
    - **Property 9: getSupportedFormats returns the correct set for each dbType**
    - **Validates: Requirements 9.1**
    - Assert `getSupportedFormats()` returns exactly `['custom', 'plain', 'directory', 'tar']`
    - _Requirements: 9.1_

  - [ ]* 1.4 Write property test for PostgreSQL artifact extensions
    - **Property 11: getArtifactExtension returns the correct extension for all valid combinations**
    - **Validates: Requirements 4.4, 6.6**
    - Use `fc.constantFrom('custom', 'plain', 'directory', 'tar')` for format
    - Use `fc.record({ type: fc.constantFrom('none', 'gzip'), level: fc.integer({ min: 1, max: 9 }) })` for compression
    - Assert extension is non-empty and reflects format and compression
    - _Requirements: 4.4, 6.6_

  - [ ]* 1.5 Write property test for PostgreSQL filter preservation
    - **Property 13: PostgreSQL-specific fields are preserved through buildBackupArgs**
    - **Validates: Requirements 13.3**
    - Use `fc.array(fc.string())` for includeTables, excludeTables, includeSchemas, excludeSchemas
    - Assert args contain `--table` for each included table, `--exclude-table` for each excluded table, etc.
    - _Requirements: 13.3_

- [x] 2. Create MySQL/MariaDB driver module
  - [x] 2.1 Implement `src/dbDrivers/mysql.js`
    - Implement `buildBackupArgs(jobConfig)` returning `mysqldump` args: `--host`, `--port`, `--user`, `--databases`, `--single-transaction`
    - Password passed via `MYSQL_PWD` env var (not in args)
    - Implement `buildRestoreArgs(target, restoreOptions, record)` returning `mysql` CLI args
    - Implement `testConnection(config)` by spawning `mysqladmin ping` with `MYSQL_PWD` env var
    - Implement `getDefaultPort()` returning `3306`
    - Implement `getSupportedFormats()` returning `['sql']`
    - Implement `getArtifactExtension(format, compression)` returning `'sql'` or `'sql.gz'` based on compression
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 8.3, 9.2_

  - [ ]* 2.2 Write property test for MySQL backup args
    - **Property 7: MySQL/MariaDB backup args contain all required flags**
    - **Validates: Requirements 4.2, 4.3**
    - Use `fc.record()` to generate arbitrary source configs
    - Assert args contain `--host`, `--port`, `--user`, `--databases`, `--single-transaction`
    - Assert password does NOT appear in args
    - _Requirements: 4.2, 4.3_

  - [ ]* 2.3 Write property test for MySQL format support
    - **Property 9: getSupportedFormats returns the correct set for each dbType**
    - **Validates: Requirements 9.2**
    - Assert `getSupportedFormats()` returns exactly `['sql']`
    - _Requirements: 9.2_

  - [ ]* 2.4 Write property test for MySQL artifact extensions
    - **Property 11: getArtifactExtension returns the correct extension for all valid combinations**
    - **Validates: Requirements 4.4**
    - Test with format `'sql'` and compression types `'none'` and `'gzip'`
    - Assert returns `'sql'` or `'sql.gz'` appropriately
    - _Requirements: 4.4_

- [x] 3. Create MongoDB driver module
  - [x] 3.1 Implement `src/dbDrivers/mongodb.js`
    - Implement `buildBackupArgs(jobConfig)` returning `mongodump` args with `--uri`, `--archive` (for archive format), `--gzip` (if compression enabled)
    - Connection URI contains embedded credentials (no separate password env var)
    - Implement `buildRestoreArgs(target, restoreOptions, record)` returning `mongorestore` args with `--uri`, `--archive`, `--gzip` as appropriate
    - Implement `testConnection(config)` by spawning `mongosh --eval "db.runCommand({ping:1})"` with the connection URI
    - Implement `getDefaultPort()` returning `27017`
    - Implement `getSupportedFormats()` returning `['archive', 'directory']`
    - Implement `getArtifactExtension(format, compression)` returning `'bson'` for archive or `'tar.gz'` for directory with compression
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.6, 7.1, 7.2, 7.3, 7.4, 8.4, 9.3_

  - [ ]* 3.2 Write property test for MongoDB backup args
    - **Property 8: MongoDB backup args contain the Connection URI via --uri**
    - **Validates: Requirements 6.2, 7.4**
    - Use `fc.webUrl()` or `fc.string()` to generate connection URIs
    - Assert args contain `--uri` followed by the exact URI value
    - Assert URI does NOT appear in any other position
    - _Requirements: 6.2, 7.4_

  - [ ]* 3.3 Write property test for MongoDB format support
    - **Property 9: getSupportedFormats returns the correct set for each dbType**
    - **Validates: Requirements 9.3**
    - Assert `getSupportedFormats()` returns exactly `['archive', 'directory']`
    - _Requirements: 9.3_

  - [ ]* 3.4 Write property test for MongoDB artifact extensions
    - **Property 11: getArtifactExtension returns the correct extension for all valid combinations**
    - **Validates: Requirements 6.6**
    - Test with formats `'archive'` and `'directory'` and compression types
    - Assert returns appropriate extension (e.g., `'bson'`, `'tar.gz'`)
    - _Requirements: 6.6_

- [x] 4. Refactor BackupEngine to use driver dispatcher
  - [x] 4.1 Add driver imports and dispatcher to `src/backupEngine.js`
    - Import all three driver modules at the top of `backupEngine.js`
    - Create `DRIVERS` object mapping `dbType` strings to driver modules
    - Implement `getDriver(dbType)` function that returns the appropriate driver or throws HTTP 400 error for invalid types
    - Default to `'postgresql'` when `dbType` is absent (backward compatibility)
    - _Requirements: 1.4, 3.6, 13.1_

  - [x] 4.2 Update `_runBackup` to use driver dispatcher
    - Replace direct calls to `buildPgDumpArgs` with `driver.buildBackupArgs(jobConfig)`
    - Replace direct calls to `getArtifactExtension` with `driver.getArtifactExtension(format, compression)`
    - Use `jobConfig.dbType` to select the driver via `getDriver()`
    - Preserve all existing PostgreSQL backup logic (encryption, compression, storage, catalog updates)
    - _Requirements: 3.1, 4.1, 6.1_

  - [x] 4.3 Update `_runRestore` to use driver dispatcher
    - Replace direct calls to `buildPgRestoreArgs` with `driver.buildRestoreArgs(target, restoreOptions, record)`
    - Use `record.dbType` to select the driver via `getDriver()` (default to `'postgresql'` if absent)
    - Preserve all existing restore logic (decryption, temp file handling, error handling)
    - _Requirements: 3.3, 3.4, 5.1, 7.1, 13.2_

  - [ ]* 4.4 Write property test for driver dispatch
    - **Property 1: Invalid dbType is always rejected**
    - **Validates: Requirements 1.4, 8.7**
    - Use `fc.string()` filtered to exclude valid dbTypes
    - Assert `getDriver(invalidType)` throws an error with `status = 400`
    - _Requirements: 1.4, 8.7_

  - [ ]* 4.5 Write property test for format validation
    - **Property 10: Invalid format for a dbType is always rejected**
    - **Validates: Requirements 9.5**
    - Use `fc.constantFrom('postgresql', 'mysql', 'mariadb', 'mongodb')` for dbType
    - Use `fc.constantFrom('custom', 'plain', 'directory', 'tar', 'sql', 'archive')` for format
    - Filter to only invalid combinations (e.g., `mysql` + `custom`)
    - Assert validation rejects the combination
    - _Requirements: 9.5_

- [x] 5. Extend BackupJobStore schema and redaction
  - [x] 5.1 Update `src/backupJobStore.js` to handle new fields
    - Accept and persist `dbType` field on BackupJob objects
    - Accept and persist `source.connectionUri` field (MongoDB)
    - Accept and persist `source.authDatabase` field (MongoDB)
    - Ensure all existing PostgreSQL fields continue to work
    - _Requirements: 1.5, 11.1, 11.2, 11.3, 11.4, 11.5_

  - [x] 5.2 Extend `redactSecrets` function in `src/backupJobStore.js`
    - Add redaction for `source.connectionUri` (replace entire value with `'***'`)
    - Preserve existing redaction for `source.password`, `storageTargets[].secretAccessKey`, `encryption.passphrase`, `notifications.email.pass`
    - _Requirements: 11.6_

  - [ ]* 5.3 Write property test for dbType round-trip
    - **Property 2: dbType round-trip through BackupJobStore**
    - **Validates: Requirements 1.5, 11.1**
    - Use `fc.constantFrom('postgresql', 'mysql', 'mariadb', 'mongodb')` for dbType
    - Create job with dbType, read it back, assert dbType matches
    - _Requirements: 1.5, 11.1_

  - [ ]* 5.4 Write property test for source fields round-trip
    - **Property 3: Source fields round-trip through BackupJobStore**
    - **Validates: Requirements 11.2**
    - Use `fc.record()` to generate source configs with host, port, database, user, password
    - Create job, read it back, assert all five fields match original values
    - _Requirements: 11.2_

  - [ ]* 5.5 Write property test for connectionUri round-trip
    - **Property 4: connectionUri round-trip through BackupJobStore**
    - **Validates: Requirements 11.4**
    - Use `fc.webUrl()` or `fc.string()` for connectionUri
    - Create MongoDB job with connectionUri, read it back, assert URI matches
    - _Requirements: 11.4_

  - [ ]* 5.6 Write property test for secrets redaction
    - **Property 5: Secrets are always redacted in the list API**
    - **Validates: Requirements 11.6**
    - Use `fc.string()` for password and connectionUri
    - Create job with secrets, call `listBackupJobs()`, assert both are `'***'`
    - _Requirements: 11.6_

- [x] 6. Extend BackupCatalog schema
  - [x] 6.1 Update `src/backupCatalog.js` to store `dbType`
    - Accept `dbType` field in `createCatalogRecord()`
    - Include `dbType` field in records returned by `listCatalog()`
    - Default to `'postgresql'` when reading records without `dbType` (backward compatibility)
    - _Requirements: 12.1, 12.2, 13.2_

  - [ ]* 6.2 Write property test for catalog dbType storage
    - **Property 12: dbType is stored in catalog records**
    - **Validates: Requirements 12.1, 12.2**
    - Use `fc.constantFrom('postgresql', 'mysql', 'mariadb', 'mongodb')` for dbType
    - Create catalog record with dbType, read it back via `listCatalog()`, assert dbType is present and matches
    - _Requirements: 12.1, 12.2_

- [x] 7. Add new API endpoint for multi-database connection testing
  - [x] 7.1 Implement `POST /api/backup/test-db-connection` in `server.js`
    - Accept request body with `dbType` and connection parameters (host/port/database/user/password for postgresql/mysql/mariadb, connectionUri for mongodb)
    - Use `getDriver(dbType)` to select the appropriate driver
    - Call `driver.testConnection(config)` and return the result
    - Return HTTP 400 for unsupported `dbType` values
    - Apply rate limiting (reuse existing `testLimiter`)
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.7_

  - [ ]* 7.2 Write unit test for connection test endpoint
    - Mock `spawn` and `pg` client
    - Test all four dbTypes (postgresql, mysql, mariadb, mongodb)
    - Assert correct tool is invoked for each type
    - Assert HTTP 400 for invalid dbType
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.7_

- [x] 8. Update Dockerfile to include MySQL and MongoDB client tools
  - [x] 8.1 Extend `RUN apk add` in Dockerfile runtime stage
    - Add `mysql-client` package to the existing `apk add` command
    - Download and extract MongoDB database tools (mongodump, mongorestore) from official tarball
    - Download and extract mongosh from official tarball
    - Combine all installations in a single `RUN` layer to minimize image size
    - Pin MongoDB tool versions to latest stable releases
    - _Requirements: 10.1, 10.2, 10.3, 10.5_

  - [ ]* 8.2 Document Docker smoke test commands
    - Add comment block in Dockerfile with smoke test commands:
      - `docker run --rm <image> pg_dump --version`
      - `docker run --rm <image> mysqldump --version`
      - `docker run --rm <image> mongodump --version`
      - `docker run --rm <image> mongosh --version`
    - _Requirements: 10.4_

- [x] 9. Checkpoint - Ensure all backend tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Add Database Type selector to frontend
  - [x] 10.1 Add Database Type `<select>` element to Backup tab in `public/index.html`
    - Insert new selector above existing connection fields in the Backup tab
    - Add `id="bkp-db-type"` attribute
    - Include options: PostgreSQL, MySQL, MariaDB, MongoDB
    - Default to PostgreSQL
    - _Requirements: 1.1, 1.2_

  - [x] 10.2 Implement `updateBackupFormForDbType(dbType)` in `public/app.js`
    - Show/hide fields based on dbType according to the design document's field visibility table
    - Update port field default when type changes (5432 for postgresql, 3306 for mysql/mariadb)
    - Only update port if current value matches old default (preserve user-entered custom ports)
    - Preserve values in fields that remain visible across type changes
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9_

  - [x] 10.3 Add event listener for Database Type selector changes
    - Call `updateBackupFormForDbType()` when selector value changes
    - _Requirements: 2.9_

- [x] 11. Add MongoDB-specific fields to frontend
  - [x] 11.1 Add Connection URI field to Backup tab in `public/index.html`
    - Add `<input>` with `id="bkp-src-connection-uri"` and `type="url"`
    - Add label "Connection URI"
    - Initially hidden (shown only when dbType is mongodb)
    - _Requirements: 2.4_

  - [x] 11.2 Add Auth Database field to Backup tab in `public/index.html`
    - Add `<input>` with `id="bkp-src-auth-database"` and `type="text"`
    - Add label "Auth Database (optional)"
    - Default placeholder value: `admin`
    - Initially hidden (shown only when dbType is mongodb)
    - _Requirements: 2.5_

- [x] 12. Implement format selector filtering in frontend
  - [x] 12.1 Define `FORMAT_OPTIONS` object in `public/app.js`
    - Map each dbType to its valid format options according to the design document
    - PostgreSQL: custom, plain, directory, tar
    - MySQL/MariaDB: sql
    - MongoDB: archive, directory
    - _Requirements: 9.1, 9.2, 9.3_

  - [x] 12.2 Implement `updateFormatOptionsForDbType(dbType)` in `public/app.js`
    - Clear existing format selector options
    - Populate with options from `FORMAT_OPTIONS[dbType]`
    - Reset selector to first option for the new type
    - _Requirements: 9.4_

  - [x] 12.3 Call `updateFormatOptionsForDbType()` when Database Type changes
    - Add call to `updateBackupFormForDbType()` function
    - _Requirements: 9.4_

- [x] 13. Update frontend connection test button
  - [x] 13.1 Implement `getBackupConnectionTestPayload()` in `public/app.js`
    - Read `dbType` from `#bkp-db-type` selector
    - For postgresql/mysql/mariadb: return object with dbType, host, port, database, user, password
    - For mongodb: return object with dbType, connectionUri
    - _Requirements: 8.1_

  - [x] 13.2 Update Test button click handler in Backup tab
    - Change endpoint from `/api/db/test-connection` to `/api/backup/test-db-connection`
    - Use `getBackupConnectionTestPayload()` to build request body
    - Update UI indicators based on response (green dot + version on success, red dot + error on failure)
    - _Requirements: 8.5, 8.6_

- [x] 14. Update frontend config serialization
  - [x] 14.1 Extend `getBackupConfig()` in `public/app.js`
    - Add `dbType` field to top level of job config (read from `#bkp-db-type`)
    - Add `dbType` field to `source` object (same value)
    - Add `connectionUri` field to `source` object (read from `#bkp-src-connection-uri`)
    - Add `authDatabase` field to `source` object (read from `#bkp-src-auth-database`)
    - Preserve all existing PostgreSQL fields
    - _Requirements: 1.3, 11.1, 11.4, 11.5_

  - [x] 14.2 Update `loadBackupJob(job)` in `public/app.js`
    - Set `#bkp-db-type` selector value from `job.dbType` or `job.source.dbType`
    - Call `updateBackupFormForDbType()` to show/hide appropriate fields
    - Populate MongoDB fields if present (`connectionUri`, `authDatabase`)
    - _Requirements: 1.3_

- [x] 15. Checkpoint - Ensure all frontend changes work correctly
  - Ensure all tests pass, ask the user if questions arise.

- [ ]* 16. Write integration tests for backup run endpoint
  - Mock `spawn` to simulate pg_dump, mysqldump, mongodump
  - Test backup run for each dbType
  - Assert correct tool is invoked with correct args
  - Assert format validation rejects invalid format/dbType combinations
  - _Requirements: 3.1, 4.1, 6.1, 9.5_

- [ ]* 17. Write integration tests for restore endpoint
  - Mock `spawn` to simulate pg_restore/psql, mysql, mongorestore
  - Test restore for each dbType
  - Assert correct tool is invoked with correct args
  - Assert backward compatibility (records without dbType default to postgresql)
  - _Requirements: 3.3, 3.4, 5.1, 7.1, 13.2_

- [ ] 18. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

---

## Notes

- Tasks marked with `*` are optional property-based and integration tests and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation at key milestones
- Property tests validate universal correctness properties across all valid inputs
- Unit tests validate specific examples and edge cases
- The implementation preserves full backward compatibility with existing PostgreSQL backup jobs
- All database client tools are installed in a single Docker layer to minimize image size
- Frontend changes are adaptive and preserve user-entered values across database type changes
