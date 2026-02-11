#!/usr/bin/env bash
set -euo pipefail

SESSION_PATH="${NEARAI_SESSION_PATH:-$HOME/.ironclaw/session.json}"
SESSION_DIR="$(dirname "$SESSION_PATH")"

if [[ -n "${NEARAI_SESSION_TOKEN:-}" ]]; then
  mkdir -p "$SESSION_DIR"
  cat > "$SESSION_PATH" <<EOF
{"session_token":"${NEARAI_SESSION_TOKEN}","created_at":"$(date -u +"%Y-%m-%dT%H:%M:%SZ")","auth_provider":"env"}
EOF
  chmod 600 "$SESSION_PATH"
fi

if [[ "${IRONCLAW_SKIP_SESSION_CHECK:-false}" != "true" ]]; then
  if [[ ! -s "$SESSION_PATH" ]]; then
    echo "Missing NEAR AI session file: $SESSION_PATH"
    echo "Set NEARAI_SESSION_TOKEN or mount a valid session file before starting IronClaw."
    exit 1
  fi
fi

exec "$@"
