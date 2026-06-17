// Storage abstraction with two interchangeable backends:
//   - RedisStore   : job state + sliding-window rate limiting in Redis
//                    (survives restarts, shared across instances)
//   - MemoryStore  : in-process fallback so the API runs with no infra
//
// The chosen backend is selected at boot based on config.redisUrl and a
// successful Redis connection. Both expose the same async interface.

import { config } from './config.js';
import { logger } from './logger.js';

// Mask the password so secrets never land in logs.
function redactUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return 'redis';
  }
}

// ---------------------------------------------------------------------------
// In-memory backend
// ---------------------------------------------------------------------------
class MemoryStore {
  constructor() {
    this.kind = 'memory';
    this.jobs = new Map(); // id -> job
    this.windows = new Map(); // rateKey -> number[] (timestamps ms)
  }

  async saveJob(job) {
    this.jobs.set(job.id, { ...job });
    return job;
  }

  async getJob(id) {
    const j = this.jobs.get(id);
    return j ? { ...j } : null;
  }

  async listJobs({ status, clientId, limit = 100 } = {}) {
    let arr = [...this.jobs.values()];
    if (status) arr = arr.filter((j) => j.status === status);
    if (clientId) arr = arr.filter((j) => j.clientId === clientId);
    arr.sort((a, b) => b.createdAt - a.createdAt);
    return arr.slice(0, limit);
  }

  // Sliding-window counter. Returns the count *including* this hit.
  async slidingWindowHit(key, nowMs, windowMs) {
    const cutoff = nowMs - windowMs;
    const hits = (this.windows.get(key) || []).filter((t) => t > cutoff);
    hits.push(nowMs);
    this.windows.set(key, hits);
    return { count: hits.length, oldest: hits[0] };
  }

  async cleanup() {
    /* GC handled by listJobs filtering; nothing persistent to close */
  }
}

// ---------------------------------------------------------------------------
// Redis backend
// ---------------------------------------------------------------------------
class RedisStore {
  constructor(redis) {
    this.kind = 'redis';
    this.redis = redis;
    this.ns = 'jobapi';
  }

  jobKey(id) {
    return `${this.ns}:job:${id}`;
  }
  rateKey(key) {
    return `${this.ns}:rl:${key}`;
  }
  indexKey() {
    return `${this.ns}:jobs:index`;
  }

  async saveJob(job) {
    const k = this.jobKey(job.id);
    const pipe = this.redis.multi();
    pipe.set(k, JSON.stringify(job), 'EX', config.jobTtlSeconds);
    // Sorted index by creation time for history listing.
    pipe.zadd(this.indexKey(), job.createdAt, job.id);
    pipe.expire(this.indexKey(), config.jobTtlSeconds);
    await pipe.exec();
    return job;
  }

  async getJob(id) {
    const raw = await this.redis.get(this.jobKey(id));
    return raw ? JSON.parse(raw) : null;
  }

  async listJobs({ status, clientId, limit = 100 } = {}) {
    const ids = await this.redis.zrevrange(this.indexKey(), 0, 499);
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(ids.map((id) => this.jobKey(id)));
    let arr = raws.filter(Boolean).map((r) => JSON.parse(r));
    if (status) arr = arr.filter((j) => j.status === status);
    if (clientId) arr = arr.filter((j) => j.clientId === clientId);
    return arr.slice(0, limit);
  }

  // Sliding window via sorted set of timestamps. Atomic-ish pipeline:
  // prune old, add current, count, set TTL.
  async slidingWindowHit(key, nowMs, windowMs) {
    const k = this.rateKey(key);
    const cutoff = nowMs - windowMs;
    const member = `${nowMs}-${Math.random().toString(36).slice(2, 8)}`;
    const pipe = this.redis.multi();
    pipe.zremrangebyscore(k, 0, cutoff);
    pipe.zadd(k, nowMs, member);
    pipe.zcard(k);
    pipe.pexpire(k, windowMs);
    const res = await pipe.exec();
    const count = res[2][1];
    return { count };
  }

  async cleanup() {
    try {
      await this.redis.quit();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Factory: try Redis, gracefully fall back to memory.
// ---------------------------------------------------------------------------
export async function createStore() {
  if (!config.redisUrl) {
    logger.warn('No REDIS_URL set — using in-memory store (non-persistent)');
    return new MemoryStore();
  }
  try {
    const { default: Redis } = await import('ioredis');
    const redis = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 2,
      lazyConnect: true,
    });
    await redis.connect();
    await redis.ping();
    logger.info('Connected to Redis', { url: redactUrl(config.redisUrl) });
    return new RedisStore(redis);
  } catch (err) {
    logger.error('Redis unavailable — falling back to in-memory store', {
      error: err.message,
    });
    return new MemoryStore();
  }
}
