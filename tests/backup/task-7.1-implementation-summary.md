# Task 7.1 Implementation Summary

## Task Description
Implement `POST /api/backup/test-db-connection` endpoint in `server.js` for testing database connections across all supported database types.

## Requirements
- Accept request body with `dbType` and connection parameters
  - For postgresql/mysql/mariadb: host, port, database, user, password
  - For mongodb: connectionUri
- Use `getDriver(dbType)` to select the appropriate driver
- Call `driver.testConnection(config)` and return the result
- Return HTTP 400 for unsupported `dbType` values
- Apply rate limiting (reuse existing `testLimiter`)

## Implementation Details

### 1. Modified Files

#### `src/backupEngine.js`
- **Change**: Exported the `getDriver` function
- **Location**: Line ~47-62
- **Reason**: The function was previously internal but needs to be accessible from `server.js`

#### `server.js`
- **Change 1**: Added `getDriver` to imports from `backupEngine.js`
  - **Location**: Line ~25
  
- **Change 2**: Implemented new endpoint `POST /api/backup/test-db-connection`
  - **Location**: Lines ~640-677
  - **Features**:
    - Rate limited with `testLimiter` (20 requests/minute)
    - Validates `dbType` using `getDriver()`
    - Returns HTTP 400 for unsupported database types
    - Validates required fields based on database type
    - Calls appropriate driver's `testConnection()` method
    - Returns connection test result

### 2. Endpoint Behavior

#### Request Format
```json
// PostgreSQL/MySQL/MariaDB
{
  "dbType": "postgresql",
  "host": "localhost",
  "port": 5432,
  "database": "mydb",
  "user": "postgres",
  "password": "secret"
}

// MongoDB
{
  "dbType": "mongodb",
  "connectionUri": "mongodb://user:pass@localhost:27017/mydb"
}
```

#### Response Format
```json
// Success
{
  "ok": true,
  "version": "PostgreSQL 16.2 on x86_64-pc-linux-gnu"
}

// Error - Invalid dbType
{
  "ok": false,
  "error": "Unsupported dbType \"oracle\". Valid values: postgresql, mysql, mariadb, mongodb"
}

// Error - Missing Fields
{
  "ok": false,
  "error": "Missing required fields: host, database, user, password"
}

// Error - Connection Failed
{
  "ok": false,
  "error": "Connection refused"
}
```

#### HTTP Status Codes
- **200**: Connection test completed (check `ok` field for success/failure)
- **400**: Invalid request (unsupported dbType or missing required fields)
- **429**: Rate limit exceeded

### 3. Validation Logic

#### dbType Validation
- Supported values: `postgresql`, `mysql`, `mariadb`, `mongodb`
- Invalid values return HTTP 400 with error message listing valid values
- Null/undefined defaults to `postgresql` (backward compatibility)

#### Field Validation
- **PostgreSQL/MySQL/MariaDB**: Requires `host`, `database`, `user`, `password`
- **MongoDB**: Requires `connectionUri`
- Missing fields return HTTP 400 with descriptive error message

### 4. Driver Integration

The endpoint uses the existing driver architecture:
- `getDriver(dbType)` returns the appropriate driver module
- Each driver implements `testConnection(config)` method
- PostgreSQL: Uses `pg` Node.js client
- MySQL/MariaDB: Uses `mysqladmin ping` CLI
- MongoDB: Uses `mongosh --eval "db.runCommand({ping:1})"` CLI

### 5. Rate Limiting

- Uses existing `testLimiter` middleware
- Limit: 20 requests per 60 seconds
- Returns HTTP 429 when limit exceeded
- Error message: "Too many test-connection requests."

## Testing

### Unit Tests
Created `tests/backup/testDbConnectionEndpoint.test.js` with 20 test cases:

1. **Driver Selection Tests** (6 tests)
   - Correct driver for each valid dbType
   - Default to postgresql for null/undefined
   - Error for unsupported dbType

2. **Validation Tests** (4 tests)
   - Required fields for each database type

3. **Error Handling Tests** (3 tests)
   - Error message includes valid dbTypes
   - Error has status property set to 400

4. **Backward Compatibility Tests** (3 tests)
   - Defaults to postgresql for null/undefined/empty string

5. **Integration Tests** (4 tests)
   - All valid dbTypes work correctly
   - All invalid dbTypes throw errors

### Test Results
```
✓ tests/backup/testDbConnectionEndpoint.test.js (20 tests)
✓ All existing backup tests (118 tests)
```

### Manual Testing
Created `tests/backup/testDbConnectionEndpoint.manual.md` with:
- cURL examples for each database type
- Expected responses for success/error cases
- Test cases for validation and error handling

## Requirements Validation

✅ **Requirement 1.4**: Invalid dbType values are rejected with HTTP 400
✅ **Requirement 8.1**: UI can send connection test request with dbType and parameters
✅ **Requirement 8.2**: PostgreSQL connections tested with pg Node.js client
✅ **Requirement 8.3**: MySQL/MariaDB connections tested with mysqladmin ping
✅ **Requirement 8.4**: MongoDB connections tested with mongosh ping
✅ **Requirement 8.5**: Success returns green indicator with version string
✅ **Requirement 8.6**: Failure returns red indicator with error message
✅ **Requirement 8.7**: Unsupported dbType returns HTTP 400

## Backward Compatibility

- Existing `/api/db/test-connection` endpoint remains unchanged
- New endpoint is separate and doesn't affect existing functionality
- `getDriver()` defaults to postgresql for null/undefined dbType
- All existing tests continue to pass

## Security Considerations

- Passwords are not logged or exposed in error messages
- Rate limiting prevents brute force attacks
- Basic authentication applies to this endpoint (if enabled)
- Connection parameters are validated before use

## Next Steps

This endpoint is ready for integration with the frontend UI. The frontend should:
1. Add a "Test Connection" button to the backup job form
2. Call this endpoint with the current form values
3. Display success/error indicator based on response
4. Show version string on success or error message on failure
