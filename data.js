/* ============================================================================
   Agula Terminal — data layer: talks to the Python server (agula.py)
   quotes (polled, shared store) · history · company data · options · rates
   ========================================================================== */
'use strict';

const HUB = (() => {
  const API = ((document.querySelector('meta[name="agula-api"]') || {}).content || '').replace(/\/$/, '');
  const settings = Object.assign({ refreshSec: 15, rfOverride: null }, U.store.get('settings', {}));
  const SYM_RE = /^[A-Z0-9.\-=^]{1,20}$/;

  // Friendly names people type -> Yahoo symbols
  const ALIAS = {
    SPX: '^GSPC', SP500: '^GSPC', NDX: '^NDX', NASDAQ: '^IXIC', DJI: '^DJI', DOW: '^DJI', RUT: '^RUT', VIX: '^VIX', DAX: '^GDAXI', FTSE: '^FTSE', NIKKEI: '^N225', HSI: '^HSI', STOXX: '^STOXX50E',
    US3M: '^IRX', US5Y: '^FVX', US10Y: '^TNX', UST10Y: '^TNX', US30Y: '^TYX', DXY: 'DX-Y.NYB',
    GOLD: 'GC=F', SILVER: 'SI=F', OIL: 'CL=F', WTI: 'CL=F', BRENT: 'BZ=F', COPPER: 'HG=F', NATGAS: 'NG=F',
    BTC: 'BTC-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', XRP: 'XRP-USD', BNB: 'BNB-USD',
    EURUSD: 'EURUSD=X', GBPUSD: 'GBPUSD=X', AUDUSD: 'AUDUSD=X', NZDUSD: 'NZDUSD=X', USDJPY: 'JPY=X', USDCHF: 'CHF=X', USDCAD: 'CAD=X', USDCNY: 'CNY=X', USDMNT: 'MNT=X', USDKRW: 'KRW=X',
  };
  const NAMES = {
    '^GSPC': 'S&P 500', '^NDX': 'Nasdaq 100', '^IXIC': 'Nasdaq Composite', '^DJI': 'Dow Jones Industrial', '^RUT': 'Russell 2000', '^VIX': 'CBOE Volatility Index',
    '^STOXX50E': 'Euro Stoxx 50', '^GDAXI': 'DAX', '^FTSE': 'FTSE 100', '^N225': 'Nikkei 225', '^HSI': 'Hang Seng',
    '^IRX': 'US 13-week T-bill yield', '^FVX': 'US 5-year Treasury yield', '^TNX': 'US 10-year Treasury yield', '^TYX': 'US 30-year Treasury yield', 'DX-Y.NYB': 'US Dollar Index',
    'GC=F': 'Gold futures', 'SI=F': 'Silver futures', 'CL=F': 'WTI crude futures', 'BZ=F': 'Brent crude futures', 'HG=F': 'Copper futures', 'NG=F': 'Natural gas futures',
    'BTC-USD': 'Bitcoin', 'ETH-USD': 'Ether', 'SOL-USD': 'Solana', 'EURUSD=X': 'EUR/USD', 'GBPUSD=X': 'GBP/USD', 'AUDUSD=X': 'AUD/USD', 'JPY=X': 'USD/JPY', 'CHF=X': 'USD/CHF',
    'CAD=X': 'USD/CAD', 'CNY=X': 'USD/CNY', 'MNT=X': 'USD/MNT',
    XLK: 'Technology SPDR', XLC: 'Communication Services SPDR', XLY: 'Consumer Discretionary SPDR', XLP: 'Consumer Staples SPDR', XLF: 'Financials SPDR', XLV: 'Health Care SPDR',
    XLE: 'Energy SPDR', XLI: 'Industrials SPDR', XLB: 'Materials SPDR', XLU: 'Utilities SPDR', XLRE: 'Real Estate SPDR',
  };
  const RATE = new Set(['^IRX', '^FVX', '^TNX', '^TYX']);

  // ------------------------------------------------------------- HTTP
  const memo = new Map(), inflight = new Map();
  async function get(path, params = {}, ttl = 0) {
    const qs = new URLSearchParams(params).toString(), url = API + path + (qs ? '?' + qs : '');
    const hit = memo.get(url); if (ttl && hit && Date.now() - hit.t < ttl) return hit.v;
    if (inflight.has(url)) return inflight.get(url);
    const p = (async () => {
      let r;
      try { r = await fetch(url); } catch (e) { throw new Error('Cannot reach the Agula server. Is agula.py running?'); }
      let j = null; try { j = await r.json(); } catch (e) { /* non-JSON */ }
      if (!r.ok) throw new Error((j && j.detail) || `Server returned ${r.status}`);
      if (ttl) memo.set(url, { t: Date.now(), v: j });
      return j;
    })();
    inflight.set(url, p); try { return await p; } finally { inflight.delete(url); }
  }

  // ------------------------------------------------------------- symbols & metadata
  function resolve(sym) {
    let s = String(sym || '').toUpperCase().trim().replace(/\s+/g, '');
    if (ALIAS[s]) s = ALIAS[s];
    const CCY = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'CNY', 'MNT', 'KRW', 'HKD', 'SGD', 'INR', 'SEK', 'NOK'];
    if (/^[A-Z]{6}$/.test(s) && CCY.includes(s.slice(0, 3)) && CCY.includes(s.slice(3))) s = s.startsWith('USD') ? s.slice(3) + '=X' : s + '=X'; // EURJPY -> EURJPY=X, USDJPY -> JPY=X
    if (/^[A-Z]{2,6}USDT$/.test(s)) s = s.replace(/USDT$/, '-USD');
    return SYM_RE.test(s) ? s : null;
  }
  const why = sym => `"${sym}" is not a valid symbol. Use Yahoo Finance symbols: AAPL, ^GSPC, EURUSD=X, GC=F, BTC-USD.`;
  const meta = new Map(Object.entries(U.store.get('meta', {})));
  function cls(sym) {
    if (RATE.has(sym)) return 'RATE';
    const m = meta.get(sym);
    if (m && m.type) return { EQUITY: 'EQ', ETF: 'ETF', INDEX: 'IDX', CURRENCY: 'FX', FUTURE: 'CMDTY', CRYPTOCURRENCY: 'CRYPTO', MUTUALFUND: 'ETF' }[m.type] || 'EQ';
    if (sym.startsWith('^')) return 'IDX'; if (sym.endsWith('=X')) return 'FX'; if (sym.endsWith('=F')) return 'CMDTY'; if (/-USD$/.test(sym)) return 'CRYPTO';
    return 'EQ';
  }
  function metaOf(sym) { const m = meta.get(sym) || {}; return { sym, name: m.name || NAMES[sym] || sym, cls: cls(sym), sector: m.sector, industry: m.industry, ccy: m.currency || 'USD', exchange: m.exchange }; }
  let metaTimer = null; const metaWant = new Set();
  function ensureMeta(syms) {
    syms.forEach(s => { if (!meta.has(s) && !NAMES[s]) metaWant.add(s); });
    if (!metaWant.size || metaTimer) return;
    metaTimer = setTimeout(async () => {
      metaTimer = null; const list = [...metaWant].slice(0, 40); list.forEach(s => metaWant.delete(s));
      try { const j = await get('/api/meta', { symbols: list.join(',') }); Object.entries(j.meta || {}).forEach(([k, v]) => meta.set(k, v)); U.store.set('meta', Object.fromEntries([...meta].slice(-300))); emit(list); }
      catch (e) { /* names are optional */ }
      if (metaWant.size) ensureMeta([]);
    }, 300);
  }

  // ------------------------------------------------------------- quotes (shared polling store)
  const quotes = new Map(), listeners = new Set(), sets = new Map();
  let lastPoll = 0, pollErr = null, pollTimer = null;
  const emit = syms => listeners.forEach(fn => { try { fn(syms); } catch (e) { console.error(e); } });
  function track(key, syms) { sets.set(key, [...new Set(syms.filter(Boolean))]); schedule(true); }
  function wanted() { const all = new Set(); sets.forEach(v => v.forEach(s => all.add(s))); return [...all]; }
  async function poll() {
    const syms = wanted(); if (!syms.length) return;
    const changed = [];
    for (let i = 0; i < syms.length; i += 100) {
      try {
        const j = await get('/api/quotes', { symbols: syms.slice(i, i + 100).join(',') });
        Object.entries(j.quotes || {}).forEach(([s, q]) => { const old = quotes.get(s); if (!old || old.last !== q.last || old.t !== q.t) changed.push(s); quotes.set(s, q); });
        pollErr = null;
      } catch (e) { pollErr = e.message; }
    }
    lastPoll = Date.now();
    ensureMeta(syms);
    if (changed.length) emit(changed); else emit([]);
  }
  function schedule(now) {
    clearTimeout(pollTimer);
    const run = async () => { if (!document.hidden) await poll(); pollTimer = setTimeout(run, Math.max(5, settings.refreshSec) * 1000); };
    pollTimer = setTimeout(run, now ? 150 : settings.refreshSec * 1000);
  }
  const quote = sym => quotes.get(sym) || null;
  async function refreshQuote(sym) { const j = await get('/api/quotes', { symbols: sym }); const q = (j.quotes || {})[sym]; if (q) { quotes.set(sym, q); emit([sym]); } return q || null; }

  // ------------------------------------------------------------- datasets
  const histCache = new Map();
  async function history(sym, tf = '1D') {
    const key = sym + '|' + tf, hit = histCache.get(key), ttl = tf === '1D' || tf === '1W' ? 10 * 60e3 : 60e3;
    if (hit && Date.now() - hit.t < ttl) return withLive(sym, tf, hit.bars);
    const j = await get('/api/history', { symbol: sym, tf });
    const bars = j.bars.map(b => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] || 0 }));
    histCache.set(key, { t: Date.now(), bars }); return withLive(sym, tf, bars);
  }
  function withLive(sym, tf, bars) {
    // fold the latest polled quote into the last bar so charts move between history refreshes
    const q = quotes.get(sym); if (!q || !bars.length) return bars;
    const b = bars[bars.length - 1];
    if (q.t >= b.t) { b.c = q.last; b.h = Math.max(b.h, q.last); b.l = Math.min(b.l, q.last); }
    return bars;
  }
  const profile = sym => get('/api/profile', { symbol: sym }, 30 * 60e3).then(j => j.info);
  const fundamentals = sym => get('/api/fundamentals', { symbol: sym }, 60 * 60e3);
  const news = sym => get('/api/news', { symbol: sym }, 10 * 60e3).then(j => j.news);
  const book = sym => get('/api/book', { symbol: sym }, 1500);
  const expirations = sym => get('/api/options', { symbol: sym }, 0);   // {expirations, status: ok|none|unavailable, source}
  const chain = (sym, exp) => get('/api/options/chain', { symbol: sym, expiry: exp }, 3 * 60e3);
  const surface = (sym, spot) => get('/api/options/surface', { symbol: sym, spot: spot.toFixed(2) }, 5 * 60e3).then(j => j.slices);
  const universe = () => get('/api/universe', {}, 5 * 60e3);
  const macro = () => get('/api/macro', {}, 30 * 60e3);
  const calendar = () => get('/api/calendar', {}, 30 * 60e3);
  const fxRates = () => get('/api/fx/rates', {}, 60 * 60e3).then(j => j.rates);
  // Damodaran's cost-of-capital data, with the industry and country matched to a company
  const damodaran = (industry, sector, country) => get('/api/damodaran', { industry: industry || '', sector: sector || '', country: country || '' }, 6 * 3600e3);
  // Excel model built on the server (formulas, charts, tables); returns a Blob
  async function dcfWorkbook(payload) {
    let r;
    try { r = await fetch(API + '/api/dcf/xlsx', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }); }
    catch (e) { throw new Error('Cannot reach the Agula server to build the Excel file.'); }
    if (!r.ok) { let j = null; try { j = await r.json(); } catch (e) { /* not JSON */ } throw new Error((j && j.detail) || `Excel export failed (${r.status})`); }
    return r.blob();
  }
  const headlines = () => get('/api/headlines', {}, 5 * 60e3);
  const sparks = syms => get('/api/sparks', { symbols: syms.join(',') }, 60e3).then(j => j.sparks);
  const search = q => get('/api/search', { q }, 30 * 60e3).then(j => j.results);
  const health = () => get('/health', {}, 60e3);
  let curveP = null, rfVal = null;
  function curve() { if (!curveP) curveP = get('/api/curve', {}, 60 * 60e3).then(c => { const y10 = c.now.find(x => x[0] === 10); if (y10) rfVal = y10[1]; return c; }).catch(e => { curveP = null; throw e; }); return curveP; }

  function rf() { if (U.isNum(settings.rfOverride)) return settings.rfOverride; return rfVal ?? 0.042; }
  function saveSettings(patch) { Object.assign(settings, patch); U.store.set('settings', settings); if ('refreshSec' in patch) schedule(true); }
  curve().catch(() => {});

  return {
    API, settings, saveSettings, resolve, why, meta: metaOf, ensureMeta, cls, RATE, NAMES,
    track, quote, refreshQuote, history, profile, fundamentals, news, book, expirations, chain, surface, universe, macro, calendar, fxRates, sparks, search, health, curve, headlines, damodaran, dcfWorkbook, rf,
    onTick: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    status: () => ({ lastPoll, pollErr }), src: sym => /-USD$/.test(sym) ? 'YAHOO+BINANCE' : 'YAHOO', isLive: () => true,
  };
})();
