#!/bin/sh
# Picks the plain-HTTP or SSL nginx config based on $ENABLE_SSL (from infra/.env).
# Runs automatically before nginx starts (nginx image executes every
# executable script in /docker-entrypoint.d/ before launching).
set -e

if [ "$ENABLE_SSL" = "true" ]; then
  echo "[nginx] SSL mode — domain: ${DOMAIN}"
  envsubst '${DOMAIN}' < /etc/nginx/templates/nginx.ssl.conf.template > /etc/nginx/nginx.conf
else
  echo "[nginx] Plain HTTP mode (local/LAN testing) — set ENABLE_SSL=true in infra/.env for production"
  cp /etc/nginx/templates/nginx.plain.conf.template /etc/nginx/nginx.conf
fi
