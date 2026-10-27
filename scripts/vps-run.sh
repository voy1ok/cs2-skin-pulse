#!/usr/bin/env bash
# Один прогон сборщика на VPS: цены Steam → ветка data → публикация сайта.
#   vps-run.sh          быстрый прогон (каждые 30 минут)
#   vps-run.sh --daily  суточный (каталог + долгий холд)
set -euo pipefail
source /etc/skinpulse.env            # GH_TOKEN, REPO
BASE=/opt/skinpulse
STATE=$BASE/state
REMOTE="https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git"

echo "=== $(date '+%F %T') start ${1:-fast}"
git -C "$BASE/app" pull -q --ff-only || echo "warn: git pull failed, using current code"

if [ ! -d "$STATE" ]; then
  git clone -q --depth 1 --branch data "$REMOTE" "$STATE" || mkdir -p "$STATE"
fi
rm -rf "$STATE/.git"

STATE_DIR="$STATE" OUT_DIR="$BASE/out" SOURCE=vps BUDGET_MIN="${BUDGET_MIN:-26}" STEAM_DELAY_MS="${STEAM_DELAY_MS:-2500}" \
  node --max-old-space-size=700 "$BASE/app/scripts/update.mjs" "$@"

cd "$STATE"
git init -q -b data
git add -A
git -c user.name=skin-pulse-bot -c user.email=skin-pulse-bot@users.noreply.github.com commit -qm "state $(date -u +%FT%TZ)"
git push -qf "$REMOTE" data
rm -rf .git

curl -fsS -X POST -H "Authorization: Bearer ${GH_TOKEN}" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${REPO}/dispatches" -d '{"event_type":"state-updated"}'
echo "=== $(date '+%F %T') done"
