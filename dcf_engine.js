/* ============================================================================
   Agula Terminal — DCF engine (free cash flow to the firm, Damodaran-style)
   · forecast drivers derived from the company's history (several methods) or
     from Damodaran's industry averages, each overridable
   · cost of capital built bottom-up: industry unlevered beta relevered at the
     company's debt-to-equity, implied ERP + country risk, synthetic rating
   · high-growth period, then growth, tax rate and cost of capital fade to
     stable-period values; reinvestment from sales-to-capital (or itemised)
   · terminal value with reinvestment = g / ROIC, so growth is never free
   ========================================================================== */
'use strict';

const DCFM = (() => {
  const isNum = U.isNum, clamp = U.clamp;

  // ------------------------------------------------------------------ drivers from history
  const TG_METHODS = { lower: 'Lower of risk-free rate and high growth (min 2%)', rf: 'Risk-free rate (Damodaran)', inflation: '2.5% (long-run nominal GDP)', manual: 'Manual' };
  const ROIC_METHODS = { industry: 'Industry return on capital (Damodaran)', wacc: 'Stable cost of capital (no excess returns)', company: 'Company\'s first-year ROIC', manual: 'Manual' };
  const METHODS = {
    cagr: 'Compound annual growth', avg: 'Average', wavg: 'Recent-weighted average', median: 'Median',
    latest: 'Latest year', trend: 'Linear trend', industry: 'Industry (Damodaran)', manual: 'Manual',
  };
  const DRIVERS = [
    // key, label, A field, unit, methods offered, default method, sane range
    ['growth', 'Revenue growth, high-growth years', 'g1', '%', ['cagr', 'avg', 'wavg', 'median', 'latest', 'trend', 'industry'], 'cagr', [-0.3, 0.6]],
    ['margin', 'Target EBIT margin', 'marginTarget', '%', ['avg', 'wavg', 'median', 'latest', 'trend', 'industry'], 'avg', [-0.3, 0.7]],
    ['taxEff', 'Effective tax rate (early years)', 'taxEff', '%', ['avg', 'wavg', 'median', 'latest', 'industry'], 'avg', [0, 0.45]],
    ['s2c', 'Sales-to-capital ratio', 's2c', 'x', ['avg', 'wavg', 'median', 'latest', 'industry'], 'avg', [0.2, 12]],
    ['daPct', 'D&A, % of revenue', 'daPct', '%', ['avg', 'wavg', 'median', 'latest', 'industry'], 'avg', [0, 0.4]],
    ['capexPct', 'Capex, % of revenue', 'capexPct', '%', ['avg', 'wavg', 'median', 'latest', 'industry'], 'avg', [0, 0.6]],
    ['nwcPct', 'Working capital, % of revenue change', 'nwcPct', '%', ['avg', 'industry'], 'avg', [-0.3, 0.5]],
  ];

  const mean = a => a.length ? U.sum(a) / a.length : NaN;
  const wmean = a => { if (!a.length) return NaN; const w = a.map((_, i) => i + 1); return U.sum(a.map((v, i) => v * w[i])) / U.sum(w); };
  const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  function linfit(xs, ys) {   // least squares y = a + b x
    const n = xs.length, mx = mean(xs), my = mean(ys);
    const b = U.sum(xs.map((x, i) => (x - mx) * (ys[i] - my))) / (U.sum(xs.map(x => (x - mx) ** 2)) || 1);
    return { a: my - b * mx, b };
  }
  const investedCapital = y => [y.equityBook, y.debtBook, y.cashBook].every(isNum) ? y.equityBook + y.debtBook - y.cashBook : null;

  /** History of each driver and the value every method gives. `look` = years of history used (3, 5 or 99 for all). */
  function deriveDrivers(f, ind, look = 5) {
    const ys = f.years.filter(y => isNum(y.revenue) && y.revenue > 0).sort((a, b) => a.year - b.year);
    const win = ys.slice(-Math.min(look, ys.length));                 // the last `look` fiscal years
    const pairs = [];                                                  // consecutive years for growth-type ratios
    for (let i = Math.max(1, ys.length - look); i < ys.length; i++) pairs.push([ys[i - 1], ys[i]]);
    const DA_IND = ind && isNum(ind.ebitdaMargin) && isNum(ind.opMargin) ? Math.max(0, ind.ebitdaMargin - ind.opMargin) : null;
    const series = {
      growth: pairs.map(([a, b]) => ({ year: b.year, v: b.revenue / a.revenue - 1 })),
      margin: win.filter(y => isNum(y.ebit)).map(y => ({ year: y.year, v: y.ebit / y.revenue })),
      taxEff: win.filter(y => isNum(y.taxRate)).map(y => ({ year: y.year, v: y.taxRate })),
      s2c: win.map(y => ({ year: y.year, ic: investedCapital(y), rev: y.revenue })).filter(x => isNum(x.ic) && x.ic > 0).map(x => ({ year: x.year, v: x.rev / x.ic })),
      daPct: win.filter(y => isNum(y.da)).map(y => ({ year: y.year, v: y.da / y.revenue })),
      capexPct: win.filter(y => isNum(y.capex)).map(y => ({ year: y.year, v: Math.abs(y.capex) / y.revenue })),
      nwcPct: pairs.filter(([a, b]) => isNum(b.dWC) && b.revenue !== a.revenue).map(([a, b]) => ({ year: b.year, v: -b.dWC / (b.revenue - a.revenue), dwc: -b.dWC, drev: b.revenue - a.revenue })),
    };
    const industry = {
      growth: ind ? (ind.revGrowthExp ?? ind.revGrowthHist) : null, margin: ind?.opMargin, taxEff: ind ? (ind.taxEffective ?? ind.taxAvg) : null,
      s2c: ind?.salesToCapital, daPct: DA_IND, capexPct: ind && isNum(ind.netCapexSales) && isNum(DA_IND) ? ind.netCapexSales + DA_IND : null, nwcPct: ind?.nwcSales,
    };
    const out = {};
    DRIVERS.forEach(([key, label, field, unit, methods, def, range]) => {
      const h = series[key], v = h.map(x => x.v).filter(isFinite), cand = {};
      if (v.length) {
        cand.avg = mean(v); cand.wavg = wmean(v); cand.median = median(v); cand.latest = v[v.length - 1];
        if (v.length >= 3) { const fit = linfit(h.map(x => x.year), v); cand.trend = fit.a + fit.b * (h[h.length - 1].year + (key === 'margin' ? 3 : 1)); }
      }
      if (key === 'growth' && win.length >= 2) cand.cagr = Math.pow(win[win.length - 1].revenue / win[0].revenue, 1 / (win[win.length - 1].year - win[0].year || 1)) - 1;
      if (key === 'growth' && win.length >= 3) {   // trend: fitted revenue next year vs last year
        const fit = linfit(win.map(y => y.year), win.map(y => y.revenue)), L = win[win.length - 1];
        cand.trend = (fit.a + fit.b * (L.year + 1)) / L.revenue - 1;
      }
      if (key === 'nwcPct' && h.length) cand.avg = U.sum(h.map(x => x.dwc)) / (U.sum(h.map(x => x.drev)) || 1);   // aggregate: total Δ working capital / total Δ revenue
      if (isNum(industry[key])) cand.industry = industry[key];
      Object.keys(cand).forEach(k => { if (!isFinite(cand[k])) delete cand[k]; else cand[k] = clamp(cand[k], range[0], range[1]); });
      let method = cand[def] != null ? def : methods.find(m => cand[m] != null) || 'manual';
      // company ratios far outside the sane range fall back to the industry
      if (key === 's2c' && method !== 'industry' && cand.industry != null && !(v.length && v.every(x => x > range[0] && x < range[1]))) method = 'industry';
      // working capital swings are noisy when revenue barely moved: prefer the industry ratio then
      if (key === 'nwcPct' && cand.industry != null && (cand.avg == null || Math.abs(cand.avg) >= range[1] - 1e-9 || cand.avg <= range[0] + 1e-9 ||
          Math.abs(U.sum(h.map(x => x.drev))) < 0.03 * (win[win.length - 1]?.revenue || 1))) method = 'industry';
      out[key] = { key, label, field, unit, methods, hist: h, cand, method, industry: industry[key] ?? null, range,
        value: method === 'manual' ? null : cand[method] };
    });
    return out;
  }

  // ------------------------------------------------------------------ synthetic rating
  function ratingFor(coverage, table) {
    if (!table || !table.length) return null;
    const rows = [...table].sort((a, b) => a[0] - b[0]);
    let hit = rows[0];
    for (const r of rows) if (coverage >= r[0]) hit = r;
    return { rating: hit[2], spread: hit[3], lo: hit[0], hi: hit[1] };
  }

  // ------------------------------------------------------------------ cost of capital
  function costOfCapital(A) {
    const tM = A.taxMarg, erpT = A.erp + A.crp;
    const betaL = A.betaU * (1 + (1 - tM) * A.de);
    const beta = A.betaMethod === 'regression' ? A.betaRegression : A.betaMethod === 'industry' ? A.betaIndustry : A.betaMethod === 'manual' ? A.betaManual : betaL;
    const ke = A.rf + beta * erpT;
    const kdPre = A.kdMethod === 'manual' ? A.kdManual : A.kdMethod === 'actual' && isNum(A.kdActual) ? A.kdActual : A.rf + A.kdSpread + A.ctrySpread;
    const kdAfter = kdPre * (1 - tM), wd = A.de / (1 + A.de), we = 1 - wd;
    const wacc = we * ke + wd * kdAfter;
    const keS = A.rf + A.stableBeta * erpT, wdS = clamp(A.stableWd, 0, 0.9);
    const waccStable = (1 - wdS) * keS + wdS * kdAfter;
    return { betaL, beta, erpT, ke, kdPre, kdAfter, wd, we, wacc, keS, wdS, waccStable };
  }

  // ------------------------------------------------------------------ yearly paths
  function paths(A, W0, WS) {
    const N = A.years, H = Math.min(A.hgYears, N), C = clamp(A.convYear, 1, N);
    const fade = (a, b, t) => t <= H || N === H ? a : a + (b - a) * (t - H) / (N - H);
    const g = A.growthPath && A.growthPath.length === N ? A.growthPath : U.range(N, i => fade(A.g1, A.termGrowth, i + 1));
    const m = A.marginPath && A.marginPath.length === N ? A.marginPath : U.range(N, i => { const t = i + 1; return t >= C ? A.marginTarget : A.margin0 + (A.marginTarget - A.margin0) * t / C; });
    const tax = U.range(N, i => fade(A.taxEff, A.taxMarg, i + 1));
    const w = U.range(N, i => fade(W0, WS, i + 1));
    return { g, m, tax, w, H, C };
  }

  // ------------------------------------------------------------------ the model
  function dcf(A) {
    const coc = costOfCapital(A), sh = A.waccShift || 0;
    const W0 = (A.waccOverride ?? coc.wacc) + sh, WS = (A.stableWaccOverride ?? coc.waccStable) + sh;
    const N = A.years, P = paths(A, W0, WS), gT = A.termGrowth;
    const rows = []; let rev = A.revenue0, cum = 1, ic = A.ic0;
    for (let i = 0; i < N; i++) {
      const prev = rev; rev = prev * (1 + P.g[i]);
      const ebit = rev * P.m[i], taxRate = P.tax[i], tax = Math.max(ebit, 0) * taxRate, nopat = ebit - tax;
      const da = rev * A.daPct, capex = rev * A.capexPct, dnwc = (rev - prev) * A.nwcPct;
      const reinvest = A.reinvMethod === 'items' ? capex - da + dnwc : (rev - prev) / A.s2c;
      const fcff = nopat - reinvest, wacc = P.w[i];
      const dfMid = cum / Math.sqrt(1 + wacc); cum = cum / (1 + wacc);
      const df = A.midYear ? dfMid : cum;
      const roic = ic > 0 ? nopat / ic : null;
      rows.push({ year: A.baseYear + i + 1, t: i + 1, rev, growth: P.g[i], margin: P.m[i], ebit, taxRate, tax, nopat, da, capex, dnwc, reinvest, fcff, ebitda: ebit + da,
        wacc, cum, df, pv: fcff * df, ic0: ic, roic, reinvRate: nopat > 0 ? reinvest / nopat : null });
      ic += reinvest;
    }
    const L = rows[N - 1];
    // stable growth: next year's operating income at the stable tax rate, reinvesting g / ROIC to grow at g
    const roicS = A.roicStable > 0 ? A.roicStable : WS;
    const revN1 = L.rev * (1 + gT), ebitN1 = revN1 * L.margin, nopatN1 = ebitN1 - Math.max(ebitN1, 0) * A.taxMarg;
    const reinvRateN1 = gT / roicS, fcffN1 = nopatN1 * (1 - reinvRateN1);
    const tvG = WS > gT ? fcffN1 / (WS - gT) : NaN, tvX = L.ebitda * A.exitMultiple;
    const pvG = tvG * L.cum * (A.midYear ? Math.sqrt(1 + WS) : 1), pvX = tvX * L.cum;
    const pvTV = A.tvMethod === 'exit' ? pvX : A.tvMethod === 'blend' ? (pvG + pvX) / 2 : pvG;
    const tv = A.tvMethod === 'exit' ? tvX : A.tvMethod === 'blend' ? (tvG + tvX) / 2 : tvG;
    const sumPV = U.sum(rows.map(r => r.pv)), ev = sumPV + pvTV;
    const equity = ev - A.netDebt - (A.minority || 0) + (A.investments || 0), perShare = equity / A.shares;
    // growth implied by an exit-multiple terminal value (same reinvestment logic)
    let impliedG = NaN;
    if (isFinite(tvX) && tvX > 0 && nopatN1 > 0) {
      const f = g => { const n1 = L.rev * (1 + g) * L.margin; const np = n1 - Math.max(n1, 0) * A.taxMarg; return np * (1 - g / roicS) / (WS - g) - tvX; };
      try { impliedG = U.bisect(f, -0.1, WS - 1e-4, 1e-9); } catch (e) { impliedG = NaN; }
    }
    return {
      rows, coc, W0, WS, roicS, revN1, ebitN1, nopatN1, reinvRateN1, fcffN1, tvG, tvX, tv, pvG, pvX, pvTV, sumPV, ev, equity, perShare,
      upside: A.price ? perShare / A.price - 1 : null, tvShare: pvTV / ev, impliedExit: tvG / L.ebitda, impliedG, evEbitdaNTM: ev / rows[0].ebitda,
    };
  }

  function sensitivity(A, rowKey, rowVals, colKey, colVals) {
    return rowVals.map(rv => colVals.map(cv => dcf({ ...A, [rowKey]: rv, [colKey]: cv }).perShare));
  }
  function monteCarlo(A, n = 4000, sd = { g1: 0.03, margin: 0.025, wacc: 0.0075, tg: 0.004, s2c: 0.15 }) {
    const g = U.gaussFactory(U.mulberry32(2024)), base = dcf(A), out = [];
    for (let i = 0; i < n; i++) {
      const shift = sd.wacc * g();
      const tg = Math.min(A.termGrowth + sd.tg * g(), base.WS + shift - 0.005);
      const b = { ...A, g1: A.g1 + sd.g1 * g(), marginTarget: Math.max(-0.3, A.marginTarget + sd.margin * g()), waccShift: (A.waccShift || 0) + shift,
        termGrowth: tg, s2c: A.s2c * Math.exp(sd.s2c * g()), growthPath: null, marginPath: null };
      const v = dcf(b).perShare; if (isFinite(v)) out.push(v);
    }
    return out;
  }
  function reverse(A) {
    if (!A.price) return NaN;
    try { return U.bisect(g1 => dcf({ ...A, g1, growthPath: null }).perShare - A.price, -0.5, 1.5, 1e-7); } catch (e) { return NaN; }
  }
  const SCEN = { bear: { g1: -0.04, marginTarget: -0.03, waccShift: 0.01, termGrowth: -0.005 }, base: { g1: 0, marginTarget: 0, waccShift: 0, termGrowth: 0 }, bull: { g1: 0.04, marginTarget: 0.03, waccShift: -0.0075, termGrowth: 0.0025 } };
  function scenario(A, k) {
    const s = SCEN[k];
    return k === 'base' ? A : { ...A, g1: A.g1 + s.g1, marginTarget: A.marginTarget + s.marginTarget, termGrowth: A.termGrowth + s.termGrowth, waccShift: (A.waccShift || 0) + s.waccShift, growthPath: null, marginPath: null };
  }

  // ------------------------------------------------------------------ starting assumptions
  const FALLBACK_ERP = { value: 0.0423, date: '2026-01-01', source: 'Damodaran implied ERP at the start of 2026 (built in; live data unavailable)' };

  /** Build a full assumption set from statements, market data and Damodaran's tables. */
  function build(f, dam, mkt, opts = {}) {
    const ys = f.years.filter(y => isNum(y.revenue) && y.revenue > 0).sort((a, b) => a.year - b.year), L = ys[ys.length - 1];
    const ind = dam?.ind || null, ctry = dam?.country || null, us = dam?.us || null;
    const look = opts.look || 5, drivers = deriveDrivers(f, ind, look);
    const methods = { ...Object.fromEntries(Object.values(drivers).map(d => [d.key, d.method])), ...(opts.methods || {}) };
    const mcap = mkt.price * f.shares, debt = Math.max(f.debt || 0, 0);
    const deCompany = mcap > 0 ? debt / mcap : 0;
    const taxMarg = isNum(ctry?.tax) ? ctry.tax : 0.25;
    const coverage = L.interest > 0 ? L.ebit / L.interest : 100;
    const financial = /Bank|Insurance|Capital Markets|Mortgage|Credit Services|Asset Management/i.test(f.industry || '');
    const tables = dam?.ratings || {};
    const table = financial && tables.financial ? tables.financial : mcap < 5e9 && tables.small ? tables.small : tables.large;
    const rating = ratingFor(coverage, table);
    const isUS = !ctry || ctry.name === 'United States';
    const erp = dam?.erp?.value ?? FALLBACK_ERP.value;
    const crp = !isUS && isNum(ctry?.crp) ? ctry.crp - (isNum(us?.crp) ? us.crp : 0) : 0;
    const rf = mkt.rf;
    const ic0 = investedCapital(L) ?? (L.revenue / (drivers.s2c.value || 1.5));
    const margin0 = isNum(L.ebit) ? L.ebit / L.revenue : drivers.margin.value ?? 0.1;
    const A = {
      look, methods, baseYear: L.year, revenue0: L.revenue, margin0, ic0, coverage, financial,
      years: 10, hgYears: 5, convYear: 5, reinvMethod: 'sc', tvMethod: 'gordon', midYear: true,
      g1: 0, marginTarget: margin0, taxEff: 0.21, s2c: 1.5, daPct: 0.04, capexPct: 0.05, nwcPct: 0.05,
      taxMarg, rf, erp, crp,
      betaMethod: ind && isNum(ind.betaUCash ?? ind.betaU) ? 'bottomup' : 'regression',
      betaU: ind?.betaUCash ?? ind?.betaU ?? (isNum(mkt.beta) ? mkt.beta / (1 + (1 - taxMarg) * deCompany) : 1),
      betaRegression: isNum(mkt.beta) ? mkt.beta : 1, betaIndustry: ind?.beta ?? 1, betaManual: isNum(mkt.beta) ? mkt.beta : 1,
      deMethod: 'company', de: deCompany, deCompany, deIndustry: ind?.de ?? deCompany,
      kdMethod: rating ? 'rating' : 'actual', kdSpread: rating ? rating.spread : 0.015, rating: rating?.rating || null,
      ctrySpread: !isUS && isNum(ctry?.defaultSpread) ? ctry.defaultSpread : 0,
      kdActual: debt > 0 && L.interest > 0 ? clamp(L.interest / debt, 0.01, 0.2) : null, kdManual: rf + 0.015,
      stableBeta: 1, stableWd: ind?.debtRatio ?? deCompany / (1 + deCompany),
      roicMethod: isNum(ind?.roc) ? 'industry' : 'wacc', roicIndustry: ind?.roc ?? null, roicStable: null,
      tgMethod: 'lower', termGrowth: null,
      exitMultiple: mkt.exitMultiple ?? 12, waccOverride: null, stableWaccOverride: null, waccShift: 0,
      netDebt: (f.debt || 0) - (f.cash || 0), cash: f.cash || 0, debt: f.debt || 0, minority: f.minority || 0, investments: 0, shares: f.shares, price: mkt.price,
      growthPath: null, marginPath: null,
      src: {
        erp: dam?.erp ? `Damodaran implied ERP, ${dam.erp.date}` : FALLBACK_ERP.source,
        betaU: ind ? `Damodaran: ${dam.indName}, unlevered beta corrected for cash` : 'Yahoo regression beta, unlevered at the company D/E',
        taxMarg: ctry?.tax != null ? `Damodaran: ${ctry.name} corporate tax rate` : 'US federal + state (default)',
        crp: isUS ? 'United States (no adjustment)' : `Damodaran: ${ctry?.name} vs US country risk premium`,
      },
    };
    applyDrivers(A, drivers);
    resolveDerived(A);
    return { A, drivers, rating };
  }

  /** Copy each driver's chosen value into the assumptions. */
  function applyDrivers(A, drivers) {
    Object.values(drivers).forEach(d => {
      const m = A.methods[d.key];
      if (m === 'manual') return;                       // keep the user's number
      const v = d.cand[m];
      if (isNum(v)) { A[d.field] = v; d.method = m; d.value = v; }
    });
  }

  /** Values that depend on other choices: D/E, ROIC in stable growth, terminal growth. */
  function resolveDerived(A) {
    if (A.deMethod === 'company') A.de = A.deCompany; else if (A.deMethod === 'industry') A.de = A.deIndustry;
    const coc = costOfCapital(A), WS = (A.stableWaccOverride ?? coc.waccStable);
    if (A.tgMethod === 'rf') A.termGrowth = Math.min(A.rf, WS - 0.01);
    else if (A.tgMethod === 'lower') A.termGrowth = Math.min(A.rf, WS - 0.01, Math.max(A.g1, 0.02));
    else if (A.tgMethod === 'inflation') A.termGrowth = 0.025;
    if (A.termGrowth == null) A.termGrowth = Math.min(A.rf, WS - 0.01);
    if (A.roicMethod === 'industry' && isNum(A.roicIndustry)) A.roicStable = Math.max(A.roicIndustry, WS);
    else if (A.roicMethod === 'wacc') A.roicStable = WS;
    else if (A.roicMethod === 'company') { const r = dcf({ ...A, roicStable: WS }).rows[0].roic; A.roicStable = isNum(r) ? Math.max(r, WS) : WS; }
    if (!(A.roicStable > 0)) A.roicStable = WS;
  }

  return { METHODS, TG_METHODS, ROIC_METHODS, DRIVERS, deriveDrivers, ratingFor, costOfCapital, paths, dcf, sensitivity, monteCarlo, reverse, SCEN, scenario, build, applyDrivers, resolveDerived, FALLBACK_ERP, investedCapital };
})();
