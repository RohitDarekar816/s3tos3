# Requirements Document

## Introduction

S3 Backup Studio currently supports PostgreSQL database backups using `pg_dump`/`pg_restore`. This feature extends the backup system to support MySQL/MariaDB and MongoDB in addition to PostgreSQL, allowing users to select the database type when creating a backup job. The connection form, backup tooling, restore tooling, and Docker image must all adapt to the selected database type. Existing PostgreSQL functionality must remain fully intact.

## Glossary

- **BackupEngine**: The server-side module (`src/backupEngine.js`) that orchestrates backup and restore operations.
- **BackupJob**: A persisted configuration object stored by `BackupJobStore` that defines a single backup task, including source connection, storage targets, schedule, and format options.
- **BackupCatalog**: The persistent record store (`src/backupCatalog.js`) that tracks every backup run and its metadata.
- **BackupJobStore**: The persistence layer (`src/backupJobStore.js`) for BackupJob configurations.
- **DatabaseType**: An enumerated value identifying the database engine. Valid values: `postgresql`, `mysql`, `mariadb`, `mongodb`.
- **NativeTool**: The CLI binary used to perform a backup or restore for a given DatabaseType (`pg_dump`/`pg_restore`/`psql` for PostgreSQL; `mysqldump`/`mysql` for MySQL and MariaDB; `mongodump`/`mongorestore` for MongoDB).
- **ConnectionURI**: A single string encoding all connection parameters for MongoDB (e.g. `mongodb://user:pass@host:27017/dbname`).
- **BackupFormat**: The output format of a backup artifact. PostgreSQL supports `custom`, `plain`, `directory`, `tar`. MySQL/MariaDB produce `sql`. MongoDB produces `archive` (single-file BSON) or `directory` (multi-file BSON).
- **UI**: The web front-end served from `public/index.html` and `public/app.js`.
- **Backup_Tab**: The "Backup" section of the UI, accessible via the "Backup" mode button in the header.
- **Connection_Form**: The form within the Backup_Tab that collects source database connection parameters for a BackupJob.
- **Docker_Image**: The container image built from `Dockerfile`.

---

## Requirements

### Requirement 1: Database Type Selection

**User Story:** As a user, I want to select the database type when creating or editing a backup job, so that the system uses the correct tools and connection parameters for my database.

#### Acceptance Criteria

1. THE Connection_Form SHALL display a "Database Type" selector with the options: PostgreSQL, MySQL, MariaDB, and MongoDB.
2. WHEN a user creates a new backup job, THE Connection_Form SHALL default the Database Type selector to PostgreSQL.
3. WHEN a user loads an existing BackupJob, THE Connection_Form SHALL display the DatabaseType stored in that BackupJob.
4. THE BackupEngine SHALL reject a backup request with an error message when the BackupJob contains a DatabaseType value that is not one of `postgresql`, `mysql`, `mariadb`, or `mongodb`.
5. THE BackupJobStore SHALL persist the `dbType` field on every BackupJob.

---

### Requirement 2: Adaptive Connection Form

**User Story:** As a user, I want the connection form fields to change based on the selected database type, so that I only see fields relevant to my database.

#### Acceptance Criteria

1. WHEN the Database Type is PostgreSQL or MySQL or MariaDB, THE Connection_Form SHALL display the following fields: Host, Port, Database Name, Username, and Password.
2. WHEN the Database Type is PostgreSQL, THE Connection_Form SHALL display a Schema field (default value: `public`).
3. WHEN the Database Type is MySQL or MariaDB, THE Connection_Form SHALL hide the Schema field.
4. WHEN the Database Type is MongoDB, THE Connection_Form SHALL display a Connection URI field and hide the individual Host, Port, Database Name, Username, and Password fields.
5. WHEN the Database Type is MongoDB, THE Connection_Form SHALL display an optional Authentication Database field (default value: `admin`).
6. WHEN the Database Type is PostgreSQL, THE Connection_Form SHALL pre-fill the Port field with `5432`.
7. WHEN the Database Type is MySQL or MariaDB, THE Connection_Form SHALL pre-fill the Port field with `3306`.
8. WHEN the Database Type is MongoDB, THE Connection_Form SHALL pre-fill the Port field in the Connection URI placeholder with `27017`.
9. WHEN the user changes the Database Type selector, THE Connection_Form SHALL update the visible fields and port defaults without clearing values already entered in fields that remain visible.

---

### Requirement 3: PostgreSQL Backup and Restore

**User Story:** As a user, I want PostgreSQL backups to continue working exactly as before, so that existing jobs are not broken by this change.

#### Acceptance Criteria

1. WHEN a BackupJob has `dbType` equal to `postgresql`, THE BackupEngine SHALL invoke `pg_dump` with the connection parameters from the BackupJob source.
2. WHEN a BackupJob has `dbType` equal to `postgresql`, THE BackupEngine SHALL support the backup formats: `custom`, `plain`, `directory`, and `tar`.
3. WHEN restoring a backup with `dbType` equal to `postgresql` and format `plain`, THE BackupEngine SHALL invoke `psql` to execute the SQL file.
4. WHEN restoring a backup with `dbType` equal to `postgresql` and format `custom`, `directory`, or `tar`, THE BackupEngine SHALL invoke `pg_restore`.
5. WHEN a BackupJob has `dbType` equal to `postgresql`, THE BackupEngine SHALL pass the source password via the `PGPASSWORD` environment variable and SHALL NOT include the password in the command-line arguments.
6. IF a BackupJob does not contain a `dbType` field, THEN THE BackupEngine SHALL treat it as `postgresql` to preserve backward compatibility with existing jobs.

---

### Requirement 4: MySQL and MariaDB Backup

**User Story:** As a user, I want to back up MySQL and MariaDB databases, so that I can protect data stored in those engines.

#### Acceptance Criteria

1. WHEN a BackupJob has `dbType` equal to `mysql` or `mariadb`, THE BackupEngine SHALL invoke `mysqldump` to produce the backup artifact.
2. WHEN a BackupJob has `dbType` equal to `mysql` or `mariadb`, THE BackupEngine SHALL pass the following arguments to `mysqldump`: `--host`, `--port`, `--user`, `--databases`, and `--single-transaction`.
3. WHEN a BackupJob has `dbType` equal to `mysql` or `mariadb`, THE BackupEngine SHALL pass the source password to `mysqldump` via the `MYSQL_PWD` environment variable and SHALL NOT include the password in the command-line arguments.
4. WHEN a BackupJob has `dbType` equal to `mysql` or `mariadb`, THE BackupEngine SHALL store the backup artifact as a `.sql` file.
5. WHEN a BackupJob has `dbType` equal to `mysql` or `mariadb` and compression is enabled, THE BackupEngine SHALL apply gzip compression to the `mysqldump` output stream and store the artifact as a `.sql.gz` file.
6. WHEN `mysqldump` exits with a non-zero exit code, THE BackupEngine SHALL mark the backup as failed and SHALL record the stderr output as the error message in the BackupCatalog.

---

### Requirement 5: MySQL and MariaDB Restore

**User Story:** As a user, I want to restore MySQL and MariaDB backups, so that I can recover data from a backup artifact.

#### Acceptance Criteria

1. WHEN restoring a backup with `dbType` equal to `mysql` or `mariadb`, THE BackupEngine SHALL invoke the `mysql` CLI client to execute the SQL artifact against the target database.
2. WHEN restoring a backup with `dbType` equal to `mysql` or `mariadb`, THE BackupEngine SHALL pass the target password via the `MYSQL_PWD` environment variable and SHALL NOT include the password in the command-line arguments.
3. WHEN restoring a compressed MySQL or MariaDB backup artifact, THE BackupEngine SHALL decompress the artifact before passing it to the `mysql` CLI client.
4. WHEN the `mysql` CLI client exits with a non-zero exit code during restore, THE BackupEngine SHALL mark the restore as failed and SHALL record the stderr output as the error message.

---

### Requirement 6: MongoDB Backup

**User Story:** As a user, I want to back up MongoDB databases, so that I can protect data stored in MongoDB.

#### Acceptance Criteria

1. WHEN a BackupJob has `dbType` equal to `mongodb`, THE BackupEngine SHALL invoke `mongodump` to produce the backup artifact.
2. WHEN a BackupJob has `dbType` equal to `mongodb` and the source specifies a Connection URI, THE BackupEngine SHALL pass the Connection URI to `mongodump` via the `--uri` argument.
3. WHEN a BackupJob has `dbType` equal to `mongodb` and the backup format is `archive`, THE BackupEngine SHALL pass `--archive` to `mongodump` and produce a single-file BSON artifact.
4. WHEN a BackupJob has `dbType` equal to `mongodb` and compression is enabled, THE BackupEngine SHALL pass `--gzip` to `mongodump`.
5. WHEN `mongodump` exits with a non-zero exit code, THE BackupEngine SHALL mark the backup as failed and SHALL record the stderr output as the error message in the BackupCatalog.
6. WHEN a BackupJob has `dbType` equal to `mongodb`, THE BackupEngine SHALL store the backup artifact with a `.bson` extension for archive format or a `.tar.gz` extension for directory format with compression.

---

### Requirement 7: MongoDB Restore

**User Story:** As a user, I want to restore MongoDB backups, so that I can recover data from a MongoDB backup artifact.

#### Acceptance Criteria

1. WHEN restoring a backup with `dbType` equal to `mongodb`, THE BackupEngine SHALL invoke `mongorestore` to restore the artifact.
2. WHEN restoring a MongoDB backup in archive format, THE BackupEngine SHALL pass `--archive` to `mongorestore` and pipe the artifact buffer to its stdin.
3. WHEN restoring a compressed MongoDB backup, THE BackupEngine SHALL pass `--gzip` to `mongorestore`.
4. WHEN the source BackupJob used a Connection URI, THE BackupEngine SHALL pass the same Connection URI to `mongorestore` via the `--uri` argument.
5. WHEN `mongorestore` exits with a non-zero exit code during restore, THE BackupEngine SHALL mark the restore as failed and SHALL record the stderr output as the error message.

---

### Requirement 8: Connection Testing

**User Story:** As a user, I want to test the database connection before saving a backup job, so that I can confirm my credentials and network access are correct.

#### Acceptance Criteria

1. WHEN a user clicks the "Test" button in the Connection_Form, THE UI SHALL send a connection test request to the server including the DatabaseType and all connection parameters currently entered in the form.
2. WHEN the server receives a connection test request with `dbType` equal to `postgresql`, THE BackupEngine SHALL attempt to connect using the `pg` Node.js client and return the server version on success.
3. WHEN the server receives a connection test request with `dbType` equal to `mysql` or `mariadb`, THE BackupEngine SHALL invoke `mysqladmin ping` with the provided credentials and return success or failure.
4. WHEN the server receives a connection test request with `dbType` equal to `mongodb`, THE BackupEngine SHALL invoke `mongosh --eval "db.runCommand({ping:1})"` with the provided Connection URI and return success or failure.
5. WHEN a connection test succeeds, THE UI SHALL display a green indicator and the database server version string next to the Test button.
6. WHEN a connection test fails, THE UI SHALL display a red indicator and the error message next to the Test button.
7. IF the connection test request contains a DatabaseType that is not supported, THEN THE BackupEngine SHALL return an error response with HTTP status 400.

---

### Requirement 9: Backup Format Options per Database Type

**User Story:** As a user, I want to see only the backup format options that are valid for my selected database type, so that I cannot select an incompatible format.

#### Acceptance Criteria

1. WHEN the Database Type is PostgreSQL, THE Connection_Form SHALL offer the backup format options: `custom`, `plain`, `directory`, and `tar`.
2. WHEN the Database Type is MySQL or MariaDB, THE Connection_Form SHALL offer only the backup format option: `sql`.
3. WHEN the Database Type is MongoDB, THE Connection_Form SHALL offer the backup format options: `archive` and `directory`.
4. WHEN the user changes the Database Type selector, THE Connection_Form SHALL reset the backup format selector to the default format for the newly selected type.
5. THE BackupEngine SHALL reject a backup request with an error message when the BackupJob specifies a format that is not valid for its DatabaseType.

---

### Requirement 10: Docker Image Client Tools

**User Story:** As a developer, I want the Docker image to include the native client tools for all supported database types, so that backup and restore operations work inside the container.

#### Acceptance Criteria

1. THE Docker_Image SHALL include `pg_dump`, `pg_restore`, and `psql` from the `postgresql16-client` Alpine package.
2. THE Docker_Image SHALL include `mysqldump` and `mysql` from the `mysql-client` Alpine package.
3. THE Docker_Image SHALL include `mongodump`, `mongorestore`, and `mongosh` from the official MongoDB tools Alpine-compatible packages.
4. WHEN the Docker_Image is built, THE Docker_Image SHALL successfully execute `pg_dump --version`, `mysqldump --version`, and `mongodump --version` without error.
5. THE Docker_Image SHALL install all database client packages in a single `RUN apk add` layer to minimise image layer count.

---

### Requirement 11: BackupJob Schema Extension

**User Story:** As a developer, I want the BackupJob schema to carry the database type and type-specific connection fields, so that the engine always has the information it needs.

#### Acceptance Criteria

1. THE BackupJobStore SHALL accept and persist a `dbType` field on BackupJob objects with one of the values: `postgresql`, `mysql`, `mariadb`, `mongodb`.
2. WHEN `dbType` is `postgresql`, `mysql`, or `mariadb`, THE BackupJobStore SHALL accept and persist the fields: `host`, `port`, `database`, `user`, and `password` within the `source` object.
3. WHEN `dbType` is `postgresql`, THE BackupJobStore SHALL accept and persist a `schema` field within the `source` object.
4. WHEN `dbType` is `mongodb`, THE BackupJobStore SHALL accept and persist a `connectionUri` field within the `source` object.
5. WHEN `dbType` is `mongodb`, THE BackupJobStore SHALL accept and persist an optional `authDatabase` field within the `source` object.
6. THE BackupJobStore SHALL redact the `password` field and the `connectionUri` field (which may contain embedded credentials) when returning BackupJob objects via the list endpoint.

---

### Requirement 12: Catalog Record Database Type Tracking

**User Story:** As a user, I want the backup catalog to record which database type was used for each backup, so that I can identify and filter backups by engine.

#### Acceptance Criteria

1. WHEN a backup is created, THE BackupCatalog SHALL store the `dbType` value from the BackupJob in the catalog record.
2. THE BackupCatalog SHALL include the `dbType` field in all catalog records returned by the list endpoint.
3. WHEN restoring a backup, THE BackupEngine SHALL read the `dbType` from the catalog record and use the corresponding NativeTool for the restore operation.

---

### Requirement 13: Backward Compatibility

**User Story:** As a user, I want my existing PostgreSQL backup jobs to continue working without modification, so that I do not need to reconfigure them after the upgrade.

#### Acceptance Criteria

1. IF a BackupJob loaded from storage does not contain a `dbType` field, THEN THE BackupEngine SHALL treat it as `dbType` equal to `postgresql`.
2. IF a catalog record does not contain a `dbType` field, THEN THE BackupEngine SHALL treat it as `dbType` equal to `postgresql` when performing a restore.
3. THE BackupEngine SHALL continue to accept all existing PostgreSQL-specific fields (`format`, `compression`, `includeTables`, `excludeTables`, `includeSchemas`, `excludeSchemas`) on BackupJobs with `dbType` equal to `postgresql`.
