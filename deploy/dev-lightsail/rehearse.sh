#!/usr/bin/env bash
# TEMPORARY dev setup: runs the dev server's whole stack on this computer at
# http://helpdesk.localhost:8080 (password "rehearsal-only"), from the working copy, to check a
# change before deploying it. The web app must be built into .rehearsal-web first (see README).
#   bash deploy/dev-lightsail/rehearse.sh        start (or update)
#   bash deploy/dev-lightsail/rehearse.sh down   stop and delete its data
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"
COMPOSE=(docker compose --project-name helpdesk-rehearsal --env-file rehearsal.env -f compose.yml)

if [ "${1:-}" = "down" ]; then
  "${COMPOSE[@]}" down -v
  exit 0
fi

if [ ! -f .rehearsal-web/current/index.html ]; then
  echo "Build the web app first (helpdesk-web: see README, Temporary dev server)." >&2
  exit 1
fi
docker build -q -t helpdesk-api:rehearsal ../..
"${COMPOSE[@]}" run --rm migrate
"${COMPOSE[@]}" up -d --remove-orphans
echo "Open http://helpdesk.localhost:8080 (user helpdesk, password rehearsal-only)."
echo "Test mailbox: http://mail.helpdesk.localhost:8080"
