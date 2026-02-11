#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.docker}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing env file: $ENV_FILE"
  echo "Copy $ROOT_DIR/.env.docker.example to $ENV_FILE and set values."
  exit 1
fi

ACTION="${1:-up}"
shift || true

export COMPOSE_DOCKER_CLI_BUILD=1
export DOCKER_BUILDKIT=1

case "$ACTION" in
  up)
    docker compose --env-file "$ENV_FILE" -f "$ROOT_DIR/docker-compose.yml" up -d --build "$@"
    ;;
  down)
    docker compose --env-file "$ENV_FILE" -f "$ROOT_DIR/docker-compose.yml" down "$@"
    ;;
  restart)
    docker compose --env-file "$ENV_FILE" -f "$ROOT_DIR/docker-compose.yml" restart "$@"
    ;;
  logs)
    docker compose --env-file "$ENV_FILE" -f "$ROOT_DIR/docker-compose.yml" logs -f --tail=200 "$@"
    ;;
  ps)
    docker compose --env-file "$ENV_FILE" -f "$ROOT_DIR/docker-compose.yml" ps "$@"
    ;;
  pull)
    docker compose --env-file "$ENV_FILE" -f "$ROOT_DIR/docker-compose.yml" pull "$@"
    ;;
  *)
    echo "Usage: $0 {up|down|restart|logs|ps|pull} [compose-args]"
    exit 1
    ;;
esac
