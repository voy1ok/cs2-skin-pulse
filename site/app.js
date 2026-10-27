/* CS2 Skin Pulse — клиентская часть (без сборки, чистый JS) */
(() => {
  'use strict';

  const CAT = { pistols: 'Пистолеты', smgs: 'Пистолеты-пулемёты', rifles: 'Винтовки', heavy: 'Тяжёлое', knives: 'Ножи', gloves: 'Перчатки', equipment: 'Снаряжение', other: 'Другое' };
  const CAT_ORDER = ['knives', 'gloves', 'rifles', 'pistols', 'smgs', 'heavy', 'equipment', 'other'];
  const RARITY_RU = {
    rarity_common_weapon: 'Ширпотреб', rarity_uncommon_weapon: 'Промышленное', rarity_rare_weapon: 'Армейское',
    rarity_mythical_weapon: 'Запрещённое', rarity_legendary_weapon: 'Засекреченное', rarity_ancient_weapon: 'Тайное',
    rarity_ancient: 'Экстраординарное', rarity_contraband: 'Контрабанда',
  };
  const WEAR_S = ['FN', 'MW', 'FT', 'WW', 'BS'];
  const WEAR_L = ['Прямо с завода', 'Немного поношенное', 'После полевых', 'Поношенное', 'Закалённое в боях'];
  const FLAG = ['', 'StatTrak™', 'Souvenir'];
  const CRATE_TYPE = { Case: 'Кейсы', Souvenir: 'Сувенирные наборы', Other: 'Другое' };
  const FAST_TABS = [['1h', '1 час'], ['6h', '6 часов'], ['24h', '24 часа']];
  const LONG_TABS = [['30d', '30 дней'], ['7d', '7 дней'], ['90d', '90 дней']];
  const PAGE = 60;

  const $app = document.getElementById('app');
  const $status = document.getElementById('status');
  const $tip = document.getElementById('tip');
  const D = { cat: null, fast: null, long: null, meta: null, byId: new Map(), col: new Map(), crate: new Map(), op: new Map(), loadedAt: 0 };
  const ui = { fast: '1h', long: '30d', shown: PAGE };

  // ---------- helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => (c ? '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');
  const chCls = (v) => (v == null ? 'flat' : v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
  const chTxt = (v) => (v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(1) + '%');
  const num = (n) => Number(n || 0).toLocaleString('ru-RU');
  const rc = (r) => D.cat?.groups.rarities[r]?.color || '#888';
  const ago = (t) => {
    if (!t) return 'нет данных';
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'только что';
    if (m < 60) return `${m} мин назад`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} ч назад`;
    return `${Math.round(h / 24)} дн назад`;
  };
  const spanTxt = (min) => (min >= 1440 ? `${Math.round(min / 1440)} дн` : min >= 60 ? `${Math.round(min / 60)} ч` : `${min} мин`);
  const steamUrl = (h) => 'https://steamcommunity.com/market/listings/730/' + encodeURIComponent(h);
  const imgUrl = (u, size = '360fx360f') => (u && u.includes('/economy/image/') && !/\/\d+fx\d+f$/.test(u) ? `${u}/${size}` : u);
  const variantLabel = (h) => {
    const m = h.match(/\(([^)]+)\)$/);
    return m ? m[1] : '';
  };

  async function getJSON(url) {
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + 'v=' + Math.floor(Date.now() / 300000), { cache: 'no-cache' });
    if (!r.ok) throw new Error(url + ' ' + r.status);
    return r.json();
  }

  async function load() {
    const [cat, fast, long, meta] = await Promise.all(['data/catalog.json', 'data/top_fast.json', 'data/top_long.json', 'data/meta.json'].map(getJSON));
    Object.assign(D, { cat, fast, long, meta, loadedAt: Date.now() });
    D.byId = new Map(cat.skins.map((s) => [s.id, s]));
    D.col = new Map(cat.groups.collections.map((c) => [c.id, c]));
    D.crate = new Map(cat.groups.crates.map((c) => [c.id, c]));
    D.op = new Map(cat.groups.operations.map((o) => [o.id, o]));
    D.opOfCol = new Map();
    for (const o of cat.groups.operations) for (const c of o.col) D.opOfCol.set(c, o.id);
    renderStatus();
  }

  function renderStatus() {
    const m = D.meta;
    const fresh = m && Date.now() - m.updatedAt < 75 * 60000;
    $status.innerHTML = `<span class="dot ${fresh ? '' : 'old'}"></span><span>обновлено ${esc(ago(m?.updatedAt))} · ${num(m?.priced)} цен</span>`;
  }

  // ---------- router ----------
  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '') || 'top';
    const [p, q] = raw.split('?');
    const parts = p.split('/');
    return { route: parts[0] || 'top', arg: decodeURIComponent(parts[1] || ''), q: new URLSearchParams(q || '') };
  }
  const go = (h) => { location.hash = h; };

  function render() {
    const r = parseHash();
    document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.r === r.route));
    $tip.hidden = true;
    const view = { top: viewTop, catalog: viewCatalog, collections: viewCollections, cases: viewCases, operations: viewOperations, skin: viewSkin }[r.route] || viewTop;
    view(r);
  }

  // ---------- TOP ----------
  function topRows(items, kind) {
    if (!items?.length) return '';
    const [lead, ...rest] = items;
    const s = D.byId.get(lead.s);
    const leadHtml = `
      <a class="leader" style="--rc:${rc(lead.r)}" href="#/skin/${lead.s}?v=${encodeURIComponent(lead.h)}">
        <div class="leader__rank">№1 · ${kind === 'fast' ? 'БЫСТРЕЕ ВСЕХ' : 'ЛУЧШИЙ ХОЛД'}</div>
        <img src="${esc(imgUrl(lead.img))}" alt="" loading="lazy">
        <div style="flex:1;min-width:180px">
          <div class="leader__name">${esc(lead.h)}</div>
          <div class="muted" style="font-size:13px">${esc(CAT[lead.c] || '')}${s ? ' · ' + esc(RARITY_RU[s.r] || '') : ''}</div>
          <div class="leader__row" style="margin-top:10px">
            <span class="leader__ch up">${chTxt(lead.ch)}</span>
            <span class="leader__price">${money(lead.p)}</span>
          </div>
          <div class="leader__was">было ${money(lead.o)} · ${num(lead.l)} лотов</div>
        </div>
      </a>`;
    const rows = rest.map((x, i) => `
      <a class="row" href="#/skin/${x.s}?v=${encodeURIComponent(x.h)}">
        <span class="row__n">${i + 2}</span>
        <img src="${esc(imgUrl(x.img, '128fx96f'))}" alt="" loading="lazy">
        <span class="row__name"><b style="color:${x.r ? '' : ''}">${esc(x.h)}</b><small>${esc(CAT[x.c] || '')} · ${num(x.l)} лотов</small></span>
        <span class="row__p">${money(x.p)}<small>было ${money(x.o)}</small></span>
        <span class="chip-ch ${chCls(x.ch)}">${chTxt(x.ch)}</span>
      </a>`).join('');
    return `<div class="top-grid">${leadHtml}<div class="rows">${rows}</div></div>`;
  }

  function topPanel(kind) {
    const data = kind === 'fast' ? D.fast : D.long;
    const tabs = kind === 'fast' ? FAST_TABS : LONG_TABS;
    const cur = ui[kind];
    const w = data?.windows?.[cur];
    const f = D.meta?.filters?.[kind] || {};
    let note;
    if (kind === 'fast') note = `Пересчёт каждые 30 минут · обновлено ${ago(data?.updatedAt)}${w?.span ? ` · сравнение с ценой ${spanTxt(w.span)} назад` : ''}`;
    else note = `Пересчёт раз в сутки · обновлено ${ago(data?.updatedAt)}${w?.days ? ` · рост за ${w.days} дн (с ${w.from})` : ''}`;
    const body = w?.items?.length ? topRows(w.items, kind)
      : `<div class="empty"><b>История цен ещё накапливается</b>${kind === 'fast'
        ? 'Для этого окна нужно ещё несколько снимков цен. Сбор идёт каждые 30 минут.'
        : `Топ «долгий холд» появится после нескольких суток сбора (сейчас в истории ${D.meta?.days || 0} дн). Для окна в 30 дней нужен месяц данных, до этого берётся самый ранний доступный день.`}</div>`;
    return `
      <section class="panel" id="p-${kind}">
        <div class="panel__head">
          <h2>${kind === 'fast' ? '⚡ Быстрый топ' : '📈 Долгий холд'} <span class="badge ${kind === 'fast' ? 'live' : ''}">${kind === 'fast' ? 'live · 30 мин' : 'раз в день'}</span></h2>
          <div class="tabs" data-kind="${kind}">${tabs.map(([k, l]) => `<button data-k="${k}" class="${k === cur ? 'on' : ''}">${l}</button>`).join('')}</div>
          <div class="panel__note" style="width:100%">${esc(note)}. Фильтр ликвидности: цена от ${money(f.minPrice)}, от ${f.minListings} лотов на продаже.</div>
        </div>
        ${body}
      </section>`;
  }

  function viewTop() {
    const m = D.meta || {};
    const best24 = D.fast?.windows?.['24h']?.items?.[0];
    $app.innerHTML = `
      <section class="hero">
        <div>
          <h1>Пульс рынка <em>скинов CS2</em></h1>
          <p>Все скины по оружию, коллекциям, кейсам и операциям. Цены с торговой площадки Steam, быстрый топ растущих скинов каждые 30 минут и рейтинг для долгого холда раз в сутки.</p>
        </div>
        <div class="stats">
          <div class="stat"><b>${num(m.skins)}</b><span>скинов в базе</span></div>
          <div class="stat"><b>${num(m.priced)}</b><span>цен со Steam</span></div>
          <div class="stat"><b class="${best24 ? 'up' : ''}">${best24 ? chTxt(best24.ch) : '—'}</b><span>лидер роста за 24ч</span></div>
        </div>
      </section>
      <div id="top-fast">${topPanel('fast')}</div>
      <div id="top-long">${topPanel('long')}</div>`;
    viewTopBind();
  }
  function viewTopBind() { // перевешиваем обработчики после перерисовки панели
    $app.querySelectorAll('.tabs').forEach((t) => {
      if (t.dataset.bound) return; t.dataset.bound = 1;
      t.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        const kind = t.dataset.kind; ui[kind] = b.dataset.k;
        document.getElementById('top-' + kind).innerHTML = topPanel(kind);
        viewTopBind();
      });
    });
  }

  // ---------- CATALOG ----------
  const SORTS = { price_desc: 'Сначала дорогие', price_asc: 'Сначала дешёвые', ch24: 'Рост за 24ч', ch7: 'Рост за 7 дней', ch30: 'Рост за 30 дней', rarity: 'По редкости', name: 'По названию' };

  function filterSkins(q) {
    const text = (q.get('q') || '').toLowerCase().trim();
    const cat = q.get('cat'), weapon = q.get('weapon'), rar = q.get('rarity'), col = q.get('col'), crate = q.get('crate'), op = q.get('op');
    const opCols = op ? new Set(D.op.get(op)?.col || []) : null;
    const priced = q.get('priced') === '1';
    let list = D.cat.skins.filter((s) =>
      (!text || s.n.toLowerCase().includes(text)) && (!cat || s.c === cat) && (!weapon || s.w === weapon) && (!rar || s.r === rar)
      && (!col || s.col.includes(col)) && (!crate || s.cr.includes(crate)) && (!opCols || s.col.some((c) => opCols.has(c)))
      && (!priced || s.p > 0));
    const sort = q.get('sort') || 'price_desc';
    const rOrder = (s) => D.cat.groups.rarities[s.r]?.order ?? -1;
    const nz = (v) => (v == null ? -Infinity : v);
    const cmp = {
      price_desc: (a, b) => b.p - a.p, price_asc: (a, b) => (a.p || 1e12) - (b.p || 1e12),
      ch24: (a, b) => nz(b.ch24) - nz(a.ch24), ch7: (a, b) => nz(b.ch7) - nz(a.ch7), ch30: (a, b) => nz(b.ch30) - nz(a.ch30),
      rarity: (a, b) => rOrder(b) - rOrder(a) || b.p - a.p, name: (a, b) => a.n.localeCompare(b.n),
    }[sort] || ((a, b) => b.p - a.p);
    return list.sort(cmp);
  }

  function setQ(q, key, val) {
    const n = new URLSearchParams(q);
    if (val == null || val === '') n.delete(key); else n.set(key, val);
    if (key === 'cat') n.delete('weapon');
    ui.shown = PAGE;
    const s = n.toString();
    go('#/catalog' + (s ? '?' + s : ''));
  }

  function card(s) {
    const ch = s.ch24;
    return `<a class="card" style="--rc:${rc(s.r)}" href="#/skin/${s.id}">
      <span class="card__w">${s.star ? '★ ' : ''}${esc(s.w)}</span>
      <img src="${esc(imgUrl(s.img, '256fx192f'))}" alt="" loading="lazy">
      <span class="card__n">${esc(s.n.split(' | ')[1] || s.n)}</span>
      <span class="card__f"><b>${s.p ? 'от ' + money(s.p) : '—'}</b><small class="${chCls(ch)}">${ch == null ? '' : chTxt(ch)}</small></span>
    </a>`;
  }

  function viewCatalog(r) {
    const q = r.q;
    const list = filterSkins(q);
    const cat = q.get('cat');
    const weapons = [...new Set(D.cat.skins.filter((s) => !cat || s.c === cat).map((s) => s.w))].sort();
    const rar = Object.entries(D.cat.groups.rarities).sort((a, b) => a[1].order - b[1].order);
    const cols = [...D.cat.groups.collections].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const crates = [...D.cat.groups.crates].filter((c) => c.type === 'Case').sort((a, b) => a.name.localeCompare(b.name));
    const ops = D.cat.groups.operations;
    const crumbs = [];
    if (q.get('col')) crumbs.push(['col', 'Коллекция: ' + (D.col.get(q.get('col'))?.name || '')]);
    if (q.get('crate')) crumbs.push(['crate', 'Кейс: ' + (D.crate.get(q.get('crate'))?.name || '')]);
    if (q.get('op')) crumbs.push(['op', 'Операция: ' + (D.op.get(q.get('op'))?.name || '')]);
    if (q.get('weapon')) crumbs.push(['weapon', q.get('weapon')]);
    if (q.get('rarity')) crumbs.push(['rarity', RARITY_RU[q.get('rarity')] || '']);
    const title = q.get('col') ? D.col.get(q.get('col'))?.name : q.get('crate') ? D.crate.get(q.get('crate'))?.name
      : q.get('op') ? D.op.get(q.get('op'))?.name : q.get('weapon') || (cat ? CAT[cat] : 'Все скины');
    const sel = (key, items, ph) => `<select class="sel" data-key="${key}"><option value="">${ph}</option>${items.map(([v, l]) => `<option value="${esc(v)}" ${q.get(key) === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

    $app.innerHTML = `
      <div class="cat-layout">
        <aside class="filters">
          <input class="search" type="search" placeholder="Поиск: AK-47, Asiimov…" value="${esc(q.get('q') || '')}" id="q">
          <div><h4>Тип оружия</h4><div class="chips">
            <button class="chip ${!cat ? 'on' : ''}" data-key="cat" data-val="">Все</button>
            ${CAT_ORDER.filter((c) => D.cat.skins.some((s) => s.c === c)).map((c) => `<button class="chip ${cat === c ? 'on' : ''}" data-key="cat" data-val="${c}">${CAT[c]}</button>`).join('')}
          </div></div>
          <div><h4>Оружие</h4>${sel('weapon', weapons.map((w) => [w, w]), 'Любое оружие')}</div>
          <div><h4>Редкость</h4><div class="chips">
            ${rar.map(([id, x]) => `<button class="chip ${q.get('rarity') === id ? 'on' : ''}" data-key="rarity" data-val="${q.get('rarity') === id ? '' : id}"><i style="background:${x.color}"></i>${esc(RARITY_RU[id] || x.name)}</button>`).join('')}
          </div></div>
          <div><h4>Коллекция</h4>${sel('col', cols.map((c) => [c.id, c.name]), 'Любая коллекция')}</div>
          <div><h4>Кейс</h4>${sel('crate', crates.map((c) => [c.id, c.name]), 'Любой кейс')}</div>
          <div><h4>Операция</h4>${sel('op', ops.map((o) => [o.id, `${o.name} (${o.year})`]), 'Любая операция')}</div>
          <label class="muted" style="font-size:14px;display:flex;gap:8px;align-items:center"><input type="checkbox" id="priced" ${q.get('priced') === '1' ? 'checked' : ''}> Только с ценой</label>
          <button class="reset" id="reset">Сбросить фильтры</button>
        </aside>
        <section>
          <div class="cat-head">
            <h1>${esc(title)}</h1><span class="muted">${num(list.length)} скинов</span>
            ${`<select class="sel" data-key="sort">${Object.entries(SORTS).map(([k, l]) => `<option value="${k}" ${(q.get('sort') || 'price_desc') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`}
          </div>
          ${crumbs.length ? `<div class="crumbs">${crumbs.map(([k, l]) => `<span class="crumb">${esc(l)}<button data-key="${k}" data-val="">×</button></span>`).join('')}</div>` : ''}
          ${list.length ? `<div class="grid" id="grid">${list.slice(0, ui.shown).map(card).join('')}</div>` : '<div class="empty"><b>Ничего не найдено</b>Попробуйте ослабить фильтры.</div>'}
          ${list.length > ui.shown ? `<button class="more" id="more">Показать ещё (${num(list.length - ui.shown)})</button>` : ''}
        </section>
      </div>`;

    $app.querySelectorAll('[data-key]').forEach((el) => {
      if (el.tagName === 'SELECT') el.addEventListener('change', () => setQ(q, el.dataset.key, el.value));
      else el.addEventListener('click', () => setQ(q, el.dataset.key, el.dataset.val));
    });
    let t;
    const qi = document.getElementById('q');
    qi.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => setQ(q, 'q', qi.value), 300); });
    if (q.get('q')) { qi.focus(); qi.setSelectionRange(qi.value.length, qi.value.length); }
    document.getElementById('priced').addEventListener('change', (e) => setQ(q, 'priced', e.target.checked ? '1' : ''));
    document.getElementById('reset').addEventListener('click', () => { ui.shown = PAGE; go('#/catalog'); });
    const more = document.getElementById('more');
    if (more) more.addEventListener('click', () => {
      const grid = document.getElementById('grid');
      grid.insertAdjacentHTML('beforeend', list.slice(ui.shown, ui.shown + PAGE).map(card).join(''));
      ui.shown += PAGE;
      if (ui.shown >= list.length) more.remove(); else more.textContent = `Показать ещё (${num(list.length - ui.shown)})`;
    });
  }

  // ---------- GROUPS ----------
  const groupStats = (pred) => {
    let n = 0, sum = 0, ch = [], top = null;
    for (const s of D.cat.skins) if (pred(s)) {
      n++; if (s.p) sum += s.p; if (s.ch24 != null) ch.push(s.ch24);
      if (s.p && (!top || s.p > top.p)) top = s;
    }
    const avg = ch.length ? ch.reduce((a, b) => a + b, 0) / ch.length : null;
    return { n, sum, avg, top };
  };
  const gcard = (href, img, name, sub, avg) => `
    <a class="gcard" href="${href}"><img src="${esc(imgUrl(img, '128fx128f'))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
      <span><b>${esc(name)}</b><small>${sub}${avg != null ? ` · <span class="${chCls(avg)}">${chTxt(avg)} 24ч</span>` : ''}</small></span></a>`;

  function viewCollections() {
    const cols = [...D.cat.groups.collections].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const byYear = new Map();
    for (const c of cols) { const y = (c.date || '????').slice(0, 4); if (!byYear.has(y)) byYear.set(y, []); byYear.get(y).push(c); }
    $app.innerHTML = `<h1 class="page-h">Коллекции</h1><p class="page-sub">${cols.length} коллекций, от новых к старым. Средний рост — по самым дешёвым вариантам скинов за 24 часа.</p>
      ${[...byYear].map(([y, list]) => `<div class="gsec">${y}</div><div class="ggrid">${list.map((c) => {
        const st = groupStats((s) => s.col.includes(c.id));
        const op = D.opOfCol.get(c.id);
        return gcard(`#/catalog?col=${c.id}`, c.img, c.name, `${st.n} скинов${op ? ' · ' + esc(D.op.get(op).name) : ''}`, st.avg);
      }).join('')}</div>`).join('')}`;
  }

  function viewCases() {
    const groups = new Map();
    for (const c of D.cat.groups.crates) { const t = CRATE_TYPE[c.type] ? c.type : 'Other'; if (!groups.has(t)) groups.set(t, []); groups.get(t).push(c); }
    $app.innerHTML = `<h1 class="page-h">Кейсы и наборы</h1><p class="page-sub">Скины, которые выпадают из кейсов и сувенирных наборов.</p>
      ${['Case', 'Souvenir', 'Other'].filter((t) => groups.has(t)).map((t) => `<div class="gsec">${CRATE_TYPE[t]} · ${groups.get(t).length}</div><div class="ggrid">${groups.get(t)
        .sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.name.localeCompare(b.name))
        .map((c) => { const st = groupStats((s) => s.cr.includes(c.id)); return gcard(`#/catalog?crate=${c.id}`, c.img, c.name, `${st.n} скинов`, st.avg); }).join('')}</div>`).join('')}`;
  }

  function viewOperations() {
    const ops = [...D.cat.groups.operations].sort((a, b) => b.year - a.year);
    $app.innerHTML = `<h1 class="page-h">Операции</h1><p class="page-sub">Коллекции, вышедшие в рамках операций CS:GO / CS2.</p>
      ${ops.map((o) => {
        const set = new Set(o.col);
        const st = groupStats((s) => s.col.some((c) => set.has(c)));
        return `<div class="op"><div class="op__h"><h3>${esc(o.name)}</h3><span class="muted">${o.year} · ${st.n} скинов${st.avg != null ? ` · <span class="${chCls(st.avg)}">${chTxt(st.avg)} 24ч</span>` : ''}</span><a href="#/catalog?op=${o.id}">Все скины →</a></div>
          <div class="ggrid">${o.col.map((id) => D.col.get(id)).filter(Boolean).map((c) => { const s2 = groupStats((s) => s.col.includes(c.id)); return gcard(`#/catalog?col=${c.id}`, c.img, c.name, `${s2.n} скинов`, s2.avg); }).join('')}</div></div>`;
      }).join('')}`;
  }

  // ---------- SKIN ----------
  async function viewSkin(r) {
    const s = D.byId.get(r.arg);
    if (!s) { $app.innerHTML = '<div class="empty"><b>Скин не найден</b><a href="#/catalog">В каталог</a></div>'; return; }
    const rar = D.cat.groups.rarities[s.r];
    const vs = s.v;
    let selected = r.q.get('v') || (vs.find((v) => v[3] && v[2] === 0) || vs.find((v) => v[3]) || vs[0])[0];
    const links = [
      `<a class="tag" href="#/catalog?cat=${s.c}">${esc(CAT[s.c])}</a>`,
      `<a class="tag" href="#/catalog?weapon=${encodeURIComponent(s.w)}">${esc(s.w)}</a>`,
      `<a class="tag rare" href="#/catalog?rarity=${s.r}">${esc(RARITY_RU[s.r] || rar?.name || '')}</a>`,
      ...s.col.map((id) => D.col.get(id)).filter(Boolean).map((c) => `<a class="tag" href="#/catalog?col=${c.id}">${esc(c.name)}</a>`),
      ...s.col.map((id) => D.opOfCol.get(id)).filter(Boolean).map((id) => `<a class="tag" href="#/catalog?op=${id}">${esc(D.op.get(id).name)}</a>`),
      ...s.cr.map((id) => D.crate.get(id)).filter(Boolean).map((c) => `<a class="tag" href="#/catalog?crate=${c.id}">${esc(c.name)}</a>`),
    ];
    const fl = s.fl?.[0] != null ? `<span class="tag">float ${s.fl[0]}–${s.fl[1]}</span>` : '';
    $app.innerHTML = `
      <a class="back" onclick="history.length > 1 ? history.back() : (location.hash = '#/catalog')">← Назад</a>
      <div class="skin" style="--rc:${rar?.color || '#888'}">
        <div class="skin__pic"><img src="${esc(imgUrl(s.img, '512fx384f'))}" alt="${esc(s.n)}"></div>
        <div>
          <h1>${s.star ? '★ ' : ''}${esc(s.n)}</h1>
          <div class="tags">${links.join('')}${fl}</div>
          <table class="vt"><thead><tr><th>Вариант</th><th>Цена</th><th>24ч</th><th>7д</th><th>30д</th><th>Лотов</th><th></th></tr></thead><tbody>
            ${vs.map(([h, w, f, p, l, c24, c7, c30]) => `<tr data-h="${esc(h)}" class="${h === selected ? 'on' : ''}">
              <td>${f ? `<span class="${f === 1 ? 'st' : 'sv'}">${FLAG[f]}</span> ` : ''}${w >= 0 ? `<span title="${WEAR_L[w]}">${WEAR_S[w]}</span>` : 'Vanilla'}</td>
              <td>${money(p)}</td><td class="${chCls(c24)}">${chTxt(c24)}</td><td class="${chCls(c7)}">${chTxt(c7)}</td><td class="${chCls(c30)}">${chTxt(c30)}</td>
              <td>${num(l)}</td><td><a href="${steamUrl(h)}" target="_blank" rel="noopener">Steam ↗</a></td></tr>`).join('')}
          </tbody></table>
          <div class="chart-box">
            <div class="panel__head"><h3 id="ch-title">${esc(selected)}</h3>
              <div class="tabs" id="ch-tabs"><button data-k="i" class="on">30 часов</button><button data-k="d">По дням</button></div></div>
            <div id="chart"><div class="loader">Загружаем историю…</div></div>
          </div>
        </div>
      </div>`;

    let hist = null, mode = 'i';
    const draw = () => {
      const el = document.getElementById('chart');
      if (!el) return;
      document.getElementById('ch-title').textContent = selected;
      const v = hist?.v?.[selected];
      const pts = mode === 'i' ? (v?.i || []).map(([t, c]) => [t * 60000, c]) : (v?.d || []).map(([d, c]) => [Date.parse(d), c]);
      el.innerHTML = pts.length >= 2 ? chart(pts, mode) : '<div class="empty"><b>Недостаточно истории</b>Цены собираются каждые 30 минут — график появится после нескольких снимков.</div>';
      bindChart(el, pts, mode);
    };
    $app.querySelectorAll('.vt tbody tr').forEach((tr) => tr.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      selected = tr.dataset.h;
      $app.querySelectorAll('.vt tbody tr').forEach((x) => x.classList.toggle('on', x === tr));
      history.replaceState(null, '', `#/skin/${s.id}?v=${encodeURIComponent(selected)}`);
      draw();
    }));
    document.getElementById('ch-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      mode = b.dataset.k;
      document.querySelectorAll('#ch-tabs button').forEach((x) => x.classList.toggle('on', x === b));
      draw();
    });
    try { hist = await getJSON(`data/history/${s.id}.json`); } catch { hist = null; }
    draw();
  }

  function chart(pts, mode) {
    const W = 760, Hh = 260, pl = 58, pr = 12, pt = 14, pb = 28;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    let y0 = Math.min(...ys), y1 = Math.max(...ys);
    const pad = (y1 - y0) * 0.12 || y1 * 0.05 || 1; y0 = Math.max(0, y0 - pad); y1 += pad;
    const X = (x) => pl + ((x - x0) / (x1 - x0 || 1)) * (W - pl - pr);
    const Y = (y) => pt + (1 - (y - y0) / (y1 - y0 || 1)) * (Hh - pt - pb);
    const up = ys[ys.length - 1] >= ys[0];
    const col = up ? 'var(--up)' : 'var(--down)';
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('');
    const area = `${line}L${X(x1).toFixed(1)},${Hh - pb}L${X(x0).toFixed(1)},${Hh - pb}Z`;
    const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => { const v = y0 + (y1 - y0) * f; const y = Y(v); return `<line x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}"/><text x="${pl - 8}" y="${y + 4}" text-anchor="end">${money(Math.round(v))}</text>`; }).join('');
    const fmt = (t) => { const d = new Date(t); return mode === 'i' ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }); };
    const xt = [0, 0.33, 0.66, 1].map((f) => { const t = x0 + (x1 - x0) * f; return `<text x="${X(t)}" y="${Hh - 8}" text-anchor="${f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}">${fmt(t)}</text>`; }).join('');
    return `<svg class="chart" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none">
      <defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${up ? '#2fd47a' : '#ff5468'}" stop-opacity=".28"/><stop offset="1" stop-color="${up ? '#2fd47a' : '#ff5468'}" stop-opacity="0"/></linearGradient></defs>
      <g class="grid">${grid}</g>${xt}
      <path d="${area}" fill="url(#ga)"/><path d="${line}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/>
      <line id="cx" y1="${pt}" y2="${Hh - pb}" stroke="var(--muted)" stroke-dasharray="3 3" opacity="0"/>
      <circle id="cd" r="4" fill="${col}" opacity="0"/>
      <rect x="${pl}" y="0" width="${W - pl - pr}" height="${Hh}" fill="transparent" id="ch-hit"/>
    </svg>`;
  }

  function bindChart(el, pts, mode) {
    const svg = el.querySelector('svg'); if (!svg) return;
    const hit = svg.querySelector('#ch-hit'), cx = svg.querySelector('#cx'), cd = svg.querySelector('#cd');
    const W = 760, pl = 58, pr = 12, Hh = 260, pt = 14, pb = 28;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    let y0 = Math.min(...ys), y1 = Math.max(...ys);
    const pad = (y1 - y0) * 0.12 || y1 * 0.05 || 1; y0 = Math.max(0, y0 - pad); y1 += pad;
    const X = (x) => pl + ((x - x0) / (x1 - x0 || 1)) * (W - pl - pr);
    const Y = (y) => pt + (1 - (y - y0) / (y1 - y0 || 1)) * (Hh - pt - pb);
    hit.addEventListener('mousemove', (e) => {
      const b = svg.getBoundingClientRect();
      const vx = ((e.clientX - b.left) / b.width) * W;
      let best = pts[0];
      for (const p of pts) if (Math.abs(X(p[0]) - vx) < Math.abs(X(best[0]) - vx)) best = p;
      cx.setAttribute('x1', X(best[0])); cx.setAttribute('x2', X(best[0])); cx.setAttribute('opacity', 1);
      cd.setAttribute('cx', X(best[0])); cd.setAttribute('cy', Y(best[1])); cd.setAttribute('opacity', 1);
      const d = new Date(best[0]);
      $tip.textContent = `${money(best[1])} · ${mode === 'i' ? d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('ru-RU')}`;
      $tip.hidden = false; $tip.style.left = e.clientX + 12 + 'px'; $tip.style.top = e.clientY - 34 + 'px';
    });
    hit.addEventListener('mouseleave', () => { $tip.hidden = true; cx.setAttribute('opacity', 0); cd.setAttribute('opacity', 0); });
  }

  // ---------- boot ----------
  window.addEventListener('hashchange', () => { render(); if (!location.hash.startsWith('#/skin')) window.scrollTo(0, 0); });
  load().then(render).catch((e) => {
    console.error(e);
    $app.innerHTML = `<div class="empty"><b>Данные ещё не собраны</b>Первый сбор цен запускается автоматически и занимает 10–20 минут. Обновите страницу чуть позже.</div>`;
    $status.innerHTML = '<span class="dot old"></span><span>нет данных</span>';
  });
  // автообновление: раз в 5 минут проверяем свежие данные
  setInterval(async () => {
    try {
      const m = await getJSON('data/meta.json');
      if (m.updatedAt !== D.meta?.updatedAt) {
        await load();
        const r = parseHash();
        if (r.route === 'top' || r.route === '') render();
      } else renderStatus();
    } catch { /* сеть */ }
  }, 5 * 60000);
})();
