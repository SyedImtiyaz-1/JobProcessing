// HTTP surface: job submission, status, history, SSE streams, metrics, health.

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { config } from './config.js';
import { logger } from './logger.js';
import { registry, metrics } from './metrics.js';
import { tracingMiddleware } from './tracing.js';
import { createStore } from './store.js';
import { createHistoryStore } from './history.js';
import { createRateLimiter } from './rateLimiter.js';
import { createAuth } from './auth.js';
import { JobQueue, PRIORITIES } from './queue.js';
import { bus } from './events.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const store = await createStore();
  const history = await createHistoryStore();
  const queue = new JobQueue(store, { history });
  const auth = createAuth(); // null when API_KEYS unset (auth disabled)
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  // --- trace context + per-request logger + client identity ---------------
  app.use(tracingMiddleware);
  app.use((req, res, next) => {
    req.clientId = String(
      req.headers['x-client-id'] || req.query.clientId || req.ip || 'anonymous',
    );
    req.log = logger.child({ traceId: req.trace.traceId, clientId: req.clientId });
    next();
  });

  const rateLimit = createRateLimiter(store);

  // --- static dashboard ----------------------------------------------------
  app.use(express.static(join(__dirname, '..', 'public')));

  // --- health & metrics ----------------------------------------------------
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      store: store.kind,
      history: history.kind,
      auth: auth ? 'enabled' : 'disabled',
      ...queue.stats(),
    });
  });

  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  });

  // --- submit a job (auth optional, then rate limited) --------------------
  const submitChain = [];
  if (auth) submitChain.push(auth);
  submitChain.push(rateLimit);
  app.post('/api/jobs', ...submitChain, async (req, res) => {
    const { type = 'generic', priority = 'NORMAL', payload = {} } = req.body || {};
    if (!PRIORITIES.includes(priority)) {
      return res.status(400).json({
        error: 'invalid_priority',
        message: `priority must be one of ${PRIORITIES.join(', ')}`,
      });
    }
    const job = await queue.submit({
      clientId: req.clientId,
      type: String(type).slice(0, 64),
      priority,
      payload,
      traceId: req.trace.traceId,
    });
    res.status(202).json({
      id: job.id,
      status: job.status,
      priority: job.priority,
      type: job.type,
      traceId: job.traceId,
      links: {
        self: `/api/jobs/${job.id}`,
        events: `/api/jobs/${job.id}/events`,
      },
    });
  });

  // --- get one job ---------------------------------------------------------
  app.get('/api/jobs/:id', async (req, res) => {
    const job = await store.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'not_found' });
    res.json(job);
  });

  // --- history / list ------------------------------------------------------
  app.get('/api/jobs', async (req, res) => {
    const { status, clientId } = req.query;
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const jobs = await store.listJobs({ status, clientId, limit });
    res.json({ count: jobs.length, jobs });
  });

  // --- durable history (Postgres/Supabase or SQLite) ----------------------
  // Long-term querying of finished jobs, beyond the Redis live-view TTL.
  app.get('/api/history', async (req, res) => {
    const { status, clientId, type } = req.query;
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const [jobs, summary] = await Promise.all([
      history.query({ status, clientId, type, limit, offset }),
      history.stats().catch(() => ({})),
    ]);
    res.json({ backend: history.kind, count: jobs.length, summary, jobs });
  });

  // --- queue stats ---------------------------------------------------------
  app.get('/api/stats', (req, res) => res.json(queue.stats()));

  // --- SSE: per-job stream -------------------------------------------------
  app.get('/api/jobs/:id/events', async (req, res) => {
    const job = await store.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'not_found' });
    const topic = `job:${req.params.id}`;
    openSse(req, res, (write) => {
      write('snapshot', job);
      const handler = (ev) => {
        write('update', ev);
        if (ev.status === 'completed' || ev.status === 'failed') res.end();
      };
      bus.on(topic, handler);
      return () => bus.off(topic, handler);
    });
  });

  // --- SSE: firehose for the dashboard ------------------------------------
  app.get('/api/events', (req, res) => {
    openSse(req, res, (write) => {
      const handler = (ev) => write('update', ev);
      bus.on('*', handler);
      const statsTimer = setInterval(() => write('stats', queue.stats()), 1000);
      return () => {
        bus.off('*', handler);
        clearInterval(statsTimer);
      };
    });
  });

  // --- error handler -------------------------------------------------------
  app.use((err, req, res, next) => {
    req.log?.error('unhandled error', { error: err.message });
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  });

  const server = app.listen(config.port, config.host, () => {
    logger.info('job processing API listening', {
      url: `http://localhost:${config.port}`,
      store: store.kind,
      history: history.kind,
      auth: auth ? 'enabled' : 'disabled',
      workerConcurrency: config.workerConcurrency,
    });
  });

  // Graceful shutdown.
  const shutdown = async (sig) => {
    logger.info('shutting down', { signal: sig });
    server.close();
    await Promise.allSettled([store.cleanup(), history.close()]);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Shared SSE plumbing: headers, heartbeat, subscriber wiring, cleanup.
function openSse(req, res, subscribe) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  metrics.sseClients.inc();

  const write = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  const unsubscribe = subscribe(write);

  req.on('close', () => {
    clearInterval(heartbeat);
    if (unsubscribe) unsubscribe();
    metrics.sseClients.dec();
  });
}

main().catch((err) => {
  logger.error('fatal startup error', { error: err.stack || err.message });
  process.exit(1);
});
