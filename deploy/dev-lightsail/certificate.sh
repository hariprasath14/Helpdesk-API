#!/usr/bin/env bash
# TEMPORARY dev setup: keeps the dev server's one HTTPS certificate (the main address and every
# workspace address, *.<dev domain>) valid. Runs on a developer's computer, never on the
# server, because only the developer's AWS access may change the dev DNS zone. deploy.sh runs it
# on every deploy; run it alone to renew now:
#   HELPDESK_DEV_HOST=<static IP> bash deploy/dev-lightsail/certificate.sh [--force]
# It renews only when the server's certificate has fewer than 30 days left (it lasts 90). lego
# proves the domain to Let's Encrypt with a temporary _acme-challenge record in the Lightsail DNS
# zone, removes it, and only the certificate and its key go to the server. Nothing is kept here.
# Needs Docker and AWS credentials in ~/.aws (allowed lightsail:CreateDomainEntry and
# DeleteDomainEntry on the zone).
set -euo pipefail
# The dev server's real names (address, DNS zone, SSH key) come from dev.local.env next to
# this script: not committed; copy dev.local.env.example and fill it in.
HERE=$(cd "$(dirname "$0")" && pwd)
if [ -f "$HERE/dev.local.env" ]; then . "$HERE/dev.local.env"; fi

HOST=${HELPDESK_DEV_HOST:?Set HELPDESK_DEV_HOST to the dev server address}
KEY=${HELPDESK_DEV_SSH_KEY:?Set HELPDESK_DEV_SSH_KEY to the dev server key file (dev.local.env)}
DOMAIN=${HELPDESK_DEV_DOMAIN:?Set HELPDESK_DEV_DOMAIN to the dev address (dev.local.env)}
ZONE=${HELPDESK_DEV_DNS_ZONE:?Set HELPDESK_DEV_DNS_ZONE to the dev DNS zone (dev.local.env)}
RENEW_DAYS=30
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "ubuntu@$HOST")

days_left=$("${SSH[@]}" "f=/srv/helpdesk/certificates/helpdesk.crt; [ -f \$f ] && echo \$(( (\$(date -d \"\$(openssl x509 -enddate -noout -in \$f | cut -d= -f2)\" +%s) - \$(date +%s)) / 86400 )) || echo -1")
if [ "${1:-}" != "--force" ] && [ "$days_left" -ge "$RENEW_DAYS" ]; then
  echo "== HTTPS certificate: $days_left days left"
  exit 0
fi
echo "== HTTPS certificate: ${days_left/#-1/none}, getting a new one for $DOMAIN and *.$DOMAIN"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# Git Bash on Windows: hand Docker Windows paths and stop it rewriting /certs and /root.
win() { cygpath -w "$1" 2>/dev/null || echo "$1"; }
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$(win "$work"):/certs" -v "$(win "$HOME/.aws"):/root/.aws:ro" \
  -e AWS_PROFILE="${AWS_PROFILE:-default}" -e AWS_REGION=us-east-1 -e DNS_ZONE="$ZONE" \
  goacme/lego:v5.5.2 run --path /certs --accept-tos --dns lightsail \
  --domains "$DOMAIN" --domains "*.$DOMAIN" --cert.name helpdesk

crt=$(find "$work" -name helpdesk.crt | head -n 1)
[ -n "$crt" ] || { echo "lego wrote no certificate." >&2; exit 1; }
tar -C "$(dirname "$crt")" -c helpdesk.crt helpdesk.key | "${SSH[@]}" '
  set -euo pipefail
  mkdir -p /srv/helpdesk/certificates && cd /srv/helpdesk/certificates
  tar -x && chmod 600 helpdesk.key
  cd /srv/helpdesk
  if docker compose ps --status running --services 2>/dev/null | grep -q caddy; then
    docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --force
  fi
  echo "== HTTPS certificate installed: $(openssl x509 -enddate -noout -in certificates/helpdesk.crt)"
'
