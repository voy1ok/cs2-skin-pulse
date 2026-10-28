#!/usr/bin/env node
// CS2 Spread — собирает цены скинов CS2 с маркетплейсов и готовит данные для сайта.
//
//   node scripts/collect.mjs
//
// Переменные окружения:
//   OUT_DIR     куда писать данные для сайта (по умолчанию ./site/data)
//   CACHE_DIR   кэш справочника предметов между запусками (по умолчанию ./.cache)
//   BUILD       версия кода сайта (sha коммита), чтобы открытые страницы перезагрузились

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = process.env.OUT_DIR || 'site/data';
const CACHE = process.env.CACHE_DIR || '.cache';
const T0 = Date.now();
const DAY = 86_400_000;
const BYMYKEL = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/';
const CSGOTRADER = 'https://prices.csgotrader.app/latest/';
const STEAM_IMG = 'https://community.akamai.steamstatic.com/economy/image/';

const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
const cents = (usd) => { const c = Math.round(Number(usd) * 100); return Number.isFinite(c) && c > 0 ? c : 0; };
const slugify = (h) => h.toLowerCase().replace(/[™★'’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function get(url, { headers = {}, timeout = 120_000 } = {}) {
  let err;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (cs2-spread)', ...headers }, signal: AbortSignal.timeout(timeout) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      let buf = Buffer.from(await r.arrayBuffer());
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
      return JSON.parse(buf);
    } catch (e) { err = e; await new Promise((res) => setTimeout(res, 5000 * (i + 1))); }
  }
  throw err;
}

// ---------- площадки ----------
// Каждая возвращает Map: market_hash_name → { p: цена лота в центах, q: число лотов (null — неизвестно), o: автопокупка в центах, slug }.
// live — цены снимаются в момент сбора; иначе это сводка csgotrader.app, которую он обновляет раз в сутки.
const SOURCES = [
  {
    id: 'skinport', name: 'Skinport', live: true,
    async fetch() {
      // Skinport отвечает только с Brotli; кэширует ответ на 5 минут
      const list = await get('https://api.skinport.com/v1/items?app_id=730&currency=USD', { headers: { 'Accept-Encoding': 'br' } });
      const m = new Map();
      for (const x of list) {
        if (!x.quantity) continue;
        m.set(x.market_hash_name, { p: cents(x.min_price), q: x.quantity, slug: String(x.item_page || '').replace(/^.*\/item\//, '') });
      }
      return m;
    },
  },
  {
    id: 'waxpeer', name: 'Waxpeer', live: true,
    async fetch() {
      const j = await get('https://api.waxpeer.com/v1/prices?game=csgo&minified=1');
      const m = new Map();
      for (const x of j.items || []) if (x.count > 0) m.set(x.name, { p: Math.round(x.min / 10), q: x.count }); // min — в тысячных долях доллара
      return m;
    },
  },
  {
    id: 'tm', name: 'Market.CSGO', live: true,
    async fetch() {
      const m = new Map();
      try {
        const j = await get('https://market.csgo.com/api/v2/prices/USD.json');
        for (const x of j.items || []) if (Number(x.volume) > 0) m.set(x.market_hash_name, { p: cents(x.price), q: Number(x.volume) });
      } catch (e) {
        // с серверов GitHub площадка отвечает 403 — тогда берём её цены из суточной сводки csgotrader
        log(`tm direct failed (${e.message}), using csgotrader`);
        for (const [h, c] of Object.entries(await get(CSGOTRADER + 'csgotm.json'))) if (c) m.set(h, { p: cents(c), q: null });
        this.live = false;
      }
      return m;
    },
  },
  {
    id: 'lis', name: 'LIS-SKINS', live: true,
    async fetch() {
      const list = await get('https://lis-skins.com/market_export_json/csgo.json');
      const m = new Map();
      for (const x of list) {
        if (!(x.count > 0)) continue;
        m.set(x.name, { p: cents(x.price), q: x.count, slug: String(x.url || '').replace(/^.*\/market\/csgo\/|\/$/g, '') });
      }
      return m;
    },
  },
  {
    id: 'buff', name: 'Buff163', live: false,
    async fetch() {
      const j = await get(CSGOTRADER + 'buff163.json');
      const m = new Map();
      for (const [h, x] of Object.entries(j)) m.set(h, { p: cents(x?.starting_at?.price), q: null, o: cents(x?.highest_order?.price) });
      return m;
    },
  },
  {
    id: 'csfloat', name: 'CSFloat', live: false,
    async fetch() {
      const j = await get(CSGOTRADER + 'csfloat.json');
      const m = new Map();
      for (const [h, x] of Object.entries(j)) m.set(h, { p: cents(x?.starting_at?.price ?? x?.price), q: null, o: cents(x?.highest_order?.price) });
      return m;
    },
  },
  {
    id: 'youpin', name: 'Youpin898', live: false,
    async fetch() {
      const j = await get(CSGOTRADER + 'youpin.json');
      const m = new Map();
      for (const [h, x] of Object.entries(j)) if (x) m.set(h, { p: cents(x), q: null });
      return m;
    },
  },
];

// ---------- справочник предметов: картинка, тип, цвет редкости ----------
const CATEGORY = { Pistols: 'pistols', SMGs: 'smgs', Rifles: 'rifles', Heavy: 'heavy', Knives: 'knives', Gloves: 'gloves' };
const EXTRA = {
  'stickers.json': 'stickers', 'crates.json': 'cases', 'agents.json': 'agents', 'graffiti.json': 'graffiti', 'music_kits.json': 'music',
  'patches.json': 'patches', 'keychains.json': 'charms', 'highlights.json': 'charms', 'keys.json': 'keys', 'collectibles.json': 'collectibles',
};

async function buildRefs() {
  const out = {};
  const add = (h, img, cat, color) => { if (h && !out[h]) out[h] = [img || '', cat, color || '']; };
  // самый большой файл (32 МБ) — отдельно, остальные по очереди
  for (const x of await get(BYMYKEL + 'skins_not_grouped.json')) {
    add(x.market_hash_name, x.image, CATEGORY[x.category?.name] || 'other', x.rarity?.color);
  }
  for (const [file, cat] of Object.entries(EXTRA)) {
    try { for (const x of await get(BYMYKEL + file)) add(x.market_hash_name, x.image, cat, x.rarity?.color); }
    catch (e) { log('refs', file, e.message); }
  }
  return out;
}

async function getRefs() {
  const f = path.join(CACHE, 'refs.json.gz');
  try {
    const c = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)));
    if (Date.now() - c.at < DAY) return c.items;
  } catch { /* нет кэша */ }
  const items = await buildRefs();
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(f, zlib.gzipSync(JSON.stringify({ at: Date.now(), items })));
  log(`refs: ${Object.keys(items).length} items`);
  return items;
}

const guessCat = (h) => (/^Sticker \|/.test(h) ? 'stickers' : /^Patch \|/.test(h) ? 'patches' : /^(Souvenir )?Charm \|/.test(h) ? 'charms'
  : /Graffiti \|/.test(h) ? 'graffiti' : /Music Kit \|/.test(h) ? 'music' : !h.includes('|') && /Case|Capsule|Package/.test(h) ? 'cases' : 'other');

// курс USD→RUB (ЦБ РФ, запасной источник — open.er-api.com)
async function getRate() {
  const tries = [
    ['cbr', 'https://www.cbr-xml-daily.ru/daily_json.js', (j) => j?.Valute?.USD?.Value],
    ['er-api', 'https://open.er-api.com/v6/latest/USD', (j) => j?.rates?.RUB],
  ];
  for (const [src, url, pick] of tries) {
    try {
      const v = Number(pick(await get(url, { timeout: 15_000 })));
      if (v > 10 && v < 1000) return { usdRub: Math.round(v * 10000) / 10000, src };
    } catch (e) { log('rate', src, e.message); }
  }
  return null;
}

// ---------- main ----------
async function main() {
  const [refs, rate, ...results] = await Promise.all([
    getRefs(),
    getRate(),
    ...SOURCES.map(async (s) => {
      try {
        const m = await s.fetch();
        log(`${s.id}: ${m.size} items`);
        return m;
      } catch (e) {
        log(`${s.id} failed: ${e.message}`);
        s.error = String(e.message).slice(0, 200);
        return new Map();
      }
    }),
  ]);
  if (results.filter((m) => m.size).length < 2) throw new Error('меньше двух площадок ответили — данные не обновляю');

  const names = new Set();
  for (const m of results) for (const [h, x] of m) if (x.p) names.add(h);

  const items = [];
  const imgs = new Map();
  for (const h of names) {
    // фазы Doppler делят одно название, а стоят в разы по-разному — сравнивать нельзя
    if (/Doppler/.test(h)) continue;
    const p = results.map((m) => m.get(h)?.p || 0);
    if (p.filter(Boolean).length < 2) continue;
    const q = results.map((m, i) => (p[i] ? m.get(h).q ?? 0 : 0)); // 0 — число лотов неизвестно
    const o = results.map((m) => m.get(h)?.o || 0);
    const ref = refs[h];
    const img = ref?.[0] || '';
    imgs.set(h, img.startsWith(STEAM_IMG) ? img.slice(STEAM_IMG.length) : img);
    const slugs = {};
    results.forEach((m, i) => { const s = m.get(h)?.slug; if (s && s !== slugify(h)) slugs[SOURCES[i].id] = s; });
    // [название, тип, цвет редкости, цены лотов, число лотов, автопокупка (0 — нет ни на одной), адреса на площадках]
    items.push([h, ref?.[1] || guessCat(h), ref?.[2] || '', p, q, o.some(Boolean) ? o : 0, ...(Object.keys(slugs).length ? [slugs] : [])]);
  }
  items.sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const now = Date.now();
  const sources = SOURCES.map((s, i) => ({ id: s.id, name: s.name, live: s.live, count: results[i].size, error: s.error || null }));
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'items.json'), JSON.stringify({ updatedAt: now, sources, items }));
  // картинки — отдельным файлом в том же порядке: он почти такой же большой, как цены, и нужен не сразу
  fs.writeFileSync(path.join(OUT, 'images.json'), JSON.stringify({ base: STEAM_IMG, images: items.map((x) => imgs.get(x[0])) }));
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify({ updatedAt: now, build: process.env.BUILD || null, items: items.length, rate, sources }));
  log(`done: ${items.length} items on 2+ sites`);
}

main().catch((e) => { console.error(e); process.exit(1); });
