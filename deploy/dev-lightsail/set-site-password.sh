#!/usr/bin/env bash
# TEMPORARY dev setup: sets the shared dev password of the test mailbox. Run it yourself
# on the server (it asks for the password, so it never appears in a terminal log):
#   bash /srv/helpdesk/set-site-password.sh
# Only a hash is stored in .env. Share the password with the team, not the hash.
set -euo pipefail
cd /srv/helpdesk
read -rsp "Dev password: " password && echo
read -rsp "Same again: " again && echo
if [ ${#password} -lt 12 ]; then
  echo "That was ${#password} characters; use at least 12. Nothing changed." >&2
  exit 1
fi
if [ "$password" != "$again" ]; then
  echo "The two entries differ (the second was ${#again} characters). Nothing changed." >&2
  exit 1
fi
# Through stdin, never as an argument, so it appears in no process list or terminal.
hash=$(printf '%s
' "$password" | docker run --rm -i caddy:2.10.2-alpine caddy hash-password)
unset password again
sed -i "s|^SITE_PASSWORD_HASH=.*|SITE_PASSWORD_HASH='$hash'|" .env
if docker compose ps --status running --services 2>/dev/null | grep -q caddy; then
  docker compose up -d --force-recreate caddy
fi
echo "Dev password set."
