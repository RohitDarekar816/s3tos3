import { state } from './syncState.js';
import { dbState } from './dbSyncState.js';

let lifetimeSyncs   = 0;
let lifetimeFiles   = 0;
let lifetimeBytes   = 0;
let lifetimeErrors  = 0;

let lifetimeDbSyncs    = 0;
let lifetimeTables    = 0;
let lifetimeRows      = 0;
let lifetimeDbErrors = 0;

export function recordSyncEnd(stats) {
  lifetimeSyncs++;
  lifetimeFiles  += stats.synced  || 0;
  lifetimeBytes  += stats.bytesTransferred || 0;
  lifetimeErrors += stats.failed  || 0;
}

export function recordDbSyncEnd(stats) {
  lifetimeDbSyncs++;
  lifetimeTables += stats.syncedTables || 0;
  lifetimeRows   += stats.syncedRows || 0;
  lifetimeDbErrors += stats.failedTables || 0;
}

function gauge(name, help, value) {
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}`;
}

function counter(name, help, value) {
  return `# HELP ${name} ${help}\n# TYPE ${name} counter\n${name} ${value}`;
}

export function getMetricsText() {
  const mem = process.memoryUsage();
  const s = state.stats;
  const ds = dbState.stats;

  return [
    gauge('s3bs_sync_running',                  'Whether a sync is currently active (1=yes)',    state.running ? 1 : 0),
    gauge('s3bs_current_total_files',            'Total files discovered in current/last run',    s.total),
    gauge('s3bs_current_synced_files',           'Files successfully synced in current/last run', s.synced),
    gauge('s3bs_current_skipped_files',          'Files skipped (already up-to-date)',            s.skipped),
    gauge('s3bs_current_failed_files',           'Files that failed in current/last run',         s.failed),
    gauge('s3bs_current_bytes_transferred',     'Bytes transferred in current/last run',         s.bytesTransferred),
    gauge('s3bs_current_bytes_total',           'Total source bytes in current/last run',        s.bytesTotal),
    counter('s3bs_lifetime_syncs_total',         'Total sync runs since process start',           lifetimeSyncs),
    counter('s3bs_lifetime_files_synced_total', 'Total files synced since process start',        lifetimeFiles),
    counter('s3bs_lifetime_bytes_total',         'Total bytes transferred since process start',   lifetimeBytes),
    counter('s3bs_lifetime_errors_total',       'Total file errors since process start',         lifetimeErrors),
    '',
    gauge('s3bs_db_sync_running',               'Whether a DB sync is currently active (1=yes)', dbState.running ? 1 : 0),
    gauge('s3bs_db_current_total_tables',         'Total tables discovered in current/last run',   ds.totalTables),
    gauge('s3bs_db_current_synced_tables',      'Tables successfully synced in current/last run', ds.syncedTables),
    gauge('s3bs_db_current_failed_tables',       'Tables that failed in current/last run',         ds.failedTables),
    gauge('s3bs_db_current_synced_rows',         'Rows synced in current/last run',                ds.syncedRows),
    gauge('s3bs_db_current_bytes_transferred',  'Bytes transferred in current/last run',         ds.bytesTransferred),
    counter('s3bs_lifetime_db_syncs_total',       'Total DB sync runs since process start',         lifetimeDbSyncs),
    counter('s3bs_lifetime_tables_synced_total', 'Total tables synced since process start',       lifetimeTables),
    counter('s3bs_lifetime_rows_synced_total',   'Total rows synced since process start',             lifetimeRows),
    counter('s3bs_lifetime_db_errors_total',      'Total table errors since process start',         lifetimeDbErrors),
    '',
    gauge('process_resident_memory_bytes',       'Process RSS memory in bytes',                  mem.rss),
    gauge('process_heap_used_bytes',             'Process heap used in bytes',                   mem.heapUsed),
    gauge('process_uptime_seconds',              'Process uptime in seconds',                    Math.floor(process.uptime())),
    '',
  ].join('\n\n');
}
