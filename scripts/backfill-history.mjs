#!/usr/bin/env node
// Загрузка истории цен со Steam (market/pricehistory) для всех скинов каталога.
// Работает в фоне на VPS, продолжает с места остановки, результат кладёт в
// state/history_backfill.json.gz — update.mjs подмешивает его в дневную историю.
//
// Нужен cookie steamLoginSecure залогиненного аккаунта Steam (STEAM_COOKIE).
//   STATE_DIR       папка состояния (как у update.mjs)
//   STEAM_COOKIE    значение cookie steamLoginSecure
//   DELAY_MS        пауза между запросами (по умолчанию 3000)
//   MAX_MIN         сколько минут работать за один запуск (по умолчанию 55)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const STATE = process.env.STATE_DIR || 'state';
const COOKIE = (process.env.STEAM_COOKIE || '').trim().replace(/^steamLoginSecure=/, '');
const DELAY = Number(process.env.DELAY_MS) || 3000;
const MAX = (Number(process.env.MAX_MIN) || 55) * 60_000;
const DAYS = 120;
const FILE = path.join(STATE, 'history_backfill.json.gz');
const TMP = path.join(path.dirname(path.resolve(STATE)), '.history_backfill.tmp');
const T0 = Date.now();
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (name, def) => {
  const f = path.join(STATE, `${name}.json.gz`);
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(f))); } catch { return def; }
};
const dayNum = (d) => Math.round(Date.parse(d) / 86_400_000);

function save(bf) {
  bf.updatedAt = Date.now();
  fs.writeFileSync(TMP, zlib.gzipSync(JSON.stringify(bf), { level: 9 }));
  fs.renameSync(TMP, FILE); // атомарно: сборщик цен не увидит полузаписанный файл
}

// prices: [["Oct 27 2026 01: +0", 12.345, "123"], ...] → { firstDay, values[] } по дням (средняя, взвешенная по объёму)
function toDaily(prices) {
  const byDay = new Map();
  for (const [ds, price, vol] of prices) {
    const m = /^(\w{3}) (\d{2}) (\d{4})/.exec(ds);
    if (!m || !MONTHS[m[1]]) continue;
    const day = `${m[3]}-${MONTHS[m[1]]}-${m[2]}`;
    const v = Math.max(1, parseInt(vol, 10) || 1);
    const a = byDay.get(day) || [0, 0];
    a[0] += price * v; a[1] += v;
    byDay.set(day, a);
  }
  const minDay = Math.round(Date.now() / 86_400_000) - DAYS;
  const days = [...byDay.keys()].map((d) => [dayNum(d), d]).filter(([n]) => n >= minDay).sort((a, b) => a[0] - b[0]);
  if (!days.length) return null;
  const first = days[0][0];
  const values = new Array(days[days.length - 1][0] - first + 1).fill(0);
  for (const [n, d] of days) { const [s, v] = byDay.get(d); values[n - first] = Math.round((s / v) * 100); }
  return [first, ...values];
}

async function main() {
  if (!COOKIE) { log('нет STEAM_COOKIE — запусти scripts/vps-steam-cookie.sh'); process.exit(2); }
  const cookieId = crypto.createHash('sha1').update(COOKIE).digest('hex').slice(0, 12);
  const catalog = read('catalog', null);
  if (!catalog) { log('нет каталога в state — дождись первого прогона сборщика'); process.exit(1); }
  const prices = read('prices', {});
  const bf = read('history_backfill', null) || { v: 1, data: {}, failed: {}, startedAt: Date.now() };
  bf.failed ||= {};

  if (bf.status === 'auth' && bf.cookieId === cookieId) { log('cookie уже признан недействительным — обнови его через vps-steam-cookie.sh'); return; }
  bf.cookieId = cookieId;

  // очередь: сначала ликвидные (попадают в топы), потом остальные
  const all = [...new Set(catalog.skins.flatMap((s) => s.v.map((v) => v[0])))];
  const score = (h) => { const p = prices[h]; return p && p[0] >= 20 && p[1] >= 5 ? 1e6 + p[1] : p ? p[1] : -1; };
  const queue = all.filter((h) => !(h in bf.data) && !(h in bf.failed)).sort((a, b) => score(b) - score(a));
  bf.total = all.length;
  log(`история: готово ${Object.keys(bf.data).length + Object.keys(bf.failed).length}/${all.length}, в очереди ${queue.length}`);
  if (!queue.length) { bf.status = 'done'; bf.finishedAt ||= Date.now(); save(bf); return; }
  bf.status = 'running';

  let n = 0, fails = 0;
  for (const h of queue) {
    if (Date.now() - T0 > MAX) break;
    const url = 'https://steamcommunity.com/market/pricehistory/?country=US&currency=1&appid=730&market_hash_name=' + encodeURIComponent(h);
    let r, body;
    try {
      r = await fetch(url, { headers: {
        Cookie: `steamLoginSecure=${COOKIE}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
        Accept: 'application/json',
      } });
      body = await r.text();
    } catch (e) { r = { status: 0 }; body = String(e.message); }

    if (r.status === 429 || r.status >= 500 || r.status === 0) {
      fails++;
      const wait = Math.min(600_000, 60_000 * 2 ** (fails - 1));
      log(`HTTP ${r.status}, пауза ${wait / 1000}s`);
      if (fails > 6) break;
      await sleep(wait);
      continue;
    }
    let j = null;
    try { j = JSON.parse(body); } catch { /* не json */ }
    if (r.status === 400 || r.status === 403 || Array.isArray(j) || (j && j.success === false && !j.prices)) {
      // Steam отвечает [] / 400, если не залогинен
      if (n === 0 || Array.isArray(j) || r.status !== 400) {
        bf.status = 'auth'; save(bf);
        log(`Steam не принял cookie (HTTP ${r.status}: ${body.slice(0, 80)}). Обнови cookie: bash /opt/skinpulse/app/scripts/vps-steam-cookie.sh`);
        process.exit(3);
      }
      bf.failed[h] = r.status; n++; await sleep(DELAY); continue;
    }
    if (!j?.success || !Array.isArray(j.prices)) { bf.failed[h] = 'bad'; n++; await sleep(DELAY); continue; }
    if (j.price_prefix !== '$' && !bf.currencyChecked) {
      bf.status = 'currency'; save(bf);
      log(`Steam отдаёт цены не в долларах (${j.price_prefix || ''}…${j.price_suffix || ''}). Нужен аккаунт с кошельком в USD.`);
      process.exit(4);
    }
    bf.currencyChecked = true;
    fails = 0;
    const d = toDaily(j.prices);
    if (d) bf.data[h] = d; else bf.failed[h] = 'empty';
    n++;
    if (n % 25 === 0) { save(bf); log(`+${n}, всего ${Object.keys(bf.data).length}/${all.length}`); }
    await sleep(DELAY);
  }
  if (Object.keys(bf.data).length + Object.keys(bf.failed).length >= all.length) { bf.status = 'done'; bf.finishedAt = Date.now(); }
  save(bf);
  log(`за запуск: ${n}, всего ${Object.keys(bf.data).length}/${all.length}, статус ${bf.status}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
