// Central configuration. All knobs are env-overridable so the same image
// runs in dev (in-memory) and prod (Redis-backed) without code changes.

const num = (v, d) => (v === undefined ? d : Number(v));

// Resolve the Redis connection string. Prefer an explicit REDIS_URL; otherwise
// derive the native TLS endpoint from Upstash REST credentials if present
// (the REST token is also the native Redis password), so a .env containing
// only UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN works out of the box.
function resolveRedisUrl() {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  const restUrl = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (restUrl && token) {
    try {
      const host = new URL(restUrl).host; // e.g. mature-loon-115488.upstash.io
      return `rediss://default:${token}@${host}:6379`;
    } catch {
      /* malformed REST url — fall through to in-memory */
    }
  }
  return null;
}

export const config = {
  port: num(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',

  // If REDIS_URL is set we use Redis for job state + rate limiting.
  // Otherwise we transparently fall back to an in-process store so the
  // service runs with zero infrastructure for demos / local dev.
  redisUrl: resolveRedisUrl(),

  // Worker pool: total jobs processed concurrently across the node.
  workerConcurrency: num(process.env.WORKER_CONCURRENCY, 5),

  // Per-client cap on simultaneously running jobs (fairness).
  perClientConcurrency: num(process.env.PER_CLIENT_CONCURRENCY, 2),

  // Sliding-window rate limit, per client.
  rateLimit: {
    windowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
    max: num(process.env.RATE_LIMIT_MAX, 30),
  },

  // Retry policy for transient failures (exponential backoff w/ jitter).
  retry: {
    maxRetries: num(process.env.MAX_RETRIES, 3),
    baseDelayMs: num(process.env.RETRY_BASE_DELAY_MS, 500),
    maxDelayMs: num(process.env.RETRY_MAX_DELAY_MS, 10_000),
  },

  // Simulated job execution (stands in for real image/report/export work).
  job: {
    minDurationMs: num(process.env.JOB_MIN_MS, 800),
    maxDurationMs: num(process.env.JOB_MAX_MS, 3000),
    failureRate: num(process.env.JOB_FAILURE_RATE, 0.2), // 0..1 transient fail chance
  },

  // How long finished jobs are retained in Redis (live view). Durable
  // long-term history lives in the history sink below.
  jobTtlSeconds: num(process.env.JOB_TTL_SECONDS, 3600),

  // Durable history sink. Set DATABASE_URL (Supabase/Postgres) for prod;
  // otherwise a local SQLite file is used so history works with no infra.
  databaseUrl: process.env.DATABASE_URL || null,
  dbForceSsl: process.env.DB_SSL === 'true',
  sqlitePath: process.env.SQLITE_PATH || './data/history.db',

  // Optional API-key auth. If API_KEYS is unset, auth is disabled (open).
  // Format: "key1:clientA,key2:clientB" (clientId defaults to the key).
  apiKeys: process.env.API_KEYS || null,

  logLevel: process.env.LOG_LEVEL || 'info',
};
