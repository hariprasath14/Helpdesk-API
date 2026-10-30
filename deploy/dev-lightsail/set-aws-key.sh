#!/usr/bin/env bash
# TEMPORARY dev setup: turns on real email for the dev server. Run it yourself on the server (it
# asks for the AWS key without showing it, so it never appears in a terminal log or in Git):
#   bash /srv/helpdesk/set-aws-key.sh
# It stores the key in .env (mode 600) and sends email through Amazon SES, but only to the safety
# list (EMAIL_ALLOWED_RECIPIENTS; everyone else's email still goes to the test mailbox). Run it
# again to change the key or the list. To stop real email: set EMAIL_DRIVER=smtp in .env, then
# docker compose up -d. Reading real incoming email (INBOUND_EMAIL_DRIVER=mailpit,s3) is turned on
# separately, once its S3 bucket exists (README, "Temporary dev server").
set -euo pipefail
cd /srv/helpdesk
read -rsp "AWS access key ID: " key_id && echo
read -rsp "AWS secret access key: " secret && echo
if [[ ! "$key_id" =~ ^AKIA[A-Z0-9]{16}$ ]]; then
  echo "That does not look like an access key ID (AKIA and 16 more letters or digits). Nothing changed." >&2
  exit 1
fi
if [ ${#secret} -ne 40 ]; then
  echo "A secret access key has 40 characters; that was ${#secret}. Nothing changed." >&2
  exit 1
fi
current=$(grep -E '^EMAIL_ALLOWED_RECIPIENTS=' .env | cut -d= -f2- || true)
echo "Real email goes only to: ${current:-everyone (the list is empty)}"
read -rp "Addresses or @domains to use instead, comma separated (Enter keeps it): " list
list=${list:-$current}

# Each setting replaces its line in .env. Values go through printf, never sed, so no character
# in the key can break the file.
set_value() {
  grep -vE "^$1=" .env > .env.next || true
  printf '%s=%s\n' "$1" "$2" >> .env.next
  chmod 600 .env.next
  mv .env.next .env
}
set_value AWS_ACCESS_KEY_ID "$key_id"
set_value AWS_SECRET_ACCESS_KEY "$secret"
unset key_id secret
set_value EMAIL_DRIVER ses
set_value EMAIL_ALLOWED_RECIPIENTS "$list"
docker compose up -d api worker
echo "Real email is on for: $list"
