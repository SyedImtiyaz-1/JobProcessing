// Priority job queue + worker pool.
//
//  * Three priority bands (HIGH > NORMAL > LOW), strict priority scheduling.
//  * Global worker concurrency cap + per-client concurrency cap (fairness).
//  * Exponential backoff with jitter for transient failures.
//  * Every state transition is persisted to the store and published to the
//    event bus (which feeds SSE subscribers) and reflected in metrics.
//
// The scheduler here is single-instance (in-process). For horizontal scale
// you'd swap the in-memory band arrays for Redis lists (BRPOPLPUSH) — the
// store + event interfaces are already designed for that.

import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { logger } from './logger.js';
import { metrics } from './metrics.js';
import { bus } from './events.js';

export const PRIORITIES = ['HIGH', 'NORMAL', 'LOW'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Simulated unit of work — stands in for image processing / report gen / export.
async function runSimulatedJob(job) {
  const { minDurationMs, maxDurationMs, failureRate } = config.job;
  const span = maxDurationMs - minDurationMs;
  const duration = minDurationMs + Math.floor(Math.random() * Math.max(1, span));
  await sleep(duration);

  if (Math.random() < failureRate) {
    const err = new Error('Simulated transient failure (downstream timeout)');
    err.transient = true;
    throw err;
  }
  return {
    durationMs: duration,
    output: `processed ${job.type} for ${job.clientId}`,
    bytes: Math.floor(Math.random() * 1_000_000),
  };
}

export class JobQueue {
  constructor(store, { processor = runSimulatedJob, history = null } = {}) {
    this.store = store;
    this.processor = processor;
    this.history = history; // durable sink for finished jobs (optional)
    this.bands = { HIGH: [], NORMAL: [], LOW: [] };
    this.activeTotal = 0;
    this.activePerClient = new Map(); // clientId -> count
    this.draining = false;
    this.refreshDepthMetrics();
  }

  refreshDepthMetrics() {
    for (const p of PRIORITIES) metrics.queueDepth.set({ priority: p }, this.bands[p].length);
    metrics.activeWorkers.set(this.activeTotal);
  }

  async submit({ clientId, type = 'generic', priority = 'NORMAL', payload = {}, traceId }) {
    if (!PRIORITIES.includes(priority)) priority = 'NORMAL';
    const now = Date.now();
    const job = {
      id: randomUUID(),
      clientId,
      type,
      priority,
      payload,
      status: 'queued',
      attempts: 0,
      maxRetries: config.retry.maxRetries,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      nextRetryAt: null,
      result: null,
      error: null,
      traceId: traceId || null,
      history: [{ status: 'queued', ts: now }],
    };

    await this.store.saveJob(job);
    metrics.jobsSubmitted.inc({ priority, type });
    this.bands[priority].push(job);
    this.refreshDepthMetrics();

    bus.publish({ jobId: job.id, clientId, status: 'queued', priority, type, ts: now });
    logger.child({ traceId: job.traceId, jobId: job.id }).info('job submitted', {
      clientId, priority, type,
    });

    this.tick();
    return job;
  }

  // Pick the next runnable job: strict priority, skipping clients already at
  // their concurrency cap (prevents one client starving others).
  #pickNext() {
    for (const p of PRIORITIES) {
      const band = this.bands[p];
      for (let i = 0; i < band.length; i++) {
        const job = band[i];
        const running = this.activePerClient.get(job.clientId) || 0;
        if (running < config.perClientConcurrency) {
          band.splice(i, 1);
          return job;
        }
      }
    }
    return null;
  }

  // Fill any free worker slots with runnable jobs.
  tick() {
    while (this.activeTotal < config.workerConcurrency) {
      const job = this.#pickNext();
      if (!job) break;
      this.#runJob(job); // fire-and-forget; manages its own lifecycle
    }
    this.refreshDepthMetrics();
  }

  async #transition(job, patch, note) {
    Object.assign(job, patch, { updatedAt: Date.now() });
    job.history.push({ status: job.status, ts: job.updatedAt, ...(note ? { note } : {}) });
    await this.store.saveJob(job);
    bus.publish({
      jobId: job.id,
      clientId: job.clientId,
      status: job.status,
      priority: job.priority,
      type: job.type,
      attempts: job.attempts,
      error: job.error,
      result: job.result,
      ts: job.updatedAt,
    });
  }

  async #runJob(job) {
    this.activeTotal++;
    this.activePerClient.set(job.clientId, (this.activePerClient.get(job.clientId) || 0) + 1);
    this.refreshDepthMetrics();

    const log = logger.child({ traceId: job.traceId, jobId: job.id, clientId: job.clientId });
    job.attempts++;
    const startedAt = Date.now();
    const endTimer = metrics.jobDuration.startTimer({ priority: job.priority, type: job.type });

    await this.#transition(job, { status: 'running', startedAt }, `attempt ${job.attempts}`);
    log.info('job started', { attempt: job.attempts });

    try {
      const result = await this.processor(job);
      endTimer({ outcome: 'success' });
      await this.#transition(job, {
        status: 'completed',
        result,
        finishedAt: Date.now(),
        error: null,
      });
      metrics.jobsCompleted.inc({ priority: job.priority, type: job.type });
      this.#archive(job, log);
      log.info('job completed', { attempt: job.attempts });
    } catch (err) {
      endTimer({ outcome: 'failure' });
      const canRetry = (err.transient ?? true) && job.attempts <= job.maxRetries;
      if (canRetry) {
        const delay = this.#backoff(job.attempts);
        metrics.jobRetries.inc({ type: job.type });
        await this.#transition(
          job,
          { status: 'retrying', error: err.message, nextRetryAt: Date.now() + delay },
          `retry in ${delay}ms`,
        );
        log.warn('job failed — scheduling retry', {
          attempt: job.attempts, delayMs: delay, error: err.message,
        });
        setTimeout(() => {
          job.status = 'queued';
          job.nextRetryAt = null;
          this.bands[job.priority].push(job);
          this.refreshDepthMetrics();
          this.tick();
        }, delay);
      } else {
        await this.#transition(job, {
          status: 'failed',
          error: err.message,
          finishedAt: Date.now(),
        });
        metrics.jobsFailed.inc({ priority: job.priority, type: job.type });
        this.#archive(job, log);
        log.error('job failed permanently', { attempts: job.attempts, error: err.message });
      }
    } finally {
      this.activeTotal--;
      const c = (this.activePerClient.get(job.clientId) || 1) - 1;
      if (c <= 0) this.activePerClient.delete(job.clientId);
      else this.activePerClient.set(job.clientId, c);
      this.refreshDepthMetrics();
      this.tick(); // a slot just freed up
    }
  }

  // Persist a finished job to the durable history sink (non-blocking).
  #archive(job, log) {
    this.history?.record(job).catch((err) =>
      log.error('history record failed', { error: err.message }),
    );
  }

  // Exponential backoff with full jitter, capped at maxDelayMs.
  #backoff(attempt) {
    const { baseDelayMs, maxDelayMs } = config.retry;
    const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    return Math.floor(Math.random() * exp); // full jitter
  }

  stats() {
    return {
      depth: {
        HIGH: this.bands.HIGH.length,
        NORMAL: this.bands.NORMAL.length,
        LOW: this.bands.LOW.length,
        total: this.bands.HIGH.length + this.bands.NORMAL.length + this.bands.LOW.length,
      },
      active: this.activeTotal,
      capacity: config.workerConcurrency,
      clientsRunning: this.activePerClient.size,
    };
  }
}
