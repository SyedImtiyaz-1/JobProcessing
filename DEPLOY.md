# Deploying

This is an **always-on** service (background worker pool + live SSE), so it
needs a host that runs a persistent Node process: an **EC2 VM**, **Render**,
**Railway**, or **Docker** all work with **zero code changes**. (Vercel /
Cloudflare Workers serverless functions are *not* suitable — they're stateless
and short-lived, so the worker loop and SSE streams won't run.)

All config comes from environment variables, and the app binds to the
platform-provided `PORT` on `0.0.0.0` — so nothing in the code changes between
local and prod.

## Environment variables

| Var | Value | Notes |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` | `https://<db>.upstash.io` | Redis (state + rate limit) |
| `UPSTASH_REDIS_REST_TOKEN` | `<token>` | app derives the native `rediss://` URL |
| `DATABASE_URL` | `postgresql://postgres.<ref>:<pwd>@aws-1-<region>.pooler.supabase.com:5432/postgres` | **IPv4 Session pooler**, not the direct `db.<ref>` host |
| `WORKER_CONCURRENCY` | `5` | optional tuning |
| `RATE_LIMIT_MAX` | `30` | optional tuning |
| `API_KEYS` | `key:client` | optional — enables `x-api-key` auth |

> Required = the three secrets. Everything else has sane defaults. You can also
> set `REDIS_URL` directly instead of the two Upstash vars.

---

## EC2 (small instance) — recommended for "real server"

A plain VM runs this app as-is. A `t3.small` (2 GB) is plenty.

**1. Launch the instance**
- AMI: Amazon Linux 2023 (or Ubuntu). Type: `t3.small`.
- **Security Group inbound:** SSH `22` (your IP), HTTP `80` (0.0.0.0/0). Open
  `3000` too only if you skip the nginx proxy and hit the app directly.

**2. Get the code + secrets onto it**
```bash
ssh ec2-user@<EC2_PUBLIC_IP>
sudo dnf install -y git          # Ubuntu: sudo apt-get update && sudo apt-get install -y git
git clone <your-repo-url> assesment && cd assesment
cp .env.example .env             # then edit: set UPSTASH_* and DATABASE_URL
```

**3. One-shot setup (installs Node 24, deps, systemd service)**
```bash
bash deploy/ec2-setup.sh
```
Installs the [jobapi.service](deploy/jobapi.service) unit (auto-restart + start
on boot) and prints a local `/health` check.

**4. (Recommended) nginx reverse proxy — public :80 → app :3000, SSE-aware**
```bash
sudo dnf install -y nginx        # Ubuntu: sudo apt-get install -y nginx
sudo cp deploy/nginx-jobapi.conf /etc/nginx/conf.d/jobapi.conf
sudo nginx -t && sudo systemctl enable --now nginx && sudo systemctl reload nginx
```
The [nginx config](deploy/nginx-jobapi.conf) disables buffering on the SSE
endpoints so the live dashboard stream isn't buffered or cut off.

**5. Verify**
```bash
curl -s http://<EC2_PUBLIC_IP>/health     # → store=redis, history=postgres
```
Open `http://<EC2_PUBLIC_IP>/` for the dashboard. Logs: `journalctl -u jobapi -f`.

> TLS: point a domain at the instance and run `certbot --nginx`, or front it
> with an ALB / Cloudflare proxy.

---

## Render (Web Service — manual, no Blueprint)

1. Push this repo to GitHub.
2. Render → **New → Web Service** → connect the repo.
3. Settings: Runtime **Node**, Build `npm install`, Start `npm start`, Health
   Check Path `/health`.
4. **Environment** → add the variables from the table above (Node pinned to 24
   via [.node-version](.node-version), or set `NODE_VERSION=24`).
5. **Create Web Service** → open the URL → check `/health`.

> Free tier sleeps when idle (the worker pauses while asleep) and cold-starts
> return `x-render-routing: no-server` 404s for ~30–60s. Use a paid instance to
> keep it always-on.

## Railway

1. Railway → **New Project → Deploy from GitHub repo**.
2. Autodetects Node, runs `npm start` (`.node-version` pins Node 24).
3. **Variables** → add the env vars from the table.
4. **Settings → Networking → Generate Domain** → open it → check `/health`.

## Docker (any VM / container host)

```bash
docker compose up --build   # API + Redis + Postgres bundled
```

Or build just the API and point it at managed Upstash/Supabase:

```bash
docker build -t job-api .
docker run -p 3000:3000 \
  -e UPSTASH_REDIS_REST_URL=... -e UPSTASH_REDIS_REST_TOKEN=... \
  -e DATABASE_URL=... job-api
```

---

## Post-deploy smoke test

```bash
BASE=http://<your-host>
curl -s $BASE/health
curl -s -XPOST $BASE/api/jobs -H 'content-type: application/json' \
  -H 'x-client-id: smoke' -d '{"type":"report-gen","priority":"HIGH"}'
curl -s "$BASE/api/history?limit=5"
```
