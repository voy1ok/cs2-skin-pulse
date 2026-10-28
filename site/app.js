/* CS2 Spread — клиентская часть (без сборки, чистый JS) */
(() => {
  'use strict';

  const CAT = {
    all: 'Все', knives: 'Ножи', gloves: 'Перчатки', rifles: 'Винтовки', pistols: 'Пистолеты', smgs: 'Пистолеты-пулемёты', heavy: 'Тяжёлое',
    stickers: 'Наклейки', cases: 'Кейсы и капсулы', agents: 'Агенты', charms: 'Брелоки', patches: 'Нашивки', graffiti: 'Граффити',
    music: 'Музыкальные наборы', keys: 'Ключи', collectibles: 'Значки', other: 'Другое',
  };
  const MIN_PRICE = [[0, 'любая'], [50, '$0.50'], [100, '$1'], [500, '$5'], [2000, '$20'], [10000, '$100'], [50000, '$500']];
  const MIN_SITES = [2, 3, 4, 5];
  const MIN_LOTS = 2;   // площадку с меньшим числом лотов не учитываем (если число известно)
  const OUTLIER = 2;    // цену дальше чем в 2 раза от медианы по площадкам считаем ошибкой
  const PAGE = 50;
  const BUILD = (document.currentScript?.src.match(/[?&]v=([^&]+)/) || [])[1] || null;

  const slugify = (h) => h.toLowerCase().replace(/[™★'’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const enc = encodeURIComponent;
  const LINK = {
    skinport: (h, s) => `https://skinport.com/item/${s || slugify(h)}`,
    waxpeer: (h) => `https://waxpeer.com/?game=csgo&search=${enc(h)}`,
    tm: (h) => `https://market.csgo.com/en/?search=${enc(h)}`,
    lis: (h, s) => `https://lis-skins.com/market/csgo/${s || slugify(h)}/`,
    buff: (h) => `https://buff.163.com/market/csgo#tab=selling&page_num=1&search=${enc(h)}`,
    csfloat: (h) => `https://csfloat.com/search?market_hash_name=${enc(h)}`,
    youpin: (h) => `https://www.youpin898.com/market/goods-list?listType=10&gameId=730&keyWords=${enc(h)}`,
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('cs2spread.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('cs2spread.' + k, JSON.stringify(v)); } catch { /* приватный режим */ } },
  };

  const D = { meta: null, sources: [], items: [], images: null, rows: [], shown: PAGE, open: new Set() };
  const ui = {
    q: '', cat: store.get('cat', 'all'), minp: store.get('minp', 100), mins: store.get('mins', 3), sort: store.get('sort', 'pct'),
    off: new Set(store.get('off', [])), cur: store.get('cur', 'RUB'),
  };

  const rate = () => D.meta?.rate?.usdRub || 0;
  const money = (c) => {
    if (!c) return '—';
    if (ui.cur === 'RUB' && rate()) {
      const r = (c / 100) * rate();
      const d = r < 100 ? 2 : 0;
      return r.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }) + ' ₽';
    }
    return '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const num = (n) => Number(n || 0).toLocaleString('ru-RU');
  const pct = (v) => (v >= 10 ? Math.round(v * 100) : Math.round(v * 1000) / 10) + '%';
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

  async function getJSON(url) {
    const r = await fetch(`${url}?v=${Math.floor(Date.now() / 60000)}`, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`${url} ${r.status}`);
    return r.json();
  }

  // ---------- расчёт ----------
  const median = (a) => { const b = [...a].sort((x, y) => x - y), n = b.length; return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2; };

  // цены площадок, которые идут в сравнение: включённые, с достаточным числом лотов, без выбросов
  function usable(it) {
    const [, , , p, q] = it;
    let v = p.map((c, i) => (c && !ui.off.has(D.sources[i].id) && (!q[i] || q[i] >= MIN_LOTS) ? c : 0));
    const vals = v.filter(Boolean);
    if (vals.length < 2) return null;
    const m = median(vals);
    v = v.map((c) => (c && c <= m * OUTLIER && c >= m / OUTLIER ? c : 0));
    return v;
  }

  function evaluate(it, idx) {
    const v = usable(it);
    if (!v) return null;
    const ok = v.filter(Boolean);
    if (ok.length < ui.mins) return null;
    const lo = Math.min(...ok), hi = Math.max(...ok);
    if (lo < ui.minp) return null;
    const loI = v.indexOf(lo), hiI = v.indexOf(hi);
    // мгновенная продажа: лучшая автопокупка на другой площадке против самого дешёвого лота
    let ord = 0, ordI = -1;
    if (it[5]) it[5].forEach((c, i) => { if (c && i !== loI && !ui.off.has(D.sources[i].id) && c > ord) { ord = c; ordI = i; } });
    return { idx, it, v, lo, hi, loI, hiI, n: ok.length, sp: (hi - lo) / lo, abs: hi - lo, ord, ordI, op: ord ? (ord - lo) / lo : -Infinity };
  }

  function recompute() {
    const q = ui.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const rows = [];
    D.items.forEach((it, i) => {
      if (ui.cat !== 'all' && it[1] !== ui.cat) return;
      if (q.length) { const h = it[0].toLowerCase(); if (!q.every((w) => h.includes(w))) return; }
      const r = evaluate(it, i);
      if (r && (ui.sort !== 'order' || r.ord)) rows.push(r);
    });
    const key = { pct: (r) => r.sp, abs: (r) => r.abs, order: (r) => r.op }[ui.sort];
    rows.sort((a, b) => key(b) - key(a) || b.lo - a.lo);
    D.rows = rows;
    D.shown = PAGE;
    renderList();
  }

  // ---------- отрисовка ----------
  function renderSources() {
    $('sources').innerHTML = D.sources.map((s) => `
      <span class="src ${s.error ? 'src--err' : ''}" title="${esc(s.error ? 'Не ответила: ' + s.error : `${num(s.count)} предметов`)}">
        <i class="${s.live ? 'live' : 'daily'}"></i>${esc(s.name)}<small>${s.error ? 'нет ответа' : s.live ? 'live' : 'раз в сутки'}</small>
      </span>`).join('');
    $('sitebox').innerHTML = '<span class="sitebox__label">Площадки:</span>' + D.sources.map((s) => `
      <label class="chk"><input type="checkbox" data-src="${s.id}" ${ui.off.has(s.id) ? '' : 'checked'} ${s.error ? 'disabled' : ''}>${esc(s.name)}</label>`).join('');
  }

  function renderStatus() {
    const m = D.meta;
    const fresh = m && Date.now() - m.updatedAt < 12 * 3600_000;
    $('status').innerHTML = `<span class="dot ${fresh ? '' : 'old'}"></span><span class="status__long">обновлено </span>${esc(ago(m?.updatedAt))}`;
    $('status').title = m ? `Цены обновляются раз в 10 часов. Последнее обновление: ${new Date(m.updatedAt).toLocaleString('ru-RU')}` : '';
    $('cur').textContent = ui.cur === 'RUB' ? '₽' : '$';
    $('cur').title = rate() ? `Курс ЦБ: 1 $ = ${rate().toFixed(2)} ₽` : 'Валюта';
  }

  function siteName(i) { return D.sources[i]?.name || ''; }

  function rowHtml(r, n) {
    const [h, cat, color] = r.it;
    const open = D.open.has(r.idx);
    const chip = ui.sort === 'order' ? `+${pct(r.op)}` : `+${pct(r.sp)}`;
    const sub = ui.sort === 'order'
      ? `купить ${esc(siteName(r.loI))} ${money(r.lo)} → автопокупка ${esc(siteName(r.ordI))} ${money(r.ord)}`
      : `${esc(siteName(r.loI))} ${money(r.lo)} → ${esc(siteName(r.hiI))} ${money(r.hi)}`;
    return `
      <article class="row ${open ? 'row--open' : ''}" data-idx="${r.idx}" style="--rc:${esc(color || '#5d6578')}">
        <button class="row__main" type="button" aria-expanded="${open}">
          <span class="row__n">${n}</span>
          <img src="${esc(img(r.idx, '128fx96f'))}" alt="" loading="lazy" width="64" height="48">
          <span class="row__name"><b>${esc(h)}</b><small>${esc(CAT[cat] || '')} · ${r.n} площадк${r.n < 5 ? 'и' : 'ок'}</small><small class="row__route">${sub}</small></span>
          <span class="row__diff"><span class="chip">${chip}</span><small>${ui.sort === 'order' ? money(r.ord - r.lo) : money(r.abs)}</small></span>
        </button>
        ${open ? detailHtml(r) : ''}
      </article>`;
  }

  function detailHtml(r) {
    const [h, , , p, q, o, slugs] = r.it;
    const order = p.map((c, i) => i).filter((i) => p[i]).sort((a, b) => p[a] - p[b]);
    const lines = order.map((i) => {
      const s = D.sources[i];
      const used = r.v[i] > 0;
      const cls = i === r.loI ? 'lo' : i === r.hiI ? 'hi' : used ? '' : 'off';
      const note = used ? '' : ui.off.has(s.id) ? 'площадка выключена' : q[i] && q[i] < MIN_LOTS ? 'мало лотов' : 'выброс, не учтён';
      return `<a class="site ${cls}" href="${esc(LINK[s.id](h, slugs?.[s.id]))}" target="_blank" rel="noopener">
          <span class="site__name">${esc(s.name)}${s.live ? '' : '<small>сводка за сутки</small>'}</span>
          <span class="site__lots">${q[i] ? num(q[i]) + ' лот.' : ''}${o && o[i] ? `<small>автопокупка ${money(o[i])}</small>` : ''}${note ? `<small>${note}</small>` : ''}</span>
          <span class="site__price">${money(p[i])}</span>
        </a>`;
    }).join('');
    return `<div class="detail">${lines}<p class="detail__note">Минимальная цена лота на каждой площадке. Ссылки ведут на страницу предмета или поиск по названию.</p></div>`;
  }

  function renderList() {
    const rows = D.rows;
    $('summary').innerHTML = rows.length
      ? `Найдено <b>${num(rows.length)}</b> предметов${ui.sort === 'order' ? ' с автопокупкой на другой площадке' : ''}`
      : '';
    $('list').innerHTML = rows.length
      ? rows.slice(0, D.shown).map((r, i) => rowHtml(r, i + 1)).join('')
      : `<div class="empty"><b>Ничего не нашлось</b>Попробуйте снизить минимальную цену или число площадок.</div>`;
    $('more').hidden = rows.length <= D.shown;
    if (!$('more').hidden) $('more').textContent = `Показать ещё (${num(Math.min(PAGE, rows.length - D.shown))} из ${num(rows.length - D.shown)})`;
  }

  // ---------- управление ----------
  function bind() {
    const fill = (el, opts, val) => { el.innerHTML = opts.map(([v, t]) => `<option value="${v}" ${String(v) === String(val) ? 'selected' : ''}>${t}</option>`).join(''); };
    const cats = new Set(D.items.map((x) => x[1]));
    fill($('cat'), Object.entries(CAT).filter(([k]) => k === 'all' || cats.has(k)), ui.cat);
    fill($('minp'), MIN_PRICE, ui.minp);
    fill($('mins'), MIN_SITES.map((n) => [n, String(n)]), ui.mins);
    $('sort').value = ui.sort;

    let t;
    $('q').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { ui.q = e.target.value; recompute(); }, 150); });
    $('cat').onchange = (e) => { ui.cat = e.target.value; store.set('cat', ui.cat); recompute(); };
    $('minp').onchange = (e) => { ui.minp = +e.target.value; store.set('minp', ui.minp); recompute(); };
    $('mins').onchange = (e) => { ui.mins = +e.target.value; store.set('mins', ui.mins); recompute(); };
    $('sort').onchange = (e) => { ui.sort = e.target.value; store.set('sort', ui.sort); recompute(); };
    $('sitebox').onchange = (e) => {
      const id = e.target.dataset.src; if (!id) return;
      if (e.target.checked) ui.off.delete(id); else ui.off.add(id);
      store.set('off', [...ui.off]); recompute();
    };
    $('more').onclick = () => { D.shown += PAGE; renderList(); };
    $('list').onclick = (e) => {
      const b = e.target.closest('.row__main'); if (!b) return;
      const art = b.parentElement, idx = +art.dataset.idx;
      if (D.open.has(idx)) D.open.delete(idx); else D.open.add(idx);
      const r = D.rows.find((x) => x.idx === idx);
      const n = +art.querySelector('.row__n').textContent;
      art.outerHTML = rowHtml(r, n);
    };
    $('cur').onclick = () => { ui.cur = ui.cur === 'RUB' ? 'USD' : 'RUB'; store.set('cur', ui.cur); renderStatus(); renderList(); };
  }

  // ---------- загрузка ----------
  async function boot() {
    try {
      const [meta, data] = await Promise.all([getJSON('data/meta.json'), getJSON('data/items.json')]);
      Object.assign(D, { meta, sources: data.sources, items: data.items });
      renderStatus(); renderSources(); bind(); recompute();
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
