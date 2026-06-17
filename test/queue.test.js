// Unit tests for the priority queue, retry/backoff, and concurrency limits.
// Run with: npm test   (uses node's built-in test runner)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../src/config.js';
import { createStore } from '../src/store.js';
import { JobQueue } from '../src/queue.js';
import { bus } from '../src/events.js';

// Make tests fast + deterministic by tuning the shared config at runtime.
config.retry.baseDelayMs = 1;
config.retry.maxDelayMs = 2;
config.job.failureRate = 0;

// Resolve when a job reaches a terminal status.
function waitFor(jobId, statuses, timeoutMs = 2000) {
  const want = new Set([].concat(statuses));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bus.off(`job:${jobId}`, h);
      reject(new Error(`timeout waiting for ${jobId} -> ${[...want]}`));
    }, timeoutMs);
    const h = (ev) => {
      if (want.has(ev.status)) {
        clearTimeout(timer);
        bus.off(`job:${jobId}`, h);
        resolve(ev);
      }
    };
    bus.on(`job:${jobId}`, h);
  });
}

test('completes a successful job', async () => {
  config.workerConcurrency = 2;
  const store = await createStore();
  const q = new JobQueue(store, { processor: async () => ({ ok: true }) });
  const job = await q.submit({ clientId: 'c1', type: 't', priority: 'NORMAL' });
  const done = await waitFor(job.id, 'completed');
  assert.equal(done.status, 'completed');
  assert.equal(done.attempts, 1);
});

test('retries transient failures with backoff, then succeeds', async () => {
  config.workerConcurrency = 2;
  config.retry.maxRetries = 3;
  let calls = 0;
  const processor = async () => {
    calls++;
    if (calls < 3) {
      const e = new Error('transient');
      e.transient = true;
      throw e;
    }
    return { ok: true };
  };
  const store = await createStore();
  const q = new JobQueue(store, { processor });
  const job = await q.submit({ clientId: 'c1', type: 't', priority: 'HIGH' });
  const done = await waitFor(job.id, 'completed');
  assert.equal(done.status, 'completed');
  assert.equal(done.attempts, 3); // 2 failures + 1 success
});

test('fails permanently after exhausting retries', async () => {
  config.workerConcurrency = 2;
  config.retry.maxRetries = 2;
  const processor = async () => {
    const e = new Error('always fails');
    e.transient = true;
    throw e;
  };
  const store = await createStore();
  const q = new JobQueue(store, { processor });
  const job = await q.submit({ clientId: 'c1', type: 't', priority: 'LOW' });
  const done = await waitFor(job.id, 'failed', 3000);
  assert.equal(done.status, 'failed');
  assert.equal(done.attempts, 3); // initial + 2 retries
});

test('respects strict priority ordering', async () => {
  config.workerConcurrency = 1; // single worker => ordering is observable
  config.retry.maxRetries = 0;
  const order = [];
  const processor = async (job) => {
    await new Promise((r) => setTimeout(r, 20));
    return { p: job.priority };
  };
  const store = await createStore();
  const q = new JobQueue(store, { processor });

  const completed = [];
  const h = (ev) => { if (ev.status === 'completed') completed.push(ev.priority); };
  bus.on('*', h);

  // First job occupies the single worker; next two queue behind it. With a
  // single worker the drain order is LOW (already running), then HIGH, then
  // NORMAL — so NORMAL completes last.
  const low = await q.submit({ clientId: 'p', type: 't', priority: 'LOW' });
  const normal = await q.submit({ clientId: 'p', type: 't', priority: 'NORMAL' });
  await q.submit({ clientId: 'p', type: 't', priority: 'HIGH' });

  await waitFor(normal.id, 'completed', 3000);
  bus.off('*', h);

  // Among the two that were queued behind LOW, HIGH must finish before NORMAL.
  assert.ok(
    completed.indexOf('HIGH') < completed.indexOf('NORMAL'),
    `expected HIGH before NORMAL, got ${completed.join(',')}`,
  );
  void low;
});

test('enforces per-client concurrency limit', async () => {
  config.workerConcurrency = 10; // plenty of global capacity
  config.perClientConcurrency = 2; // but only 2 per client
  config.retry.maxRetries = 0;
  let active = 0;
  let peak = 0;
  const processor = async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 30));
    active--;
    return { ok: true };
  };
  const store = await createStore();
  const q = new JobQueue(store, { processor });

  const ids = [];
  for (let i = 0; i < 6; i++) {
    const j = await q.submit({ clientId: 'solo', type: 't', priority: 'NORMAL' });
    ids.push(j.id);
  }
  await Promise.all(ids.map((id) => waitFor(id, 'completed', 4000)));
  assert.ok(peak <= 2, `peak concurrency for one client should be <= 2, was ${peak}`);
});
