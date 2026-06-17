// Optional API-key authentication.
//
// Disabled by default (open) so the dashboard / demos work with zero config.
// Set API_KEYS="key1:clientA,key2:clientB" to require an `x-api-key` header;
// the authenticated client id then drives rate limiting + per-client limits.

import { config } from './config.js';

export function createAuth() {
  if (!config.apiKeys) return null; // auth disabled

  const map = new Map(
    config.apiKeys
      .split(',')
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const [key, client] = pair.split(':');
        return [key.trim(), (client || key).trim()];
      }),
  );

  return function auth(req, res, next) {
    const key = req.headers['x-api-key'];
    const client = key && map.get(key);
    if (!client) {
      return res.status(401).json({
        error: 'unauthorized',
        message: 'a valid x-api-key header is required',
      });
    }
    // Authenticated identity wins over any client-supplied header.
    req.clientId = client;
    req.log = req.log?.child?.({ clientId: client }) || req.log;
    next();
  };
}
