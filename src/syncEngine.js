import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Transform } from 'stream';
import { minimatch } from 'minimatch';
import { buildS3Client, streamListObjects, listAllObjects, deleteObject } from './s3Client.js';
import { log } from './logger.js';
import { state, resetStats } from './syncState.js';
import { consume, setLimit } from './rateLimiter.js';
import { makeKey, saveCheckpoint, loadCheckpoint, removeCheckpoint } from './checkpoint.js';
import { appendHistory } from './history.js';
import { notify } from './notifier.js';
import { recordSyncEnd } from './metrics.js';

let _io = null;

export function initEngine(io) { _io = io; }

function emitStats() {
  if (_io) _io.emit('sync:stats', { ...state.stats, startedAt: state.startedAt });
}

function normalizeETag(etag) {
  return etag ? etag.replace(/"/g, '') : '';
}

function needsCopy(srcObj, dstObj) {
  if (!dstObj) return true;
  if (srcObj.Size !== dstObj.Size) return true;
  const se = normalizeETag(srcObj.ETag);
  const de = normalizeETag(dstObj.ETag);
  if (!se || !de) return false;
  if (se === de) return false;
  if (se.includes('-') || de.includes('-')) return false; // Multipart: trust size
  return true;
}

// Filter: apply include/exclude glob patterns from settings.
function passesFilter(key, settings) {
  const inc = (settings.includePatterns || []).filter(Boolean);
  const exc = (settings.excludePatterns || []).filter(Boolean);
  const opts = { matchBase: true, dot: true };

  if (exc.some((p) => minimatch(key, p, opts))) return false;
  if (inc.length > 0 && !inc.some((p) => minimatch(key, p, opts))) return false;
  return true;
}

// Byte-tracker Transform: counts bytes AND applies shared bandwidth throttle.
// Using IIFE to bridge async consume() into the callback-based Transform.
function createByteTracker() {
  return new Transform({
    transform(chunk, _enc, cb) {
      const push = () => {
        state.stats.bytesTransferred += chunk.length;
        this.push(chunk);
        cb();
      };
      consume(chunk.length).then(push, cb);
    },
  });
}

async function copyFile(srcClient, dstClient, srcConfig, dstConfig, obj, settings, isDryRun) {
  const key = obj.Key;
  const isLarge = obj.Size >= (settings.multipartThresholdMb || 100) * 1024 * 1024;
  const timeoutMs = (settings.fileTimeoutMinutes || 30) * 60 * 1000;

  // ── Dry run: simulate without touching anything ─────────────────────────
  if (isDryRun) {
    state.stats.synced++;
    emitStats();
    if (_io) _io.emit('sync:file_done', { key, action: 'synced', bytes: obj.Size, dryRun: true });
    log('info', `[DRY RUN] Would sync: ${key}`);
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Transfer timeout after ${settings.fileTimeoutMinutes || 30} min`)),
    timeoutMs,
  );

  try {
    const getRes = await srcClient.send(
      new GetObjectCommand({ Bucket: srcConfig.bucket, Key: key }),
      { abortSignal: controller.signal },
    );

    const tracker = createByteTracker();
    getRes.Body.on('error', (err) => tracker.destroy(err));
    getRes.Body.pipe(tracker);

    const baseParams = {
      Bucket: dstConfig.bucket,
      Key: key,
      Body: tracker,
      ContentType: getRes.ContentType || 'application/octet-stream',
      Metadata: getRes.Metadata || {},
    };

    if (isLarge) {
      await new Upload({
        client: dstClient,
        params: baseParams,
        queueSize: 4,
        partSize: 10 * 1024 * 1024,
        leavePartsOnError: false,
      }).done();
    } else {
      await dstClient.send(
        new PutObjectCommand({ ...baseParams, ContentLength: obj.Size }),
        { abortSignal: controller.signal },
      );
    }

    clearTimeout(timer);
    state.stats.synced++;
    emitStats();
    if (_io) _io.emit('sync:file_done', { key, action: 'synced', bytes: obj.Size });
    log('success', `Synced: ${key}`);
  } catch (err) {
    clearTimeout(timer);
    state.stats.failed++;
    if (state.lastFailedObjects.length < 10_000) state.lastFailedObjects.push(obj);
    emitStats();
    if (_io) _io.emit('sync:file_error', { key, error: err.message });
    log('error', `Failed: ${key} — ${err.message}`);
  }
}

// Worker-pool: N workers race through items[] via shared index.
// Memory: only N Promises exist at any time, regardless of list size.
async function runWorkerPool(items, concurrency, processor) {
  if (items.length === 0) return;
  let index = 0;

  async function worker() {
    while (!state.stopRequested) {
      const i = index++;
      if (i >= items.length) break;
      await processor(items[i]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
}

async function runOnce(config) {
  const { source, dest, settings } = config;
  const isDryRun = !!settings.dryRun;
  const concurrency = Math.max(1, Math.min(settings.concurrency || 5, 50));

  setLimit(settings.maxBandwidthMbps || 0);

  const srcClient = buildS3Client(source);
  const dstClient = buildS3Client(dest);

  // ── Checkpoint: check for a resumable previous run ──────────────────────
  const cpKey = makeKey(source.bucket, dest.bucket);
  state.currentCheckpointKey = cpKey;
  const checkpoint = loadCheckpoint(cpKey);
  if (checkpoint) {
    log('info', `Resuming from checkpoint: ${checkpoint.count} files already completed (saved ${checkpoint.savedAt})`);
    if (_io) _io.emit('sync:resumed', { count: checkpoint.count, savedAt: checkpoint.savedAt });
  }

  // ── Phase 1: Load destination into Map ─────────────────────────────────
  log('info', `Listing destination: s3://${dest.bucket}${dest.prefix ? '/' + dest.prefix : ''}`);
  let dstObjects;
  try {
    dstObjects = await listAllObjects(dstClient, dest.bucket, dest.prefix);
  } catch (err) {
    log('error', `Cannot list destination: ${err.message}`);
    return 'fatal_error';
  }
  const dstMap = new Map(dstObjects.map((o) => [o.Key, o]));

  // ── Phase 2: Stream-list source, apply filters, diff ───────────────────
  log('info', `Scanning source: s3://${source.bucket}${source.prefix ? '/' + source.prefix : ''}`);
  const toCopy = [];
  const srcKeySeen = new Set();
  let checkpointDirty = 0;
  const completedKeys = checkpoint?.completedKeys || new Set();

  try {
    for await (const page of streamListObjects(srcClient, source.bucket, source.prefix)) {
      if (state.stopRequested) break;

      for (const obj of page) {
        srcKeySeen.add(obj.Key);
        state.stats.total++;
        state.stats.bytesTotal += obj.Size || 0;

        if (!passesFilter(obj.Key, settings)) {
          state.stats.skipped++;
          continue;
        }

        if (completedKeys.has(obj.Key)) {
          state.stats.skipped++;
          log('info', `Resume skip: ${obj.Key}`);
          continue;
        }

        if (needsCopy(obj, dstMap.get(obj.Key))) {
          toCopy.push(obj);
        } else {
          state.stats.skipped++;
        }
      }
      emitStats();
    }
  } catch (err) {
    log('error', `Cannot list source: ${err.message}`);
    return 'fatal_error';
  }

  const toDelete = settings.deleteOrphaned && !isDryRun
    ? dstObjects.filter((o) => !srcKeySeen.has(o.Key))
    : [];

  if (_io) {
    _io.emit('sync:started', {
      totalFiles: state.stats.total,
      totalBytes: state.stats.bytesTotal,
      toCopy: toCopy.length,
      toSkip: state.stats.skipped,
      toDelete: toDelete.length,
      dryRun: isDryRun,
      resumed: !!checkpoint,
    });
  }

  log('info',
    `${isDryRun ? '[DRY RUN] ' : ''}Scan done: ${state.stats.total} objects | ` +
    `${toCopy.length} to copy, ${state.stats.skipped} skipped, ${toDelete.length} to delete`);

  // ── Phase 3: Copy files (or simulate if dry-run) ────────────────────────
  await runWorkerPool(toCopy, concurrency, async (obj) => {
    await copyFile(srcClient, dstClient, source, dest, obj, settings, isDryRun);

    // Save checkpoint every 100 processed files
    if (!isDryRun && ++checkpointDirty >= 100) {
      completedKeys.add(obj.Key);
      saveCheckpoint(cpKey, completedKeys);
      checkpointDirty = 0;
    } else {
      completedKeys.add(obj.Key);
    }
  });

  // ── Phase 4: Delete orphans ─────────────────────────────────────────────
  if (toDelete.length > 0 && !state.stopRequested) {
    log('info', `Deleting ${toDelete.length} orphaned objects`);
    await runWorkerPool(toDelete, concurrency, async (obj) => {
      if (state.stopRequested) return;
      try {
        await deleteObject(dstClient, dest.bucket, obj.Key);
        if (_io) _io.emit('sync:file_done', { key: obj.Key, action: 'deleted', bytes: 0 });
        log('info', `Deleted: ${obj.Key}`);
      } catch (err) {
        log('error', `Delete failed: ${obj.Key} — ${err.message}`);
      }
    });
  }

  return state.stopRequested ? 'user_stopped' : 'completed';
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function startSync(config) {
  if (state.running) return { ok: false, error: 'Sync already running' };

  state.running = true;
  state.config = config;
  state.currentCycle = (state.currentCycle || 0) + 1;
  resetStats();

  const statsInterval = setInterval(emitStats, 500);
  log('info', `Cycle #${state.currentCycle}: s3://${config.source.bucket} → s3://${config.dest.bucket}${config.settings?.dryRun ? ' [DRY RUN]' : ''}`);

  let reason;
  try {
    reason = await runOnce(config);
  } catch (err) {
    reason = 'fatal_error';
    log('error', `Engine error: ${err.message}`);
  }

  clearInterval(statsInterval);
  emitStats();
  state.running = false;

  const elapsed = ((Date.now() - state.startedAt) / 1000).toFixed(1);

  // Clean up checkpoint on success; keep it on crash/stop for resume
  if (reason === 'completed' && state.currentCheckpointKey) {
    removeCheckpoint(state.currentCheckpointKey);
  }

  if (_io) _io.emit('sync:stopped', { reason, stats: { ...state.stats }, elapsed });

  log(reason === 'completed' ? 'success' : 'info',
    `Sync ${reason} | ${state.stats.synced} synced, ${state.stats.failed} failed, ` +
    `${state.stats.skipped} skipped | ${elapsed}s`);

  // ── Post-run: history, metrics, notifications ──────────────────────────
  const payload = {
    reason,
    source: `s3://${config.source.bucket}`,
    dest:   `s3://${config.dest.bucket}`,
    stats: { ...state.stats },
    elapsed,
    dryRun: !!config.settings?.dryRun,
    startedAt: state.startedAt,
    completedAt: Date.now(),
    jobName: config.name || null,
  };

  if (!config.settings?.dryRun) {
    appendHistory(payload);
    recordSyncEnd(state.stats);
  }

  if (config.notifications) {
    notify(config.notifications, payload).catch(() => {});
  }

  // Schedule next repeat cycle
  if (reason === 'completed' && !state.stopRequested && (config.settings?.intervalSeconds || 0) > 0) {
    log('info', `Next sync in ${config.settings.intervalSeconds}s`);
    if (state.repeatTimer) clearTimeout(state.repeatTimer);
    state.repeatTimer = setTimeout(() => startSync(config), config.settings.intervalSeconds * 1000);
  }

  return { ok: true };
}

// Retry only the objects that failed in the last run.
export async function retryFailed(config, failedObjects) {
  if (state.running) return { ok: false, error: 'Sync already running' };
  if (!failedObjects?.length) return { ok: false, error: 'No failed objects to retry' };

  state.running = true;
  state.config = config;
  resetStats();
  state.stats.total = failedObjects.length;
  state.stats.bytesTotal = failedObjects.reduce((s, o) => s + (o.Size || 0), 0);

  setLimit(config.settings?.maxBandwidthMbps || 0);

  const statsInterval = setInterval(emitStats, 500);
  log('info', `Retrying ${failedObjects.length} failed files`);

  const { source, dest, settings } = config;
  const srcClient = buildS3Client(source);
  const dstClient = buildS3Client(dest);
  const concurrency = Math.max(1, Math.min(settings?.concurrency || 5, 50));

  if (_io) {
    _io.emit('sync:started', {
      totalFiles: failedObjects.length,
      totalBytes: state.stats.bytesTotal,
      toCopy: failedObjects.length,
      toSkip: 0,
      toDelete: 0,
      isRetry: true,
    });
  }

  await runWorkerPool(failedObjects, concurrency, (obj) =>
    copyFile(srcClient, dstClient, source, dest, obj, settings || {}, false),
  );

  clearInterval(statsInterval);
  emitStats();
  state.running = false;

  const elapsed = ((Date.now() - state.startedAt) / 1000).toFixed(1);
  const reason = state.stopRequested ? 'user_stopped' : 'completed';

  if (_io) _io.emit('sync:stopped', { reason, stats: { ...state.stats }, elapsed });
  log(reason === 'completed' ? 'success' : 'info',
    `Retry ${reason}: ${state.stats.synced} synced, ${state.stats.failed} failed | ${elapsed}s`);

  return { ok: true };
}

export function stopSync() {
  if (state.repeatTimer) {
    clearTimeout(state.repeatTimer);
    state.repeatTimer = null;
  }
  if (!state.running) {
    if (_io) _io.emit('sync:stopped', { reason: 'user_stopped', stats: { ...state.stats } });
    return;
  }
  state.stopRequested = true;
  log('info', 'Stop requested — draining current transfers…');
}
