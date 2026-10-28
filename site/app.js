/* CS2 Spread — клиентская часть (без сборки, чистый JS) */
(() => {
  'use strict';

  const CAT = {
    all: 'Все', knives: 'Ножи', gloves: 'Перчатки', rifles: 'Винтовки', pistols: 'Пистолеты', smgs: 'Пистолеты-пулемёты', heavy: 'Тяжёлое',
    stickers: 'Наклейки', cases: 'Кейсы и капсулы', agents: 'Агенты', charms: 'Брелоки', patches: 'Нашивки', graffiti: 'Граффити',
    music: 'Музыкальные наборы', keys: 'Ключи', collectibles: 'Значки', other: 'Другое',
  };
  const MIN_SALES = [[0, 'любые'], [1, 'от 1 в сутки'], [5, 'от 5 в сутки'], [20, 'от 20 в сутки'], [100, 'от 100 в сутки']];
  const LIQUID = 20;      // от 20 продаж в сутки в Steam предмет считаем ходовым: продастся быстро
  const MIN_PRICE = [[0, 'любая'], [5000, '50 ₽'], [10000, '100 ₽'], [50000, '500 ₽'], [100000, '1 000 ₽'], [500000, '5 000 ₽'], [2000000, '20 000 ₽']];
  // площадки: можно ли продать (и выводятся ли деньги), комиссии по умолчанию в процентах
  const SITE = {
    steam: { sell: true, cash: false, fee: { sell: 13.04, dep: 0, out: 0 }, note: 'покупатель платит +15% к сумме продавца' },
    tm: { sell: true, cash: true, fee: { sell: 5, dep: 0, out: 0 }, note: 'комиссия продавца 5%' },
    lis: { sell: false, cash: true, fee: { sell: 0, dep: 0, out: 0 }, note: 'только покупка; цены в $ — проверьте курс на их сайте' },
  };
  const MIN_LOTS = 2;     // если на площадке меньше лотов, её цену не берём
  const SUSPICIOUS = 1.8; // продажа дороже покупки больше чем в 1,8 раза — почти всегда ошибка в данных или случайный лот
  // цена лота сильно ниже (или продажи — выше) медианы реальных сделок за месяц — тоже ошибка или лот с подвохом
  const REF_LOW = 0.6, REF_HIGH = 2;
  const PAGE = 50;
  const BUILD = (document.currentScript?.src.match(/[?&]v=([^&]+)/) || [])[1] || null;

  const slugify = (h) => h.toLowerCase().replace(/[™★'’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const enc = encodeURIComponent;
  const LINK = {
    steam: (h) => `https://steamcommunity.com/market/listings/730/${enc(h)}`,
    tm: (h) => `https://market.csgo.com/ru/?search=${enc(h)}`,
    lis: (h, s) => `https://lis-skins.com/ru/market/csgo/${s || slugify(h)}/`,
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('cs2spread.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('cs2spread.' + k, JSON.stringify(v)); } catch { /* приватный режим */ } },
  };

  const D = { meta: null, sources: [], items: [], images: null, rows: [], shown: PAGE, open: new Set() };
  const ui = {
    q: '', cat: store.get('cat', 'all'), minp: store.get('minp', 10000), sell: store.get('sell', 'all'), sort: store.get('sort2', 'best'),
    mins: store.get('mins', 0),
    fees: Object.fromEntries(Object.entries(SITE).map(([id, s]) => [id, { ...s.fee, ...store.get('fee.' + id, {}) }])),
    lisRate: store.get('rate.lis', 0), // свой курс LIS-SKINS, ₽ за $ (0 — как в данных)
  };

  const rub = (k, sign = false) => {
    if (k == null || Number.isNaN(k)) return '—';
    const r = k / 100, a = Math.abs(r), d = a < 100 ? 2 : 0;
    return (sign && r > 0 ? '+' : r < 0 ? '−' : '') + a.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }) + ' ₽';
  };
  const num = (n) => Number(n || 0).toLocaleString('ru-RU');
  const pct = (v, sign = true) => {
    const x = v * 100, a = Math.abs(x);
    return (sign && x > 0 ? '+' : x < 0 ? '−' : '') + (a >= 10 ? Math.round(a) : Math.round(a * 10) / 10).toLocaleString('ru-RU') + '%';
  };
  const ago = (t) => {
    if (!t) return 'нет данных';
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'только что';
    if (m < 60) return `${m} мин назад`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} ч назад` : `${Math.round(h / 24)} дн назад`;
  };
  const NOIMG = 'data:image/svg+xml,' + enc('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 3"><rect width="4" height="3" rx=".3" fill="#8883"/></svg>');
  const img = (i, size) => {
    const u = D.images?.images[i];
    if (!u) return NOIMG;
    return u.startsWith('http') ? u : `${D.images.base}${u}/${size}`;
  };
  const sid = (i) => D.sources[i]?.id;
  const sname = (i) => D.sources[i]?.name || '';

  async function getJSON(url) {
    const r = await fetch(`${url}?v=${Math.floor(Date.now() / 60000)}`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${url} ${r.status}`);
    return r.json();
  }

  // ---------- расчёт ----------
  // сколько стоит купить по цене лота c на площадке i (с наценкой пополнения)
  const cost = (i, c) => c * (1 + ui.fees[sid(i)].dep / 100);
  // сколько получишь, выставив лот по цене c на площадке i (за вычетом комиссии продажи и вывода)
  const proceeds = (i, c) => { const f = ui.fees[sid(i)]; return c * (1 - f.sell / 100) * (1 - f.out / 100); };

  // LIS-SKINS отдаёт цены в долларах: если пользователь поставил свой курс, пересчитываем
  const scaled = (it) => it[3].map((c, i) => (c && D.scale[i] !== 1 ? Math.round(c * D.scale[i]) : c));

  // продажи: [Steam за сутки (-1 — не знаем), Skinport за 7 дней, Skinport за 30 дней]
  // k — множитель ликвидности от 0 до 1; по одному Skinport — с поправкой ×0,5, это лишь оценка спроса
  function liquidity(s) {
    const [steam = -1, sp7 = 0, sp30 = 0] = s || [];
    if (steam >= 0) return { day: steam, k: Math.min(1, steam / LIQUID), src: 'steam' };
    return { day: null, sp7, sp30, k: Math.min(1, sp7 / LIQUID) * 0.5, src: sp30 ? 'skinport' : null };
  }
  const salesTxt = (x) => (x.src === 'steam' ? `${num(x.day)} продаж/сутки в Steam`
    : x.src === 'skinport' ? `продаж на Skinport: ${num(x.sp7)} за неделю, ${num(x.sp30)} за месяц` : 'продажи неизвестны');

  function evaluate(it, idx) {
    const q = it[4], p = scaled(it), ref = it[5]?.[3] || 0;
    const ok = p.map((c, i) => (c && (!q[i] || q[i] >= MIN_LOTS) ? c : 0));
    let best = null;
    const routes = [];
    ok.forEach((b, i) => {
      if (!b) return;
      ok.forEach((s, j) => {
        const site = SITE[sid(j)];
        if (!s || i === j || !site?.sell || (ui.sell === 'cash' && !site.cash) || s > b * SUSPICIOUS) return;
        if (ref && (b < ref * REF_LOW || s > ref * REF_HIGH)) return;
        const buy = cost(i, b), get = proceeds(j, s);
        const r = { i, j, b, s, buy, get, profit: get - buy, pct: (get - buy) / buy };
        routes.push(r);
        if (!best || r.pct > best.pct) best = r;
      });
    });
    if (!best || best.b < ui.minp) return null;
    const sales = liquidity(it[5]);
    if (ui.mins && !(sales.day >= ui.mins)) return null;
    const vals = ok.filter(Boolean);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    // «лучшие»: выгода в рублях с поправкой на то, как быстро предмет продаётся (k², чтобы редкие уходили вниз)
    const score = best.profit > 0 ? best.profit * sales.k * sales.k : best.profit;
    return { idx, it, p, ok, best, routes, sales, score, spread: (hi - lo) / lo };
  }

  function recompute() {
    D.scale = D.sources.map((s) => (s.id === 'lis' && ui.lisRate && s.rate ? ui.lisRate / s.rate : 1));
    const q = ui.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = [];
    D.items.forEach((it, i) => {
      if (ui.cat !== 'all' && it[1] !== ui.cat) return;
      if (q.length) { const h = it[0].toLowerCase(); if (!q.every((w) => h.includes(w))) return; }
      const r = evaluate(it, i);
      if (r) rows.push(r);
    });
    const key = {
      best: (r) => r.score, pct: (r) => r.best.pct, rub: (r) => r.best.profit, spread: (r) => r.spread,
      sales: (r) => (r.best.profit > 0 ? (r.sales.day ?? r.sales.sp7 / 100) : -1),
    }[ui.sort];
    rows.sort((a, b) => key(b) - key(a) || b.best.b - a.best.b);
    D.rows = rows;
    D.shown = PAGE;
    renderList();
  }

  // ---------- отрисовка ----------
  function renderSources() {
    $('sources').innerHTML = D.sources.map((s) => `
      <span class="src ${s.error ? 'src--err' : ''}" title="${esc(s.error ? 'Нет данных: ' + s.error : `${num(s.count)} предметов, ${s.via || ''}`)}">
        <i></i>${esc(s.name)}<small>${s.error ? 'нет данных' : `${num(s.count)} · ${esc(ago(s.at))}`}</small>
      </span>`).join('');
  }

  function renderStatus() {
    const m = D.meta;
    const fresh = m && Date.now() - m.updatedAt < 12 * 3600_000;
    $('status').innerHTML = `<span class="dot ${fresh ? '' : 'old'}"></span><span class="status__long">обновлено </span>${esc(ago(m?.updatedAt))}`;
    $('status').title = m ? `Цены обновляются раз в 10 часов. Последнее обновление: ${new Date(m.updatedAt).toLocaleString('ru-RU')}` : '';
  }

  function renderFees() {
    const field = (id, k, label, on = true) => `<label class="fee ${on ? '' : 'fee--off'}">${label}
      <span><input type="number" min="0" max="50" step="0.1" inputmode="decimal" data-site="${id}" data-k="${k}" value="${ui.fees[id][k]}" ${on ? '' : 'disabled'}>%</span></label>`;
    $('feebox').innerHTML = D.sources.map((s) => {
      const site = SITE[s.id];
      if (!site) return '';
      const rate = s.id === 'lis' && s.rate ? `<label class="fee">курс ₽/$
        <span><input type="number" min="50" max="200" step="0.01" inputmode="decimal" data-rate="lis" value="${ui.lisRate || s.rate}"></span></label>` : '';
      return `<div class="feerow"><b>${esc(s.name)}</b><small>${esc(site.note)}</small>
        ${field(s.id, 'dep', 'пополнение')}${field(s.id, 'sell', 'продажа', site.sell)}${field(s.id, 'out', 'вывод', site.sell && site.cash)}${rate}</div>`;
    }).join('');
    renderFeeSum();
  }

  function rowHtml(r, n) {
    const [h, cat, color] = r.it;
    const open = D.open.has(r.idx);
    const b = r.best;
    const main = ui.sort === 'spread' ? `+${pct(r.spread, false)}` : pct(b.pct);
    const good = ui.sort === 'spread' || b.profit > 0;
    return `
      <article class="row ${open ? 'row--open' : ''}" data-idx="${r.idx}" style="--rc:${esc(color || '#5d6578')}">
        <button class="row__main" type="button" aria-expanded="${open}">
          <span class="row__n">${n}</span>
          <img src="${esc(img(r.idx, '128fx96f'))}" alt="" loading="lazy" width="64" height="48">
          <span class="row__name"><b>${esc(h)}</b><small>${esc(CAT[cat] || '')} · <span class="liq liq--${r.sales.k >= 1 ? 'hi' : r.sales.k >= 0.25 ? 'mid' : 'lo'}">${esc(salesTxt(r.sales))}</span></small>
            <small class="row__route">${esc(sname(b.i))} ${rub(b.b)} → ${esc(sname(b.j))} ${rub(b.s)}</small></span>
          <span class="row__diff"><span class="chip ${good ? '' : 'chip--bad'}">${main}</span><small>${ui.sort === 'spread' ? 'без комиссий' : rub(b.profit, true)}</small></span>
        </button>
        ${open ? detailHtml(r) : ''}
      </article>`;
  }

  function detailHtml(r) {
    const [h, , , , q, , slugs] = r.it;
    const { p } = r;
    const b = r.best;
    const sites = p.map((c, i) => i).filter((i) => p[i]).sort((x, y) => p[x] - p[y]).map((i) => {
      const cls = i === b.i ? 'lo' : i === b.j ? 'hi' : r.ok[i] ? '' : 'off';
      const note = r.ok[i] ? (SITE[sid(i)]?.sell ? '' : 'только покупка') : 'мало лотов, не учтена';
      return `<a class="site ${cls}" href="${esc(LINK[sid(i)](h, slugs?.[sid(i)]))}" target="_blank" rel="noopener">
          <span class="site__name">${esc(sname(i))}${note ? `<small>${note}</small>` : ''}</span>
          <span class="site__lots">${q[i] ? num(q[i]) + ' лот.' : ''}</span>
          <span class="site__price">${rub(p[i])}</span>
        </a>`;
    }).join('');
    const f = ui.fees[sid(b.j)], fb = ui.fees[sid(b.i)];
    const calc = `
      <div class="calc">
        <div><span>Купить на ${esc(sname(b.i))}</span><b>${rub(b.b)}</b></div>
        ${fb.dep ? `<div><span>+ пополнение ${String(fb.dep).replace('.', ',')}%</span><b>${rub(b.buy)}</b></div>` : ''}
        <div><span>Продать на ${esc(sname(b.j))} по ${rub(b.s)}, − ${String(f.sell).replace('.', ',')}%${f.out ? ` и вывод ${String(f.out).replace('.', ',')}%` : ''}</span><b>${rub(b.get)}</b></div>
        <div class="calc__total ${b.profit > 0 ? 'up' : 'down'}"><span>Выгода${SITE[sid(b.j)].cash ? '' : ' (в кошельке Steam)'}</span><b>${rub(b.profit, true)} · ${pct(b.pct)}</b></div>
      </div>`;
    const others = r.routes.filter((x) => x !== b).sort((x, y) => y.pct - x.pct).map((x) =>
      `<li>${esc(sname(x.i))} → ${esc(sname(x.j))}: <b class="${x.profit > 0 ? 'up' : 'down'}">${rub(x.profit, true)} (${pct(x.pct)})</b></li>`).join('');
    return `<div class="detail">${calc}<div class="sites">${sites}</div>
      ${others ? `<p class="detail__sub">Другие маршруты</p><ul class="alt">${others}</ul>` : ''}
      <p class="detail__note">Цены — минимальные лоты. Продаёте по цене самого дешёвого лота на площадке продажи; на практике нужно выставить чуть ниже.</p></div>`;
  }

  function renderList() {
    const rows = D.rows;
    const plus = rows.filter((r) => r.best.profit > 0).length;
    $('summary').innerHTML = rows.length ? `${num(rows.length)} предметов, из них в плюсе после комиссий — <b>${num(plus)}</b>` : '';
    $('list').innerHTML = rows.length
      ? rows.slice(0, D.shown).map((r, i) => rowHtml(r, i + 1)).join('')
      : `<div class="empty"><b>Ничего не нашлось</b>Попробуйте снизить минимальную цену или выбрать другой тип.</div>`;
    $('more').hidden = rows.length <= D.shown;
    if (!$('more').hidden) $('more').textContent = `Показать ещё (${num(Math.min(PAGE, rows.length - D.shown))} из ${num(rows.length - D.shown)})`;
  }

  // ---------- управление ----------
  function bind() {
    const fill = (el, opts, val) => { el.innerHTML = opts.map(([v, t]) => `<option value="${v}" ${String(v) === String(val) ? 'selected' : ''}>${t}</option>`).join(''); };
    const cats = new Set(D.items.map((x) => x[1]));
    fill($('cat'), Object.entries(CAT).filter(([k]) => k === 'all' || cats.has(k)), ui.cat);
    fill($('minp'), MIN_PRICE, ui.minp);
    fill($('mins'), MIN_SALES, ui.mins);
    $('sell').value = ui.sell;
    $('sort').value = ui.sort;

    let t;
    $('q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { ui.q = e.target.value; recompute(); }, 150); });
    $('cat').onchange = (e) => { ui.cat = e.target.value; store.set('cat', ui.cat); recompute(); };
    $('minp').onchange = (e) => { ui.minp = +e.target.value; store.set('minp', ui.minp); recompute(); };
    $('sell').onchange = (e) => { ui.sell = e.target.value; store.set('sell', ui.sell); recompute(); };
    $('sort').onchange = (e) => { ui.sort = e.target.value; store.set('sort2', ui.sort); recompute(); };
    $('mins').onchange = (e) => { ui.mins = +e.target.value; store.set('mins', ui.mins); recompute(); };
    let ft;
    $('feebox').addEventListener('input', (e) => {
      if (e.target.dataset.rate) {
        const v = parseFloat(String(e.target.value).replace(',', '.')) || 0;
        const def = D.sources.find((s) => s.id === 'lis')?.rate;
        ui.lisRate = v >= 50 && v <= 200 && v !== def ? v : 0;
        store.set('rate.lis', ui.lisRate);
        clearTimeout(ft); ft = setTimeout(recompute, 250);
        return;
      }
      const { site, k } = e.target.dataset; if (!site) return;
      const v = Math.min(50, Math.max(0, parseFloat(String(e.target.value).replace(',', '.')) || 0));
      ui.fees[site][k] = v;
      store.set('fee.' + site, ui.fees[site]);
      clearTimeout(ft); ft = setTimeout(() => { renderFeeSum(); recompute(); }, 250);
    });
    $('more').onclick = () => { D.shown += PAGE; renderList(); };
    $('list').onclick = (e) => {
      const b = e.target.closest('.row__main'); if (!b) return;
      const art = b.parentElement, idx = +art.dataset.idx;
      if (D.open.has(idx)) D.open.delete(idx); else D.open.add(idx);
      const r = D.rows.find((x) => x.idx === idx);
      const n = +art.querySelector('.row__n').textContent;
      art.outerHTML = rowHtml(r, n);
    };
  }
  function renderFeeSum() {
    $('feesum').textContent = '· ' + D.sources.filter((s) => SITE[s.id]?.sell).map((s) => `${s.name} ${String(ui.fees[s.id].sell).replace('.', ',')}%`).join(', ');
  }

  // ---------- загрузка ----------
  async function boot() {
    try {
      const [meta, data] = await Promise.all([getJSON('data/meta.json'), getJSON('data/items.json')]);
      Object.assign(D, { meta, sources: data.sources, items: data.items });
      renderStatus(); renderSources(); renderFees(); bind(); recompute();
      // картинки — после того как список уже виден
      getJSON('data/images.json').then((im) => { D.images = im; renderList(); }).catch(() => { /* без картинок */ });
    } catch (e) {
      console.error(e);
      $('list').innerHTML = '<div class="empty"><b>Цены ещё не собраны</b>Первый сбор занимает пару минут. Обновите страницу чуть позже.</div>';
      $('status').innerHTML = '<span class="dot old"></span>нет данных';
    }
  }
  boot();

  // новые цены или новая версия сайта: проверяем раз в 10 минут и при возврате в приложение
  async function poll() {
    if (document.hidden || !D.meta) return;
    try {
      const m = await getJSON('data/meta.json');
      if (BUILD && m.build && !m.build.startsWith(BUILD) && !location.search.includes('b=' + m.build.slice(0, 8))) {
        location.replace(location.pathname + '?b=' + m.build.slice(0, 8));
        return;
      }
      if (m.updatedAt !== D.meta.updatedAt) {
        const data = await getJSON('data/items.json');
        Object.assign(D, { meta: m, sources: data.sources, items: data.items, images: null });
        renderStatus(); renderSources(); recompute();
        getJSON('data/images.json').then((im) => { D.images = im; renderList(); }).catch(() => {});
      } else renderStatus();
    } catch { /* сеть */ }
  }
  setInterval(poll, 10 * 60000);
  document.addEventListener('visibilitychange', poll);
})();
