import pg from 'pg';
const { Client, Pool } = pg;

export function buildDbClient(config) {
  const client = new Client({
    host: config.host,
    port: parseInt(config.port) || 5432,
    database: config.database,
    user: config.user,
    password: config.password,
    max: config.maxConnections || 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  return client;
}

export function buildDbPool(config) {
  return new Pool({
    host: config.host,
    port: parseInt(config.port) || 5432,
    database: config.database,
    user: config.user,
    password: config.password,
    max: config.maxConnections || 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
}

export async function testConnection(config) {
  const client = buildDbClient(config);
  try {
    await client.connect();
    const result = await client.query('SELECT version()');
    await client.end();
    return { ok: true, version: result.rows[0].version };
  } catch (err) {
    await client.end().catch(() => {});
    return { ok: false, error: err.message };
  }
}

export async function getTables(pool, schema = 'public') {
  const result = await pool.query(`
    SELECT table_name, table_type
    FROM information_schema.tables
    WHERE table_schema = $1 AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `, [schema]);
  return result.rows;
}

export async function getTableCount(pool, tableName, schema = 'public') {
  try {
    const quotedTable = `"${tableName}"`;
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM ${schema}.${quotedTable}`
    );
    return parseInt(result.rows[0].count);
  } catch (err) {
    return -1;
  }
}

export async function getTableSchema(pool, tableName, schema = 'public') {
  const result = await pool.query(`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = $2
    ORDER BY ordinal_position
  `, [schema, tableName]);
  return result.rows;
}

export async function getTableSize(pool, tableName, schema = 'public') {
  try {
    const quotedTable = `"${tableName}"`;
    const result = await pool.query(`
      SELECT pg_total_relation_size($1) as size
    `, [schema + '.' + quotedTable]);
    return parseInt(result.rows[0].size) || 0;
  } catch {
    return 0;
  }
}

export async function dumpTable(pool, tableName, schema = 'public') {
  const quotedTable = `"${tableName}"`;
  const query = `SELECT * FROM ${schema}.${quotedTable} LIMIT 1`;
  try {
    const result = await pool.query(query);
    if (result.rows.length === 0) {
      return [];
    }
    const fullQuery = `SELECT * FROM ${schema}.${quotedTable}`;
    const fullResult = await pool.query(fullQuery);
    return fullResult.rows;
  } catch (err) {
    return null;
  }
}

export async function restoreTable(pool, tableName, schema, rows) {
  if (!rows.length) return { ok: true, restored: 0 };
  
  const tableExistsCheck = await pool.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = $1 AND table_name = $2
    ) as exists
  `, [schema, tableName]);
  
  if (!tableExistsCheck.rows[0].exists) {
    const columns = Object.keys(rows[0]);
    const colDefs = columns.map(c => `"${c}" TEXT`).join(', ');
    const quotedTable = `"${tableName}"`;
    await pool.query(`CREATE TABLE IF NOT EXISTS ${schema}.${quotedTable} (${colDefs})`);
  }
  
  const columns = Object.keys(rows[0]);
  const colNames = columns.map(c => `"${c}"`).join(', ');
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const values = rows.map(row => columns.map(c => row[c]));
  const quotedTable = `"${tableName}"`;
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const vals of values) {
      await client.query(
        `INSERT INTO ${schema}.${quotedTable} (${colNames}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
        vals
      );
    }
    await client.query('COMMIT');
    return { ok: true, restored: values.length };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function copyTable(pool, srcTable, dstPool, dstTable, dstSchema) {
  const rows = await dumpTable(pool, srcTable);
  if (!rows.length) return { ok: true, copied: 0 };
  return restoreTable(dstPool, dstTable, dstSchema, rows);
}

export async function closePool(pool) {
  await pool.end();
}