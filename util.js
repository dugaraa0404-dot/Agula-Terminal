/* ============================================================================
   Agula Terminal — utilities: RNG, statistics, linear algebra, formatting
   ========================================================================== */
'use strict';

const U = (() => {
  // ---------- random numbers ----------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function gaussFactory(rand) {
    let spare = null;
    return function () {
      if (spare !== null) { const s = spare; spare = null; return s; }
      let u = 0, v = 0;
      while (u === 0) u = rand();
      v = rand();
      const r = Math.sqrt(-2 * Math.log(u));
      spare = r * Math.sin(2 * Math.PI * v);
      return r * Math.cos(2 * Math.PI * v);
    };
  }
  const rand = Math.random;
  const gauss = gaussFactory(Math.random);

  // ---------- normal distribution ----------
  function erf(x) {
    // Abramowitz & Stegun 7.1.26 refined (max error ~1.2e-7 with this form)
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.5 * x);
    const y = 1 - t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
      t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
    return s * y;
  }
  const ncdf = x => 0.5 * (1 + erf(x / Math.SQRT2));
  const npdf = x => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
  function ninv(p) {
    // Acklam's algorithm
    if (p <= 0) return -Infinity; if (p >= 1) return Infinity;
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    const pl = 0.02425, ph = 1 - pl;
    let q, r;
    if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p <= ph) { q = p - 0.5; r = q * q; return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1); }
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }

  // ---------- descriptive statistics ----------
  const sum = a => { let s = 0; for (const x of a) s += x; return s; };
  const mean = a => a.length ? sum(a) / a.length : NaN;
  function variance(a, ddof = 1) {
    const n = a.length; if (n <= ddof) return NaN;
    const m = mean(a); let s = 0; for (const x of a) s += (x - m) * (x - m); return s / (n - ddof);
  }
  const std = (a, ddof = 1) => Math.sqrt(variance(a, ddof));
  function quantile(a, q) {
    if (!a.length) return NaN;
    const s = Float64Array.from(a).sort();
    const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }
  function cov(a, b) {
    const n = Math.min(a.length, b.length); if (n < 2) return NaN;
    const ma = mean(a.slice(-n)), mb = mean(b.slice(-n));
    let s = 0; for (let i = 0; i < n; i++) s += (a[a.length - n + i] - ma) * (b[b.length - n + i] - mb);
    return s / (n - 1);
  }
  const corr = (a, b) => cov(a, b) / (std(a.slice(-Math.min(a.length, b.length))) * std(b.slice(-Math.min(a.length, b.length))));
  function skew(a) { const m = mean(a), s = std(a, 0); return mean(a.map(x => ((x - m) / s) ** 3)); }
  function kurt(a) { const m = mean(a), s = std(a, 0); return mean(a.map(x => ((x - m) / s) ** 4)) - 3; }
  function returns(closes, log = false) {
    const r = [];
    for (let i = 1; i < closes.length; i++) r.push(log ? Math.log(closes[i] / closes[i - 1]) : closes[i] / closes[i - 1] - 1);
    return r;
  }
  function maxDrawdown(series) {
    let peak = -Infinity, mdd = 0, peakI = 0, s = 0, e = 0, curPeakI = 0;
    series.forEach((v, i) => {
      if (v > peak) { peak = v; curPeakI = i; }
      const dd = v / peak - 1;
      if (dd < mdd) { mdd = dd; peakI = curPeakI; e = i; }
    });
    s = peakI;
    return { mdd, start: s, end: e };
  }
  function drawdownSeries(series) {
    let peak = -Infinity; return series.map(v => { peak = Math.max(peak, v); return v / peak - 1; });
  }
  function histogram(values, bins = 40, lo, hi) {
    lo = lo ?? Math.min(...values); hi = hi ?? Math.max(...values);
    if (hi === lo) hi = lo + 1;
    const w = (hi - lo) / bins, counts = new Array(bins).fill(0);
    for (const v of values) { let k = Math.floor((v - lo) / w); if (k < 0) k = 0; if (k >= bins) k = bins - 1; counts[k]++; }
    return { counts, edges: Array.from({ length: bins + 1 }, (_, i) => lo + i * w), width: w };
  }
  function linreg(x, y) {
    const mx = mean(x), my = mean(y); let sxy = 0, sxx = 0;
    for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
    const b = sxy / sxx, a = my - b * mx;
    let ssr = 0, sst = 0;
    for (let i = 0; i < x.length; i++) { ssr += (y[i] - a - b * x[i]) ** 2; sst += (y[i] - my) ** 2; }
    return { a, b, r2: 1 - ssr / sst };
  }

  // ---------- linear algebra ----------
  function covMatrix(series) { // series: array of equal-length return arrays
    const k = series.length, M = Array.from({ length: k }, () => new Array(k).fill(0));
    const means = series.map(mean), n = series[0].length;
    for (let i = 0; i < k; i++) for (let j = i; j < k; j++) {
      let s = 0; for (let t = 0; t < n; t++) s += (series[i][t] - means[i]) * (series[j][t] - means[j]);
      M[i][j] = M[j][i] = s / (n - 1);
    }
    return M;
  }
  function corrFromCov(C) {
    return C.map((row, i) => row.map((v, j) => v / Math.sqrt(C[i][i] * C[j][j])));
  }
  function cholesky(A) {
    const n = A.length, L = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let attempt = 0; attempt < 6; attempt++) {
      const jitter = attempt === 0 ? 0 : 1e-10 * Math.pow(10, attempt) * Math.max(...A.map((r, i) => r[i]));
      let ok = true;
      for (let i = 0; i < n && ok; i++) for (let j = 0; j <= i; j++) {
        let s = A[i][j] + (i === j ? jitter : 0);
        for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
        if (i === j) { if (s <= 0) { ok = false; break; } L[i][j] = Math.sqrt(s); }
        else L[i][j] = s / L[j][j];
      }
      if (ok) return L;
    }
    throw new Error('Matrix is not positive definite');
  }
  const matVec = (M, v) => M.map(r => r.reduce((s, x, j) => s + x * v[j], 0));
  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
  const quad = (w, M) => dot(w, matVec(M, w));
  function projectSimplex(v, lo = 0) {
    // Euclidean projection onto {w >= lo, sum w = 1}
    const n = v.length, shifted = v.map(x => x - lo), target = 1 - n * lo;
    const u = [...shifted].sort((a, b) => b - a);
    let css = 0, rho = 0, theta = 0;
    for (let i = 0; i < n; i++) { css += u[i]; const t = (css - target) / (i + 1); if (u[i] - t > 0) { rho = i; theta = t; } }
    return shifted.map(x => Math.max(x - theta, 0) + lo);
  }
  function solveLinear(A, b) { // Gaussian elimination with partial pivoting
    const n = A.length, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      if (Math.abs(M[c][c]) < 1e-14) throw new Error('Singular matrix');
      for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
    return x;
  }
  function bisect(f, lo, hi, tol = 1e-8, maxIt = 200) {
    let flo = f(lo), fhi = f(hi);
    if (isNaN(flo) || isNaN(fhi) || flo * fhi > 0) return NaN;
    for (let i = 0; i < maxIt; i++) {
      const mid = (lo + hi) / 2, fm = f(mid);
      if (Math.abs(fm) < tol || (hi - lo) / 2 < tol) return mid;
      if (fm * flo < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
    }
    return (lo + hi) / 2;
  }

  // ---------- formatting ----------
  const isNum = x => typeof x === 'number' && isFinite(x);
  function decimalsFor(p) {
    const a = Math.abs(p);
    if (a === 0 || a >= 1000) return 2; if (a >= 10) return 2; if (a >= 1) return 3; if (a >= 0.1) return 4; return 5;
  }
  function fmt(x, d = 2) { return isNum(x) ? x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—'; }
  const fmtPx = (x, d) => isNum(x) ? fmt(x, d ?? decimalsFor(x)) : '—';
  const fmtPct = (x, d = 2, sign = true) => isNum(x) ? (sign && x > 0 ? '+' : '') + (x * 100).toFixed(d) + '%' : '—';
  const fmtSigned = (x, d = 2) => isNum(x) ? (x > 0 ? '+' : '') + fmt(x, d) : '—';
  function fmtBig(x, d = 2) {
    if (!isNum(x)) return '—';
    const a = Math.abs(x), s = x < 0 ? '-' : '';
    if (a >= 1e12) return s + (a / 1e12).toFixed(d) + 'T';
    if (a >= 1e9) return s + (a / 1e9).toFixed(d) + 'B';
    if (a >= 1e6) return s + (a / 1e6).toFixed(d) + 'M';
    if (a >= 1e3) return s + (a / 1e3).toFixed(d) + 'K';
    return s + a.toFixed(d);
  }
  const fmtX = (x, d = 1) => isNum(x) ? x.toFixed(d) + '×' : '—';
  const fmtBp = x => isNum(x) ? (x > 0 ? '+' : '') + (x * 1e4).toFixed(1) + 'bp' : '—';
  const cls = x => !isNum(x) || x === 0 ? 'flat' : x > 0 ? 'up' : 'down';
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const range = (n, f = i => i) => Array.from({ length: n }, (_, i) => f(i));
  const linspace = (a, b, n) => range(n, i => a + (b - a) * i / (n - 1));
  const last = a => a[a.length - 1];

  // ---------- dates ----------
  const DAY = 86400000;
  function isoDate(t) { const d = new Date(t); return d.toISOString().slice(0, 10); }
  function businessDaysBack(endDate, n) {
    const out = []; let d = new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate()));
    while (out.length < n) { const wd = d.getUTCDay(); if (wd !== 0 && wd !== 6) out.push(d.getTime()); d = new Date(d.getTime() - DAY); }
    return out.reverse();
  }
  function yearFrac(a, b) { return (b - a) / (365.25 * DAY); }

  // ---------- storage (per-viewer convenience only) ----------
  const store = {
    get(k, def) { try { const v = localStorage.getItem('agula:' + k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
    set(k, v) { try { localStorage.setItem('agula:' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem('agula:' + k); } catch (e) { /* ignore */ } },
  };

  return {
    mulberry32, hashStr, gaussFactory, rand, gauss, erf, ncdf, npdf, ninv,
    sum, mean, variance, std, quantile, cov, corr, skew, kurt, returns, maxDrawdown, drawdownSeries, histogram, linreg,
    covMatrix, corrFromCov, cholesky, matVec, dot, quad, projectSimplex, solveLinear, bisect,
    isNum, decimalsFor, fmt, fmtPx, fmtPct, fmtSigned, fmtBig, fmtX, fmtBp, cls, esc, clamp, range, linspace, last,
    DAY, isoDate, businessDaysBack, yearFrac, store,
  };
})();
