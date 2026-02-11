#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$ROOT_DIR/.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Env file not found: $ENV_FILE" >&2
  exit 1
fi

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

need_cmd openssl
need_cmd awk

backup_file="${ENV_FILE}.bak.$(date +%Y%m%d%H%M%S)"
cp "$ENV_FILE" "$backup_file"

upsert_env() {
  local key="$1"
  local value="$2"
  local tmp_file
  tmp_file="$(mktemp)"

  awk -v key="$key" -v value="$value" '
    BEGIN { updated = 0 }
    $0 ~ "^[[:space:]]*" key "=" {
      print key "=" value
      updated = 1
      next
    }
    { print }
    END {
      if (!updated) {
        print key "=" value
      }
    }
  ' "$ENV_FILE" > "$tmp_file"

  mv "$tmp_file" "$ENV_FILE"
}

new_master_key="$(openssl rand -hex 32)"
new_hyperclaw_api_key="$(openssl rand -hex 32)"
new_mcp_api_key="$(openssl rand -hex 32)"
new_orchestrator_secret="$(openssl rand -hex 32)"
new_webhook_secret="$(openssl rand -hex 32)"
new_gateway_auth_token="$(openssl rand -hex 32)"
new_account_encryption_key="$(openssl rand -hex 32)"
new_pinant_jwt_secret="$(openssl rand -hex 32)"

upsert_env "SECRETS_MASTER_KEY" "$new_master_key"
upsert_env "HYPERCLAW_API_KEY" "$new_hyperclaw_api_key"
upsert_env "MCP_API_KEY" "$new_mcp_api_key"
upsert_env "ORCHESTRATOR_SECRET" "$new_orchestrator_secret"
upsert_env "IRONCLAW_WEBHOOK_SECRET" "$new_webhook_secret"
upsert_env "HTTP_WEBHOOK_SECRET" "$new_webhook_secret"
upsert_env "GATEWAY_AUTH_TOKEN" "$new_gateway_auth_token"
upsert_env "ACCOUNT_ENCRYPTION_KEY" "$new_account_encryption_key"
upsert_env "PINANT_JWT_SECRET" "$new_pinant_jwt_secret"

cat <<EOF
Rotated local development/test secrets in:
  $ENV_FILE

Backup:
  $backup_file

Rotated keys:
  SECRETS_MASTER_KEY
  HYPERCLAW_API_KEY
  MCP_API_KEY
  ORCHESTRATOR_SECRET
  IRONCLAW_WEBHOOK_SECRET
  HTTP_WEBHOOK_SECRET
  GATEWAY_AUTH_TOKEN
  ACCOUNT_ENCRYPTION_KEY
  PINANT_JWT_SECRET

If IronClaw is running, restart it to load the new values.
If MCP static auth keys were previously stored in plaintext mcp-servers.json, run:
  cargo run --manifest-path ironclaw/Cargo.toml -- mcp list --verbose
to trigger migration into encrypted secrets.
EOF
