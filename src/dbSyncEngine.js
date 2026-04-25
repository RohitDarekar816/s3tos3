import { buildDbPool, testConnection, getTables, getTableCount, getTableSize, copyTable, closePool, dumpTable } from './dbClient.js';
import { log } from './logger.js';
import { dbState, resetDbStats } from './dbSyncState.js';
import { appendHistory } from './history.js';
import { notify } from './notifier.js';
import { recordDbSyncEnd } from './metrics.js';

let _io = null;

export function initDbEngine(io) { _io = io; }

function emitDbStats() {
  if (_io) _io.emit('db:sync:stats', { ...dbState.stats, startedAt: dbState.startedAt });
}

function passesFilter(tableName, settings) {
  const inc = (settings.includeTables || []).filter(Boolean);
  const exc = (settings.excludeTables || []).filter(Boolean);

  if (exc.includes(tableName)) return false;
  if (inc.length > 0 && !inc.includes(tableName)) return false;
  return true;
}

async function syncTable(srcPool, dstPool, srcTable, dstTable, dstSchema, settings) {
  try {
    log('info', `Attempting to dump table: ${srcTable} in schema ${settings.sourceSchema || 'public'}`);
    
    const rows = await dumpTable(srcPool, srcTable, settings.sourceSchema || 'public');
    
    if (!rows) {
      dbState.stats.skippedTables++;
      emitDbStats();
      if (_io) _io.emit('db:sync:table_done', { table: srcTable, action: 'skipped', rows: 0 });
      log('info', `Table does not exist or inaccessible (skipping): ${srcTable}`);
      return;
    }
    
    if (rows.length === 0) {
      dbState.stats.skippedTables++;
      emitDbStats();
      if (_io) _io.emit('db:sync:table_done', { table: srcTable, action: 'skipped', rows: 0 });
      log('info', `Skipped empty table: ${srcTable}`);
      return;
    }

    const srcCount = rows.length;
    const srcSize = await getTableSize(srcPool, srcTable, settings.sourceSchema || 'public');
    
    const result = await copyTable(
      srcPool, srcTable,
      dstPool, dstTable,
      dstSchema || 'public'
    );

    dbState.stats.syncedTables++;
    dbState.stats.syncedRows += srcCount;
    dbState.stats.bytesTransferred += srcSize;
    emitDbStats();
    
    if (_io) _io.emit('db:sync:table_done', { table: srcTable, action: 'synced', rows: srcCount, bytes: srcSize });
    log('success', `Synced table: ${srcTable} (${srcCount} rows)`);
    
  } catch (err) {
    dbState.stats.failedTables++;
    dbState.lastFailedTables.push({ table: srcTable, error: err.message });
    emitDbStats();
    
    if (_io) _io.emit('db:sync:table_error', { table: srcTable, error: err.message });
    log('error', `Failed table: ${srcTable} — ${err.message}`);
  }
}

async function runWorkerPool(items, concurrency, processor) {
  if (items.length === 0) return;
  let index = 0;

  async function worker() {
    while (!dbState.stopRequested) {
      const i = index++;
      if (i >= items.length) break;
      await processor(items[i]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
}

async function runOnce(config) {
  const { source, dest, settings } = config;
  const isDryRun = !!settings.dryRun;
  const concurrency = Math.max(1, Math.min(settings.concurrency || 5, 10));

  const srcPool = buildDbPool(source);
  const dstPool = buildDbPool(dest);

  try {
    log('info', `Listing tables: ${source.host}/${source.database}`);
    const srcTables = await getTables(srcPool, settings.sourceSchema || 'public');
    
    const tablesToSync = [];
    
    for (const table of srcTables) {
      if (!passesFilter(table.table_name, settings)) continue;
      tablesToSync.push(table.table_name);
    }

    dbState.stats.totalTables = tablesToSync.length;
    
    if (_io) {
      _io.emit('db:sync:started', {
        totalTables: dbState.stats.totalTables,
        dryRun: isDryRun,
      });
    }

    log('info', `Found ${tablesToSync.length} tables to sync`);

    if (isDryRun) {
      for (const tableName of tablesToSync) {
        dbState.stats.syncedTables++;
        emitDbStats();
        log('info', `[DRY RUN] Would sync: ${tableName}`);
      }
      return 'completed';
    }

    await runWorkerPool(tablesToSync, concurrency, async (tableName) => {
      if (dbState.stopRequested) return;
      const dstName = settings.renameTables?.[tableName] || tableName;
      await syncTable(srcPool, dstPool, tableName, dstName, settings.destSchema || 'public', settings);
    });

    return dbState.stopRequested ? 'user_stopped' : 'completed';
    
  } catch (err) {
    log('error', `Database sync error: ${err.message}`);
    return 'fatal_error';
  } finally {
    await closePool(srcPool);
    await closePool(dstPool);
  }
}

export async function startDbSync(config) {
  if (dbState.running) return { ok: false, error: 'Database sync already running' };

  dbState.running = true;
  dbState.config = config;
  dbState.currentCycle = (dbState.currentCycle || 0) + 1;
  resetDbStats();

  const statsInterval = setInterval(emitDbStats, 500);
  
  const { source, dest } = config;
  
  log('info', `DB Sync Cycle #${dbState.currentCycle}: ${source.host}/${source.database} → ${dest.host}/${dest.database}${config.settings?.dryRun ? ' [DRY RUN]' : ''}`);
  
  let reason;
  try {
    reason = await runOnce(config);
  } catch (err) {
    reason = 'fatal_error';
    log('error', `DB Engine error: ${err.message}`);
  }

  clearInterval(statsInterval);
  emitDbStats();
  dbState.running = false;

  const elapsed = ((Date.now() - dbState.startedAt) / 1000).toFixed(1);

  if (_io) _io.emit('db:sync:stopped', { reason, stats: { ...dbState.stats }, elapsed });

  log(reason === 'completed' ? 'success' : 'info',
    `DB Sync ${reason} | ${dbState.stats.syncedTables} tables, ${dbState.stats.syncedRows} rows | ${elapsed}s`);

  if (!config.settings?.dryRun) {
    appendHistory({
      reason,
      source: `pgsql://${source.host}/${source.database}`,
      dest: `pgsql://${dest.host}/${dest.database}`,
      stats: { ...dbState.stats },
      elapsed,
      dryRun: !!config.settings?.dryRun,
      startedAt: dbState.startedAt,
      completedAt: Date.now(),
      jobName: config.name || null,
    });
    recordDbSyncEnd(dbState.stats);
  }

  if (config.notifications) {
    notify(config.notifications, {
      reason,
      source: `pgsql://${source.host}/${source.database}`,
      dest: `pgsql://${dest.host}/${dest.database}`,
      stats: { ...dbState.stats },
      elapsed,
      dryRun: !!config.settings?.dryRun,
    }).catch(() => {});
  }

  if (reason === 'completed' && !dbState.stopRequested && (config.settings?.intervalSeconds || 0) > 0) {
    log('info', `Next DB sync in ${config.settings.intervalSeconds}s`);
    if (dbState.repeatTimer) clearTimeout(dbState.repeatTimer);
    dbState.repeatTimer = setTimeout(() => startDbSync(config), config.settings.intervalSeconds * 1000);
  }

  return { ok: true };
}

export async function stopDbSync() {
  if (dbState.repeatTimer) {
    clearTimeout(dbState.repeatTimer);
    dbState.repeatTimer = null;
  }
  if (!dbState.running) {
    if (_io) _io.emit('db:sync:stopped', { reason: 'user_stopped', stats: { ...dbState.stats } });
    return;
  }
  dbState.stopRequested = true;
  log('info', 'Stop requested — draining DB sync…');
}

export async function retryFailedDbTables(config) {
  if (dbState.running) return { ok: false, error: 'Database sync already running' };
  if (!dbState.lastFailedTables?.length) return { ok: false, error: 'No failed tables from last run' };

  dbState.running = true;
  dbState.config = config;
  resetDbStats();
  dbState.stats.totalTables = dbState.lastFailedTables.length;

  const srcPool = buildDbPool(config.source);
  const dstPool = buildDbPool(config.dest);
  const concurrency = Math.max(1, Math.min(config.settings?.concurrency || 5, 10));

  const statsInterval = setInterval(emitDbStats, 500);
  log('info', `Retrying ${dbState.lastFailedTables.length} failed tables`);

  await runWorkerPool(dbState.lastFailedTables, concurrency, async ({ table }) => {
    await syncTable(srcPool, dstPool, table, table, config.settings?.destSchema || 'public', config.settings);
  });

  clearInterval(statsInterval);
  emitDbStats();
  dbState.running = false;

  const elapsed = ((Date.now() - dbState.startedAt) / 1000).toFixed(1);
  const reason = dbState.stopRequested ? 'user_stopped' : 'completed';

  if (_io) _io.emit('db:sync:stopped', { reason, stats: { ...dbState.stats }, elapsed });
  
  log(reason === 'completed' ? 'success' : 'info',
    `Retry ${reason}: ${dbState.stats.syncedTables} tables, ${dbState.stats.syncedRows} rows | ${elapsed}s`);

  return { ok: true };
}

export { dbState };