#!/usr/bin/env bash
# Один прогон на VPS: цены Steam (и Market.CSGO) → ветка `steam` репозитория.
# Сайт раз в 10 часов собирает GitHub Actions и берёт отсюда последние цены.
set -euo pipefail
source /etc/cs2spread.env              # GH_TOKEN, REPO, STEAM_COOKIE (необязательно)
BASE=/opt/cs2spread
STATE=$BASE/state
REMOTE="https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git"

# свежий код, затем перезапуск уже обновлённого скрипта
if [ -z "${CS2SPREAD_PULLED:-}" ]; then
  git -C "$BASE/app" pull -q --ff-only || echo "warn: git pull failed, using current code"
  CS2SPREAD_PULLED=1 exec "$0" "$@"
fi

echo "=== $(date '+%F %T') start"
if ! cmp -s "$BASE/app/scripts/cs2spread.cron" /etc/cron.d/cs2spread; then
  install -m 644 "$BASE/app/scripts/cs2spread.cron" /etc/cron.d/cs2spread && echo "cron: расписание обновлено"
fi
if [ ! -d "$STATE" ]; then
  git clone -q --depth 1 --branch steam "$REMOTE" "$STATE" || mkdir -p "$STATE"
  rm -rf "$STATE/.git"
fi

owner=${REPO%/*}; repo=${REPO#*/}
STATE_DIR="$STATE" SITE_URL="https://${owner,,}.github.io/${repo}/" STEAM_COOKIE="${STEAM_COOKIE:-}" BUDGET_MIN="${BUDGET_MIN:-25}" STEAM_DELAY_MS="${STEAM_DELAY_MS:-6000}" \
  node --max-old-space-size=300 "$BASE/app/scripts/steam-crawl.mjs"

cd "$STATE"
rm -rf .git
git init -q -b steam
git add -A -- . ':!*.tmp'
git -c user.name=cs2spread-bot -c user.email=cs2spread-bot@users.noreply.github.com commit -qm "steam $(date -u +%FT%TZ)"
git push -qf "$REMOTE" steam
rm -rf .git
echo "=== $(date '+%F %T') done"
