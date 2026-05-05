# Requirements Document

## Introduction

This feature adds database connection testing to the database sync workflow. Users can verify that their source and target PostgreSQL database credentials are correct before starting a sync job. A "Test" button next to each database configuration panel sends the credentials to the backend, attempts a real connection, and reports success or failure inline — matching the existing S3 connection-test UX pattern already present in the application.

## Glossary

- **Connection_Tester**: The frontend component responsible for collecting database credentials from the UI and invoking the test-connection API.
- **DB_Test_API**: The backend HTTP endpoint (`POST /api/db/test-connection`) that accepts a database configuration object and returns a connection result.
- **DB_Client**: The `src/dbClient.js` module that establishes a PostgreSQL connection and executes a probe query.
- **Status_Indicator**: The colored dot element next to each database panel header that reflects the last known connection state (untested, success, or failure).
- **Source_Database**: The PostgreSQL database from which data is read during a sync job.
- **Target_Database**: The PostgreSQL database to which data is written during a sync job.
- **Credential_Fields**: The set of form inputs required to connect to a database: host, port, database name, username, and password.

---

## Requirements

### Requirement 1: Test Source Database Connection

**User Story:** As a user, I want to test the connection to the source database, so that I can confirm my source credentials are correct before starting a sync.

#### Acceptance Criteria

1. WHEN the user clicks the "Test" button in the Source Database panel, THE Connection_Tester SHALL collect the current values of all source Credential_Fields from the UI.
2. WHEN the user clicks the "Test" button in the Source Database panel, THE Connection_Tester SHALL send a POST request to the DB_Test_API with the collected source configuration.
3. WHILE the connection test is in progress, THE Connection_Tester SHALL display a loading indicator on the "Test" button and set the Status_Indicator to amber.
4. WHEN the DB_Test_API returns a successful result, THE Connection_Tester SHALL set the source Status_Indicator to green and append a success entry to the activity log.
5. WHEN the DB_Test_API returns a failure result, THE Connection_Tester SHALL set the source Status_Indicator to red and append an error entry to the activity log containing the error message.
6. WHEN the user modifies any source Credential_Field after a test, THE Connection_Tester SHALL reset the source Status_Indicator to the untested (grey) state.

---

### Requirement 2: Test Target Database Connection

**User Story:** As a user, I want to test the connection to the target database, so that I can confirm my target credentials are correct before starting a sync.

#### Acceptance Criteria

1. WHEN the user clicks the "Test" button in the Target Database panel, THE Connection_Tester SHALL collect the current values of all target Credential_Fields from the UI.
2. WHEN the user clicks the "Test" button in the Target Database panel, THE Connection_Tester SHALL send a POST request to the DB_Test_API with the collected target configuration.
3. WHILE the connection test is in progress, THE Connection_Tester SHALL display a loading indicator on the "Test" button and set the Status_Indicator to amber.
4. WHEN the DB_Test_API returns a successful result, THE Connection_Tester SHALL set the target Status_Indicator to green and append a success entry to the activity log.
5. WHEN the DB_Test_API returns a failure result, THE Connection_Tester SHALL set the target Status_Indicator to red and append an error entry to the activity log containing the error message.
6. WHEN the user modifies any target Credential_Field after a test, THE Connection_Tester SHALL reset the target Status_Indicator to the untested (grey) state.

---

### Requirement 3: Backend Connection Validation

**User Story:** As a developer, I want the backend to validate database credentials by attempting a real connection, so that the test result accurately reflects whether the database is reachable.

#### Acceptance Criteria

1. WHEN the DB_Test_API receives a request, THE DB_Client SHALL attempt to open a TCP connection to the specified host and port and authenticate with the provided credentials.
2. WHEN the DB_Client successfully connects, THE DB_Test_API SHALL return `{ ok: true, version: <server_version_string> }`.
3. WHEN the DB_Client fails to connect, THE DB_Test_API SHALL return `{ ok: false, error: <descriptive_error_message> }`.
4. IF the request body is missing any required Credential_Field (host, database, user, or password), THEN THE DB_Test_API SHALL return HTTP 400 with `{ ok: false, error: "Missing required fields" }`.
5. THE DB_Test_API SHALL close the test connection after the probe query completes, regardless of success or failure.
6. THE DB_Test_API SHALL respond within 15 seconds; IF the database does not respond within 10 seconds, THEN THE DB_Client SHALL return a timeout error.

---

### Requirement 4: Input Validation Before Test

**User Story:** As a user, I want to be prevented from triggering a test with incomplete credentials, so that I receive clear feedback rather than a confusing network error.

#### Acceptance Criteria

1. WHEN the user clicks the "Test" button and any required Credential_Field (host, database, username, or password) is empty, THE Connection_Tester SHALL append an error entry to the activity log describing which fields are missing and SHALL NOT send a request to the DB_Test_API.
2. THE Connection_Tester SHALL validate Credential_Fields before sending the request, without requiring a round-trip to the server.

---

### Requirement 5: Rate Limiting for Test Endpoint

**User Story:** As an operator, I want the test-connection endpoint to be rate-limited, so that the server is protected from credential-stuffing or accidental request floods.

#### Acceptance Criteria

1. THE DB_Test_API SHALL apply a rate limit of no more than 20 requests per 60-second window per IP address.
2. WHEN a client exceeds the rate limit, THE DB_Test_API SHALL return HTTP 429 with `{ ok: false, error: "Too many test-connection requests." }`.
