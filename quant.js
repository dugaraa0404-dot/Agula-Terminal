/* ============================================================================
   Agula Terminal — quantitative engine
   Indicators · risk · options · fixed income · portfolio · DCF · expressions
   ========================================================================== */
'use strict';

const Q = (() => {
  const { mean, std, ncdf, npdf, ninv, quantile, isNum } = U;

  // ======================= technical indicators =======================
  function sma(x, n) { const o = new Array(x.length).fill(null); let s = 0; for (let i = 0; i < x.length; i++) { s += x[i]; if (i >= n) s -= x[i - n]; if (i >= n - 1) o[i] = s / n; } return o; }
  function ema(x, n) { const o = new Array(x.length).fill(null), k = 2 / (n + 1); let e = null; for (let i = 0; i < x.length; i++) { if (x[i] == null) continue; e = e == null ? x[i] : x[i] * k + e * (1 - k); if (i >= n - 1) o[i] = e; } return o; }
  function wilder(x, n) { const o = new Array(x.length).fill(null); let s = 0, e = null; for (let i = 0; i < x.length; i++) { if (e == null) { s += x[i]; if (i === n - 1) { e = s / n; o[i] = e; } } else { e = (e * (n - 1) + x[i]) / n; o[i] = e; } } return o; }
  function rollingStd(x, n) { const o = new Array(x.length).fill(null); for (let i = n - 1; i < x.length; i++) o[i] = std(x.slice(i - n + 1, i + 1), 0); return o; }
  function bbands(c, n = 20, k = 2) { const m = sma(c, n), s = rollingStd(c, n); return { mid: m, up: m.map((v, i) => v == null ? null : v + k * s[i]), lo: m.map((v, i) => v == null ? null : v - k * s[i]) }; }
  function rsi(c, n = 14) {
    const g = [0], l = [0]; for (let i = 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g.push(Math.max(d, 0)); l.push(Math.max(-d, 0)); }
    const ag = wilder(g.slice(1), n), al = wilder(l.slice(1), n);
    return [null, ...ag.map((v, i) => v == null ? null : al[i] === 0 ? 100 : 100 - 100 / (1 + v / al[i]))];
  }
  function macd(c, f = 12, s = 26, sig = 9) {
    const ef = ema(c, f), es = ema(c, s), line = c.map((_, i) => ef[i] == null || es[i] == null ? null : ef[i] - es[i]);
    const start = line.findIndex(v => v != null), sl = new Array(c.length).fill(null);
    if (start >= 0) { const e = ema(line.slice(start), sig); e.forEach((v, i) => sl[start + i] = v); }
    return { line, signal: sl, hist: line.map((v, i) => v == null || sl[i] == null ? null : v - sl[i]) };
  }
  function trueRange(b) { return b.map((x, i) => i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c))); }
  const atr = (b, n = 14) => wilder(trueRange(b), n);
  function stoch(b, n = 14, d = 3) {
    const k = b.map((x, i) => { if (i < n - 1) return null; let hh = -Infinity, ll = Infinity; for (let j = i - n + 1; j <= i; j++) { hh = Math.max(hh, b[j].h); ll = Math.min(ll, b[j].l); } return hh === ll ? 50 : 100 * (x.c - ll) / (hh - ll); });
    const ks = k.map((v, i) => i < n - 1 + 2 ? null : (k[i] + k[i - 1] + k[i - 2]) / 3);
    const dd = ks.map((v, i) => i < n - 1 + 2 + d - 1 ? null : U.mean(ks.slice(i - d + 1, i + 1)));
    return { k: ks, d: dd };
  }
  function obv(b) { let s = 0; return b.map((x, i) => { if (i > 0) s += x.c > b[i - 1].c ? x.v : x.c < b[i - 1].c ? -x.v : 0; return s; }); }
  function vwapRolling(b, n = 20) { return b.map((_, i) => { if (i < n - 1) return null; let pv = 0, v = 0; for (let j = i - n + 1; j <= i; j++) { const tp = (b[j].h + b[j].l + b[j].c) / 3; pv += tp * b[j].v; v += b[j].v; } return v ? pv / v : null; }); }
  function keltner(b, n = 20, m = 2) { const c = b.map(x => x.c), e = ema(c, n), a = atr(b, n); return { mid: e, up: e.map((v, i) => v == null || a[i] == null ? null : v + m * a[i]), lo: e.map((v, i) => v == null || a[i] == null ? null : v - m * a[i]) }; }
  function donchian(b, n = 20) { return { up: b.map((_, i) => i < n - 1 ? null : Math.max(...b.slice(i - n + 1, i + 1).map(x => x.h))), lo: b.map((_, i) => i < n - 1 ? null : Math.min(...b.slice(i - n + 1, i + 1).map(x => x.l))) }; }

  // ======================= performance & risk statistics =======================
  function perfStats(bars, benchBars, rf = 0.04, periodsPerYear = 252) {
    const c = bars.map(b => b.c), r = U.returns(c);
    const out = { n: r.length };
    const lastC = c[c.length - 1];
    const ret = k => c.length > k ? lastC / c[c.length - 1 - k] - 1 : null;
    out.r1d = ret(1); out.r1w = ret(5); out.r1m = ret(21); out.r3m = ret(63); out.r6m = ret(126); out.r1y = ret(252);
    const y = new Date(bars[bars.length - 1].t).getUTCFullYear();
    const ytdBase = bars.filter(b => new Date(b.t).getUTCFullYear() < y).pop();
    out.ytd = ytdBase ? lastC / ytdBase.c - 1 : null;
    const r1y = r.slice(-periodsPerYear);
    out.vol = std(r1y) * Math.sqrt(periodsPerYear);
    out.annRet = Math.pow(c[c.length - 1] / c[Math.max(0, c.length - 1 - periodsPerYear)], periodsPerYear / Math.min(periodsPerYear, r.length)) - 1;
    out.sharpe = (out.annRet - rf) / out.vol;
    const dn = r1y.filter(x => x < 0); out.sortino = (out.annRet - rf) / (Math.sqrt(U.mean(dn.map(x => x * x))) * Math.sqrt(periodsPerYear));
    const md = U.maxDrawdown(c.slice(-periodsPerYear)); out.mdd = md.mdd;
    out.skew = U.skew(r1y); out.kurt = U.kurt(r1y);
    out.var95 = -quantile(r1y, 0.05);
    out.hi52 = Math.max(...bars.slice(-periodsPerYear).map(b => b.h)); out.lo52 = Math.min(...bars.slice(-periodsPerYear).map(b => b.l));
    if (benchBars && benchBars.length > 30) {
      const m = new Map(benchBars.map(b => [U.isoDate(b.t), b.c]));
      const xs = [], ys = [];
      for (let i = 1; i < bars.length; i++) {
        const a = m.get(U.isoDate(bars[i].t)), p = m.get(U.isoDate(bars[i - 1].t));
        if (a && p) { xs.push(a / p - 1); ys.push(bars[i].c / bars[i - 1].c - 1); }
      }
      const xs1 = xs.slice(-periodsPerYear), ys1 = ys.slice(-periodsPerYear);
      if (xs1.length > 30) {
        const lr = U.linreg(xs1, ys1);
        out.beta = lr.b; out.alpha = lr.a * periodsPerYear; out.r2 = lr.r2; out.corr = U.corr(xs1, ys1);
        const te = std(ys1.map((v, i) => v - xs1[i])) * Math.sqrt(periodsPerYear);
        out.te = te; out.ir = (U.mean(ys1) - U.mean(xs1)) * periodsPerYear / te;
      }
    }
    return out;
  }
  function realizedVol(c, n = 21, ppy = 252) { const r = U.returns(c, true); return std(r.slice(-n)) * Math.sqrt(ppy); }

  // ======================= options =======================
  function d1d2(S, K, T, r, q, v) { const d1 = (Math.log(S / K) + (r - q + 0.5 * v * v) * T) / (v * Math.sqrt(T)); return [d1, d1 - v * Math.sqrt(T)]; }
  function bs(S, K, T, r, q, v, type = 'C') {
    if (T <= 0 || v <= 0) return Math.max(type === 'C' ? S - K : K - S, 0);
    const [d1, d2] = d1d2(S, K, T, r, q, v);
    return type === 'C' ? S * Math.exp(-q * T) * ncdf(d1) - K * Math.exp(-r * T) * ncdf(d2)
      : K * Math.exp(-r * T) * ncdf(-d2) - S * Math.exp(-q * T) * ncdf(-d1);
  }
  function greeks(S, K, T, r, q, v, type = 'C') {
    T = Math.max(T, 1e-6); v = Math.max(v, 1e-6);
    const [d1, d2] = d1d2(S, K, T, r, q, v), sq = Math.sqrt(T), eq = Math.exp(-q * T), er = Math.exp(-r * T), pd = npdf(d1);
    const call = type === 'C';
    const delta = call ? eq * ncdf(d1) : -eq * ncdf(-d1);
    const gamma = eq * pd / (S * v * sq);
    const vega = S * eq * pd * sq / 100;                       // per 1 vol point
    const theta = (call
      ? -S * eq * pd * v / (2 * sq) - r * K * er * ncdf(d2) + q * S * eq * ncdf(d1)
      : -S * eq * pd * v / (2 * sq) + r * K * er * ncdf(-d2) - q * S * eq * ncdf(-d1)) / 365; // per calendar day
    const rho = (call ? K * T * er * ncdf(d2) : -K * T * er * ncdf(-d2)) / 100; // per 1% rate
    const vanna = -eq * pd * d2 / v / 100;                     // d delta / d vol (per vol pt)
    const volga = vega * d1 * d2 / v / 100;                    // d vega / d vol (per vol pt)
    const charm = (call ? q * eq * ncdf(d1) : -q * eq * ncdf(-d1)) - eq * pd * (2 * (r - q) * T - d2 * v * sq) / (2 * T * v * sq);
    return { price: bs(S, K, T, r, q, v, type), delta, gamma, vega, theta, rho, vanna, volga, charm: charm / 365, d1, d2, probITM: call ? ncdf(d2) : ncdf(-d2) };
  }
  function impliedVol(price, S, K, T, r, q, type = 'C') {
    const intrinsic = Math.max(type === 'C' ? S * Math.exp(-q * T) - K * Math.exp(-r * T) : K * Math.exp(-r * T) - S * Math.exp(-q * T), 0);
    if (!(price > intrinsic)) return NaN;
    let v = Math.sqrt(2 * Math.abs(Math.log(S / K) + (r - q) * T) / T) || 0.3; v = U.clamp(v, 0.05, 2);
    for (let i = 0; i < 50; i++) {
      const p = bs(S, K, T, r, q, v, type), vg = greeks(S, K, T, r, q, v, type).vega * 100;
      const diff = p - price; if (Math.abs(diff) < 1e-8) return v;
      if (vg < 1e-8) break;
      v -= diff / vg; if (v <= 0.001 || v > 5) break;
    }
    return U.bisect(x => bs(S, K, T, r, q, x, type) - price, 0.001, 5, 1e-9);
  }
  function binomial(S, K, T, r, q, v, type = 'C', american = true, N = 300) {
    const dt = T / N, u = Math.exp(v * Math.sqrt(dt)), d = 1 / u, p = (Math.exp((r - q) * dt) - d) / (u - d), disc = Math.exp(-r * dt);
    const vals = new Float64Array(N + 1);
    for (let i = 0; i <= N; i++) { const s = S * Math.pow(u, N - i) * Math.pow(d, i); vals[i] = Math.max(type === 'C' ? s - K : K - s, 0); }
    for (let step = N - 1; step >= 0; step--) {
      for (let i = 0; i <= step; i++) {
        let cont = disc * (p * vals[i] + (1 - p) * vals[i + 1]);
        if (american) { const s = S * Math.pow(u, step - i) * Math.pow(d, i); cont = Math.max(cont, type === 'C' ? s - K : K - s); }
        vals[i] = cont;
      }
    }
    return vals[0];
  }
  function monteCarloOption(S, K, T, r, q, v, type = 'C', paths = 20000, kind = 'european', steps = 50, barrier = null) {
    const g = U.gaussFactory(U.mulberry32(12345));
    let s1 = 0, s2 = 0;
    const dt = T / steps, drift = (r - q - 0.5 * v * v), payoff = (st, avg, hit) => {
      const ref = kind === 'asian' ? avg : st;
      let p = Math.max(type === 'C' ? ref - K : K - ref, 0);
      if (kind === 'barrier-up-out' && hit) p = 0;
      return p;
    };
    const n = paths / 2;
    for (let i = 0; i < n; i++) {
      let sa = S, sb = S, aa = 0, ab = 0, ha = false, hb = false;
      if (kind === 'european') {
        const z = g(); sa = S * Math.exp(drift * T + v * Math.sqrt(T) * z); sb = S * Math.exp(drift * T - v * Math.sqrt(T) * z);
      } else {
        for (let k = 0; k < steps; k++) {
          const z = g();
          sa *= Math.exp(drift * dt + v * Math.sqrt(dt) * z); sb *= Math.exp(drift * dt - v * Math.sqrt(dt) * z);
          aa += sa; ab += sb; if (barrier && sa >= barrier) ha = true; if (barrier && sb >= barrier) hb = true;
        }
        aa /= steps; ab /= steps;
      }
      const x = 0.5 * (payoff(sa, aa, ha) + payoff(sb, ab, hb));
      s1 += x; s2 += x * x;
    }
    const m = s1 / n, se = Math.sqrt(Math.max(s2 / n - m * m, 0) / n);
    return { price: Math.exp(-r * T) * m, se: Math.exp(-r * T) * se };
  }
  // Parametric volatility smile: atm term structure + skew + curvature in log-moneyness
  function smileVol(model, K, F, T) {
    const k = Math.log(K / F), atm = model.atmLong + (model.atmShort - model.atmLong) * Math.exp(-T / model.termDecay);
    const sk = model.skew / Math.sqrt(Math.max(T, 0.02)), cv = model.curv / Math.max(T, 0.05) ** 0.25;
    return Math.max(0.03, atm + sk * k + cv * k * k);
  }
  function strategyPayoff(legs, S, Tshift, r, q, model, spotGrid) {
    // legs: {type:'C'|'P'|'S', K, T, qty, premium}
    return spotGrid.map(x => {
      let atExp = 0, now = 0;
      for (const L of legs) {
        if (L.type === 'S') { atExp += L.qty * (x - L.premium); now += L.qty * (x - L.premium); continue; }
        const intrinsic = Math.max(L.type === 'C' ? x - L.K : L.K - x, 0);
        const minT = Math.min(...legs.filter(l => l.type !== 'S').map(l => l.T));
        const tRem = L.T - minT; // value other legs at first expiry
        const volAt = (t, spot) => model ? smileVol(model, L.K, spot * Math.exp((r - q) * t), t) : L.iv; // real chains: each leg keeps its own implied vol
        const valAtFirst = tRem > 1e-6 ? bs(x, L.K, tRem, r, q, volAt(tRem, x), L.type) : intrinsic;
        atExp += L.qty * 100 * (valAtFirst - L.premium);
        const tNow = Math.max(L.T - Tshift, 1e-6);
        now += L.qty * 100 * (bs(x, L.K, tNow, r, q, volAt(tNow, x), L.type) - L.premium);
      }
      return { x, atExp, now };
    });
  }

  // ======================= fixed income =======================
  function nss(p, t) { // zero rate (decimal) at maturity t (years), Nelson-Siegel-Svensson
    t = Math.max(t, 1e-4);
    const a = t / p.l1, b = t / p.l2, f1 = (1 - Math.exp(-a)) / a, f2 = f1 - Math.exp(-a), f3 = (1 - Math.exp(-b)) / b - Math.exp(-b);
    return p.b0 + p.b1 * f1 + p.b2 * f2 + (p.b3 || 0) * f3;
  }
  function fitNSS(tenors, yields, l1 = 1.6, l2 = 9) {
    // With the decay parameters fixed, Nelson-Siegel-Svensson is linear in its four betas: ordinary least squares.
    const basis = t => { const a = t / l1, b = t / l2, f1 = (1 - Math.exp(-a)) / a; return [1, f1, f1 - Math.exp(-a), (1 - Math.exp(-b)) / b - Math.exp(-b)]; };
    const X = tenors.map(basis), XtX = U.range(4, i => U.range(4, j => U.sum(X.map(x => x[i] * x[j])) + (i === j ? 1e-10 : 0))), Xty = U.range(4, i => U.sum(X.map((x, k) => x[i] * yields[k])));
    const [b0, b1, b2, b3] = U.solveLinear(XtX, Xty), p = { b0, b1, b2, b3, l1, l2 };
    return { p, resid: tenors.map((t, k) => yields[k] - nss(p, t)) };
  }
  function curveFromZeros(tenors, zeros) { // linear interpolation on zero rates, flat extrapolation
    return t => {
      if (t <= tenors[0]) return zeros[0];
      for (let i = 1; i < tenors.length; i++) if (t <= tenors[i]) { const w = (t - tenors[i - 1]) / (tenors[i] - tenors[i - 1]); return zeros[i - 1] + w * (zeros[i] - zeros[i - 1]); }
      return zeros[zeros.length - 1];
    };
  }
  const discount = (zeroFn, t) => Math.exp(-zeroFn(t) * t);
  function parYield(zeroFn, T, freq = 2) {
    const n = Math.max(1, Math.round(T * freq)); let annuity = 0;
    for (let i = 1; i <= n; i++) annuity += discount(zeroFn, i / freq) / freq;
    return (1 - discount(zeroFn, n / freq)) / annuity;
  }
  function forwardRate(zeroFn, t1, t2) { return (zeroFn(t2) * t2 - zeroFn(t1) * t1) / (t2 - t1); }
  function bootstrapPar(tenors, pars, freq = 2) {
    // par yields (decimal, semi-annual bond-equivalent) -> continuously compounded zero curve on a 1/freq grid
    const parAt = curveFromZeros(tenors, pars), maxT = tenors[tenors.length - 1];
    const grid = [], zeros = [], dfs = [];
    for (let i = 1; i <= Math.round(maxT * freq); i++) {
      const t = i / freq, c = parAt(t) / freq;
      if (t <= 1 / freq + 1e-9 || t < 1) { // money-market style at the very short end
        const df = 1 / (1 + parAt(t) * t); dfs.push(df); grid.push(t); zeros.push(-Math.log(df) / t); continue;
      }
      let s = 0; for (let j = 0; j < dfs.length; j++) s += c * dfs[j];
      const df = (1 - s) / (1 + c); dfs.push(df); grid.push(t); zeros.push(-Math.log(df) / t);
    }
    return { grid, zeros, fn: curveFromZeros(grid, zeros) };
  }
  function addMonthsUTC(d, months, day) {
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + months;
    const first = new Date(Date.UTC(y, m, 1)), dim = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, dim)));
  }
  function bondSchedule(settle, maturity, freq) {
    // coupon dates strictly after settlement, rolled back from maturity; plus the previous coupon date
    const dates = [], months = 12 / freq, day = maturity.getUTCDate();
    let k = 0, d = maturity;
    while (d > settle) { dates.unshift(d); k++; d = addMonthsUTC(maturity, -months * k, day); }
    return { dates, prev: d };
  }
  function dayCount(a, b, conv) {
    if (conv === '30/360') {
      let d1 = Math.min(a.getUTCDate(), 30), d2 = b.getUTCDate(); if (d1 === 30 && d2 === 31) d2 = 30;
      return ((b.getUTCFullYear() - a.getUTCFullYear()) * 360 + (b.getUTCMonth() - a.getUTCMonth()) * 30 + (d2 - d1)) / 360;
    }
    return (b - a) / U.DAY / 365; // ACT/365 helper
  }
  function bondAnalytics({ face = 100, coupon, freq = 2, settle, maturity, ytm = null, clean = null, conv = 'ACT/ACT', spread = 0, zeroFn = null }) {
    const { dates, prev } = bondSchedule(settle, maturity, freq);
    if (!dates.length) throw new Error('Maturity must be after settlement');
    const next = dates[0];
    const periodFrac = conv === '30/360' ? dayCount(prev, settle, '30/360') * freq : (settle - prev) / (next - prev);
    const accrued = face * coupon / freq * periodFrac;
    const cpn = face * coupon / freq;
    const flows = dates.map((d, i) => ({ date: d, k: i + (1 - periodFrac), cf: cpn + (i === dates.length - 1 ? face : 0), tYears: (d - settle) / U.DAY / 365.25 }));
    const dirtyFromY = y => flows.reduce((s, f) => s + f.cf / Math.pow(1 + y / freq, f.k), 0);
    if (ytm == null && clean != null) ytm = U.bisect(y => dirtyFromY(y) - (clean + accrued), -0.05, 1.5, 1e-12);
    if (ytm == null && zeroFn) {
      const dirtyCurve = flows.reduce((s, f) => s + f.cf * Math.exp(-(zeroFn(f.tYears) + spread) * f.tYears), 0);
      ytm = U.bisect(y => dirtyFromY(y) - dirtyCurve, -0.05, 1.5, 1e-12);
    }
    const dirty = dirtyFromY(ytm), cleanP = dirty - accrued;
    let mac = 0, cx = 0;
    flows.forEach(f => { const df = Math.pow(1 + ytm / freq, -f.k); mac += f.k / freq * f.cf * df; cx += f.cf * df * f.k * (f.k + 1) / (freq * freq) / Math.pow(1 + ytm / freq, 2); f.pv = f.cf * df; });
    mac /= dirty; cx /= dirty;
    const mod = mac / (1 + ytm / freq);
    const dv01 = mod * dirty / 1e4;
    const currentYield = face * coupon / cleanP;
    return { ytm, dirty, clean: cleanP, accrued, macaulay: mac, modified: mod, convexity: cx, dv01, currentYield, flows, next, prev, dirtyFromY };
  }
  function keyRateDurations(flows, zeroFn, keys = [0.5, 2, 5, 10, 30], bump = 1e-4) {
    const price = fn => flows.reduce((s, f) => s + f.cf * Math.exp(-fn(f.tYears) * f.tYears), 0);
    const p0 = price(zeroFn);
    return keys.map((k, i) => {
      const lo = i ? keys[i - 1] : 0, hi = i < keys.length - 1 ? keys[i + 1] : 100;
      const tri = t => t <= lo || t >= hi ? 0 : t <= k ? (t - lo) / (k - lo) : (hi - t) / (hi - k);
      const up = t => zeroFn(t) + bump * (i === keys.length - 1 && t >= k ? 1 : tri(t));
      const dn = t => zeroFn(t) - bump * (i === keys.length - 1 && t >= k ? 1 : tri(t));
      return { key: k, krd: (price(dn) - price(up)) / (2 * p0 * bump) };
    });
  }

  // ======================= portfolio =======================
  function portfolioReturns(weights, retMatrix) { // retMatrix[asset][t]
    const T = retMatrix[0].length; const out = new Array(T).fill(0);
    weights.forEach((w, i) => { for (let t = 0; t < T; t++) out[t] += w * retMatrix[i][t]; });
    return out;
  }
  function varSuite(weights, retMatrix, value, horizon = 1, conf = [0.95, 0.99], mcPaths = 10000) {
    const pr = portfolioReturns(weights, retMatrix), C = U.covMatrix(retMatrix), mu = retMatrix.map(U.mean);
    const pm = U.dot(weights, mu) * horizon, ps = Math.sqrt(U.quad(weights, C) * horizon);
    const sk = U.skew(pr), ku = U.kurt(pr);
    const L = U.cholesky(C), g = U.gaussFactory(U.mulberry32(99)), sims = new Float64Array(mcPaths);
    for (let p = 0; p < mcPaths; p++) {
      const z = weights.map(() => g()); const x = U.matVec(L, z);
      sims[p] = weights.reduce((s, w, i) => s + w * (mu[i] * horizon + x[i] * Math.sqrt(horizon)), 0);
    }
    const simArr = Array.from(sims);
    const hist = horizon === 1 ? pr : pr.map((_, i) => i + horizon <= pr.length ? pr.slice(i, i + horizon).reduce((a, b) => (1 + a) * (1 + b) - 1, 0) : null).filter(v => v != null);
    const rows = conf.map(c => {
      const z = ninv(1 - c);
      const zcf = z + (z * z - 1) * sk / 6 + (z ** 3 - 3 * z) * ku / 24 - (2 * z ** 3 - 5 * z) * sk * sk / 36; // Cornish-Fisher
      const hq = quantile(hist, 1 - c), mq = quantile(simArr, 1 - c);
      const es = arr => { const q = quantile(arr, 1 - c); const t = arr.filter(x => x <= q); return t.length ? -U.mean(t) : NaN; };
      return {
        conf: c,
        hist: -hq * value, histES: es(hist) * value,
        param: -(pm + z * ps) * value, paramES: (-pm + ps * npdf(z) / (1 - c)) * value,
        cf: -(pm + zcf * ps) * value,
        mc: -mq * value, mcES: es(simArr) * value,
      };
    });
    const z95 = -ninv(0.05), Cw = U.matVec(C, weights), sp = Math.sqrt(U.quad(weights, C));
    const component = weights.map((w, i) => w * Cw[i] / sp * z95 * Math.sqrt(horizon) * value);
    return { rows, component, sigmaDaily: sp, pr, sims: simArr, skew: sk, kurt: ku };
  }
  function optimizeMV(mu, C, lambda, lo = 0, iters = 600) {
    // maximize w'mu - lambda/2 w'Cw on the simplex (projected gradient, adaptive step)
    const n = mu.length; let w = new Array(n).fill(1 / n);
    const L = Math.max(...C.map((r) => r.reduce((s, x) => s + Math.abs(x), 0))) * lambda + 1e-12;
    const step = 1 / L;
    for (let k = 0; k < iters; k++) {
      const Cw = U.matVec(C, w), grad = mu.map((m, i) => m - lambda * Cw[i]);
      const nw = U.projectSimplex(w.map((x, i) => x + step * grad[i]), lo);
      let diff = 0; for (let i = 0; i < n; i++) diff += Math.abs(nw[i] - w[i]);
      w = nw; if (diff < 1e-10) break;
    }
    return w;
  }
  function efficientFrontier(mu, C, rf = 0.04, n = 40) {
    const pts = []; const lams = U.linspace(Math.log(0.3), Math.log(400), n).map(Math.exp);
    for (const lam of lams) {
      const w = optimizeMV(mu, C, lam); const r = U.dot(w, mu), s = Math.sqrt(U.quad(w, C));
      pts.push({ w, ret: r, vol: s, sharpe: (r - rf) / s });
    }
    pts.sort((a, b) => a.vol - b.vol);
    const minVar = pts[0];
    let best = pts.reduce((a, b) => b.sharpe > a.sharpe ? b : a);
    // refine max-Sharpe by projected gradient on the Sharpe ratio
    let w = best.w.slice();
    for (let k = 0; k < 400; k++) {
      const r = U.dot(w, mu) - rf, Cw = U.matVec(C, w), s2 = U.dot(w, Cw), s = Math.sqrt(s2);
      const grad = mu.map((m, i) => (m * s - r * Cw[i] / s) / s2);
      w = U.projectSimplex(w.map((x, i) => x + 0.02 * grad[i]));
    }
    const r = U.dot(w, mu), s = Math.sqrt(U.quad(w, C));
    if ((r - rf) / s > best.sharpe) best = { w, ret: r, vol: s, sharpe: (r - rf) / s };
    return { pts, minVar, maxSharpe: best };
  }
  function randomPortfolios(mu, C, n = 1500, rf = 0.04) {
    const r = U.mulberry32(7), out = [];
    for (let i = 0; i < n; i++) {
      let w = mu.map(() => (-Math.log(r() + 1e-12)) ** 1.5); const s = U.sum(w); w = w.map(x => x / s);
      const ret = U.dot(w, mu), vol = Math.sqrt(U.quad(w, C)); out.push({ ret, vol, sharpe: (ret - rf) / vol });
    }
    return out;
  }
  function riskParity(C, iters = 500) {
    const n = C.length; let w = new Array(n).fill(1 / n);
    for (let k = 0; k < iters; k++) {
      const Cw = U.matVec(C, w), s = Math.sqrt(U.dot(w, Cw));
      const rc = w.map((x, i) => x * Cw[i] / s), target = s / n;
      w = w.map((x, i) => x * Math.pow(target / Math.max(rc[i], 1e-12), 0.5));
      const t = U.sum(w); w = w.map(x => x / t);
    }
    return w;
  }

  // DCF: see dcf_engine.js (DCFM)


  // ======================= expression filter (screener) =======================
  function compileExpr(src, allowed) {
    const toks = []; const re = /\s*(?:(\d+(?:\.\d+)?%?)|([A-Za-z_][A-Za-z0-9_]*)|(<=|>=|==|!=|&&|\|\||[<>()+\-*/!]))/y;
    let m, pos = 0; src = src.trim();
    while (pos < src.length) {
      re.lastIndex = pos; m = re.exec(src);
      if (!m || m.index !== pos) throw new Error(`Unexpected text near "${src.slice(pos, pos + 12)}"`);
      pos = re.lastIndex;
      if (m[1]) toks.push({ t: 'num', v: m[1].endsWith('%') ? parseFloat(m[1]) / 100 : parseFloat(m[1]) });
      else if (m[2]) { const w = m[2].toLowerCase(); if (w === 'and' || w === 'or' || w === 'not') toks.push({ t: 'op', v: w }); else { if (!allowed.includes(w)) throw new Error(`Unknown field "${m[2]}". Fields: ${allowed.join(', ')}`); toks.push({ t: 'id', v: w }); } }
      else toks.push({ t: 'op', v: m[3] === '&&' ? 'and' : m[3] === '||' ? 'or' : m[3] === '!' ? 'not' : m[3] });
      while (pos < src.length && /\s/.test(src[pos])) pos++;
    }
    let i = 0; const peek = () => toks[i], take = () => toks[i++];
    const expect = v => { const t = take(); if (!t || t.v !== v) throw new Error(`Expected "${v}"`); };
    function primary() {
      const t = take(); if (!t) throw new Error('Unexpected end of filter');
      if (t.t === 'num') return () => t.v;
      if (t.t === 'id') return r => r[t.v];
      if (t.v === '(') { const e = or(); expect(')'); return e; }
      if (t.v === '-') { const e = primary(); return r => -e(r); }
      if (t.v === 'not') { const e = cmp(); return r => !e(r); }
      throw new Error(`Unexpected "${t.v}"`);
    }
    function mul() { let l = primary(); while (peek() && (peek().v === '*' || peek().v === '/')) { const o = take().v, r = primary(), a = l; l = o === '*' ? x => a(x) * r(x) : x => a(x) / r(x); } return l; }
    function add() { let l = mul(); while (peek() && (peek().v === '+' || peek().v === '-')) { const o = take().v, r = mul(), a = l; l = o === '+' ? x => a(x) + r(x) : x => a(x) - r(x); } return l; }
    function cmp() {
      if (peek() && peek().v === 'not') { take(); const e = cmp(); return r => !e(r); }
      const l = add(); const o = peek() && ['<', '>', '<=', '>=', '==', '!='].includes(peek().v) ? take().v : null;
      if (!o) return l; const r = add();
      return { '<': x => l(x) < r(x), '>': x => l(x) > r(x), '<=': x => l(x) <= r(x), '>=': x => l(x) >= r(x), '==': x => l(x) === r(x), '!=': x => l(x) !== r(x) }[o];
    }
    function and() { let l = cmp(); while (peek() && peek().v === 'and') { take(); const r = cmp(), a = l; l = x => a(x) && r(x); } return l; }
    function or() { let l = and(); while (peek() && peek().v === 'or') { take(); const r = and(), a = l; l = x => a(x) || r(x); } return l; }
    const fn = or(); if (i < toks.length) throw new Error(`Unexpected "${toks[i].v}"`);
    return row => { try { const v = fn(row); return v === true || (typeof v === 'number' && v !== 0 && isFinite(v)); } catch (e) { return false; } };
  }

  return {
    sma, ema, bbands, rsi, macd, atr, stoch, obv, vwapRolling, keltner, donchian, trueRange,
    perfStats, realizedVol,
    bs, greeks, impliedVol, binomial, monteCarloOption, smileVol, strategyPayoff,
    nss, fitNSS, curveFromZeros, discount, parYield, forwardRate, bootstrapPar, bondAnalytics, keyRateDurations, dayCount,
    portfolioReturns, varSuite, optimizeMV, efficientFrontier, randomPortfolios, riskParity,
    compileExpr,
  };
})();
