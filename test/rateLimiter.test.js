// Unit tests for the sliding-window rate limiter (in-memory backend).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../src/config.js';
import { createStore } from '../src/store.js';
import { createRateLimiter } from '../src/rateLimiter.js';

// Minimal Express req/res doubles.
function fakeReqRes(clientId) {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  const req = { clientId, log: { warn() {}, error() {} } };
  return { req, res };
}

async function hit(rateLimit, clientId) {
  const { req, res } = fakeReqRes(clientId);
  let passed = false;
  await rateLimit(req, res, () => { passed = true; });
  return { passed, status: res.statusCode, headers: res.headers, body: res.body };
}

test('allows up to the limit, then returns 429', async () => {
  config.rateLimit.max = 5;
  config.rateLimit.windowMs = 10_000;
  const store = await createStore();
  const rateLimit = createRateLimiter(store);

  const results = [];
  for (let i = 0; i < 7; i++) results.push(await hit(rateLimit, 'alice'));

  const allowed = results.filter((r) => r.passed).length;
  const blocked = results.filter((r) => r.status === 429).length;
  assert.equal(allowed, 5);
  assert.equal(blocked, 2);
  assert.equal(results[6].body.error, 'rate_limited');
});

test('limits are per-client (independent windows)', async () => {
  config.rateLimit.max = 3;
  config.rateLimit.windowMs = 10_000;
  const store = await createStore();
  const rateLimit = createRateLimiter(store);

  // bob uses up his quota
  for (let i = 0; i < 3; i++) await hit(rateLimit, 'bob');
  const bobBlocked = await hit(rateLimit, 'bob');
  // carol is unaffected
  const carolOk = await hit(rateLimit, 'carol');

  assert.equal(bobBlocked.status, 429);
  assert.equal(carolOk.passed, true);
});

test('sets standard RateLimit headers', async () => {
  config.rateLimit.max = 10;
  config.rateLimit.windowMs = 60_000;
  const store = await createStore();
  const rateLimit = createRateLimiter(store);

  const r = await hit(rateLimit, 'dave');
  assert.equal(r.headers['RateLimit-Limit'], '10');
  assert.equal(r.headers['RateLimit-Remaining'], '9');
  assert.ok(r.headers['RateLimit-Reset']);
});
