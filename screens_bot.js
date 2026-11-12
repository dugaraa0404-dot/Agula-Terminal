/* ============================================================================
   Agula Terminal — BOT: strategy backtester, parameter optimizer and paper-trading bots
   Everything is simulated money on real (delayed) prices. No broker, no real orders.
   ========================================================================== */
'use strict';

(() => {
  const { panel, kv, $, $$ } = APP;
  const esc = U.esc;
  const errBox = e => `<div class="empty err">${esc(e.message || e)}</div>`;
  const money = v => U.isNum(v) ? (v < 0 ? '−$' : '$') + U.fmt(Math.abs(v), Math.abs(v) >= 1e5 ? 0 : 2) : '—';
  const pnlTxt = v => U.isNum(v) ? `<span class="${U.cls(v)}">${v > 0 ? '+' : ''}${money(v).replace('−', '-')}</span>` : '—';
  const STATUS = { running: ['RUNNING', 'on'], stopped: ['STOPPED', 'off'], paused: ['PAUSED · DAILY LOSS', 'bad'], halted: ['HALTED · MAX DRAWDOWN', 'bad'] };
  const WHY = { signal: 'Signal', stop: 'Stop-loss', take: 'Take-profit', trail: 'Trailing stop', end: 'End of test', manual: 'Manual', 'kill switch': 'Kill switch', 'max drawdown': 'Max drawdown', 'daily loss limit': 'Daily loss', stopped: 'Bot stopped' };
  let listTimer = null, backupT = 0;

  APP.register('BOT', {
    title: 'Trading Bot · Backtest & Paper Trading', global: true,
    async render(root) {
      this.tab = U.store.get('botTab', 'bt'); this.cfg = U.store.get('botCfg', null); this.sel = U.store.get('botSel', null);
      root.innerHTML = `<div class="toolbar botbar"><div class="seg" id="bTab">${[['bt', 'BACKTEST'], ['bots', 'PAPER BOTS'], ['blot', 'BLOTTER']].map(([k, l]) => `<button data-t="${k}" class="${k === this.tab ? 'on' : ''}">${l}</button>`).join('')}</div>
        <span id="bEng" class="muted small"></span><span class="grow"></span><button class="btn danger sm" id="bKill" title="Stop every bot and close every paper position">KILL SWITCH</button></div>
        <div id="bBody"></div>`;
      $('#bTab').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; this.tab = b.dataset.t; U.store.set('botTab', this.tab); $$('#bTab button').forEach(x => x.classList.toggle('on', x === b)); this.show(); });
      $('#bKill').addEventListener('click', e => this.kill(e.target));
      try { this.meta = await HUB.bot.strategies(); } catch (e) { $('#bBody').innerHTML = errBox(e); return; }
      this.show();
      clearInterval(listTimer); listTimer = setInterval(() => { if (this.tab !== 'bt' && !document.hidden) this.refresh(); }, 10e3);
      this.refresh(true);
    },
    destroy() { clearInterval(listTimer); listTimer = null; },
    show() {
      if (this.tab === 'bt') this.renderBacktest();
      else if (this.tab === 'bots') { $('#bBody').innerHTML = `<div id="bSum"></div><div id="bCards" class="botcards"><div class="muted small">Loading bots…</div></div><div id="bDetail"></div>`; this.refresh(true); }
      else { $('#bBody').innerHTML = panel('All paper orders', '<div id="bBlot"><div class="muted small">Loading…</div></div>', { tools: '<button class="btn ghost sm" id="bCsv">Download CSV</button>' }); $('#bCsv').addEventListener('click', () => this.csv()); this.blotter(); }
    },

    // ---------------------------------------------------------------- strategy form (shared by backtest and new bot)
    defaults() {
      return { symbol: APP.state.sym, tf: '1D', strategy: 'SMA_CROSS', params: {}, risk: { capital: 100000, size_pct: 100, fee_bps: 1, slip_bps: 2, stop_pct: '', take_pct: '', trail_pct: '', allow_short: false, daily_loss_pct: '', max_dd_pct: '' }, oos_pct: 30, session_only: true };
    },
    formHTML(c) {
      const S = this.meta.strategies, st = S[c.strategy] || S.SMA_CROSS;
      const p = Object.entries(st.params).map(([k, d]) => Array.isArray(d[1])
        ? `<div class="field"><label>${esc(d[2])}</label><select data-p="${k}">${d[1].map(o => `<option ${String(c.params[k] ?? d[0]) === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`
        : `<div class="field"><label>${esc(d[4])}</label><input class="num" type="number" data-p="${k}" min="${d[1]}" max="${d[2]}" step="${d[3]}" value="${c.params[k] ?? d[0]}"></div>`).join('');
      const r = c.risk, rf = (k, lab, ph, step = 0.5) => `<div class="field"><label>${lab}</label><div class="inwrap"><input class="num" type="number" data-r="${k}" step="${step}" value="${r[k] ?? ''}" placeholder="${ph}"><em>%</em></div></div>`;
      return `<div class="fields">
        <div class="field"><label>Symbol</label><input class="txt" id="fSym" value="${esc(c.symbol)}"></div>
        <div class="field"><label>Bars</label><select id="fTf">${Object.entries(this.meta.timeframes).map(([k, l]) => `<option value="${k}" ${k === c.tf ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
        <div class="field span2"><label>Strategy</label><select id="fStrat">${Object.entries(S).filter(([k]) => k !== 'MANUAL' || this.formMode === 'bot').map(([k, s]) => `<option value="${k}" ${k === c.strategy ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select></div>
        <p class="note span2 small" id="fDesc">${esc(st.desc)}</p>
        ${p}
        <label class="chk span2"><input type="checkbox" id="fShort" ${r.allow_short ? 'checked' : ''}> Allow short positions</label>
      </div>
      <h4 class="subh">Money & costs</h4><div class="fields">
        <div class="field"><label>Paper capital</label><div class="inwrap"><input class="num" type="number" data-r="capital" step="1000" value="${r.capital}"><em>$</em></div></div>
        ${rf('size_pct', 'Position size (of equity)', '100', 5)}
        <div class="field"><label>Commission</label><div class="inwrap"><input class="num" type="number" data-r="fee_bps" step="0.5" value="${r.fee_bps}"><em>bp</em></div></div>
        <div class="field"><label>Slippage</label><div class="inwrap"><input class="num" type="number" data-r="slip_bps" step="0.5" value="${r.slip_bps}"><em>bp</em></div></div>
      </div>
      <h4 class="subh">Risk controls</h4><div class="fields">
        ${rf('stop_pct', 'Stop-loss', 'off')}${rf('take_pct', 'Take-profit', 'off')}${rf('trail_pct', 'Trailing stop', 'off')}
        ${this.formMode === 'bot' ? rf('daily_loss_pct', 'Daily loss limit (pause)', 'off') + rf('max_dd_pct', 'Max drawdown (halt)', 'off') : `<div class="field"><label>Out-of-sample test</label><div class="inwrap"><input class="num" type="number" id="fOos" min="0" max="60" step="5" value="${c.oos_pct ?? 30}"><em>%</em></div></div>`}
      </div>${this.formMode === 'bot' ? `<label class="chk mt"><input type="checkbox" id="fSess" ${c.session_only !== false ? 'checked' : ''}> Trade US stocks only in the regular session (9:30–16:00 New York)</label>
        <div class="field mt"><label>Bot name</label><input class="txt" id="fName" placeholder="${esc(c.symbol)} ${esc(st.label)}" value="${esc(c.name || '')}"></div>` : ''}`;
    },
    readForm() {
      const c = this.defaults();
      c.symbol = HUB.resolve($('#fSym').value) || $('#fSym').value.trim().toUpperCase(); c.tf = $('#fTf').value; c.strategy = $('#fStrat').value;
      $$('#bForm [data-p]').forEach(el => { c.params[el.dataset.p] = el.tagName === 'SELECT' ? el.value : +el.value; });
      $$('#bForm [data-r]').forEach(el => { c.risk[el.dataset.r] = el.value === '' ? '' : +el.value; });
      c.risk.allow_short = $('#fShort').checked;
      if ($('#fOos')) c.oos_pct = +$('#fOos').value || 0;
      if ($('#fSess')) c.session_only = $('#fSess').checked;
      if ($('#fName')) c.name = $('#fName').value.trim();
      return c;
    },
    wireForm(onChange) {
      $('#fStrat').addEventListener('change', () => { const c = this.readForm(); c.params = {}; this.cfg = c; $('#bForm').innerHTML = this.formHTML(c); this.wireForm(onChange); onChange && onChange(); });
    },

    // ---------------------------------------------------------------- BACKTEST tab
    renderBacktest() {
      this.formMode = 'bt';
      const c = this.cfg || this.defaults();
      $('#bBody').innerHTML = `<div class="grid botgrid"><div class="stack">${panel('Strategy', `<div id="bForm">${this.formHTML(c)}</div>
          <div class="row mt"><button class="btn" id="bRun">Run backtest</button><button class="btn ghost" id="bOpt">Optimize…</button><button class="btn ghost" id="bDeploy">Deploy as paper bot</button></div>
          <div id="bOptBox" hidden></div>`)}
          <div class="warnbox small">Backtests show how simple rules <i>would have</i> done on past prices, after costs. They don't predict the future, and the more you tune parameters to the past, the less the result means. Check the out-of-sample column.</div></div>
        <div class="stack" id="bRes">${panel('Results', '<div class="empty small">Choose a strategy and press <b>Run backtest</b>.</div>')}</div></div>`;
      this.wireForm();
      $('#bRun').addEventListener('click', () => this.run());
      $('#bOpt').addEventListener('click', () => this.optForm());
      $('#bDeploy').addEventListener('click', () => { this.cfg = this.readForm(); U.store.set('botCfg', this.cfg); this.tab = 'bots'; U.store.set('botTab', 'bots'); $$('#bTab button').forEach(x => x.classList.toggle('on', x.dataset.t === 'bots')); this.show(); setTimeout(() => this.newBot(this.cfg), 50); });
      if (this.cfg) this.run();
    },
    async run() {
      const c = this.readForm(); this.cfg = c; U.store.set('botCfg', c);
      const res = $('#bRes'); res.innerHTML = panel('Results', '<div class="muted small">Running the backtest on the server…</div>');
      try { const r = await HUB.bot.backtest(c); this.last = r; this.results(r); }
      catch (e) { res.innerHTML = panel('Results', errBox(e)); }
    },
    results(r) {
      const s = r.stats, S = this.meta.strategies[r.strategy];
      const k = (lab, v, cls = '') => `<div class="kpi2"><span>${lab}</span><b class="${cls}">${v}</b></div>`;
      const pf = s.profitFactor == null ? (s.trades && s.winRate === 1 ? '∞' : '—') : U.fmt(s.profitFactor, 2);
      const bt = (st, lab) => st ? `<tr><td>${lab}</td><td class="r ${U.cls(st.totalReturn)}">${U.fmtPct(st.totalReturn, 1)}</td><td class="r ${U.cls(st.bhReturn)}">${U.fmtPct(st.bhReturn, 1)}</td><td class="r">${U.fmt(st.sharpe, 2)}</td><td class="r down">${U.fmtPct(st.maxDD, 1)}</td><td class="r">${st.trades}</td><td class="r">${st.winRate == null ? '—' : U.fmtPct(st.winRate, 0, false)}</td></tr>` : '';
      $('#bRes').innerHTML = `
        <div class="kpis">${k('Strategy return', U.fmtPct(s.totalReturn, 1), U.cls(s.totalReturn))}${k('Buy & hold', U.fmtPct(s.bhReturn, 1), U.cls(s.bhReturn))}${k('CAGR', U.fmtPct(s.cagr, 1), U.cls(s.cagr))}${k('Sharpe', U.fmt(s.sharpe, 2))}${k('Sortino', U.fmt(s.sortino, 2))}
          ${k('Max drawdown', U.fmtPct(s.maxDD, 1), 'down')}${k('Win rate', s.winRate == null ? '—' : U.fmtPct(s.winRate, 0, false))}${k('Profit factor', pf)}${k('Trades', s.trades)}${k('Time in market', U.fmtPct(s.exposure, 0, false))}</div>
        ${panel(`${esc(r.symbol)} · ${esc(S.label)} · ${esc(r.tf)}`, '<div class="cv xl"><canvas id="bPx"></canvas></div><p class="hint">▲ buy · ▼ sell · amber = stop, take-profit or trailing exit. Wheel to zoom, drag to pan.</p>', { badge: Object.entries(r.params).map(([a, b]) => `${a} ${b}`).join(' · ') })}
        <div class="grid g2">${panel('Equity: strategy vs buy & hold', '<div class="cv"><canvas id="bEq"></canvas></div>')}${panel('Drawdown', '<div class="cv"><canvas id="bDd"></canvas></div>')}</div>
        <div class="grid g2">${panel('In-sample vs out-of-sample', r.outsample ? `<table class="tbl"><thead><tr><th>Period</th><th class="r">Return</th><th class="r">Buy & hold</th><th class="r">Sharpe</th><th class="r">Max DD</th><th class="r">Trades</th><th class="r">Win</th></tr></thead><tbody>${bt(r.insample, 'In-sample (first ' + (100 - this.cfg.oos_pct) + '%)')}${bt(r.outsample, 'Out-of-sample (last ' + this.cfg.oos_pct + '%)')}${bt(s, 'Whole test')}</tbody></table><p class="hint">If the strategy only works in-sample, it was probably fitted to noise.</p>` : '<p class="note">Set an out-of-sample share (e.g. 30%) to see whether the rule held up on data it wasn\'t judged on.</p>')}
          ${panel('Trade statistics', `<div class="kvgrid">${kv('Average win', U.fmtPct(s.avgWin, 2), 'up')}${kv('Average loss', U.fmtPct(s.avgLoss, 2), 'down')}${kv('Expectancy per trade', U.fmtPct(s.expectancy, 2), U.cls(s.expectancy))}${kv('Average holding', s.avgBars == null ? '—' : U.fmt(s.avgBars, 1) + ' bars')}
            ${kv('Volatility (annual)', U.fmtPct(s.vol, 1, false))}${kv('Calmar', s.calmar == null ? '—' : U.fmt(s.calmar, 2))}${kv('Longest drawdown', s.ddBars + ' bars')}${kv('Buy & hold max DD', U.fmtPct(s.bhMaxDD, 1), 'down')}${kv('Ending equity', money(s.endEquity))}${kv('Years tested', U.fmt(s.years, 1))}</div>
            <p class="hint">Signal on a closed bar, fill at the next bar's open, ${this.cfg.risk.fee_bps}bp commission and ${this.cfg.risk.slip_bps}bp slippage per side.</p>`)}</div>
        ${r.monthly && r.monthly.length && r.tf !== '5m' ? panel('Monthly returns', this.monthlyHTML(r.monthly)) : ''}
        ${panel('Trades', this.tradesHTML(r.trades, r.tf), { badge: `${r.trades.length} shown` })}
        <div id="bSweep"></div>`;
      this.drawBt(r);
    },
    drawBt(r) {
      const bars = r.bars.map(b => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] })), cols = CK.colors();
      const ovl = [], bands = [];
      (r.overlays || []).forEach((o, i) => { if (o.band) bands.push({ up: o.up, lo: o.lo, color: cols.series[2] }); else ovl.push({ data: o.data, color: [cols.key, cols.accent, cols.series[2]][i % 3], label: o.label }); });
      const sub = r.sub ? { title: r.sub.title, min: r.sub.min, max: r.sub.max, guides: r.sub.guides, series: r.sub.series.map((s, i) => ({ data: s.data, type: s.type, color: [cols.accent, cols.key, cols.series[2]][i % 3] })) } : null;
      CK.price($('#bPx'), { bars, key: r.symbol + r.tf + r.strategy + JSON.stringify(r.params), tf: r.tf, overlays: ovl, bands, sub, markers: r.marks, initialBars: Math.min(bars.length, r.tf === '1D' ? 500 : 400), title: r.symbol });
      const idx = r.sampled || r.t.map((_, i) => i);
      const eq = idx.map(i => [r.t[i], r.equity[i]]), bh = idx.map(i => [r.t[i], r.bh[i]]), dd = idx.map(i => [r.t[i], r.dd[i] * 100]);
      const tfmt = t => new Date(t).toISOString().slice(0, r.tf === '5m' || r.tf === '1H' ? 10 : 7);
      const vb = r.splitT ? [{ x0: r.splitT, x1: U.last(r.t), color: cols.key + '14' }] : [];
      CK.xy($('#bEq'), { series: [{ name: 'Strategy', data: eq, color: cols.key, width: 1.8 }, { name: 'Buy & hold', data: bh, color: cols.muted }], xFmt: tfmt, yFmt: v => '$' + U.fmtBig(v, 0), vbands: vb, vlines: r.splitT ? [{ x: r.splitT, label: 'out-of-sample →' }] : [] });
      CK.xy($('#bDd'), { series: [{ name: 'Drawdown %', data: dd, color: cols.down, fill: true, fillBase: 0 }], xFmt: tfmt, yFmt: v => v.toFixed(0) + '%', ymax: 0 });
    },
    monthlyHTML(m) {
      const years = [...new Set(m.map(x => x[0]))].sort((a, b) => b - a), M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const get = (y, mo) => m.find(x => x[0] === y && x[1] === mo);
      return `<div class="tblwrap"><table class="tbl mret"><thead><tr><th>Year</th>${M.map(x => `<th class="r">${x}</th>`).join('')}<th class="r">Year</th></tr></thead><tbody>${years.map(y => {
        const cells = M.map((_, i) => { const v = get(y, i + 1); return v ? `<td class="r" style="background:${CK.divergingColor(v[2], 0.1)}">${(v[2] * 100).toFixed(1)}</td>` : '<td></td>'; });
        const yr = m.filter(x => x[0] === y).reduce((a, x) => a * (1 + x[2]), 1) - 1;
        return `<tr><td class="key">${y}</td>${cells.join('')}<td class="r ${U.cls(yr)}"><b>${(yr * 100).toFixed(1)}%</b></td></tr>`;
      }).join('')}</tbody></table></div>`;
    },
    tradesHTML(t, tf) {
      const d = x => new Date(x).toISOString().slice(0, tf === '1D' || tf === '1W' ? 10 : 16).replace('T', ' ');
      return `<div class="tblwrap short"><table class="tbl"><thead><tr><th>#</th><th>Side</th><th>Entry</th><th class="r">Price</th><th>Exit</th><th class="r">Price</th><th class="r">Return</th><th class="r">P&amp;L</th><th class="r">Bars</th><th>Exit reason</th></tr></thead><tbody>${t.slice().reverse().slice(0, 200).map((x, i) => `<tr><td class="muted">${t.length - i}</td><td class="${x.side === 'LONG' ? 'up' : 'down'}">${x.side}</td><td class="small">${d(x.entryT)}</td><td class="r">${U.fmtPx(x.entryPx)}</td><td class="small">${d(x.exitT)}</td><td class="r">${U.fmtPx(x.exitPx)}</td><td class="r ${U.cls(x.ret)}">${U.fmtPct(x.ret, 2)}</td><td class="r">${pnlTxt(x.pnl)}</td><td class="r muted">${x.bars}</td><td>${esc(WHY[x.why] || x.why)}</td></tr>`).join('') || '<tr><td colspan="10" class="muted">No trades: the rule never fired on this history.</td></tr>'}</tbody></table></div>`;
    },
    optForm() {
      const c = this.readForm(), sp = this.meta.strategies[c.strategy].params, num = Object.entries(sp).filter(([, d]) => !Array.isArray(d[1]));
      const box = $('#bOptBox');
      if (num.length < 2) { box.hidden = false; box.innerHTML = '<p class="note">This strategy has fewer than two numeric parameters to optimize.</p>'; return; }
      const axis = (id, pick) => `<select id="${id}">${num.map(([k, d]) => `<option value="${k}" ${k === pick ? 'selected' : ''}>${esc(d[4])}</option>`).join('')}</select>`;
      const rng = (k, side) => { const d = sp[k]; return side === 'lo' ? d[1] + (d[0] - d[1]) * 0.3 : Math.min(d[2], d[0] * 2.5); };
      box.hidden = false;
      box.innerHTML = `<h4 class="subh">Optimize two parameters</h4><div class="fields">
        <div class="field"><label>Across (x)</label>${axis('oX', num[0][0])}</div><div class="field"><label>From – to</label><div class="row"><input class="num xs" id="oXl" value="${Math.round(rng(num[0][0], 'lo'))}"><input class="num xs" id="oXh" value="${Math.round(rng(num[0][0], 'hi'))}"></div></div>
        <div class="field"><label>Down (y)</label>${axis('oY', num[1][0])}</div><div class="field"><label>From – to</label><div class="row"><input class="num xs" id="oYl" value="${Math.round(rng(num[1][0], 'lo'))}"><input class="num xs" id="oYh" value="${Math.round(rng(num[1][0], 'hi'))}"></div></div>
        <div class="field"><label>Steps per axis</label><input class="num" id="oN" type="number" min="2" max="12" value="8"></div>
        <div class="field"><label>Score by</label><select id="oM"><option value="sharpe">Sharpe ratio</option><option value="totalReturn">Total return</option><option value="cagr">CAGR</option><option value="calmar">Calmar (CAGR / max DD)</option><option value="maxDD">Max drawdown</option></select></div></div>
        <button class="btn mt" id="oGo">Run optimization</button>`;
      $('#oGo').addEventListener('click', () => this.sweep());
    },
    async sweep() {
      const c = this.readForm(), n = +$('#oN').value || 8;
      const body = { ...c, x: { name: $('#oX').value, lo: +$('#oXl').value, hi: +$('#oXh').value, steps: n }, y: { name: $('#oY').value, lo: +$('#oYl').value, hi: +$('#oYh').value, steps: n }, metric: $('#oM').value };
      const out = $('#bSweep') || $('#bRes'); if (!$('#bSweep')) $('#bRes').insertAdjacentHTML('beforeend', '<div id="bSweep"></div>');
      $('#bSweep').innerHTML = panel('Optimization', '<div class="muted small">Running up to 144 backtests…</div>');
      try {
        const r = await HUB.bot.sweep(body), sp = this.meta.strategies[r.strategy].params;
        const vals = r.grid.map(row => row.map(x => x && U.isNum(x.v) ? x.v : null)), flat = vals.flat().filter(U.isNum);
        const isPct = ['totalReturn', 'cagr', 'maxDD'].includes(r.metric), lo = Math.min(...flat), hi = Math.max(...flat);
        const best = r.metric === 'maxDD' ? hi : hi; let bi = -1, bj = -1; vals.forEach((row, i) => row.forEach((v, j) => { if (v === best && bi < 0) { bi = i; bj = j; } }));
        $('#bSweep').innerHTML = panel(`Optimization · ${esc(sp[r.x.name][4])} × ${esc(sp[r.y.name][4])}`, `<div class="cv tall"><canvas id="bSw"></canvas></div><p class="hint">Each cell is a full backtest scored by ${esc($('#oM').selectedOptions[0].text)}. Click a cell to load those parameters. Prefer a broad bright area over one bright cell: isolated peaks are usually luck.</p>`, { badge: `best ${isPct ? U.fmtPct(best, 1) : U.fmt(best, 2)}` });
        const el = $('#bSw');
        CK.heatmap(el, { rows: r.y.values.map(v => String(+v.toFixed(2))), cols: r.x.values.map(v => String(+v.toFixed(2))), values: vals, padL: 56, padT: 24, cornerLabel: `${r.y.name} ↓ · ${r.x.name} →`,
          fmt: v => v == null ? '' : isPct ? (v * 100).toFixed(0) + '%' : v.toFixed(2), color: v => v == null ? CK.colors().grid : CK.seqColor(hi > lo ? (v - lo) / (hi - lo) : 0.5), highlight: (i, j) => i === bi && j === bj });
        el.style.cursor = 'pointer';
        el.onclick = e => {
          const b = el.getBoundingClientRect(), nc = r.x.values.length, nr = r.y.values.length, cw = (b.width - 56 - 4) / nc, ch = (b.height - 24 - 4) / nr;
          const j = Math.floor((e.clientX - b.left - 56) / cw), i = Math.floor((e.clientY - b.top - 24) / ch);
          if (i < 0 || j < 0 || i >= nr || j >= nc || vals[i][j] == null) return;
          const cfg = this.readForm(); cfg.params[r.x.name] = r.x.values[j]; cfg.params[r.y.name] = r.y.values[i]; this.cfg = cfg; $('#bForm').innerHTML = this.formHTML(cfg); this.wireForm(); this.run();
        };
      } catch (e) { $('#bSweep').innerHTML = panel('Optimization', errBox(e)); }
    },

    // ---------------------------------------------------------------- PAPER BOTS tab
    async refresh(first) {
      try {
        const j = await HUB.bot.list(); this.bots = j.bots; this.eng = j.engine;
        const e = $('#bEng'); if (e) e.innerHTML = `Engine ${j.engine.owner ? '<b class="up">ON</b>' : '<b class="down">OFF</b>'} · checks every ${j.engine.tick}s${j.engine.lastTick ? ' · last ' + new Date(j.engine.lastTick).toLocaleTimeString('en-GB') : ''} · NYSE ${j.engine.sessionOpen ? 'open' : 'closed'}${j.engine.protected ? ' · token protected' : ''}`;
        if (this.bots.length && Date.now() - backupT > 5 * 60e3) { backupT = Date.now(); HUB.bot.exportAll().then(x => U.store.set('botBackup', x)).catch(() => {}); }
        if (this.tab === 'bots') this.cards();
        if (this.tab === 'blot' && !first) this.blotter();
      } catch (e) { const c = $('#bCards'); if (c) c.innerHTML = errBox(e); }
    },
    cards() {
      const bots = this.bots || [], sum = $('#bSum'); if (!sum) return;
      const tot = U.sum(bots.map(b => b.equity)), cap = U.sum(bots.map(b => b.capital)), today = U.sum(bots.map(b => b.today));
      const backup = U.store.get('botBackup', null), canRestore = !bots.length && backup && backup.bots && backup.bots.length;
      const e = this.eng || {};
      sum.innerHTML = `<div class="kpis">${[['Paper equity', money(tot)], ['Total P&L', pnlTxt(tot - cap)], ['Today', pnlTxt(today)], ['Bots running', `${bots.filter(b => b.status === 'running').length} / ${bots.length}`], ['Open positions', bots.filter(b => b.qty).length]].map(([l, v]) => `<div class="kpi2"><span>${l}</span><b>${v}</b></div>`).join('')}</div>
        <div class="toolbar"><button class="btn" id="bNew">+ New paper bot</button><button class="btn ghost sm" id="bExp">Export bots</button><label class="btn ghost sm">Import<input type="file" id="bImp" accept=".json,application/json" hidden></label>
        ${canRestore ? `<button class="btn sm" id="bRestore">Restore ${backup.bots.length} bot${backup.bots.length > 1 ? 's' : ''} saved in this browser</button>` : ''}</div>
        ${!e.persistent && bots.length ? `<div class="warnbox small">Bots are saved on the server in <code>${esc(e.dataDir || '')}</code>. Free cloud plans (Render free) erase that disk when the server restarts or sleeps, and stop the engine while asleep. Agula keeps a backup of your bots in this browser and offers to restore it; for bots that keep running 24/7, use an always-on plan with a persistent disk and set <code>AGULA_DATA_DIR</code>.</div>` : ''}`;
      $('#bNew').addEventListener('click', () => this.newBot());
      $('#bExp').addEventListener('click', async () => { try { const x = await HUB.bot.exportAll(); APP.saveFile(`agula-bots-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(x, null, 1)); } catch (err) { APP.toast(err.message, 'err'); } });
      $('#bImp').addEventListener('change', async ev => { const f = ev.target.files[0]; if (!f) return; try { const r = await HUB.bot.importAll(JSON.parse(await f.text())); APP.toast(`Imported ${r.added} bot(s).`, 'ok'); this.refresh(); } catch (err) { APP.toast('Import failed: ' + err.message, 'err'); } });
      if (canRestore) $('#bRestore').addEventListener('click', async () => { try { const r = await HUB.bot.importAll(backup); APP.toast(`Restored ${r.added} bot(s) from this browser.`, 'ok'); this.refresh(); } catch (err) { APP.toast(err.message, 'err'); } });
      const box = $('#bCards');
      box.innerHTML = bots.length ? bots.map(b => {
        const [st, cl] = STATUS[b.status] || [b.status.toUpperCase(), 'off'];
        const pos = b.qty ? `${b.qty > 0 ? 'LONG' : 'SHORT'} ${U.fmt(Math.abs(b.qty), Math.abs(b.qty) < 10 ? 4 : 2)} @ ${U.fmtPx(b.entryPx)}` : 'FLAT';
        return `<div class="botcard ${b.id === this.sel ? 'on' : ''}" data-id="${b.id}"><div class="bc1"><b>${esc(b.name)}</b><span class="chipst ${cl}">${st}</span></div>
          <div class="bc2"><span class="key">${esc(b.symbol)}</span> · ${esc(b.label)} · ${esc(b.tf)}</div>
          <div class="bc3"><span class="mono">${money(b.equity)}</span>${pnlTxt(b.pnl)}<span class="${U.cls(b.pnlPct)}">${U.fmtPct(b.pnlPct, 2)}</span></div>
          <canvas class="spk" id="bsp-${b.id}"></canvas><div class="bc4"><span>${pos}</span><span class="muted">${b.lastPx ? 'last ' + U.fmtPx(b.lastPx) : ''}</span></div></div>`;
      }).join('') : `<div class="empty"><p>No paper bots yet.</p><p class="small">Test a strategy on the <b>BACKTEST</b> tab, then press <b>Deploy as paper bot</b>, or create one here with <b>+ New paper bot</b>.</p></div>`;
      bots.forEach(b => { const el = document.getElementById('bsp-' + b.id); if (el && b.spark.length > 1) CK.spark(el, b.spark); });
      box.onclick = ev => { const c = ev.target.closest('.botcard'); if (!c) return; this.sel = c.dataset.id; U.store.set('botSel', this.sel); $$('.botcard').forEach(x => x.classList.toggle('on', x === c)); this.detail(); };
      if (this.sel && bots.some(b => b.id === this.sel)) this.detail(true); else $('#bDetail').innerHTML = '';
    },
    newBot(cfg) {
      this.formMode = 'bot';
      const c = cfg || this.cfg || this.defaults();
      $('#bDetail').innerHTML = panel('New paper bot', `<div id="bForm">${this.formHTML(c)}</div><div class="row mt"><button class="btn" id="bCreate">Create and start</button><button class="btn ghost" id="bCreateStop">Create stopped</button><button class="btn ghost" id="bCancel">Cancel</button></div>
        <p class="hint">The bot trades simulated money on live (delayed) quotes: it checks every ${this.eng?.tick || 30} seconds, acts on each closed bar's signal, and applies your stops and limits. No real orders are ever sent.</p>`, { id: 'bNewP' });
      this.wireForm();
      const go = async start => { const f = this.readForm(); try { const b = await HUB.bot.create({ ...f, start }); this.sel = b.id; U.store.set('botSel', b.id); APP.toast(`Paper bot "${b.name}" created${start ? ' and running' : ''}.`, 'ok'); this.formMode = 'bt'; const d = $('#bDetail'); d.innerHTML = ''; d.dataset.id = ''; this.refresh(); } catch (e) { APP.toast(e.message, 'err', 7000); } };
      $('#bCreate').addEventListener('click', () => go(true)); $('#bCreateStop').addEventListener('click', () => go(false));
      $('#bCancel').addEventListener('click', () => { $('#bDetail').innerHTML = ''; this.formMode = 'bt'; });
      $('#bNewP').scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    async detail(quiet) {
      const box = $('#bDetail'); if (!box || $('#bNewP')) return;
      let b; try { b = await HUB.bot.get(this.sel); } catch (e) { box.innerHTML = errBox(e); return; }
      if (quiet && box.dataset.id === b.id && box.dataset.n === String(b.nOrders) && box.dataset.u === String(b.updated)) return;
      if (quiet && box.dataset.id === b.id && document.activeElement && box.contains(document.activeElement) && /INPUT|SELECT/.test(document.activeElement.tagName)) return;   // don't redraw while the user is typing
      box.dataset.id = b.id; box.dataset.n = b.nOrders; box.dataset.u = b.updated;
      const [st, cl] = STATUS[b.status] || [b.status, 'off'];
      const S = this.meta.strategies[b.strategy];
      const rk = k => b[k] == null ? '' : b[k];
      const rf = (k, lab, ph = 'off') => `<div class="field"><label>${lab}</label><div class="inwrap"><input class="num" type="number" step="0.5" data-k="${k}" value="${rk(k)}" placeholder="${ph}"><em>%</em></div></div>`;
      const d = x => new Date(x).toLocaleString('en-GB', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      box.innerHTML = `<div class="grid g2 mt">
        ${panel(`${esc(b.name)} <span class="chipst ${cl}">${st}</span>`, `<div class="kvgrid c3">${kv('Equity', money(b.equity))}${kv('P&L', pnlTxt(b.pnl))}${kv('Return', U.fmtPct(b.pnlPct, 2), U.cls(b.pnlPct))}${kv('Today', pnlTxt(b.today))}${kv('Cash', money(b.cash))}${kv('Unrealized', pnlTxt(b.unrealized))}
            ${kv('Position', b.qty ? `${b.qty > 0 ? 'LONG' : 'SHORT'} ${U.fmt(Math.abs(b.qty), 4)}` : 'FLAT')}${kv('Entry', U.fmtPx(b.entryPx))}${kv('Last price', U.fmtPx(b.lastPx))}
            ${kv('Strategy', esc(S?.label || b.strategy))}${kv('Parameters', esc(Object.entries(b.params).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'))}${kv('Last signal', b.lastSignal == null ? '—' : b.lastSignal > 0 ? 'LONG' : b.lastSignal < 0 ? 'SHORT' : 'FLAT')}</div>
          ${b.haltReason ? `<div class="warnbox small mt">${esc(b.haltReason)}</div>` : ''}
          <div class="row mt">${b.status === 'running' ? '<button class="btn ghost" data-act="stop">Stop</button><button class="btn ghost" data-act="stopflat">Stop &amp; flatten</button>' : '<button class="btn" data-act="start">Start</button>'}
            <button class="btn ghost" data-act="reset">Reset</button><button class="btn ghost" data-act="delete">Delete</button><button class="btn ghost" data-act="chart">Chart ${esc(b.symbol)}</button><span id="bConf"></span></div>`, { badge: `${esc(b.symbol)} · ${esc(b.tf)}` })}
        ${panel('Equity', '<div class="cv"><canvas id="bdEq"></canvas></div>')}
        ${panel('Order ticket (paper)', `<div class="fields"><div class="field"><label>Quantity</label><input class="num" id="tQty" type="number" min="0" step="any" placeholder="units"></div><div class="field"><label>or % of equity</label><div class="inwrap"><input class="num" id="tPct" type="number" min="0" max="100" step="5" placeholder="e.g. 50"><em>%</em></div></div></div>
          <div class="row mt"><button class="btn buy" data-side="BUY">BUY</button><button class="btn sell" data-side="SELL">SELL</button><button class="btn ghost" data-side="FLAT">FLATTEN</button></div>
          <p class="hint">Fills immediately at the latest quote ± ${b.slip_bps}bp slippage, ${b.fee_bps}bp commission. No leverage${b.allow_short ? '; shorts allowed' : '; shorts off'}.</p>`)}
        ${panel('Risk settings', `<div class="fields">${rf('size_pct', 'Position size', '100')}${rf('stop_pct', 'Stop-loss')}${rf('take_pct', 'Take-profit')}${rf('trail_pct', 'Trailing stop')}${rf('daily_loss_pct', 'Daily loss limit')}${rf('max_dd_pct', 'Max drawdown halt')}</div>
          <label class="chk mt"><input type="checkbox" data-k="allow_short" ${b.allow_short ? 'checked' : ''}> Allow shorts</label> <label class="chk mt"><input type="checkbox" data-k="session_only" ${b.session_only !== false ? 'checked' : ''}> US session only</label>
          <div class="row mt"><button class="btn ghost" id="bSave">Save risk settings</button></div>`)}
        ${panel('Orders', `<div class="tblwrap short"><table class="tbl"><thead><tr><th>Time</th><th>Side</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Fee</th><th class="r">Realized</th><th>Reason</th></tr></thead><tbody>${b.orders.slice().reverse().map(o => `<tr><td class="small">${d(o.t)}</td><td class="${o.side === 'BUY' ? 'up' : 'down'}">${o.side}</td><td class="r">${U.fmt(o.qty, 4)}</td><td class="r">${U.fmtPx(o.px)}</td><td class="r muted">${money(o.fee)}</td><td class="r">${o.realized ? pnlTxt(o.realized) : '—'}</td><td>${esc(WHY[o.why] || o.why)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No orders yet. The bot trades when its signal changes.</td></tr>'}</tbody></table></div>`, { cls: 'span2' })}
        ${panel('Bot log', `<div class="botlog">${b.log.slice().reverse().map(l => `<div class="${l.level}"><span>${d(l.t)}</span>${esc(l.msg)}</div>`).join('')}</div>`, { cls: 'span2' })}</div>`;
      const eq = b.equityHist.map(x => [x[0], x[1]]);
      if (eq.length > 1) CK.xy($('#bdEq'), { series: [{ name: 'Equity', data: eq, color: CK.colors().key, fill: true }], hlines: [{ y: b.capital, label: 'start' }], xFmt: t => new Date(t).toLocaleString('en-GB', eq[eq.length - 1][0] - eq[0][0] < 2 * 86400e3 ? { hour: '2-digit', minute: '2-digit' } : { month: 'short', day: 'numeric' }), yFmt: v => '$' + U.fmt(v, 0) });
      else $('#bdEq').parentElement.innerHTML = '<div class="empty small">The equity curve fills in as the bot runs (one point every 5 minutes).</div>';
      box.onclick = ev => this.detailClick(ev, b);
    },
    async detailClick(ev, b) {
      const a = ev.target.closest('[data-act]'), sd = ev.target.closest('[data-side]');
      if (ev.target.id === 'bSave') {
        const risk = {}; $$('#bDetail [data-k]').forEach(el => { if (el.type === 'checkbox') return; risk[el.dataset.k] = el.value === '' ? '' : +el.value; });
        risk.allow_short = $('#bDetail [data-k=allow_short]').checked;
        try { await HUB.bot.action(b.id, 'update', { risk, session_only: $('#bDetail [data-k=session_only]').checked }); APP.toast('Risk settings saved.', 'ok'); this.after(); } catch (e) { APP.toast(e.message, 'err', 7000); }
        return;
      }
      if (sd) {
        const body = { side: sd.dataset.side, qty: +$('#tQty').value || 0, pct: +$('#tPct').value || 0 };
        try { await HUB.bot.action(b.id, 'order', body); APP.toast(`Paper ${body.side} filled.`, 'ok'); this.after(); } catch (e) { APP.toast(e.message, 'err', 7000); }
        return;
      }
      if (!a) return;
      const act = a.dataset.act;
      if (act === 'chart') { APP.open('CHART', b.symbol); return; }
      if ((act === 'delete' || act === 'reset') && a.dataset.sure !== '1') { a.dataset.sure = '1'; a.textContent = act === 'delete' ? 'Confirm delete' : 'Confirm reset'; a.classList.add('danger'); setTimeout(() => { if (a.isConnected) { a.dataset.sure = ''; a.textContent = act === 'delete' ? 'Delete' : 'Reset'; a.classList.remove('danger'); } }, 4000); return; }
      try {
        if (act === 'stopflat') await HUB.bot.action(b.id, 'stop', { flatten: true });
        else await HUB.bot.action(b.id, act);
        if (act === 'delete') { this.sel = null; U.store.set('botSel', null); }
        this.after();
      } catch (e) { APP.toast(e.message, 'err', 7000); }
    },
    async after() { document.activeElement?.blur?.(); await this.refresh(); if (this.sel) this.detail(); },
    async kill(btn) {
      if (btn.dataset.sure !== '1') { btn.dataset.sure = '1'; btn.textContent = 'CONFIRM: STOP ALL & FLATTEN'; setTimeout(() => { if (btn.isConnected) { btn.dataset.sure = ''; btn.textContent = 'KILL SWITCH'; } }, 4000); return; }
      btn.dataset.sure = ''; btn.textContent = 'KILL SWITCH';
      try { const r = await HUB.bot.kill(); APP.toast(`Kill switch: ${r.stopped} bot(s) stopped, positions flattened.`, 'alert', 8000); this.refresh(); } catch (e) { APP.toast(e.message, 'err', 7000); }
    },

    // ---------------------------------------------------------------- BLOTTER tab
    async blotter() {
      const box = $('#bBlot'); if (!box) return;
      try {
        const list = (await HUB.bot.list()).bots, full = await Promise.all(list.map(b => HUB.bot.get(b.id).catch(() => null)));
        this.orders = full.filter(Boolean).flatMap(b => b.orders).sort((a, b) => b.t - a.t);
        const d = x => new Date(x).toLocaleString('en-GB', { year: '2-digit', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        box.innerHTML = this.orders.length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>Time</th><th>Bot</th><th>Symbol</th><th>Side</th><th class="r">Qty</th><th class="r">Price</th><th class="r">Notional</th><th class="r">Fee</th><th class="r">Realized</th><th>Reason</th></tr></thead><tbody>${this.orders.slice(0, 500).map(o => `<tr><td class="small">${d(o.t)}</td><td>${esc(o.name)}</td><td class="key">${esc(o.symbol)}</td><td class="${o.side === 'BUY' ? 'up' : 'down'}">${o.side}</td><td class="r">${U.fmt(o.qty, 4)}</td><td class="r">${U.fmtPx(o.px)}</td><td class="r">${money(o.qty * o.px)}</td><td class="r muted">${money(o.fee)}</td><td class="r">${o.realized ? pnlTxt(o.realized) : '—'}</td><td>${esc(WHY[o.why] || o.why)}</td></tr>`).join('')}</tbody></table></div>`
          : '<div class="empty small">No paper orders yet.</div>';
      } catch (e) { box.innerHTML = errBox(e); }
    },
    csv() {
      const rows = this.orders || []; if (!rows.length) { APP.toast('No orders to export.', 'err'); return; }
      const head = ['time_utc', 'bot', 'symbol', 'side', 'qty', 'price', 'fee', 'realized', 'reason'];
      const q = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
      APP.saveFile('agula-paper-orders.csv', [head.join(','), ...rows.map(o => [new Date(o.t).toISOString(), o.name, o.symbol, o.side, o.qty, o.px, o.fee, o.realized, o.why].map(q).join(','))].join('\n'));
    },
  });
})();
