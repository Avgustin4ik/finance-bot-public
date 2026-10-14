#!/usr/bin/env bash
# Runs on the VPS. Deploys the given image, health-checks it, and rolls back
# to the previously deployed image if the bot doesn't stay up.
#
# Usage: ./deploy.sh ghcr.io/<owner>/<repo>:<tag>
set -euo pipefail

NEW_IMAGE="${1:?usage: deploy.sh <image>}"
HEALTH_WAIT="${HEALTH_WAIT:-20}"

cd "$(dirname "$0")"

for f in bot.env service-account.json docker-compose.yml; do
  [[ -f "$f" ]] || { echo "Missing $PWD/$f — see README 'Deployment'." >&2; exit 1; }
done

PREV_IMAGE=""
if [[ -f .env ]]; then
  PREV_IMAGE="$(sed -n 's/^IMAGE=//p' .env)"
fi

healthy() {
  local id running restarts
  id="$(docker compose ps -q bot)"
  [[ -n "$id" ]] || return 1
  running="$(docker inspect -f '{{.State.Running}}' "$id")"
  restarts="$(docker inspect -f '{{.RestartCount}}' "$id")"
  [[ "$running" == "true" && "$restarts" == "0" ]]
}

up() {
  echo "IMAGE=$1" > .env
  docker compose pull bot
  docker compose up -d --remove-orphans
}

echo "Deploying $NEW_IMAGE (previous: ${PREV_IMAGE:-none})"
up "$NEW_IMAGE"

echo "Waiting ${HEALTH_WAIT}s to make sure the bot stays up..."
sleep "$HEALTH_WAIT"

if healthy; then
  docker compose logs --tail 20 bot
  docker image prune -f >/dev/null
  echo "Deploy OK: $NEW_IMAGE"
  exit 0
fi

echo "New version is unhealthy. Logs:" >&2
docker compose logs --tail 50 bot >&2 || true

if [[ -n "$PREV_IMAGE" && "$PREV_IMAGE" != "$NEW_IMAGE" ]]; then
  echo "Rolling back to $PREV_IMAGE" >&2
  up "$PREV_IMAGE"
fi
exit 1
