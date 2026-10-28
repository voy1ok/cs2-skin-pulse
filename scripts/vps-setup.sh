#!/usr/bin/env bash
# Установка сборщика цен Steam на VPS (Ubuntu 22.04/24.04).
#   curl -fsSL https://raw.githubusercontent.com/voy1ok/cs2-skin-pulse/main/scripts/vps-setup.sh | bash
set -euo pipefail
REPO=${REPO:-voy1ok/cs2-skin-pulse}
BASE=/opt/cs2spread
[ "$(id -u)" = 0 ] || { echo "Запусти от root"; exit 1; }

echo "== 1/5 Убираю старый сборщик Skin Pulse, если он остался"
rm -f /etc/cron.d/skinpulse /etc/skinpulse.env
rm -rf /opt/skinpulse

echo "== 2/5 Ставлю git и Node.js"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates nodejs cron >/dev/null
systemctl enable --now cron >/dev/null 2>&1 || true
major=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
if [ "$major" -lt 18 ]; then echo "!! Нужен Node.js 18 или новее, а стоит $(node -v). Скопируй это сообщение в чат."; exit 1; fi
echo "   node $(node -v)"

echo "== 3/5 Токен GitHub (доступ к репозиторию $REPO: Contents → Read and write)"
read -rsp "   Вставь токен и нажми Enter: " TOKEN < /dev/tty; echo
TOKEN=$(echo "$TOKEN" | tr -d '[:space:]')
if ! curl -fsS -o /dev/null -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$REPO"; then
  echo "!! Токен не подошёл. Проверь, что он скопирован целиком и выдан на репозиторий $REPO."; exit 1
fi

echo "== 4/5 Cookie Steam (необязательно — Enter, чтобы пропустить)"
echo "   С ним Steam отдаёт 100 предметов за запрос вместо 10, и весь рынок обходится за час, а не за сутки."
echo "   Где взять: steamcommunity.com → войти → F12 → Application → Cookies → steamLoginSecure → значение."
read -rsp "   steamLoginSecure: " COOKIE < /dev/tty; echo
COOKIE=$(echo "$COOKIE" | tr -d '[:space:]'); COOKIE=${COOKIE#steamLoginSecure=}
printf 'GH_TOKEN=%s\nREPO=%s\nSTEAM_COOKIE=%s\n' "$TOKEN" "$REPO" "$COOKIE" > /etc/cs2spread.env
chmod 600 /etc/cs2spread.env

echo "== 5/5 Скачиваю код, ставлю расписание и запускаю первый сбор"
mkdir -p "$BASE"
if [ -d "$BASE/app/.git" ]; then git -C "$BASE/app" pull -q; else git clone -q "https://github.com/$REPO.git" "$BASE/app"; fi
install -m 644 "$BASE/app/scripts/cs2spread.cron" /etc/cron.d/cs2spread
nohup flock /run/cs2spread.lock "$BASE/app/scripts/vps-run.sh" >> /var/log/cs2spread.log 2>&1 &
echo
echo "Готово! Окно можно закрывать. Цены Steam собираются сами каждые 30 минут."
echo "Лог: tail -f /var/log/cs2spread.log"
