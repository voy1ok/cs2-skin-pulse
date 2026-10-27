#!/usr/bin/env node
// CS2 Skin Pulse — сбор каталога скинов, цен Steam Market и расчёт топов.
//
//   node scripts/update.mjs           — быстрый прогон (каждые 30 мин): цены Steam + быстрый топ
//   node scripts/update.mjs --daily   — суточный прогон: обновить каталог + топ «долгий холд»
//
// Переменные окружения:
//   STATE_DIR   папка с состоянием между прогонами (по умолчанию ./state)
//   OUT_DIR     куда писать данные для сайта (по умолчанию ./site/data)
//   BUDGET_MIN  сколько минут можно тратить на опрос Steam (по умолчанию 22)
//   STEAM_DELAY_MS пауза между страницами Steam (по умолчанию 3500)
//   CATALOG_DIR локальная папка с json-файлами каталога (для офлайн-отладки)
//   MOCK=1      не ходить в Steam, сгенерировать цены (для отладки)
//   FAKE_NOW    подменить текущее время (для отладки)

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ARGS = new Set(process.argv.slice(2));
const DAILY = ARGS.has('--daily');
const RENDER = ARGS.has('--render'); // только собрать сайт из готового состояния, ничего не опрашивать и не сохранять
const STATE = process.env.STATE_DIR || 'state';
const OUT = process.env.OUT_DIR || 'site/data';
const MOCK = process.env.MOCK === '1';
const BUDGET = (Number(process.env.BUDGET_MIN) || 22) * 60_000;
const DELAY = Number(process.env.STEAM_DELAY_MS) || 3500;
const NOW = process.env.FAKE_NOW ? Date.parse(process.env.FAKE_NOW) : Date.now();
const T0 = Date.now();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/';

const H = 3_600_000;
const DAY = 24 * H;
const INTRADAY_KEEP = 30 * H;
const DAILY_KEEP = 400;
const STALE = 4 * H; // полный обход ~16 тыс. позиций по 10 штук занимает 1–2 часа

const FAST_WINDOWS = { '1h': 1 * H, '6h': 6 * H, '24h': 24 * H };
const LONG_WINDOWS = { '7d': 7, '30d': 30, '90d': 90 };
const FAST_FILTER = { minPrice: 20, minOld: 10, minListings: 5 };
const LONG_FILTER = { minPrice: 100, minOld: 50, minListings: 5 };
const TOP_N = 100;

const STEAM_TYPES = [
  'tag_CSGO_Type_Pistol', 'tag_CSGO_Type_SMG', 'tag_CSGO_Type_Rifle', 'tag_CSGO_Type_SniperRifle',
  'tag_CSGO_Type_Shotgun', 'tag_CSGO_Type_Machinegun', 'tag_CSGO_Type_Knife', 'tag_Type_Hands',
];

const CATEGORY = { Pistols: 'pistols', SMGs: 'smgs', Rifles: 'rifles', Heavy: 'heavy', Knives: 'knives', Gloves: 'gloves', Equipment: 'equipment' };
const WEAR = { 'Factory New': 0, 'Minimal Wear': 1, 'Field-Tested': 2, 'Well-Worn': 3, 'Battle-Scarred': 4 };
const RARITY_ORDER = ['rarity_common_weapon', 'rarity_uncommon_weapon', 'rarity_rare_weapon', 'rarity_mythical_weapon',
  'rarity_legendary_weapon', 'rarity_ancient_weapon', 'rarity_ancient', 'rarity_contraband'];

const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayStr = (ms) => new Date(ms).toISOString().slice(0, 10);
const pct = (cur, old) => Math.round(((cur - old) / old) * 1000) / 10;

// ---------- state io ----------
function readState(name, def) {
  const f = path.join(STATE, `${name}.json.gz`);
  if (!fs.existsSync(f)) return def;
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(f))); } catch (e) { log('state broken', name, e.message); return def; }
}
function writeState(name, data) {
  if (RENDER) return;
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(path.join(STATE, `${name}.json.gz`), zlib.gzipSync(JSON.stringify(data), { level: 9 }));
}
function writeOut(rel, data) {
  const f = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data));
}

async function loadSource(name) {
  if (process.env.CATALOG_DIR) return JSON.parse(fs.readFileSync(path.join(process.env.CATALOG_DIR, name), 'utf8'));
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(API + name);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { log('catalog fetch failed', name, e.message); await sleep(5000 * (i + 1)); }
  }
  throw new Error(`cannot load ${name}`);
}

// ---------- catalog ----------
async function buildCatalog() {
  log('building catalog…');
  const [skins, flat, cols, crates] = await Promise.all(
    ['skins.json', 'skins_not_grouped.json', 'collections.json', 'crates.json'].map(loadSource));
  const operations = JSON.parse(fs.readFileSync(path.join(HERE, 'operations.json'), 'utf8'));

  const variants = new Map();
  const seen = new Set();
  for (const v of flat) {
    const h = v.market_hash_name;
    if (!h || seen.has(h)) continue; // фазы Doppler делят один hash
    seen.add(h);
    const w = v.wear?.name in WEAR ? WEAR[v.wear.name] : -1;
    const f = v.souvenir ? 2 : v.stattrak ? 1 : 0;
    if (!variants.has(v.skin_id)) variants.set(v.skin_id, []);
    variants.get(v.skin_id).push([h, w, f]);
  }

  const rarities = {};
  const crateById = new Map(crates.map((c) => [c.id, c]));
  const colStats = new Map();
  const crateStats = new Map();
  const list = [];
  for (const s of skins) {
    const vs = variants.get(s.id);
    if (!vs) continue;
    vs.sort((a, b) => a[2] - b[2] || a[1] - b[1]);
    const r = s.rarity || { id: 'unknown', name: 'Unknown', color: '#888888' };
    rarities[r.id] ??= { name: r.name, color: r.color, order: RARITY_ORDER.indexOf(r.id) };
    const col = (s.collections || []).map((c) => c.id);
    const cr = (s.crates || []).map((c) => c.id).filter((id) => crateById.has(id));
    col.forEach((id) => colStats.set(id, (colStats.get(id) || 0) + 1));
    cr.forEach((id) => crateStats.set(id, (crateStats.get(id) || 0) + 1));
    list.push({
      id: s.id.replace(/^skin-/, ''),
      n: s.name.replace(/^★ /, ''),
      star: s.name.startsWith('★') ? 1 : 0,
      w: s.weapon?.name || '',
      c: CATEGORY[s.category?.name] || 'other',
      r: r.id,
      img: s.image,
      fl: [s.min_float, s.max_float],
      col, cr,
      v: vs,
    });
  }

  const collections = cols.filter((c) => colStats.has(c.id)).map((c) => ({
    id: c.id, name: c.name, img: c.image, date: c.release_date, n: colStats.get(c.id),
    cr: (c.crates || []).map((k) => k.id).filter((id) => crateById.has(id)),
  }));
  const cratesOut = [...crateStats.keys()].map((id) => {
    const c = crateById.get(id);
    return { id, name: c.name, img: c.image, date: c.first_sale_date || null, type: c.type || 'Other', n: crateStats.get(id) };
  });
  const colByName = new Map(collections.map((c) => [c.name, c.id]));
  const ops = operations.map((o) => ({
    id: o.id, name: o.name, year: o.year, col: o.collections.map((n) => colByName.get(n)).filter(Boolean),
  }));

  log(`catalog: ${list.length} skins, ${seen.size} market items, ${collections.length} collections, ${cratesOut.length} crates`);
  return { builtAt: NOW, skins: list, groups: { rarities, collections, crates: cratesOut, operations: ops } };
}

// ---------- Steam ----------
async function fetchSteam(hashes, prices, cursor) {
  const base = 'https://steamcommunity.com/market/search/render/?appid=730&norender=1&count=100&search_descriptions=0'
    + '&sort_column=name&sort_dir=asc&' + STEAM_TYPES.map((t) => `category_730_Type%5B%5D=${t}`).join('&');
  let start = cursor.start || 0;
  let fails = 0, pages = 0, got = 0, passDone = false;
  while (Date.now() - T0 < BUDGET && !passDone) {
    let data;
    try {
      const r = await fetch(`${base}&start=${start}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
          Accept: 'application/json,text/javascript,*/*;q=0.01',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: 'https://steamcommunity.com/market/search?appid=730',
        },
      });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status} ${body.replace(/\s+/g, ' ').slice(0, 160)}`);
      }
      data = await r.json();
      if (!data?.success) throw new Error('success=false');
      if (!data.results?.length && start < (data.total_count || 0)) throw new Error('empty page (soft rate limit)');
    } catch (e) {
      fails++;
      cursor.errors = [...(cursor.errors || []), { at: Date.now(), start, msg: String(e.message).slice(0, 220) }].slice(-10);
      const wait = Math.min(240_000, 30_000 * 2 ** (fails - 1));
      log(`steam start=${start}: ${e.message}; retry in ${wait / 1000}s`);
      if (fails > 6 || Date.now() - T0 + wait > BUDGET) break;
      await sleep(wait);
      continue;
    }
    fails = 0; pages++;
    const now = Date.now();
    for (const it of data.results) {
      if (!hashes.has(it.hash_name)) continue;
      prices[it.hash_name] = [it.sell_listings > 0 ? it.sell_price : 0, it.sell_listings, now];
      got++;
    }
    cursor.total = data.total_count;
    cursor.pageSize = data.results.length;
    start += data.results.length; // Steam отдаёт без логина только 10 позиций за запрос
    if (start >= data.total_count) {
      start = 0; passDone = true;
      cursor.fullPassAt = now;
      cursor.passes = (cursor.passes || 0) + 1;
    }
    if (pages % 100 === 0) log(`steam: ${pages} pages, start=${start}/${cursor.total}`);
    await sleep(DELAY);
  }
  cursor.start = start;
  cursor.lastRun = { at: Date.now(), pages, items: got, passDone };
  log(`steam done: ${pages} pages, ${got} items, full pass: ${passDone}`);
  return got;
}

function mockPrices(catalog, prices) {
  const base = { rarity_common_weapon: 8, rarity_uncommon_weapon: 15, rarity_rare_weapon: 40, rarity_mythical_weapon: 180,
    rarity_legendary_weapon: 700, rarity_ancient_weapon: 2500, rarity_ancient: 15000, rarity_contraband: 300000 };
  const hot = (h) => [...h].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 97 === 0;
  let n = 0;
  for (const s of catalog.skins) for (const [h, w, f] of s.v) {
    const prev = prices[h]?.[0];
    let p = prev || Math.round((base[s.r] || 50) * (1 + (4 - Math.max(w, 0)) * 0.35) * (f === 1 ? 2.2 : f === 2 ? 1.6 : 1) * (s.star ? 10 : 1) * (0.5 + Math.random()));
    p = Math.max(3, Math.round(p * Math.exp((Math.random() - 0.5) * 0.04 + (hot(h) ? 0.03 : 0))));
    prices[h] = [p, Math.round(5 + Math.random() * 300), NOW];
    n++;
  }
  return n;
}

// ---------- series ----------
function ensureNames(state, hashes) {
  state.idx = new Map(state.names.map((h, i) => [h, i]));
  for (const h of hashes) if (!state.idx.has(h)) { state.idx.set(h, state.names.length); state.names.push(h); }
}
function snapshotRow(names, prices) {
  return names.map((h) => { const p = prices[h]; return p && p[0] > 0 && NOW - p[2] < STALE ? p[0] : 0; });
}
const cell = (row, j) => (row && row[j]) || 0;

// индекс снимка, ближайшего к моменту target (не позже target + tolerance)
function pastIndex(times, target, minSpan, tolerance) {
  let idx = -1;
  for (let i = 0; i < times.length; i++) if (times[i] <= target + tolerance) idx = i;
  if (idx >= 0) return idx;
  return times.length && times[times.length - 1] - times[0] >= minSpan ? 0 : -1;
}
function oldValue(rows, idx, j, last) {
  for (const k of [idx, idx - 1, idx + 1, idx - 2]) if (k >= 0 && k < last && cell(rows[k], j)) return rows[k][j];
  return 0;
}

function rank(names, curRow, oldRow, prices, filter, skinOf) {
  const out = [];
  for (let j = 0; j < names.length; j++) {
    const cur = cell(curRow, j), old = oldRow(j);
    if (!cur || !old || cur < filter.minPrice || old < filter.minOld) continue;
    const l = prices[names[j]]?.[1] || 0;
    if (l < filter.minListings) continue;
    const s = skinOf.get(names[j]);
    if (!s) continue;
    out.push({ h: names[j], s: s.id, p: cur, o: old, ch: pct(cur, old), l });
  }
  out.sort((a, b) => b.ch - a.ch || b.p - a.p);
  return out.slice(0, TOP_N);
}

function mergeBackfill(series, data) {
  const d = series.daily;
  const minDay = dayStr(NOW - DAILY_KEEP * DAY);
  const need = new Set(d.days);
  for (const arr of Object.values(data)) {
    for (let k = 1; k < arr.length; k++) if (arr[k]) need.add(dayStr((arr[0] + k - 1) * DAY));
  }
  if (need.size !== d.days.length) {
    const old = new Map(d.days.map((day, i) => [day, d.rows[i]]));
    d.days = [...need].filter((x) => x >= minDay).sort();
    d.rows = d.days.map((day) => old.get(day) || []);
  }
  const pos = new Map(d.days.map((day, i) => [day, i]));
  for (const [h, arr] of Object.entries(data)) {
    const j = series.idx.get(h);
    if (j === undefined) continue;
    for (let k = 1; k < arr.length; k++) {
      if (!arr[k]) continue;
      const i = pos.get(dayStr((arr[0] + k - 1) * DAY));
      if (i !== undefined && !d.rows[i][j]) d.rows[i][j] = arr[k];
    }
  }
}

// курс USD→RUB (ЦБ РФ, запасной источник — open.er-api.com)
async function getRate() {
  const tries = [
    ['cbr', 'https://www.cbr-xml-daily.ru/daily_json.js', (j) => j?.Valute?.USD?.Value],
    ['er-api', 'https://open.er-api.com/v6/latest/USD', (j) => j?.rates?.RUB],
  ];
  for (const [src, url, pick] of tries) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const v = Number(pick(await r.json()));
      if (v > 10 && v < 1000) return { usdRub: Math.round(v * 10000) / 10000, src, at: Date.now() };
    } catch (e) { log('rate', src, e.message); }
  }
  return null;
}

// цены Buff163 (через csgotrader.app, обновляются раз в сутки) — запасной источник
// для скинов, у которых нет лотов в Steam. В топы и проценты не попадают.
async function fetchBuff(hashes) {
  const r = await fetch('https://prices.csgotrader.app/latest/buff163.json', { signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  let buf = Buffer.from(await r.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  const j = JSON.parse(buf);
  const p = {};
  for (const [h, x] of Object.entries(j)) {
    const usd = Number(x?.starting_at?.price);
    if (hashes.has(h) && usd > 0) p[h] = Math.round(usd * 100);
  }
  return p;
}

// ---------- main ----------
async function main() {
  log(`mode=${RENDER ? 'render' : DAILY ? 'daily' : 'fast'}${MOCK ? ' (mock)' : ''} now=${new Date(NOW).toISOString()}`);
  let catalog = readState('catalog', null);
  if (!catalog || (!RENDER && (DAILY || NOW - catalog.builtAt > 3 * DAY))) {
    try { catalog = await buildCatalog(); writeState('catalog', catalog); }
    catch (e) { if (!catalog) throw e; log('catalog refresh failed, using cached:', e.message); }
  }
  const skinOf = new Map();
  for (const s of catalog.skins) for (const v of s.v) skinOf.set(v[0], s);
  const hashes = new Set(skinOf.keys());

  const prices = readState('prices', {});
  const cursor = readState('cursor', {});
  const series = readState('series', { names: [], intraday: { ts: [], rows: [] }, daily: { days: [], rows: [] } });
  let topFast = readState('top_fast', null);
  let topLong = readState('top_long', null);

  let buff = readState('buff', { at: 0, p: {} });
  if (!RENDER && !MOCK && NOW - buff.at > 6 * H) {
    try { buff = { at: NOW, p: await fetchBuff(hashes) }; writeState('buff', buff); log(`buff: ${Object.keys(buff.p).length} prices`); }
    catch (e) { log('buff fetch failed:', e.message); }
  }

  // история, загруженная из Steam (scripts/backfill-history.mjs): заполняет только пустые дни
  const bf = readState('history_backfill', null);
  if (bf?.data) {
    ensureNames(series, [...Object.keys(prices), ...Object.keys(bf.data)]);
    mergeBackfill(series, bf.data);
  }

  if (!DAILY && !RENDER) {
    const got = MOCK ? mockPrices(catalog, prices) : await fetchSteam(hashes, prices, cursor);
    ensureNames(series, Object.keys(prices));
    if (got > 0) {
      const row = snapshotRow(series.names, prices);
      const it = series.intraday;
      if (it.ts.length && NOW - it.ts[it.ts.length - 1] < 10 * 60_000) { it.ts.pop(); it.rows.pop(); }
      it.ts.push(NOW); it.rows.push(row);
      while (it.ts.length && it.ts[0] < NOW - INTRADAY_KEEP) { it.ts.shift(); it.rows.shift(); }

      const d = series.daily, today = dayStr(NOW);
      if (d.days[d.days.length - 1] !== today) { d.days.push(today); d.rows.push([]); }
      const dr = d.rows[d.rows.length - 1];
      row.forEach((v, j) => { if (v) dr[j] = v; });
      for (let j = 0; j < dr.length; j++) if (dr[j] === undefined || dr[j] === null) dr[j] = 0;
      while (d.days.length > DAILY_KEEP) { d.days.shift(); d.rows.shift(); }
    }

    // быстрый топ
    const it = series.intraday, last = it.rows.length;
    const cur = it.rows[last - 1];
    topFast = { updatedAt: NOW, windows: {} };
    for (const [key, win] of Object.entries(FAST_WINDOWS)) {
      const idx = last >= 2 ? pastIndex(it.ts.slice(0, -1), NOW - win, win * 0.5, 10 * 60_000) : -1;
      if (idx < 0) { topFast.windows[key] = { span: 0, items: [] }; continue; }
      const span = Math.round((NOW - it.ts[idx]) / 60_000);
      topFast.windows[key] = { span, items: rank(series.names, cur, (j) => oldValue(it.rows, idx, j, last - 1), prices, FAST_FILTER, skinOf) };
    }
    writeState('top_fast', topFast);
    writeState('prices', prices);
    writeState('cursor', cursor);
  } else {
    ensureNames(series, Object.keys(prices));
  }

  // долгий холд — раз в сутки (или если его ещё нет)
  const bfNewer = bf?.updatedAt && (!topLong || bf.updatedAt > (topLong.bfAt || 0));
  if ((DAILY && !RENDER) || !topLong || (!RENDER && bfNewer)) {
    const d = series.daily;
    const todayStr = dayStr(NOW);
    // берём последний ЗАКРЫТЫЙ день; если есть только сегодняшний — его
    let li = d.days.length - 1;
    if (li > 0 && d.days[li] === todayStr) li--;
    topLong = { updatedAt: NOW, bfAt: bf?.updatedAt || 0, day: d.days[li] || null, windows: {} };
    for (const [key, days] of Object.entries(LONG_WINDOWS)) {
      if (li < 1) { topLong.windows[key] = { days: 0, items: [] }; continue; }
      const target = Date.parse(d.days[li]) - days * DAY;
      const times = d.days.slice(0, li).map((x) => Date.parse(x));
      const idx = pastIndex(times, target, DAY, 0);
      if (idx < 0) { topLong.windows[key] = { days: 0, items: [] }; continue; }
      const span = Math.round((Date.parse(d.days[li]) - times[idx]) / DAY);
      topLong.windows[key] = { days: span, from: d.days[idx], items: rank(series.names, d.rows[li], (j) => oldValue(d.rows, idx, j, li), prices, LONG_FILTER, skinOf) };
    }
    writeState('top_long', topLong);
  }
  writeState('series', { names: series.names, intraday: series.intraday, daily: series.daily });

  // ---------- выход для сайта ----------
  const idx = series.idx;
  const it = series.intraday, d = series.daily;
  const iLast = it.rows.length - 1;
  const i24 = iLast >= 1 ? pastIndex(it.ts.slice(0, -1), NOW - DAY, 12 * H, 10 * 60_000) : -1;
  const d7 = d.days.length >= 2 ? pastIndex(d.days.slice(0, -1).map(Date.parse), Date.parse(d.days[d.days.length - 1]) - 7 * DAY, DAY, 0) : -1;
  const d30 = d.days.length >= 2 ? pastIndex(d.days.slice(0, -1).map(Date.parse), Date.parse(d.days[d.days.length - 1]) - 30 * DAY, DAY, 0) : -1;
  const change = (h, rows, i, lastIdx, curVal) => {
    const j = idx.get(h);
    if (j === undefined || i < 0 || !curVal) return null;
    const o = oldValue(rows, i, j, lastIdx);
    return o ? pct(curVal, o) : null;
  };

  let priced = 0, buffPriced = 0;
  const skinsOut = catalog.skins.map((s) => {
    let best = null;
    const v = s.v.map(([h, w, f]) => {
      const p = prices[h];
      const steam = p && p[0] > 0 ? p[0] : 0;
      if (steam) priced++;
      // нет лотов в Steam → цена Buff163 (последнее поле 'b'), без процентов
      if (!steam && buff.p[h]) {
        buffPriced++;
        const row = [h, w, f, buff.p[h], 0, null, null, null, 'b'];
        if (!best || (best[8] === 'b' && ((f === 0 && best[2] !== 0) || (f === best[2] && buff.p[h] < best[3])))) best = row;
        return row;
      }
      const ch24 = change(h, it.rows, i24, iLast, steam);
      const ch7 = change(h, d.rows, d7, d.rows.length - 1, steam);
      const ch30 = change(h, d.rows, d30, d.rows.length - 1, steam);
      const row = [h, w, f, steam, p ? p[1] : 0, ch24, ch7, ch30];
      if (steam && (!best || best[8] === 'b' || (f === 0 && best[2] !== 0) || (f === best[2] && steam < best[3]))) best = row;
      return row;
    });
    return { ...s, v, p: best ? best[3] : 0, pb: best?.[8] === 'b' ? 1 : 0, ch24: best ? best[5] : null, ch7: best ? best[6] : null, ch30: best ? best[7] : null };
  });

  fs.rmSync(OUT, { recursive: true, force: true });
  writeOut('catalog.json', { updatedAt: NOW, skins: skinsOut, groups: catalog.groups });

  const decorate = (top) => top && {
    ...top,
    windows: Object.fromEntries(Object.entries(top.windows).map(([k, w]) => [k, {
      ...w,
      items: w.items.map((x) => { const s = skinOf.get(x.h); return s ? { ...x, img: s.img, r: s.r, c: s.c } : x; }),
    }])),
  };
  writeOut('top_fast.json', decorate(topFast) || { updatedAt: null, windows: {} });
  writeOut('top_long.json', decorate(topLong) || { updatedAt: null, windows: {} });

  // история по каждому скину
  for (const s of catalog.skins) {
    const v = {};
    for (const [h] of s.v) {
      const j = idx.get(h);
      if (j === undefined) continue;
      const i = []; const dd = [];
      it.ts.forEach((t, k) => { const c = cell(it.rows[k], j); if (c) i.push([Math.round(t / 60_000), c]); });
      d.days.forEach((day, k) => { const c = cell(d.rows[k], j); if (c) dd.push([day, c]); });
      if (i.length || dd.length) v[h] = { i, d: dd };
    }
    writeOut(`history/${s.id}.json`, { updatedAt: NOW, v });
  }

  const rate = MOCK ? { usdRub: 81.5, src: 'mock', at: NOW } : (await getRate()) || cursor.rate || null;
  if (rate && !RENDER && !DAILY) { cursor.rate = rate; writeState('cursor', cursor); }
  const meta = {
    rate,
    updatedAt: RENDER ? (cursor.lastRun?.at || topFast?.updatedAt || NOW) : NOW,
    mode: DAILY ? 'daily' : 'fast',
    source: process.env.SOURCE || null,
    mock: MOCK,
    skins: catalog.skins.length,
    items: hashes.size,
    priced,
    buffPriced,
    buffAt: buff.at || null,
    snapshots: it.ts.length,
    firstSnapshot: it.ts[0] || null,
    days: d.days.length,
    firstDay: d.days[0] || null,
    fullPassAt: cursor.fullPassAt || null,
    lastRun: cursor.lastRun || null,
    fastUpdatedAt: topFast?.updatedAt || null,
    longUpdatedAt: topLong?.updatedAt || null,
    filters: { fast: FAST_FILTER, long: LONG_FILTER },
    backfill: bf ? { status: bf.status, done: Object.keys(bf.data || {}).length, total: bf.total || 0, updatedAt: bf.updatedAt || null } : null,
  };
  writeOut('meta.json', meta);
  log('done', JSON.stringify({ priced, snapshots: meta.snapshots, days: meta.days }));
}

main().catch((e) => { console.error(e); process.exit(1); });
