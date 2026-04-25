import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { init as initLogger, log } from './src/logger.js';
import { initEngine, startSync, stopSync, retryFailed } from './src/syncEngine.js';
import { testConnection } from './src/s3Client.js';
import { testConnection as testDbConnection } from './src/dbClient.js';
import { initDbEngine, startDbSync, stopDbSync, retryFailedDbTables, dbState } from './src/dbSyncEngine.js';
import { getClusterStatus, getReplicaLag, checkReplicationLag, buildClusterPool } from './src/dbCluster.js';
import { state } from './src/syncState.js';
import { getMetricsText } from './src/metrics.js';
import { listJobs, getJob, createJob, updateJob, deleteJob } from './src/jobStore.js';
import { getHistory, clearHistory } from './src/history.js';
import { listCheckpoints, removeCheckpoint } from './src/checkpoint.js';
import { sendWebhook, sendEmail } from './src/notifier.js';

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

// ── Named jobs ─────────────────────────────────────────────────────────────

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

let _clusterPool = null;

app.post('/api/cluster/connect', async (req, res) => {
  const { config } = req.body;
  if (!config?.host || !config?.database || !config?.user || !config?.password)
    return res.status(400).json({ ok: false, error: 'Missing required fields' });

  if (_clusterPool) await _clusterPool.end();
  _clusterPool = buildClusterPool(config);
  
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
    const result = await getClusterStatus({
      host: _clusterPool.options.host,
      port: _clusterPool.options.port,
      database: _clusterPool.options.database,
      user: _clusterPool.options.user,
      password: '',
    });
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get('/api/cluster/replicas', async (_req, res) => {
  if (!_clusterPool) return res.json({ ok: false, error: 'Not connected to cluster' });
  
  const config = {
    host: _clusterPool.options.host,
    port: _clusterPool.options.port,
    database: _clusterPool.options.database,
    user: _clusterPool.options.user,
    password: '',
  };
  
  const result = await getReplicaLag(config);
  res.json(result);
});

app.get('/api/cluster/lag', async (_req, res) => {
  if (!_clusterPool) return res.json({ ok: false, error: 'Not connected to cluster' });
  
  const config = {
    host: _clusterPool.options.host,
    port: _clusterPool.options.port,
    database: _clusterPool.options.database,
    user: _clusterPool.options.user,
    password: '',
  };
  
  const result = await checkReplicationLag(config);
  res.json(result);
});

app.get('/api/cluster/disconnect', async (_req, res) => {
  if (_clusterPool) {
    await _clusterPool.end();
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
