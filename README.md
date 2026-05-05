# S3 Backup Studio

A self-hosted, real-time backup and sync tool with a web UI. Supports S3-to-S3 object sync and PostgreSQL-to-PostgreSQL table sync, with live progress, job scheduling, notifications, and Prometheus metrics.

![Node.js](https://img.shields.io/badge/Node.js-20-green) ![License](https://img.shields.io/badge/license-MIT-blue)

---

## Features

### S3 Sync
- Sync between any two S3-compatible buckets (AWS S3, MinIO, DigitalOcean Spaces, Wasabi, etc.)
- Concurrent transfers with a configurable worker pool (up to 50 parallel uploads)
- Automatic multipart upload for large files (configurable threshold, default 100 MB)
- Bandwidth throttling via a shared token-bucket rate limiter
- Include/exclude glob pattern filtering
- Orphan deletion — remove destination files that no longer exist in the source
- Dry-run mode — preview what would be synced without touching anything
- Resumable syncs — checkpoints are saved every 100 files so interrupted runs can continue
- Retry failed files from the last run without re-scanning everything
- Scheduled repeat syncs (configurable interval in seconds)

### Database Sync (PostgreSQL)
- Table-by-table sync between two PostgreSQL databases
- Schema-aware: configurable source and destination schemas
- Include/exclude table lists
- Table renaming support
- Concurrent table sync (up to 10 parallel workers)
- Dry-run mode
- Retry failed tables

### Cluster Monitoring
- Connect to a PostgreSQL primary and inspect replication status
- View replica lag (in MB), sync/async replica counts, and WAL positions
- Replication lag alerting (threshold: 100 MB)

### Operations
- Real-time log streaming and progress stats via WebSocket (Socket.io)
- Persistent sync history (last 100 runs, stored in `data/history.json`)
- Named job storage — save and reload sync configurations (stored in `data/jobs.json`)
- Prometheus metrics endpoint at `/metrics`
- HTTP Basic Auth for the entire UI and API
- Webhook notifications (Slack, Discord, or any HTTP endpoint)
- SMTP email notifications with HTML and plain-text bodies
- Graceful shutdown on `SIGTERM`/`SIGINT`

---

## Quick Start

### Prerequisites
- Node.js 20+
- npm

### Run locally

```bash
# 1. Clone and install
git clone <repo-url>
cd s3-backup-studio
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — set AUTH_USER and AUTH_PASSWORD at minimum

# 3. Start
npm start
```

Open `http://localhost:3000` in your browser.

---

## Docker

### Using Docker Compose (recommended)

```bash
# 1. Copy and configure environment
cp .env.example .env
# Edit .env — set AUTH_USER and AUTH_PASSWORD at minimum

# 2. Build and start
docker compose up -d --build

# 3. Check status
docker compose ps
docker compose logs -f
```

Open `http://localhost:3000` (or your configured `PORT`).

Data and logs are persisted in named Docker volumes (`s3backup-data`, `s3backup-logs`) and survive container restarts and image rebuilds.

### Updating to a new version

```bash
docker compose pull          # if using a registry image
docker compose up -d --build # rebuild from source
```

### Build and run manually

```bash
docker build -t s3-backup-studio .
docker run -d \
  --name s3-backup-studio \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  -v s3backup-data:/app/data \
  -v s3backup-logs:/app/logs \
  s3-backup-studio
```

### What's included in the image

- Node.js 20 (Alpine)
- `pg_dump`, `pg_restore`, `psql` (PostgreSQL 16 client) — required for the database backup feature
- Non-root `appuser` for least-privilege execution
- `/ping` healthcheck endpoint (no auth required, used by Docker and load balancers)

---

## PM2

```bash
npm install -g pm2

# Start
pm2 start ecosystem.config.cjs --env production

# Persist across reboots
pm2 save && pm2 startup

# Logs
pm2 logs s3-backup-studio

# Monitor
pm2 monit
```

> The app must run as a single instance (`instances: 1`) because the sync engine is stateful in-memory.

---

## Configuration

All configuration is via environment variables.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | `development` | `production` or `development` |
| `AUTH_USER` | _(none)_ | HTTP Basic Auth username. Leave blank to disable auth. |
| `AUTH_PASSWORD` | _(none)_ | HTTP Basic Auth password. Leave blank to disable auth. |
| `ALLOWED_ORIGIN` | `*` (dev) / `false` (prod) | CORS origin for WebSocket connections. Set to your public domain in production. |

Copy `.env.example` to `.env` and fill in the values.

---

## API Reference

All endpoints (except `/ping`) require HTTP Basic Auth when `AUTH_USER` and `AUTH_PASSWORD` are set.

### Health & Metrics

| Method | Path | Description |
|---|---|---|
| `GET` | `/ping` | Liveness probe — always returns `{"ok":true}`, no auth required |
| `GET` | `/health` | Detailed health: uptime, memory, sync status |
| `GET` | `/metrics` | Prometheus metrics (text/plain) |

### S3 Sync

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/test-connection` | Test S3 credentials and bucket access |
| `POST` | `/api/start` | Start a sync |
| `POST` | `/api/stop` | Stop the running sync |
| `GET` | `/api/status` | Current sync status and stats |
| `POST` | `/api/retry-failed` | Retry files that failed in the last run |

#### `POST /api/start` body

```json
{
  "source": {
    "bucket": "my-source-bucket",
    "accessKeyId": "AKIA...",
    "secretAccessKey": "...",
    "region": "us-east-1",
    "prefix": "optional/prefix/",
    "endpoint": "https://custom-endpoint.com"
  },
  "dest": {
    "bucket": "my-backup-bucket",
    "accessKeyId": "AKIA...",
    "secretAccessKey": "...",
    "region": "us-west-2"
  },
  "settings": {
    "concurrency": 5,
    "maxBandwidthMbps": 0,
    "fileTimeoutMinutes": 30,
    "multipartThresholdMb": 100,
    "intervalSeconds": 0,
    "deleteOrphaned": false,
    "dryRun": false,
    "includePatterns": ["*.jpg", "backups/**"],
    "excludePatterns": ["temp/**", "*.tmp"]
  },
  "notifications": {
    "webhook": { "url": "https://hooks.slack.com/...", "onComplete": true, "onFailure": true },
    "email": { "host": "smtp.gmail.com", "port": 587, "user": "...", "pass": "...", "to": "admin@example.com", "onComplete": true, "onFailure": true }
  },
  "name": "prod-to-dr"
}
```

### Database Sync

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/db/test-connection` | Test PostgreSQL connection |
| `POST` | `/api/db/start` | Start a database sync |
| `POST` | `/api/db/stop` | Stop the running database sync |
| `GET` | `/api/db/status` | Current database sync status and stats |
| `POST` | `/api/db/retry-failed` | Retry tables that failed in the last run |

#### `POST /api/db/start` body

```json
{
  "source": { "host": "primary.db.example.com", "port": 5432, "database": "mydb", "user": "postgres", "password": "..." },
  "dest":   { "host": "replica.db.example.com", "port": 5432, "database": "backup_db", "user": "postgres", "password": "..." },
  "settings": {
    "sourceSchema": "public",
    "destSchema": "public",
    "concurrency": 5,
    "intervalSeconds": 0,
    "includeTables": [],
    "excludeTables": ["logs", "audit"],
    "renameTables": { "users": "users_backup" },
    "dryRun": false
  }
}
```

### Cluster Monitoring

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/cluster/connect` | Connect to a PostgreSQL primary |
| `GET` | `/api/cluster/status` | Replication status and WAL info |
| `GET` | `/api/cluster/replicas` | Replica lag details |
| `GET` | `/api/cluster/lag` | Replication lag check with alert flag |
| `GET` | `/api/cluster/disconnect` | Disconnect from cluster |

### Saved Jobs

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/jobs` | List all saved jobs (secrets redacted) |
| `GET` | `/api/jobs/:id` | Get a single job (includes secrets) |
| `POST` | `/api/jobs` | Create a saved job |
| `PUT` | `/api/jobs/:id` | Update a saved job |
| `DELETE` | `/api/jobs/:id` | Delete a saved job |
| `POST` | `/api/jobs/:id/start` | Start a saved job |

### History & Checkpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/history` | Last 100 sync run records |
| `DELETE` | `/api/history` | Clear history |
| `GET` | `/api/checkpoints` | List resumable checkpoints |
| `DELETE` | `/api/checkpoints/:key` | Delete a checkpoint |

### Notifications

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/test-webhook` | Send a test webhook payload |
| `POST` | `/api/test-email` | Send a test email |

---

## Prometheus Metrics

The `/metrics` endpoint exposes metrics in the Prometheus text format.

| Metric | Type | Description |
|---|---|---|
| `s3bs_sync_running` | gauge | `1` if an S3 sync is active |
| `s3bs_current_total_files` | gauge | Files discovered in the current/last run |
| `s3bs_current_synced_files` | gauge | Files successfully synced |
| `s3bs_current_failed_files` | gauge | Files that failed |
| `s3bs_current_bytes_transferred` | gauge | Bytes transferred |
| `s3bs_lifetime_syncs_total` | counter | Total sync runs since process start |
| `s3bs_lifetime_files_synced_total` | counter | Total files synced since process start |
| `s3bs_lifetime_bytes_total` | counter | Total bytes transferred since process start |
| `s3bs_db_sync_running` | gauge | `1` if a database sync is active |
| `s3bs_db_current_synced_tables` | gauge | Tables synced in current/last run |
| `s3bs_db_current_synced_rows` | gauge | Rows synced in current/last run |
| `process_resident_memory_bytes` | gauge | Process RSS memory |
| `process_uptime_seconds` | gauge | Process uptime |

---

## WebSocket Events

The UI connects via Socket.io. You can also consume these events programmatically.

| Event | Direction | Description |
|---|---|---|
| `log` | server → client | Log line: `{ ts, level, message }` |
| `sync:stats` | server → client | Live S3 sync stats |
| `sync:started` | server → client | Sync started with totals |
| `sync:stopped` | server → client | Sync finished with reason and final stats |
| `sync:file_done` | server → client | Single file synced or deleted |
| `sync:file_error` | server → client | Single file failed |
| `sync:resumed` | server → client | Sync resumed from checkpoint |
| `db:sync:stats` | server → client | Live database sync stats |
| `db:sync:started` | server → client | Database sync started |
| `db:sync:stopped` | server → client | Database sync finished |
| `db:sync:table_done` | server → client | Single table synced |
| `db:sync:table_error` | server → client | Single table failed |
| `jobs:update` | server → client | Active job list updated |

---

## Data Persistence

| Path | Contents |
|---|---|
| `data/jobs.json` | Saved job configurations |
| `data/history.json` | Last 100 sync run records |
| `data/checkpoints/` | Resumable checkpoint files (one per bucket pair) |
| `logs/` | Daily log files (`YYYY-MM-DD.log`) and PM2 logs |

When running in Docker, mount these paths as volumes to persist data across container restarts (the `docker-compose.yml` does this automatically).

---

## Security

- **HTTP Basic Auth** — enabled by setting `AUTH_USER` and `AUTH_PASSWORD`. Uses timing-safe comparison to prevent timing attacks.
- **Rate limiting** — API endpoints are rate-limited (300 req/15 min general, 20 req/min for connection tests, 10 req/min for sync starts).
- **Helmet** — standard HTTP security headers applied via `helmet`.
- **Non-root Docker user** — the container runs as an unprivileged `appuser`.
- **Secret redaction** — the job list API strips `secretAccessKey` values from responses.
- The `/ping` endpoint is intentionally unauthenticated for use by Docker/Kubernetes health checks.

---

## Development

```bash
# Watch mode (restarts on file changes)
npm run dev
```

The app uses ES modules (`"type": "module"` in `package.json`). Node.js 20+ is required.

---

## Architecture

```
server.js          Express + Socket.io server, all HTTP routes
src/
  syncEngine.js    S3 sync orchestration (list → diff → copy → delete)
  dbSyncEngine.js  PostgreSQL sync orchestration (list tables → copy rows)
  s3Client.js      AWS SDK v3 S3 client helpers (stream list, copy, delete)
  dbClient.js      pg Pool helpers (dump/restore tables)
  dbCluster.js     PostgreSQL replication monitoring queries
  syncState.js     In-memory S3 sync state and stats
  dbSyncState.js   In-memory DB sync state and stats
  rateLimiter.js   Token-bucket bandwidth limiter (shared across all transfers)
  checkpoint.js    Resumable checkpoint read/write (data/checkpoints/)
  history.js       Sync run history (data/history.json)
  jobStore.js      Saved job CRUD (data/jobs.json)
  jobRunner.js     In-memory active job tracking
  notifier.js      Webhook and SMTP email notifications
  metrics.js       Prometheus metrics text generation
  logger.js        Structured logger (stdout + daily log file + Socket.io)
public/
  index.html       Single-page UI (Tailwind CSS, Chart.js, Socket.io client)
  app.js           Frontend JavaScript
```
