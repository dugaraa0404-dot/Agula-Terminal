/* ============================================================================
   Agula Terminal — core screens: HELP · MON · DES · CHART · ECO · SET
   ========================================================================== */
'use strict';

(() => {
  const { panel, kv, $, $$ } = APP;
  const esc = U.esc;
  const pxf = (s, v) => U.fmtPx(v, HUB.RATE.has(s) ? 3 : undefined);
  const chgf = (s, q) => HUB.RATE.has(s) ? U.fmtBp(q.chg / 100) : U.fmtPct(q.chgPct);
  const errBox = e => `<div class="empty err">${esc(e.message || e)}</div>`;

  // ======================================================================== HELP
  APP.register('HELP', {
    title: 'Functions & Commands', global: true,
    render(root) {
      const rows = [
        ['MON', 'Market monitor: world indices, Treasury yields, FX, commodities, crypto, S&P heatmap, sectors, breadth, regime'],
        ['DES', 'Security overview: quote, statistics, analyst targets, profile, financials, order book (crypto), news'],
        ['CHART', 'Candlestick chart: 1m to weekly, 8 overlays, 5 indicators, compare, levels, return statistics'],
        ['DCF', 'DCF from annual filings with Damodaran\'s cost of capital (industry beta, implied ERP, synthetic rating), drivers from history, scenarios, Monte Carlo, Excel model with charts'],
        ['OPT', 'Real option chains: Greeks, implied-volatility smile and surface, strategy builder, pricer'],
        ['PORT', 'Portfolio: P&L, VaR/CVaR three ways, correlation, efficient frontier, risk parity, stress tests'],
        ['CURVE', 'US Treasury curve from FRED: fitted, zero and forward curves, shifts, bond calculator, key-rate durations'],
        ['FX', 'Cross rates incl. MNT, converter, forwards from interest parity, carry-to-risk, correlations'],
        ['SCRN', 'Screener of 65 US large caps with filter expressions, factor score and scatter plot'],
        ['ECO', 'US economic calendar and FRED macro dashboard (inflation, jobs, growth, credit)'],
        ['NEWS', 'Market news by theme (Fed, inflation, geopolitics, energy, Asia, tech, crypto, Mongolia) next to the prices each theme moves'],
        ['SET', 'Refresh rate, risk-free rate, server status'],
      ];
      root.innerHTML = `<div class="grid g2">
        ${panel('Functions', `<table class="tbl"><tbody>${rows.map(([c, d], i) => `<tr class="clk" data-open="${c}"><td class="key">${c}</td><td class="wrap">${d}</td><td class="muted r">${i < 11 ? 'Alt+' + (i + 1 === 11 ? 0 : i + 1) : ''}</td></tr>`).join('')}</tbody></table>`)}
        <div class="stack">
        ${panel('Commands', `<table class="tbl"><tbody>
          <tr><td class="key">AAPL</td><td>Load a security on the current function</td></tr>
          <tr><td class="key">MSFT DCF</td><td>Security + function, in either order</td></tr>
          <tr><td class="key">SPX · GOLD · BTC · USDMNT</td><td>Short names work (→ ^GSPC, GC=F, BTC-USD, MNT=X)</td></tr>
          <tr><td class="key">CMP AAPL MSFT SPX</td><td>Compare performance on one chart</td></tr>
          <tr><td class="key">ALERT NVDA &gt; 200</td><td>Price alert (also &lt;)</td></tr>
          <tr><td class="key">WATCH TSM ASML</td><td>Add to the watchlist</td></tr>
          <tr><td class="key">NEWS FED · NEWS MONGOLIA</td><td>Open the news wire on one theme</td></tr>
        </tbody></table><p class="note">Any Yahoo Finance symbol works: US and foreign stocks (7203.T, SAP.DE), ETFs, indices (^N225), futures (CL=F), FX (EURJPY=X) and crypto (ETH-USD). Start typing a company name for suggestions.</p>`)}
        ${panel('Keyboard', `<table class="tbl"><tbody>
          <tr><td class="key">/ or Ctrl+K</td><td>Focus the command line</td></tr>
          <tr><td class="key">Tab · ↑ ↓</td><td>Accept suggestion · command history</td></tr>
          <tr><td class="key">Alt+1 … Alt+0</td><td>Function keys F2–F11</td></tr>
          <tr><td class="key">Chart</td><td>Wheel to zoom, drag to pan, double-click to reset, Alt+click to draw a level</td></tr>
        </tbody></table>`)}
        ${panel('Data sources', `<p class="note">Prices, company data, statements, option chains and news: <b>Yahoo Finance</b> (via yfinance; delayed up to 15–20 minutes on some exchanges). Treasury curve and macro data: <b>FRED</b>, Federal Reserve Bank of St. Louis. Crypto order books: <b>Binance</b> public market data. Extra headlines: <b>Google News</b>.</p><p class="note">For research and education. Not investment advice; verify important figures against company filings.</p>`)}
        </div></div>`;
      root.addEventListener('click', e => { const r = e.target.closest('[data-open]'); if (r) APP.open(r.dataset.open); });
    },
  });

  // ======================================================================== MON
  const GROUPS = [
    ['Equity indices', ['^GSPC', '^NDX', '^DJI', '^RUT', '^VIX', '^STOXX50E', '^N225', '^HSI']],
    ['US Treasury yields', ['^IRX', '^FVX', '^TNX', '^TYX']],
    ['Currencies', ['DX-Y.NYB', 'EURUSD=X', 'GBPUSD=X', 'JPY=X', 'CHF=X', 'CAD=X', 'AUDUSD=X', 'CNY=X', 'MNT=X']],
    ['Commodities', ['GC=F', 'SI=F', 'CL=F', 'BZ=F', 'HG=F', 'NG=F']],
    ['Crypto', ['BTC-USD', 'ETH-USD', 'SOL-USD']],
  ];
  const SECT = ['XLK', 'XLC', 'XLY', 'XLP', 'XLF', 'XLV', 'XLE', 'XLI', 'XLB', 'XLU', 'XLRE'];
  const tileId = s => s.replace(/[^A-Za-z0-9]/g, '_');
  function tile(s) {
    return `<div class="tile clk" data-s="${esc(s)}"><div class="t1"><b>${esc(s)}</b><span id="mt-c-${tileId(s)}">—</span></div><div class="t2">${esc(HUB.meta(s).name)}</div><div class="t3"><span id="mt-l-${tileId(s)}" class="tl">—</span>${HUB.RATE.has(s) ? '<em>%</em>' : ''}</div><canvas class="spk" id="mt-s-${tileId(s)}"></canvas></div>`;
  }
  function updTile(s) {
    const q = HUB.quote(s); if (!q) return;
    const l = document.getElementById('mt-l-' + tileId(s)), c = document.getElementById('mt-c-' + tileId(s)); if (!l) return;
    l.textContent = pxf(s, q.last); c.textContent = chgf(s, q); c.className = U.cls(q.chg);
  }
  let monTimers = [];
  APP.register('MON', {
    title: 'Market Monitor', global: true,
    async render(root) {
      const all = GROUPS.flatMap(g => g[1]);
      root.innerHTML = `<div class="mon-groups">${GROUPS.map(([g, list]) => `<section class="grp"><h4>${g}</h4><div class="tiles">${list.map(tile).join('')}</div></section>`).join('')}</div>
        <div class="grid g3 mt">
          ${panel('S&amp;P large caps · size = market cap, colour = today', '<div class="cv tall"><canvas id="monTree"></canvas></div>', { cls: 'span2' })}
          ${panel('Market regime', '<div id="monRegime"><div class="muted small">Loading…</div></div>')}
          ${panel('US sectors today (SPDR sector ETFs)', '<div class="cv"><canvas id="monSect"></canvas></div>')}
          ${panel('Top movers · large caps', '<div id="monMovers"><div class="muted small">Loading…</div></div>')}
          ${panel('Breadth · large caps', '<div id="monBreadth"><div class="muted small">Loading…</div></div>')}
        </div>`;
      root.addEventListener('click', e => { const t = e.target.closest('[data-s]'); if (t) APP.open('DES', t.dataset.s); });
      HUB.track('screen', [...all, ...SECT]); HUB.ensureMeta(all);
      all.forEach(updTile);
      const sparks = () => HUB.sparks(all).then(sp => Object.entries(sp).forEach(([s, d]) => { const el = document.getElementById('mt-s-' + tileId(s)); if (el) CK.spark(el, d); })).catch(() => {});
      sparks();
      this.loadUniverse(all);
      regimeHTML().then(h => { const el = $('#monRegime'); if (el) el.innerHTML = h; }).catch(e => { const el = $('#monRegime'); if (el) el.innerHTML = errBox(e); });
      monTimers.forEach(clearInterval); monTimers = [setInterval(sparks, 60e3), setInterval(() => this.panels(), 15e3)];
    },
    async loadUniverse(all) {
      try { const u = await HUB.universe(); this.u = u.rows; window.AGULA_UNIVERSE = u.rows; HUB.track('screen', [...all, ...SECT, ...u.rows.map(r => r.sym)]); this.panels(); }
      catch (e) { const el = $('#monMovers'); if (el) el.innerHTML = errBox(e); }
    },
    panels() {
      const sq = SECT.map(s => [s, HUB.quote(s)]).filter(x => x[1]).sort((a, b) => b[1].chgPct - a[1].chgPct);
      const se = $('#monSect'); if (se && sq.length) CK.bars(se, { horizontal: true, labels: sq.map(([s]) => HUB.NAMES[s].replace(' SPDR', '').replace('Consumer ', 'Cons. ').replace('Communication Services', 'Comm. Services')), values: sq.map(x => x[1].chgPct), fmt: v => U.fmtPct(v), padL: 120 });
      if (!this.u) return;
      const rows = this.u.map(r => ({ ...r, chg: HUB.quote(r.sym)?.chgPct ?? r.chg, price: HUB.quote(r.sym)?.last ?? r.price })).filter(r => U.isNum(r.chg));
      const tree = $('#monTree'); if (tree) CK.treemap(tree, rows.filter(r => r.cap).map(r => ({ label: r.sym, value: r.cap, chg: r.chg })), { scale: 0.025, onClick: r => APP.open('DES', r.label) });
      const mv = [...rows].sort((a, b) => b.chg - a.chg);
      const mrow = e => `<tr class="clk" data-s="${e.sym}"><td class="key">${e.sym}</td><td class="muted">${esc(e.name)}</td><td class="r">${U.fmtPx(e.price)}</td><td class="r ${U.cls(e.chg)}">${U.fmtPct(e.chg)}</td></tr>`;
      const m = $('#monMovers'); if (m) m.innerHTML = `<table class="tbl"><tbody>${mv.slice(0, 5).map(mrow).join('')}<tr class="sep"><td colspan="4"></td></tr>${mv.slice(-5).reverse().map(mrow).join('')}</tbody></table>`;
      const adv = rows.filter(r => r.chg > 0).length, dec = rows.filter(r => r.chg < 0).length, a50 = this.u.filter(r => r.above50).length, a200 = this.u.filter(r => r.above200).length, n = this.u.length;
      const capW = U.sum(rows.filter(r => r.cap).map(r => r.cap * r.chg)) / U.sum(rows.filter(r => r.cap).map(r => r.cap));
      const b = $('#monBreadth'); if (b) b.innerHTML = `<div class="breadth"><div class="bb"><span class="up" style="flex:${adv || 0.001}">${adv} up</span><span class="down" style="flex:${dec || 0.001}">${dec} down</span></div></div>
        ${kv('Above 50-day average', `${a50}/${n} (${Math.round(a50 / n * 100)}%)`)}${kv('Above 200-day average', `${a200}/${n} (${Math.round(a200 / n * 100)}%)`)}${kv('Cap-weighted move today', U.fmtPct(capW), U.cls(capW))}`;
    },
    onTick(syms) { syms.forEach(updTile); },
    destroy() { monTimers.forEach(clearInterval); monTimers = []; },
  });
  async function regimeHTML() {
    const [curve, vixB, spxB, dxyB, oilB, macro] = await Promise.all([HUB.curve().catch(() => null), HUB.history('^VIX', '1D'), HUB.history('^GSPC', '1D'), HUB.history('DX-Y.NYB', '1D').catch(() => null), HUB.history('CL=F', '1D').catch(() => null), HUB.macro().catch(() => null)]);
    const vix = vixB.map(b => b.c), vNow = U.last(vix), vPct = vix.slice(-252).filter(x => x < vNow).length / Math.min(252, vix.length);
    const spx = spxB.map(b => b.c), trend = U.last(spx) / U.mean(spx.slice(-200)) - 1;
    const ch1m = b => b && b.length > 22 ? U.last(b).c / b[b.length - 22].c - 1 : null;
    const usd = ch1m(dxyB), oil = ch1m(oilB);
    const y = t => curve ? (curve.now.find(x => Math.abs(x[0] - t) < 1e-6) || [0, NaN])[1] : NaN;
    const s210 = (y(10) - y(2)) * 1e4, s3m = (y(10) - y(0.25)) * 1e4;
    const hy = macro ? (macro.indicators.find(i => i.id === 'BAMLH0A0HYM2') || {}).value : null;
    const rows = [
      ['2s10s curve', isFinite(s210) ? `${s210.toFixed(0)}bp` : '—', s210 < 0 ? 'Inverted: markets expect rate cuts; historically a recession warning.' : s210 < 50 ? 'Flat to modestly positive.' : 'Steep: growth/inflation expectations or term premium rising.', s210 < 0 ? 'down' : 'flat'],
      ['3m10y curve', isFinite(s3m) ? `${s3m.toFixed(0)}bp` : '—', s3m < 0 ? 'Inverted at the front end.' : 'Positive.', s3m < 0 ? 'down' : 'flat'],
      ['VIX', `${U.fmt(vNow, 1)} · ${Math.round(vPct * 100)}th pct 1y`, vPct > 0.8 ? 'Stress: hedging demand is high.' : vPct < 0.25 ? 'Calm: complacency risk.' : 'Normal range.', vPct > 0.8 ? 'down' : 'flat'],
      ['S&P 500 trend', U.fmtPct(trend, 1) + ' vs 200d', trend > 0 ? 'Above its 200-day average: uptrend.' : 'Below its 200-day average: downtrend.', trend > 0 ? 'up' : 'down'],
      ['High-yield spread', hy != null ? hy.toFixed(2) + '%' : '—', hy == null ? '' : hy > 5 ? 'Wide: credit stress.' : hy < 3.5 ? 'Tight: strong risk appetite.' : 'Middle of its range.', hy > 5 ? 'down' : 'flat'],
      ['US dollar 1m', U.fmtPct(usd, 1), usd > 0.01 ? 'Strengthening: tighter global financial conditions.' : usd < -0.01 ? 'Weakening: supportive for commodities and EM.' : 'Little change.', 'flat'],
      ['WTI oil 1m', U.fmtPct(oil, 1), oil > 0.08 ? 'Rising energy costs add to headline inflation.' : oil < -0.08 ? 'Falling energy costs ease headline inflation.' : 'Stable.', 'flat'],
    ];
    const score = (trend > 0 ? 1 : -1) + (vPct < 0.6 ? 1 : -1) + (s210 > 0 ? 0.5 : -0.5) + (hy != null ? (hy < 4 ? 0.5 : -0.5) : 0);
    return `<div class="regime ${score > 1 ? 'up' : score < -1 ? 'down' : 'flat'}">${score > 1 ? 'RISK-ON' : score < -1 ? 'RISK-OFF' : 'MIXED'}</div>` +
      rows.map(r => `<div class="rg"><div><b>${r[0]}</b><span class="${r[3]}">${r[1]}</span></div><p>${r[2]}</p></div>`).join('') + '<p class="note small mt">Sources: Yahoo Finance prices, FRED yields and ICE BofA high-yield spread.</p>';
  }

  // ======================================================================== DES
  let desTimer = null;
  APP.register('DES', {
    title: 'Security Overview',
    async render(root, { sym }) {
      const crypto = /-USD$/.test(sym);
      root.innerHTML = `<div class="grid des">
        ${panel('Quote', '<div id="dQuote"><div class="muted small">Loading…</div></div>')}
        ${panel('Price', `<div class="seg" id="dTf"><button data-tf="1m">1D</button><button data-tf="6M" class="on">6M</button><button data-tf="1Y">1Y</button><button data-tf="5Y">5Y</button></div><div class="cv"><canvas id="dChart"></canvas></div>`, { cls: 'span2' })}
        ${panel(crypto ? 'Order book' : 'Recent 1-minute bars', '<div id="dBook"></div>', { badge: crypto ? 'BINANCE' : 'YAHOO' })}
        ${panel('Key statistics', '<div id="dStats" class="kvgrid"><div class="muted small">Loading…</div></div>')}
        ${panel('Performance &amp; risk', '<div id="dPerf" class="kvgrid"></div>')}
        ${panel(crypto ? 'Trades' : 'Analyst view', '<div id="dTrades" class="tape-list"></div>')}
        ${panel('Profile', '<div id="dProfile"></div>', { cls: 'span2' })}
        ${panel('Financial summary', '<div id="dFin"><div class="muted small">Loading…</div></div>', { cls: 'span2' })}
        ${panel('News', '<div id="dNews"><div class="muted small">Loading…</div></div>')}
      </div>`;
      let tf = '6M', daily = null, info = {};
      $('#dTf').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; tf = b.dataset.tf; $$('#dTf button').forEach(x => x.classList.toggle('on', x === b)); drawChart(); });
      const drawChart = async () => {
        const el = $('#dChart'); if (!el) return;
        try {
          if (tf === '1m') { const b = await HUB.history(sym, '1m'); const lastDay = U.isoDate(U.last(b).t); const today = b.filter(x => U.isoDate(x.t) === lastDay); CK.price(el, { bars: today.length > 20 ? today : b.slice(-390), type: 'area', tf: '1m', key: sym + 'i', initialBars: 1000, title: sym + ' · 1 min' }); }
          else { daily = daily || await HUB.history(sym, '1D'); CK.price(el, { bars: daily, type: 'area', tf: '1D', key: sym + tf, initialBars: { '6M': 126, '1Y': 252, '5Y': 1260 }[tf], title: sym }); }
        } catch (e) { el.parentElement.innerHTML = errBox(e); }
      };
      let book = null;
      const quoteHTML = () => {
        const q = HUB.quote(sym); if (!q) return '<div class="muted">Waiting for a quote…</div>';
        const rate = HUB.RATE.has(sym), rng = q.high > q.low ? (q.last - q.low) / (q.high - q.low) : 0.5;
        const bid = book && book.bids ? book.bids[0][0] : info.bid, ask = book && book.asks ? book.asks[0][0] : info.ask;
        return `<div class="bigpx ${U.cls(q.chg)}">${pxf(sym, q.last)}${rate ? '<small>%</small>' : ''}</div>
          <div class="${U.cls(q.chg)} chg">${rate ? U.fmtBp(q.chg / 100) : U.fmtSigned(q.chg, U.decimalsFor(q.last)) + '  ' + U.fmtPct(q.chgPct)}</div>
          <div class="kvgrid c2">${kv('Bid', bid ? U.fmtPx(bid) : '—')}${kv('Ask', ask ? U.fmtPx(ask) : '—')}${kv('Open', pxf(sym, q.open))}${kv('Prev close', pxf(sym, q.prev))}${kv('High', pxf(sym, q.high))}${kv('Low', pxf(sym, q.low))}${kv('Volume', U.fmtBig(q.vol, 2))}${kv('As of', new Date(q.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</div>
          <div class="rangebar" title="Position in today's range"><span style="left:${U.clamp(rng, 0, 1) * 100}%"></span></div><div class="rangel"><span>${pxf(sym, q.low)}</span><span>day range</span><span>${pxf(sym, q.high)}</span></div>`;
      };
      const bookHTML = async () => {
        if (crypto) {
          try { book = await HUB.book(sym); } catch (e) { return `<div class="muted small">${esc(e.message)}</div>`; }
          if (!book.bids) return '<div class="muted small">No order book.</div>';
          const asks = book.asks.slice(0, 10).reverse(), bids = book.bids.slice(0, 10), mx = Math.max(...[...asks, ...bids].map(x => x[1]));
          const row = (x, side) => `<div class="lvl ${side}"><i style="width:${x[1] / mx * 100}%"></i><span>${U.fmtPx(x[0])}</span><span>${U.fmt(x[1], 4)}</span></div>`;
          const spr = book.asks[0][0] - book.bids[0][0];
          return `<div class="book">${asks.map(x => row(x, 'ask')).join('')}<div class="mid">${esc(book.pair)} · spread ${U.fmtPx(spr)} · ${U.fmt(spr / book.bids[0][0] * 1e4, 2)} bp</div>${bids.map(x => row(x, 'bid')).join('')}</div>`;
        }
        try { const b = await HUB.history(sym, '1m'); return `<div class="tape-list">${b.slice(-24).reverse().map(x => `<div class="tr ${x.c >= x.o ? 'up' : 'down'}"><span>${new Date(x.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><span>${pxf(sym, x.c)}</span><span>${U.fmtBig(x.v, 0)}</span></div>`).join('')}</div><div class="hint">Yahoo publishes no order book for this market; these are the latest one-minute closes and volumes.</div>`; }
        catch (e) { return `<div class="muted small">${esc(e.message)}</div>`; }
      };
      const refresh = async () => { const a = $('#dQuote'); if (!a) return; a.innerHTML = quoteHTML(); const bk = await bookHTML(); if ($('#dBook')) $('#dBook').innerHTML = bk; if (crypto && book && book.trades && $('#dTrades')) $('#dTrades').innerHTML = book.trades.slice(0, 24).map(t => `<div class="tr ${t.side === 'B' ? 'up' : 'down'}"><span>${new Date(t.t).toLocaleTimeString()}</span><span>${U.fmtPx(t.p)}</span><span>${U.fmt(t.q, 4)}</span></div>`).join(''); };
      this.refresh = refresh;
      refresh(); drawChart();
      clearInterval(desTimer); desTimer = setInterval(refresh, crypto ? 3000 : 30000);

      // statistics, profile, fundamentals, news
      const [infoR, barsR, benchR] = await Promise.allSettled([HUB.profile(sym), HUB.history(sym, '1D'), HUB.history('^GSPC', '1D')]);
      info = infoR.status === 'fulfilled' ? infoR.value || {} : {};
      if ($('#dQuote') && HUB.quote(sym)) $('#dQuote').innerHTML = quoteHTML();   // bid/ask arrive with the profile
      if (barsR.status === 'fulfilled') {
        daily = barsR.value; const st = Q.perfStats(daily, benchR.status === 'fulfilled' && sym !== '^GSPC' ? benchR.value : null, HUB.rf());
        $('#dPerf').innerHTML = [['1 day', st.r1d], ['1 week', st.r1w], ['1 month', st.r1m], ['3 months', st.r3m], ['YTD', st.ytd], ['1 year', st.r1y]].map(([l, v]) => kv(l, U.fmtPct(v), U.cls(v))).join('') +
          kv('Volatility 1y', U.fmtPct(st.vol, 1, false)) + kv('Sharpe 1y', U.fmt(st.sharpe, 2)) + kv('Sortino 1y', U.fmt(st.sortino, 2)) + kv('Max drawdown 1y', U.fmtPct(st.mdd, 1), 'down') +
          (st.beta != null ? kv('Beta vs S&P 500', U.fmt(st.beta, 2)) + kv('Correlation', U.fmt(st.corr, 2)) : '') + kv('1-day VaR 95%', U.fmtPct(-st.var95, 2), 'down') + kv('Skew / kurtosis', `${U.fmt(st.skew, 2)} / ${U.fmt(st.kurt, 1)}`) +
          kv('52-week high', pxf(sym, st.hi52)) + kv('52-week low', pxf(sym, st.lo52));
      } else $('#dPerf').innerHTML = errBox(barsR.reason);
      const q = HUB.quote(sym), price = q?.last ?? info.currentPrice;
      const i = info, has = k => i[k] != null;
      $('#dStats').innerHTML = (has('marketCap') ? kv('Market cap', U.fmtBig(i.marketCap)) : '') + (has('enterpriseValue') ? kv('Enterprise value', U.fmtBig(i.enterpriseValue)) : '') +
        (has('trailingPE') ? kv('P/E (trailing)', U.fmtX(i.trailingPE)) : '') + (has('forwardPE') ? kv('P/E (forward)', U.fmtX(i.forwardPE)) : '') + (has('enterpriseToEbitda') ? kv('EV/EBITDA', U.fmtX(i.enterpriseToEbitda)) : '') +
        (has('priceToSalesTrailing12Months') ? kv('Price/sales', U.fmtX(i.priceToSalesTrailing12Months)) : '') + (has('priceToBook') ? kv('Price/book', U.fmtX(i.priceToBook)) : '') +
        (has('dividendRate') && price ? kv('Dividend yield', U.fmtPct(i.dividendRate / price, 2, false)) : '') + (has('profitMargins') ? kv('Net margin', U.fmtPct(i.profitMargins, 1, false)) : '') + (has('operatingMargins') ? kv('Operating margin', U.fmtPct(i.operatingMargins, 1, false)) : '') +
        (has('returnOnEquity') ? kv('Return on equity', U.fmtPct(i.returnOnEquity, 1, false)) : '') + (has('revenueGrowth') ? kv('Revenue growth (yoy)', U.fmtPct(i.revenueGrowth, 1), U.cls(i.revenueGrowth)) : '') +
        (has('debtToEquity') ? kv('Debt / equity', U.fmt(i.debtToEquity / 100, 2)) : '') + (has('beta') ? kv('Beta (Yahoo, 5y monthly)', U.fmt(i.beta, 2)) : '') + (has('shortRatio') ? kv('Short ratio (days)', U.fmt(i.shortRatio, 1)) : '') +
        (has('heldPercentInstitutions') ? kv('Institutional ownership', U.fmtPct(i.heldPercentInstitutions, 0, false)) : '') || '<div class="muted small">No fundamentals for this instrument type.</div>';
      if (!crypto) $('#dTrades').innerHTML = has('targetMeanPrice') && price ? `<div class="bignum">${U.fmtPx(i.targetMeanPrice)} <small class="${U.cls(i.targetMeanPrice - price)}">${U.fmtPct(i.targetMeanPrice / price - 1, 1)}</small></div>
          <div class="kvgrid c2">${kv('Consensus', esc(String(i.recommendationKey || '—').replace('_', ' ').toUpperCase()))}${kv('Analysts', U.fmt(i.numberOfAnalystOpinions, 0))}${kv('High target', U.fmtPx(i.targetHighPrice))}${kv('Low target', U.fmtPx(i.targetLowPrice))}</div>
          <div class="hint">Mean 12-month analyst price target from Yahoo Finance.</div>` : '<div class="muted small">No analyst coverage for this instrument.</div>';
      $('#dProfile').innerHTML = `<h2 class="coname">${esc(i.longName || i.shortName || HUB.meta(sym).name)}</h2><p class="desc">${esc(i.longBusinessSummary || '')}</p>
        <div class="kvgrid c3">${kv('Sector', esc(i.sector || HUB.meta(sym).cls))}${kv('Industry', esc(i.industry || '—'))}${kv('Exchange', esc(i.fullExchangeName || i.exchange || '—'))}${kv('Currency', esc(i.currency || '—'))}${i.fullTimeEmployees ? kv('Employees', U.fmt(i.fullTimeEmployees, 0)) : ''}${i.ceo ? kv('CEO', esc(i.ceo)) : ''}${i.country ? kv('Country', esc(i.country)) : ''}${i.website ? `<div class="kv"><span>Website</span><b><a href="${esc(i.website)}" target="_blank" rel="noopener">${esc(i.website.replace(/^https?:\/\//, ''))}</a></b></div>` : ''}</div>`;
      if (HUB.cls(sym) === 'EQ') {
        HUB.fundamentals(sym).then(f => {
          const yrs = f.years, line = (lab, fn, fmt) => `<tr><td>${lab}</td>${yrs.map((y, k) => `<td class="r">${fmt(fn(y, k))}</td>`).join('')}</tr>`;
          $('#dFin').innerHTML = `<div class="tblwrap"><table class="tbl fin"><thead><tr><th>${esc(f.currency)}</th>${yrs.map(y => `<th class="r">FY${y.year}</th>`).join('')}</tr></thead><tbody>
            ${line('Revenue', y => y.revenue, v => U.fmtBig(v, 1))}${line('Growth', (y, k) => k ? y.revenue / yrs[k - 1].revenue - 1 : null, v => v == null ? '—' : `<span class="${U.cls(v)}">${U.fmtPct(v, 1)}</span>`)}
            ${line('Operating income', y => y.ebit, v => U.fmtBig(v, 1))}${line('Operating margin', y => y.ebit / y.revenue, v => U.fmtPct(v, 1, false))}${line('Net income', y => y.netIncome, v => U.fmtBig(v, 1))}
            ${line('Free cash flow', y => y.fcf, v => U.fmtBig(v, 1))}${line('Capex', y => y.capex, v => U.fmtBig(v, 1))}
          </tbody></table></div><div class="src-note">Source: ${esc(f.source)}. <a href="#" data-open="DCF">Open the DCF model →</a></div>`;
          $('#dFin').addEventListener('click', e => { if (e.target.closest('[data-open]')) { e.preventDefault(); APP.open('DCF'); } });
        }).catch(e => { $('#dFin').innerHTML = `<div class="muted small">${esc(e.message)}</div>`; });
      } else $('#dFin').innerHTML = '<div class="muted small">Financial statements apply to individual companies.</div>';
      HUB.news(sym).then(n => { $('#dNews').innerHTML = n && n.length ? n.slice(0, 14).map(x => `<a class="news" href="${esc(x.url)}" target="_blank" rel="noopener"><b>${esc(x.title)}</b><span>${esc(x.site || '')}${x.date ? ' · ' + esc(String(typeof x.date === 'number' ? new Date(x.date * 1000).toISOString() : x.date).slice(0, 16).replace('T', ' ')) : ''}</span></a>`).join('') : '<div class="muted small">No recent news.</div>'; })
        .catch(e => { $('#dNews').innerHTML = `<div class="muted small">${esc(e.message)}</div>`; });
    },
    onTick(syms) { if (syms.includes(APP.state.sym) && this.refresh) { const a = $('#dQuote'); if (a) this.refresh(); } },
    destroy() { clearInterval(desTimer); },
  });

  // ======================================================================== CHART
  const OVL = [['sma20', 'SMA 20'], ['sma50', 'SMA 50'], ['sma200', 'SMA 200'], ['ema21', 'EMA 21'], ['bb', 'Bollinger'], ['kc', 'Keltner'], ['dc', 'Donchian'], ['vwap', 'VWAP 20']];
  const chartState = Object.assign({ tf: '1D', type: 'candle', log: false, ovl: ['sma50', 'sma200'], sub: 'rsi', levels: {}, compare: [] }, U.store.get('chart', {}));
  const saveChart = () => U.store.set('chart', { ...chartState, compare: [] });
  APP.register('CHART', {
    title: 'Price Chart',
    render(root, { sym }) {
      const cs = chartState;
      root.innerHTML = `<div class="toolbar">
          <div class="seg" id="cTf">${['1m', '5m', '1H', '1D', '1W'].map(t => `<button data-v="${t}" class="${cs.tf === t ? 'on' : ''}">${t}</button>`).join('')}</div>
          <div class="seg" id="cType">${[['candle', 'Candles'], ['line', 'Line'], ['area', 'Area']].map(([v, l]) => `<button data-v="${v}" class="${cs.type === v ? 'on' : ''}">${l}</button>`).join('')}</div>
          <label class="chk"><input type="checkbox" id="cLog" ${cs.log ? 'checked' : ''}> Log</label>
          <div class="chks" id="cOvl">${OVL.map(([k, l]) => `<label class="chk"><input type="checkbox" value="${k}" ${cs.ovl.includes(k) ? 'checked' : ''}> ${l}</label>`).join('')}</div>
          <select id="cSub">${[['none', 'No lower pane'], ['rsi', 'RSI 14'], ['macd', 'MACD 12/26/9'], ['stoch', 'Stochastic 14/3'], ['atr', 'ATR 14'], ['obv', 'On-balance volume']].map(([v, l]) => `<option value="${v}" ${cs.sub === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <input id="cCmp" class="txt" placeholder="Compare: MSFT ^GSPC" value="${esc(cs.compare.join(' '))}">
          <button class="btn ghost" id="cLvlClr" title="Remove drawn levels">Clear levels</button>
        </div>
        <div class="grid chartgrid">
          ${panel(`<span id="cTitle">${esc(sym)} · ${esc(HUB.meta(sym).name)}</span>`, '<div class="cv xl"><canvas id="cMain"></canvas></div><div class="hint">Wheel: zoom · drag: pan · double-click: reset · Alt+click: draw level. Intraday bars: last 5 days (1m), 1 month (5m), 6 months (1H).</div>', { cls: 'span2' })}
          <div class="stack">${panel('Statistics', '<div id="cStats" class="kvgrid c2"></div>')}${panel('Signal summary', '<div id="cSig"></div>')}${panel('Return distribution', '<div class="cv sm"><canvas id="cHist"></canvas></div>')}</div>
        </div>`;
      const seg = (id, key) => $(id).addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; cs[key] = b.dataset.v; $$(id + ' button').forEach(x => x.classList.toggle('on', x === b)); saveChart(); this.load(sym); });
      seg('#cTf', 'tf'); seg('#cType', 'type');
      $('#cLog').addEventListener('change', e => { cs.log = e.target.checked; saveChart(); this.draw(); });
      $('#cOvl').addEventListener('change', () => { cs.ovl = $$('#cOvl input:checked').map(i => i.value); saveChart(); this.draw(); });
      $('#cSub').addEventListener('change', e => { cs.sub = e.target.value; saveChart(); this.draw(); });
      $('#cCmp').addEventListener('change', e => this.compare(e.target.value.toUpperCase().split(/[\s,]+/).filter(Boolean)));
      $('#cLvlClr').addEventListener('click', () => { cs.levels[sym] = []; saveChart(); this.draw(); });
      this.sym = sym; this.load(sym);
    },
    async compare(list) {
      chartState.compare = list.map(s => HUB.resolve(s)).filter(s => s && s !== this.sym);
      const inp = $('#cCmp'); if (inp) inp.value = chartState.compare.join(' ');
      await this.load(this.sym);
    },
    async load(sym) {
      const cs = chartState;
      try {
        this.bars = await HUB.history(sym, cs.tf);
        this.cmp = [];
        const key = cs.tf === '1D' || cs.tf === '1W' ? (t => U.isoDate(t)) : (t => Math.round(t / 60e3));
        for (const [k, s] of chartState.compare.entries()) {
          try { const b = await HUB.history(s, cs.tf); const m = new Map(b.map(x => [key(x.t), x.c])); this.cmp.push({ name: s, data: this.bars.map(x => m.get(key(x.t)) ?? null), color: CK.colors().series[(k + 1) % 8] }); }
          catch (e) { APP.toast(`${s}: ${e.message}`, 'err'); }
        }
        if (cs.tf === '1D' || cs.tf === '1W') { try { this.bench = await HUB.history('^GSPC', cs.tf); } catch (e) { this.bench = null; } } else this.bench = null;
        this.draw(); this.stats();
      } catch (e) { const c = $('#cMain'); if (c) c.parentElement.innerHTML = errBox(e); }
    },
    draw() {
      const el = $('#cMain'); if (!el || !this.bars) return;
      const cs = chartState, b = this.bars, c = b.map(x => x.c), col = CK.colors(), ov = [], bands = [];
      if (cs.ovl.includes('sma20')) ov.push({ data: Q.sma(c, 20), color: col.series[2], label: 'SMA20' });
      if (cs.ovl.includes('sma50')) ov.push({ data: Q.sma(c, 50), color: col.key, label: 'SMA50' });
      if (cs.ovl.includes('sma200')) ov.push({ data: Q.sma(c, 200), color: col.series[4], label: 'SMA200' });
      if (cs.ovl.includes('ema21')) ov.push({ data: Q.ema(c, 21), color: col.series[5], label: 'EMA21', dash: [4, 3] });
      if (cs.ovl.includes('vwap')) ov.push({ data: Q.vwapRolling(b, 20), color: col.series[6], label: 'VWAP' });
      if (cs.ovl.includes('bb')) { const x = Q.bbands(c); bands.push({ up: x.up, lo: x.lo, color: col.accent }); }
      if (cs.ovl.includes('kc')) { const x = Q.keltner(b); bands.push({ up: x.up, lo: x.lo, color: col.series[3] }); }
      if (cs.ovl.includes('dc')) { const x = Q.donchian(b); ov.push({ data: x.up, color: col.muted, dash: [2, 2] }, { data: x.lo, color: col.muted, dash: [2, 2] }); }
      let sub = null;
      if (cs.sub === 'rsi') sub = { title: 'RSI 14', min: 0, max: 100, guides: [30, 50, 70], series: [{ data: Q.rsi(c), color: col.key }] };
      if (cs.sub === 'macd') { const m = Q.macd(c); sub = { title: 'MACD', series: [{ data: m.hist, type: 'hist' }, { data: m.line, color: col.accent }, { data: m.signal, color: col.key }], guides: [0] }; }
      if (cs.sub === 'stoch') { const s = Q.stoch(b); sub = { title: 'Stoch %K %D', min: 0, max: 100, guides: [20, 80], series: [{ data: s.k, color: col.accent }, { data: s.d, color: col.key }] }; }
      if (cs.sub === 'atr') sub = { title: 'ATR 14', series: [{ data: Q.atr(b), color: col.series[5] }] };
      if (cs.sub === 'obv') sub = { title: 'OBV', series: [{ data: Q.obv(b), color: col.series[2] }] };
      CK.price(el, { bars: b, key: this.sym + cs.tf + cs.compare.join(','), tf: cs.tf, type: cs.type, log: cs.log, overlays: ov, bands, sub, levels: cs.levels[this.sym] || [], title: this.sym + ' · ' + cs.tf,
        compare: this.cmp && this.cmp.length ? this.cmp : null, initialBars: cs.tf === '1D' ? 260 : cs.tf === '1W' ? 156 : 300,
        onLevel: px => { (cs.levels[this.sym] = cs.levels[this.sym] || []).push(px); saveChart(); APP.toast(`Level drawn at ${U.fmtPx(px)}. Type ALERT ${this.sym} > ${U.fmtPx(px).replace(/,/g, '')} to be notified.`, 'ok'); this.draw(); } });
    },
    stats() {
      const b = this.bars; if (!b || b.length < 30) return;
      const cs = chartState, daily = cs.tf === '1D' || cs.tf === '1W', ppy = { '1W': 52, '1D': 252, '1H': 252 * 7, '5m': 252 * 78, '1m': 252 * 390 }[cs.tf];
      const st = Q.perfStats(b, this.bench && this.sym !== '^GSPC' ? this.bench : null, HUB.rf(), ppy), c = b.map(x => x.c);
      $('#cStats').innerHTML = (daily ? kv('1 month', U.fmtPct(st.r1m), U.cls(st.r1m)) + kv('3 months', U.fmtPct(st.r3m), U.cls(st.r3m)) + kv('1 year', U.fmtPct(st.r1y), U.cls(st.r1y)) + kv('YTD', U.fmtPct(st.ytd), U.cls(st.ytd)) : '') +
        kv('Volatility (ann.)', U.fmtPct(st.vol, 1, false)) + kv('Sharpe', U.fmt(st.sharpe, 2)) + kv('Sortino', U.fmt(st.sortino, 2)) + kv('Max drawdown', U.fmtPct(st.mdd, 1), 'down') +
        (st.beta != null ? kv('Beta vs S&P 500', U.fmt(st.beta, 2)) + kv('Alpha (ann.)', U.fmtPct(st.alpha, 1), U.cls(st.alpha)) + kv('R²', U.fmt(st.r2, 2)) + kv('Info ratio', U.fmt(st.ir, 2)) : '') +
        kv('Skew', U.fmt(st.skew, 2)) + kv('Excess kurtosis', U.fmt(st.kurt, 2)) + kv('Hist. VaR 95% (1 bar)', U.fmtPct(-st.var95, 2), 'down') + kv('ATR 14', U.fmtPx(U.last(Q.atr(b))));
      const r = U.last(Q.rsi(c)), m = Q.macd(c), s50 = U.last(Q.sma(c, 50)), s200 = U.last(Q.sma(c, 200)), bb = Q.bbands(c), last = U.last(c), st2 = Q.stoch(b);
      const sig = [
        ['Trend (50 vs 200)', s200 == null ? null : s50 > s200 ? 1 : -1, s200 == null ? 'Not enough history' : s50 > s200 ? 'Golden-cross regime' : 'Death-cross regime'],
        ['Price vs 50 MA', s50 == null ? null : last > s50 ? 1 : -1, U.fmtPct(last / s50 - 1, 1) + ' from the average'],
        ['RSI 14', r > 70 ? -1 : r < 30 ? 1 : 0, U.fmt(r, 1) + (r > 70 ? ' overbought' : r < 30 ? ' oversold' : ' neutral')],
        ['MACD', U.last(m.hist) > 0 ? 1 : -1, U.last(m.hist) > 0 ? 'Above signal line' : 'Below signal line'],
        ['Bollinger', last > U.last(bb.up) ? -1 : last < U.last(bb.lo) ? 1 : 0, '%B ' + U.fmt((last - U.last(bb.lo)) / (U.last(bb.up) - U.last(bb.lo)), 2)],
        ['Stochastic', U.last(st2.k) > 80 ? -1 : U.last(st2.k) < 20 ? 1 : 0, '%K ' + U.fmt(U.last(st2.k), 0)],
      ];
      const score = U.sum(sig.map(x => x[1] || 0));
      $('#cSig').innerHTML = `<div class="sigscore ${score > 1 ? 'up' : score < -1 ? 'down' : 'flat'}">${score > 2 ? 'Strong buy' : score > 0 ? 'Buy' : score < -2 ? 'Strong sell' : score < 0 ? 'Sell' : 'Neutral'} <small>${score > 0 ? '+' : ''}${score} of ±${sig.length}</small></div>` +
        sig.map(x => `<div class="sigrow"><span>${x[0]}</span><b class="${x[1] > 0 ? 'up' : x[1] < 0 ? 'down' : 'flat'}">${x[1] > 0 ? '▲' : x[1] < 0 ? '▼' : '■'}</b><em>${x[2]}</em></div>`).join('') + '<p class="note">Rule-based technical readings, not a forecast.</p>';
      const rets = U.returns(c).slice(-252).map(x => x * 100);
      CK.hist($('#cHist'), { values: rets, bins: 40, xFmt: v => v.toFixed(1) + '%', vlines: [{ x: -st.var95 * 100, label: 'VaR95', color: CK.colors().down }], colorFn: x => x < 0 ? CK.colors().down + 'aa' : CK.colors().up + 'aa' });
    },
    onTick(syms) {
      if (!syms.includes(this.sym) || !this.bars) return;
      const q = HUB.quote(this.sym), b = U.last(this.bars); if (!q || !b) return;
      if (q.t >= b.t) { b.c = q.last; b.h = Math.max(b.h, q.last); b.l = Math.min(b.l, q.last); }
      this.draw();
      if (chartState.tf !== '1D' && chartState.tf !== '1W' && (!this._reload || Date.now() - this._reload > 60e3)) { this._reload = Date.now(); HUB.history(this.sym, chartState.tf).then(x => { this.bars = x; this.draw(); }).catch(() => {}); }
    },
  });

  // ======================================================================== ECO
  const ECO_DESC = {
    FOMC: ['Sets the federal funds target rate; the statement, press conference and quarterly projections move every asset class.', ['^IRX', '^TNX', '^GSPC', 'DX-Y.NYB', 'GC=F'], 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'],
    NFP: ['Payrolls, unemployment and wages for the prior month: the largest scheduled market mover.', ['^FVX', 'JPY=X', '^GSPC'], 'https://www.bls.gov/schedule/news_release/empsit.htm'],
    CPI: ['Monthly consumer inflation; core CPI drives rate expectations.', ['^FVX', '^TNX', '^GSPC', 'GC=F'], 'https://www.bls.gov/schedule/news_release/cpi.htm'],
    PPI: ['Pipeline inflation; several components feed the Fed\'s preferred PCE gauge.', ['^FVX'], 'https://www.bls.gov/schedule/news_release/ppi.htm'],
    PCE: ['The Fed\'s target inflation measure plus consumer spending.', ['^FVX', '^TNX'], 'https://www.bea.gov/data/personal-consumption-expenditures-price-index'],
    GDP: ['Quarterly output growth (annualised).', ['^GSPC', '^TNX'], 'https://www.bea.gov/data/gdp/gross-domestic-product'],
    RETAIL: ['Monthly consumer spending at retailers and restaurants.', ['^GSPC', 'XLY'], 'https://www.census.gov/retail/index.html'],
    JOLTS: ['Job openings and quits: labour-market tightness.', ['^FVX'], 'https://www.bls.gov/jlt/'],
    IP: ['Factory, mining and utility output.', ['XLI', 'HG=F'], 'https://www.federalreserve.gov/releases/g17/current/default.htm'],
    UMICH: ['Consumer sentiment and inflation expectations.', ['^TNX'], 'https://www.sca.isr.umich.edu/'],
    HOUSING: ['Housing starts and permits: the most rate-sensitive sector.', ['XLRE', '^TNX'], 'https://www.census.gov/construction/nrc/index.html'],
    ECI: ['Quarterly wage and benefit growth: the Fed\'s preferred wage gauge.', ['^FVX'], 'https://www.bls.gov/eci/'],
    CLAIMS: ['Weekly new unemployment filings: the most timely labour signal.', ['^FVX'], 'https://www.dol.gov/ui/data.pdf'],
  };
  APP.register('ECO', {
    title: 'Economic Calendar & Macro', global: true,
    async render(root) {
      root.innerHTML = `<div class="grid g3">
        ${panel('Upcoming US releases · your local time', '<div id="eCal"><div class="muted small">Loading…</div></div>', { cls: 'span2' })}
        ${panel('Market regime', '<div id="eReg"><div class="muted small">Loading…</div></div>')}
        ${panel('Macro dashboard · latest official data (FRED)', '<div id="eMac" class="macgrid"><div class="muted small">Loading…</div></div>', { cls: 'span3' })}
      </div>`;
      root.addEventListener('click', e => { const a = e.target.closest('.symlink'); if (a) { e.preventDefault(); APP.open('CHART', a.dataset.s); } });
      regimeHTML().then(h => { if ($('#eReg')) $('#eReg').innerHTML = h; }).catch(e => { if ($('#eReg')) $('#eReg').innerHTML = errBox(e); });
      HUB.calendar().then(c => {
        const rel = t => { const d = (t - Date.now()) / 36e5; return d < 0 ? (d > -24 ? 'today' : Math.round(-d / 24) + 'd ago') : d < 24 ? 'in ' + Math.round(d) + 'h' : 'in ' + Math.round(d / 24) + 'd'; };
        $('#eCal').innerHTML = `<div class="tblwrap"><table class="tbl eco"><thead><tr><th>When (local)</th><th></th><th>Event</th><th>Watch</th><th>Source</th></tr></thead><tbody>
          ${c.events.slice(0, 40).map(e => { const d = ECO_DESC[e.code] || ['', [], '#']; return `<tr class="${e.ts < Date.now() ? 'past' : ''}"><td class="mono">${new Date(e.ts).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td><td class="muted">${rel(e.ts)}</td>
            <td><b>${esc(e.label)}</b>${e.est ? ' <span class="pill">est.</span>' : ''}<div class="muted small">${esc(d[0])}</div></td><td>${d[1].map(s => `<a href="#" class="symlink" data-s="${s}">${s}</a>`).join(' ')}</td><td class="small"><a href="${d[2]}" target="_blank" rel="noopener">${esc(e.src)} ↗</a></td></tr>`; }).join('')}
          </tbody></table></div><p class="note">${c.fredKey ? 'Dates from the FRED release calendar.' : 'Set FRED_API_KEY on the server for the full official release calendar. Without it, Fed and BLS published dates are shown and "est." rows follow standard conventions.'}</p>`;
      }).catch(e => { $('#eCal').innerHTML = errBox(e); });
      HUB.macro().then(m => {
        if (!m.indicators.length) { $('#eMac').innerHTML = '<div class="muted small">FRED did not answer this time. The macro dashboard fills in on a later visit (the server keeps retrying).</div>'; return; }
        $('#eMac').innerHTML = m.indicators.map((x, k) => { const d = x.value - x.prior, unit = x.unit === '%' ? '%' : x.unit === 'k' ? 'k' : x.unit === '$' ? '' : '';
          return `<div class="mcard"><div class="mh"><b>${esc(x.label)}</b><a href="${esc(x.url)}" target="_blank" rel="noopener" class="small">FRED ↗</a></div><div class="mv">${x.unit === '$' ? '$' : ''}${U.fmt(x.value, Math.abs(x.value) >= 100 ? 0 : 2)}${unit}</div>
            <div class="small"><span class="${U.cls(d)}">${d >= 0 ? '+' : ''}${U.fmt(d, 2)}</span> <span class="muted">vs prior · ${esc(x.date)}</span></div><canvas class="spk" id="mac-${k}"></canvas></div>`; }).join('');
        m.indicators.forEach((x, k) => { const el = document.getElementById('mac-' + k); if (el) CK.spark(el, x.history.map(p => p[1])); });
      }).catch(e => { $('#eMac').innerHTML = errBox(e); });
    },
  });

  // ======================================================================== SET
  APP.register('SET', {
    title: 'Settings & Server', global: true,
    async render(root) {
      const s = HUB.settings;
      root.innerHTML = `<div class="grid g2">
        ${panel('Refresh', `<p class="note">How often quotes update while this tab is visible. The server shares one download among all visitors.</p><div class="seg" id="sRef">${[5, 15, 30, 60].map(x => `<button data-v="${x}" class="${s.refreshSec === x ? 'on' : ''}">${x}s</button>`).join('')}</div>`)}
        ${panel('Valuation defaults', `<div class="field"><label for="sRf">Risk-free rate override (blank = latest 10-year Treasury from FRED, now ${U.fmtPct(HUB.rf(), 2, false)})</label><input id="sRf" class="num" type="number" step="0.01" value="${U.isNum(s.rfOverride) ? (s.rfOverride * 100).toFixed(2) : ''}" placeholder="e.g. 4.25"></div>`)}
        ${panel('Server', '<div id="sSrv" class="kvgrid c2"><div class="muted small">Checking…</div></div>')}
        ${panel('Workspace', `<p class="note">Watchlist, alerts, portfolio and chart settings are saved in this browser.</p><button class="btn ghost" id="sReset">Reset workspace</button> <span id="sResetAsk"></span>`)}
      </div>`;
      $('#sRef').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; HUB.saveSettings({ refreshSec: +b.dataset.v }); $$('#sRef button').forEach(x => x.classList.toggle('on', x === b)); });
      $('#sRf').addEventListener('change', e => { const v = parseFloat(e.target.value); HUB.saveSettings({ rfOverride: isFinite(v) ? v / 100 : null }); APP.toast('Risk-free rate saved', 'ok'); });
      $('#sReset').addEventListener('click', () => {
        $('#sResetAsk').innerHTML = '<span class="small">Erase watchlist, alerts, portfolio and settings? </span><button class="btn danger" id="sResetYes">Erase</button>';
        $('#sResetYes').addEventListener('click', () => { try { Object.keys(localStorage).filter(k => k.startsWith('agula:')).forEach(k => localStorage.removeItem(k)); } catch (e) { /* ignore */ } location.reload(); });
      });
      try { const h = await HUB.health(); $('#sSrv').innerHTML = kv('Status', h.status.toUpperCase(), 'up') + kv('Version', h.version) + kv('FRED release calendar', h.fredKey ? 'on' : 'off (set FRED_API_KEY)') + kv('Cached datasets', h.cached) + kv('Provider calls', h.stats.provider_calls || 0) + kv('Cache hits', h.stats.cache_hit || 0) + kv('Shared requests', h.stats.coalesced || 0); }
      catch (e) { $('#sSrv').innerHTML = errBox(e); }
    },
  });

})();
