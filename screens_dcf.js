/* ============================================================================
   Agula Terminal — DCF: Damodaran-style FCFF valuation
   drivers from history · bottom-up cost of capital from Damodaran's data ·
   stable-growth terminal value · sensitivities, scenarios, Monte Carlo,
   reverse DCF, football field, comparables · Excel model built on the server
   ========================================================================== */
'use strict';

(() => {
  const { panel, kv, $, $$ } = APP;
  const esc = U.esc, isNum = U.isNum;
  const saved = new Map();                 // sym -> { A, look, indName, ctryName } for this session
  let weights = { bear: 0.25, base: 0.5, bull: 0.25 };
  const pct = (v, d = 1) => isNum(v) ? U.fmtPct(v, d, false) : '—';
  const pctS = (v, d = 1) => isNum(v) ? U.fmtPct(v, d) : '—';
  const xf = (v, d = 2) => isNum(v) ? U.fmt(v, d) + '×' : '—';
  const M = 1e6, B = 1e9;

  // input helpers: data-f = assumption field, data-u = unit (% stored as decimal, x, n, bn, m)
  const toIn = (u, v) => !isNum(v) ? '' : u === '%' ? +(v * 100).toFixed(2) : u === 'bn' ? +(v / B).toFixed(Math.abs(v) < B ? 3 : 2) : u === 'm' ? +(v / M).toFixed(1) : +(+v).toFixed(u === 'n' ? 3 : 2);
  const fromIn = (u, v) => u === '%' ? v / 100 : u === 'bn' ? v * B : u === 'm' ? v * M : v;
  const inp = (f, u, v, step, attrs = '') => `<div class="inwrap"><input class="num" data-f="${f}" data-u="${u}" type="number" step="${step}" value="${toIn(u, v)}" ${attrs}><em>${u === '%' ? '%' : u === 'x' ? '×' : u === 'bn' ? '$bn' : u === 'm' ? 'm' : ''}</em></div>`;
  const sel = (k, opts, cur) => `<select data-s="${k}">${Object.entries(opts).map(([v, l]) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const src = t => t ? `<span class="srcnote">${esc(t)}</span>` : '';

  APP.register('DCF', {
    title: 'DCF Valuation',
    async render(root, { sym }) {
      root.innerHTML = '<div class="empty">Loading financial statements and Damodaran\'s cost-of-capital data…</div>';
      let f, bars;
      try { [f, bars] = await Promise.all([HUB.fundamentals(sym), HUB.history(sym, '1D')]); }
      catch (e) { root.innerHTML = `<div class="empty err">${esc(e.message)}<br><br>Try a company such as <a href="#" data-s="AAPL">AAPL</a>, <a href="#" data-s="KO">KO</a> or <a href="#" data-s="XOM">XOM</a>.</div>`; root.onclick = ev => { const a = ev.target.closest('[data-s]'); if (a) { ev.preventDefault(); APP.open('DCF', a.dataset.s); } }; return; }
      root.onclick = null;
      const [bench, uni, dam, prof] = await Promise.all([HUB.history('^GSPC', '1D').catch(() => null), HUB.universe().catch(() => null),
        HUB.damodaran(f.industry, f.sector, f.country).catch(e => ({ error: e.message })), HUB.profile(sym).catch(() => ({}))]);
      await HUB.curve().catch(() => null);                                          // sets the live 10-year risk-free rate
      const q = HUB.quote(sym) || await HUB.refreshQuote(sym).catch(() => null) || { last: U.last(bars).c };
      const st = Q.perfStats(bars, bench, HUB.rf());
      const peers = uni ? compsFor(sym, f.sector, uni.rows) : [];
      const others = peers.filter(p => p.sym !== sym).map(p => p.evEbitda).filter(v => v > 0 && v < 60);
      const exitMultiple = others.length > 1 ? +U.quantile(others, 0.5).toFixed(1) : 12;
      const mkt = { price: q.last, rf: HUB.rf(), beta: isNum(f.beta) ? f.beta : st.beta, exitMultiple };
      const damOk = dam && !dam.error && Object.keys(dam.industries || {}).length > 0;
      this.ctx = { sym, f, q, bars, st, peers, dam: damOk ? dam : null, damErr: dam?.error || (dam && !damOk ? 'the server could not download it' : null), mkt, prof };
      const s = saved.get(sym);
      this.build(s ? s.indName : this.ctx.dam?.match?.industry, s ? s.ctryName : this.ctx.dam?.match?.country, s);

      const warn = [];
      if (prof.currency && f.currency && prof.currency !== f.currency) warn.push(`Financial statements are reported in ${f.currency} but the share price is in ${prof.currency}. Convert one of them before relying on the value per share.`);
      if (this.ctx.A.financial) warn.push('Banks and insurers fund operations with debt and deposits, so a free-cash-flow-to-firm DCF does not describe them well; Damodaran values them with dividend-discount or excess-return models. Numbers below are illustrative.');
      if (!this.ctx.dam) warn.push(`Damodaran's data couldn't be downloaded (${this.ctx.damErr || 'no answer'}), so the cost of capital uses fallbacks: the built-in January 2026 implied ERP (4.23%), Yahoo's regression beta and the interest-to-debt cost of debt. Try again later.`);
      if (this.ctx.A.margin0 < 0.05 && this.ctx.A.g1 > 0.15) warn.push('This company is barely profitable and growing fast: the target margin and the year it is reached drive most of the value. Test them in the drivers table.');

      root.innerHTML = `
        <div class="dcf-hero" id="dHero"></div>
        ${warn.map(w => `<div class="warnbox">${esc(w)}</div>`).join('')}
        <div class="grid dcfgrid">
          <div class="stack">
            ${panel('Cost of capital · Damodaran bottom-up', '<div id="dCoc"></div>', { badge: 'DAMODARAN' })}
            ${panel('Model structure', '<div id="dStruct"></div>')}
            ${panel('Equity bridge', '<div id="dBridgeIn"></div>')}
            ${panel('Damodaran data', '<div id="dDamo"></div>')}
          </div>
          <div class="stack">
            ${panel('Forecast drivers · from the company\'s history', '<div id="dDrv"></div>', { tools: `<div class="seg" id="dLook"><button data-look="3">Last 3 yrs</button><button data-look="5">All years</button></div><button class="btn ghost sm" data-act="reset">Reset all</button>` })}
            ${panel('Projected free cash flow to the firm', '<div id="dTable" class="tblwrap"></div><div class="hint">Growth and margin cells are editable per year (blue). Figures in millions. The last column is the first stable-growth year that feeds the terminal value.</div>', { tools: '<button class="btn ghost sm" data-act="paths">Reset yearly paths</button>' })}
            <div class="grid g2">
              ${panel('Revenue and free cash flow ($bn)', '<div class="cv"><canvas id="cRev"></canvas></div>')}
              ${panel('Revenue growth path', '<div class="cv"><canvas id="cGrowth"></canvas></div>')}
              ${panel('EBIT margin, return on capital and cost of capital', '<div class="cv"><canvas id="cRet"></canvas></div>')}
              ${panel('Where the value comes from ($bn)', '<div class="cv"><canvas id="cPV"></canvas></div>')}
              ${panel('Cost of capital build-up', '<div class="cv"><canvas id="cWacc"></canvas></div>')}
              ${panel('Enterprise value to equity ($bn)', '<div class="cv"><canvas id="cBridge"></canvas></div>')}
            </div>
            <div class="grid g2">
              ${panel('Sensitivity · value per share', '<div class="seg" id="dSensSel"><button data-v="wg" class="on">WACC × growth</button><button data-v="wx">WACC × exit multiple</button><button data-v="gm">Growth × margin</button><button data-v="rg">ROIC × growth</button></div><div id="dSens" class="tblwrap"></div>')}
              ${panel('Scenarios', '<div id="dScen"></div>')}
            </div>
            <div class="grid g2">
              ${panel('Monte Carlo · 4,000 runs', '<div class="cv"><canvas id="dMc"></canvas></div><div id="dMcStats" class="kvgrid c3"></div>')}
              ${panel('Reverse DCF', '<div id="dRev2"></div>')}
            </div>
            ${panel('Valuation range (football field)', '<div class="cv"><canvas id="dFoot"></canvas></div>')}
            ${panel('Company vs Damodaran industry and US market', '<div id="dBench" class="tblwrap"></div>')}
            ${peers.length ? panel(`Comparable companies · ${esc(f.sector)} and market`, '<div id="dComps" class="tblwrap"></div>') : ''}
            ${panel('Historical financials', histHTML(f))}
          </div>
        </div>`;

      // ---- one set of delegated listeners for every input on the screen
      root.addEventListener('change', e => this.onChange(e));
      root.addEventListener('click', e => {
        const b = e.target.closest('[data-act]');
        if (b) { const a = b.dataset.act;
          if (a === 'xlsx') this.exportXlsx(); else if (a === 'csv') this.exportCsv();
          else if (a === 'reset') { saved.delete(sym); APP.open('DCF', sym); }
          else if (a === 'paths') { this.ctx.A.growthPath = null; this.ctx.A.marginPath = null; this.recalc(); }
          return; }
        const lk = e.target.closest('[data-look]');
        if (lk) { this.ctx.A.look = +lk.dataset.look; this.rederive(); return; }
        const sv = e.target.closest('#dSensSel button');
        if (sv) { this.sensMode = sv.dataset.v; $$('#dSensSel button').forEach(x => x.classList.toggle('on', x === sv)); this.drawSens(); }
        const pr = e.target.closest('#dComps [data-s]');
        if (pr && pr.dataset.s !== sym) APP.open('DCF', pr.dataset.s);
      });
      this.sensMode = 'wg';
      this.recalc();
      if (peers.length) this.drawComps();
    },

    // ------------------------------------------------------------------ assumptions
    damCtx(indName, ctryName) {
      const d = this.ctx.dam; if (!d) return null;
      const names = Object.keys(d.industries);
      indName = names.includes(indName) ? indName : d.match?.industry;
      ctryName = d.countries[ctryName] ? ctryName : d.match?.country || 'United States';
      const country = d.countries[ctryName] ? { name: ctryName, ...d.countries[ctryName] } : null;
      const us = d.countries['United States'] ? { name: 'United States', ...d.countries['United States'] } : null;
      const market = d.industries['Total Market'] || null;
      return { ind: d.industries[indName] || null, indName, country, us, market, ratings: d.ratings, erp: d.erp };
    },
    build(indName, ctryName, keep) {
      const c = this.ctx; c.dc = this.damCtx(indName, ctryName);
      const out = DCFM.build(c.f, c.dc, c.mkt, { look: keep?.A?.look || 5, methods: keep?.A?.methods });
      if (keep && keep.A) {                                   // same company again this session: keep the user's edits
        out.A = keep.A; out.A.price = c.mkt.price; out.drivers = DCFM.deriveDrivers(c.f, c.dc?.ind, out.A.look); DCFM.applyDrivers(out.A, out.drivers);
      }
      c.A = out.A; c.drivers = out.drivers; c.rating = out.rating;
      saved.set(c.sym, { A: c.A, indName: c.dc?.indName, ctryName: c.dc?.country?.name });
    },
    rederive() {
      const { A, f, dc } = this.ctx;
      this.ctx.drivers = DCFM.deriveDrivers(f, dc?.ind, A.look);
      DCFM.applyDrivers(A, this.ctx.drivers); DCFM.resolveDerived(A); this.recalc();
    },
    onChange(e) {
      const t = e.target, { A, drivers } = this.ctx;
      if (t.matches('[data-f]')) {
        const v = parseFloat(t.value); if (!isFinite(v)) return;
        const fld = t.dataset.f; A[fld] = fromIn(t.dataset.u, v);
        if (fld === 'de') A.deMethod = 'manual';
        if (fld === 'termGrowth') A.tgMethod = 'manual';
        if (fld === 'roicStable') A.roicMethod = 'manual';
        if (fld === 'betaManual') A.betaMethod = 'manual';
        if (fld === 'kdManual') A.kdMethod = 'manual';
        if (fld === 'kdSpread') { A.kdMethod = 'rating'; A.rating = 'manual spread'; }
        if (fld === 'waccOverride' || fld === 'stableWaccOverride') { /* stays until the box is cleared */ }
        if (['years', 'hgYears', 'convYear'].includes(fld)) { A[fld] = Math.round(A[fld]); A.growthPath = null; A.marginPath = null; }
      } else if (t.matches('[data-s]')) {
        const k = t.dataset.s, v = t.value;
        if (k === 'industry') { this.build(v, this.ctx.dc?.country?.name, null); APP.toast(`Assumptions rebuilt for Damodaran's "${v}" industry`, 'ok'); }
        else if (k === 'country') { const keepInd = this.ctx.dc?.indName; this.build(keepInd, v, null); APP.toast(`Country risk and tax set for ${v}`, 'ok'); }
        else { A[k] = ['years', 'hgYears', 'convYear'].includes(k) ? +v : v === 'true' ? true : v === 'false' ? false : v; if (['years', 'hgYears', 'convYear'].includes(k)) { A.growthPath = null; A.marginPath = null; } }
      } else if (t.matches('[data-dm]')) {                         // driver method
        const d = drivers[t.dataset.dm]; A.methods[d.key] = t.value; DCFM.applyDrivers(A, drivers);
        if (d.key === 'growth') A.growthPath = null; if (d.key === 'margin') A.marginPath = null;
      } else if (t.matches('[data-dv]')) {                         // driver typed by hand
        const d = drivers[t.dataset.dv], v = parseFloat(t.value); if (!isFinite(v)) return;
        A[d.field] = d.unit === '%' ? v / 100 : v; A.methods[d.key] = 'manual'; d.method = 'manual'; d.value = A[d.field];
        if (d.key === 'growth') A.growthPath = null; if (d.key === 'margin') A.marginPath = null;
      } else if (t.matches('input[data-k]')) {                     // per-year growth / margin
        const i = +t.dataset.i, v = parseFloat(t.value) / 100; if (!isFinite(v)) return;
        const r = DCFM.dcf(A);
        if (t.dataset.k === 'g') { A.growthPath = r.rows.map(x => x.growth); A.growthPath[i] = v; } else { A.marginPath = r.rows.map(x => x.margin); A.marginPath[i] = v; }
      } else if (t.matches('[data-w]')) { weights[t.dataset.w] = U.clamp(parseFloat(t.value) / 100 || 0, 0, 1); this.drawScen(); return; }
      else if (t.id === 'dWo' || t.id === 'dWso') { const k = t.id === 'dWo' ? 'waccOverride' : 'stableWaccOverride'; const r = DCFM.dcf(A); A[k] = t.checked ? (k === 'waccOverride' ? r.coc.wacc : r.coc.waccStable) : null; }
      else return;
      DCFM.resolveDerived(A); this.recalc();
    },

    // ------------------------------------------------------------------ redraw everything
    recalc() {
      const { A, q, f } = this.ctx;
      if (A.growthPath && A.growthPath.length !== A.years) A.growthPath = null;
      if (A.marginPath && A.marginPath.length !== A.years) A.marginPath = null;
      A.hgYears = U.clamp(A.hgYears, 1, A.years); A.convYear = U.clamp(A.convYear, 1, A.years);
      const r = DCFM.dcf(A); this.r = r;
      const up = r.upside, bad = !(r.WS > A.termGrowth);
      $('#dHero').innerHTML = `<div class="hero-main"><span class="lab">Fair value per share</span><span class="val ${U.cls(up)}">${isNum(r.perShare) ? U.fmtPx(r.perShare) : '—'}</span><span class="upl ${U.cls(up)}">${isNum(up) ? U.fmtPct(up, 1) + (up >= 0 ? ' upside' : ' downside') : ''}</span><span class="muted">vs price ${U.fmtPx(q.last)}</span></div>
        <div class="hero-kv">${kv('Enterprise value', U.fmtBig(r.ev))}${kv('Equity value', U.fmtBig(r.equity))}${kv('Cost of capital', `${pct(r.W0, 2)} → ${pct(r.WS, 2)}`)}${kv('Terminal value share of EV', pct(r.tvShare, 0), r.tvShare > 0.8 ? 'down' : '')}
          ${kv(A.tvMethod === 'exit' ? 'Implied perpetual growth' : 'Implied exit EV/EBITDA', A.tvMethod === 'exit' ? pct(r.impliedG, 2) : U.fmtX(r.impliedExit))}${kv('EV / next-year EBITDA', U.fmtX(r.evEbitdaNTM))}</div>
        <div class="hero-act"><button class="btn" data-act="xlsx">Export Excel model</button><button class="btn ghost" data-act="csv">CSV</button><span class="muted small">${esc(f.source)} · latest FY${A.baseYear}${this.ctx.dc ? ' · cost of capital: Damodaran' : ''}</span></div>
        ${bad ? '<div class="warnbox">The stable-period cost of capital must be above terminal growth. Raise it or lower terminal growth.</div>' : ''}`;
      $$('#dLook button').forEach(b => b.classList.toggle('on', +b.dataset.look === (A.look >= 5 ? 5 : 3)));
      this.drawCoc(); this.drawStruct(); this.drawBridgeIn(); this.drawDamo(); this.drawDrivers(); this.drawTable(); this.drawCharts();
      this.drawSens(); this.drawScen(); this.drawMC(); this.drawReverse(); this.drawFoot(); this.drawBench();
      saved.set(this.ctx.sym, { A, indName: this.ctx.dc?.indName, ctryName: this.ctx.dc?.country?.name });
    },

    drawCoc() {
      const { A, dc, dam } = this.ctx, c = this.r.coc;
      const indOpts = dam ? Object.fromEntries(Object.keys(dam.industries).sort().map(n => [n, n])) : null;
      const ctyOpts = dam ? Object.fromEntries(Object.keys(dam.countries).sort().map(n => [n, n])) : null;
      const ratingNote = A.kdMethod === 'rating' ? `${A.rating || '—'} · interest coverage ${isNum(A.coverage) ? A.coverage.toFixed(1) + '×' : '—'}` : A.kdMethod === 'actual' ? 'interest expense ÷ debt' : 'manual';
      $('#dCoc').innerHTML = `
        ${dam ? `<div class="fields"><div class="field"><label>Damodaran industry</label>${sel('industry', indOpts, dc?.indName)}${src(dam.match?.industry === dc?.indName ? 'matched from ' + dam.match.how : 'chosen by you')}</div>
          <div class="field"><label>Country (risk premium, tax)</label>${sel('country', ctyOpts, dc?.country?.name)}${src('company headquarters: ' + (this.ctx.f.country || '—'))}</div></div>` : ''}
        <h4 class="subh">Cost of equity</h4>
        <div class="fields">
          <div class="field"><label>Risk-free rate (10-year Treasury)</label>${inp('rf', '%', A.rf, 0.05)}${src('US Treasury / FRED, latest')}</div>
          <div class="field"><label>Equity risk premium (implied)</label>${inp('erp', '%', A.erp, 0.05)}${src(A.src.erp)}</div>
          <div class="field"><label>Country risk adjustment</label>${inp('crp', '%', A.crp, 0.05)}${src(A.src.crp)}</div>
          <div class="field"><label>Unlevered beta (industry, cash-adjusted)</label>${inp('betaU', 'n', A.betaU, 0.01)}${src(A.src.betaU)}</div>
          <div class="field"><label>Debt / equity (market)</label>${inp('de', '%', A.de, 0.5)}${src(A.deMethod === 'company' ? 'company: debt ÷ market cap' : A.deMethod === 'industry' ? 'Damodaran industry average' : 'manual')}</div>
          <div class="field"><label>D/E source</label>${sel('deMethod', { company: 'Company (market)', industry: 'Industry average', manual: 'Manual' }, A.deMethod)}</div>
          <div class="field"><label>Marginal tax rate</label>${inp('taxMarg', '%', A.taxMarg, 0.5)}${src(A.src.taxMarg)}</div>
          <div class="field"><label>Beta used</label>${sel('betaMethod', { bottomup: `Bottom-up relevered: ${c.betaL.toFixed(2)}`, regression: `Regression (Yahoo): ${(+A.betaRegression).toFixed(2)}`, industry: `Industry levered: ${(+A.betaIndustry).toFixed(2)}`, manual: 'Manual' }, A.betaMethod)}${A.betaMethod === 'manual' ? inp('betaManual', 'n', A.betaManual, 0.01) : ''}</div>
        </div>
        <h4 class="subh">Cost of debt</h4>
        <div class="fields">
          <div class="field"><label>Method</label>${sel('kdMethod', { rating: 'Synthetic rating (Damodaran)', actual: 'Interest ÷ debt (actual)', manual: 'Manual' }, A.kdMethod)}${src(ratingNote)}</div>
          ${A.kdMethod === 'manual' ? `<div class="field"><label>Pre-tax cost of debt</label>${inp('kdManual', '%', A.kdManual, 0.05)}</div>` : A.kdMethod === 'rating' ? `<div class="field"><label>Company default spread</label>${inp('kdSpread', '%', A.kdSpread, 0.05)}</div>` : `<div class="field"><label>Interest ÷ debt</label><div class="ro">${pct(A.kdActual, 2)}</div></div>`}
          <div class="field"><label>Country default spread</label>${inp('ctrySpread', '%', A.ctrySpread, 0.05)}${src(A.ctrySpread ? 'Damodaran: ' + (dc?.country?.name || '') : 'none for US companies')}</div>
        </div>
        <div class="kvgrid c2 mt">${kv('Levered beta', c.beta.toFixed(2))}${kv('Total ERP', pct(c.erpT, 2))}${kv('Cost of equity', pct(c.ke, 2))}${kv('Cost of debt, pre-tax', pct(c.kdPre, 2))}${kv('Cost of debt, after tax', pct(c.kdAfter, 2))}${kv('Debt / capital', pct(c.wd, 1))}${kv('WACC (high-growth years)', pct(c.wacc, 2), 'key')}</div>
        <h4 class="subh">Stable growth (after year ${A.years})</h4>
        <div class="fields">
          <div class="field"><label>Stable beta</label>${inp('stableBeta', 'n', A.stableBeta, 0.05)}${src('mature firms move towards 1')}</div>
          <div class="field"><label>Stable debt / capital</label>${inp('stableWd', '%', A.stableWd, 0.5)}${src(dc?.ind ? 'Damodaran industry D/(D+E)' : 'company today')}</div>
        </div>
        <div class="kvgrid c2 mt">${kv('Stable cost of equity', pct(c.keS, 2))}${kv('Stable WACC', pct(c.waccStable, 2), 'key')}${dc?.ind && isNum(dc.ind.wacc) ? kv('Industry WACC', pct(dc.ind.wacc, 2)) : ''}${dc?.market && isNum(dc.market.wacc) ? kv('US market WACC', pct(dc.market.wacc, 2)) : ''}</div>
        <div class="row mt"><label class="chk"><input type="checkbox" id="dWo" ${A.waccOverride != null ? 'checked' : ''}> Override WACC</label>${A.waccOverride != null ? inp('waccOverride', '%', A.waccOverride, 0.05) : ''}</div>
        <div class="row"><label class="chk"><input type="checkbox" id="dWso" ${A.stableWaccOverride != null ? 'checked' : ''}> Override stable WACC</label>${A.stableWaccOverride != null ? inp('stableWaccOverride', '%', A.stableWaccOverride, 0.05) : ''}</div>`;
    },
    drawStruct() {
      const { A } = this.ctx, r = this.r;
      const yrs = n => Object.fromEntries(U.range(n, i => [i + 1, String(i + 1)]));
      $('#dStruct').innerHTML = `<div class="fields">
        <div class="field"><label>Forecast years</label>${sel('years', { 5: '5', 7: '7', 10: '10' }, A.years)}</div>
        <div class="field"><label>High-growth years</label>${sel('hgYears', yrs(A.years), A.hgYears)}${src('then growth, tax and WACC fade to stable')}</div>
        <div class="field"><label>Margin reaches target in year</label>${sel('convYear', yrs(A.years), A.convYear)}</div>
        <div class="field"><label>Reinvestment</label>${sel('reinvMethod', { sc: 'Sales-to-capital (Damodaran)', items: 'Capex − D&A + working capital' }, A.reinvMethod)}</div>
        <div class="field"><label>Terminal growth</label>${inp('termGrowth', '%', A.termGrowth, 0.05)}</div>
        <div class="field"><label>Terminal growth rule</label>${sel('tgMethod', DCFM.TG_METHODS, A.tgMethod)}</div>
        <div class="field"><label>Return on capital, stable</label>${inp('roicStable', '%', A.roicStable, 0.5)}${src('terminal reinvestment = g ÷ ROIC = ' + pct(r.reinvRateN1, 1))}</div>
        <div class="field"><label>ROIC rule</label>${sel('roicMethod', DCFM.ROIC_METHODS, A.roicMethod)}</div>
        <div class="field"><label>Terminal value</label>${sel('tvMethod', { gordon: 'Stable growth (Gordon)', exit: 'Exit EV/EBITDA multiple', blend: 'Average of both' }, A.tvMethod)}</div>
        <div class="field"><label>Exit EV/EBITDA</label>${inp('exitMultiple', 'x', A.exitMultiple, 0.5)}${src('median of comparable companies')}</div>
        <div class="field"><label>Discounting</label>${sel('midYear', { true: 'Mid-year', false: 'Year-end' }, A.midYear)}</div>
      </div>`;
    },
    drawBridgeIn() {
      const { A } = this.ctx;
      $('#dBridgeIn').innerHTML = `<div class="fields">
        <div class="field"><label>Net debt (debt − cash)</label>${inp('netDebt', 'bn', A.netDebt, 0.1)}</div>
        <div class="field"><label>Minority interest</label>${inp('minority', 'bn', A.minority, 0.1)}</div>
        <div class="field"><label>Non-operating assets</label>${inp('investments', 'bn', A.investments, 0.1)}</div>
        <div class="field"><label>Diluted shares</label>${inp('shares', 'bn', A.shares, 0.001)}</div></div>`;
    },
    drawDamo() {
      const { dam, dc, damErr } = this.ctx;
      if (!dam) { $('#dDamo').innerHTML = `<div class="muted small">Not available: ${esc(damErr || 'no answer')}. The model uses fallbacks.</div>`; return; }
      const L = dam.links || {}, errs = Object.keys(dam.errors || {});
      const link = (k, t) => L[k] ? `<a href="${esc(L[k])}" target="_blank" rel="noopener">${t} ↗</a>` : '';
      $('#dDamo').innerHTML = `<p class="note"><b>${esc(dc?.indName || '—')}</b>${dc?.ind?.firms ? ` · ${U.fmt(dc.ind.firms, 0)} US firms` : ''}</p>
        <div class="kvgrid c2">${kv('Implied ERP', dam.erp ? pct(dam.erp.value, 2) : '—')}${kv('ERP as of', esc(dam.erp?.date || '—'))}${kv('Country', esc(dc?.country?.name || '—'))}${kv('Moody\'s rating', esc(dc?.country?.rating || '—'))}</div>
        <p class="note small mt">${[link('betas', 'Betas'), link('wacc', 'Cost of capital'), link('margin', 'Margins'), link('capex', 'Sales-to-capital'), link('ratings', 'Ratings & spreads'), link('country', 'Country risk'), link('erp', 'Implied ERP')].filter(Boolean).join(' · ')}</p>
        ${errs.length ? `<div class="warnbox">Not refreshed this time: ${esc(errs.join(', '))}. Earlier copies or fallbacks are used.</div>` : ''}
        <p class="hint">Aswath Damodaran (NYU Stern) updates the industry tables each January and the implied ERP monthly. Agula refreshes its copy daily.</p>`;
    },
    drawDrivers() {
      const { A, drivers, f } = this.ctx;
      const years = [...new Set(Object.values(drivers).flatMap(d => d.hist.map(h => h.year)))].sort();
      const fmtV = (d, v) => !isNum(v) ? '—' : d.unit === '%' ? U.fmtPct(v, 1, false) : v.toFixed(2) + '×';
      $('#dDrv').innerHTML = `<table class="tbl drv"><thead><tr><th>Driver</th>${years.map(y => `<th class="r hist">FY${y}</th>`).join('')}<th>Method</th><th class="r">Industry</th><th class="r">Used</th></tr></thead><tbody>
        ${Object.values(drivers).map(d => {
          const byY = Object.fromEntries(d.hist.map(h => [h.year, h.v])), m = A.methods[d.key];
          const dim = (d.key === 'daPct' || d.key === 'capexPct' || d.key === 'nwcPct') && A.reinvMethod === 'sc' && d.key !== 'daPct';
          const val = A[d.field];
          return `<tr class="${dim ? 'dimrow' : ''}"><td>${esc(d.label)}${dim ? ' <span class="muted small">(not used with sales-to-capital)</span>' : ''}</td>${years.map(y => `<td class="r hist">${fmtV(d, byY[y])}</td>`).join('')}
            <td><select data-dm="${d.key}">${[...d.methods, 'manual'].map(k => `<option value="${k}" ${m === k ? 'selected' : ''} ${k !== 'manual' && d.cand[k] == null ? 'disabled' : ''}>${esc(DCFM.METHODS[k])}${k !== 'manual' && d.cand[k] != null ? ' · ' + fmtV(d, d.cand[k]) : ''}</option>`).join('')}</select></td>
            <td class="r">${fmtV(d, d.industry)}</td>
            <td class="r"><input class="num xs ${m === 'manual' ? 'manual' : ''}" data-dv="${d.key}" type="number" step="${d.unit === '%' ? 0.1 : 0.05}" value="${isNum(val) ? (d.unit === '%' ? (val * 100).toFixed(2) : val.toFixed(2)) : ''}">${d.unit === '%' ? '%' : '×'}</td></tr>`;
        }).join('')}</tbody></table>
        <div class="hint">Each driver is computed from the fiscal years shown (${A.look >= 5 ? 'all available' : 'last 3'}) by the method you choose, or taken from Damodaran's ${esc(this.ctx.dc?.indName || 'industry')} average. Type a value to override. Recent-weighted gives the latest year the most weight; linear trend extrapolates the fitted line.</div>`;
    },
    drawTable() {
      const { A, f } = this.ctx, r = this.r, hist = f.years.slice(-3);
      const cols = [...hist.map(y => ({ h: true, y })), ...r.rows.map((x, i) => ({ x, i })), { T: true }];
      const prevOf = y => f.years[f.years.indexOf(y) - 1];
      const icOf = y => DCFM.investedCapital(y);
      const V = (c, fn) => { const v = fn(c); return v == null || !isFinite(v) ? '—' : v; };
      const td = (c, v, fmt) => `<td class="r ${c.h ? 'hist' : c.T ? 'term' : ''}">${v === '—' ? '—' : fmt(v)}</td>`;
      const m0 = v => U.fmt(v / M, 0), p1 = v => U.fmtPct(v, 1, false);
      const row = (lab, fn, fmt = m0, cls = '') => `<tr class="${cls}"><td>${lab}</td>${cols.map(c => td(c, V(c, fn), fmt)).join('')}</tr>`;
      const inRow = (lab, k, fn) => `<tr class="inrow"><td>${lab}</td>${cols.map(c => c.h || c.T ? td(c, V(c, fn), p1) : `<td class="r"><input data-k="${k}" data-i="${c.i}" type="number" step="0.5" value="${(fn(c) * 100).toFixed(1)}"></td>`).join('')}</tr>`;
      const items = A.reinvMethod === 'items';
      $('#dTable').innerHTML = `<table class="tbl proj"><thead><tr><th></th>${cols.map(c => `<th class="r ${c.h ? 'hist' : c.T ? 'term' : ''}">${c.h ? 'FY' + c.y.year + 'A' : c.T ? 'Stable' : 'FY' + c.x.year + 'E'}</th>`).join('')}</tr></thead><tbody>
        ${inRow('Revenue growth', 'g', c => c.h ? (prevOf(c.y) ? c.y.revenue / prevOf(c.y).revenue - 1 : null) : c.T ? A.termGrowth : c.x.growth)}
        ${row('Revenue', c => c.h ? c.y.revenue : c.T ? r.revN1 : c.x.rev, m0, 'b')}
        ${inRow('EBIT margin', 'm', c => c.h ? c.y.ebit / c.y.revenue : c.T ? r.ebitN1 / r.revN1 : c.x.margin)}
        ${row('EBIT (operating income)', c => c.h ? c.y.ebit : c.T ? r.ebitN1 : c.x.ebit)}
        ${row('Tax rate', c => c.h ? c.y.taxRate : c.T ? A.taxMarg : c.x.taxRate, p1)}
        ${row('NOPAT = EBIT × (1 − tax)', c => c.h ? (isNum(c.y.taxRate) ? c.y.ebit * (1 - c.y.taxRate) : null) : c.T ? r.nopatN1 : c.x.nopat)}
        ${items ? row('+ D&amp;A', c => c.h ? c.y.da : c.T ? null : c.x.da) + row('− Capex', c => c.h ? -Math.abs(c.y.capex) : c.T ? null : -c.x.capex) + row('− Increase in working capital', c => c.h ? null : c.T ? null : -c.x.dnwc) : ''}
        ${row(items ? '= Net reinvestment' : '− Reinvestment = Δ revenue ÷ sales-to-capital', c => c.h ? null : c.T ? r.nopatN1 * r.reinvRateN1 : c.x.reinvest)}
        ${row('Free cash flow to the firm', c => c.h ? c.y.fcf : c.T ? r.fcffN1 : c.x.fcff, m0, 'b')}
        ${row('Cost of capital', c => c.h ? null : c.T ? r.WS : c.x.wacc, v => U.fmtPct(v, 2, false))}
        ${row('Cumulative discount factor', c => c.h || c.T ? null : c.x.cum, v => v.toFixed(4))}
        ${row('Present value of FCFF', c => c.h || c.T ? null : c.x.pv, m0, 'b key')}
        ${row('Invested capital (start of year)', c => c.h ? icOf(c.y) : c.T ? null : c.x.ic0)}
        ${row('Return on invested capital', c => c.h ? (isNum(c.y.taxRate) && prevOf(c.y) && icOf(prevOf(c.y)) > 0 ? c.y.ebit * (1 - c.y.taxRate) / icOf(prevOf(c.y)) : null) : c.T ? A.roicStable : c.x.roic, p1)}
      </tbody></table>
      <div class="kvgrid c4 mt">${kv('Sum of PV (FCFF)', U.fmtBig(r.sumPV))}${kv('Terminal value (stable growth)', U.fmtBig(r.tvG))}${kv('Terminal value (exit multiple)', U.fmtBig(r.tvX))}${kv('PV of terminal value', U.fmtBig(r.pvTV))}</div>`;
    },

    // ------------------------------------------------------------------ charts
    drawCharts() {
      const { A, f, dc } = this.ctx, r = this.r, col = CK.colors(), ys = f.years;
      const yFmtPct = v => (v * 100).toFixed(0) + '%', yr = v => "'" + String(Math.round(v)).slice(2);
      const xt = [...ys.map(y => y.year), ...r.rows.map(x => x.year)];
      const x0 = ys[0].year - 0.7, x1 = U.last(r.rows).year + 0.7;
      // 1. revenue and FCFF bars
      CK.xy($('#cRev'), { series: [
        { name: 'Revenue (actual)', type: 'bar', barW: 0.34, data: ys.map(y => [y.year - 0.18, y.revenue / B]), color: col.dim },
        { name: 'Revenue (forecast)', type: 'bar', barW: 0.34, data: r.rows.map(x => [x.year - 0.18, x.rev / B]), color: col.accent },
        { name: 'Free cash flow', type: 'bar', barW: 0.34, data: [...ys.filter(y => isNum(y.fcf)).map(y => [y.year + 0.18, y.fcf / B]), ...r.rows.map(x => [x.year + 0.18, x.fcff / B])], color: col.key }],
        xmin: x0, xmax: x1, xFmt: yr, zeroY: true, xTicks: xt, hover: false });
      // 2. growth path (smooth)
      const hg = ys.slice(1).map((y, i) => [y.year, y.revenue / ys[i].revenue - 1]);
      CK.xy($('#cGrowth'), { smooth: true, series: [
        { name: 'Actual', data: hg, color: col.dim, points: true, width: 1.6 },
        { name: 'Forecast', data: r.rows.map(x => [x.year, x.growth]), color: col.accent, width: 2.2, points: true },
        { name: 'Stable', data: [[U.last(r.rows).year, A.termGrowth], [U.last(r.rows).year + 1, A.termGrowth]], color: col.key, dash: [4, 3] }],
        hlines: dc?.ind && isNum(dc.ind.revGrowthExp) ? [{ y: dc.ind.revGrowthExp, label: 'industry expected', color: col.muted }] : [], xFmt: yr, yFmt: yFmtPct, xTicks: xt });
      // 3. margin, ROIC, WACC (smooth)
      const hm = ys.filter(y => isNum(y.ebit)).map(y => [y.year, y.ebit / y.revenue]);
      CK.xy($('#cRet'), { smooth: true, series: [
        { name: 'EBIT margin', data: [...hm, ...r.rows.map(x => [x.year, x.margin])], color: col.accent, width: 2 },
        { name: 'ROIC', data: r.rows.filter(x => isNum(x.roic)).map(x => [x.year, x.roic]), color: col.up, width: 2 },
        { name: 'Cost of capital', data: r.rows.map(x => [x.year, x.wacc]), color: col.key, width: 2, dash: [5, 3] }],
        hlines: dc?.ind && isNum(dc.ind.opMargin) ? [{ y: dc.ind.opMargin, label: 'industry margin', color: col.muted }] : [], vlines: [{ x: A.baseYear + 0.5, label: 'forecast', color: col.dim }], xFmt: yr, yFmt: yFmtPct, xTicks: xt });
      // 4. cumulative present value (smooth area) up to the enterprise value
      let cum = 0; const cpv = r.rows.map(x => [x.year, (cum += x.pv) / B]);
      CK.xy($('#cPV'), { smooth: true, series: [
        { name: 'Cumulative PV of FCFF', data: [[A.baseYear, 0], ...cpv], color: col.accent, fill: true, width: 2 },
        { name: '+ PV of terminal value', data: [[U.last(r.rows).year, r.sumPV / B], [U.last(r.rows).year + 0.6, r.ev / B]], color: col.key, width: 2.4 }],
        hlines: [{ y: r.ev / B, label: `EV ${U.fmtBig(r.ev)}`, color: col.text }], marks: [{ x: U.last(r.rows).year + 0.6, y: r.ev / B, color: col.key, label: `TV ${pct(r.tvShare, 0)} of EV`, align: 'right' }],
        xFmt: yr, yFmt: v => v.toFixed(0), zeroY: true, xTicks: [A.baseYear, ...r.rows.map(x => x.year)] });
      // 5. cost of capital build-up
      const c = r.coc, items = [['Risk-free rate', A.rf], ['Beta × ERP', c.beta * A.erp], ['Beta × country risk', c.beta * A.crp], ['Cost of equity', c.ke], ['Pre-tax cost of debt', c.kdPre], ['After-tax cost of debt', c.kdAfter],
        ['WACC, high growth', r.W0], ['WACC, stable', r.WS], ...(dc?.ind && isNum(dc.ind.wacc) ? [['Industry WACC', dc.ind.wacc]] : [])].filter(x => isNum(x[1]) && (x[0] !== 'Beta × country risk' || Math.abs(x[1]) > 1e-6));
      CK.bars($('#cWacc'), { horizontal: true, labels: items.map(x => x[0]), values: items.map(x => x[1]), fmt: v => U.fmtPct(v, 2, false), padL: 168,
        colors: items.map(x => /WACC/.test(x[0]) ? col.key : /equity/.test(x[0]) ? col.accent : /debt/.test(x[0]) ? col.series[3] : col.dim) });
      // 6. bridge
      CK.waterfall($('#cBridge'), [{ label: 'PV FCFF', value: r.sumPV / B, total: true }, { label: 'PV TV', value: r.pvTV / B }, { label: 'EV', value: r.ev / B, total: true }, { label: 'Net debt', value: -A.netDebt / B }, { label: 'Minority', value: -(A.minority || 0) / B }, { label: 'Other', value: (A.investments || 0) / B }, { label: 'Equity', value: r.equity / B, total: true }], v => v.toFixed(1));
    },

    // ------------------------------------------------------------------ analyses
    sensGrid(mode) {
      const { A } = this.ctx, r = this.r, base = A.waccShift || 0, sh = U.range(7, i => base + (i - 3) * 0.005);
      const wl = v => U.fmtPct(r.W0 + v - base, 2, false);
      if (mode === 'wg') { const gs = U.range(7, i => A.termGrowth + (i - 3) * 0.0025); return { rows: sh, cols: gs, rl: 'WACC', cl: 'Terminal growth', rf: wl, cf: v => U.fmtPct(v, 2, false), grid: DCFM.sensitivity({ ...A, tvMethod: 'gordon' }, 'waccShift', sh, 'termGrowth', gs), base: [3, 3] }; }
      if (mode === 'wx') { const xs = U.range(7, i => Math.max(1, A.exitMultiple + (i - 3))); return { rows: sh, cols: xs, rl: 'WACC', cl: 'Exit EV/EBITDA', rf: wl, cf: v => v.toFixed(1) + '×', grid: DCFM.sensitivity({ ...A, tvMethod: 'exit' }, 'waccShift', sh, 'exitMultiple', xs), base: [3, 3] }; }
      if (mode === 'rg') { const rs = U.range(7, i => Math.max(0.02, A.roicStable + (i - 3) * 0.03)), gs = U.range(7, i => A.termGrowth + (i - 3) * 0.0025); return { rows: rs, cols: gs, rl: 'Stable ROIC', cl: 'Terminal growth', rf: v => U.fmtPct(v, 0, false), cf: v => U.fmtPct(v, 2, false), grid: DCFM.sensitivity({ ...A, tvMethod: 'gordon' }, 'roicStable', rs, 'termGrowth', gs), base: [3, 3] }; }
      const gs = U.range(7, i => A.g1 + (i - 3) * 0.02), ms = U.range(7, i => A.marginTarget + (i - 3) * 0.02);
      return { rows: gs, cols: ms, rl: 'High growth', cl: 'Target margin', rf: v => U.fmtPct(v, 0, false), cf: v => U.fmtPct(v, 0, false), grid: DCFM.sensitivity({ ...A, growthPath: null, marginPath: null }, 'g1', gs, 'marginTarget', ms), base: [3, 3] };
    },
    drawSens() {
      const s = this.sensGrid(this.sensMode), px = this.ctx.q.last;
      $('#dSens').innerHTML = `<table class="tbl sens"><thead><tr><th class="corner">${s.rl} ↓ · ${s.cl} →</th>${s.cols.map(c => `<th class="r">${s.cf(c)}</th>`).join('')}</tr></thead><tbody>
        ${s.rows.map((rv, i) => `<tr><th>${s.rf(rv)}</th>${s.grid[i].map((v, j) => { const up = v / px - 1; return `<td class="r ${i === s.base[0] && j === s.base[1] ? 'basecell' : ''}" style="background:${CK.divergingColor(up, 0.5, 0.85)}" title="${U.fmtPct(up, 1)} vs price">${isNum(v) ? U.fmtPx(v) : '—'}</td>`; }).join('')}</tr>`).join('')}
      </tbody></table><div class="hint">Colour shows upside (green) or downside (red) against the current price. WACC moves shift both the high-growth and the stable cost of capital.</div>`;
    },
    drawScen() {
      const { A, q } = this.ctx, res = {};
      ['bear', 'base', 'bull'].forEach(k => { res[k] = DCFM.dcf(DCFM.scenario(A, k)); });
      const tw = weights.bear + weights.base + weights.bull || 1, pw = (weights.bear * res.bear.perShare + weights.base * res.base.perShare + weights.bull * res.bull.perShare) / tw;
      this.scen = { res, pw };
      const S = DCFM.SCEN, line = (lab, fn) => `<tr><td>${lab}</td>${['bear', 'base', 'bull'].map(k => `<td class="r">${fn(k)}</td>`).join('')}</tr>`;
      $('#dScen').innerHTML = `<table class="tbl"><thead><tr><th></th><th class="r down">Bear</th><th class="r">Base</th><th class="r up">Bull</th></tr></thead><tbody>
        ${line('High growth', k => pct(A.g1 + S[k].g1))}${line('Target EBIT margin', k => pct(A.marginTarget + S[k].marginTarget))}${line('WACC (high growth)', k => pct(res[k].W0, 2))}${line('Terminal growth', k => pct(A.termGrowth + S[k].termGrowth, 2))}
        <tr class="b"><td>Value per share</td>${['bear', 'base', 'bull'].map(k => `<td class="r ${U.cls(res[k].perShare - q.last)}">${U.fmtPx(res[k].perShare)}</td>`).join('')}</tr>
        <tr><td>Probability</td>${['bear', 'base', 'bull'].map(k => `<td class="r"><input class="num xs" data-w="${k}" type="number" step="5" value="${Math.round(weights[k] * 100)}">%</td>`).join('')}</tr>
      </tbody></table><div class="kvgrid c2 mt">${kv('Probability-weighted value', U.fmtPx(pw), 'key')}${kv('vs price', U.fmtPct(pw / q.last - 1, 1), U.cls(pw - q.last))}</div>`;
    },
    drawMC() {
      const { A, q } = this.ctx, vals = DCFM.monteCarlo(A, 4000), fin = vals.filter(isFinite);
      const lo = U.quantile(fin, 0.01), hi = U.quantile(fin, 0.99), clip = fin.filter(v => v >= lo && v <= hi), col = CK.colors();
      const pAbove = fin.filter(v => v > q.last).length / (fin.length || 1);
      this.mc = { p10: U.quantile(fin, 0.1), p50: U.quantile(fin, 0.5), p90: U.quantile(fin, 0.9), prob: pAbove, values: clip };
      CK.hist($('#dMc'), { values: clip, bins: 45, xFmt: v => U.fmtPx(v), vlines: [{ x: q.last, label: 'Price', color: col.key }, { x: this.r.perShare, label: 'Base', color: col.text }], colorFn: x => x >= q.last ? col.up + 'aa' : col.down + 'aa' });
      $('#dMcStats').innerHTML = kv('10th percentile', U.fmtPx(this.mc.p10)) + kv('Median', U.fmtPx(this.mc.p50)) + kv('90th percentile', U.fmtPx(this.mc.p90)) + kv('Chance value exceeds price', pct(pAbove, 0), pAbove > 0.5 ? 'up' : 'down') +
        '<div class="hint" style="grid-column:1/-1">Each run draws high growth (±3pp), target margin (±2.5pp), cost of capital (±0.75pp), terminal growth (±0.4pp) and sales-to-capital (±15%).</div>';
    },
    drawReverse() {
      const { A, q, drivers } = this.ctx, g = DCFM.reverse(A); this.revG = g;
      const ok = isNum(g), hist = drivers.growth.cand.cagr;
      $('#dRev2').innerHTML = `<p class="note">What high-growth revenue rate (for ${A.hgYears} years, then fading to ${pct(A.termGrowth)}) does today's price of ${U.fmtPx(q.last)} imply, with every other assumption unchanged?</p>
        <div class="bignum ${ok ? '' : 'muted'}">${ok ? pct(g) : 'No solution'}</div>
        <div class="kvgrid c2">${kv('Your base case', pct(A.g1))}${kv('Historical CAGR', pct(hist))}</div>
        <p class="note">${!ok ? 'Even extreme growth cannot reach the price with these margins and cost of capital.' : g > A.g1 + 0.03 ? 'The market prices in faster growth than your base case: the stock looks expensive on your assumptions.' : g < A.g1 - 0.03 ? 'The market prices in slower growth than your base case: the stock looks cheap on your assumptions.' : 'The market-implied growth is close to your base case.'}</p>`;
    },
    drawFoot() {
      const { A, q, bars, peers, f, sym } = this.ctx, last = U.last(f.years), ebitda = last.ebit + (last.da || 0);
      const sens = DCFM.sensitivity({ ...A, tvMethod: 'gordon' }, 'waccShift', [(A.waccShift || 0) - 0.01, (A.waccShift || 0) + 0.01], 'termGrowth', [A.termGrowth - 0.005, A.termGrowth + 0.005]).flat().filter(isFinite);
      const exitR = [A.exitMultiple - 2, A.exitMultiple + 2].map(m => DCFM.dcf({ ...A, tvMethod: 'exit', exitMultiple: Math.max(1, m) }).perShare);
      const fromEV = ev => (ev - A.netDebt - (A.minority || 0)) / A.shares;
      const rows = [
        { label: '52-week trading range', lo: Math.min(...bars.slice(-252).map(b => b.l)), hi: Math.max(...bars.slice(-252).map(b => b.h)), color: CK.colors().dim },
        { label: 'DCF · WACC ±1pp, g ±0.5pp', lo: Math.min(...sens), hi: Math.max(...sens), mid: this.r.perShare },
        { label: 'DCF · exit multiple ±2×', lo: Math.min(...exitR), hi: Math.max(...exitR) },
        { label: 'DCF · Monte Carlo 10–90%', lo: this.mc.p10, hi: this.mc.p90, mid: this.mc.p50 },
        { label: 'Scenarios bear–bull', lo: this.scen.res.bear.perShare, hi: this.scen.res.bull.perShare, mid: this.scen.pw },
      ];
      const others = peers.filter(p => p.sym !== sym);
      if (others.length > 2) {
        const evm = others.map(p => p.evEbitda).filter(v => v > 0 && v < 60), pe = others.map(p => p.pe).filter(v => v > 0 && v < 100);
        if (evm.length > 2) rows.push({ label: 'Peers EV/EBITDA 25–75%', lo: fromEV(U.quantile(evm, 0.25) * ebitda), hi: fromEV(U.quantile(evm, 0.75) * ebitda), color: CK.colors().key });
        if (last.netIncome > 0 && pe.length > 2) rows.push({ label: 'Peers P/E 25–75%', lo: U.quantile(pe, 0.25) * last.netIncome / A.shares, hi: U.quantile(pe, 0.75) * last.netIncome / A.shares, color: CK.colors().key });
      }
      this.foot = rows.filter(x => isFinite(x.lo) && isFinite(x.hi));
      CK.football($('#dFoot'), this.foot, q.last);
    },
    benchRows() {
      const { A, f, dc, drivers } = this.ctx, r = this.r, ind = dc?.ind || {}, mk = dc?.market || {};
      const L = U.last(f.years), P = f.years[f.years.length - 2], icP = P ? DCFM.investedCapital(P) : null;
      const roic = isNum(L.taxRate) && icP > 0 ? L.ebit * (1 - L.taxRate) / icP : null;
      return [
        ['Revenue growth (historical CAGR / industry expected)', drivers.growth.cand.cagr, ind.revGrowthExp ?? ind.revGrowthHist, mk.revGrowthExp ?? mk.revGrowthHist, '%'],
        ['Operating (EBIT) margin', A.margin0, ind.opMargin, mk.opMargin, '%'],
        ['Effective tax rate', drivers.taxEff.cand.avg, ind.taxEffective ?? ind.taxAvg, mk.taxEffective ?? mk.taxAvg, '%'],
        ['Sales-to-capital', drivers.s2c.cand.latest, ind.salesToCapital, mk.salesToCapital, 'x'],
        ['Return on invested capital', roic, ind.roc, mk.roc, '%'],
        ['Levered beta', r.coc.beta, ind.beta, mk.beta, 'n'],
        ['Debt / equity (market)', A.deCompany, ind.de, mk.de, '%'],
        ['Cost of capital', r.W0, ind.wacc, mk.wacc, '%'],
      ];
    },
    drawBench() {
      const { dc } = this.ctx, fmt = (v, u) => !isNum(v) ? '—' : u === '%' ? U.fmtPct(v, 1, false) : u === 'x' ? v.toFixed(2) + '×' : v.toFixed(2);
      this.bench = this.benchRows();
      $('#dBench').innerHTML = `<table class="tbl"><thead><tr><th></th><th class="r">${esc(this.ctx.sym)}</th><th class="r">${esc(dc?.indName || 'Industry')}</th><th class="r">US market</th></tr></thead><tbody>
        ${this.bench.map(([l, a, b, c, u]) => `<tr><td>${l}</td><td class="r b">${fmt(a, u)}</td><td class="r">${fmt(b, u)}</td><td class="r">${fmt(c, u)}</td></tr>`).join('')}</tbody></table>
        <div class="hint">Industry and market columns: Damodaran, January data for US companies${dc?.ind?.firms ? ` (${U.fmt(dc.ind.firms, 0)} firms in this industry)` : ''}.</div>`;
    },
    drawComps() {
      const { peers, sym } = this.ctx;
      $('#dComps').innerHTML = `<table class="tbl"><thead><tr><th>Ticker</th><th>Company</th><th class="r">Mkt cap</th><th class="r">EV/EBITDA</th><th class="r">P/E</th><th class="r">EV/Sales</th><th class="r">Rev growth</th><th class="r">EBIT margin</th><th class="r">FCF yield</th></tr></thead><tbody>
        ${peers.map(p => `<tr class="${p.sym === sym ? 'self' : ''} clk" data-s="${p.sym}"><td class="key">${p.sym}</td><td>${esc(p.name)}${p.same ? '' : ' <span class="muted small">(other sector)</span>'}</td><td class="r">${U.fmtBig(p.cap)}</td><td class="r">${U.fmtX(p.evEbitda)}</td><td class="r">${p.pe > 0 ? U.fmtX(p.pe) : 'n/m'}</td><td class="r">${U.fmtX(p.evSales)}</td><td class="r">${U.fmtPct(p.growth, 1)}</td><td class="r">${pct(p.margin)}</td><td class="r">${pct(p.fcfy)}</td></tr>`).join('')}
        <tr class="b"><td colspan="3">Median excluding ${sym}</td>${['evEbitda', 'pe', 'evSales'].map(k => `<td class="r">${U.fmtX(U.quantile(peers.filter(p => p.sym !== sym).map(p => p[k]).filter(v => v > 0 && v < 100), 0.5))}</td>`).join('')}${['growth', 'margin', 'fcfy'].map(k => `<td class="r">${pct(U.quantile(peers.filter(p => p.sym !== sym).map(p => p[k]).filter(isNum), 0.5))}</td>`).join('')}</tr>
      </tbody></table>`;
    },

    // ------------------------------------------------------------------ exports
    payload() {
      const { A, f, q, sym, dc, dam, drivers, peers } = this.ctx, r = this.r;
      const sens = ['wg', 'wx', 'gm', 'rg'].map(k => { const s = this.sensGrid(k); return { key: k, rl: s.rl, cl: s.cl, rows: s.rows.map(s.rf), cols: s.cols.map(s.cf), grid: s.grid.map(row => row.map(v => isFinite(v) ? v : null)) }; });
      const vals = this.mc.values, lo = Math.min(...vals), hi = Math.max(...vals), nb = 30, w = (hi - lo) / nb || 1;
      const bins = U.range(nb, i => ({ x0: lo + i * w, x1: lo + (i + 1) * w, n: 0 })); vals.forEach(v => { bins[Math.min(nb - 1, Math.floor((v - lo) / w))].n++; });
      const clean = o => JSON.parse(JSON.stringify(o, (k, v) => typeof v === 'number' && !isFinite(v) ? null : v));
      return clean({
        meta: { sym, name: f.name, industry: f.industry, sector: f.sector, country: f.country, currency: f.currency, source: f.source, price: q.last, generated: new Date().toISOString(),
          damIndustry: dc?.indName || null, damCountry: dc?.country?.name || null, damAsOf: dam ? 'January 2026 tables; ERP ' + (dam.erp?.date || 'n/a') : null, rating: A.rating },
        A: { ...A, growthPath: A.growthPath, marginPath: A.marginPath }, coc: { ...r.coc, W0: r.W0, WS: r.WS },
        rows: r.rows, terminal: { revN1: r.revN1, ebitN1: r.ebitN1, nopatN1: r.nopatN1, reinvRateN1: r.reinvRateN1, fcffN1: r.fcffN1, roicS: r.roicS, tvG: r.tvG, tvX: r.tvX, tv: r.tv, pvG: r.pvG, pvX: r.pvX, pvTV: r.pvTV, sumPV: r.sumPV, ev: r.ev, equity: r.equity, perShare: r.perShare, upside: r.upside, tvShare: r.tvShare, impliedExit: r.impliedExit, impliedG: r.impliedG },
        drivers: Object.values(drivers).map(d => ({ key: d.key, label: d.label, unit: d.unit, hist: d.hist.map(h => ({ year: h.year, v: h.v })), cand: d.cand, method: A.methods[d.key], methodLabel: DCFM.METHODS[A.methods[d.key]], value: A[d.field], industry: d.industry })),
        hist: f.years, sens, scen: { rows: ['bear', 'base', 'bull'].map(k => ({ k, g1: A.g1 + DCFM.SCEN[k].g1, margin: A.marginTarget + DCFM.SCEN[k].marginTarget, wacc: this.scen.res[k].W0, tg: A.termGrowth + DCFM.SCEN[k].termGrowth, value: this.scen.res[k].perShare, prob: weights[k] })), pw: this.scen.pw },
        mc: { p10: this.mc.p10, p50: this.mc.p50, p90: this.mc.p90, prob: this.mc.prob, bins }, reverse: this.revG, foot: this.foot.map(x => ({ label: x.label, lo: x.lo, hi: x.hi, mid: x.mid ?? null })),
        bench: this.bench.map(([label, company, industry, market, unit]) => ({ label, company, industry, market, unit })),
        peers: peers.map(p => ({ sym: p.sym, name: p.name, cap: p.cap, evEbitda: p.evEbitda, pe: p.pe, evSales: p.evSales, growth: p.growth, margin: p.margin, fcfy: p.fcfy, self: p.sym === sym })),
        damodaran: dc ? { industry: dc.ind, industryName: dc.indName, market: dc.market, country: dc.country, us: dc.us, erp: dc.erp, ratings: dc.ratings, links: dam.links } : null,
      });
    },
    exportCsv() {
      const { A, sym, f, q } = this.ctx, r = this.r;
      const L = [[`Agula DCF — ${sym} ${f.name}`], [`Source: ${f.source}; cost of capital: ${this.ctx.dc ? 'Damodaran (' + this.ctx.dc.indName + ')' : 'fallbacks'}`], [`Generated ${new Date().toISOString()}`], [],
        ['Year', ...r.rows.map(x => x.year), 'Stable'], ['Revenue growth', ...r.rows.map(x => x.growth.toFixed(4)), A.termGrowth.toFixed(4)], ['Revenue ($m)', ...r.rows.map(x => (x.rev / M).toFixed(1)), (r.revN1 / M).toFixed(1)],
        ['EBIT margin', ...r.rows.map(x => x.margin.toFixed(4))], ['EBIT ($m)', ...r.rows.map(x => (x.ebit / M).toFixed(1)), (r.ebitN1 / M).toFixed(1)], ['Tax rate', ...r.rows.map(x => x.taxRate.toFixed(4)), A.taxMarg.toFixed(4)],
        ['NOPAT ($m)', ...r.rows.map(x => (x.nopat / M).toFixed(1)), (r.nopatN1 / M).toFixed(1)], ['Reinvestment ($m)', ...r.rows.map(x => (x.reinvest / M).toFixed(1)), (r.nopatN1 * r.reinvRateN1 / M).toFixed(1)],
        ['FCFF ($m)', ...r.rows.map(x => (x.fcff / M).toFixed(1)), (r.fcffN1 / M).toFixed(1)], ['Cost of capital', ...r.rows.map(x => x.wacc.toFixed(4)), r.WS.toFixed(4)], ['Cumulative discount factor', ...r.rows.map(x => x.cum.toFixed(5))],
        ['PV of FCFF ($m)', ...r.rows.map(x => (x.pv / M).toFixed(1))], [], ['Enterprise value ($m)', (r.ev / M).toFixed(1)], ['Equity value ($m)', (r.equity / M).toFixed(1)], ['Value per share', r.perShare.toFixed(2)], ['Price', q.last.toFixed(2)], ['Upside', r.upside.toFixed(4)]];
      APP.saveFile(`${sym}_DCF.csv`, new Blob([L.map(l => l.map(x => /[,"]/.test(String(x)) ? `"${String(x).replace(/"/g, '""')}"` : x).join(',')).join('\n')], { type: 'text/csv' }));
    },
    async exportXlsx() {
      const btn = $('[data-act="xlsx"]'); if (btn) { btn.disabled = true; btn.textContent = 'Building Excel…'; }
      try { const blob = await HUB.dcfWorkbook(this.payload()); APP.saveFile(`${this.ctx.sym}_DCF_model.xlsx`, blob); APP.toast('Excel model downloaded', 'ok'); }
      catch (e) { APP.toast(`${e.message} Exporting CSV instead.`, 'err', 6000); this.exportCsv(); }
      finally { if (btn) { btn.disabled = false; btn.textContent = 'Export Excel model'; } }
    },
  });

  function histHTML(f) {
    const ys = f.years;
    return `<div class="tblwrap"><table class="tbl fin"><thead><tr><th>$m</th>${ys.map(y => `<th class="r">FY${y.year}</th>`).join('')}</tr></thead><tbody>
      ${[['Revenue', y => y.revenue], ['Gross profit', y => y.grossProfit], ['EBIT', y => y.ebit], ['D&A', y => y.da], ['Capex', y => y.capex], ['Net income', y => y.netIncome], ['Operating cash flow', y => y.ocf], ['Free cash flow', y => y.fcf], ['Interest expense', y => y.interest], ['Book equity', y => y.equityBook], ['Total debt', y => y.debtBook], ['Cash & investments', y => y.cashBook], ['Invested capital', y => DCFM.investedCapital(y)]]
        .map(([l, fn]) => `<tr><td>${l}</td>${ys.map(y => `<td class="r">${isNum(fn(y)) ? U.fmt(fn(y) / 1e6, 0) : '—'}</td>`).join('')}</tr>`).join('')}
      <tr><td>Effective tax rate</td>${ys.map(y => `<td class="r">${pct(y.taxRate)}</td>`).join('')}</tr>
    </tbody></table></div><div class="kvgrid c4 mt">${kv('Cash', U.fmtBig(f.cash))}${kv('Debt', U.fmtBig(f.debt))}${kv('Net debt', U.fmtBig(f.debt - f.cash))}${kv('Shares', U.fmtBig(f.shares))}</div>`;
  }
  function compsFor(sym, sector, rows) {
    const map = r => ({ sym: r.sym, name: r.name, same: r.sector === sector, cap: (r.cap || 0) * 1e9, evEbitda: r.evebitda, pe: r.pe, evSales: r.evsales ?? r.ps, growth: r.growth, margin: r.margin, fcfy: r.fcfy });
    const same = rows.filter(r => r.sector === sector).map(map).sort((a, b) => b.cap - a.cap);
    const fill = same.length < 5 ? rows.filter(r => r.sector !== sector).map(map).sort((a, b) => b.cap - a.cap).slice(0, 6 - same.length) : [];
    return [...same, ...fill];
  }
})();
