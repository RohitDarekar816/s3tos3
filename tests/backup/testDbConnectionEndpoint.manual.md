# Manual Testing Guide for POST /api/backup/test-db-connection

This endpoint tests database connections for multiple database types.

## Endpoint Details

- **URL**: `POST /api/backup/test-db-connection`
- **Rate Limit**: 20 requests per minute (testLimiter)
- **Authentication**: Basic Auth (if enabled)

## Request Format

### PostgreSQL
```bash
curl -X POST http://localhost:3000/api/backup/test-db-connection \
  -H "Content-Type: application/json" \
  -d '{
    "dbType": "postgresql",
    "host": "localhost",
    "port": 5432,
    "database": "mydb",
    "user": "postgres",
    "password": "secret"
  }'
```

### MySQL
```bash
curl -X POST http://localhost:3000/api/backup/test-db-connection \
  -H "Content-Type: application/json" \
  -d '{
    "dbType": "mysql",
    "host": "localhost",
    "port": 3306,
    "database": "mydb",
    "user": "root",
    "password": "secret"
  }'
```

### MariaDB
```bash
curl -X POST http://localhost:3000/api/backup/test-db-connection \
  -H "Content-Type: application/json" \
  -d '{
    "dbType": "mariadb",
    "host": "localhost",
    "port": 3306,
    "database": "mydb",
    "user": "root",
    "password": "secret"
  }'
```

### MongoDB
```bash
curl -X POST http://localhost:3000/api/backup/test-db-connection \
  -H "Content-Type: application/json" \
  -d '{
    "dbType": "mongodb",
    "connectionUri": "mongodb://user:pass@localhost:27017/mydb"
  }'
```

## Response Format

### Success Response
```json
{
  "ok": true,
  "version": "PostgreSQL 16.2 on x86_64-pc-linux-gnu"
}
```

### Error Response (Invalid dbType)
```json
{
  "ok": false,
  "error": "Unsupported dbType \"oracle\". Valid values: postgresql, mysql, mariadb, mongodb"
}
```

### Error Response (Missing Fields)
```json
{
  "ok": false,
  "error": "Missing required fields: host, database, user, password"
}
```

### Error Response (Connection Failed)
```json
{
  "ok": false,
  "error": "Connection refused"
}
```

## Test Cases

### 1. Valid PostgreSQL Connection
- **Expected**: `{ ok: true, version: "..." }`
- **Status Code**: 200

### 2. Valid MySQL Connection
- **Expected**: `{ ok: true, version: "..." }`
- **Status Code**: 200

### 3. Valid MariaDB Connection
- **Expected**: `{ ok: true, version: "..." }`
- **Status Code**: 200

### 4. Valid MongoDB Connection
- **Expected**: `{ ok: true, version: "..." }`
- **Status Code**: 200

### 5. Invalid dbType
- **Expected**: `{ ok: false, error: "Unsupported dbType..." }`
- **Status Code**: 400

### 6. Missing connectionUri for MongoDB
- **Expected**: `{ ok: false, error: "Missing required field: connectionUri" }`
- **Status Code**: 400

### 7. Missing host/database/user/password for PostgreSQL/MySQL/MariaDB
- **Expected**: `{ ok: false, error: "Missing required fields..." }`
- **Status Code**: 400

### 8. Connection Failure (wrong credentials)
- **Expected**: `{ ok: false, error: "..." }`
- **Status Code**: 200 (connection test failed, not a request error)

### 9. Rate Limiting
- **Expected**: After 20 requests in 1 minute, should return rate limit error
- **Status Code**: 429
