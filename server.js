import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { init as initLogger, log, isDebugEnabled } from './src/logger.js';
import { initEngine, startSync, stopSync, retryFailed } from './src/syncEngine.js';
import { testConnection } from './src/s3Client.js';
import { testConnection as testDbConnection } from './src/dbClient.js';
import { initDbEngine, startDbSync, stopDbSync, retryFailedDbTables, dbState } from './src/dbSyncEngine.js';
import { getClusterStatus, getReplicaLag, checkReplicationLag, buildClusterPool } from './src/dbCluster.js';
import { state } from './src/syncState.js';
import { getMetricsText } from './src/metrics.js';
import { listJobs, getJob, createJob, updateJob, deleteJob } from './src/jobStore.js';
import { initJobManager, addJob, getActiveJobs, updateJobProgress, removeJob, pauseJob, resumeJob, stopJob } from './src/jobRunner.js';
import { getHistory, clearHistory } from './src/history.js';
import { listCheckpoints, removeCheckpoint } from './src/checkpoint.js';
import { sendWebhook, sendEmail } from './src/notifier.js';
import { initBackupEngine, startBackup, startRestore, verifyBackup, applyRetention, rotateKey, validateFormat, validateCompressionLevel, getDriver } from './src/backupEngine.js';
import { listBackupJobs, getBackupJob, createBackupJob, updateBackupJob, deleteBackupJob } from './src/backupJobStore.js';
import { listCatalog, getCatalogRecord, updateCatalogRecord } from './src/backupCatalog.js';
import { initScheduler, scheduleJob, unscheduleJob, rescheduleJob } from './src/backupScheduler.js';
import { deleteFromTarget } from './src/backupStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT      = parseInt(process.env.PORT || '3000', 10);
const NODE_ENV  = process.env.NODE_ENV || 'development';
const IS_PROD   = NODE_ENV === 'production';

function getCorsOrigin() {
  const allowed = process.env.ALLOWED_ORIGIN;
  if (!allowed) return IS_PROD ? false : '*';
  if (allowed === '*') return '*';
  if (allowed.includes(',')) return allowed.split(',').map(o => o.trim());
  return allowed;
}

// ── App & WebSocket ────────────────────────────────────────────────────────

const app        = express();
const httpServer = createServer(app);
const io         = new Server(httpServer, {
  cors: {
    origin: getCorsOrigin(),
    methods: ['GET', 'POST'],
  },
  pingTimeout:  60_000,
  pingInterval: 25_000,
});

// ── Security ───────────────────────────────────────────────────────────────

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  hsts: false,
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 300,
  standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: 'Too many requests — try again later.' },
});
const testLimiter = rateLimit({
  windowMs: 60 * 1000, max: 20,
  message: { ok: false, error: 'Too many test-connection requests.' },
});
const startLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  message: { ok: false, error: 'Too many sync start requests.' },
});

const AUTH_USER     = process.env.AUTH_USER;
const AUTH_PASSWORD = process.env.AUTH_PASSWORD;
const AUTH_ENABLED  = !!(AUTH_USER && AUTH_PASSWORD);

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) { crypto.timingSafeEqual(Buffer.alloc(1), Buffer.alloc(1)); return false; }
  return crypto.timingSafeEqual(ba, bb);
}

function basicAuth(req, res, next) {
  if (!AUTH_ENABLED) return next();
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="S3 Backup Studio"');
    return res.status(401).end('Authentication required');
  }
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colon   = decoded.indexOf(':');
  const u = decoded.slice(0, colon);
  const p = decoded.slice(colon + 1);
  if (!timingSafeEqual(u, AUTH_USER) || !timingSafeEqual(p, AUTH_PASSWORD)) {
    res.set('WWW-Authenticate', 'Basic realm="S3 Backup Studio"');
    return res.status(401).end('Invalid credentials');
  }
  next();
}

// ── Middleware ─────────────────────────────────────────────────────────────

// Public liveness probe — registered before basicAuth so Docker/k8s healthchecks work without credentials
app.get('/ping', (_req, res) => res.json({ ok: true }));

app.use(basicAuth);
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', apiLimiter);
app.use('/api/test-connection', testLimiter);

initLogger(io);
initEngine(io);
initDbEngine(io);
initJobManager(io);
initScheduler(io);

// ── Debug HTTP request logging ─────────────────────────────────────────────
// Only active when LOG_LEVEL=debug — logs every request with method, path,
// status code, and response time.
app.use((req, res, next) => {
  if (!isDebugEnabled()) return next();
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const color = res.statusCode >= 500 ? 'error'
                : res.statusCode >= 400 ? 'warning'
                : 'debug';
    log(color, `HTTP ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// Declared here so /health and cluster routes can reference it safely.
let _clusterPool = null;

// ── Routes ─────────────────────────────────────────────────────────────────

app.get('/health', basicAuth, (_req, res) => res.json({
  status: 'ok', uptime: Math.floor(process.uptime()),
  memory: process.memoryUsage(),
  sync: { running: state.running },
  dbSync: { running: dbState.running },
  cluster: { connected: !!_clusterPool },
  version: '1.0.0', timestamp: new Date().toISOString(),
}));

// Prometheus metrics — protected so internal stats aren't public
app.get('/metrics', basicAuth, (_req, res) => {
  res.set('Content-Type', 'text/plain; version=0.0.4');
  res.send(getMetricsText());
});

// ── Sync control ───────────────────────────────────────────────────────────

app.post('/api/test-connection', async (req, res) => {
  const { config } = req.body;
  if (!config?.bucket || !config?.accessKeyId || !config?.secretAccessKey)
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  res.json(await testConnection(config));
});

app.post('/api/start', startLimiter, (req, res) => {
  const { source, dest, settings, notifications, name } = req.body;
  if (state.running)
    return res.status(409).json({ ok: false, error: 'A sync is already running' });
  if (!source?.bucket || !source?.accessKeyId || !source?.secretAccessKey)
    return res.status(400).json({ ok: false, error: 'Source configuration is incomplete' });
  if (!dest?.bucket || !dest?.accessKeyId || !dest?.secretAccessKey)
    return res.status(400).json({ ok: false, error: 'Destination configuration is incomplete' });

  const s = settings || {};
  const safeSettings = {
    ...s,
    concurrency:        Math.max(1, Math.min(parseInt(s.concurrency)        || 5,   50)),
    fileTimeoutMinutes: Math.max(1, Math.min(parseInt(s.fileTimeoutMinutes) || 30, 1440)),
    maxBandwidthMbps:   Math.max(0, parseFloat(s.maxBandwidthMbps)          || 0),
    intervalSeconds:    Math.max(0, parseInt(s.intervalSeconds)             || 0),
    multipartThresholdMb: Math.max(5, Math.min(parseInt(s.multipartThresholdMb) || 100, 5000)),
  };

  res.json({ ok: true, message: safeSettings.dryRun ? 'Dry-run started' : 'Sync started' });
  startSync({ source, dest, settings: safeSettings, notifications, name }).catch((err) =>
    log('error', `Sync crashed: ${err.message}`));
});

app.post('/api/stop', (_req, res) => { stopSync(); res.json({ ok: true }); });

app.get('/api/status', (_req, res) => res.json({
  running: state.running,
  stats: state.stats,
  startedAt: state.startedAt,
  hasConfig: !!state.config,
  failedCount: state.lastFailedObjects?.length || 0,
}));

app.post('/api/retry-failed', (req, res) => {
  if (state.running) return res.status(409).json({ ok: false, error: 'Sync already running' });
  if (!state.lastFailedObjects?.length) return res.json({ ok: false, error: 'No failed files from last run' });
  if (!state.config) return res.json({ ok: false, error: 'No previous config available' });

  const count = state.lastFailedObjects.length;
  const objects = [...state.lastFailedObjects];
  res.json({ ok: true, count });
  retryFailed(state.config, objects).catch((err) => log('error', `Retry crashed: ${err.message}`));
});

// ── Named jobs (persisted to disk) ─────────────────────────────────────────

app.get('/api/jobs',         (_req, res) => res.json(listJobs()));
app.get('/api/jobs/:id',     (req, res)  => {
  const job = getJob(req.params.id);
  job ? res.json(job) : res.status(404).json({ error: 'Job not found' });
});
app.post('/api/jobs',        (req, res)  => res.status(201).json(createJob(req.body)));
app.put('/api/jobs/:id',     (req, res)  => {
  const job = updateJob(req.params.id, req.body);
  job ? res.json(job) : res.status(404).json({ error: 'Job not found' });
});
app.delete('/api/jobs/:id',  (req, res)  => {
  deleteJob(req.params.id)
    ? res.json({ ok: true })
    : res.status(404).json({ error: 'Job not found' });
});
app.post('/api/jobs/:id/start', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (state.running) return res.status(409).json({ ok: false, error: 'A sync is already running' });

  res.json({ ok: true, jobName: job.name });
  startSync(job).catch((err) => log('error', `Job crashed: ${err.message}`));
});

// ── History ────────────────────────────────────────────────────────────────

app.get('/api/history',    (_req, res) => res.json(getHistory()));
app.delete('/api/history', (_req, res) => { clearHistory(); res.json({ ok: true }); });

// ── Active job control (in-memory runner) ─────────────────────────────────

// NOTE: POST /api/jobs/start must be registered BEFORE POST /api/jobs/:id/start
// so Express doesn't match the literal string "start" as a job :id.
app.post('/api/jobs/start', startLimiter, (req, res) => {
  const { name, type, source, dest, settings, schedule } = req.body;

  if (!name || !type) return res.status(400).json({ ok: false, error: 'Name and type required' });
  if (!source) return res.status(400).json({ ok: false, error: 'Source configuration required' });
  if (!dest && type !== 'status') return res.status(400).json({ ok: false, error: 'Destination configuration required' });

  const jobId = 'job_' + Date.now();
  const job = { id: jobId, name, type, source, dest, settings, schedule, status: 'pending' };

  addJob(job);
  res.json({ ok: true, jobId });

  if (type === 's3') {
    startSync({ ...job, id: jobId }).catch(err => log('error', `Job ${jobId} error: ${err.message}`));
  } else if (type === 'db') {
    startDbSync({ ...job, id: jobId }).catch(err => log('error', `Job ${jobId} error: ${err.message}`));
  }
});

app.get('/api/jobs/active', (_req, res) => res.json(getActiveJobs()));

app.post('/api/jobs/:id/pause', (req, res) => {
  const job = pauseJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  res.json({ ok: true });
});

app.post('/api/jobs/:id/resume', (req, res) => {
  const job = resumeJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  res.json({ ok: true });
});

app.post('/api/jobs/:id/stop', (req, res) => {
  const job = stopJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Job not found' });
  removeJob(req.params.id);
  res.json({ ok: true });
});

// ── Checkpoints ────────────────────────────────────────────────────────────

app.get('/api/checkpoints', (_req, res) => res.json(listCheckpoints()));
app.delete('/api/checkpoints/:key', (req, res) => {
  removeCheckpoint(req.params.key);
  res.json({ ok: true });
});

// ── Database Sync ───────────────────────────────────────────────────────

app.post('/api/db/test-connection', async (req, res) => {
  const { config } = req.body;
  if (!config?.host || !config?.database || !config?.user || !config?.password)
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  res.json(await testDbConnection(config));
});

app.post('/api/db/start', startLimiter, (req, res) => {
  const { source, dest, settings, notifications, name } = req.body;
  if (dbState.running)
    return res.status(409).json({ ok: false, error: 'A database sync is already running' });
  if (!source?.host || !source?.database || !source?.user || !source?.password)
    return res.status(400).json({ ok: false, error: 'Source configuration is incomplete' });
  if (!dest?.host || !dest?.database || !dest?.user || !dest?.password)
    return res.status(400).json({ ok: false, error: 'Destination configuration is incomplete' });

  const s = settings || {};
  const safeSettings = {
    ...s,
    sourceSchema: s.sourceSchema || 'public',
    destSchema: s.destSchema || 'public',
    concurrency: Math.max(1, Math.min(parseInt(s.concurrency) || 5, 10)),
    intervalSeconds: Math.max(0, parseInt(s.intervalSeconds) || 0),
    includeTables: s.includeTables || [],
    excludeTables: s.excludeTables || [],
    renameTables: s.renameTables || {},
  };

  res.json({ ok: true, message: safeSettings.dryRun ? 'Dry-run started' : 'Database sync started' });
  startDbSync({ source, dest, settings: safeSettings, notifications, name }).catch((err) =>
    log('error', `DB Sync crashed: ${err.message}`));
});

app.post('/api/db/stop', (_req, res) => { stopDbSync(); res.json({ ok: true }); });

app.get('/api/db/status', (_req, res) => res.json({
  running: dbState.running,
  stats: dbState.stats,
  startedAt: dbState.startedAt,
  hasConfig: !!dbState.config,
  failedCount: dbState.lastFailedTables?.length || 0,
}));

app.post('/api/db/retry-failed', (req, res) => {
  if (dbState.running) return res.status(409).json({ ok: false, error: 'Sync already running' });
  if (!dbState.lastFailedTables?.length) return res.json({ ok: false, error: 'No failed tables from last run' });
  if (!dbState.config) return res.json({ ok: false, error: 'No previous config available' });

  const count = dbState.lastFailedTables.length;
  res.json({ ok: true, count });
  retryFailedDbTables(dbState.config).catch((err) => log('error', `DB Retry crashed: ${err.message}`));
});

// ── Cluster Management ───────────────────────────────────────────────────

app.post('/api/cluster/connect', async (req, res) => {
  const { config } = req.body;
  if (!config?.host || !config?.database || !config?.user || !config?.password)
    return res.status(400).json({ ok: false, error: 'Missing required fields' });

  if (_clusterPool) await _clusterPool.end().catch(() => {});
  _clusterPool = buildClusterPool(config);
  // Stash the full config (including password) so subsequent routes can reuse it.
  _clusterPool._config = config;

  try {
    const result = await getClusterStatus(config);
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/cluster/status', async (_req, res) => {
  if (!_clusterPool) return res.json({ ok: false, error: 'Not connected to cluster' });
  try {
    const result = await getClusterStatus(_clusterPool._config);
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/cluster/replicas', async (_req, res) => {
  if (!_clusterPool) return res.json({ ok: false, error: 'Not connected to cluster' });
  const result = await getReplicaLag(_clusterPool._config);
  res.json(result);
});

app.get('/api/cluster/lag', async (_req, res) => {
  if (!_clusterPool) return res.json({ ok: false, error: 'Not connected to cluster' });
  const result = await checkReplicationLag(_clusterPool._config);
  res.json(result);
});

app.get('/api/cluster/disconnect', async (_req, res) => {
  if (_clusterPool) {
    await _clusterPool.end().catch(() => {});
    _clusterPool = null;
  }
  res.json({ ok: true });
});

app.post('/api/cluster/create-replica', async (req, res) => {
  const { source, dest } = req.body;
  if (!source?.host || !source?.database)
    return res.status(400).json({ ok: false, error: 'Source (Primary) not connected' });
  if (!dest?.host || !dest?.database || !dest?.user || !dest?.password)
    return res.status(400).json({ ok: false, error: 'Destination configuration incomplete' });

  res.json({ 
    ok: true, 
    message: `Base backup initiated. Please configure replication manually on ${dest.host}. This feature requires database superuser access for automated setup.` 
  });
});

// ── Backup Job CRUD (Task 10.2) ────────────────────────────────────────────

app.get('/api/backup/jobs', apiLimiter, (_req, res) => {
  res.json(listBackupJobs());
});

app.post('/api/backup/jobs', apiLimiter, async (req, res) => {
  const data = req.body;
  const requiredFields = [
    ['source.host',     data.source?.host],
    ['source.database', data.source?.database],
    ['source.user',     data.source?.user],
    ['source.password', data.source?.password],
    ['storageTargets',  data.storageTargets],
  ];
  for (const [field, value] of requiredFields) {
    if (!value || (Array.isArray(value) && value.length === 0)) {
      return res.status(400).json({ ok: false, error: `Missing required field: ${field}` });
    }
  }
  try {
    const job = createBackupJob(data);
    if (job.schedule != null) {
      scheduleJob(job);
    }
    res.status(201).json(job);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/backup/jobs/:id', apiLimiter, (req, res) => {
  const job = getBackupJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Backup job not found' });
  res.json(job);
});

app.put('/api/backup/jobs/:id', apiLimiter, (req, res) => {
  const existing = getBackupJob(req.params.id);
  if (!existing) return res.status(404).json({ ok: false, error: 'Backup job not found' });
  const updated = updateBackupJob(req.params.id, req.body);
  if (!updated) return res.status(404).json({ ok: false, error: 'Backup job not found' });
  // Reschedule if schedule changed
  if (req.body.schedule !== undefined) {
    rescheduleJob(updated);
  }
  res.json(updated);
});

app.delete('/api/backup/jobs/:id', apiLimiter, (req, res) => {
  const job = getBackupJob(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'Backup job not found' });
  unscheduleJob(req.params.id);
  deleteBackupJob(req.params.id);
  res.json({ ok: true });
});

// ── Backup Operations (Task 10.3) ──────────────────────────────────────────

app.post('/api/backup/run', apiLimiter, startLimiter, async (req, res) => {
  const jobConfig = req.body;

  // Validate format if provided
  if (jobConfig.format) {
    const fmtResult = validateFormat(jobConfig.format);
    if (!fmtResult.valid) {
      return res.status(400).json({ ok: false, error: fmtResult.error });
    }
  }

  // Validate compression level if gzip
  if (jobConfig.compression?.type === 'gzip' && jobConfig.compression?.level != null) {
    const lvlResult = validateCompressionLevel(jobConfig.compression.level);
    if (!lvlResult.valid) {
      return res.status(400).json({ ok: false, error: lvlResult.error });
    }
  }

  try {
    const result = await startBackup(jobConfig);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.post('/api/backup/restore', apiLimiter, startLimiter, async (req, res) => {
  const { backupId, target, restoreOptions, passphrase } = req.body;

  if (!backupId) return res.status(400).json({ ok: false, error: 'Missing required field: backupId' });
  if (!target)   return res.status(400).json({ ok: false, error: 'Missing required field: target' });

  // Check if backup is encrypted and require passphrase
  const record = getCatalogRecord(backupId);
  if (!record) return res.status(404).json({ ok: false, error: 'Backup record not found' });
  if (record.encrypted && !passphrase) {
    return res.status(400).json({ ok: false, error: 'passphrase is required for encrypted backups' });
  }

  try {
    const result = await startRestore(backupId, target, restoreOptions || {}, passphrase || null);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.post('/api/backup/verify/:backupId', apiLimiter, async (req, res) => {
  try {
    const result = await verifyBackup(req.params.backupId);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.get('/api/backup/verify/:backupId', apiLimiter, (req, res) => {
  const record = getCatalogRecord(req.params.backupId);
  if (!record) return res.status(404).json({ ok: false, error: 'Backup record not found' });
  res.json({
    backupId: record.backupId,
    status: record.status,
    lastVerifiedAt: record.lastVerifiedAt || null,
    errorMessage: record.errorMessage || null,
  });
});

app.post('/api/backup/jobs/:id/apply-retention', apiLimiter, async (req, res) => {
  try {
    const result = await applyRetention(req.params.id);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.post('/api/backup/jobs/:id/rotate-key', apiLimiter, async (req, res) => {
  const { currentPassphrase, newPassphrase } = req.body;
  if (!currentPassphrase) return res.status(400).json({ ok: false, error: 'Missing required field: currentPassphrase' });
  if (!newPassphrase)     return res.status(400).json({ ok: false, error: 'Missing required field: newPassphrase' });
  try {
    const result = await rotateKey(req.params.id, currentPassphrase, newPassphrase);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

app.post('/api/backup/test-webhook', apiLimiter, async (req, res) => {
  const { url } = req.body;
  if (!url?.trim()) return res.status(400).json({ ok: false, error: 'Webhook URL required' });

  const timestamp = new Date().toLocaleString();
  // Build a payload with `text` so Google Chat, Slack, and Discord all accept it
  const payload = {
    text: `🔔 *S3 Backup Studio — test notification*\nSent at: ${timestamp}`,
    content: `🔔 S3 Backup Studio — test notification\nSent at: ${timestamp}`,
    event: 'backup_test',
    message: 'S3 Backup Studio — backup notification test',
    timestamp: new Date().toISOString(),
  };

  const result = await sendWebhook(url.trim(), payload);
  if (!result?.ok) {
    log('warning', `Test webhook failed for ${url.trim()} — ${result?.error || `HTTP ${result?.status}`}`);
  }
  res.json(result?.ok
    ? { ok: true, status: result.status }
    : { ok: false, error: result?.error || `Webhook returned HTTP ${result?.status}` });
});

app.post('/api/backup/test-notification', apiLimiter, async (req, res) => {
  const { jobId, notifications } = req.body;

  // Resolve notification config: use provided directly or load from job
  let notifConfig = notifications;
  if (!notifConfig && jobId) {
    const job = getBackupJob(jobId);
    if (!job) return res.status(404).json({ ok: false, error: 'Backup job not found' });
    notifConfig = job.notifications;
  }
  if (!notifConfig) return res.status(400).json({ ok: false, error: 'No notification configuration provided' });

  const webhookUrl = notifConfig.webhook?.url?.trim();
  const emailHost  = notifConfig.email?.host?.trim();
  const emailTo    = notifConfig.email?.to?.trim();

  if (!webhookUrl && !emailHost) {
    return res.status(400).json({ ok: false, error: 'No webhook URL or email host configured' });
  }

  const results = {};
  let anyOk = false;

  if (webhookUrl) {
    results.webhook = await sendWebhook(webhookUrl, {
      event: 'backup_test',
      message: 'S3 Backup Studio — backup notification test',
      timestamp: new Date().toISOString(),
    });
    if (results.webhook?.ok) anyOk = true;
  }

  if (emailHost && emailTo) {
    results.email = await sendEmail(notifConfig.email, {
      reason: 'completed',
      source: 'backup-test',
      dest: 'backup-test',
      stats: { synced: 0, skipped: 0, failed: 0, bytesTransferred: 0 },
      elapsed: '0',
      dryRun: false,
    });
    if (results.email?.ok) anyOk = true;
  }

  // Return the actual outcome — ok only if at least one channel succeeded
  const webhookErr = results.webhook && !results.webhook.ok ? results.webhook.error : null;
  const emailErr   = results.email   && !results.email.ok   ? results.email.error   : null;
  const errorMsg   = [webhookErr, emailErr].filter(Boolean).join('; ');

  res.json({ ok: anyOk, results, error: errorMsg || undefined });
});

// ── Multi-Database Connection Testing (Task 7.1) ──────────────────────────

app.post('/api/backup/test-db-connection', testLimiter, async (req, res) => {
  const { dbType, host, port, database, user, password, connectionUri } = req.body;

  // Validate dbType and get the appropriate driver
  let driver, resolvedType;
  try {
    const result = getDriver(dbType);
    driver = result.driver;
    resolvedType = result.resolvedType;
  } catch (err) {
    // getDriver throws with status 400 for unsupported dbType
    return res.status(err.status || 400).json({ ok: false, error: err.message });
  }

  // Build config object based on database type
  let config;
  if (resolvedType === 'mongodb') {
    // MongoDB uses connectionUri
    if (!connectionUri) {
      return res.status(400).json({ ok: false, error: 'Missing required field: connectionUri' });
    }
    config = { connectionUri };
  } else {
    // PostgreSQL, MySQL, MariaDB use individual connection parameters
    if (!host || !database || !user || !password) {
      return res.status(400).json({ ok: false, error: 'Missing required fields: host, database, user, password' });
    }
    config = { host, port, database, user, password };
  }

  // Call driver's testConnection method
  const result = await driver.testConnection(config);
  res.json(result);
});

// ── Backup Catalog (Task 10.4) ─────────────────────────────────────────────

app.get('/api/backup/catalog', apiLimiter, (_req, res) => {
  res.json(listCatalog());
});

app.get('/api/backup/catalog/:backupId', apiLimiter, (req, res) => {
  const record = getCatalogRecord(req.params.backupId);
  if (!record) return res.status(404).json({ ok: false, error: 'Backup record not found' });
  res.json(record);
});

app.delete('/api/backup/catalog/:backupId', apiLimiter, async (req, res) => {
  const record = getCatalogRecord(req.params.backupId);
  if (!record) return res.status(404).json({ ok: false, error: 'Backup record not found' });

  const storagePaths = (record.storagePaths || []).filter((p) => p.status === 'ok');
  const deleteResults = await Promise.all(
    storagePaths.map((p) => deleteFromTarget(p.path))
  );

  const anyFailed = deleteResults.some((r) => !r.ok);
  const newStatus = anyFailed ? 'delete_failed' : 'deleted';

  updateCatalogRecord(req.params.backupId, { status: newStatus });

  if (anyFailed) {
    const errors = deleteResults.filter((r) => !r.ok).map((r) => r.error);
    return res.status(500).json({ ok: false, error: `Some deletions failed: ${errors.join('; ')}`, status: newStatus });
  }

  res.json({ ok: true, status: newStatus });
});

// ── Notification tests ─────────────────────────────────────────────────────

app.post('/api/test-webhook', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ ok: false, error: 'URL required' });
  const result = await sendWebhook(url, {
    event: 'test', message: 'S3 Backup Studio webhook test', timestamp: new Date().toISOString(),
  });
  res.json(result);
});

app.post('/api/test-email', async (req, res) => {
  const { config } = req.body;
  if (!config?.host || !config?.to) return res.status(400).json({ ok: false, error: 'SMTP host and recipient required' });
  const result = await sendEmail(config, {
    reason: 'completed', source: 's3://test-bucket', dest: 's3://backup-bucket',
    stats: { total: 10, synced: 10, failed: 0, skipped: 0, bytesTransferred: 1024 * 1024 },
    elapsed: '5.0', dryRun: false,
  });
  res.json(result);
});

// ── Socket.io ──────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  socket.emit('sync:stats', { ...state.stats, startedAt: state.startedAt });
  socket.emit('sync:init', {
    running: state.running,
    failedCount: state.lastFailedObjects?.length || 0,
  });
  socket.emit('db:sync:stats', { ...dbState.stats, startedAt: dbState.startedAt });
  socket.emit('db:sync:init', {
    running: dbState.running,
    failedCount: dbState.lastFailedTables?.length || 0,
  });
  socket.emit('jobs:update', { jobs: getActiveJobs() });
  if (state.running) {
    socket.emit('log', { ts: Date.now(), level: 'info', message: 'Sync is currently in progress…' });
  }
  if (dbState.running) {
    socket.emit('log', { ts: Date.now(), level: 'info', message: 'Database sync is currently in progress…' });
  }
});

// ── Graceful shutdown ──────────────────────────────────────────────────────

function shutdown(signal) {
  log('info', `${signal} received — shutting down`);
  if (state.running) { state.stopRequested = true; log('info', 'Signalling sync to stop'); }
  if (dbState.running) { dbState.stopRequested = true; log('info', 'Signalling DB sync to stop'); }
  httpServer.close(() => { log('info', 'Server closed'); process.exit(0); });
  setTimeout(() => { log('error', 'Forced exit after 30s'); process.exit(1); }, 30_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  (err)    => { log('error', `Uncaught: ${err.message}\n${err.stack}`); process.exit(1); });
process.on('unhandledRejection', (reason) => { log('error', `Unhandled rejection: ${String(reason)}`); });

// ── Start ──────────────────────────────────────────────────────────────────

httpServer.listen(PORT, '0.0.0.0', () => {
  log('info', `S3 Backup Studio on http://0.0.0.0:${PORT} [${NODE_ENV}]`);
  if (AUTH_ENABLED) log('info', 'HTTP Basic Auth enabled');
});
