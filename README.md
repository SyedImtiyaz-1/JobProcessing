# Background Job Processing API

A production-grade Node.js REST API that accepts job submissions, processes them
asynchronously through a **priority queue**, enforces **per-client rate limits**
(sliding window), streams **real-time status via SSE**, and ships a full
**observability layer** (structured JSON logs, Prometheus metrics, W3C Trace
Context propagation)

> Runs with **zero infrastructure** out of the box (in-memory store). Point it at
> Redis with one env var for persistence + horizontal scale.

## Quick start

```bash
npm install
npm start
# open http://localhost:3000  → the dashboard
```

Generate some load:

```bash
npm run seed          # fires 40 mixed jobs
# or just click "Burst ×25" in the dashboard
```

With Redis (optional):

```bash
REDIS_URL=redis://localhost:6379 npm start
```

### Upstash (serverless Redis)

No code change — Upstash speaks the standard Redis protocol over TLS. Grab the
**ioredis / TLS connection string** from the Upstash console (Database →
*Connect* → Node/ioredis) and pass it as `REDIS_URL`:

```bash
REDIS_URL='rediss://default:<PASSWORD>@<region>.upstash.io:6379' npm start
```

The `rediss://` scheme makes ioredis negotiate TLS automatically. On boot you'll
see `Connected to Redis` in the logs and `"store":"redis"` at `GET /health`.
For a long-running server use the native Redis endpoint above (not the REST
URL) — it pools one connection and supports the sorted-set ops the rate limiter
relies on.

**Using a `.env` file** — `npm start`/`npm run dev` auto-load `.env`. You can drop
in the native string, *or* paste Upstash's REST credentials and let the app
derive the native endpoint for you:

```ini
# .env
UPSTASH_REDIS_REST_URL="https://<db>.upstash.io"
UPSTASH_REDIS_REST_TOKEN="<token>"
```

(`REDIS_URL` takes precedence if both are set. The password is redacted in logs.)

## Features → where they live

| Requirement | Implementation |
|---|---|
| Job submission REST API | `POST /api/jobs` → [src/server.js](src/server.js) |
| Priority queue (HIGH/NORMAL/LOW) | [src/queue.js](src/queue.js) — strict-priority scheduler |
| Async worker pool + per-client concurrency | [src/queue.js](src/queue.js) (`workerConcurrency`, `perClientConcurrency`) |
| Retry w/ exponential backoff + jitter | [src/queue.js](src/queue.js) `#backoff()` |
| Per-client rate limiting (sliding window) | [src/rateLimiter.js](src/rateLimiter.js) + [src/store.js](src/store.js) (Redis ZSET / in-mem) |
| Job state persistence (Redis, in-mem fallback) | [src/store.js](src/store.js) |
| Durable history DB (Postgres/Supabase, SQLite fallback) | [src/history.js](src/history.js) → `GET /api/history` |
| Real-time status via SSE | `GET /api/jobs/:id/events`, `GET /api/events` |
| Prometheus metrics | `GET /metrics` → [src/metrics.js](src/metrics.js) |
| Structured logging | [src/logger.js](src/logger.js) (JSON, trace-correlated) |
| W3C Trace Context propagation | [src/tracing.js](src/tracing.js) (`traceparent`) |
| Optional API-key auth | [src/auth.js](src/auth.js) (`API_KEYS` → `x-api-key`) |
| Dashboard (white / black theme) | [public/](public/) |
| Tests + Docker | [test/](test/) (`npm test`), [Dockerfile](Dockerfile) + [docker-compose.yml](docker-compose.yml) |

## API

```
POST /api/jobs            submit a job   { type, priority, payload }   → 202
GET  /api/jobs/:id        job status (full record incl. history)
GET  /api/jobs            live list (Redis) ?status=&clientId=&limit=
GET  /api/history         durable history (DB) ?status=&clientId=&type=&limit=&offset=
GET  /api/jobs/:id/events SSE stream for one job
GET  /api/events          SSE firehose (used by the dashboard)
GET  /api/stats           queue depth + worker stats
GET  /metrics             Prometheus exposition
GET  /health             liveness + store/history backends
```

Client identity comes from the `x-client-id` header (or the authenticated
API key when `API_KEYS` is set; falls back to IP).

### Examples

```bash
# submit a HIGH-priority job
curl -XPOST localhost:3000/api/jobs \
  -H 'content-type: application/json' -H 'x-client-id: acme-co' \
  -d '{"type":"report-gen","priority":"HIGH","payload":{"month":"2026-06"}}'

# stream its status
curl -N localhost:3000/api/jobs/<id>/events

# trace propagation — the response echoes a W3C traceparent
curl -i localhost:3000/api/stats \
  -H 'traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
```

## How the queue works

1. Jobs land in one of three priority bands. The scheduler always drains
   `HIGH` before `NORMAL` before `LOW`.
2. A worker pool processes up to `WORKER_CONCURRENCY` jobs at once. When picking
   the next job it **skips any client already at `PER_CLIENT_CONCURRENCY`** so a
   single noisy client can't starve everyone else.
3. A transient failure re-queues the job after `base * 2^attempt` ms (full
   jitter, capped). After `MAX_RETRIES` it's marked `failed`.
4. Every transition is persisted, emitted to SSE subscribers, and recorded in
   metrics.

Job logic is **simulated** (configurable delay + random failure rate) — swap
`runSimulatedJob` in [src/queue.js](src/queue.js) for real work.

## Observability

- **Logs** — one JSON object per line on stdout/stderr, every line carries
  `traceId` so logs join up with traces.
- **Metrics** — `jobapi_jobs_{submitted,completed,failed}_total`,
  `jobapi_job_duration_seconds` (histogram), `jobapi_queue_depth`,
  `jobapi_active_workers`, `jobapi_rate_limited_total`, `jobapi_sse_clients`,
  plus default Node process metrics.
- **Tracing** — incoming `traceparent` is parsed and continued; otherwise a new
  trace is minted. The server's `traceparent` + `x-trace-id` are returned on
  every response.

## Durable history (Supabase / Postgres)

Finished jobs are written to a durable SQL store for long-term querying via
`GET /api/history` (filter by `status`, `clientId`, `type`; paginate with
`limit`/`offset`). Backend selection:

- `DATABASE_URL` set → **Postgres** (Supabase or any Postgres). The table is
  auto-created; SSL is enabled automatically for Supabase/RDS hosts.
- unset → **SQLite** at `SQLITE_PATH` (built-in `node:sqlite`) — zero infra.

**Supabase note:** use the **IPv4 connection pooler** string, not the direct
`db.<ref>.supabase.co` endpoint (that one is IPv6-only and unreachable from most
hosts/CI). In the Supabase dashboard: *Connect → Session pooler*:

```ini
DATABASE_URL="postgresql://postgres.<ref>:<PASSWORD>@aws-1-<region>.pooler.supabase.com:5432/postgres"
```

## Authentication (optional)

Disabled by default. Set `API_KEYS="key:client,key2:client2"` to require an
`x-api-key` header on job submission; the authenticated client id then drives
rate limiting and per-client concurrency.

```bash
API_KEYS="demo-key:acme-co" npm start
curl -XPOST localhost:3000/api/jobs -H 'x-api-key: demo-key' \
  -H 'content-type: application/json' -d '{"priority":"HIGH"}'
```

## Tests

```bash
npm test   # node's built-in runner — queue (priority/retry/concurrency) + rate limiter
```

## Docker

```bash
docker compose up --build    # API + Redis + Postgres, then open http://localhost:3000
```

## Configuration

All knobs are env vars — see [.env.example](.env.example).

## Production notes / trade-offs

- The scheduler is **single-instance** (in-process arrays). For multi-node scale,
  swap the band arrays for Redis lists (`BRPOPLPUSH`) — the store and event
  interfaces are already shaped for it. Job state and rate limiting are already
  Redis-backed and shared.
- SSE is used (not WebSockets) because status flow is server→client only; it
  reconnects automatically and rides over plain HTTP.
- The rate limiter **fails open** — a limiter outage degrades to no limiting
  rather than dropping traffic.
- The durable history sink is **fire-and-forget** — a DB hiccup is logged but
  never blocks or fails job processing; Redis remains the source of truth for
  live state.
