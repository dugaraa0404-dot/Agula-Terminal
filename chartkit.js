/* ============================================================================
   Agula Terminal — canvas chart kit (no dependencies)
   price charts with panes, zoom/pan and crosshair · line · bar · scatter ·
   heatmap · histogram · treemap · sparkline
   ========================================================================== */
'use strict';

const CK = (() => {
  let C = null;
  function colors() {
    if (C) return C;
    const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
    C = { bg: v('--panel'), text: v('--text'), muted: v('--muted'), dim: v('--dim'), grid: v('--grid'), line: v('--line'), up: v('--up'), down: v('--down'),
      accent: v('--accent'), key: v('--key'), warn: v('--warn'),
      series: [v('--accent'), v('--key'), v('--s3'), v('--s4'), v('--s5'), v('--s6'), v('--s7'), v('--s8')] };
    return C;
  }
  const MONO = '11px "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace';
  const MONO_S = '10px "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace';

  function setup(el) {
    const dpr = window.devicePixelRatio || 1, r = el.getBoundingClientRect();
    const w = Math.max(10, Math.floor(r.width)), h = Math.max(10, Math.floor(r.height));
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) { el.width = Math.round(w * dpr); el.height = Math.round(h * dpr); }
    const ctx = el.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    ctx.font = MONO; ctx.textBaseline = 'middle';
    return { ctx, w, h };
  }
  // re-draw on resize; keep the latest draw function per canvas
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(es => es.forEach(e => { const c = e.target._ckCanvas; if (c && c._ck && c._ck.draw && c.isConnected) c._ck.draw(); })) : null;
  function bind(el, draw) {
    el._ck = el._ck || {}; el._ck.draw = draw;
    if (ro && !el._ck.observed && el.parentElement) { el.parentElement._ckCanvas = el; ro.observe(el.parentElement); el._ck.observed = true; }
    draw();
  }
  function niceTicks(min, max, n = 6) {
    if (!isFinite(min) || !isFinite(max)) return [];
    if (min === max) { min -= 1; max += 1; }
    const span = max - min, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag, out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(+v.toPrecision(12));
    return out;
  }
  function tickFmt(v, span) { const a = Math.abs(span); return a >= 1000 ? U.fmt(v, 0) : a >= 10 ? U.fmt(v, 1) : a >= 1 ? U.fmt(v, 2) : a >= 0.05 ? U.fmt(v, 3) : U.fmt(v, 5); }
  function timeFmt(t, kind) {
    const d = new Date(t), m = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    if (kind === 'intra') return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' });
    if (kind === 'week') return m + " '" + String(d.getUTCFullYear()).slice(2);
    return m + ' ' + d.getUTCDate();
  }
  function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function label(ctx, txt, x, y, bg, fg, align = 'left') {
    ctx.font = MONO_S; const tw = ctx.measureText(txt).width + 8, bx = align === 'right' ? x - tw : align === 'center' ? x - tw / 2 : x;
    ctx.fillStyle = bg; roundRect(ctx, bx, y - 8, tw, 16, 2); ctx.fill(); ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.fillText(txt, bx + 4, y); ctx.font = MONO;
  }

  // =================================================================== price chart
  function price(el, opt) {
    el._ck = el._ck || {};
    const st = el._ck;
    if (!st.view || st.view.n !== opt.bars.length || st.view.key !== opt.key) {
      const n = opt.bars.length, show = Math.min(n, opt.initialBars || 160);
      st.view = { n, key: opt.key, end: n, start: Math.max(0, n - show) };
    } else if (st.view.end >= st.view.n - 1) { st.view.end = opt.bars.length; }
    st.opt = opt;
    if (!st.wired) {
      st.wired = true;
      el.addEventListener('mousemove', e => { const r = el.getBoundingClientRect(); st.hover = { x: e.clientX - r.left, y: e.clientY - r.top }; if (st.drag) { const dx = e.clientX - st.drag.x, per = st.drag.span / st.drag.w; const sh = Math.round(-dx * per); const span = st.drag.e - st.drag.s; let s = U.clamp(st.drag.s + sh, 0, st.opt.bars.length - span); st.view.start = s; st.view.end = s + span; } st.draw(); });
      el.addEventListener('mouseleave', () => { st.hover = null; st.drag = null; st.draw(); });
      el.addEventListener('mousedown', e => { st.drag = { x: e.clientX, s: st.view.start, e: st.view.end, span: st.view.end - st.view.start, w: el.getBoundingClientRect().width }; });
      window.addEventListener('mouseup', () => { st.drag = null; });
      el.addEventListener('wheel', e => {
        e.preventDefault(); const v = st.view, span = v.end - v.start, n = st.opt.bars.length;
        const ns = U.clamp(Math.round(span * (e.deltaY > 0 ? 1.15 : 0.87)), 20, n);
        const r = el.getBoundingClientRect(), frac = st.hover ? U.clamp(st.hover.x / (r.width - 64), 0, 1) : 1;
        const center = v.start + span * frac; let s = Math.round(center - ns * frac); s = U.clamp(s, 0, n - ns); v.start = s; v.end = s + ns; st.draw();
      }, { passive: false });
      el.addEventListener('dblclick', () => { const n = st.opt.bars.length; st.view.start = Math.max(0, n - (st.opt.initialBars || 160)); st.view.end = n; st.draw(); });
      el.addEventListener('click', e => { if (e.altKey && st.lastY && st.opt.onLevel) { const r = el.getBoundingClientRect(); st.opt.onLevel(st.lastY.inv(e.clientY - r.top)); } });
    }
    st.draw = () => drawPrice(el, st);
    bind(el, st.draw);
  }
  function drawPrice(el, st) {
    const { ctx, w, h } = setup(el), c = colors(), o = st.opt, v = st.view;
    const bars = o.bars.slice(v.start, v.end); if (!bars.length) return;
    const padR = 64, padT = 22, subH = o.sub ? Math.round(h * 0.24) : 0, gap = o.sub ? 10 : 0, mainH = h - padT - 20 - subH - gap;
    const plotW = w - padR - 6, n = bars.length, bw = plotW / n;
    const X = i => 6 + (i + 0.5) * bw;
    // y range (visible)
    let lo = Infinity, hi = -Infinity;
    const comp = o.compare && o.compare.length;
    const pctOf = (val, base) => (val / base - 1) * 100;
    if (comp) {
      const base0 = bars[0].c;
      bars.forEach(b => { const p = pctOf(b.c, base0); lo = Math.min(lo, p); hi = Math.max(hi, p); });
      o.compare.forEach(s => { const sl = s.data.slice(v.start, v.end), b0 = sl.find(x => x != null); sl.forEach(x => { if (x != null && b0) { const p = pctOf(x, b0); lo = Math.min(lo, p); hi = Math.max(hi, p); } }); });
    } else {
      bars.forEach(b => { lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); });
      (o.overlays || []).forEach(s => s.data.slice(v.start, v.end).forEach(x => { if (x != null) { lo = Math.min(lo, x); hi = Math.max(hi, x); } }));
      (o.levels || []).forEach(L => { if (L >= lo * 0.9 && L <= hi * 1.1) { lo = Math.min(lo, L); hi = Math.max(hi, L); } });
    }
    const pad = (hi - lo) * 0.06 || hi * 0.01 || 1; lo -= pad; hi += pad;
    const log = o.log && !comp && lo > 0;
    const fy = log ? x => Math.log(x) : x => x, ylo = fy(lo), yhi = fy(hi);
    const Y = x => padT + (1 - (fy(x) - ylo) / (yhi - ylo)) * mainH;
    st.lastY = { inv: py => { const f = 1 - (py - padT) / mainH, val = ylo + f * (yhi - ylo); return log ? Math.exp(val) : val; } };
    // grid + axis
    ctx.strokeStyle = c.grid; ctx.lineWidth = 1; ctx.fillStyle = c.muted; ctx.textAlign = 'left';
    niceTicks(lo, hi, Math.max(3, Math.floor(mainH / 46))).forEach(t => { const y = Math.round(Y(t)) + 0.5; if (y < padT || y > padT + mainH) return; ctx.beginPath(); ctx.moveTo(6, y); ctx.lineTo(6 + plotW, y); ctx.stroke(); ctx.fillText(comp ? (t > 0 ? '+' : '') + U.fmt(t, 1) + '%' : tickFmt(t, hi - lo), w - padR + 6, y); });
    const kind = o.tf === '1m' || o.tf === '5m' || o.tf === '1H' ? 'intra' : o.tf === '1W' ? 'week' : 'day';
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 90))));
    ctx.textAlign = 'center';
    for (let i = Math.floor(every / 2); i < n; i += every) { const x = Math.round(X(i)) + 0.5; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + mainH); ctx.stroke(); if (x > 30 && x < plotW - 20) ctx.fillText(timeFmt(bars[i].t, kind), x, h - 9); }
    // volume (bottom 18% of main pane)
    if (o.volume !== false && !comp) {
      const vmax = Math.max(...bars.map(b => b.v || 0)) || 1, vh = mainH * 0.18;
      bars.forEach((b, i) => { ctx.fillStyle = (b.c >= b.o ? c.up : c.down) + '33'; const hh = (b.v || 0) / vmax * vh; ctx.fillRect(X(i) - bw * 0.35, padT + mainH - hh, Math.max(1, bw * 0.7), hh); });
    }
    // bands
    (o.bands || []).forEach(bd => {
      const up = bd.up.slice(v.start, v.end), dn = bd.lo.slice(v.start, v.end);
      ctx.beginPath(); let started = false;
      up.forEach((x, i) => { if (x == null) return; started ? ctx.lineTo(X(i), Y(x)) : (ctx.moveTo(X(i), Y(x)), started = true); });
      for (let i = dn.length - 1; i >= 0; i--) if (dn[i] != null) ctx.lineTo(X(i), Y(dn[i]));
      ctx.closePath(); ctx.fillStyle = bd.color + '14'; ctx.fill();
      [up, dn].forEach(arr => { ctx.beginPath(); let s = false; arr.forEach((x, i) => { if (x == null) return; s ? ctx.lineTo(X(i), Y(x)) : (ctx.moveTo(X(i), Y(x)), s = true); }); ctx.strokeStyle = bd.color + '88'; ctx.lineWidth = 1; ctx.stroke(); });
    });
    // series
    if (comp) {
      const base0 = bars[0].c; const draw = (arr, col, wdt) => { ctx.beginPath(); let s = false, b0 = null; arr.forEach((x, i) => { if (x == null) return; if (b0 == null) b0 = x; const y = Y(pctOf(x, b0)); s ? ctx.lineTo(X(i), y) : (ctx.moveTo(X(i), y), s = true); }); ctx.strokeStyle = col; ctx.lineWidth = wdt; ctx.stroke(); };
      draw(bars.map(b => b.c), c.text, 1.8);
      o.compare.forEach((s, k) => draw(s.data.slice(v.start, v.end), s.color || c.series[k % 8], 1.4));
      const zy = Math.round(Y(0)) + 0.5; ctx.setLineDash([3, 3]); ctx.strokeStyle = c.dim; ctx.beginPath(); ctx.moveTo(6, zy); ctx.lineTo(6 + plotW, zy); ctx.stroke(); ctx.setLineDash([]);
    } else if (o.type === 'line' || o.type === 'area' || bw < 2.2) {
      ctx.beginPath(); bars.forEach((b, i) => i ? ctx.lineTo(X(i), Y(b.c)) : ctx.moveTo(X(i), Y(b.c)));
      const up = U.last(bars).c >= bars[0].c, col = o.type === 'area' || bw < 2.2 ? (up ? c.up : c.down) : c.accent;
      ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.stroke();
      if (o.type !== 'line') { ctx.lineTo(X(n - 1), padT + mainH); ctx.lineTo(X(0), padT + mainH); ctx.closePath(); const gr = ctx.createLinearGradient(0, padT, 0, padT + mainH); gr.addColorStop(0, col + '40'); gr.addColorStop(1, col + '00'); ctx.fillStyle = gr; ctx.fill(); }
    } else {
      bars.forEach((b, i) => {
        const up = b.c >= b.o, col = up ? c.up : c.down, x = X(i);
        ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, Y(b.h)); ctx.lineTo(Math.round(x) + 0.5, Y(b.l)); ctx.stroke();
        const y1 = Y(Math.max(b.o, b.c)), y2 = Y(Math.min(b.o, b.c)), bwid = Math.max(1, bw * 0.68);
        ctx.fillStyle = up ? c.bg : col; ctx.fillRect(x - bwid / 2, y1, bwid, Math.max(1, y2 - y1));
        if (up) { ctx.strokeRect(x - bwid / 2 + 0.5, y1 + 0.5, bwid - 1, Math.max(1, y2 - y1) - 1); }
      });
    }
    if (!comp) (o.overlays || []).forEach(s => {
      const arr = s.data.slice(v.start, v.end); ctx.beginPath(); let started = false;
      arr.forEach((x, i) => { if (x == null) { started = false; return; } if (s.dots) { ctx.moveTo(X(i) + 1.6, Y(x)); ctx.arc(X(i), Y(x), 1.6, 0, Math.PI * 2); return; } started ? ctx.lineTo(X(i), Y(x)) : (ctx.moveTo(X(i), Y(x)), started = true); });
      if (s.dots) { ctx.fillStyle = s.color; ctx.fill(); } else { ctx.setLineDash(s.dash || []); ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.2; ctx.stroke(); ctx.setLineDash([]); }
    });
    // levels
    if (!comp) (o.levels || []).forEach(L => { const y = Math.round(Y(L)) + 0.5; if (y < padT || y > padT + mainH) return; ctx.setLineDash([6, 4]); ctx.strokeStyle = c.key; ctx.beginPath(); ctx.moveTo(6, y); ctx.lineTo(6 + plotW, y); ctx.stroke(); ctx.setLineDash([]); label(ctx, U.fmtPx(L), w - padR + 2, y, c.key, '#111'); });
    // last price tag
    const lb = U.last(bars), lastY = comp ? Y(pctOf(lb.c, bars[0].c)) : Y(lb.c);
    if (v.end >= o.bars.length) { ctx.setLineDash([2, 3]); ctx.strokeStyle = (lb.c >= lb.o ? c.up : c.down) + 'aa'; ctx.beginPath(); ctx.moveTo(6, lastY); ctx.lineTo(6 + plotW, lastY); ctx.stroke(); ctx.setLineDash([]); label(ctx, comp ? U.fmtPct(lb.c / bars[0].c - 1, 2) : U.fmtPx(lb.c), w - padR + 2, lastY, lb.c >= lb.o ? c.up : c.down, '#06110c'); }
    // sub pane
    if (o.sub) {
      const top = padT + mainH + gap, sh = subH - 4, sd = o.sub;
      ctx.strokeStyle = c.line; ctx.beginPath(); ctx.moveTo(6, top - gap / 2); ctx.lineTo(6 + plotW, top - gap / 2); ctx.stroke();
      const ser = sd.series.map(s => ({ ...s, d: s.data.slice(v.start, v.end) }));
      let slo = sd.min ?? Infinity, shi = sd.max ?? -Infinity;
      if (sd.min == null) ser.forEach(s => s.d.forEach(x => { if (x != null) { slo = Math.min(slo, x); shi = Math.max(shi, x); } }));
      if (!isFinite(slo)) { slo = 0; shi = 1; } if (slo === shi) { slo -= 1; shi += 1; }
      const SY = x => top + (1 - (x - slo) / (shi - slo)) * sh;
      (sd.guides || []).forEach(gv => { ctx.setLineDash([3, 3]); ctx.strokeStyle = c.dim; const y = Math.round(SY(gv)) + 0.5; ctx.beginPath(); ctx.moveTo(6, y); ctx.lineTo(6 + plotW, y); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = c.muted; ctx.textAlign = 'left'; ctx.fillText(tickFmt(gv, shi - slo), w - padR + 6, y); });
      if (!sd.guides) [slo, shi].forEach(gv => { ctx.fillStyle = c.muted; ctx.textAlign = 'left'; ctx.fillText(U.fmtBig(gv, 1), w - padR + 6, SY(gv)); });
      ser.forEach(s => {
        if (s.type === 'hist') { const z = SY(Math.max(slo, Math.min(0, shi))); s.d.forEach((x, i) => { if (x == null) return; ctx.fillStyle = (x >= 0 ? c.up : c.down) + '99'; const y = SY(x); ctx.fillRect(X(i) - bw * 0.35, Math.min(y, z), Math.max(1, bw * 0.7), Math.abs(z - y)); }); return; }
        ctx.beginPath(); let started = false; s.d.forEach((x, i) => { if (x == null) { started = false; return; } started ? ctx.lineTo(X(i), SY(x)) : (ctx.moveTo(X(i), SY(x)), started = true); });
        ctx.strokeStyle = s.color; ctx.lineWidth = 1.2; ctx.stroke();
      });
      ctx.fillStyle = c.muted; ctx.textAlign = 'left'; ctx.font = MONO_S; ctx.fillText(sd.title + '  ' + ser.map(s => { const x = s.d[s.d.length - 1]; return x == null ? '' : U.fmt(x, Math.abs(x) >= 100 ? 0 : 2); }).filter(Boolean).join(' · '), 10, top + 8); ctx.font = MONO;
    }
    // crosshair + legend
    const hv = st.hover;
    let idx = n - 1;
    if (hv && hv.x < 6 + plotW) {
      idx = U.clamp(Math.floor((hv.x - 6) / bw), 0, n - 1);
      const x = Math.round(X(idx)) + 0.5;
      ctx.strokeStyle = c.muted + '88'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - 18); ctx.stroke();
      if (hv.y > padT && hv.y < padT + mainH) { ctx.beginPath(); ctx.moveTo(6, hv.y); ctx.lineTo(6 + plotW, hv.y); ctx.stroke(); ctx.setLineDash([]); const val = st.lastY.inv(hv.y); label(ctx, comp ? U.fmt(val, 2) + '%' : U.fmtPx(val), w - padR + 2, hv.y, c.text, c.bg); }
      ctx.setLineDash([]);
      label(ctx, new Date(bars[idx].t).toISOString().slice(0, kind === 'intra' ? 16 : 10).replace('T', ' '), x, h - 9, c.text, c.bg, 'center');
    }
    const b = bars[idx], chg = idx > 0 ? b.c / bars[idx - 1].c - 1 : null;
    ctx.font = MONO_S; ctx.textAlign = 'left'; let lx = 10;
    const seg = (t, col) => { ctx.fillStyle = col; ctx.fillText(t, lx, 10); lx += ctx.measureText(t).width + 10; };
    seg(o.title || '', c.key);
    seg('O ' + U.fmtPx(b.o), c.muted); seg('H ' + U.fmtPx(b.h), c.muted); seg('L ' + U.fmtPx(b.l), c.muted); seg('C ' + U.fmtPx(b.c), c.text);
    if (chg != null) seg(U.fmtPct(chg), chg >= 0 ? c.up : c.down);
    if (b.v) seg('V ' + U.fmtBig(b.v, 1), c.muted);
    (o.overlays || []).forEach(s => { if (!s.label) return; const x = s.data[v.start + idx]; if (x != null) seg(s.label + ' ' + U.fmtPx(x), s.color); });
    if (comp) o.compare.forEach((s, k) => seg(s.name, s.color || c.series[k % 8]));
    ctx.font = MONO;
  }

  // =================================================================== generic XY chart
  // Monotone cubic (Fritsch–Carlson) through pixel points: smooth, but never overshoots the data.
  function trace(ctx, P, smooth) {
    const n = P.length; if (!n) return;
    ctx.moveTo(P[0][0], P[0][1]);
    let mono = smooth && n > 2; for (let i = 1; mono && i < n; i++) if (!(P[i][0] > P[i - 1][0])) mono = false;
    if (!mono) { for (let i = 1; i < n; i++) ctx.lineTo(P[i][0], P[i][1]); return; }
    const d = [], m = new Array(n);
    for (let i = 0; i < n - 1; i++) d.push((P[i + 1][1] - P[i][1]) / (P[i + 1][0] - P[i][0]));
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], q = a * a + b * b;
      if (q > 9) { const t = 3 / Math.sqrt(q); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    for (let i = 0; i < n - 1; i++) { const h = P[i + 1][0] - P[i][0]; ctx.bezierCurveTo(P[i][0] + h / 3, P[i][1] + m[i] * h / 3, P[i + 1][0] - h / 3, P[i + 1][1] - m[i + 1] * h / 3, P[i + 1][0], P[i + 1][1]); }
  }
  function xy(el, opt) {
    el._ck = el._ck || {}; const st = el._ck; st.opt = opt;
    if (!st.wired) {
      st.wired = true;
      el.addEventListener('mousemove', e => { const r = el.getBoundingClientRect(); st.hover = { x: e.clientX - r.left, y: e.clientY - r.top }; st.draw(); });
      el.addEventListener('mouseleave', () => { st.hover = null; st.draw(); });
    }
    st.draw = () => drawXY(el, st); bind(el, st.draw);
  }
  function drawXY(el, st) {
    const { ctx, w, h } = setup(el), c = colors(), o = st.opt;
    const padL = o.padL ?? 58, padR = o.padR ?? 14, padT = o.legend === false ? 12 : 26, padB = 26;
    const pw = w - padL - padR, ph = h - padT - padB;
    const series = o.series.filter(s => s && s.data);
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    series.forEach(s => s.data.forEach(p => { if (p == null || p[1] == null || !isFinite(p[1]) || !isFinite(p[0])) return; xmin = Math.min(xmin, p[0]); xmax = Math.max(xmax, p[0]); ymin = Math.min(ymin, p[1]); ymax = Math.max(ymax, p[1]); }));
    (o.hlines || []).forEach(l => { if (isFinite(l.y)) { ymin = Math.min(ymin, l.y); ymax = Math.max(ymax, l.y); } });
    (o.marks || []).forEach(m => { if (isFinite(m.x) && isFinite(m.y)) { xmin = Math.min(xmin, m.x); xmax = Math.max(xmax, m.x); ymin = Math.min(ymin, m.y); ymax = Math.max(ymax, m.y); } });
    if (!isFinite(xmin) || !isFinite(ymin)) return;
    { const p = (ymax - ymin) * 0.08 || Math.abs(ymax) * 0.05 || 1; ymin -= p; ymax += p; if (o.zeroY && ymin > 0) ymin = 0; }
    if (o.xmin != null) xmin = o.xmin; if (o.xmax != null) xmax = o.xmax; if (o.ymin != null) ymin = o.ymin; if (o.ymax != null) ymax = o.ymax;
    if (xmax === xmin) { xmin -= 1; xmax += 1; }
    const X = x => padL + (x - xmin) / (xmax - xmin || 1) * pw, Y = y => padT + (1 - (y - ymin) / (ymax - ymin || 1)) * ph;
    ctx.strokeStyle = c.grid; ctx.fillStyle = c.muted; ctx.lineWidth = 1;
    niceTicks(ymin, ymax, Math.max(3, Math.floor(ph / 40))).forEach(t => { const y = Math.round(Y(t)) + 0.5; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + pw, y); ctx.stroke(); ctx.textAlign = 'right'; ctx.fillText((o.yFmt || (v => tickFmt(v, ymax - ymin)))(t), padL - 6, y); });
    const xt = o.xTicks || niceTicks(xmin, xmax, Math.max(3, Math.floor(pw / 80)));
    xt.forEach(t => { const x = Math.round(X(t)) + 0.5; if (x < padL - 1 || x > padL + pw + 1) return; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ph); ctx.stroke(); ctx.textAlign = 'center'; ctx.fillText((o.xFmt || (v => tickFmt(v, xmax - xmin)))(t), x, h - 10); });
    if (o.xLabel) { ctx.textAlign = 'right'; ctx.fillStyle = c.dim; ctx.fillText(o.xLabel, padL + pw, h - 22 + 12); }
    (o.vbands || []).forEach(b => { ctx.fillStyle = b.color; ctx.fillRect(X(b.x0), padT, X(b.x1) - X(b.x0), ph); });
    (o.hlines || []).forEach(l => { const y = Math.round(Y(l.y)) + 0.5; ctx.setLineDash(l.dash || [4, 4]); ctx.strokeStyle = l.color || c.dim; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + pw, y); ctx.stroke(); ctx.setLineDash([]); if (l.label) { ctx.fillStyle = l.color || c.muted; ctx.textAlign = 'left'; ctx.font = MONO_S; ctx.fillText(l.label, padL + 4, y - 7); ctx.font = MONO; } });
    (o.vlines || []).forEach(l => { const x = Math.round(X(l.x)) + 0.5; ctx.setLineDash(l.dash || [4, 4]); ctx.strokeStyle = l.color || c.dim; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + ph); ctx.stroke(); ctx.setLineDash([]); if (l.label) { ctx.fillStyle = l.color || c.muted; ctx.textAlign = 'left'; ctx.font = MONO_S; ctx.fillText(l.label, x + 4, padT + 8); ctx.font = MONO; } });
    series.forEach((s, k) => {
      const col = s.color || c.series[k % 8];
      if (s.type === 'scatter') { s.data.forEach(p => { if (p == null) return; ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1]), p[3] || s.r || 2.5, 0, Math.PI * 2); ctx.fillStyle = p[2] || col; ctx.globalAlpha = s.alpha ?? 1; ctx.fill(); ctx.globalAlpha = 1; if (p[4]) { ctx.fillStyle = c.text; ctx.textAlign = 'left'; ctx.font = MONO_S; ctx.fillText(p[4], X(p[0]) + 6, Y(p[1]) - 6); ctx.font = MONO; } }); return; }
      if (s.type === 'bar') { const bw = s.barW ? Math.max(2, s.barW * pw / (xmax - xmin)) : Math.max(2, pw / s.data.length * 0.7); const z = Y(Math.max(ymin, 0)); s.data.forEach(p => { if (p == null || p[1] == null) return; ctx.fillStyle = p[2] || (s.signColor ? (p[1] >= 0 ? c.up : c.down) : col); const y = Y(p[1]); ctx.fillRect(X(p[0]) - bw / 2, Math.min(y, z), bw, Math.abs(z - y)); }); return; }
      // split into unbroken segments of pixel points; smooth ones are drawn as monotone cubic curves
      const segs = []; let cur = [];
      s.data.forEach(p => { if (p == null || p[1] == null || !isFinite(p[1]) || !isFinite(p[0])) { if (cur.length) segs.push(cur); cur = []; return; } cur.push([X(p[0]), Y(p[1])]); });
      if (cur.length) segs.push(cur);
      const smooth = s.smooth ?? o.smooth;
      if (s.fill && segs.length) {
        const base = Y(s.fillBase != null ? s.fillBase : Math.max(ymin, Math.min(0, ymax)));
        const grad = ctx.createLinearGradient(0, padT, 0, padT + ph); grad.addColorStop(0, col + (s.fillAlpha || '44')); grad.addColorStop(1, col + '06');
        segs.forEach(seg => { ctx.beginPath(); trace(ctx, seg, smooth); ctx.lineTo(U.last(seg)[0], base); ctx.lineTo(seg[0][0], base); ctx.closePath(); ctx.fillStyle = s.solidFill ? col + '22' : grad; ctx.fill(); });
      }
      ctx.beginPath(); segs.forEach(seg => trace(ctx, seg, smooth));
      ctx.setLineDash(s.dash || []); ctx.strokeStyle = col; ctx.lineWidth = s.width || 1.6; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke(); ctx.setLineDash([]);
      if (s.points) s.data.forEach(p => { if (p && p[1] != null) { ctx.beginPath(); ctx.arc(X(p[0]), Y(p[1]), 2.6, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); } });
    });
    (o.marks || []).forEach(m => { ctx.beginPath(); ctx.arc(X(m.x), Y(m.y), m.r || 5, 0, Math.PI * 2); ctx.fillStyle = m.color; ctx.fill(); ctx.strokeStyle = c.bg; ctx.lineWidth = 1.5; ctx.stroke(); if (m.label) { ctx.fillStyle = m.color; ctx.textAlign = m.align || 'left'; ctx.font = MONO_S; ctx.fillText(m.label, X(m.x) + (m.align === 'right' ? -9 : 9), Y(m.y) - 9); ctx.font = MONO; } });
    // legend
    if (o.legend !== false) { let lx = padL; ctx.font = MONO_S; ctx.textAlign = 'left'; series.forEach((s, k) => { if (!s.name) return; const col = s.color || c.series[k % 8]; ctx.fillStyle = col; ctx.fillRect(lx, 9, 10, 3); ctx.fillStyle = c.muted; ctx.fillText(s.name, lx + 14, 11); lx += ctx.measureText(s.name).width + 30; }); ctx.font = MONO; }
    // hover readout
    const hv = st.hover;
    if (hv && hv.x >= padL && hv.x <= padL + pw && o.hover !== false) {
      const xv = xmin + (hv.x - padL) / pw * (xmax - xmin);
      ctx.strokeStyle = c.muted + '88'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(hv.x, padT); ctx.lineTo(hv.x, padT + ph); ctx.stroke(); ctx.setLineDash([]);
      const rows = [(o.xFmt || (v => tickFmt(v, xmax - xmin)))(xv)];
      series.forEach((s, k) => { if (s.type === 'scatter' || !s.name) return; let best = null; s.data.forEach(p => { if (p && p[1] != null && (best == null || Math.abs(p[0] - xv) < Math.abs(best[0] - xv))) best = p; }); if (best) { rows.push(s.name + ': ' + (o.yFmt || (v => tickFmt(v, ymax - ymin)))(best[1])); ctx.beginPath(); ctx.arc(X(best[0]), Y(best[1]), 3, 0, Math.PI * 2); ctx.fillStyle = s.color || c.series[k % 8]; ctx.fill(); } });
      ctx.font = MONO_S; const tw = Math.max(...rows.map(r => ctx.measureText(r).width)) + 12, th = rows.length * 14 + 8;
      const bx = hv.x + tw + 16 > w ? hv.x - tw - 10 : hv.x + 10, by = padT + 4;
      ctx.fillStyle = c.bg + 'ee'; ctx.strokeStyle = c.line; roundRect(ctx, bx, by, tw, th, 3); ctx.fill(); ctx.stroke();
      rows.forEach((r, i) => { ctx.fillStyle = i ? c.text : c.muted; ctx.textAlign = 'left'; ctx.fillText(r, bx + 6, by + 11 + i * 14); }); ctx.font = MONO;
    }
  }

  // =================================================================== categorical bars
  function bars(el, opt) {
    bind(el, () => {
      const { ctx, w, h } = setup(el), c = colors(), o = opt, hz = o.horizontal;
      const vals = o.values, n = vals.length; if (!n) return;
      const lo = Math.min(0, ...vals.filter(isFinite)), hi = Math.max(0, ...vals.filter(isFinite)) || 1;
      if (hz) {
        const padL = o.padL ?? 110, padN = lo < 0 ? 62 : 0, padR = hi > 0 ? 70 : 12, rowH = (h - 8) / n;   // room for value labels on both sides
        const X = v => padL + padN + (v - lo) / (hi - lo || 1) * (w - padL - padN - padR);
        vals.forEach((v, i) => {
          const y = 4 + i * rowH, bh = Math.min(18, rowH * 0.66), x0 = X(0), x1 = X(v);
          ctx.fillStyle = (o.colors && o.colors[i]) || (v >= 0 ? c.up : c.down); ctx.fillRect(Math.min(x0, x1), y + (rowH - bh) / 2, Math.max(1, Math.abs(x1 - x0)), bh);
          ctx.fillStyle = c.text; ctx.textAlign = 'right'; ctx.fillText(o.labels[i], padL - 8, y + rowH / 2);
          ctx.fillStyle = c.muted; ctx.textAlign = v >= 0 ? 'left' : 'right'; ctx.fillText((o.fmt || U.fmt)(v), x1 + (v >= 0 ? 6 : -6), y + rowH / 2);
        });
        ctx.strokeStyle = c.dim; ctx.beginPath(); ctx.moveTo(X(0) + 0.5, 0); ctx.lineTo(X(0) + 0.5, h); ctx.stroke();
      } else {
        const padB = 30, padT = 18, colW = (w - 20) / n;
        const Y = v => padT + (1 - (v - lo) / (hi - lo || 1)) * (h - padT - padB);
        vals.forEach((v, i) => {
          const x = 10 + i * colW, bw = Math.min(46, colW * 0.62), y0 = Y(0), y1 = Y(v);
          ctx.fillStyle = (o.colors && o.colors[i]) || (v >= 0 ? c.accent : c.down); ctx.fillRect(x + (colW - bw) / 2, Math.min(y0, y1), bw, Math.max(1, Math.abs(y1 - y0)));
          ctx.fillStyle = c.muted; ctx.textAlign = 'center'; ctx.fillText(o.labels[i], x + colW / 2, h - 12);
          ctx.fillStyle = c.text; ctx.font = MONO_S; ctx.fillText((o.fmt || U.fmt)(v), x + colW / 2, Math.min(y0, y1) - 8); ctx.font = MONO;
        });
      }
    });
  }

  // =================================================================== heatmap
  function heatmap(el, opt) {
    bind(el, () => {
      const { ctx, w, h } = setup(el), c = colors(), o = opt;
      const nr = o.rows.length, nc = o.cols.length, padL = o.padL ?? 64, padT = o.padT ?? 22;
      const cw = (w - padL - 4) / nc, ch = (h - padT - 4) / nr;
      for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) {
        const v = o.values[i][j]; ctx.fillStyle = o.color(v, i, j); ctx.fillRect(padL + j * cw + 1, padT + i * ch + 1, cw - 2, ch - 2);
        if (o.showValues !== false && cw > 34 && ch > 14) { ctx.fillStyle = o.textColor ? o.textColor(v) : c.text; ctx.textAlign = 'center'; ctx.font = cw > 52 ? MONO : MONO_S; ctx.fillText(o.fmt(v), padL + (j + 0.5) * cw, padT + (i + 0.5) * ch); ctx.font = MONO; }
        if (o.highlight && o.highlight(i, j)) { ctx.strokeStyle = c.key; ctx.lineWidth = 2; ctx.strokeRect(padL + j * cw + 1.5, padT + i * ch + 1.5, cw - 3, ch - 3); ctx.lineWidth = 1; }
      }
      ctx.fillStyle = c.muted; ctx.font = MONO_S;
      o.cols.forEach((t, j) => { ctx.textAlign = 'center'; ctx.fillText(t, padL + (j + 0.5) * cw, padT - 10); });
      o.rows.forEach((t, i) => { ctx.textAlign = 'right'; ctx.fillText(t, padL - 6, padT + (i + 0.5) * ch); });
      if (o.cornerLabel) { ctx.textAlign = 'left'; ctx.fillStyle = c.dim; ctx.fillText(o.cornerLabel, 2, 10); }
      ctx.font = MONO;
    });
  }
  function divergingColor(v, scale, alpha = 1) {
    const c = colors(); if (v == null || !isFinite(v)) return c.grid;
    const t = U.clamp(Math.abs(v) / scale, 0, 1), base = v >= 0 ? hex(c.up) : hex(c.down), bg = hex(c.bg);
    const mix = bg.map((b, i) => Math.round(b + (base[i] - b) * (0.12 + 0.78 * t)));
    return `rgba(${mix[0]},${mix[1]},${mix[2]},${alpha})`;
  }
  function seqColor(t) { const c = colors(), a = hex(c.bg), b = hex(c.accent), k = U.clamp(t, 0, 1); return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * (0.1 + 0.85 * k))).join(',')})`; }
  function hex(s) { s = s.replace('#', ''); if (s.length === 3) s = s.split('').map(x => x + x).join(''); return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16)); }

  // =================================================================== histogram
  function hist(el, opt) {
    const hgm = U.histogram(opt.values, opt.bins || 50, opt.lo, opt.hi);
    const data = hgm.counts.map((n, i) => [(hgm.edges[i] + hgm.edges[i + 1]) / 2, n, opt.colorFn ? opt.colorFn((hgm.edges[i] + hgm.edges[i + 1]) / 2) : null]);
    xy(el, { series: [{ type: 'bar', data, color: opt.color }], vlines: opt.vlines, xFmt: opt.xFmt, yFmt: v => U.fmt(v, 0), legend: false, hover: false, zeroY: true, ymin: 0, padL: 44 });
  }

  // =================================================================== treemap (squarified)
  function treemap(el, items, opt = {}) {
    bind(el, () => {
      const { ctx, w, h } = setup(el), c = colors();
      const total = U.sum(items.map(i => i.value)); if (!total) return;
      const rects = [];
      (function layout(list, x, y, W, H) {
        if (!list.length) return;
        if (list.length === 1) { rects.push({ ...list[0], x, y, w: W, h: H }); return; }
        const sumV = U.sum(list.map(i => i.value)); let acc = 0, k = 0;
        while (k < list.length - 1 && acc + list[k].value < sumV / 2) acc += list[k++].value;
        if (k === 0) { acc = list[0].value; k = 1; }
        const f = acc / sumV;
        if (W >= H) { layout(list.slice(0, k), x, y, W * f, H); layout(list.slice(k), x + W * f, y, W * (1 - f), H); }
        else { layout(list.slice(0, k), x, y, W, H * f); layout(list.slice(k), x, y + H * f, W, H * (1 - f)); }
      })([...items].sort((a, b) => b.value - a.value), 0, 0, w, h);
      rects.forEach(r => {
        ctx.fillStyle = divergingColor(r.chg, opt.scale || 0.03); ctx.fillRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
        if (r.w > 40 && r.h > 24) { ctx.fillStyle = c.text; ctx.textAlign = 'center'; ctx.font = '600 ' + (r.w > 110 && r.h > 50 ? 13 : 11) + 'px "IBM Plex Sans Condensed", sans-serif'; ctx.fillText(r.label, r.x + r.w / 2, r.y + r.h / 2 - 7); ctx.font = MONO_S; ctx.fillText(U.fmtPct(r.chg), r.x + r.w / 2, r.y + r.h / 2 + 8); ctx.font = MONO; }
      });
      el._ck.rects = rects;
      if (!el._ck.tmWired && opt.onClick) { el._ck.tmWired = true; el.addEventListener('click', e => { const b = el.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top; const hit = (el._ck.rects || []).find(r => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h); if (hit) opt.onClick(hit); }); el.style.cursor = 'pointer'; }
    });
  }

  // =================================================================== sparkline
  function spark(el, data, up) {
    const { ctx, w, h } = setup(el), c = colors(); if (!data || data.length < 2) return;
    const lo = Math.min(...data), hi = Math.max(...data), col = up == null ? (U.last(data) >= data[0] ? c.up : c.down) : up ? c.up : c.down;
    ctx.beginPath(); data.forEach((v, i) => { const x = i / (data.length - 1) * (w - 2) + 1, y = 2 + (1 - (v - lo) / (hi - lo || 1)) * (h - 4); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.lineTo(w - 1, h); ctx.lineTo(1, h); ctx.closePath(); ctx.fillStyle = col + '1f'; ctx.fill();
  }


  // =================================================================== waterfall (EV -> equity bridge)
  function waterfall(el, steps, fmt = v => U.fmtBig(v, 1)) {
    bind(el, () => {
      const { ctx, w, h } = setup(el), c = colors(); let run = 0; const segs = [];
      steps.filter(s => s.total || Math.abs(s.value) > 1e-9).forEach(s => { if (s.total) { segs.push({ ...s, a: 0, b: s.value }); run = s.value; } else { segs.push({ ...s, a: run, b: run + s.value }); run += s.value; } });
      const lo = Math.min(0, ...segs.map(s => Math.min(s.a, s.b))), hi = Math.max(...segs.map(s => Math.max(s.a, s.b)));
      const padT = 18, padB = 30, colW = (w - 16) / segs.length, Y = v => padT + (1 - (v - lo) / (hi - lo || 1)) * (h - padT - padB);
      segs.forEach((s, i) => {
        const x = 8 + i * colW, bw = Math.min(64, colW * 0.6), y1 = Y(Math.max(s.a, s.b)), y2 = Y(Math.min(s.a, s.b));
        ctx.fillStyle = s.total ? c.accent : s.value >= 0 ? c.up : c.down; ctx.fillRect(x + (colW - bw) / 2, y1, bw, Math.max(1, y2 - y1));
        if (i < segs.length - 1) { ctx.strokeStyle = c.dim; ctx.setLineDash([2, 2]); ctx.beginPath(); ctx.moveTo(x + (colW + bw) / 2, Y(s.b)); ctx.lineTo(x + colW + (colW - bw) / 2, Y(s.b)); ctx.stroke(); ctx.setLineDash([]); }
        ctx.fillStyle = c.muted; ctx.textAlign = 'center'; ctx.font = MONO_S; ctx.fillText(s.label, x + colW / 2, h - 12);
        ctx.fillStyle = c.text; ctx.fillText(fmt(s.value), x + colW / 2, y1 - 8); ctx.font = MONO;
      });
    });
  }
  // =================================================================== football field
  function football(el, rows, price, fmt = v => U.fmtPx(v)) {
    bind(el, () => {
      const { ctx, w, h } = setup(el), c = colors(); const vals = rows.flatMap(r => [r.lo, r.hi]).concat(price ? [price] : []).filter(isFinite);
      if (!vals.length) return;
      let lo = Math.min(...vals), hi = Math.max(...vals); const p = (hi - lo) * 0.08 || 1; lo -= p; hi += p;
      ctx.font = '12px "IBM Plex Sans Condensed", sans-serif'; const padL = Math.min(w * 0.45, Math.max(...rows.map(r => ctx.measureText(r.label).width)) + 22); ctx.font = MONO;
      const padR = 48, padT = 8, padB = 26, rowH = (h - padT - padB) / rows.length, X = v => padL + (v - lo) / (hi - lo) * (w - padL - padR);
      ctx.strokeStyle = c.grid; ctx.fillStyle = c.muted; niceTicks(lo, hi, 6).forEach(t => { const x = Math.round(X(t)) + 0.5; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke(); ctx.textAlign = 'center'; ctx.fillText(fmt(t), x, h - 10); });
      rows.forEach((r, i) => {
        const y = padT + i * rowH, bh = Math.min(20, rowH * 0.56);
        ctx.fillStyle = c.text; ctx.textAlign = 'right'; ctx.font = '12px "IBM Plex Sans Condensed", sans-serif'; ctx.fillText(r.label, padL - 10, y + rowH / 2); ctx.font = MONO;
        if (!isFinite(r.lo) || !isFinite(r.hi)) { ctx.fillStyle = c.dim; ctx.textAlign = 'left'; ctx.fillText('n/a', padL + 4, y + rowH / 2); return; }
        ctx.fillStyle = (r.color || c.accent) + 'cc'; ctx.fillRect(X(r.lo), y + (rowH - bh) / 2, Math.max(2, X(r.hi) - X(r.lo)), bh);
        if (isFinite(r.mid)) { ctx.fillStyle = c.text; ctx.fillRect(X(r.mid) - 1, y + (rowH - bh) / 2 - 2, 2, bh + 4); }
        ctx.font = MONO_S; ctx.fillStyle = c.muted; ctx.textAlign = 'right'; ctx.fillText(fmt(r.lo), X(r.lo) - 4, y + rowH / 2); ctx.textAlign = 'left'; ctx.fillText(fmt(r.hi), X(r.hi) + 4, y + rowH / 2); ctx.font = MONO;
      });
      if (price) { const x = Math.round(X(price)) + 0.5; ctx.strokeStyle = c.key; ctx.setLineDash([5, 3]); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, h - padB); ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1; label(ctx, 'Price ' + fmt(price), x, padT + 6, c.key, '#111', 'center'); }
    });
  }

  return { price, xy, bars, heatmap, hist, treemap, spark, waterfall, football, divergingColor, seqColor, colors, niceTicks, resetColors: () => { C = null; } };
})();
