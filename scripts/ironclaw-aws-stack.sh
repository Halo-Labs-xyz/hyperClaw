#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.ironclaw-aws}"
COMPOSE_FILE="$ROOT_DIR/docker-compose.ironclaw-aws.yml"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE"
  echo "Copy $ROOT_DIR/.env.ironclaw-aws.example to $ENV_FILE and set values."
  exit 1
fi

ACTION="${1:-up}"
shift || true

export COMPOSE_DOCKER_CLI_BUILD=1
export DOCKER_BUILDKIT=1

case "$ACTION" in
  up)
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build "$@"
    ;;
  down)
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" down "$@"
    ;;
  restart)
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" restart "$@"
    ;;
  logs)
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" logs -f --tail=200 "$@"
    ;;
  ps)
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps "$@"
    ;;
  pull)
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull "$@"
    ;;
  *)
    echo "Usage: $0 {up|down|restart|logs|ps|pull} [compose-args]"
    exit 1
    ;;
esac
