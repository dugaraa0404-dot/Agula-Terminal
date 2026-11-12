/* ============================================================================
   Agula Terminal — market screens: WEI · GLCO · CRYP · IMAP · MOST · EVTS · CORR
   ========================================================================== */
'use strict';

(() => {
  const { panel, kv, $, $$ } = APP;
  const esc = U.esc;
  const idOf = s => s.replace(/[^A-Za-z0-9]/g, '_');
  const errBox = e => `<div class="empty err">${esc(e.message || e)}</div>`;
  const pctCell = (v, d = 1) => `<td class="r ${U.cls(v)}">${U.fmtPct(v, d)}</td>`;

  // exchange sessions (local time) for the open/closed dot
  const SESS = {
    NY: ['America/New_York', 570, 960], TOR: ['America/Toronto', 570, 960], SAO: ['America/Sao_Paulo', 600, 1020], MEX: ['America/Mexico_City', 510, 900], BUE: ['America/Argentina/Buenos_Aires', 660, 1020],
    LDN: ['Europe/London', 480, 990], FRA: ['Europe/Berlin', 540, 1050], PAR: ['Europe/Paris', 540, 1050], MAD: ['Europe/Madrid', 540, 1050], MIL: ['Europe/Rome', 540, 1050], AMS: ['Europe/Amsterdam', 540, 1050],
    ZRH: ['Europe/Zurich', 540, 1050], IST: ['Europe/Istanbul', 600, 1080], TKY: ['Asia/Tokyo', 540, 930], HKG: ['Asia/Hong_Kong', 570, 960], SHA: ['Asia/Shanghai', 570, 900], SEL: ['Asia/Seoul', 540, 930],
    TPE: ['Asia/Taipei', 540, 810], SYD: ['Australia/Sydney', 600, 960], BOM: ['Asia/Kolkata', 555, 930], SIN: ['Asia/Singapore', 540, 1020], JKT: ['Asia/Jakarta', 540, 960],
  };
  function sessionState(code) {
    const s = SESS[code]; if (!s) return { open: true, label: '24H' };
    const now = new Date(), day = now.toLocaleString('en-US', { weekday: 'short', timeZone: s[0] });
    const hm = now.toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: s[0] }), [h, m] = hm.split(':').map(Number), mins = h * 60 + m;
    const open = !['Sat', 'Sun'].includes(day) && mins >= s[1] && mins < s[2];
    return { open, label: hm, tz: s[0] };
  }

  // ======================================================================== monitor factory (WEI, GLCO, CRYP)
  function monitor(code, title, groups, opt = {}) {
    const all = groups.flatMap(g => g.rows.map(r => r[0]));
    let perf = {}, timers = [];
    const unitOf = s => (groups.flatMap(g => g.rows).find(r => r[0] === s) || [])[2] || '';
    const sessOf = s => (groups.flatMap(g => g.rows).find(r => r[0] === s) || [])[1];
    function rowHTML(s) {
      return `<tr class="clk" data-s="${esc(s)}"><td class="key">${esc(opt.short ? opt.short(s) : s)}</td><td class="wrap">${esc(HUB.meta(s).name)}${unitOf(s) && !SESS[unitOf(s)] ? ` <span class="muted small">${esc(unitOf(s))}</span>` : ''}</td>
        <td class="r" id="${code}-l-${idOf(s)}">—</td><td class="r" id="${code}-n-${idOf(s)}">—</td><td class="r" id="${code}-p-${idOf(s)}">—</td>
        <td class="r" id="${code}-w-${idOf(s)}">—</td><td class="r" id="${code}-m-${idOf(s)}">—</td><td class="r" id="${code}-y-${idOf(s)}">—</td><td class="r" id="${code}-a-${idOf(s)}">—</td>
        <td class="rng" id="${code}-r-${idOf(s)}"></td><td class="sp"><canvas class="spk" id="${code}-s-${idOf(s)}"></canvas></td><td class="r small" id="${code}-t-${idOf(s)}">—</td></tr>`;
    }
    const last = new Map();
    function upd(s) {
      const q = HUB.quote(s), g = id => document.getElementById(`${code}-${id}-${idOf(s)}`); if (!g('l')) return;
      if (q) {
        const prev = last.get(s);
        g('l').textContent = U.fmtPx(q.last); g('n').textContent = U.fmtSigned(q.chg, U.decimalsFor(q.last)); g('n').className = 'r ' + U.cls(q.chg);
        g('p').textContent = U.fmtPct(q.chgPct); g('p').className = 'r ' + U.cls(q.chg);
        if (prev != null && prev !== q.last) U.flash(g('l'), q.last > prev);
        last.set(s, q.last);
        const ss = sessionState(sessOf(s));
        g('t').innerHTML = `<span class="sess ${ss.open ? 'on' : ''}" title="${ss.tz ? 'Local time ' + ss.label + (ss.open ? ', session open' : ', closed') : 'Trades around the clock'}">●</span> ${q.t ? new Date(q.t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''}`;
      }
      const p = perf[s];
      if (p) {
        [['w', p.w1], ['m', p.m1], ['y', p.ytd], ['a', p.y1]].forEach(([k, v]) => { g(k).textContent = U.fmtPct(v, 1); g(k).className = 'r ' + U.cls(v); });
        const px = q ? q.last : p.last, pos = p.hi52 > p.lo52 ? U.clamp((px - p.lo52) / (p.hi52 - p.lo52), 0, 1) : 0.5;
        g('r').innerHTML = `<div class="rngbar" title="52-week range ${U.fmtPx(p.lo52)} – ${U.fmtPx(p.hi52)}"><span style="left:${(pos * 100).toFixed(1)}%"></span></div>`;
      }
    }
    function summary() {
      const el = $(`#${code}Sum`); if (!el) return;
      el.innerHTML = groups.map(gr => {
        const ch = gr.rows.map(r => HUB.quote(r[0])?.chgPct).filter(U.isNum), avg = ch.length ? U.mean(ch) : null, up = ch.filter(x => x > 0).length;
        return `<div class="sumc"><b>${esc(gr.name)}</b><span class="${U.cls(avg)}">${U.fmtPct(avg)}</span><em>${up}/${ch.length} up</em></div>`;
      }).join('');
    }
    APP.register(code, {
      title, global: true,
      async render(root) {
        root.innerHTML = `<div class="sumstrip" id="${code}Sum"></div>
          ${groups.map(gr => panel(gr.name, `<div class="tblwrap"><table class="tbl mon"><thead><tr><th>Ticker</th><th>Name</th><th class="r">Last</th><th class="r">Net chg</th><th class="r">% chg</th><th class="r">1W</th><th class="r">1M</th><th class="r">YTD</th><th class="r">1Y</th><th>52-week range</th><th>Today</th><th class="r">Time</th></tr></thead><tbody>${gr.rows.map(r => rowHTML(r[0])).join('')}</tbody></table></div>`, { badge: gr.badge })).join('')}
          <p class="src-note">${esc(opt.note || 'Quotes: Yahoo Finance, delayed up to 15–20 minutes on some exchanges. ● = local session open. Click a row for the security overview.')}</p>`;
        root.addEventListener('click', e => { const t = e.target.closest('[data-s]'); if (t) APP.open('DES', t.dataset.s); });
        HUB.track('screen', all); HUB.ensureMeta(all);
        all.forEach(upd); summary();
        const sparks = () => HUB.sparks(all).then(sp => Object.entries(sp).forEach(([s, d]) => { const el = document.getElementById(`${code}-s-${idOf(s)}`); if (el) CK.spark(el, d); })).catch(() => {});
        sparks();
        HUB.perf(all).then(p => { perf = p || {}; all.forEach(upd); }).catch(e => APP.toast('Performance columns: ' + e.message, 'err'));
        timers.forEach(clearInterval); timers = [setInterval(sparks, 90e3), setInterval(() => all.forEach(upd), 30e3)];
      },
      onTick(syms) { syms.forEach(upd); summary(); },
      destroy() { timers.forEach(clearInterval); timers = []; },
    });
  }

  monitor('WEI', 'World Equity Indices', [
    { name: 'Americas', rows: [['^GSPC', 'NY'], ['^DJI', 'NY'], ['^IXIC', 'NY'], ['^RUT', 'NY'], ['^VIX', 'NY'], ['^GSPTSE', 'TOR'], ['^BVSP', 'SAO'], ['^MXX', 'MEX'], ['^MERV', 'BUE']] },
    { name: 'Europe, Middle East & Africa', rows: [['^STOXX50E', 'FRA'], ['^FTSE', 'LDN'], ['^GDAXI', 'FRA'], ['^FCHI', 'PAR'], ['^IBEX', 'MAD'], ['FTSEMIB.MI', 'MIL'], ['^AEX', 'AMS'], ['^SSMI', 'ZRH'], ['XU100.IS', 'IST']] },
    { name: 'Asia Pacific', rows: [['^N225', 'TKY'], ['^HSI', 'HKG'], ['000001.SS', 'SHA'], ['399001.SZ', 'SHA'], ['^KS11', 'SEL'], ['^TWII', 'TPE'], ['^AXJO', 'SYD'], ['^NSEI', 'BOM'], ['^BSESN', 'BOM'], ['^STI', 'SIN'], ['^JKSE', 'JKT']] },
  ]);
  monitor('GLCO', 'Commodities Monitor', [
    { name: 'Energy', rows: [['CL=F', null, '$/bbl'], ['BZ=F', null, '$/bbl'], ['NG=F', null, '$/MMBtu'], ['RB=F', null, '$/gal'], ['HO=F', null, '$/gal']] },
    { name: 'Metals', rows: [['GC=F', null, '$/oz'], ['SI=F', null, '$/oz'], ['PL=F', null, '$/oz'], ['PA=F', null, '$/oz'], ['HG=F', null, '$/lb']] },
    { name: 'Agriculture', rows: [['ZC=F', null, '¢/bu'], ['ZW=F', null, '¢/bu'], ['ZS=F', null, '¢/bu'], ['KC=F', null, '¢/lb'], ['SB=F', null, '¢/lb'], ['CC=F', null, '$/t'], ['CT=F', null, '¢/lb']] },
    { name: 'Livestock', rows: [['LE=F', null, '¢/lb'], ['HE=F', null, '¢/lb']] },
  ], { note: 'Front-month futures from Yahoo Finance (delayed). Futures roll monthly, so long-period changes include roll effects. Click a row for the security overview.', short: s => s.replace('=F', '') });
  monitor('CRYP', 'Crypto Monitor', [
    { name: 'Large caps', rows: [['BTC-USD'], ['ETH-USD'], ['SOL-USD'], ['XRP-USD'], ['BNB-USD'], ['DOGE-USD']] },
    { name: 'Alt coins', rows: [['ADA-USD'], ['AVAX-USD'], ['LINK-USD'], ['DOT-USD'], ['TRX-USD'], ['LTC-USD']] },
  ], { note: 'Crypto trades 24/7; "today" is the UTC day. Prices: Yahoo Finance (CoinMarketCap feed). Click a row for the overview with the Binance order book.', short: s => s.replace('-USD', '') });

  // ======================================================================== IMAP — sector heatmap
  const PERIODS = [['1D', 'chg', 0.03], ['1W', 'w1', 0.06], ['1M', 'm1', 0.1], ['3M', 'm3', 0.18], ['YTD', 'ytd', 0.3], ['1Y', 'y1', 0.4]];
  APP.register('IMAP', {
    title: 'Equity Heatmap by Sector', global: true,
    async render(root) {
      this.period = U.store.get('imapP', '1D'); this.size = U.store.get('imapS', 'cap');
      root.innerHTML = `<div class="toolbar"><div class="seg" id="imP">${PERIODS.map(p => `<button data-p="${p[0]}" class="${p[0] === this.period ? 'on' : ''}">${p[0]}</button>`).join('')}</div>
          <div class="seg" id="imS"><button data-s="cap" class="${this.size === 'cap' ? 'on' : ''}">Size: market cap</button><button data-s="eq" class="${this.size === 'eq' ? 'on' : ''}">Equal size</button></div>
          <span class="muted small" id="imNote">Loading 65 US large caps…</span></div>
        <div class="grid imapgrid">
          ${panel('S&amp;P large caps by sector', '<div class="cv imap"><canvas id="imTree"></canvas></div><div class="legend" id="imLeg"></div>')}
          ${panel('Sectors', '<div id="imSect"><div class="muted small">Loading…</div></div>')}
        </div>`;
      $('#imP').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; this.period = b.dataset.p; U.store.set('imapP', this.period); $$('#imP button').forEach(x => x.classList.toggle('on', x === b)); this.draw(); });
      $('#imS').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; this.size = b.dataset.s; U.store.set('imapS', this.size); $$('#imS button').forEach(x => x.classList.toggle('on', x === b)); this.draw(); });
      try {
        const u = await HUB.universe(); this.u = u.rows; window.AGULA_UNIVERSE = u.rows;
        HUB.track('screen', this.u.map(r => r.sym));
        const n = $('#imNote'); if (n) n.textContent = (u.note ? u.note + ' ' : '') + 'Click a tile for the security overview.';
        this.draw();
        HUB.perf(this.u.map(r => r.sym)).then(p => { this.perf = p; this.draw(); }).catch(() => {});
      } catch (e) { $('#imTree').parentElement.innerHTML = errBox(e); }
    },
    val(r) {
      const p = PERIODS.find(x => x[0] === this.period);
      if (p[1] === 'chg') return HUB.quote(r.sym)?.chgPct ?? r.chg;
      return this.perf?.[r.sym]?.[p[1]] ?? ({ m1: r.mom1m, y1: r.mom12m }[p[1]] ?? null);
    },
    draw() {
      if (!this.u) return; const el = $('#imTree'); if (!el) return;
      const scale = PERIODS.find(x => x[0] === this.period)[2];
      const by = {};
      this.u.forEach(r => { const v = this.val(r); if (!U.isNum(v)) return; const sec = r.sector && r.sector !== '—' ? r.sector : 'Other'; (by[sec] = by[sec] || []).push({ label: r.sym, value: this.size === 'cap' ? (r.cap || 50) : 1, chg: v, name: r.name, cap: r.cap, price: HUB.quote(r.sym)?.last ?? r.price }); });
      const groups = Object.entries(by).map(([label, items]) => { const w = U.sum(items.map(i => i.value)); return { label, items, chg: U.sum(items.map(i => i.value * i.chg)) / w, n: items.length, up: items.filter(i => i.chg > 0).length }; });
      CK.treemap2(el, groups, { scale, onClick: r => APP.open('DES', r.label), tip: r => [`${r.label} · ${r.name || ''}`, `${this.period}: ${U.fmtPct(r.chg)}`, `Price ${U.fmtPx(r.price)}`, r.cap ? `Market cap $${U.fmt(r.cap, 0)}B` : 'Market cap n/a'] });
      $('#imLeg').innerHTML = [-1, -0.66, -0.33, 0, 0.33, 0.66, 1].map(k => `<span style="background:${CK.divergingColor(k * scale, scale)}">${U.fmtPct(k * scale, 0)}</span>`).join('');
      const rows = groups.sort((a, b) => b.chg - a.chg);
      $('#imSect').innerHTML = `<table class="tbl"><thead><tr><th>Sector</th><th class="r">${this.period}</th><th class="r">Up</th><th>Best · worst</th></tr></thead><tbody>${rows.map(g => {
        const s = [...g.items].sort((a, b) => b.chg - a.chg);
        return `<tr><td class="wrap">${esc(g.label)}</td>${pctCell(g.chg, 2)}<td class="r muted">${g.up}/${g.n}</td><td class="small"><a href="#" data-s="${esc(s[0].label)}" class="up">${esc(s[0].label)}</a> · <a href="#" data-s="${esc(U.last(s).label)}" class="down">${esc(U.last(s).label)}</a></td></tr>`;
      }).join('')}</tbody></table><p class="hint">${this.size === 'cap' ? 'Sector moves are market-cap weighted.' : 'Sector moves are equal weighted.'}</p>`;
      $('#imSect').onclick = e => { const a = e.target.closest('[data-s]'); if (a) { e.preventDefault(); APP.open('DES', a.dataset.s); } };
    },
    onTick() { if (this.period === '1D') { clearTimeout(this._t); this._t = setTimeout(() => this.draw(), 400); } },
  });

  // ======================================================================== MOST — movers & most active
  APP.register('MOST', {
    title: 'Most Active & Top Movers', global: true,
    async render(root) {
      this.tab = U.store.get('mostTab', 'gain'); this.src = U.store.get('mostSrc', 'univ');
      root.innerHTML = `<div class="toolbar"><div class="seg" id="moT">${[['gain', 'Gainers'], ['lose', 'Losers'], ['active', 'Most active ($ volume)'], ['unusual', 'Unusual volume'], ['near', 'Near 52-week high'], ['low', 'Near 52-week low']].map(([k, l]) => `<button data-t="${k}" class="${k === this.tab ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="seg" id="moS"><button data-s="univ" class="${this.src === 'univ' ? 'on' : ''}">US large caps + sectors</button><button data-s="watch" class="${this.src === 'watch' ? 'on' : ''}">Watchlist</button></div></div>
        <div class="grid g2"><div id="moTbl">${panel('Loading', '<div class="muted small">Loading…</div>')}</div>${panel('Top 12', '<div class="cv tall"><canvas id="moBar"></canvas></div><p class="hint" id="moHint"></p>')}</div>`;
      $('#moT').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; this.tab = b.dataset.t; U.store.set('mostTab', this.tab); $$('#moT button').forEach(x => x.classList.toggle('on', x === b)); this.draw(); });
      $('#moS').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; this.src = b.dataset.s; U.store.set('mostSrc', this.src); $$('#moS button').forEach(x => x.classList.toggle('on', x === b)); this.load(); });
      root.addEventListener('click', e => { const t = e.target.closest('tr[data-s]'); if (t) APP.open('DES', t.dataset.s); });
      this.load();
    },
    async load() {
      try {
        if (!this.u) { const u = await HUB.universe(); this.u = u.rows; window.AGULA_UNIVERSE = u.rows; }
        const SECT = ['XLK', 'XLC', 'XLY', 'XLP', 'XLF', 'XLV', 'XLE', 'XLI', 'XLB', 'XLU', 'XLRE'];
        this.syms = this.src === 'watch' ? APP.state.watch.filter(s => !HUB.RATE.has(s)) : [...this.u.map(r => r.sym), ...SECT];
        HUB.track('screen', this.syms); HUB.ensureMeta(this.syms);
        this.draw();
        this.perf = await HUB.perf(this.syms.slice(0, 80)); this.draw();
      } catch (e) { $('#moTbl').innerHTML = errBox(e); }
    },
    rows() {
      const name = s => (this.u || []).find(r => r.sym === s)?.name || HUB.meta(s).name;
      return this.syms.map(s => {
        const q = HUB.quote(s), p = (this.perf || {})[s] || {}; if (!q) return null;
        const dv = q.vol && q.last ? q.vol * q.last : null, rv = q.vol && p.avgVol ? q.vol / p.avgVol : null;
        const pos = p.hi52 > p.lo52 ? (q.last - p.lo52) / (p.hi52 - p.lo52) : null;
        return { s, name: name(s), last: q.last, chg: q.chgPct, vol: q.vol, dv, rv, m1: p.m1, pos, hi: p.hi52, lo: p.lo52 };
      }).filter(Boolean);
    },
    draw() {
      if (!this.syms) return;
      let r = this.rows(); const T = this.tab;
      const key = { gain: x => -x.chg, lose: x => x.chg, active: x => -(x.dv || 0), unusual: x => -(x.rv || 0), near: x => -(x.pos ?? -1), low: x => (x.pos ?? 2) }[T];
      if (T === 'unusual') r = r.filter(x => x.rv); if (T === 'near' || T === 'low') r = r.filter(x => x.pos != null);
      r.sort((a, b) => key(a) - key(b));
      const title = { gain: 'Top gainers today', lose: 'Top losers today', active: 'Most active by dollar volume', unusual: 'Unusual volume (today vs 20-day average)', near: 'Closest to the 52-week high', low: 'Closest to the 52-week low' }[T];
      $('#moTbl').innerHTML = panel(title, `<div class="tblwrap"><table class="tbl"><thead><tr><th>#</th><th>Ticker</th><th>Name</th><th class="r">Last</th><th class="r">% chg</th><th class="r">Volume</th><th class="r">$ volume</th><th class="r">Rel vol</th><th class="r">1M</th><th>52W</th></tr></thead><tbody>${r.slice(0, 30).map((x, i) => `<tr class="clk" data-s="${esc(x.s)}"><td class="muted">${i + 1}</td><td class="key">${esc(x.s)}</td><td class="wrap">${esc(x.name)}</td><td class="r">${U.fmtPx(x.last)}</td>${pctCell(x.chg, 2)}<td class="r">${U.fmtBig(x.vol, 1)}</td><td class="r">${x.dv ? '$' + U.fmtBig(x.dv, 1) : '—'}</td><td class="r ${x.rv > 1.5 ? 'key' : ''}">${x.rv ? U.fmt(x.rv, 2) + '×' : '—'}</td>${pctCell(x.m1)}<td class="rng">${x.pos != null ? `<div class="rngbar" title="${U.fmtPx(x.lo)} – ${U.fmtPx(x.hi)}"><span style="left:${(U.clamp(x.pos, 0, 1) * 100).toFixed(1)}%"></span></div>` : ''}</td></tr>`).join('') || '<tr><td colspan="10" class="muted">Waiting for quotes…</td></tr>'}</tbody></table></div>`, { badge: `${r.length} names` });
      const top = r.slice(0, 12), el = $('#moBar');
      const val = { gain: x => x.chg, lose: x => x.chg, active: x => (x.dv || 0) / 1e9, unusual: x => x.rv, near: x => x.pos, low: x => x.pos }[T];
      if (el && top.length) CK.bars(el, { horizontal: true, labels: top.map(x => x.s), values: top.map(val), fmt: { active: v => '$' + U.fmt(v, 2) + 'B', unusual: v => U.fmt(v, 2) + '×', near: v => U.fmtPct(v, 0, false), low: v => U.fmtPct(v, 0, false) }[T] || (v => U.fmtPct(v)), padL: 60, colors: ['active', 'unusual', 'near', 'low'].includes(T) ? top.map(() => CK.colors().accent) : null });
      const h = $('#moHint'); if (h) h.textContent = T === 'unusual' ? 'Today\'s volume so far divided by the 20-day average; early in the session every stock looks quiet.' : T === 'near' || T === 'low' ? 'Position in the 52-week range: 100% = at the high.' : 'Live quotes from Yahoo Finance (delayed).';
    },
    onTick() { clearTimeout(this._t); this._t = setTimeout(() => this.draw(), 500); },
  });

  // ======================================================================== EVTS — earnings calendar
  APP.register('EVTS', {
    title: 'Earnings Calendar', global: true,
    async render(root) {
      this.cap = U.store.get('evCap', 10); this.mine = U.store.get('evMine', false);
      root.innerHTML = `<div class="toolbar"><div class="seg" id="evCap">${[[0, 'All'], [2, '> $2B'], [10, '> $10B'], [100, '> $100B']].map(([v, l]) => `<button data-v="${v}" class="${v === this.cap ? 'on' : ''}">${l}</button>`).join('')}</div>
        <label class="chk"><input type="checkbox" id="evMine" ${this.mine ? 'checked' : ''}> Watchlist & large caps only</label><input class="txt" id="evQ" placeholder="Filter ticker or company"><span class="muted small" id="evSrc"></span></div>
        <div id="evDays" class="daytabs"></div><div id="evBody">${panel('Loading', '<div class="muted small">Loading the calendar…</div>')}</div>`;
      $('#evCap').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; this.cap = +b.dataset.v; U.store.set('evCap', this.cap); $$('#evCap button').forEach(x => x.classList.toggle('on', x === b)); this.draw(); });
      $('#evMine').addEventListener('change', e => { this.mine = e.target.checked; U.store.set('evMine', this.mine); this.draw(); });
      $('#evQ').addEventListener('input', () => this.draw());
      $('#evDays').addEventListener('click', e => { const b = e.target.closest('[data-d]'); if (!b) return; this.day = b.dataset.d; this.draw(); });
      root.addEventListener('click', e => { const t = e.target.closest('tr[data-s]'); if (t) APP.open('DES', t.dataset.s); });
      try {
        const j = await HUB.earnings(); this.j = j;
        this.day = j.days.find(d => d >= j.today && j.rows.some(r => r.date === d)) || j.today;
        $('#evSrc').innerHTML = `Source: ${esc(j.source)}${j.note ? ' · <span class="warn-t">' + esc(j.note) + '</span>' : ''}`;
        this.draw();
      } catch (e) { $('#evBody').innerHTML = errBox(e); }
    },
    filtered() {
      const mine = new Set([...APP.state.watch, ...(window.AGULA_UNIVERSE || []).map(r => r.sym), 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'JPM']);
      const q = ($('#evQ')?.value || '').trim().toUpperCase();
      return this.j.rows.filter(r => (!this.cap || (r.cap || 0) >= this.cap * 1e9 || mine.has(r.sym)) && (!this.mine || mine.has(r.sym)) && (!q || r.sym.includes(q) || r.name.toUpperCase().includes(q)));
    },
    draw() {
      if (!this.j) return;
      const rows = this.filtered(), byDay = {}; rows.forEach(r => { (byDay[r.date] = byDay[r.date] || []).push(r); });
      const fmtD = d => { const x = new Date(d + 'T12:00:00Z'); return x.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); };
      $('#evDays').innerHTML = this.j.days.map(d => `<button data-d="${d}" class="${d === this.day ? 'on' : ''} ${d < this.j.today ? 'past' : ''} ${d === this.j.today ? 'today' : ''}"><b>${fmtD(d)}</b><span>${(byDay[d] || []).length}</span></button>`).join('');
      const mine = new Set(APP.state.watch);
      const list = (byDay[this.day] || []).sort((a, b) => (b.cap || 0) - (a.cap || 0));
      const sect = t => list.filter(r => r.time === t);
      const tbl = (rs, title) => rs.length ? `<h4 class="subh">${title} · ${rs.length}</h4><div class="tblwrap"><table class="tbl"><thead><tr><th>Ticker</th><th>Company</th><th class="r">Market cap</th><th class="r">EPS estimate</th><th class="r">Estimates</th><th class="r">Year-ago EPS</th><th class="r">Implied y/y</th><th>Fiscal qtr</th></tr></thead><tbody>${rs.map(r => {
        const yy = U.isNum(r.eps) && U.isNum(r.lastEps) && r.lastEps !== 0 ? r.eps / Math.abs(r.lastEps) - Math.sign(r.lastEps) : null;
        return `<tr class="clk" data-s="${esc(r.sym)}"><td class="key">${esc(r.sym)}${mine.has(r.sym) ? ' <span class="pill">WATCH</span>' : ''}</td><td class="wrap">${esc(r.name)}</td><td class="r">${r.cap ? '$' + U.fmtBig(r.cap, 1) : '—'}</td><td class="r">${U.isNum(r.eps) ? U.fmtSigned(r.eps, 2) : '—'}</td><td class="r muted">${r.nEst ?? '—'}</td><td class="r">${U.isNum(r.lastEps) ? U.fmtSigned(r.lastEps, 2) : '—'}</td>${pctCell(yy, 0)}<td class="muted">${esc(r.fq || '')}</td></tr>`;
      }).join('')}</tbody></table></div>` : '';
      const big = list.slice(0, 6).map(r => `<span class="symchip" data-s="${esc(r.sym)}">${esc(r.sym)}</span>`).join(' ');
      $('#evBody').innerHTML = panel(`Reporting ${fmtD(this.day)}`, list.length ? `<div class="chips mb">${big}</div>${tbl(sect('BMO'), 'Before the open')}${tbl(sect('AMC'), 'After the close')}${tbl(sect('—'), 'Time not announced')}`
        : '<div class="empty small">No reports match these filters on this day. Try "All" sizes.</div>', { badge: `${list.length} reports` }) +
        `<p class="src-note">EPS estimates are consensus figures from the calendar source; "implied y/y" compares the estimate with the year-ago quarter. Dates can move; confirm with the company.</p>`;
      $$('#evBody .symchip').forEach(c => c.addEventListener('click', () => APP.open('DES', c.dataset.s)));
    },
  });

  // ======================================================================== CORR — correlation matrix
  function cluster(C) {
    // average-linkage hierarchical clustering on 1 - corr; returns the leaf order
    let groups = C.map((_, i) => [i]);
    const d = (a, b) => U.mean(a.flatMap(i => b.map(j => 1 - C[i][j])));
    while (groups.length > 1) {
      let best = [0, 1, Infinity];
      for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) { const x = d(groups[i], groups[j]); if (x < best[2]) best = [i, j, x]; }
      const merged = [...groups[best[0]], ...groups[best[1]]];
      groups = groups.filter((_, k) => k !== best[0] && k !== best[1]); groups.push(merged);
    }
    return groups[0];
  }
  APP.register('CORR', {
    title: 'Correlation Matrix', global: true,
    async render(root) {
      const def = APP.state.watch.filter(s => !HUB.RATE.has(s)).slice(0, 14);
      this.syms = U.store.get('corrSyms', def); this.lb = U.store.get('corrLb', 252); this.freq = U.store.get('corrFreq', 'D'); this.order = U.store.get('corrOrd', 'cluster');
      root.innerHTML = `<div class="toolbar"><input class="txt wide" id="crSyms" value="${esc(this.syms.join(' '))}" aria-label="Symbols"><button class="btn" id="crGo">Compute</button><button class="btn ghost sm" id="crW">Use watchlist</button>
        <div class="seg" id="crLb">${[[63, '3M'], [126, '6M'], [252, '1Y'], [756, '3Y'], [1260, '5Y']].map(([v, l]) => `<button data-v="${v}" class="${v === this.lb ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="seg" id="crF"><button data-v="D" class="${this.freq === 'D' ? 'on' : ''}">Daily</button><button data-v="W" class="${this.freq === 'W' ? 'on' : ''}">Weekly</button></div>
        <div class="seg" id="crO"><button data-v="cluster" class="${this.order === 'cluster' ? 'on' : ''}">Clustered</button><button data-v="input" class="${this.order === 'input' ? 'on' : ''}">As typed</button></div></div>
        <div class="grid corrgrid">${panel('Return correlation', '<div class="cv xl"><canvas id="crHeat"></canvas></div><p class="hint">Click a cell to chart that pair\'s rolling correlation. Blue = move together, red = move opposite.</p>', { id: 'crP' })}
          <div class="stack">${panel('Summary', '<div id="crSum"><div class="muted small">Loading…</div></div>')}${panel('Diversifiers', '<div id="crDiv"></div>')}</div>
          ${panel('Rolling correlation', '<div class="cv"><canvas id="crRoll"></canvas></div><p class="hint" id="crRollH">Click a cell above.</p>', { cls: 'span3' })}</div>`;
      const seg = (id, key, store, cast = x => x) => $(id).addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; this[key] = cast(b.dataset.v); U.store.set(store, this[key]); $$(id + ' button').forEach(x => x.classList.toggle('on', x === b)); this.compute(); });
      seg('#crLb', 'lb', 'corrLb', Number); seg('#crF', 'freq', 'corrFreq'); seg('#crO', 'order', 'corrOrd');
      $('#crGo').addEventListener('click', () => this.readSyms());
      $('#crSyms').addEventListener('keydown', e => { if (e.key === 'Enter') this.readSyms(); });
      $('#crW').addEventListener('click', () => { $('#crSyms').value = APP.state.watch.filter(s => !HUB.RATE.has(s)).slice(0, 25).join(' '); this.readSyms(); });
      this.compute();
    },
    readSyms() {
      const list = [...new Set($('#crSyms').value.split(/[\s,]+/).map(HUB.resolve).filter(Boolean))].slice(0, 25);
      if (list.length < 2) { APP.toast('Enter at least two symbols.', 'err'); return; }
      this.syms = list; U.store.set('corrSyms', list); this.compute();
    },
    async compute() {
      const box = $('#crSum'); if (box) box.innerHTML = '<div class="muted small">Loading price history…</div>';
      const got = await Promise.all(this.syms.map(s => HUB.history(s, '1D').then(b => [s, b]).catch(() => [s, null])));
      const ok = got.filter(x => x[1] && x[1].length > 30), bad = got.filter(x => !x[1] || x[1].length <= 30).map(x => x[0]);
      if (ok.length < 2) { $('#crP .pb').innerHTML = errBox('Need at least two symbols with price history.'); return; }
      // align on calendar dates (crypto trades weekends, stocks don't)
      const key = t => { const d = new Date(t); if (this.freq === 'W') { const k = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7))); return k.toISOString().slice(0, 10); } return d.toISOString().slice(0, 10); };
      const maps = ok.map(([s, b]) => { const m = new Map(); b.forEach(x => m.set(key(x.t), x.c)); return [s, m]; });
      let dates = [...maps[0][1].keys()].filter(d => maps.every(([, m]) => m.has(d))).sort();
      const need = this.freq === 'W' ? Math.ceil(this.lb / 5) + 1 : this.lb + 1; dates = dates.slice(-need);
      if (dates.length < 20) { $('#crP .pb').innerHTML = errBox('These symbols share too few common trading days.'); return; }
      const R = maps.map(([, m]) => { const c = dates.map(d => m.get(d)); return c.slice(1).map((x, i) => Math.log(x / c[i])); });
      const n = R.length, C = R.map((a, i) => R.map((b, j) => i === j ? 1 : U.corr(a, b)));
      const ord = this.order === 'cluster' ? cluster(C) : U.range(n);
      const labels = ord.map(i => ok[i][0]), M = ord.map(i => ord.map(j => C[i][j]));
      this.ctx = { R, ok, dates, ord };
      CK.heatmap($('#crHeat'), { rows: labels, cols: labels, values: M, padL: 86, padT: 26, fmt: v => v.toFixed(2), color: v => v >= 0.999 ? CK.colors().grid : corrColor(v) });
      const pairs = []; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([ok[i][0], ok[j][0], C[i][j], i, j]);
      pairs.sort((a, b) => b[2] - a[2]);
      const avg = U.mean(pairs.map(p => p[2]));
      const vols = R.map(r => U.std(r) * Math.sqrt(this.freq === 'W' ? 52 : 252));
      const ew = U.range(n).map(() => 1 / n); let pv = 0; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) pv += ew[i] * ew[j] * C[i][j] * vols[i] * vols[j];
      const dr = U.sum(ew.map((w, i) => w * vols[i])) / Math.sqrt(pv);
      const pr = p => `<tr class="clk" data-i="${p[3]}" data-j="${p[4]}"><td class="key">${esc(p[0])} · ${esc(p[1])}</td><td class="r">${p[2].toFixed(2)}</td></tr>`;
      $('#crSum').innerHTML = kv('Assets · observations', `${n} · ${R[0].length} ${this.freq === 'W' ? 'weeks' : 'days'}`) + kv('Window', `${dates[0]} → ${U.last(dates)}`) + kv('Average pairwise correlation', avg.toFixed(2)) +
        kv('Diversification ratio (equal weight)', dr.toFixed(2) + '×') + (bad.length ? `<p class="hint">No history for: ${esc(bad.join(', '))}</p>` : '') +
        `<h4 class="subh">Most correlated</h4><table class="tbl"><tbody>${pairs.slice(0, 4).map(pr).join('')}</tbody></table><h4 class="subh">Least correlated</h4><table class="tbl"><tbody>${pairs.slice(-4).reverse().map(pr).join('')}</tbody></table>`;
      const avgC = U.range(n).map(i => [ok[i][0], U.mean(C[i].filter((_, j) => j !== i)), vols[i]]).sort((a, b) => a[1] - b[1]);
      $('#crDiv').innerHTML = `<table class="tbl"><thead><tr><th>Asset</th><th class="r">Avg corr</th><th class="r">Vol</th></tr></thead><tbody>${avgC.map(x => `<tr><td class="key">${esc(x[0])}</td><td class="r">${x[1].toFixed(2)}</td><td class="r muted">${U.fmtPct(x[2], 0, false)}</td></tr>`).join('')}</tbody></table><p class="hint">Lowest average correlation first: these add the most diversification.</p>`;
      $('#crSum').onclick = e => { const t = e.target.closest('tr[data-i]'); if (t) this.roll(+t.dataset.i, +t.dataset.j); };
      const heat = $('#crHeat');
      heat.onclick = e => { const b = heat.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top, cw = (b.width - 86 - 4) / n, ch = (b.height - 26 - 4) / n; const j = Math.floor((x - 86) / cw), i = Math.floor((y - 26) / ch); if (i >= 0 && j >= 0 && i < n && j < n && i !== j) this.roll(ord[i], ord[j]); };
      heat.style.cursor = 'pointer';
      this.roll(pairs[0][3], pairs[0][4]);
    },
    roll(i, j) {
      const { R, ok, dates } = this.ctx, w = this.freq === 'W' ? 26 : 60, a = R[i], b = R[j], pts = [];
      for (let k = w; k <= a.length; k++) pts.push([Date.parse(dates[k]), U.corr(a.slice(k - w, k), b.slice(k - w, k))]);
      CK.xy($('#crRoll'), { series: [{ name: `${ok[i][0]} vs ${ok[j][0]} · ${w}-${this.freq === 'W' ? 'week' : 'day'} rolling`, data: pts, color: CK.colors().key }], hlines: [{ y: 0 }, { y: U.corr(a, b), label: 'full window ' + U.corr(a, b).toFixed(2), color: CK.colors().accent }], ymin: -1, ymax: 1, xFmt: t => new Date(t).toISOString().slice(0, 7), yFmt: v => v.toFixed(1) });
      $('#crRollH').textContent = 'Correlation is not stable: watch how it moves in stress periods, when diversification matters most.';
    },
  });
  function corrColor(v) {
    const c = CK.colors(), t = U.clamp(Math.abs(v), 0, 1), hex = s => { s = s.replace('#', ''); return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16)); };
    const base = v >= 0 ? hex(c.accent) : hex(c.down), bg = hex(c.bg);
    return `rgb(${bg.map((b, i) => Math.round(b + (base[i] - b) * (0.1 + 0.8 * t))).join(',')})`;
  }
})();
