#!/usr/bin/env bash
# Revisa GitHub cada 10 minutos (lo llama cron) y, si hay cambios, reconstruye Brisa.
set -euo pipefail
cd /opt/brisa
git fetch -q origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "$(date) actualizando a $(git rev-parse --short origin/main)"
  git reset -q --hard origin/main
  docker compose up -d --build
  docker image prune -f >/dev/null
fi
