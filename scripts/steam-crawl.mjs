#!/usr/bin/env node
// Сборщик цен Steam Market для VPS (GitHub Actions Steam не пускает — отвечает 429).
// Идёт по всему рынку CS2 по алфавиту, за каждый запуск — сколько успеет за BUDGET_MIN минут,
// и продолжает с того же места в следующий раз. Заодно снимает цены Market.CSGO в рублях:
// серверам GitHub эта площадка тоже отвечает 403.
//
// Переменные окружения:
//   STATE_DIR      папка состояния (по умолчанию ./steam)
//   BUDGET_MIN     сколько минут работать за запуск (по умолчанию 25)
//   STEAM_DELAY_MS пауза между запросами (по умолчанию 6000)
//   STEAM_COOKIE   значение cookie steamLoginSecure — с ним Steam отдаёт 100 позиций за запрос вместо 10
//   SITE_URL       адрес сайта: оттуда берётся список предметов, для которых нужны продажи в Steam
//   VOLUME_PER_RUN сколько предметов за запуск проверять на число продаж (по умолчанию 80)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const STATE = process.env.STATE_DIR || 'steam';
const BUDGET = (Number(process.env.BUDGET_MIN) || 25) * 60_000;
const DELAY = Number(process.env.STEAM_DELAY_MS) || 6000;
const COOKIE = (process.env.STEAM_COOKIE || '').trim();
const SITE = (process.env.SITE_URL || '').replace(/\/?$/, '/');
const VOLUME_PER_RUN = Number(process.env.VOLUME_PER_RUN) || 80;
const VOLUME_FRESH = 20 * 3_600_000; // продажи за сутки перепроверяем не чаще раза в 20 часов
const T0 = Date.now();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (name, def) => { try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(STATE, name)))); } catch { return def; } };
const write = (name, data) => {
  fs.mkdirSync(STATE, { recursive: true });
  const f = path.join(STATE, name);
  fs.writeFileSync(f + '.tmp', zlib.gzipSync(JSON.stringify(data)));
  fs.renameSync(f + '.tmp', f);
};

async function steam(url) {
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA, Accept: 'application/json,text/javascript,*/*;q=0.01', 'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      Referer: 'https://steamcommunity.com/market/search?appid=730', ...(COOKIE ? { Cookie: `steamLoginSecure=${COOKIE}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  return r.json();
}

// курс Steam: одна и та же цена в долларах и рублях
async function steamRate() {
  const h = encodeURIComponent('AK-47 | Redline (Field-Tested)');
  // «$1,234.56» и «2 572,38 руб.» → число
  const num = (s) => {
    let t = (String(s || '').match(/\d[\d\s.,]*/) || [''])[0].replace(/\s/g, '').replace(/[.,]$/, '');
    t = /,\d{1,2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
    return Number(t);
  };
  const usd = await steam(`https://steamcommunity.com/market/priceoverview/?appid=730&currency=1&market_hash_name=${h}`);
  await sleep(DELAY);
  const rub = await steam(`https://steamcommunity.com/market/priceoverview/?appid=730&currency=5&market_hash_name=${h}`);
  const k = num(rub.lowest_price) / num(usd.lowest_price);
  if (!(k > 10 && k < 1000)) throw new Error(`странный курс: ${usd.lowest_price} / ${rub.lowest_price}`);
  return Math.round(k * 10000) / 10000;
}

async function main() {
  const s = read('steam.json.gz', { prices: {}, cursor: {}, rate: null });
  const c = s.cursor;

  // Market.CSGO в рублях
  try {
    const r = await fetch('https://market.csgo.com/api/v2/prices/RUB.json', { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!j.items?.length) throw new Error('пустой ответ');
    write('tm.json.gz', { at: Date.now(), items: j.items });
    log(`market.csgo: ${j.items.length} items`);
  } catch (e) { log('market.csgo failed:', e.message); }

  if (c.cooldownUntil && Date.now() < c.cooldownUntil) {
    log(`steam: пауза после 429 до ${new Date(c.cooldownUntil).toISOString()}`);
    return write('steam.json.gz', s);
  }

  // продажи за сутки в Steam — для самых выгодных предметов (список считает сайт), устаревшие первыми
  if (SITE.length > 1) {
    const vol = read('volume.json.gz', { items: {} });
    let list = [];
    try {
      const r = await fetch(`${SITE}data/candidates.json?x=${Date.now()}`, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      list = (await r.json()).items || [];
    } catch (e) { log('candidates failed:', e.message); }
    const todo = list.filter((h) => !vol.items[h] || Date.now() - vol.items[h][1] > VOLUME_FRESH).slice(0, VOLUME_PER_RUN);
    let n = 0;
    for (const h of todo) {
      try {
        const j = await steam(`https://steamcommunity.com/market/priceoverview/?appid=730&currency=5&market_hash_name=${encodeURIComponent(h)}`);
        // «77,007» — тысячи через запятую; нет поля — продаж за сутки не было
        vol.items[h] = [Number(String(j.volume || '0').replace(/\D/g, '')) || 0, Date.now()];
        n++;
      } catch (e) {
        if (e.status === 429) {
          c.cooldowns = (c.cooldowns || 0) + 1;
          c.cooldownUntil = Date.now() + Math.min(120, 15 * 2 ** (c.cooldowns - 1)) * 60_000;
          log(`steam volume 429, пауза до ${new Date(c.cooldownUntil).toISOString()}`);
          break;
        }
        log(`volume ${h}: ${e.message}`);
      }
      await sleep(DELAY);
    }
    // старше недели — не нужно
    for (const [h, [, t]] of Object.entries(vol.items)) if (Date.now() - t > 7 * 86_400_000) delete vol.items[h];
    write('volume.json.gz', vol);
    log(`steam volume: ${n} of ${todo.length} checked, ${Object.keys(vol.items).length} known, ${list.length} candidates`);
    if (c.cooldownUntil && Date.now() < c.cooldownUntil) return write('steam.json.gz', s);
  }

  // курс Steam — раз в 6 часов
  if (!s.rate || Date.now() - s.rate.at > 6 * 3_600_000) {
    try { s.rate = { usdRub: await steamRate(), at: Date.now() }; log(`steam rate: ${s.rate.usdRub}`); }
    catch (e) { log('steam rate failed:', e.message); }
    await sleep(DELAY);
  }

  const base = 'https://steamcommunity.com/market/search/render/?appid=730&norender=1&count=100&search_descriptions=0&sort_column=name&sort_dir=asc';
  let start = c.start || 0, pages = 0, got = 0, fails = 0;
  while (Date.now() - T0 < BUDGET) {
    let data;
    try {
      data = await steam(`${base}&start=${start}`);
      if (!data?.success) throw new Error('success=false');
      if (!data.results?.length && start < (data.total_count || 0)) throw new Error('пустая страница');
    } catch (e) {
      if (e.status === 429) {
        // Steam ограничил IP: не долбим, ждём 15 мин, при повторах — дольше (до 2 ч)
        c.cooldowns = (c.cooldowns || 0) + 1;
        c.cooldownUntil = Date.now() + Math.min(120, 15 * 2 ** (c.cooldowns - 1)) * 60_000;
        log(`steam 429 на start=${start}, пауза до ${new Date(c.cooldownUntil).toISOString()}`);
        break;
      }
      if (++fails > 5) { log(`steam: ${e.message}, хватит на этот раз`); break; }
      log(`steam start=${start}: ${e.message}, повтор через 30 с`);
      await sleep(30_000);
      continue;
    }
    fails = 0; pages++; c.cooldowns = 0;
    const now = Date.now();
    for (const it of data.results) {
      // без входа Steam отдаёт цены в долларах (центы); с cookie — в валюте аккаунта
      const text = String(it.sell_price_text || '');
      const unit = text.includes('$') ? 'usd' : /руб|₽/.test(text) ? 'rub' : null;
      if (!unit) continue;
      s.unit = unit;
      s.prices[it.hash_name] = [it.sell_listings > 0 ? it.sell_price : 0, it.sell_listings, now];
      got++;
    }
    c.total = data.total_count;
    start += data.results.length;
    if (start >= data.total_count) { start = 0; c.passes = (c.passes || 0) + 1; c.fullPassAt = now; }
    if (pages % 50 === 0) log(`steam: ${pages} pages, start=${start}/${c.total}`);
    await sleep(DELAY);
  }
  c.start = start;
  c.lastRun = { at: Date.now(), pages, items: got };
  log(`steam: ${pages} pages, ${got} items, start=${start}/${c.total || '?'}`);
  write('steam.json.gz', s);
}

main().catch((e) => { console.error(e); process.exit(1); });
