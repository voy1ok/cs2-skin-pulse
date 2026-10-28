#!/usr/bin/env node
// CS2 Spread — цены скинов CS2 на площадках, куда можно завести рубли из России, и данные для сайта.
//
//   node scripts/collect.mjs
//
// Переменные окружения:
//   OUT_DIR    куда писать данные для сайта (по умолчанию ./site/data)
//   CACHE_DIR  кэш справочника предметов между запусками (по умолчанию ./.cache)
//   STEAM_DIR  папка с ценами Steam и Market.CSGO, которые собирает VPS (ветка `steam`, по умолчанию ./steam)
//   BUILD      версия кода сайта (sha коммита), чтобы открытые страницы перезагрузились

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = process.env.OUT_DIR || 'site/data';
const CACHE = process.env.CACHE_DIR || '.cache';
const STEAM_DIR = process.env.STEAM_DIR || 'steam';
const T0 = Date.now();
const H = 3_600_000;
const DAY = 24 * H;
const STEAM_MAX_AGE = 36 * H; // цену Steam старше полутора суток не показываем
const VOLUME_MAX_AGE = 3 * DAY; // продажи Steam за сутки — считаем актуальными 3 дня
const CANDIDATES = 1500;        // сколько самых выгодных предметов отдаём VPS, чтобы он узнал их продажи в Steam
// комиссии продажи по умолчанию — те же, что на сайте (site/app.js, SITE)
const SELL_KEEP = { steam: 1 - 0.1304, tm: 0.95, csmoney: 0.95 };
const BYMYKEL = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en/';
const CSGOTRADER = 'https://prices.csgotrader.app/latest/';
const STEAM_IMG = 'https://community.akamai.steamstatic.com/economy/image/';

const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
const kop = (rub) => { const c = Math.round(Number(rub) * 100); return Number.isFinite(c) && c > 0 ? c : 0; };
const slugify = (h) => h.toLowerCase().replace(/[™★'’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function get(url, { headers = {}, timeout = 120_000, tries = 3 } = {}) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (cs2-spread)', ...headers }, signal: AbortSignal.timeout(timeout) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      let buf = Buffer.from(await r.arrayBuffer());
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
      return JSON.parse(buf);
    } catch (e) { err = e; if (i < tries - 1) await new Promise((res) => setTimeout(res, 5000 * (i + 1))); }
  }
  throw err;
}
function readGz(f) {
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(f))); } catch { return null; }
}

// курс USD→RUB (ЦБ РФ, запасной источник — open.er-api.com)
async function getRate() {
  const tries = [
    ['ЦБ РФ', 'https://www.cbr-xml-daily.ru/daily_json.js', (j) => j?.Valute?.USD?.Value],
    ['open.er-api.com', 'https://open.er-api.com/v6/latest/USD', (j) => j?.rates?.RUB],
  ];
  for (const [src, url, pick] of tries) {
    try {
      const v = Number(pick(await get(url, { timeout: 15_000 })));
      if (v > 10 && v < 1000) return { usdRub: Math.round(v * 10000) / 10000, src };
    } catch (e) { log('rate', src, e.message); }
  }
  throw new Error('нет курса рубля');
}

// ---------- площадки ----------
// fetch(ctx) возвращает Map: market_hash_name → { p: цена лота в копейках, q: число лотов, slug }.
// Откуда взяты цены — в this.via, их время — в this.at.
const SOURCES = [
  {
    id: 'steam', name: 'Steam',
    async fetch() {
      // Steam не пускает серверы GitHub — цены собирает VPS (scripts/steam-crawl.mjs) и кладёт в ветку `steam`
      const s = readGz(path.join(STEAM_DIR, 'steam.json.gz'));
      if (!s?.prices) throw new Error('нет данных с VPS');
      // без входа в аккаунт Steam отдаёт центы — переводим по курсу самого Steam; с рублёвым аккаунтом — сразу копейки
      const rub = s.unit === 'rub';
      const rate = rub ? 1 : s.rate?.usdRub;
      if (!rate) throw new Error('нет курса Steam');
      const m = new Map();
      let newest = 0;
      for (const [h, [c, q, t]] of Object.entries(s.prices)) {
        if (!c || !q || T0 - t > STEAM_MAX_AGE) continue;
        m.set(h, { p: Math.round(c * rate), q }); // центы × курс = копейки
        newest = Math.max(newest, t);
      }
      if (!m.size) {
        const c = s.cursor || {};
        throw new Error(Object.keys(s.prices).length ? 'цены Steam с VPS устарели'
          : c.cooldownUntil ? 'VPS ещё собирает: Steam ограничил запросы, сбор продолжится после паузы' : 'VPS ещё не собрал цены');
      }
      this.via = rub ? 'с VPS, в рублях' : `с VPS, курс Steam ${rate.toFixed(2)} ₽/$`;
      this.at = newest;
      return m;
    },
  },
  {
    id: 'tm', name: 'Market.CSGO',
    async fetch({ rate }) {
      const parse = (j) => {
        const m = new Map();
        for (const x of j.items || []) if (Number(x.volume) > 0) m.set(x.market_hash_name, { p: kop(x.price), q: Number(x.volume) });
        return m;
      };
      // 1) напрямую; 2) снимок с VPS (с серверов GitHub площадка отвечает 403); 3) суточная сводка csgotrader в долларах
      let m = null;
      try {
        m = parse(await get('https://market.csgo.com/api/v2/prices/RUB.json', { tries: 1 }));
        this.via = 'напрямую'; this.at = Date.now();
      } catch (e) { log(`tm direct: ${e.message}`); }
      const v = !m && readGz(path.join(STEAM_DIR, 'tm.json.gz'));
      if (v?.items && Date.now() - v.at < DAY) {
        m = parse(v);
        this.via = 'снимок с VPS'; this.at = v.at;
      }
      if (m) {
        this.rate = await impliedRate(m).catch((e) => { log('tm rate:', e.message); return null; });
        return m;
      }
      const j = await get(CSGOTRADER + 'csgotm.json');
      m = new Map();
      for (const [h, usd] of Object.entries(j)) if (usd) m.set(h, { p: kop(usd * rate.usdRub), q: 0 });
      this.via = `сводка csgotrader.app за сутки, курс ${rate.src}`; this.at = Date.now();
      return m;
    },
  },
  {
    id: 'lis', name: 'LIS-SKINS',
    async fetch({ rate, tmRate }) {
      // LIS-SKINS отдаёт цены только в долларах
      const usdRub = usdRubFor(rate, tmRate);
      const list = await get('https://lis-skins.com/market_export_json/csgo.json');
      const m = new Map();
      for (const x of list) {
        // unlocked_price — лоты без блокировки обмена: только их можно сразу перепродать
        const usd = x.unlocked_price || 0;
        if (!(x.count > 0) || !usd) continue;
        m.set(x.name, { p: kop(usd * usdRub), q: x.count, slug: String(x.url || '').replace(/^.*\/market\/csgo\/|\/$/g, '') });
      }
      this.rate = usdRub;
      this.via = `в долларах, ${rateNote(usdRub, rate)}`; this.at = Date.now();
      return m;
    },
  },
  {
    id: 'csmoney', name: 'CS.MONEY',
    async fetch({ rate, tmRate }) {
      // API маркета CS.MONEY закрыт проверкой Cloudflare — берём минимальные цены из суточной сводки csgotrader.app.
      // Числа лотов в ней нет; по сравнению с другими площадками это цены маркета, а не обменника.
      const usdRub = usdRubFor(rate, tmRate);
      const j = await get(CSGOTRADER + 'csmoney.json');
      const m = new Map();
      for (const [h, x] of Object.entries(j)) { const c = kop((x?.price || 0) * usdRub); if (c) m.set(h, { p: c, q: 0 }); }
      this.rate = usdRub;
      this.via = `сводка csgotrader.app за сутки, ${rateNote(usdRub, rate)}`; this.at = Date.now();
      return m;
    },
  },
];

// для LIS-SKINS и CS.MONEY: цены в долларах, свой курс рубля площадки не публикуют. У рублёвых площадок он
// выше ЦБ (Market.CSGO — около +4%), поэтому берём больший из курсов ЦБ и Market.CSGO: так выгода покупки
// там скорее занижена, чем завышена. Точный курс можно поставить на сайте.
function usdRubFor(rate, tmRate) { return Math.max(rate.usdRub, tmRate || 0); }
function rateNote(r, rate) { return `курс ${r.toFixed(2)} ₽/$ (${r > rate.usdRub ? 'как у Market.CSGO' : rate.src})`; }

// курс, по которому Market.CSGO переводит доллары в рубли: медиана отношения его рублёвых и долларовых цен
async function impliedRate(rubMap) {
  let usd;
  try {
    const j = await get('https://market.csgo.com/api/v2/prices/USD.json', { tries: 1 });
    usd = new Map((j.items || []).map((x) => [x.market_hash_name, Number(x.price)]));
  } catch {
    usd = new Map(Object.entries(await get(CSGOTRADER + 'csgotm.json')).map(([h, v]) => [h, Number(v)]));
  }
  const r = [];
  for (const [h, x] of rubMap) { const u = usd.get(h); if (u > 1 && x.q >= 10) r.push(x.p / 100 / u); }
  if (r.length < 500) throw new Error(`мало пар цен: ${r.length}`);
  r.sort((a, b) => a - b);
  const k = r[Math.floor(r.length / 2)];
  if (!(k > 10 && k < 1000)) throw new Error(`странный курс ${k}`);
  return Math.round(k * 100) / 100;
}

// продажи: Skinport отдаёт число продаж за 7 и 30 дней сразу по всем предметам. Покупать там из России
// нельзя, но как мера спроса годится; точное число продаж за сутки — по Steam, его собирает VPS.
// Заодно — медиана цены сделок за 30 дней: по ней отсеиваем явно ошибочные цены площадок.
async function getSales(rate) {
  const list = await get('https://api.skinport.com/v1/sales/history?app_id=730&currency=USD', { headers: { 'Accept-Encoding': 'br' } });
  const m = new Map();
  for (const x of list) m.set(x.market_hash_name, [x.last_7_days?.volume || 0, x.last_30_days?.volume || 0, kop((x.last_30_days?.median || 0) * rate)]);
  return m;
}
function steamVolumes() {
  const v = readGz(path.join(STEAM_DIR, 'volume.json.gz'));
  const m = new Map();
  for (const [h, [n, t]] of Object.entries(v?.items || {})) if (T0 - t < VOLUME_MAX_AGE) m.set(h, n);
  return m;
}

// предметы, у которых есть выгодный маршрут при комиссиях по умолчанию. Порядок — как «Лучшие» на сайте
// (выгода в рублях × ликвидность по Skinport), чтобы VPS первыми проверял в Steam самые перспективные
function candidates(items) {
  const ids = SOURCES.map((s) => s.id);
  const out = [];
  for (const [h, , , p, q, sv] of items) {
    let best = -Infinity;
    p.forEach((b, i) => {
      if (!b || b < 10000 || (q[i] && q[i] < 2)) return;
      p.forEach((c, j) => {
        const keep = SELL_KEEP[ids[j]];
        if (!c || i === j || !keep || c > b * 1.8 || (q[j] && q[j] < 2) || (sv[3] && (b < sv[3] * 0.6 || c > sv[3] * 2))) return;
        best = Math.max(best, c * keep - b);
      });
    });
    if (best > 0) out.push([h, best * Math.min(1, (sv[1] + 1) / 20)]);
  }
  return out.sort((a, b) => b[1] - a[1]).slice(0, CANDIDATES).map((x) => x[0]);
}

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
  const c = readGz(f);
  if (c && Date.now() - c.at < DAY) return c.items;
  const items = await buildRefs();
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(f, zlib.gzipSync(JSON.stringify({ at: Date.now(), items })));
  log(`refs: ${Object.keys(items).length} items`);
  return items;
}

const guessCat = (h) => (/^Sticker \|/.test(h) ? 'stickers' : /^Patch \|/.test(h) ? 'patches' : /^(Souvenir )?Charm \|/.test(h) ? 'charms'
  : /Graffiti \|/.test(h) ? 'graffiti' : /Music Kit \|/.test(h) ? 'music' : !h.includes('|') && /Case|Capsule|Package/.test(h) ? 'cases' : 'other');

// ---------- main ----------
async function main() {
  const [refs, rate] = await Promise.all([getRefs(), getRate()]);
  const sales = await getSales(rate.usdRub).catch((e) => { log('skinport sales:', e.message); return new Map(); });
  const vols = steamVolumes();
  log(`sales: skinport ${sales.size}, steam ${vols.size}`);
  const run = async (s, ctx) => {
    try {
      const m = await s.fetch(ctx);
      log(`${s.id}: ${m.size} items (${s.via})`);
      return m;
    } catch (e) {
      log(`${s.id} failed: ${e.message}`);
      s.error = String(e.message).slice(0, 200);
      return new Map();
    }
  };
  const [steam, tm, ...usd] = SOURCES;
  // LIS-SKINS и CS.MONEY пересчитываются по курсу Market.CSGO — поэтому после него
  const [steamRes, tmRes] = await Promise.all([run(steam, { rate }), run(tm, { rate })]);
  const results = [steamRes, tmRes, ...await Promise.all(usd.map((s) => run(s, { rate, tmRate: tm.rate })))];
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
    const q = results.map((m, i) => (p[i] ? m.get(h).q || 0 : 0)); // 0 — число лотов неизвестно
    const ref = refs[h];
    const img = ref?.[0] || '';
    imgs.set(h, img.startsWith(STEAM_IMG) ? img.slice(STEAM_IMG.length) : img);
    const slugs = {};
    results.forEach((m, i) => { const s = m.get(h)?.slug; if (s && s !== slugify(h)) slugs[SOURCES[i].id] = s; });
    // продажи: [Steam за сутки (-1 — не знаем), Skinport за 7 дней, за 30 дней, медиана сделок Skinport за 30 дней в копейках]
    const sp = sales.get(h) || [0, 0, 0];
    const sv = [vols.has(h) ? vols.get(h) : -1, sp[0], sp[1], sp[2]];
    // [название, тип, цвет редкости, цены лотов в копейках, число лотов, продажи, адреса на площадках]
    items.push([h, ref?.[1] || guessCat(h), ref?.[2] || '', p, q, sv, ...(Object.keys(slugs).length ? [slugs] : [])]);
  }
  items.sort((a, b) => (a[0] < b[0] ? -1 : 1));

  const now = Date.now();
  const sources = SOURCES.map((s, i) => ({
    id: s.id, name: s.name, count: results[i].size, via: s.via || null, at: s.at || null, rate: s.rate || null, error: s.error || null,
  }));
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'items.json'), JSON.stringify({ updatedAt: now, sources, items }));
  // картинки — отдельным файлом в том же порядке: он почти такой же большой, как цены, и нужен не сразу
  fs.writeFileSync(path.join(OUT, 'images.json'), JSON.stringify({ base: STEAM_IMG, images: items.map((x) => imgs.get(x[0])) }));
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify({
    updatedAt: now, build: process.env.BUILD || null, items: items.length, rate, sources,
    sales: { skinport: sales.size, steam: vols.size },
  }));
  // список для VPS: по каким предметам узнать продажи в Steam в первую очередь
  fs.writeFileSync(path.join(OUT, 'candidates.json'), JSON.stringify({ updatedAt: now, items: candidates(items) }));
  log(`done: ${items.length} items on 2+ sites`);
}

main().catch((e) => { console.error(e); process.exit(1); });
