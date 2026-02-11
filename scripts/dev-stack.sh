#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${LOG_DIR:-/tmp/hyperclaw-stack}"
mkdir -p "$LOG_DIR"

PG_CONTAINER="${PG_CONTAINER:-hyperclaw-pgvector}"
PG_IMAGE="${PG_IMAGE:-pgvector/pgvector:pg16}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-ironclaw}"
PG_PASSWORD="${PG_PASSWORD:-ironclaw}"
PG_DB="${PG_DB:-ironclaw}"

IRONCLAW_PORT="${IRONCLAW_PORT:-8080}"
HYPERCLAW_PORT="${HYPERCLAW_PORT:-3014}"

IRONCLAW_PID_FILE="$LOG_DIR/ironclaw.pid"
HYPERCLAW_PID_FILE="$LOG_DIR/hyperclaw.pid"
GENERATED_SECRETS_FILE="$LOG_DIR/generated-secrets.env"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

is_pid_running() {
  local pid_file="$1"
  [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" >/dev/null 2>&1
}

echo "Starting local stack from $ROOT_DIR"

need_cmd docker
need_cmd cargo
need_cmd npm
need_cmd openssl
need_cmd curl

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ROOT_DIR/.env"
  set +a
fi

export DATABASE_URL="${DATABASE_URL:-postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB}}"
export HTTP_HOST="${HTTP_HOST:-127.0.0.1}"
export HTTP_PORT="${HTTP_PORT:-$IRONCLAW_PORT}"
export CLI_ENABLED="${CLI_ENABLED:-false}"
export RUST_LOG="${RUST_LOG:-ironclaw=info}"
export IRONCLAW_WEBHOOK_URL="${IRONCLAW_WEBHOOK_URL:-http://127.0.0.1:${IRONCLAW_PORT}/webhook}"

if [[ -z "${SECRETS_MASTER_KEY:-}" ]]; then
  export SECRETS_MASTER_KEY="$(openssl rand -hex 32)"
fi
if [[ -z "${HYPERCLAW_API_KEY:-}" ]]; then
  export HYPERCLAW_API_KEY="$(openssl rand -hex 32)"
fi
if [[ -z "${MCP_API_KEY:-}" ]]; then
  export MCP_API_KEY="$HYPERCLAW_API_KEY"
fi
if [[ -z "${ORCHESTRATOR_SECRET:-}" ]]; then
  export ORCHESTRATOR_SECRET="$(openssl rand -hex 32)"
fi
if [[ -z "${IRONCLAW_WEBHOOK_SECRET:-}" ]]; then
  export IRONCLAW_WEBHOOK_SECRET="$(openssl rand -hex 32)"
fi
if [[ -z "${HTTP_WEBHOOK_SECRET:-}" ]]; then
  export HTTP_WEBHOOK_SECRET="$IRONCLAW_WEBHOOK_SECRET"
fi

cat > "$GENERATED_SECRETS_FILE" <<EOF
SECRETS_MASTER_KEY=$SECRETS_MASTER_KEY
HYPERCLAW_API_KEY=$HYPERCLAW_API_KEY
MCP_API_KEY=$MCP_API_KEY
ORCHESTRATOR_SECRET=$ORCHESTRATOR_SECRET
IRONCLAW_WEBHOOK_SECRET=$IRONCLAW_WEBHOOK_SECRET
HTTP_WEBHOOK_SECRET=$HTTP_WEBHOOK_SECRET
DATABASE_URL=$DATABASE_URL
IRONCLAW_WEBHOOK_URL=$IRONCLAW_WEBHOOK_URL
EOF
chmod 600 "$GENERATED_SECRETS_FILE"

if docker ps --format '{{.Names}}' | grep -Fxq "$PG_CONTAINER"; then
  echo "Postgres container already running: $PG_CONTAINER"
elif docker ps -a --format '{{.Names}}' | grep -Fxq "$PG_CONTAINER"; then
  echo "Starting existing Postgres container: $PG_CONTAINER"
  docker start "$PG_CONTAINER" >/dev/null
else
  echo "Creating Postgres+pgvector container: $PG_CONTAINER"
  docker run -d \
    --name "$PG_CONTAINER" \
    -e POSTGRES_USER="$PG_USER" \
    -e POSTGRES_PASSWORD="$PG_PASSWORD" \
    -e POSTGRES_DB="$PG_DB" \
    -p "${PG_PORT}:5432" \
    "$PG_IMAGE" >/dev/null
fi

echo "Waiting for Postgres readiness..."
for _ in $(seq 1 60); do
  if docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null

if is_pid_running "$IRONCLAW_PID_FILE"; then
  echo "IronClaw already running (pid $(cat "$IRONCLAW_PID_FILE"))"
else
  echo "Starting IronClaw on ${HTTP_HOST}:${HTTP_PORT} ..."
  nohup env \
    DATABASE_URL="$DATABASE_URL" \
    SECRETS_MASTER_KEY="$SECRETS_MASTER_KEY" \
    CLI_ENABLED="$CLI_ENABLED" \
    HTTP_HOST="$HTTP_HOST" \
    HTTP_PORT="$HTTP_PORT" \
    HTTP_WEBHOOK_SECRET="$HTTP_WEBHOOK_SECRET" \
    RUST_LOG="$RUST_LOG" \
    cargo run --manifest-path "$ROOT_DIR/ironclaw/Cargo.toml" -- --no-onboard \
    > "$LOG_DIR/ironclaw.log" 2>&1 &
  echo $! > "$IRONCLAW_PID_FILE"
fi

if is_pid_running "$HYPERCLAW_PID_FILE"; then
  echo "hyperClaw already running (pid $(cat "$HYPERCLAW_PID_FILE"))"
else
  echo "Starting hyperClaw on 127.0.0.1:${HYPERCLAW_PORT} ..."
  nohup env \
    HYPERCLAW_API_KEY="$HYPERCLAW_API_KEY" \
    MCP_API_KEY="$MCP_API_KEY" \
    ORCHESTRATOR_SECRET="$ORCHESTRATOR_SECRET" \
    IRONCLAW_WEBHOOK_URL="$IRONCLAW_WEBHOOK_URL" \
    IRONCLAW_WEBHOOK_SECRET="$IRONCLAW_WEBHOOK_SECRET" \
    npm run dev -- -H 127.0.0.1 -p "$HYPERCLAW_PORT" \
    > "$LOG_DIR/hyperclaw.log" 2>&1 &
  echo $! > "$HYPERCLAW_PID_FILE"
fi

echo "Waiting for HTTP endpoints..."
for _ in $(seq 1 60); do
  if curl -sS --max-time 2 "http://127.0.0.1:${HYPERCLAW_PORT}/api/startup" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

for _ in $(seq 1 60); do
  if curl -sS --max-time 2 "http://127.0.0.1:${IRONCLAW_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

cat <<EOF

Stack started.

Postgres:   postgres://${PG_USER}:***@127.0.0.1:${PG_PORT}/${PG_DB}
IronClaw:   http://127.0.0.1:${IRONCLAW_PORT}
hyperClaw:  http://127.0.0.1:${HYPERCLAW_PORT}

PID files:
  $IRONCLAW_PID_FILE
  $HYPERCLAW_PID_FILE

Logs:
  $LOG_DIR/ironclaw.log
  $LOG_DIR/hyperclaw.log

Generated/active local secrets:
  $GENERATED_SECRETS_FILE

EOF
