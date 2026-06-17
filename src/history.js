// Durable job-history sink for historical querying beyond the Redis TTL.
//
//   - PostgresHistory : production sink (Supabase / any Postgres) via `pg`.
//                       Activated when DATABASE_URL is set.
//   - SqliteHistory   : zero-infra fallback using Node's built-in node:sqlite,
//                       so historical querying works out of the box.
//
// Finished jobs (completed / failed) are upserted here; the API exposes them
// at GET /api/history with filtering + pagination.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

const COLUMNS =
  'id, client_id, type, priority, status, attempts, error, result, created_at, finished_at, trace_id';

function toRow(j) {
  return {
    id: j.id,
    client_id: j.clientId,
    type: j.type,
    priority: j.priority,
    status: j.status,
    attempts: j.attempts,
    error: j.error || null,
    result: j.result ? JSON.stringify(j.result) : null,
    created_at: j.createdAt,
    finished_at: j.finishedAt || null,
    trace_id: j.traceId || null,
  };
}

// ---------------------------------------------------------------------------
// Postgres (Supabase) backend
// ---------------------------------------------------------------------------
class PostgresHistory {
  constructor(pool) {
    this.kind = 'postgres';
    this.pool = pool;
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS job_history (
        id          TEXT PRIMARY KEY,
        client_id   TEXT,
        type        TEXT,
        priority    TEXT,
        status      TEXT,
        attempts    INTEGER,
        error       TEXT,
        result      JSONB,
        created_at  BIGINT,
        finished_at BIGINT,
        trace_id    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_hist_client  ON job_history(client_id);
      CREATE INDEX IF NOT EXISTS idx_hist_status  ON job_history(status);
      CREATE INDEX IF NOT EXISTS idx_hist_created ON job_history(created_at DESC);
    `);
  }

  async record(job) {
    const r = toRow(job);
    await this.pool.query(
      `INSERT INTO job_history (${COLUMNS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET
         status=EXCLUDED.status, attempts=EXCLUDED.attempts,
         error=EXCLUDED.error, result=EXCLUDED.result,
         finished_at=EXCLUDED.finished_at`,
      [r.id, r.client_id, r.type, r.priority, r.status, r.attempts, r.error, r.result, r.created_at, r.finished_at, r.trace_id],
    );
  }

  async query({ status, clientId, type, limit = 50, offset = 0 } = {}) {
    const where = [];
    const params = [];
    const add = (sql, val) => { params.push(val); where.push(sql.replace('?', `$${params.length}`)); };
    if (status) add('status = ?', status);
    if (clientId) add('client_id = ?', clientId);
    if (type) add('type = ?', type);
    params.push(Math.min(limit, 500)); const limIdx = params.length;
    params.push(offset); const offIdx = params.length;
    const sql = `SELECT ${COLUMNS} FROM job_history
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC LIMIT $${limIdx} OFFSET $${offIdx}`;
    const { rows } = await this.pool.query(sql, params);
    return rows.map((r) => ({ ...r, result: r.result || null }));
  }

  async stats() {
    const { rows } = await this.pool.query(
      `SELECT status, count(*)::int AS n FROM job_history GROUP BY status`,
    );
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  async close() {
    await this.pool.end();
  }
}

// ---------------------------------------------------------------------------
// SQLite backend (built-in node:sqlite)
// ---------------------------------------------------------------------------
class SqliteHistory {
  constructor(db) {
    this.kind = 'sqlite';
    this.db = db;
  }

  async init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS job_history (
        id TEXT PRIMARY KEY, client_id TEXT, type TEXT, priority TEXT,
        status TEXT, attempts INTEGER, error TEXT, result TEXT,
        created_at INTEGER, finished_at INTEGER, trace_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_hist_client  ON job_history(client_id);
      CREATE INDEX IF NOT EXISTS idx_hist_status  ON job_history(status);
      CREATE INDEX IF NOT EXISTS idx_hist_created ON job_history(created_at DESC);
    `);
  }

  async record(job) {
    const r = toRow(job);
    this.db
      .prepare(
        `INSERT INTO job_history (${COLUMNS})
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           status=excluded.status, attempts=excluded.attempts,
           error=excluded.error, result=excluded.result,
           finished_at=excluded.finished_at`,
      )
      .run(r.id, r.client_id, r.type, r.priority, r.status, r.attempts, r.error, r.result, r.created_at, r.finished_at, r.trace_id);
  }

  async query({ status, clientId, type, limit = 50, offset = 0 } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('status = ?'); params.push(status); }
    if (clientId) { where.push('client_id = ?'); params.push(clientId); }
    if (type) { where.push('type = ?'); params.push(type); }
    params.push(Math.min(limit, 500), offset);
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM job_history
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params);
    return rows.map((r) => ({ ...r, result: r.result ? JSON.parse(r.result) : null }));
  }

  async stats() {
    const rows = this.db.prepare(`SELECT status, count(*) AS n FROM job_history GROUP BY status`).all();
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  async close() {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Factory: Postgres if DATABASE_URL set (Supabase needs SSL); else SQLite.
// ---------------------------------------------------------------------------
export async function createHistoryStore() {
  if (config.databaseUrl) {
    try {
      const { default: pg } = await import('pg');
      const needsSsl =
        /supabase|sslmode=require|amazonaws/.test(config.databaseUrl) || config.dbForceSsl;
      const pool = new pg.Pool({
        connectionString: config.databaseUrl,
        ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
        max: 5,
      });
      await pool.query('SELECT 1');
      const store = new PostgresHistory(pool);
      await store.init();
      logger.info('History sink: Postgres connected', { ssl: !!needsSsl });
      return store;
    } catch (err) {
      logger.error('Postgres unavailable — falling back to SQLite history', {
        error: err.message,
      });
    }
  }

  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(dirname(config.sqlitePath), { recursive: true });
  const db = new DatabaseSync(config.sqlitePath);
  const store = new SqliteHistory(db);
  await store.init();
  logger.info('History sink: SQLite', { path: config.sqlitePath });
  return store;
}
