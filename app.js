/* ============================================================================
   Agula Terminal — shell: command line, router, watchlist, tape, alerts
   ========================================================================== */
'use strict';

const APP = (() => {
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  // Launchpad panes load this same page as ?pane=<id>&fn=CHART&sym=AAPL: one isolated terminal per tile
  const QS = new URLSearchParams(location.search), PANE = QS.get('pane');
  const state = {
    sym: (PANE && QS.get('sym')) || U.store.get('sym', 'AAPL'), screen: null, history: U.store.get('cmdHist', []), histIdx: -1,
    watch: U.store.get('watch', null), alerts: U.store.get('alerts', []).map(a => ({ kind: 'px', ...a })), pane: PANE,
  };
  const SCREENS = {};
  const FKEYS = ['HELP', 'MON', 'LP', 'DES', 'CHART', 'DCF', 'OPT', 'PORT', 'BOT', 'GEO', 'NEWS', 'ALRT'];
  const ALIAS = { GP: 'CHART', G: 'CHART', GIP: 'CHART', CN: 'DES', Q: 'DES', QUOTE: 'DES', VAL: 'DCF', VALUE: 'DCF', OPTIONS: 'OPT', OMON: 'OPT', RISK: 'PORT', PRT: 'PORT', YC: 'CURVE', FI: 'CURVE', GC: 'CURVE',
    FXC: 'FX', WCRS: 'FX', SCREEN: 'SCRN', EQS: 'SCRN', CAL: 'ECO', CALENDAR: 'ECO', MACRO: 'ECO', ECOW: 'ECO', MARKET: 'MON', TOP: 'NEWS', N: 'NEWS', HEADLINES: 'NEWS', WIRE: 'NEWS', SETTINGS: 'SET', '?': 'HELP',
    LAUNCHPAD: 'LP', BLP: 'LP', HEAT: 'IMAP', HEATMAP: 'IMAP', MOVERS: 'MOST', ACTIVE: 'MOST', ERN: 'EVTS', EARNINGS: 'EVTS', EA: 'EVTS', COMM: 'GLCO', COMMODITIES: 'GLCO', BTMM: 'CURVE',
    CRYPTOS: 'CRYP', COINS: 'CRYP', COR: 'CORR', CORRELATION: 'CORR', MAP: 'GEO', GEOPOLITICS: 'GEO', GPR: 'GEO', ALERTS: 'ALRT', ALRTS: 'ALRT', BOND: 'YAS', BONDS: 'YAS', YA: 'YAS', DUR: 'YAS', DURATION: 'YAS', BOND_CALC: 'YAS', TRADE: 'BOT', BOTS: 'BOT', BT: 'BOT', BACKTEST: 'BOT', EMSX: 'BOT', WORLD: 'WEI', INDICES: 'WEI' };
  // Bloomberg's yellow market-sector keys -> the monitor for that market
  const SECTORS = [['GOVT', 'YAS', 'Bonds: yield, duration and spread analysis (CURVE for the Treasury curve)'], ['EQUITY', 'IMAP', 'Equities: sector heatmap'], ['CMDTY', 'GLCO', 'Commodities monitor'], ['INDEX', 'WEI', 'World equity indices'],
    ['CRNCY', 'FX', 'Currencies'], ['CRYPTO', 'CRYP', 'Crypto monitor']];
  // numbered "related functions" menu under every screen title (press 1-9)
  const RELATED = {
    DES: ['CHART', 'DCF', 'OPT', 'NEWS', 'CORR', 'BOT', 'ALRT', 'EVTS'], CHART: ['DES', 'BOT', 'CORR', 'ALRT', 'NEWS', 'OPT'], MON: ['WEI', 'IMAP', 'MOST', 'GLCO', 'CRYP', 'GEO', 'ECO', 'EVTS'],
    WEI: ['MON', 'IMAP', 'GEO', 'FX', 'CURVE', 'GLCO'], GLCO: ['WEI', 'GEO', 'FX', 'CURVE'], CRYP: ['WEI', 'BOT', 'CORR', 'DES'], IMAP: ['MOST', 'SCRN', 'WEI', 'EVTS', 'CORR'], MOST: ['IMAP', 'SCRN', 'EVTS', 'DES'],
    EVTS: ['ECO', 'MOST', 'DES', 'NEWS'], GEO: ['NEWS', 'GLCO', 'WEI', 'FX', 'ALRT'], BOT: ['CHART', 'DES', 'ALRT', 'MOST', 'CORR'], ALRT: ['BOT', 'MON', 'LP'], CORR: ['PORT', 'CHART', 'IMAP'],
    NEWS: ['GEO', 'ECO', 'EVTS'], PORT: ['CORR', 'BOT', 'DES'], DCF: ['DES', 'EVTS', 'SCRN'], OPT: ['DES', 'CHART'], CURVE: ['YAS', 'ECO', 'FX', 'WEI'], YAS: ['CURVE', 'ECO', 'FX', 'PORT'], FX: ['GEO', 'CURVE', 'WEI'], SCRN: ['IMAP', 'MOST', 'EVTS'],
    ECO: ['EVTS', 'CURVE', 'NEWS'], LP: ['MON', 'BOT', 'GEO'],
  };

  function register(code, def) { SCREENS[code] = { code, ...def }; }

  // ------------------------------------------------------------- helpers for screens
  const panel = (title, body, opts = {}) => `<section class="pnl ${opts.cls || ''}" ${opts.id ? `id="${opts.id}"` : ''}><header><h3>${title}</h3>${opts.tools ? `<div class="tools">${opts.tools}</div>` : ''}${opts.badge ? `<span class="badge">${opts.badge}</span>` : ''}</header><div class="pb">${body}</div></section>`;
  const kv = (label, value, cls = '') => `<div class="kv"><span>${label}</span><b class="${cls}">${value}</b></div>`;
  const srcBadge = sym => `<span class="src live">${/-USD$/.test(sym) ? 'YAHOO · BINANCE' : 'YAHOO'}</span>`;

  function toast(msg, kind = 'info', ms = 4200) {
    const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg; $('#toasts').appendChild(t);
    setTimeout(() => t.classList.add('out'), ms); setTimeout(() => t.remove(), ms + 400);
  }
  async function saveFile(name, data) {
    const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data]));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
    toast(`Downloaded ${name}`, 'ok');
  }

  // ------------------------------------------------------------- routing
  function open(code, sym) {
    code = code || 'DES';
    if (sym && !setSym(sym, false)) return;
    const def = SCREENS[code]; if (!def) { toast(`Unknown function ${code}. Type HELP for the list.`, 'err'); return; }
    if (PANE && code === 'LP') { toast('A Launchpad tile cannot hold another Launchpad.', 'err'); return; }
    if (state.screen && SCREENS[state.screen]?.destroy) { try { SCREENS[state.screen].destroy(); } catch (e) { console.error(e); } }
    HUB.track('screen', []);
    state.screen = code; if (!PANE) U.store.set('screen', code); tellParent();
    $$('#fkeys button').forEach(b => b.classList.toggle('on', b.dataset.code === code));
    const root = $('#screen'); root.innerHTML = ''; root.className = 'screen scr-' + code.toLowerCase(); root.onclick = null;
    const fresh = root.cloneNode(false); root.replaceWith(fresh);   // drop listeners from the previous function
    renderHead();
    try { const r = def.render(fresh, { sym: state.sym }); if (r && r.catch) r.catch(e => { console.error(e); fresh.innerHTML = `<div class="empty err">${U.esc(e.message)}</div>`; }); }
    catch (e) { console.error(e); fresh.innerHTML = `<div class="empty err">${U.esc(e.message)}</div>`; }
    fresh.scrollTop = 0;
  }
  let headPx = null;
  const relatedOf = code => (RELATED[code] || ['MON', 'DES', 'CHART', 'NEWS']).filter(c => SCREENS[c] && c !== code).slice(0, 9);
  function renderHead() {
    const def = SCREENS[state.screen]; if (!def) return;
    const q = HUB.quote(state.sym), m = HUB.meta(state.sym), rate = m.cls === 'RATE';
    const rel = relatedOf(def.code);
    $('#scrHead').innerHTML = `<span class="fcode">${def.code}</span><span class="ftitle">${def.title}</span>` +
      (def.global ? '' : `<span class="hsym">${U.esc(state.sym)}</span><span class="hname">${U.esc(m.name)}</span><span class="ysec">${{ EQ: 'EQUITY', ETF: 'EQUITY', IDX: 'INDEX', FX: 'CRNCY', CMDTY: 'CMDTY', CRYPTO: 'CRYPTO', RATE: 'GOVT' }[m.cls] || ''}</span>${srcBadge(state.sym)}` +
        (q ? `<span class="hpx">${U.fmtPx(q.last, rate ? 3 : undefined)}${rate ? '%' : ''}</span><span class="${U.cls(q.chg)}">${rate ? U.fmtBp(q.chg / 100) : U.fmtSigned(q.chg, U.decimalsFor(q.last)) + ' (' + U.fmtPct(q.chgPct) + ')'}</span>` : '')) +
      (rel.length ? `<nav class="rel" aria-label="Related functions">${rel.map((c, i) => `<button data-rel="${c}" title="${U.esc(SCREENS[c].title)} (press ${i + 1})"><i>${i + 1})</i>${c}</button>`).join('')}</nav>` : '');
    if (q && !def.global) { const el = $('#scrHead .hpx'); if (headPx && headPx.sym === state.sym && headPx.px !== q.last) U.flash(el, q.last > headPx.px); headPx = { sym: state.sym, px: q.last }; }
  }
  function tellParent() { if (PANE && window.parent !== window) window.parent.postMessage({ agula: 'pane', id: PANE, fn: state.screen, sym: state.sym }, location.origin); }
  function setSym(sym, rerender = true) {
    const s = HUB.resolve(sym);
    if (!s) { toast(HUB.why(sym), 'err', 6000); return false; }
    state.sym = s; if (!PANE) U.store.set('sym', s); tellParent();
    HUB.track('sym', [s]); HUB.ensureMeta([s]);
    if (!HUB.quote(s)) HUB.refreshQuote(s).then(q => { if (!q) toast(`No quote for ${s}. Check the symbol (Yahoo format).`, 'err', 6000); renderHead(); }).catch(e => toast(e.message, 'err'));
    if (rerender && state.screen) { const def = SCREENS[state.screen]; if (def.onSym) { renderHead(); def.onSym(s); } else open(def.global ? 'DES' : state.screen); }
    renderWatch();
    return true;
  }

  // ------------------------------------------------------------- command line
  // Bloomberg syntax: <ticker> [exchange] <yellow key> [function] <GO>, e.g. "AAPL US EQUITY DES <GO>", "7203 JP EQUITY GP",
  // "SPX INDEX GP", "EURUSD CURNCY", "CL1 COMDTY", "GT10 GOVT". Yahoo symbols and plain commands keep working.
  const EXCH = { US: '', UN: '', UW: '', UQ: '', UA: '', UR: '', UP: '', UV: '', LN: '.L', GY: '.DE', GR: '.DE', FP: '.PA', NA: '.AS', SW: '.SW', SE: '.SW', IM: '.MI', SM: '.MC', JP: '.T', JT: '.T',
    HK: '.HK', CN: '.TO', CT: '.TO', AU: '.AX', AT: '.AX', KS: '.KS', TT: '.TW', SP: '.SI', IN: '.NS', IS: '.NS', IB: '.BO', BZ: '.SA', MM: '.MX', SS: '.ST', NO: '.OL', DC: '.CO', FH: '.HE', AV: '.VI', BB: '.BR',
    ID: '.IR', PL: '.LS', CH: '.SS', CG: '.SS', CS: '.SZ', TI: '.IS', SJ: '.JO', IJ: '.JK', MK: '.KL', TB: '.BK' };
  const YELLOW = { EQUITY: 'EQ', EQ: 'EQ', PFD: 'EQ', INDEX: 'IDX', CRNCY: 'FX', CURNCY: 'FX', CMDTY: 'CMDTY', COMDTY: 'CMDTY', GOVT: 'GOVT', CORP: 'CORP', MTGE: 'CORP', MUNI: 'CORP', CRYPTO: 'CRYPTO' };
  function bbg(parts) {
    while (parts.length && /^<?GO>?$/.test(parts[parts.length - 1])) parts.pop();
    const yi = parts.findIndex(p => YELLOW[p]);
    if (yi < 0) return { parts, sector: null };
    const sector = YELLOW[parts[yi]];
    if (yi === 0) return { parts: parts.slice(1), sector, bare: parts.length === 1 };
    let tick = parts[0].replace('/', '-'); const ex = yi >= 2 ? parts[1] : null; let sym = tick;
    if (sector === 'EQ') {
      const suf = ex != null && EXCH[ex] != null ? EXCH[ex] : '';
      if (suf === '.HK' && /^\d+$/.test(tick)) tick = tick.padStart(4, '0');
      sym = tick + suf;
    } else if (sector === 'IDX') sym = HUB.resolve(tick) && (tick.startsWith('^') || HUB.resolve(tick) !== tick) ? tick : '^' + tick;
    else if (sector === 'CRYPTO' && !/-USD$/.test(tick)) sym = tick + '-USD';
    return { parts: [sym, ...parts.slice(yi + 1)], sector };
  }
  function parse(raw) {
    const text = raw.trim(); if (!text) return;
    state.history = [text, ...state.history.filter(x => x !== text)].slice(0, 40); U.store.set('cmdHist', state.history); state.histIdx = -1;
    const up = text.toUpperCase().replace(/<\s*GO\s*>/g, ' <GO>'), b = bbg(up.split(/\s+/).filter(Boolean)), parts = b.parts;
    if (b.sector === 'CORP') { toast('Corporate bond quotes are not in Agula\'s data: enter the coupon, maturity and yield or spread in YAS to analyse any bond.', 'info'); open('YAS'); return; }
    if (b.bare || (!parts.length && b.sector)) { const sec = SECTORS.find(x => YELLOW[x[0]] === b.sector); if (sec) open(sec[1]); return; }
    if (!parts.length) return;
    if (parts[0] === 'NEWS' && parts.length > 1 && SCREENS.NEWS.themeFor(parts.slice(1).join(' '))) { SCREENS.NEWS.theme = SCREENS.NEWS.themeFor(parts.slice(1).join(' ')); open('NEWS'); return; }
    if (parts[0] === 'ALERT') {
      const line = parts.join(' ');
      const pc = line.match(/^ALERT(?:\s+(\S+))?\s*(>|<|>=|<=)?\s*([+-]?[\d.]+)%$/);
      if (pc) {
        const s = HUB.resolve(pc[1] || state.sym); if (!s) { toast(HUB.why(pc[1]), 'err'); return; }
        let v = +pc[3] / 100; const op = pc[2] ? (pc[2][0] === '>' ? '>' : '<') : (v < 0 ? '<' : '>'); if (op === '<' && v > 0) v = -v;
        addAlert(s, op, v, { kind: 'pct' }); return;
      }
      const m = line.match(/^ALERT\s+(\S+)\s*(>|<|>=|<=|ABOVE|BELOW)\s*([\d.]+)$/) || line.match(/^ALERT\s*(>|<|>=|<=|ABOVE|BELOW)\s*([\d.]+)$/);
      if (!m) { toast('Alert format: ALERT AAPL > 250 · ALERT AAPL +5% · ALERT AAPL -3% (or open ALRT)', 'err'); return; }
      const [sym, op, px] = m.length === 4 ? [m[1], m[2], +m[3]] : [state.sym, m[1], +m[2]];
      const s = HUB.resolve(sym); if (!s) { toast(HUB.why(sym), 'err'); return; }
      addAlert(s, op === 'ABOVE' || op[0] === '>' ? '>' : '<', px); return;
    }
    if (parts[0] === 'CMP' || parts[0] === 'COMPARE') { open('CHART'); setTimeout(() => SCREENS.CHART.compare && SCREENS.CHART.compare(parts.slice(1)), 0); return; }
    if (parts[0] === 'WATCH' || parts[0] === 'W+') { parts.slice(1).forEach(addWatch); return; }
    const fn = parts.find((p, i) => (SCREENS[p] || ALIAS[p]) && !(b.sector && i === 0));
    const code = fn ? (SCREENS[fn] ? fn : ALIAS[fn]) : null;
    const symTok = parts.find(p => p !== fn);
    if (symTok && !setSym(symTok, false)) return;
    if (code) open(code); else if (symTok) open(b.sector || SCREENS[state.screen]?.global ? 'DES' : (state.screen || 'DES'));
  }

  const KNOWN = () => {
    const out = new Map();
    Object.entries(HUB.NAMES).forEach(([s, n]) => out.set(s, n));
    state.watch.forEach(s => out.set(s, HUB.meta(s).name));
    (window.AGULA_UNIVERSE || []).forEach(r => out.set(r.sym, r.name));
    return out;
  };
  let remote = [], remoteFor = '', searchT = null;
  function suggestions(text) {
    const up = text.toUpperCase().trim(); if (!up) return [];
    const last = up.split(/\s+/).pop(), out = [];
    Object.values(SCREENS).forEach(s => { if (s.code.startsWith(last)) out.push({ k: s.code, d: s.title, t: 'fn' }); });
    KNOWN().forEach((n, s) => { if (s.startsWith(last) || String(n).toUpperCase().includes(last)) out.push({ k: s, d: n, t: HUB.cls(s) }); });
    if (remoteFor === last) remote.forEach(r => { if (!out.some(o => o.k === r.sym)) out.push({ k: r.sym, d: `${r.name} · ${r.exch}`, t: r.type }); });
    return out.slice(0, 10);
  }
  function wireCmd() {
    const inp = $('#cmd'), box = $('#suggest'); let sel = -1, items = [];
    const draw = () => {
      items = suggestions(inp.value); sel = Math.min(sel, items.length - 1);
      box.innerHTML = items.map((s, i) => `<div class="sg ${i === sel ? 'on' : ''}" data-i="${i}"><b>${U.esc(s.k)}</b><span>${U.esc(s.d)}</span><em>${U.esc(s.t)}</em></div>`).join('');
      box.hidden = !items.length;
    };
    const lookup = () => {
      clearTimeout(searchT); const last = inp.value.toUpperCase().trim().split(/\s+/).pop();
      if (!last || last.length < 2 || SCREENS[last]) return;
      searchT = setTimeout(() => HUB.search(last).then(r => { remote = r || []; remoteFor = last; if (document.activeElement === inp) draw(); }).catch(() => {}), 280);
    };
    const accept = i => { const parts = inp.value.trim().split(/\s+/); parts[parts.length - 1] = items[i].k; inp.value = parts.join(' ') + ' '; draw(); inp.focus(); };
    inp.addEventListener('input', () => { sel = -1; draw(); lookup(); });
    inp.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (!box.hidden && items.length) { sel = (sel + 1) % items.length; draw(); } else if (state.histIdx > 0) { state.histIdx--; inp.value = state.history[state.histIdx]; } else { state.histIdx = -1; inp.value = ''; } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (!box.hidden && items.length && sel > 0) { sel--; draw(); } else if (state.history.length) { state.histIdx = Math.min(state.histIdx + 1, state.history.length - 1); inp.value = state.history[state.histIdx]; box.hidden = true; } }
      else if (e.key === 'Tab' && items.length) { e.preventDefault(); accept(Math.max(sel, 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); if (sel >= 0) accept(sel); const v = inp.value; inp.value = ''; box.hidden = true; parse(v); }
      else if (e.key === 'Escape') { inp.value = ''; box.hidden = true; inp.blur(); }
    });
    box.addEventListener('mousedown', e => { const d = e.target.closest('.sg'); if (d) { e.preventDefault(); accept(+d.dataset.i); } });
    inp.addEventListener('blur', () => setTimeout(() => box.hidden = true, 120));
    document.addEventListener('keydown', e => {
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
      if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); inp.focus(); inp.select(); }
      if (e.altKey && /^Digit\d$/.test(e.code)) { e.preventDefault(); const i = +e.code.slice(5); const code = FKEYS[i === 0 ? 10 : i]; if (code) open(code); }
    });
  }

  // ------------------------------------------------------------- watchlist & tape
  const defaultWatch = () => ['^GSPC', '^NDX', '^VIX', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'JPM', 'XOM', '^TNX', 'DX-Y.NYB', 'EURUSD=X', 'JPY=X', 'MNT=X', 'GC=F', 'CL=F', 'BTC-USD'];
  function addWatch(sym) {
    const s = HUB.resolve(sym); if (!s) { toast(HUB.why(sym), 'err'); return; }
    if (!state.watch.includes(s)) { state.watch.push(s); U.store.set('watch', state.watch); HUB.track('watch', state.watch); renderWatch(); renderTape(); toast(`${s} added to the watchlist`, 'ok'); }
  }
  const idOf = s => s.replace(/[^A-Za-z0-9]/g, '_');
  function renderWatch() {
    $('#watch').innerHTML = state.watch.map(s => `<div class="wrow ${s === state.sym ? 'on' : ''}" data-s="${U.esc(s)}" title="${U.esc(HUB.meta(s).name)}"><span class="ws">${U.esc(s)}</span><span class="wl" id="wl-${idOf(s)}">—</span><span class="wc" id="wc-${idOf(s)}">—</span><button class="x" title="Remove ${U.esc(s)}" data-x="${U.esc(s)}">×</button></div>`).join('');
    updateWatch(state.watch);
  }
  const lastPx = new Map();
  function updateWatch(syms) {
    syms.forEach(s => {
      const q = HUB.quote(s), l = document.getElementById('wl-' + idOf(s)), c = document.getElementById('wc-' + idOf(s));
      if (!q || !l) return;
      const rate = HUB.RATE.has(s), prev = lastPx.get(s);
      l.textContent = U.fmtPx(q.last, rate ? 3 : undefined); c.textContent = rate ? U.fmtBp(q.chg / 100) : U.fmtPct(q.chgPct); c.className = 'wc ' + U.cls(q.chg);
      if (prev != null && prev !== q.last) { l.classList.remove('fu', 'fd'); void l.offsetWidth; l.classList.add(q.last > prev ? 'fu' : 'fd'); }
      lastPx.set(s, q.last);
    });
  }
  function renderTape() {
    const items = state.watch.map(s => `<span class="ti" data-s="${U.esc(s)}"><b>${U.esc(s)}</b> <span id="tl-${idOf(s)}">—</span> <span id="tc-${idOf(s)}">—</span></span>`).join('');
    $('#tapeInner').innerHTML = items + items.replace(/id="t([lc])-/g, 'id="t$1d-');
    $('#tapeInner').style.animationDuration = Math.max(30, state.watch.length * 5) + 's';
    updateTape(state.watch);
  }
  function updateTape(syms) {
    syms.forEach(s => {
      const q = HUB.quote(s); if (!q) return; const rate = HUB.RATE.has(s);
      for (const p of ['', 'd']) {
        const l = document.getElementById(`tl${p}-` + idOf(s)), c = document.getElementById(`tc${p}-` + idOf(s)); if (!l) continue;
        l.textContent = U.fmtPx(q.last, rate ? 3 : undefined); c.textContent = rate ? U.fmtBp(q.chg / 100) : U.fmtPct(q.chgPct); c.className = U.cls(q.chg);
      }
    });
  }

  // ------------------------------------------------------------- alerts (price level or day % move; once or repeating)
  const alertText = a => a.kind === 'pct' ? `${a.sym} day ${a.op === '>' ? '≥' : '≤'} ${U.fmtPct(a.px, 1)}` : `${a.sym} ${a.op} ${U.fmtPx(a.px)}`;
  function saveAlerts() { U.store.set('alerts', state.alerts); renderAlerts(); HUB.track('alerts', state.alerts.filter(a => !a.hit || a.repeat).map(a => a.sym)); if (SCREENS.ALRT && state.screen === 'ALRT') SCREENS.ALRT.refresh?.(); }
  function addAlert(sym, op, px, extra = {}) {
    const a = { id: Date.now() + Math.floor(Math.random() * 1000), sym, op, px, kind: 'px', repeat: false, note: '', created: Date.now(), hit: false, armed: true, ...extra };
    state.alerts.push(a); saveAlerts(); setTimeout(() => checkAlerts([sym]), 50);
    toast(`Alert set: ${alertText(a)}. Checked every ${HUB.settings.refreshSec} seconds while Agula is open.`, 'ok');
    return a;
  }
  function renderAlerts() {
    const el = $('#alerts'); if (!el) return;
    el.innerHTML = state.alerts.length ? state.alerts.map(a => `<div class="arow ${a.hit && !a.repeat ? 'hit' : ''}"><span>${U.esc(alertText(a))}${a.repeat ? ' ↻' : ''}</span><button class="x" data-a="${a.id}" title="Delete alert">×</button></div>`).join('')
      : '<div class="muted small">No alerts. Type <b>ALERT AAPL &gt; 250</b> or <b>ALERT AAPL +5%</b>, or open <b>ALRT</b>.</div>';
  }
  const alertLog = () => U.store.get('alertLog', []);
  function logAlert(entry) { const l = [{ t: Date.now(), ...entry }, ...alertLog()].slice(0, 150); U.store.set('alertLog', l); }
  let audio = null;
  function beep(kind) {
    if (!HUB.settings.sound) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator(), g = audio.createGain(); o.connect(g); g.connect(audio.destination);
      o.frequency.value = kind === 'bot' ? 660 : 880; g.gain.setValueAtTime(0.0001, audio.currentTime); g.gain.exponentialRampToValueAtTime(0.12, audio.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.35);
      o.start(); o.stop(audio.currentTime + 0.4);
    } catch (e) { /* audio blocked until the first click */ }
  }
  function notify(title, body) {
    if (!HUB.settings.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
    try { new Notification(title, { body, tag: 'agula-' + title }); } catch (e) { /* not allowed here */ }
  }
  function fire(text, kind = 'alert', sym = null) { toast(text, 'alert', 10000); beep(kind); notify(kind === 'bot' ? 'Agula bot' : 'Agula alert', text); logAlert({ text, kind, sym }); if (state.screen === 'ALRT') SCREENS.ALRT.refresh?.(); }
  function checkAlerts(syms) {
    if (PANE) return;                                     // the main window checks alerts; tiles don't repeat them
    let changed = false;
    state.alerts.forEach(a => {
      if ((a.hit && !a.repeat) || !syms.includes(a.sym)) return; const q = HUB.quote(a.sym); if (!q) return;
      const v = a.kind === 'pct' ? q.chgPct : q.last, cond = a.op === '>' ? v >= a.px : v <= a.px;
      if (cond && a.armed !== false && !(a.repeat && a.lastFired && Date.now() - a.lastFired < 10 * 60e3)) {
        a.hit = true; a.armed = false; a.lastFired = Date.now(); a.firedAt = v; changed = true;
        fire(`ALERT ${alertText(a)}: now ${a.kind === 'pct' ? U.fmtPct(q.chgPct) : U.fmtPx(q.last)}${a.note ? ' · ' + a.note : ''}`, 'alert', a.sym);
      } else if (!cond && a.repeat && a.armed === false) { a.armed = true; changed = true; }   // re-arm once the condition clears
    });
    if (changed) saveAlerts();
  }
  // paper-bot trades show up as alerts too (polled; cheap)
  let botSince = Date.now(), botTimer = null;
  async function pollBots() {
    clearTimeout(botTimer);
    if (!document.hidden) { try { const j = await HUB.bot.events(botSince); (j.events || []).forEach(e => { botSince = Math.max(botSince, e.t); fire(`BOT ${e.name}: ${e.side} ${U.fmt(e.qty, e.qty < 10 ? 4 : 2)} ${e.symbol} @ ${U.fmtPx(e.px)} (${e.why})`, 'bot', e.symbol); }); if (j.asof) botSince = Math.max(botSince, j.asof - 1000); } catch (e) { /* server busy */ } }
    botTimer = setTimeout(pollBots, 20e3);
  }

  // ------------------------------------------------------------- clocks & status
  function clocks() {
    const t = new Date(), f = (tz, lab) => `<span><em>${lab}</em>${t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz })}</span>`;
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone, st = HUB.status();
    const nyH = +t.toLocaleString('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }), nyM = +t.toLocaleString('en-US', { minute: 'numeric', timeZone: 'America/New_York' });
    const nyDay = t.toLocaleString('en-US', { weekday: 'short', timeZone: 'America/New_York' }), mins = nyH * 60 + nyM;
    const open = !['Sat', 'Sun'].includes(nyDay) && mins >= 570 && mins < 960;
    $('#clocks').innerHTML = f('America/New_York', 'NY') + f('Europe/London', 'LDN') + f('Asia/Tokyo', 'TKY') + (/(New_York|London|Tokyo)/.test(local) ? '' : f(local, 'LOCAL')) +
      `<span class="${open ? 'up' : 'muted'}" title="New York Stock Exchange regular session">${open ? '● NYSE OPEN' : '○ NYSE CLOSED'}</span>` +
      `<span class="simclk" title="Last data refresh">${st.pollErr ? '<b class="down">DATA ERROR</b>' : st.lastPoll ? 'UPD ' + new Date(st.lastPoll).toLocaleTimeString('en-GB') : 'CONNECTING'}</span>`;
  }
  async function renderStatus() {
    let h = null; try { h = await HUB.health(); } catch (e) { /* offline */ }
    $('#modes').innerHTML = h ? `<span class="chip live" title="Yahoo Finance quotes are delayed up to 15-20 minutes for some exchanges">LIVE DATA · YAHOO</span><span class="chip ${h.fredKey ? 'live' : 'off'}" title="FRED Treasury and macro data${h.fredKey ? ' with release calendar' : ''}">FRED${h.fredKey ? ' + CAL' : ''}</span><span class="chip live" title="Google News headlines by theme (F12)">NEWS</span>`
      : '<span class="chip off">SERVER OFFLINE</span>';
  }

  // ------------------------------------------------------------- tick loop
  function onTick(syms) {
    if (PANE) { if (syms.includes(state.sym) || !syms.length) renderHead(); const d = SCREENS[state.screen]; if (d && d.onTick && !document.hidden) { try { d.onTick(syms); } catch (e) { console.error(e); } } return; }
    updateWatch(syms.filter(s => state.watch.includes(s))); updateTape(syms.filter(s => state.watch.includes(s)));
    checkAlerts(state.alerts.map(a => a.sym));             // every poll, so an alert that is already true fires too
    if (syms.includes(state.sym) || !syms.length) renderHead();
    const def = SCREENS[state.screen];
    if (def && def.onTick && !document.hidden) { try { def.onTick(syms); } catch (e) { console.error(e); } }
    if (!syms.length) return;
  }

  function applyTheme() { document.documentElement.dataset.theme = HUB.settings.theme || 'classic'; CK.resetColors(); }
  function init() {
    applyTheme();
    if (!state.watch || !state.watch.length) state.watch = defaultWatch();
    state.watch = state.watch.map(s => HUB.resolve(s)).filter(Boolean);
    state.sym = HUB.resolve(state.sym) || 'AAPL';
    $('#fkeys').innerHTML = `<div class="ykeys" role="group" aria-label="Market sector keys">${SECTORS.map(([k, c, t]) => `<button class="ykey" data-code="${c}" title="${t}">${k}</button>`).join('')}</div>` +
      FKEYS.map((c, i) => `<button data-code="${c}" title="${SCREENS[c]?.title || c}${i <= 10 ? ` (Alt+${i === 10 ? 0 : i})` : ''}"><i>F${i + 1}</i>${c}</button>`).join('') + '<button data-code="SET"><i>⚙</i>SET</button>';
    $('#fkeys').addEventListener('click', e => { const b = e.target.closest('button'); if (b) open(b.dataset.code); });
    $('#scrHead').addEventListener('click', e => { const b = e.target.closest('[data-rel]'); if (b) open(b.dataset.rel); });
    $('#goBtn').addEventListener('click', () => { const inp = $('#cmd'), v = inp.value; inp.value = ''; $('#suggest').hidden = true; if (v.trim()) parse(v); else inp.focus(); });
    document.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
      if (/^[1-9]$/.test(e.key)) { const rel = relatedOf(state.screen)[+e.key - 1]; if (rel) { e.preventDefault(); open(rel); } }
    });
    if (PANE) {                                            // a Launchpad tile: just the function, its command line and header
      document.body.classList.add('pane'); $('#cmd').placeholder = 'Ticker or function (e.g. MSFT GP, NEWS, AAPL US EQUITY DES)';
      window.addEventListener('message', e => { if (e.origin !== location.origin || !e.data || e.data.agula !== 'link') return; if (e.data.sym && e.data.sym !== state.sym && setSym(e.data.sym, false)) { const d = SCREENS[state.screen]; if (d && d.onSym) { renderHead(); d.onSym(state.sym); } else open(state.screen); } });
      wireCmd(); clocks();
      HUB.track('sym', [state.sym]); HUB.ensureMeta([state.sym]); HUB.onTick(onTick);
      open(QS.get('fn') || 'DES');
      return;
    }
    $('#watch').addEventListener('click', e => {
      const x = e.target.closest('[data-x]'); if (x) { state.watch = state.watch.filter(s => s !== x.dataset.x); U.store.set('watch', state.watch); HUB.track('watch', state.watch); renderWatch(); renderTape(); return; }
      const r = e.target.closest('.wrow'); if (r) setSym(r.dataset.s);
    });
    $('#watchAdd').addEventListener('keydown', e => { if (e.key === 'Enter') { addWatch(e.target.value); e.target.value = ''; } });
    $('#alerts').addEventListener('click', e => { const x = e.target.closest('[data-a]'); if (x) { state.alerts = state.alerts.filter(a => String(a.id) !== x.dataset.a); saveAlerts(); } });
    $('#tapeInner').addEventListener('click', e => { const t = e.target.closest('.ti'); if (t) setSym(t.dataset.s); });
    $('#menuBtn').addEventListener('click', () => document.body.classList.toggle('side-open'));
    wireCmd(); renderWatch(); renderTape(); renderAlerts(); renderStatus(); clocks(); setInterval(clocks, 1000); setTimeout(pollBots, 4000);
    HUB.track('watch', state.watch); HUB.track('sym', [state.sym]); HUB.track('alerts', state.alerts.filter(a => !a.hit || a.repeat).map(a => a.sym));
    HUB.ensureMeta([...state.watch, state.sym]);
    HUB.onTick(onTick);
    open(U.store.get('screen', 'MON'));
  }

  const alerts = { list: () => state.alerts, add: addAlert, save: saveAlerts, text: alertText, log: alertLog, clearLog: () => U.store.set('alertLog', []),
    remove: id => { state.alerts = state.alerts.filter(a => String(a.id) !== String(id)); saveAlerts(); }, beep, notify };
  return { init, register, open, setSym, toast, saveFile, panel, kv, srcBadge, renderStatus, renderWatch, renderTape, addWatch, addAlert, alerts, applyTheme, relatedOf, state, SCREENS, FKEYS, SECTORS, PANE, $, $$ };
})();
