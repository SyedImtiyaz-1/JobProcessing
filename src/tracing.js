// W3C Trace Context (https://www.w3.org/TR/trace-context/) propagation.
// Parses an incoming `traceparent`, or mints a fresh trace, and exposes
// the context on req so it flows into logs and downstream service calls.

import { randomBytes } from 'node:crypto';

const TRACEPARENT_RE =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

const hex = (bytes) => randomBytes(bytes).toString('hex');

export function newTraceId() {
  return hex(16); // 16 bytes -> 32 hex chars
}
export function newSpanId() {
  return hex(8); // 8 bytes -> 16 hex chars
}

function parseTraceparent(value) {
  if (typeof value !== 'string') return null;
  const m = TRACEPARENT_RE.exec(value.trim());
  if (!m) return null;
  const [, version, traceId, parentId, flags] = m;
  if (traceId === '0'.repeat(32) || parentId === '0'.repeat(16)) return null;
  return { version, traceId, parentId, flags };
}

export function formatTraceparent({ traceId, spanId, flags = '01' }) {
  return `00-${traceId}-${spanId}-${flags}`;
}

// Express middleware: hydrate req.trace and echo a server traceparent back.
export function tracingMiddleware(req, res, next) {
  const incoming = parseTraceparent(req.headers['traceparent']);
  const traceId = incoming?.traceId || newTraceId();
  const parentId = incoming?.parentId || null;
  const spanId = newSpanId(); // this server's span for the request
  const flags = incoming?.flags || '01';

  req.trace = { traceId, parentId, spanId, flags, tracestate: req.headers['tracestate'] || null };

  // Surface the trace so callers / browsers can correlate.
  res.setHeader('traceparent', formatTraceparent({ traceId, spanId, flags }));
  res.setHeader('x-trace-id', traceId);
  next();
}
