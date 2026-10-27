#!/usr/bin/env bash
# Сохранить cookie steamLoginSecure и запустить загрузку истории цен.
#   bash /opt/skinpulse/app/scripts/vps-steam-cookie.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Запусти от root"; exit 1; }
read -rsp "Вставь значение cookie steamLoginSecure и нажми Enter: " C < /dev/tty; echo
C=$(echo "$C" | tr -d '[:space:]'); C=${C#steamLoginSecure=}
[ -n "$C" ] || { echo "Пусто — попробуй ещё раз"; exit 1; }

echo "Проверяю cookie в Steam…"
body=$(curl -s -H "Cookie: steamLoginSecure=$C" -A 'Mozilla/5.0' \
  'https://steamcommunity.com/market/pricehistory/?country=US&currency=1&appid=730&market_hash_name=AK-47%20%7C%20Redline%20(Field-Tested)')
case "$body" in
  *'"success":true'*) ;;
  *) echo "!! Steam не принял cookie (ответ: ${body:0:80}). Проверь, что скопировано значение целиком и вход в Steam не завершён."; exit 1 ;;
esac
case "$body" in
  *'"price_prefix":"$"'*) echo "   ок, цены в USD" ;;
  *) echo "!! Аккаунт отдаёт цены не в долларах: ${body:0:120}"; echo "   Скопируй это сообщение в чат."; exit 1 ;;
esac

grep -v '^STEAM_COOKIE=' /etc/skinpulse.env > /etc/skinpulse.env.new || true
echo "STEAM_COOKIE=$C" >> /etc/skinpulse.env.new
mv /etc/skinpulse.env.new /etc/skinpulse.env && chmod 600 /etc/skinpulse.env
chmod +x /opt/skinpulse/app/scripts/vps-backfill.sh

cat > /etc/cron.d/skinpulse-backfill <<CRON
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
*/10 * * * * root flock -n /run/skinpulse-backfill.lock /opt/skinpulse/app/scripts/vps-backfill.sh >> /var/log/skinpulse-backfill.log 2>&1
CRON
chmod 644 /etc/cron.d/skinpulse-backfill
nohup flock -n /run/skinpulse-backfill.lock /opt/skinpulse/app/scripts/vps-backfill.sh >> /var/log/skinpulse-backfill.log 2>&1 &
echo
echo "Готово! История загружается в фоне (около 12–15 часов). Окно можно закрыть."
echo "Прогресс: tail -f /var/log/skinpulse-backfill.log"
