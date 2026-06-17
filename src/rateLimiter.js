// Per-client sliding-window rate limiter. Backed by the store (Redis sorted
// set in prod, array in dev). Returns standard rate-limit headers.

import { config } from './config.js';
import { metrics } from './metrics.js';

export function createRateLimiter(store) {
  const { windowMs, max } = config.rateLimit;

  return async function rateLimit(req, res, next) {
    const clientId = req.clientId;
    try {
      const now = Date.now();
      const { count } = await store.slidingWindowHit(clientId, now, windowMs);
      const remaining = Math.max(0, max - count);
      const resetSec = Math.ceil((now + windowMs) / 1000);

      res.setHeader('RateLimit-Limit', String(max));
      res.setHeader('RateLimit-Remaining', String(remaining));
      res.setHeader('RateLimit-Reset', String(resetSec));

      if (count > max) {
        metrics.rateLimited.inc({ client: clientId });
        res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
        req.log?.warn('rate limit exceeded', { clientId, count, max });
        return res.status(429).json({
          error: 'rate_limited',
          message: `Rate limit of ${max} requests per ${windowMs / 1000}s exceeded`,
          retryAfterMs: windowMs,
        });
      }
      next();
    } catch (err) {
      // Fail open — a rate-limiter outage shouldn't take down the API.
      req.log?.error('rate limiter error (failing open)', { error: err.message });
      next();
    }
  };
}
