#!/usr/bin/env bash
# Один прогон сборщика на VPS: цены → ветка data → публикация сайта.
#   vps-run.sh --market рынок Skinport и быстрый топ (каждые 5 минут)
#   vps-run.sh          цены Steam для каталога (каждые 30 минут)
#   vps-run.sh --daily  суточный (каталог + долгий холд)
set -euo pipefail
source /etc/skinpulse.env            # GH_TOKEN, REPO
BASE=/opt/skinpulse
STATE=$BASE/state
REMOTE="https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git"
MODE=${1:-fast}

# свежий код, затем перезапуск уже обновлённого скрипта
if [ -z "${SKINPULSE_PULLED:-}" ]; then
  flock /run/skinpulse-git.lock git -C "$BASE/app" pull -q --ff-only || echo "warn: git pull failed, using current code"
  SKINPULSE_PULLED=1 exec "$0" "$@"
fi

[ "$MODE" = --market ] || echo "=== $(date '+%F %T') start $MODE"
if ! cmp -s "$BASE/app/scripts/skinpulse.cron" /etc/cron.d/skinpulse; then
  install -m 644 "$BASE/app/scripts/skinpulse.cron" /etc/cron.d/skinpulse && echo "cron: расписание обновлено"
fi

(
  flock 9
  if [ ! -d "$STATE" ]; then
    git clone -q --depth 1 --branch data "$REMOTE" "$STATE" || mkdir -p "$STATE"
    rm -rf "$STATE/.git"
  fi
) 9>/run/skinpulse-git.lock

if [ "$MODE" = --market ]; then
  STATE_DIR="$STATE" node --max-old-space-size=500 "$BASE/app/scripts/update.mjs" --market
else
  STATE_DIR="$STATE" OUT_DIR="$BASE/out" SOURCE=vps BUDGET_MIN="${BUDGET_MIN:-26}" STEAM_DELAY_MS="${STEAM_DELAY_MS:-4000}" \
    node --max-old-space-size=700 "$BASE/app/scripts/update.mjs" "$@"
fi

# прогоны рынка и Steam идут параллельно — в git пишем по очереди
(
  flock 9
  cd "$STATE"
  rm -rf .git
  git init -q -b data
  git add -A -- . ':!*.tmp'
  git -c user.name=skin-pulse-bot -c user.email=skin-pulse-bot@users.noreply.github.com commit -qm "state $(date -u +%FT%TZ)"
  git push -qf "$REMOTE" data
  rm -rf .git
) 9>/run/skinpulse-git.lock

curl -fsS -X POST -H "Authorization: Bearer ${GH_TOKEN}" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/dispatches" -d '{"event_type":"state-updated"}'
[ "$MODE" = --market ] || echo "=== $(date '+%F %T') done"
