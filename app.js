/* ============================================================================
   Agula Terminal — shell: command line, router, watchlist, tape, alerts
   ========================================================================== */
'use strict';

const APP = (() => {
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const state = {
    sym: U.store.get('sym', 'AAPL'), screen: null, history: U.store.get('cmdHist', []), histIdx: -1,
    watch: U.store.get('watch', null), alerts: U.store.get('alerts', []),
  };
  const SCREENS = {};
  const FKEYS = ['HELP', 'MON', 'DES', 'CHART', 'DCF', 'OPT', 'PORT', 'CURVE', 'FX', 'SCRN', 'ECO', 'NEWS'];
  const ALIAS = { GP: 'CHART', G: 'CHART', CN: 'DES', Q: 'DES', QUOTE: 'DES', VAL: 'DCF', VALUE: 'DCF', OPTIONS: 'OPT', OMON: 'OPT', RISK: 'PORT', PRT: 'PORT', BOND: 'CURVE', YC: 'CURVE', FI: 'CURVE',
    FXC: 'FX', SCREEN: 'SCRN', EQS: 'SCRN', CAL: 'ECO', CALENDAR: 'ECO', MACRO: 'ECO', MARKET: 'MON', TOP: 'MON', N: 'NEWS', HEADLINES: 'NEWS', WIRE: 'NEWS', SETTINGS: 'SET', '?': 'HELP' };

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
    if (state.screen && SCREENS[state.screen]?.destroy) { try { SCREENS[state.screen].destroy(); } catch (e) { console.error(e); } }
    HUB.track('screen', []);
    state.screen = code; U.store.set('screen', code);
    $$('#fkeys button').forEach(b => b.classList.toggle('on', b.dataset.code === code));
    const root = $('#screen'); root.innerHTML = ''; root.className = 'screen scr-' + code.toLowerCase(); root.onclick = null;
    const fresh = root.cloneNode(false); root.replaceWith(fresh);   // drop listeners from the previous function
    renderHead();
    try { const r = def.render(fresh, { sym: state.sym }); if (r && r.catch) r.catch(e => { console.error(e); fresh.innerHTML = `<div class="empty err">${U.esc(e.message)}</div>`; }); }
    catch (e) { console.error(e); fresh.innerHTML = `<div class="empty err">${U.esc(e.message)}</div>`; }
    fresh.scrollTop = 0;
  }
  function renderHead() {
    const def = SCREENS[state.screen]; if (!def) return;
    const q = HUB.quote(state.sym), m = HUB.meta(state.sym), rate = m.cls === 'RATE';
    $('#scrHead').innerHTML = `<span class="fcode">${def.code}</span><span class="ftitle">${def.title}</span>` +
      (def.global ? '' : `<span class="hsym">${U.esc(state.sym)}</span><span class="hname">${U.esc(m.name)}</span>${srcBadge(state.sym)}` +
        (q ? `<span class="hpx">${U.fmtPx(q.last, rate ? 3 : undefined)}${rate ? '%' : ''}</span><span class="${U.cls(q.chg)}">${rate ? U.fmtBp(q.chg / 100) : U.fmtSigned(q.chg, U.decimalsFor(q.last)) + ' (' + U.fmtPct(q.chgPct) + ')'}</span>` : ''));
  }
  function setSym(sym, rerender = true) {
    const s = HUB.resolve(sym);
    if (!s) { toast(HUB.why(sym), 'err', 6000); return false; }
    state.sym = s; U.store.set('sym', s);
    HUB.track('sym', [s]); HUB.ensureMeta([s]);
    if (!HUB.quote(s)) HUB.refreshQuote(s).then(q => { if (!q) toast(`No quote for ${s}. Check the symbol (Yahoo format).`, 'err', 6000); renderHead(); }).catch(e => toast(e.message, 'err'));
    if (rerender && state.screen) { const def = SCREENS[state.screen]; open(def.global ? 'DES' : state.screen); }
    renderWatch();
    return true;
  }

  // ------------------------------------------------------------- command line
  function parse(raw) {
    const text = raw.trim(); if (!text) return;
    state.history = [text, ...state.history.filter(x => x !== text)].slice(0, 40); U.store.set('cmdHist', state.history); state.histIdx = -1;
    const up = text.toUpperCase(), parts = up.split(/\s+/);
    if (parts[0] === 'NEWS' && parts.length > 1 && SCREENS.NEWS.themeFor(parts.slice(1).join(' '))) { SCREENS.NEWS.theme = SCREENS.NEWS.themeFor(parts.slice(1).join(' ')); open('NEWS'); return; }
    if (parts[0] === 'ALERT') {
      const m = up.match(/^ALERT\s+(\S+)\s*(>|<|>=|<=|ABOVE|BELOW)\s*([\d.]+)$/) || up.match(/^ALERT\s*(>|<|>=|<=|ABOVE|BELOW)\s*([\d.]+)$/);
      if (!m) { toast('Alert format: ALERT AAPL > 250', 'err'); return; }
      const [sym, op, px] = m.length === 4 ? [m[1], m[2], +m[3]] : [state.sym, m[1], +m[2]];
      const s = HUB.resolve(sym); if (!s) { toast(HUB.why(sym), 'err'); return; }
      addAlert(s, op === 'ABOVE' || op[0] === '>' ? '>' : '<', px); return;
    }
    if (parts[0] === 'CMP' || parts[0] === 'COMPARE') { open('CHART'); setTimeout(() => SCREENS.CHART.compare && SCREENS.CHART.compare(parts.slice(1)), 0); return; }
    if (parts[0] === 'WATCH' || parts[0] === 'W+') { parts.slice(1).forEach(addWatch); return; }
    const fn = parts.find(p => SCREENS[p] || ALIAS[p]);
    const code = fn ? (SCREENS[fn] ? fn : ALIAS[fn]) : null;
    const symTok = parts.find(p => p !== fn);
    if (symTok && !setSym(symTok, false)) return;
    if (code) open(code); else if (symTok) open(SCREENS[state.screen]?.global ? 'DES' : (state.screen || 'DES'));
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

  // ------------------------------------------------------------- alerts
  function addAlert(sym, op, px) {
    state.alerts.push({ id: Date.now(), sym, op, px, hit: false }); U.store.set('alerts', state.alerts); renderAlerts(); HUB.track('alerts', state.alerts.map(a => a.sym));
    toast(`Alert set: ${sym} ${op} ${U.fmtPx(px)}. Checked every ${HUB.settings.refreshSec} seconds while this tab is open.`, 'ok');
  }
  function renderAlerts() {
    $('#alerts').innerHTML = state.alerts.length ? state.alerts.map(a => `<div class="arow ${a.hit ? 'hit' : ''}"><span>${U.esc(a.sym)} ${a.op} ${U.fmtPx(a.px)}</span><button class="x" data-a="${a.id}" title="Delete alert">×</button></div>`).join('')
      : '<div class="muted small">No alerts. Type <b>ALERT AAPL &gt; 250</b>.</div>';
  }
  function checkAlerts(syms) {
    let changed = false;
    state.alerts.forEach(a => { if (a.hit || !syms.includes(a.sym)) return; const q = HUB.quote(a.sym); if (!q) return; if ((a.op === '>' && q.last >= a.px) || (a.op === '<' && q.last <= a.px)) { a.hit = true; changed = true; toast(`ALERT ${a.sym} ${a.op} ${U.fmtPx(a.px)}: now ${U.fmtPx(q.last)}`, 'alert', 10000); } });
    if (changed) { U.store.set('alerts', state.alerts); renderAlerts(); }
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
    updateWatch(syms.filter(s => state.watch.includes(s))); updateTape(syms.filter(s => state.watch.includes(s)));
    checkAlerts(syms);
    if (syms.includes(state.sym) || !syms.length) renderHead();
    const def = SCREENS[state.screen];
    if (def && def.onTick && !document.hidden) { try { def.onTick(syms); } catch (e) { console.error(e); } }
    if (!syms.length) return;
  }

  function init() {
    if (!state.watch || !state.watch.length) state.watch = defaultWatch();
    state.watch = state.watch.map(s => HUB.resolve(s)).filter(Boolean);
    state.sym = HUB.resolve(state.sym) || 'AAPL';
    $('#fkeys').innerHTML = FKEYS.map((c, i) => `<button data-code="${c}" title="${SCREENS[c]?.title || c}${i <= 10 ? ` (Alt+${i === 10 ? 0 : i})` : ''}"><i>F${i + 1}</i>${c}</button>`).join('') + '<button data-code="SET"><i>⚙</i>SET</button>';
    $('#fkeys').addEventListener('click', e => { const b = e.target.closest('button'); if (b) open(b.dataset.code); });
    $('#watch').addEventListener('click', e => {
      const x = e.target.closest('[data-x]'); if (x) { state.watch = state.watch.filter(s => s !== x.dataset.x); U.store.set('watch', state.watch); HUB.track('watch', state.watch); renderWatch(); renderTape(); return; }
      const r = e.target.closest('.wrow'); if (r) setSym(r.dataset.s);
    });
    $('#watchAdd').addEventListener('keydown', e => { if (e.key === 'Enter') { addWatch(e.target.value); e.target.value = ''; } });
    $('#alerts').addEventListener('click', e => { const x = e.target.closest('[data-a]'); if (x) { state.alerts = state.alerts.filter(a => String(a.id) !== x.dataset.a); U.store.set('alerts', state.alerts); renderAlerts(); } });
    $('#tapeInner').addEventListener('click', e => { const t = e.target.closest('.ti'); if (t) setSym(t.dataset.s); });
    $('#menuBtn').addEventListener('click', () => document.body.classList.toggle('side-open'));
    wireCmd(); renderWatch(); renderTape(); renderAlerts(); renderStatus(); clocks(); setInterval(clocks, 1000);
    HUB.track('watch', state.watch); HUB.track('sym', [state.sym]); HUB.track('alerts', state.alerts.filter(a => !a.hit).map(a => a.sym));
    HUB.ensureMeta([...state.watch, state.sym]);
    HUB.onTick(onTick);
    open(U.store.get('screen', 'MON'));
  }

  return { init, register, open, setSym, toast, saveFile, panel, kv, srcBadge, renderStatus, renderWatch, renderTape, addWatch, addAlert, state, SCREENS, FKEYS, $, $$ };
})();
