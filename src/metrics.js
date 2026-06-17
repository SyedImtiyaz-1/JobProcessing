// Prometheus-compatible metrics via prom-client. Exposed at /metrics.

import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'jobapi_' });

export const metrics = {
  jobsSubmitted: new client.Counter({
    name: 'jobapi_jobs_submitted_total',
    help: 'Total jobs accepted for processing',
    labelNames: ['priority', 'type'],
    registers: [registry],
  }),
  jobsCompleted: new client.Counter({
    name: 'jobapi_jobs_completed_total',
    help: 'Total jobs that finished successfully',
    labelNames: ['priority', 'type'],
    registers: [registry],
  }),
  jobsFailed: new client.Counter({
    name: 'jobapi_jobs_failed_total',
    help: 'Total jobs that exhausted retries and failed',
    labelNames: ['priority', 'type'],
    registers: [registry],
  }),
  jobRetries: new client.Counter({
    name: 'jobapi_job_retries_total',
    help: 'Total retry attempts across all jobs',
    labelNames: ['type'],
    registers: [registry],
  }),
  rateLimited: new client.Counter({
    name: 'jobapi_rate_limited_total',
    help: 'Requests rejected by the rate limiter',
    labelNames: ['client'],
    registers: [registry],
  }),
  jobDuration: new client.Histogram({
    name: 'jobapi_job_duration_seconds',
    help: 'Wall-clock duration of job execution',
    labelNames: ['priority', 'type', 'outcome'],
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
    registers: [registry],
  }),
  queueDepth: new client.Gauge({
    name: 'jobapi_queue_depth',
    help: 'Jobs currently waiting in the queue, by priority',
    labelNames: ['priority'],
    registers: [registry],
  }),
  activeWorkers: new client.Gauge({
    name: 'jobapi_active_workers',
    help: 'Jobs currently being processed',
    registers: [registry],
  }),
  sseClients: new client.Gauge({
    name: 'jobapi_sse_clients',
    help: 'Connected Server-Sent-Events subscribers',
    registers: [registry],
  }),
};
