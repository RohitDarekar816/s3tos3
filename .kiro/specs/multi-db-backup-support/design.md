# Design Document: Multi-Database Backup Support

## Overview

S3 Backup Studio currently supports PostgreSQL backups via `pg_dump`/`pg_restore`. This design extends the backup system to support MySQL/MariaDB and MongoDB alongside PostgreSQL, using a **driver pattern** that encapsulates all database-specific logic behind a common interface.

The key design principle is **additive extension**: the existing PostgreSQL code path is preserved intact, and new database types are added as pluggable drivers. The `BackupEngine` becomes a dispatcher that selects the correct driver based on `dbType`, then delegates argument-building, connection testing, and extension resolution to that driver.

### Key Design Decisions

1. **Driver modules over inheritance** — Each database type gets a plain ES module in `src/dbDrivers/` that exports a fixed set of functions. No class hierarchy is needed; the dispatcher imports all drivers at startup and selects by `dbType`.

2. **Backward compatibility via default** — Any `BackupJob` or catalog record without a `dbType` field is treated as `postgresql`. No migration is required.

3. **Password security** — Passwords are never passed as CLI arguments. PostgreSQL uses `PGPASSWORD`, MySQL/MariaDB use `MYSQL_PWD`, MongoDB embeds credentials in the Connection URI (which is itself redacted in the list API).

4. **Connection URI for MongoDB** — MongoDB's native connection string format already encodes host, port, credentials, and auth database. Exposing individual fields would be redundant and error-prone. The UI shows a single URI field for MongoDB.

5. **Format validation per driver** — Each driver declares its supported formats. The engine validates the requested format against the driver's list before spawning any process.

---

## Architecture

```mermaid
graph TD
    UI["Frontend (public/app.js)"]
    API["Express API (server.js)"]
    BE["BackupEngine (src/backupEngine.js)"]
    DISP["Driver Dispatcher\ngetDriver(dbType)"]
    PG["PostgreSQL Driver\n(src/dbDrivers/postgresql.js)"]
    MY["MySQL/MariaDB Driver\n(src/dbDrivers/mysql.js)"]
    MG["MongoDB Driver\n(src/dbDrivers/mongodb.js)"]
    CAT["BackupCatalog\n(src/backupCatalog.js)"]
    STORE["BackupStore\n(src/backupStore.js)"]
    JOB["BackupJobStore\n(src/backupJobStore.js)"]

    UI -->|"POST /api/backup/test-db-connection"| API
    UI -->|"POST /api/backup/run"| API
    API --> BE
    BE --> DISP
    DISP --> PG
    DISP --> MY
    DISP --> MG
    BE --> CAT
    BE --> STORE
    BE --> JOB
```

The `BackupEngine` is the only module that imports drivers. All other modules (`BackupJobStore`, `BackupCatalog`, `BackupStore`) are driver-agnostic and require only minor schema additions.

---

## Components and Interfaces

### Driver Interface

Every driver module in `src/dbDrivers/` must export the following functions:

```js
/**
 * Build CLI arguments for the backup tool (e.g. pg_dump, mysqldump, mongodump).
 * The password MUST NOT appear in the returned args array.
 * @param {object} jobConfig  Full BackupJob object
 * @returns {string[]}
 */
export function buildBackupArgs(jobConfig) {}

/**
 * Build CLI arguments for the restore tool (e.g. pg_restore/psql, mysql, mongorestore).
 * The password MUST NOT appear in the returned args array.
 * @param {object} target       { host, port, database, user, password, connectionUri, ... }
 * @param {object} restoreOptions  { cleanBeforeRestore?, createDatabase? }
 * @param {object} record       Catalog record (contains format, compression, etc.)
 * @returns {string[]}
 */
export function buildRestoreArgs(target, restoreOptions, record) {}

/**
 * Test the database connection.
 * For PostgreSQL: uses the pg Node.js client.
 * For MySQL/MariaDB: spawns mysqladmin ping.
 * For MongoDB: spawns mongosh --eval "db.runCommand({ping:1})".
 * @param {object} config  Connection parameters
 * @returns {Promise<{ ok: boolean, version?: string, error?: string }>}
 */
export async function testConnection(config) {}

/**
 * Return the default port number for this database type.
 * @returns {number}
 */
export function getDefaultPort() {}

/**
 * Return the list of valid backup format strings for this database type.
 * @returns {string[]}
 */
export function getSupportedFormats() {}

/**
 * Return the file extension for a backup artifact given format and compression.
 * @param {string} format
 * @param {{ type: string, level?: number }|null} compression
 * @returns {string}  e.g. "dump", "sql", "sql.gz", "bson"
 */
export function getArtifactExtension(format, compression) {}
```

### Driver Dispatcher (`src/backupEngine.js`)

A new internal helper replaces the current hard-coded PostgreSQL logic:

```js
import * as postgresqlDriver from './dbDrivers/postgresql.js';
import * as mysqlDriver      from './dbDrivers/mysql.js';
import * as mongodbDriver    from './dbDrivers/mongodb.js';

const DRIVERS = {
  postgresql: postgresqlDriver,
  mysql:      mysqlDriver,
  mariadb:    mysqlDriver,   // MariaDB reuses the MySQL driver
  mongodb:    mongodbDriver,
};

const VALID_DB_TYPES = new Set(Object.keys(DRIVERS));

/**
 * Return the driver for a given dbType, defaulting to postgresql.
 * Throws with HTTP 400 if the type is explicitly set but invalid.
 */
function getDriver(dbType) {
  const type = dbType || 'postgresql';
  const driver = DRIVERS[type];
  if (!driver) {
    const err = new Error(`Unsupported dbType "${type}". Valid values: ${[...VALID_DB_TYPES].join(', ')}`);
    err.status = 400;
    throw err;
  }
  return { driver, resolvedType: type };
}
```

### New API Endpoint: `POST /api/backup/test-db-connection`

The existing `/api/db/test-connection` is PostgreSQL-only (uses the `pg` Node.js client). A new endpoint handles multi-database connection testing:

```
POST /api/backup/test-db-connection
Content-Type: application/json

{
  "dbType": "mysql",
  "host": "db.example.com",
  "port": 3306,
  "database": "mydb",
  "user": "root",
  "password": "secret"
}

// MongoDB variant:
{
  "dbType": "mongodb",
  "connectionUri": "mongodb://user:pass@host:27017/mydb"
}
```

Response:
```json
{ "ok": true, "version": "8.0.32 MySQL Community Server" }
// or
{ "ok": false, "error": "Connection refused" }
```

The endpoint delegates to `driver.testConnection(config)` after resolving the driver from `dbType`. Returns HTTP 400 for unsupported `dbType` values.

---

## Data Models

### BackupJob Schema Extension

The `source` object gains new optional fields. Existing fields are unchanged.

```js
{
  // Existing fields (unchanged)
  id: string,
  name: string,
  format: string,           // "custom"|"plain"|"directory"|"tar"|"sql"|"archive"
  compression: { type, level },
  encryption: { enabled, passphrase },
  storageTargets: [...],
  retentionPolicy: {...},
  schedule: {...},
  notifications: {...},

  // NEW: database type (defaults to "postgresql" if absent)
  dbType: "postgresql" | "mysql" | "mariadb" | "mongodb",

  source: {
    // Existing PostgreSQL fields (unchanged, still valid for postgresql)
    host: string,
    port: number,
    database: string,
    user: string,
    password: string,       // redacted in list API
    schema: string,         // postgresql only
    sslMode: string,        // postgresql only

    // NEW: MongoDB-specific fields
    connectionUri: string,  // mongodb only — redacted in list API
    authDatabase: string,   // mongodb only, default "admin"
  },

  // Existing PostgreSQL filter fields (unchanged)
  includeTables: string[],
  excludeTables: string[],
  includeSchemas: string[],
  excludeSchemas: string[],
}
```

### BackupCatalog Record Extension

```js
{
  // Existing fields (unchanged)
  backupId: string,
  jobId: string,
  jobName: string,
  format: string,
  compression: {...},
  encrypted: boolean,
  storagePaths: [...],
  sizeBytes: number,
  sha256Checksum: string,
  durationMs: number,
  status: string,
  startedAt: string,
  completedAt: string,
  errorMessage: string | null,

  // NEW: database type (defaults to "postgresql" if absent — backward compat)
  dbType: "postgresql" | "mysql" | "mariadb" | "mongodb",

  source: {
    host: string,       // null for mongodb (URI-based)
    port: number,       // null for mongodb
    database: string,   // null for mongodb
  },
}
```

### Driver Module Files

| File | Handles |
|------|---------|
| `src/dbDrivers/postgresql.js` | PostgreSQL — wraps existing `buildPgDumpArgs`, `buildPgRestoreArgs`, `validateFormat`, `getArtifactExtension` logic extracted from `backupEngine.js` |
| `src/dbDrivers/mysql.js` | MySQL and MariaDB — `mysqldump`/`mysql` CLI, `MYSQL_PWD` env var |
| `src/dbDrivers/mongodb.js` | MongoDB — `mongodump`/`mongorestore` CLI, `--uri` flag, `--archive`/`--gzip` flags |

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Invalid dbType is always rejected

*For any* string value that is not one of `postgresql`, `mysql`, `mariadb`, or `mongodb`, passing it as `dbType` to the engine's `getDriver` function SHALL throw an error, and passing it to the `POST /api/backup/test-db-connection` endpoint SHALL return HTTP 400.

**Validates: Requirements 1.4, 8.7**

---

### Property 2: dbType round-trip through BackupJobStore

*For any* BackupJob created with a valid `dbType` value, reading that job back from `BackupJobStore` SHALL return the same `dbType` value.

**Validates: Requirements 1.5, 11.1**

---

### Property 3: Source fields round-trip through BackupJobStore

*For any* BackupJob with `dbType` in `{postgresql, mysql, mariadb}` and any combination of `host`, `port`, `database`, `user`, and `password` values in the `source` object, reading that job back from `BackupJobStore` SHALL return all five fields with their original values.

**Validates: Requirements 11.2**

---

### Property 4: connectionUri round-trip through BackupJobStore

*For any* BackupJob with `dbType` equal to `mongodb` and any `connectionUri` value in the `source` object, reading that job back from `BackupJobStore` SHALL return the same `connectionUri` value.

**Validates: Requirements 11.4**

---

### Property 5: Secrets are always redacted in the list API

*For any* BackupJob with any `password` value and any `connectionUri` value, calling `listBackupJobs()` SHALL return a record where `source.password` is `"***"` and `source.connectionUri` is `"***"`, regardless of the original values.

**Validates: Requirements 11.6**

---

### Property 6: PostgreSQL connection args contain all source parameters

*For any* BackupJob with `dbType` equal to `postgresql` and any values for `source.host`, `source.port`, `source.database`, and `source.user`, calling `buildBackupArgs(jobConfig)` on the PostgreSQL driver SHALL return an array that contains `-h {host}`, `-p {port}`, `-U {user}`, and `-d {database}`. The `source.password` SHALL NOT appear anywhere in the returned array.

**Validates: Requirements 3.1, 3.5**

---

### Property 7: MySQL/MariaDB backup args contain all required flags

*For any* BackupJob with `dbType` in `{mysql, mariadb}` and any values for `source.host`, `source.port`, `source.database`, and `source.user`, calling `buildBackupArgs(jobConfig)` on the MySQL driver SHALL return an array that contains `--host`, `--port`, `--user`, `--databases`, and `--single-transaction`. The `source.password` SHALL NOT appear anywhere in the returned array.

**Validates: Requirements 4.2, 4.3**

---

### Property 8: MongoDB backup args contain the Connection URI via --uri

*For any* BackupJob with `dbType` equal to `mongodb` and any `source.connectionUri` value, calling `buildBackupArgs(jobConfig)` on the MongoDB driver SHALL return an array that contains `--uri` followed by the exact `connectionUri` value. The `connectionUri` SHALL NOT appear in any other position in the array.

**Validates: Requirements 6.2, 7.4**

---

### Property 9: getSupportedFormats returns the correct set for each dbType

*For any* driver, calling `getSupportedFormats()` SHALL return exactly the set of formats valid for that database type:
- PostgreSQL: `{custom, plain, directory, tar}`
- MySQL/MariaDB: `{sql}`
- MongoDB: `{archive, directory}`

**Validates: Requirements 9.1, 9.2, 9.3**

---

### Property 10: Invalid format for a dbType is always rejected

*For any* `(dbType, format)` pair where `format` is not in `getSupportedFormats()` for that `dbType`, the engine's format validator SHALL reject the pair with an error message.

**Validates: Requirements 9.5**

---

### Property 11: getArtifactExtension returns the correct extension for all valid combinations

*For any* driver and any valid `(format, compression)` combination supported by that driver, calling `getArtifactExtension(format, compression)` SHALL return a non-empty string that correctly reflects both the format and the compression type (e.g., `.sql` without compression, `.sql.gz` with gzip).

**Validates: Requirements 4.4, 6.6**

---

### Property 12: dbType is stored in catalog records

*For any* BackupJob with any valid `dbType`, the catalog record created by `BackupCatalog.createCatalogRecord` SHALL contain a `dbType` field equal to the job's `dbType`. The `listCatalog()` function SHALL include the `dbType` field in every returned record.

**Validates: Requirements 12.1, 12.2**

---

### Property 13: PostgreSQL-specific fields are preserved through buildBackupArgs

*For any* BackupJob with `dbType` equal to `postgresql` and any combination of `includeTables`, `excludeTables`, `includeSchemas`, and `excludeSchemas` arrays, calling `buildBackupArgs(jobConfig)` on the PostgreSQL driver SHALL include `--table` for each included table, `--schema` for each included schema, `--exclude-table` for each excluded table, and `--exclude-schema` for each excluded schema.

**Validates: Requirements 13.3**

---

### Property 14: Form field values are preserved across type changes for shared fields

*For any* sequence of Database Type selector changes, field values that exist in both the previous and new type's form (e.g., Host, Port, Database Name, Username, Password) SHALL retain their values after the type change. Only fields that are hidden by the new type need not be preserved.

**Validates: Requirements 2.9**

---

## Error Handling

### Driver Not Found

When `getDriver(dbType)` is called with an unrecognized `dbType`, it throws an error with `status = 400`. The API layer catches this and returns `{ ok: false, error: "..." }` with HTTP 400.

### Tool Not Available

If a native tool (e.g., `mongodump`) is not installed in the container, `spawn` will emit an `ENOENT` error. The engine catches this in the `pgDump.on('error', ...)` / equivalent handler and marks the backup as failed with a descriptive error message: `"mongodump not found — ensure the Docker image includes MongoDB client tools"`.

### Format Validation

Format validation happens in the API handler (`POST /api/backup/run`) before `startBackup` is called. The new validation logic calls `driver.getSupportedFormats()` and checks the requested format against that list. This returns HTTP 400 before any process is spawned.

### Connection URI Parsing

MongoDB connection URIs may contain embedded passwords. The `BackupJobStore.redactSecrets` function is extended to also redact `source.connectionUri`. The redaction replaces the entire URI value with `"***"` rather than attempting to parse and redact only the password component, to avoid URI parsing edge cases.

### MySQL/MariaDB Restore Decompression

When restoring a compressed MySQL/MariaDB artifact (`.sql.gz`), the engine detects compression from the catalog record's `compression.type` field and pipes the artifact buffer through `zlib.gunzip` before writing to the temp file that is passed to the `mysql` CLI.

### Backward Compatibility

- `BackupJob` without `dbType`: resolved to `"postgresql"` in `getDriver`.
- Catalog record without `dbType`: resolved to `"postgresql"` in `_runRestore`.
- Existing `validateFormat` export in `backupEngine.js` is kept for backward compatibility but now delegates to the PostgreSQL driver's `getSupportedFormats`.

---

## Testing Strategy

### Unit Tests (example-based)

Located in `tests/backup/`:

- **Driver dispatch**: assert correct driver is selected for each `dbType`; assert error for invalid `dbType`
- **PostgreSQL driver**: `buildBackupArgs` with various format/compression/filter combinations; `buildRestoreArgs` for plain vs custom/tar/directory; `getArtifactExtension` for all format/compression combos
- **MySQL driver**: `buildBackupArgs` includes all required flags; `getArtifactExtension` returns `sql` / `sql.gz`; `testConnection` invokes `mysqladmin ping`
- **MongoDB driver**: `buildBackupArgs` includes `--uri`, `--archive`, `--gzip` as appropriate; `buildRestoreArgs` includes `--archive` for archive format; `testConnection` invokes `mongosh`
- **BackupJobStore redaction**: `listBackupJobs` redacts `password` and `connectionUri`
- **Backward compatibility**: jobs without `dbType` resolve to postgresql; catalog records without `dbType` resolve to postgresql on restore
- **Format validation**: valid formats accepted per driver; invalid formats rejected

### Property-Based Tests (fast-check)

Located in `tests/backup/multiDbBackup.property.test.js`:

Uses `fast-check` (already in `devDependencies`). Each property test runs a minimum of 100 iterations.

**Generators needed:**
- `fc.constantFrom('postgresql', 'mysql', 'mariadb', 'mongodb')` — valid dbType
- `fc.string()` filtered to exclude valid dbTypes — invalid dbType
- `fc.record({ host: fc.string(), port: fc.integer(), database: fc.string(), user: fc.string(), password: fc.string() })` — source config
- `fc.webUrl()` or `fc.string()` — connection URI
- `fc.constantFrom('custom', 'plain', 'directory', 'tar', 'sql', 'archive')` — format values

Tag format for each test: `// Feature: multi-db-backup-support, Property N: <property text>`

### Integration Tests

- **Connection test endpoint**: mock `spawn` and `pg` client; assert correct tool is invoked per `dbType`; assert HTTP 400 for invalid `dbType`
- **Backup run endpoint**: mock `spawn`; assert correct tool is invoked per `dbType`; assert format validation rejects invalid combinations

### Docker Smoke Tests

After building the image, run:
```sh
docker run --rm <image> pg_dump --version
docker run --rm <image> mysqldump --version
docker run --rm <image> mongodump --version
docker run --rm <image> mongosh --version
```

These are manual verification steps, not automated unit tests.

---

## Dockerfile Changes

The `RUN apk add` line in the runtime stage is extended to include MySQL and MongoDB client tools in a single layer:

```dockerfile
# Install database client tools for all supported backup types.
# All packages are installed in a single layer to minimise image size.
RUN apk add --no-cache \
    postgresql16-client \
    mysql-client \
    && \
    # MongoDB tools are not in the standard Alpine repos.
    # Install from the official MongoDB Alpine-compatible tarballs.
    # mongodump, mongorestore: from mongodb-database-tools
    # mongosh: from mongosh package
    # See: https://www.mongodb.com/try/download/database-tools
    wget -qO /tmp/mongo-tools.tgz "https://fastdl.mongodb.org/tools/db/mongodb-database-tools-alpine-x86_64-100.9.4.tgz" \
    && tar -xzf /tmp/mongo-tools.tgz -C /usr/local/bin --strip-components=2 \
    && rm /tmp/mongo-tools.tgz \
    && wget -qO /tmp/mongosh.tgz "https://downloads.mongodb.com/compass/mongosh-2.2.5-linux-x64.tgz" \
    && tar -xzf /tmp/mongosh.tgz -C /usr/local/bin --strip-components=2 \
    && rm /tmp/mongosh.tgz
```

> **Note**: The exact MongoDB tool URLs and versions should be pinned to the latest stable release at implementation time. The Alpine `mysql-client` package provides `mysqldump` and `mysql`. If the Alpine version of `mysql-client` is not available or conflicts, the `mariadb-client` package (which provides compatible `mysqldump`/`mysql` binaries) is an acceptable alternative.

---

## Frontend Changes

### Database Type Selector

A new "Database Type" `<select>` element is added to the Backup tab's connection form, above the existing connection fields:

```html
<div>
  <label class="label">Database Type</label>
  <select class="inp" id="backup-db-type">
    <option value="postgresql">PostgreSQL</option>
    <option value="mysql">MySQL</option>
    <option value="mariadb">MariaDB</option>
    <option value="mongodb">MongoDB</option>
  </select>
</div>
```

### Adaptive Field Visibility

A `updateBackupFormForDbType(dbType)` function in `app.js` controls field visibility:

| Field | postgresql | mysql | mariadb | mongodb |
|-------|-----------|-------|---------|---------|
| Host | ✓ | ✓ | ✓ | ✗ |
| Port | ✓ | ✓ | ✓ | ✗ |
| Database Name | ✓ | ✓ | ✓ | ✗ |
| Username | ✓ | ✓ | ✓ | ✗ |
| Password | ✓ | ✓ | ✓ | ✗ |
| Schema | ✓ | ✗ | ✗ | ✗ |
| Connection URI | ✗ | ✗ | ✗ | ✓ |
| Auth Database | ✗ | ✗ | ✗ | ✓ |

Port defaults: PostgreSQL → `5432`, MySQL/MariaDB → `3306`. When the type changes, the port field is updated to the new default only if the current value matches the old default (to avoid overwriting a user-entered custom port).

### Format Selector Filtering

The backup format `<select>` is filtered based on `dbType`:

```js
const FORMAT_OPTIONS = {
  postgresql: [
    { value: 'custom',    label: 'Custom (pg_dump -Fc)' },
    { value: 'plain',     label: 'Plain SQL' },
    { value: 'directory', label: 'Directory' },
    { value: 'tar',       label: 'Tar' },
  ],
  mysql:    [{ value: 'sql', label: 'SQL Dump' }],
  mariadb:  [{ value: 'sql', label: 'SQL Dump' }],
  mongodb:  [
    { value: 'archive',   label: 'Archive (single-file BSON)' },
    { value: 'directory', label: 'Directory (multi-file BSON)' },
  ],
};
```

When the type changes, the format selector is repopulated and reset to the first option for the new type.

### Connection Test Button

The existing "Test" button in the Backup tab's connection form is wired to `POST /api/backup/test-db-connection` instead of the existing PostgreSQL-only endpoint. The request body is assembled by `getBackupConnectionTestPayload()` which reads `dbType` and the appropriate fields (individual fields for postgresql/mysql/mariadb, `connectionUri` for mongodb).

### Config Serialization

`getBackupConfig()` in `app.js` is extended to include `dbType` and the MongoDB-specific fields:

```js
source: {
  dbType: v('backup-db-type') || 'postgresql',
  host: v('backup-src-host'),
  port: parseInt(v('backup-src-port')) || undefined,
  database: v('backup-src-database'),
  user: v('backup-src-user'),
  password: v('backup-src-password'),
  schema: v('backup-src-schema') || undefined,
  connectionUri: v('backup-src-connection-uri') || undefined,
  authDatabase: v('backup-src-auth-database') || undefined,
},
```

The `dbType` field is also hoisted to the top level of the job config (alongside `format`, `compression`, etc.) since `BackupEngine` reads it from `jobConfig.dbType`.
