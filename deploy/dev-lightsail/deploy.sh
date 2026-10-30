#!/usr/bin/env bash
# TEMPORARY dev setup: deploys the committed helpdesk-api to the dev server. Run from this repo:
#   HELPDESK_DEV_HOST=<static IP> bash deploy/dev-lightsail/deploy.sh
# Copies this folder and the code at HEAD to the server, builds the image there, runs migrations,
# restarts the API and worker, and waits for /health. Only committed code is deployed.
set -euo pipefail
# The dev server's real names (address, DNS zone, SSH key) come from dev.local.env next to
# this script: not committed; copy dev.local.env.example and fill it in.
HERE=$(cd "$(dirname "$0")" && pwd)
if [ -f "$HERE/dev.local.env" ]; then . "$HERE/dev.local.env"; fi

HOST=${HELPDESK_DEV_HOST:?Set HELPDESK_DEV_HOST to the dev server address}
KEY=${HELPDESK_DEV_SSH_KEY:?Set HELPDESK_DEV_SSH_KEY to the dev server key file (dev.local.env)}
TARGET="ubuntu@$HOST"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$TARGET")
cd "$HERE/../.."

if [ -n "$(git status --porcelain)" ]; then
  echo "Commit or stash your changes first: only committed code is deployed." >&2
  exit 1
fi
VERSION=$(git rev-parse --short=12 HEAD)
echo "== Deploying helpdesk-api $VERSION to $HOST"

echo "== Server files (compose, Caddy, scripts; .env is never overwritten)"
"${SSH[@]}" 'test -w /srv/helpdesk || { sudo mkdir -p /srv/helpdesk && sudo chown "$USER":"$USER" /srv/helpdesk; }; mkdir -p /srv/helpdesk/src'
scp -q -i "$KEY" "$HERE"/{compose.yml,Caddyfile,site.caddy,postgres-init.sh,env.example,setup-server.sh,backup.sh,set-site-password.sh,set-aws-key.sh} "$TARGET:/srv/helpdesk/"

# The HTTPS certificate is renewed from here when due (see certificate.sh).
HELPDESK_DEV_HOST="$HOST" HELPDESK_DEV_SSH_KEY="$KEY" bash "$HERE/certificate.sh"

echo "== Code at $VERSION"
git archive --format=tar HEAD | "${SSH[@]}" 'rm -rf /srv/helpdesk/src/api && mkdir -p /srv/helpdesk/src/api && tar -x -C /srv/helpdesk/src/api'

"${SSH[@]}" VERSION="$VERSION" bash -s <<'REMOTE'
set -euo pipefail
cd /srv/helpdesk
if ! grep -qE '^SITE_PASSWORD_HASH=.+' .env; then
  echo "Set the dev password first: bash /srv/helpdesk/set-site-password.sh" >&2
  exit 1
fi
echo "== Building image helpdesk-api:$VERSION"
docker build -q -t "helpdesk-api:$VERSION" src/api
sed -i "s|^APP_VERSION=.*|APP_VERSION=$VERSION|" .env
echo "== Migrations"
docker compose run --rm -T migrate </dev/null
echo "== Starting"
docker compose up -d --remove-orphans
# Caddy keeps running across deploys, so it reads a changed Caddyfile or site.caddy only here.
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
for i in $(seq 1 30); do
  if docker compose exec -T api node -e "fetch('http://127.0.0.1:4000/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"; then
    echo "== Healthy: helpdesk-api $VERSION"
    # Keep the three newest images for a quick roll back.
    docker image ls helpdesk-api --format '{{.Tag}}' | tail -n +4 | xargs -r -I{} docker image rm -f helpdesk-api:{} >/dev/null
    exit 0
  fi
  sleep 2
done
echo "The API did not become healthy. Logs: docker compose logs api" >&2
exit 1
REMOTE
