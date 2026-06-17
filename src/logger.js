// Minimal structured (JSON) logger. One line == one event, machine-parseable,
// with trace context woven in so logs correlate with distributed traces.

import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? 20;

function emit(level, msg, fields = {}) {
  if (LEVELS[level] < threshold) return;
  const record = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };
  const line = JSON.stringify(record);
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const logger = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),

  // Returns a logger that automatically attaches the given fields
  // (e.g. traceId, jobId, clientId) to every line.
  child(bound = {}) {
    return {
      debug: (msg, fields) => emit('debug', msg, { ...bound, ...fields }),
      info: (msg, fields) => emit('info', msg, { ...bound, ...fields }),
      warn: (msg, fields) => emit('warn', msg, { ...bound, ...fields }),
      error: (msg, fields) => emit('error', msg, { ...bound, ...fields }),
      child: (more) => logger.child({ ...bound, ...more }),
    };
  },
};
