#!/usr/bin/env bash
# TEMPORARY dev setup: backs up the dev database and the uploaded files (ticket attachments) to
# /srv/helpdesk/backups and keeps 7 days. Run nightly by cron (setup-server.sh).
# Restore: see README "Temporary dev server".
set -euo pipefail
cd /srv/helpdesk
stamp="$(date +%F-%H%M)"
file="backups/helpdesk-$stamp.dump"
files="backups/files-$stamp.tar.gz"
docker compose exec -T postgres pg_dump -U postgres --format=custom helpdesk > "$file"
# The files volume, read through the worker (it mounts it at /app/storage).
docker compose exec -T worker tar -C /app/storage -czf - . > "$files"
find backups \( -name 'helpdesk-*.dump' -o -name 'files-*.tar.gz' \) -mtime +7 -delete
echo "Backed up to $file and $files"
