#!/usr/bin/env bash
# TEMPORARY dev setup: prepares a new Ubuntu 24.04 Lightsail server once. Run on the server as the
# default "ubuntu" user, from the folder deploy.sh copied (/srv/helpdesk):
#   bash setup-server.sh
# Safe to run again: it skips what is already done and never overwrites .env values.
set -euo pipefail

APP_DIR=/srv/helpdesk

echo "== Packages (Docker from Ubuntu's own repository)"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2 unattended-upgrades
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"

echo "== Swap (2 GB): builds and PostgreSQL get headroom on a 2 GB server"
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "== Folders"
sudo mkdir -p "$APP_DIR"/{src,web/releases,backups}
sudo chown -R "$USER":"$USER" "$APP_DIR"

echo "== Settings (.env): generated secrets stay on this server"
cd "$APP_DIR"
if [ ! -f .env ]; then
  cp env.example .env
  chmod 600 .env
fi
fill() { # fill KEY VALUE: only when KEY is empty in .env
  if grep -qE "^$1=$" .env; then sed -i "s|^$1=$|$1=$2|" .env; fi
}
fill POSTGRES_PASSWORD "$(openssl rand -hex 24)"
fill MIGRATOR_DB_PASSWORD "$(openssl rand -hex 24)"
fill APP_DB_PASSWORD "$(openssl rand -hex 24)"
fill READONLY_DB_PASSWORD "$(openssl rand -hex 24)"
fill TWO_FACTOR_ENCRYPTION_KEY "$(openssl rand -base64 32)"

echo "== Nightly database backup at 02:30 server time, kept 7 days"
chmod +x backup.sh
( crontab -l 2>/dev/null | grep -v helpdesk-backup || true; echo "30 2 * * * $APP_DIR/backup.sh # helpdesk-backup" ) | crontab -

echo "Done. Next: set the dev password (set-site-password.sh), then deploy."
echo "Log out and back in once so the docker group applies to this user."
