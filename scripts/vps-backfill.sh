#!/usr/bin/env bash
# Фоновая загрузка истории цен Steam. Запускается cron'ом каждые 10 минут; если уже идёт — пропускается.
set -euo pipefail
source /etc/skinpulse.env
[ -n "${STEAM_COOKIE:-}" ] || exit 0
[ -d /opt/skinpulse/state ] || exit 0
STATE_DIR=/opt/skinpulse/state STEAM_COOKIE="$STEAM_COOKIE" MAX_MIN=55 \
  node --max-old-space-size=600 /opt/skinpulse/app/scripts/backfill-history.mjs
