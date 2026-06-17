#!/usr/bin/env bash
# One-shot EC2 provisioning for the Job Processing API.
# Tested on Amazon Linux 2023 (dnf) and Ubuntu (apt). Run from the repo root:
#   bash deploy/ec2-setup.sh
#
# Prereqs: you've already cloned the repo and created a .env in the repo root
# (copy .env.example and fill UPSTASH_* + DATABASE_URL).

set -euo pipefail

NODE_MAJOR=24
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_USER="$(whoami)"

echo "==> Repo: $APP_DIR   User: $SERVICE_USER"

# --- Install Node.js -------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
  echo "==> Installing Node.js ${NODE_MAJOR}.x"
  if command -v dnf >/dev/null 2>&1; then
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | sudo bash -
    sudo dnf install -y nodejs
  elif command -v yum >/dev/null 2>&1; then
    curl -fsSL "https://rpm.nodesource.com/setup_${NODE_MAJOR}.x" | sudo bash -
    sudo yum install -y nodejs
  else
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo bash -
    sudo apt-get install -y nodejs
  fi
fi
echo "==> node $(node -v)"

# --- App deps --------------------------------------------------------------
echo "==> npm install (production)"
cd "$APP_DIR"
npm install --omit=dev

# --- .env check ------------------------------------------------------------
if [ ! -f "$APP_DIR/.env" ]; then
  echo "!! WARNING: $APP_DIR/.env not found."
  echo "   Without UPSTASH_* / DATABASE_URL it falls back to in-memory + SQLite."
  echo "   cp .env.example .env  &&  edit it, then re-run / restart the service."
fi

# --- systemd service -------------------------------------------------------
echo "==> Installing systemd service (jobapi)"
TMP=$(mktemp)
sed -e "s#^User=.*#User=${SERVICE_USER}#" \
    -e "s#^WorkingDirectory=.*#WorkingDirectory=${APP_DIR}#" \
    "$APP_DIR/deploy/jobapi.service" > "$TMP"
sudo cp "$TMP" /etc/systemd/system/jobapi.service
rm -f "$TMP"
sudo systemctl daemon-reload
sudo systemctl enable --now jobapi

sleep 2
echo "==> Service status:"
sudo systemctl --no-pager --full status jobapi | head -n 8 || true
echo
echo "==> Local health check:"
curl -s http://127.0.0.1:3000/health || echo "(not responding yet — check: journalctl -u jobapi -f)"
echo
echo "Done. Next:"
echo "  • Open port 80 (and/or 3000) in the instance Security Group."
echo "  • Optional reverse proxy: see deploy/nginx-jobapi.conf and DEPLOY.md."
echo "  • Logs: journalctl -u jobapi -f"
