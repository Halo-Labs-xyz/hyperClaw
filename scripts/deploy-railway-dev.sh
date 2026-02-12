#!/usr/bin/env bash
set -euo pipefail

# Non-interactive Railway deploy for this repo's dev service.
# Requires a valid RAILWAY_TOKEN and linked project/service ids.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v railway >/dev/null 2>&1; then
  echo "railway CLI not found" >&2
  exit 1
fi

if [ -z "${RAILWAY_TOKEN:-}" ]; then
  echo "RAILWAY_TOKEN is required" >&2
  exit 1
fi

PROJECT_ID="${RAILWAY_PROJECT_ID:-}"
SERVICE_ID="${RAILWAY_SERVICE_ID:-}"
ENVIRONMENT_ID="${RAILWAY_ENVIRONMENT_ID:-}"

if [ -z "$PROJECT_ID" ] && [ -f .env ]; then
  PROJECT_ID="$(awk -F= '/^RAILWAY_PROJECT_ID=/{print $2}' .env | tail -n1 | tr -d '[:space:]')"
fi

if [ -z "$PROJECT_ID" ]; then
  echo "RAILWAY_PROJECT_ID is required" >&2
  exit 1
fi

echo "[railway] validating auth"
railway whoami >/dev/null

echo "[railway] linking project"
if [ -n "$SERVICE_ID" ] && [ -n "$ENVIRONMENT_ID" ]; then
  railway link --project "$PROJECT_ID" --service "$SERVICE_ID" --environment "$ENVIRONMENT_ID" >/dev/null
elif [ -n "$SERVICE_ID" ]; then
  railway link --project "$PROJECT_ID" --service "$SERVICE_ID" >/dev/null
else
  railway link --project "$PROJECT_ID" >/dev/null
fi

echo "[railway] status"
railway status

echo "[railway] deploying"
railway up --detach

echo "[railway] latest deployment"
railway deployments | sed -n '1,20p'
