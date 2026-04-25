import { Pool } from 'pg';

export function buildClusterPool(config) {
  return new Pool({
    host: config.host,
    port: parseInt(config.port) || 5432,
    database: config.database || 'postgres',
    user: config.user,
    password: config.password,
    max: config.maxConnections || 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
}

export async function getClusterStatus(config) {
  const pool = buildClusterPool(config);
  
  try {
    const replicationResult = await pool.query(`
      SELECT 
        pid,
        usesysid,
        usename,
        application_name,
        client_addr,
        client_hostname,
        client_port,
        backend_start,
        state,
        sync_state,
        (NOW() - backend_start) as duration
      FROM pg_stat_replication
      ORDER BY backend_start DESC
    `);

    const walResult = await pool.query(`
      SELECT 
        pg_current_wal_lsn() as current_lsn,
        pg_current_wal_insert_lsn() as insert_lsn,
        pg_wal_lsn_diff(pg_current_wal_lsn(), '0/00000000') as bytes_behind
    `);

    const replicaInfo = await pool.query(`
      SELECT 
        count(*) as replica_count,
        count(CASE WHEN sync_state = 'sync' THEN 1 END) as sync_replicas,
        count(CASE WHEN sync_state = 'async' THEN 1 END) as async_replicas
      FROM pg_stat_replication
    `);

    const nodeHealth = await pool.query(`
      SELECT 
        count(*) as total_connections,
        count(CASE WHEN state = 'active' THEN 1 END) as active_connections,
        count(CASE WHEN state = 'idle' THEN 1 END) as idle_connections
      FROM pg_stat_activity
      WHERE application_name LIKE '%replica%'
    `);

    return {
      ok: true,
      role: 'primary',
      replication: replicationResult.rows,
      wal: walResult.rows[0],
      replicas: replicaInfo.rows[0],
      connections: nodeHealth.rows[0],
    };
  } catch (err) {
    await pool.end();
    return { ok: false, error: err.message };
  }
}

export async function getReplicaLag(config) {
  const pool = buildClusterPool(config);
  
  try {
    const result = await pool.query(`
      SELECT 
        application_name as replica_name,
        client_addr as replica_ip,
        state,
        sync_state,
        COALESCE(pg_wal_lsn_diff(COALESCE(remote_lsn, '0/00000000'), 0), 0) / 1024 / 1024 as lag_mb,
        (NOW() - backend_start) as uptime
      FROM pg_stat_replication
      ORDER BY remote_lsn DESC NULLS LAST
    `);

    await pool.end();
    return { ok: true, replicas: result.rows };
  } catch (err) {
    await pool.end();
    return { ok: false, error: err.message };
  }
}

export async function createReplicationSlot(config, slotName) {
  const pool = buildClusterPool(config);
  
  try {
    await pool.query(`
      SELECT pg_create_logical_replication_slot($1, 'pgoutput')
    `, [slotName]);

    await pool.end();
    return { ok: true, slotName };
  } catch (err) {
    await pool.end();
    return { ok: false, error: err.message };
  }
}

export async function configureReplica(config, replicaConfig) {
  const pool = buildClusterPool(replicaConfig);
  
  try {
    const result = await pool.query(`
      SELECT 
        CASE 
          WHEN pg_is_in_recovery() THEN 'replica'
          ELSE 'primary'
        END as role,
        current_setting('data_directory') as data_dir,
        server_version as version,
        pg_postmaster_start_time() as start_time
    `);

    await pool.end();
    return { ok: true, ...result.rows[0] };
  } catch (err) {
    await pool.end();
    return { ok: false, error: err.message };
  }
}

export async function checkReplicationLag(config) {
  const pool = buildClusterPool(config);
  
  try {
    const replicas = await pool.query(`
      SELECT 
        application_name,
        COALESCE(pg_wal_lsn_diff(COALESCE(remote_lsn, '0/00000000'), 
          COALESCE(local_lsn, '0/00000000')), 0) / 1024 / 1024 as lag_mb,
        state,
        sync_state
      FROM pg_stat_replication
      WHERE COALESCE(pg_wal_lsn_diff(remote_lsn, local_lsn), 0) > 0
    `);

    const maxLag = await pool.query(`
      SELECT MAX(lsn_diff) as max_lag_mb FROM (
        SELECT pg_wal_lsn_diff(remote_lsn, local_lsn) as lsn_diff
        FROM pg_stat_replication
        WHERE remote_lsn IS NOT NULL
      ) sub
    `);

    await pool.end();
    
    return {
      ok: true,
      replicas: replicas.rows,
      maxLag: maxLag.rows[0]?.max_lag_mb || 0,
      lagAlert: (maxLag.rows[0]?.max_lag_mb || 0) > 100
    };
  } catch (err) {
    await pool.end();
    return { ok: false, error: err.message };
  }
}

export async function stopReplication(config) {
  const pool = buildClusterPool(config);
  
  try {
    await pool.query(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_replication
      WHERE application_name LIKE '%replica%'
    `);

    await pool.end();
    return { ok: true };
  } catch (err) {
    await pool.end();
    return { ok: false, error: err.message };
  }
}

export async function closePool(pool) {
  await pool.end();
}