#!/usr/bin/env bash
# Установка сборщика цен CS2 Skin Pulse на VPS (Ubuntu 22.04/24.04).
#   curl -fsSL https://raw.githubusercontent.com/voy1ok/cs2-skin-pulse/main/scripts/vps-setup.sh | bash
set -euo pipefail
REPO=voy1ok/cs2-skin-pulse
BASE=/opt/skinpulse
[ "$(id -u)" = 0 ] || { echo "Запусти от root"; exit 1; }

echo "== 1/6 Проверяю, отдаёт ли Steam цены этому серверу"
code=$(curl -s -o /dev/null -w '%{http_code}' -A 'Mozilla/5.0' \
  'https://steamcommunity.com/market/search/render/?appid=730&norender=1&count=1' || echo 000)
echo "   Steam ответил: $code"
if [ "$code" != 200 ]; then
  echo "!! Steam не отдаёт цены этому серверу (код $code). Скопируй это сообщение в чат."; exit 1
fi

echo "== 2/6 Ставлю git и Node.js"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates nodejs cron >/dev/null
systemctl enable --now cron >/dev/null 2>&1 || true
echo "   node $(node -v)"

echo "== 3/6 Файл подкачки (у сервера мало памяти)"
if ! swapon --show | grep -q .; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "   swap 1G включён"
else
  echo "   swap уже есть"
fi

echo "== 4/6 Токен GitHub"
read -rsp "   Вставь токен GitHub и нажми Enter: " TOKEN < /dev/tty; echo
TOKEN=$(echo "$TOKEN" | tr -d '[:space:]')
if ! curl -fsS -o /dev/null -H "Authorization: Bearer $TOKEN" "https://api.github.com/repos/$REPO"; then
  echo "!! Токен не подошёл. Проверь, что он скопирован целиком и выдан на репозиторий $REPO."; exit 1
fi
printf 'GH_TOKEN=%s\nREPO=%s\n' "$TOKEN" "$REPO" > /etc/skinpulse.env
chmod 600 /etc/skinpulse.env
echo "   токен сохранён"

echo "== 5/6 Скачиваю код и ставлю расписание"
mkdir -p "$BASE"
if [ -d "$BASE/app/.git" ]; then git -C "$BASE/app" pull -q; else git clone -q "https://github.com/$REPO.git" "$BASE/app"; fi
chmod +x "$BASE/app/scripts/vps-run.sh"
install -m 644 "$BASE/app/scripts/skinpulse.cron" /etc/cron.d/skinpulse

echo "== 6/6 Первый сбор цен запущен в фоне (10–20 минут)"
nohup flock /run/skinpulse-market.lock "$BASE/app/scripts/vps-run.sh" --market >> /var/log/skinpulse.log 2>&1 &
nohup flock /run/skinpulse.lock "$BASE/app/scripts/vps-run.sh" >> /var/log/skinpulse.log 2>&1 &
echo
echo "Готово! Окно можно закрывать. Дальше топы обновляются сами каждые 5 минут, цены Steam — каждые 30."
echo "Лог: tail -f /var/log/skinpulse.log"
