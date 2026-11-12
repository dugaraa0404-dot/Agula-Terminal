/* ============================================================================
   Agula Terminal — YAS: Yield & Spread Analysis (bond calculator)
   price ↔ yield, yield to call / worst, Macaulay / modified / effective duration,
   convexity, DV01, G- and Z-spread to the Treasury curve, key-rate durations,
   rate-shock scenarios, horizon total return and breakeven, a bond portfolio,
   and a plain-language interpretation of the results.
   ========================================================================== */
'use strict';

(() => {
  const { panel, kv, $, $$ } = APP;
  const esc = U.esc;
  const DAY = 864e5;

  // ---------------------------------------------------------------- bond engine
  function addMonths(d, months, day) {
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + months, first = new Date(Date.UTC(y, m, 1));
    const dim = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
    return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, dim)));
  }
  function days360(a, b) {
    let d1 = Math.min(a.getUTCDate(), 30), d2 = b.getUTCDate(); if (d1 === 30 && d2 === 31) d2 = 30;
    return (b.getUTCFullYear() - a.getUTCFullYear()) * 360 + (b.getUTCMonth() - a.getUTCMonth()) * 30 + (d2 - d1);
  }
  // fraction of the current coupon period that has accrued, by day-count convention
  function accrualFrac(prev, settle, next, conv, f) {
    if (conv === '30/360') return days360(prev, settle) / (360 / f);
    if (conv === 'ACT/360') return (settle - prev) / DAY / (360 / f);
    if (conv === 'ACT/365') return (settle - prev) / DAY / (365 / f);
    return (settle - prev) / (next - prev);                                    // ACT/ACT (ICMA)
  }
  /** Cash flows after `settle` to `end` (maturity or a call date), redeeming at `redemption`. */
  function flowsTo({ coupon, freq, settle, end, conv, redemption = 100, face = 100 }) {
    if (!freq) {                                                                 // zero coupon: one flow, semi-annual compounding
      const k = (end - settle) / DAY / 365.25 * 2;
      return { flows: [{ date: end, k, cf: redemption, t: (end - settle) / DAY / 365.25 }], accrued: 0, w: 0, prev: settle, next: end, f: 2, nCpn: 0 };
    }
    const months = 12 / freq, day = end.getUTCDate(), dates = [];
    let n = 0, d = end;
    while (d > settle) { dates.unshift(d); n++; d = addMonths(end, -months * n, day); }
    const prev = d, next = dates[0], w = U.clamp(accrualFrac(prev, settle, next, conv, freq), 0, 1), cpn = face * coupon / freq;
    const flows = dates.map((dt, i) => ({ date: dt, k: i + 1 - w, cf: cpn + (i === dates.length - 1 ? redemption : 0), t: (dt - settle) / DAY / 365.25 }));
    return { flows, accrued: cpn * w, w, prev, next, f: freq, nCpn: dates.length };
  }
  const pvAt = (fl, f, y) => fl.reduce((s, x) => s + x.cf / Math.pow(1 + y / f, x.k), 0);
  const yieldFrom = (fl, f, dirty) => U.bisect(y => pvAt(fl, f, y) - dirty, -0.2, 3, 1e-13);
  function measures(fl, f, y, dirty) {
    let mac = 0, cx = 0;
    fl.forEach(x => { const df = Math.pow(1 + y / f, -x.k); x.pv = x.cf * df; mac += (x.k / f) * x.pv; cx += x.cf * x.k * (x.k + 1) / (f * f) * Math.pow(1 + y / f, -x.k - 2); });
    mac /= dirty; cx /= dirty;
    const mod = mac / (1 + y / f), h = 0.0025, up = pvAt(fl, f, y + h), dn = pvAt(fl, f, y - h);
    return { mac, mod, cx, effDur: (dn - up) / (2 * dirty * h), effCx: (dn + up - 2 * dirty) / (dirty * h * h), dv01: (pvAt(fl, f, y - 1e-4) - pvAt(fl, f, y + 1e-4)) / 2 };
  }
  function analyze(s, curve) {
    const base = flowsTo({ ...s, end: s.maturity });
    const f = base.f, fl = base.flows;
    const T = (s.maturity - s.settle) / DAY / 365.25;
    let y, dirty;
    if (s.mode === 'yield') { y = s.value / 100; dirty = pvAt(fl, f, y); }
    else if (s.mode === 'price') { dirty = s.value + base.accrued; y = yieldFrom(fl, f, dirty); }
    else {                                                                        // spread over the Treasury zero curve
      if (!curve) throw new Error('The Treasury curve is not loaded yet, so a spread can\'t be priced. Use yield or price.');
      dirty = fl.reduce((a, x) => a + x.cf * Math.exp(-(curve.zero(x.t) + s.value / 1e4) * x.t), 0); y = yieldFrom(fl, f, dirty);
    }
    if (!isFinite(y) || !isFinite(dirty)) throw new Error('No yield matches that price. Check the inputs.');
    const clean = dirty - base.accrued, m = measures(fl, f, y, dirty);
    const out = { ...m, y, dirty, clean, accrued: base.accrued, w: base.w, prev: base.prev, next: base.next, flows: fl, f, T, nCpn: base.nCpn,
      currentYield: s.freq ? s.coupon * 100 / clean : null, accruedDays: Math.round((s.settle - base.prev) / DAY) };
    // call: yield to call, yield to worst
    if (s.callDate && s.callDate > s.settle && s.callDate < s.maturity) {
      const c = flowsTo({ ...s, end: s.callDate, redemption: s.callPrice || 100 });
      const ytc = yieldFrom(c.flows, c.f, dirty), cm = measures(c.flows, c.f, ytc, dirty);
      out.call = { ytc, ...cm, date: s.callDate, price: s.callPrice || 100 };
      out.worst = ytc < y ? 'call' : 'maturity'; out.ytw = Math.min(ytc, y);
    } else { out.worst = 'maturity'; out.ytw = y; }
    // spreads and key rates against the Treasury curve
    if (curve) {
      out.tsy = Q.parYield(curve.zero, T, s.freq || 2); out.g = y - out.tsy;
      out.z = U.bisect(z => fl.reduce((a, x) => a + x.cf * Math.exp(-(curve.zero(x.t) + z) * x.t), 0) - dirty, -0.2, 2, 1e-12);
      out.krd = Q.keyRateDurations(fl.map(x => ({ ...x, tYears: x.t, cf: x.cf * Math.exp(-out.z * x.t) })), curve.zero);
    }
    return out;
  }
  /** Total return over `months` if the yield moves by `dy` now and the bond is held; coupons reinvested at the new yield. */
  function horizon(s, a, months, dy) {
    const hz = new Date(s.settle.getTime() + months * 30.4375 * DAY);
    const y1 = a.y + dy, ff = a.f;
    let carry = 0;
    a.flows.filter(x => x.date <= hz).forEach(x => { carry += x.cf * Math.pow(1 + y1 / ff, (hz - x.date) / DAY / 365.25 * ff); });
    let pH = 0;
    if (hz < s.maturity) { const r = flowsTo({ ...s, settle: hz, end: s.maturity }); pH = pvAt(r.flows, r.f, y1); }
    return (pH + carry) / a.dirty - 1;
  }
  const priceAt = (s, a, dy) => pvAt(a.flows, a.f, a.y + dy) - a.accrued;

  // ---------------------------------------------------------------- Treasury curve (shared with CURVE)
  let curveP = null;
  function treasury() {
    if (!curveP) curveP = HUB.curve().then(d => {
      const fit = Q.fitNSS(d.now.map(x => x[0]), d.now.map(x => x[1]));
      const dense = U.range(60, i => (i + 1) / 2).map(t => [t, Q.nss(fit.p, t)]), z = Q.bootstrapPar(dense.map(x => x[0]), dense.map(x => x[1]));
      return { zero: z.fn, par: t => Q.nss(fit.p, t), date: d.date, source: d.source, now: d.now };
    }).catch(e => { curveP = null; throw e; });
    return curveP;
  }

  // ---------------------------------------------------------------- presets (generic, not real issues)
  const iso = d => d.toISOString().slice(0, 10);
  const yearsOut = n => { const t = new Date(); return new Date(Date.UTC(t.getUTCFullYear() + n, t.getUTCMonth(), 15)); };
  function presets(c) {
    const par = n => c ? Math.max(0.125, Math.floor(c.par(n) * 800) / 8) : 4.25;     // coupon rounded down to 1/8 like a new Treasury
    return {
      UST2: { label: 'US Treasury 2-year (generic new issue)', coupon: par(2), years: 2, freq: 2, conv: 'ACT/ACT', mode: 'spread', value: 0 },
      UST5: { label: 'US Treasury 5-year (generic)', coupon: par(5), years: 5, freq: 2, conv: 'ACT/ACT', mode: 'spread', value: 0 },
      UST10: { label: 'US Treasury 10-year (generic)', coupon: par(10), years: 10, freq: 2, conv: 'ACT/ACT', mode: 'spread', value: 0 },
      UST30: { label: 'US Treasury 30-year (generic)', coupon: par(30), years: 30, freq: 2, conv: 'ACT/ACT', mode: 'spread', value: 0 },
      IG5: { label: 'Investment-grade corporate, 5y, +95bp', coupon: 5.0, years: 5, freq: 2, conv: '30/360', mode: 'spread', value: 95 },
      HY7: { label: 'High-yield corporate, 7y, +325bp', coupon: 7.5, years: 7, freq: 2, conv: '30/360', mode: 'spread', value: 325 },
      CALL: { label: 'Callable 10-non-call-3, 6% coupon', coupon: 6.0, years: 10, freq: 2, conv: '30/360', mode: 'yield', value: 5.25, callYears: 3, callPrice: 100 },
      ZERO: { label: 'Zero-coupon 20-year (STRIP)', coupon: 0, years: 20, freq: 0, conv: 'ACT/ACT', mode: 'spread', value: 0 },
    };
  }
  const nextBusinessDay = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); do { d.setUTCDate(d.getUTCDate() + 1); } while ([0, 6].includes(d.getUTCDay())); return d; };

  // ---------------------------------------------------------------- interpretation
  function riskBand(d) { return d < 3 ? ['LOW', 'up', 'short bonds barely move with rates'] : d < 7 ? ['MODERATE', 'key', 'a typical intermediate bond'] : d < 12 ? ['HIGH', 'down', 'long bonds swing hard with rates'] : ['VERY HIGH', 'down', 'very long or zero-coupon: equity-like rate risk']; }
  function interpret(s, a, H) {
    const pos = s.notional / 100, mv = a.dirty * pos, money = v => (v <= -0.5 ? '−$' : '$') + U.fmt(Math.abs(v), 0);
    const up100 = (priceAt(s, a, 0.01) - a.clean) * pos, dn100 = (priceAt(s, a, -0.01) - a.clean) * pos;
    const [band, bcls, bdesc] = riskBand(a.mod);
    const L = [];
    L.push(`<b>Price.</b> At a ${U.fmt(a.y * 100, 3)}% yield the bond is worth <b>${U.fmt(a.clean, 3)}</b> per 100 (clean), plus ${U.fmt(a.accrued, 3)} of accrued interest${a.accruedDays ? ` for ${a.accruedDays} days since the last coupon` : ''}: you'd pay ${U.fmt(a.dirty, 3)}, or ${money(mv)} for ${money(s.notional)} face. ` +
      (s.freq && Math.abs(a.clean - 100) > 0.05 ? (a.clean > 100 ? `It trades at a <b>premium</b> because its ${U.fmt(s.coupon * 100, 3)}% coupon is above today's yield; the price drifts down toward 100 as it ages ("pull to par").` : `It trades at a <b>discount</b> because its ${U.fmt(s.coupon * 100, 3)}% coupon is below today's yield; part of the return comes from the price rising toward 100 by maturity.`) : !s.freq ? 'A zero-coupon bond pays nothing until maturity, so all of its return is the climb from today\'s price to 100.' : 'It trades close to par because its coupon is close to today\'s yield.'));
    L.push(`<b>Duration.</b> Macaulay duration is <b>${U.fmt(a.mac, 2)} years</b>: the present-value-weighted average time until you get your money back (the balance point in the picture). Modified duration of <b>${U.fmt(a.mod, 2)}</b> means a 1-percentage-point rise in yield cuts the price by about ${U.fmt(a.mod, 1)}%. Interest-rate risk: <b class="${bcls}">${band}</b> (${bdesc}).`);
    L.push(`<b>DV01.</b> Each 1bp (0.01%) move in yield changes the price by ${U.fmt(a.dv01, 4)} per 100, which is <b>${money(a.dv01 * pos)}</b> on your position. A +100bp move ≈ <span class="down">${money(up100)}</span>; −100bp ≈ <span class="up">+${money(dn100)}</span>.`);
    L.push(`<b>Convexity.</b> Convexity of ${U.fmt(a.cx, 1)} bends the price–yield line upward: price gains when yields fall (${money(dn100)}) are larger than losses when they rise (${money(Math.abs(up100))}) by ${money(dn100 + up100)}. Duration alone ${a.cx > 50 ? 'noticeably' : 'slightly'} misjudges big moves; the scenario table shows how much.`);
    if (a.g != null) L.push(`<b>Spread.</b> The bond yields <b>${U.fmt(a.g * 1e4, 0)}bp</b> over the Treasury curve at its maturity (G-spread) and <b>${U.fmt(a.z * 1e4, 0)}bp</b> over every point of the zero curve (Z-spread). ${Math.abs(a.g) < 0.0015 ? 'That is Treasury-like: almost all of the return is the risk-free rate.' : a.g < 0.02 ? 'That is investment-grade territory: the extra yield pays for modest credit and liquidity risk.' : 'That is a high-yield spread: the extra yield is compensation for a real chance of default or a forced sale at a loss.'}`);
    if (a.call) L.push(`<b>Call.</b> The issuer can repay at ${U.fmt(a.call.price, 2)} on ${iso(a.call.date)}. Yield to call is ${U.fmt(a.call.ytc * 100, 3)}% vs ${U.fmt(a.y * 100, 3)}% to maturity, so yield to <b>worst</b> is the ${a.worst} yield (${U.fmt(a.ytw * 100, 3)}%). ${a.worst === 'call' ? 'Expect the bond to be called if rates stay here: its effective duration is closer to the ' + U.fmt(a.call.mod, 1) + ' of the call date, and its upside when yields fall is capped (negative convexity).' : 'At this price a call is unlikely to hurt you; the maturity yield is the conservative one.'}`);
    const be = U.bisect(d => horizon(s, a, H, d), -0.2, 0.5, 1e-9), carry = horizon(s, a, H, 0);
    L.push(`<b>Holding for ${H} months.</b> If yields don't change, the bond returns about <b>${U.fmtPct(carry, 2)}</b> from coupons and pull to par. Yields can rise by about <b>${isFinite(be) ? U.fmt(be * 1e4, 0) + 'bp' : 'n/a'}</b> before that income is wiped out (the breakeven). ${isFinite(be) && be * 1e4 < 50 ? 'That cushion is thin: a modest sell-off in bonds would mean a loss.' : 'That is a reasonable cushion against a sell-off.'}`);
    return { html: L.map(x => `<p>${x}</p>`).join(''), be, carry, band, bcls };
  }

  // ---------------------------------------------------------------- the "balance point" illustration (Macaulay duration)
  function fulcrum(a) {
    // each payment is a weight (circle area = present value) on a beam; the beam balances at the Macaulay duration
    const W = 900, H = 210, padL = 40, padR = 56, beamY = 128, T = Math.max(a.T, 0.5), x = t => padL + t / T * (W - padL - padR);
    const mx = Math.max(...a.flows.map(f => f.pv)), R = 46, rOf = pv => Math.max(2.5, Math.sqrt(pv / mx) * R);
    const w = a.flows.map(f => { const r = rOf(f.pv), cx = x(f.t); return `<g><line x1="${cx.toFixed(1)}" y1="${beamY}" x2="${cx.toFixed(1)}" y2="${(beamY - 4).toFixed(1)}" class="peg"/><circle cx="${cx.toFixed(1)}" cy="${(beamY - 4 - r).toFixed(1)}" r="${r.toFixed(1)}" class="${f.cf > 50 ? 'pr' : 'cp'}"><title>${iso(f.date)} · pays ${U.fmt(f.cf, 3)} · worth ${U.fmt(f.pv, 3)} today (${U.fmtPct(f.pv / a.dirty, 1, false)} of the price)</title></circle></g>`; }).join('');
    const step = T > 20 ? 5 : T > 10 ? 2 : T > 3 ? 1 : 0.5, ticks = U.range(Math.floor(T / step) + 1, i => i * step).map(t => `<text x="${x(t).toFixed(1)}" y="${beamY + 46}" class="tk">${step < 1 ? t.toFixed(1) : t}y</text>`).join('');
    const dx = x(a.mac), right = dx > W * 0.62;
    return `<svg viewBox="0 0 ${W} ${H}" class="fulcrum" role="img" aria-label="Payments drawn as weights on a beam that balances at the Macaulay duration">
      <line x1="${padL - 10}" y1="${beamY}" x2="${W - padR + 10}" y2="${beamY}" class="beam"/>${w}
      <path d="M${dx.toFixed(1)} ${beamY + 2} l-13 24 h26z" class="fp"/><line x1="${padL - 10}" y1="${beamY + 27}" x2="${W - padR + 10}" y2="${beamY + 27}" class="ground"/>
      <line x1="${dx.toFixed(1)}" y1="22" x2="${dx.toFixed(1)}" y2="${beamY}" class="dl"/>
      <text x="${(dx + (right ? -8 : 8)).toFixed(1)}" y="30" class="dlab" text-anchor="${right ? 'end' : 'start'}">balance point = Macaulay duration ${U.fmt(a.mac, 2)} years</text>
      ${ticks}<circle cx="${padL - 4}" cy="${H - 8}" r="5" class="cp"/><text x="${padL + 6}" y="${H - 4}" class="lg">coupon</text><circle cx="${padL + 76}" cy="${H - 8}" r="5" class="pr"/><text x="${padL + 86}" y="${H - 4}" class="lg">principal + last coupon · circle area = what the payment is worth today</text></svg>`;
  }

  // ---------------------------------------------------------------- screen
  APP.register('YAS', {
    title: 'Yield & Spread Analysis · bond duration calculator', global: true,
    async render(root) {
      try { this.curve = await treasury(); } catch (e) { this.curve = null; }
      const P = presets(this.curve), st = U.store.get('yas', null) || this.fromPreset(P.UST10);
      this.st = st;
      root.innerHTML = `<div class="toolbar"><select id="yPre" aria-label="Preset bonds"><option value="">Load a preset bond…</option>${Object.entries(P).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('')}</select>
          <span class="muted small" id="yCurve">${this.curve ? `Treasury curve: ${esc(this.curve.source)}, ${esc(this.curve.date)}` : 'Treasury curve unavailable: spreads and key rates are off.'}</span></div>
        <div class="grid yasgrid">
          <div class="stack">${panel('Bond', `<div class="fields" id="yIn">
              <div class="field"><label>Coupon % a year</label><input class="num" data-k="coupon" type="number" step="0.125" min="0" value="${st.coupon}"></div>
              <div class="field"><label>Coupons a year</label><select data-k="freq">${[[2, 'Semi-annual'], [1, 'Annual'], [4, 'Quarterly'], [12, 'Monthly'], [0, 'Zero coupon']].map(([v, l]) => `<option value="${v}" ${+st.freq === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
              <div class="field"><label>Settlement</label><input class="txt" data-k="settle" type="date" value="${st.settle}"></div>
              <div class="field"><label>Maturity</label><input class="txt" data-k="maturity" type="date" value="${st.maturity}"></div>
              <div class="field"><label>Day count</label><select data-k="conv">${['ACT/ACT', '30/360', 'ACT/360', 'ACT/365'].map(c => `<option ${st.conv === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
              <div class="field"><label>Position (face amount)</label><div class="inwrap"><input class="num" data-k="notional" type="number" step="10000" min="0" value="${st.notional}"><em>$</em></div></div>
              <div class="field"><label>Solve from</label><select data-k="mode"><option value="yield" ${st.mode === 'yield' ? 'selected' : ''}>Yield to maturity</option><option value="price" ${st.mode === 'price' ? 'selected' : ''}>Clean price</option><option value="spread" ${st.mode === 'spread' ? 'selected' : ''} ${this.curve ? '' : 'disabled'}>Spread to Treasury curve</option></select></div>
              <div class="field"><label id="yValL">${{ yield: 'Yield %', price: 'Clean price (per 100)', spread: 'Spread (bp)' }[st.mode]}</label><input class="num" data-k="value" type="number" step="0.01" value="${st.value}"></div>
              <div class="field"><label>Call date (optional)</label><input class="txt" data-k="callDate" type="date" value="${st.callDate || ''}"></div>
              <div class="field"><label>Call price</label><input class="num" data-k="callPrice" type="number" step="0.25" value="${st.callPrice || 100}"></div>
              <div class="field"><label>Holding period</label><select data-k="H">${[3, 6, 12, 24, 36].map(m => `<option value="${m}" ${+st.H === m ? 'selected' : ''}>${m} months</option>`).join('')}</select></div>
            </div><div class="row mt"><button class="btn" id="yAdd">Add to bond portfolio</button><span class="muted small" id="yDesc"></span></div>`)}
            ${panel('Results', '<div id="yRes"></div>')}
            ${panel('Risk rating', '<div id="yRisk"></div>')}</div>
          <div class="stack">${panel('What this means', '<div id="yInt" class="interp"></div>')}
            <div class="grid g2">${panel('Price–yield curve', '<div class="cv"><canvas id="yPy"></canvas></div><p class="hint">Solid: exact price. Dashed: duration only (a straight tangent). Dotted: duration + convexity.</p>')}
              ${panel(`Total return over the holding period`, '<div class="cv"><canvas id="yHz"></canvas></div><p class="hint" id="yHzH"></p>')}</div>
            ${panel('Where the duration comes from', '<div id="yFul"></div>')}
            ${panel('Rate-shock scenarios', '<div id="ySc"></div>')}
            <div class="grid g2">${panel('Key-rate durations', '<div class="cv sm"><canvas id="yKrd"></canvas></div><p class="hint" id="yKrdH"></p>')}${panel('Cash flows', '<div id="yCf" class="tblwrap short"></div>')}</div>
            ${panel('Bond portfolio', '<div id="yPort"></div>')}</div>
        </div><p class="src-note">Street-convention yields (compounded at the coupon frequency; zeros semi-annually). Treasury curve: FRED / US Treasury par yields, Nelson-Siegel-Svensson fit, bootstrapped zero curve. Presets are generic examples, not real securities. Horizon returns assume an instant parallel yield change and coupons reinvested at the new yield.</p>`;
      $('#yPre').addEventListener('change', e => { const p = P[e.target.value]; if (!p) return; this.st = { ...this.fromPreset(p), notional: this.st.notional, H: this.st.H }; U.store.set('yas', this.st); this.render(root); });
      $('#yIn').addEventListener('input', e => this.read(e));
      $('#yIn').addEventListener('change', e => this.read(e));
      $('#yAdd').addEventListener('click', () => this.addToPort());
      $('#yPort').addEventListener('click', e => {
        const d = e.target.closest('[data-rm]'); if (d) { const p = U.store.get('bondPort', []); p.splice(+d.dataset.rm, 1); U.store.set('bondPort', p); this.port(); return; }
        const l = e.target.closest('[data-load]'); if (l) { this.st = { ...U.store.get('bondPort', [])[+l.dataset.load] }; U.store.set('yas', this.st); this.render(root); }
      });
      $('#yPort').addEventListener('change', e => { if (e.target.id === 'yLiab') { U.store.set('bondLiab', +e.target.value || ''); this.port(); } });
      this.calc(); this.port();
    },
    fromPreset(p) {
      const m = yearsOut(p.years);
      return { coupon: p.coupon, freq: p.freq, settle: iso(nextBusinessDay()), maturity: iso(m), conv: p.conv, mode: p.mode, value: p.value, notional: 1000000, H: 12,
        callDate: p.callYears ? iso(yearsOut(p.callYears)) : '', callPrice: p.callPrice || 100, label: p.label };
    },
    read(e) {
      const el = e.target.closest('[data-k]'); if (!el) return;
      const k = el.dataset.k, prevMode = this.st.mode;
      this.st[k] = el.type === 'number' || k === 'freq' || k === 'H' ? (el.value === '' ? '' : +el.value) : el.value;
      if (k === 'mode' && this.st.mode !== prevMode && this.last) {        // keep the same bond: convert the value to the new mode
        const a = this.last; this.st.value = +(this.st.mode === 'yield' ? (a.y * 100).toFixed(4) : this.st.mode === 'price' ? a.clean.toFixed(4) : (a.z != null ? (a.z * 1e4).toFixed(1) : 0));
        $('#yIn [data-k=value]').value = this.st.value; $('#yValL').textContent = { yield: 'Yield %', price: 'Clean price (per 100)', spread: 'Spread (bp)' }[this.st.mode];
      }
      this.st.label = '';
      U.store.set('yas', this.st); clearTimeout(this._t); this._t = setTimeout(() => this.calc(), e.type === 'input' ? 160 : 0);
    },
    spec() {
      const s = this.st, d = x => x ? new Date(x + 'T00:00:00Z') : null;
      return { coupon: (+s.coupon || 0) / 100, freq: +s.freq, settle: d(s.settle), maturity: d(s.maturity), conv: s.conv, mode: s.mode, value: +s.value, notional: +s.notional || 0,
        callDate: d(s.callDate), callPrice: +s.callPrice || 100, redemption: 100 };
    },
    calc() {
      const s = this.spec(), res = $('#yRes'); if (!res) return;
      const bad = m => { res.innerHTML = `<div class="empty small err">${esc(m)}</div>`; ['yInt', 'ySc', 'yCf', 'yFul', 'yRisk'].forEach(id => { const el = $('#' + id); if (el) el.innerHTML = ''; }); };
      if (!s.settle || !s.maturity || !(s.maturity > s.settle)) return bad('Maturity must be after settlement.');
      if (!isFinite(s.value)) return bad('Enter a yield, price or spread.');
      if (s.freq && s.coupon <= 0 && s.mode !== 'price') { /* a 0% coupon bond with coupons is fine: it behaves like a zero */ }
      let a; try { a = analyze(s, this.curve); } catch (e) { return bad(e.message); }
      this.last = a; const H = +this.st.H || 12, pos = s.notional / 100, money = v => (v <= -0.5 ? '−$' : '$') + U.fmt(Math.abs(v), 0);
      $('#yDesc').textContent = (this.st.label ? this.st.label + ' · ' : '') + `${s.freq ? U.fmt(s.coupon * 100, 3) + '%' : 'zero'} ${this.st.maturity} · ${U.fmt(a.T, 2)} years`;
      res.innerHTML = `<div class="kvgrid">${kv('Clean price', U.fmt(a.clean, 4), 'key')}${kv('Dirty (invoice) price', U.fmt(a.dirty, 4))}${kv('Accrued interest', `${U.fmt(a.accrued, 4)} <small>${a.accruedDays}d</small>`)}${kv('Yield to maturity', U.fmtPct(a.y, 3, false), 'key')}
        ${a.call ? kv('Yield to call', U.fmtPct(a.call.ytc, 3, false)) + kv('Yield to worst', U.fmtPct(a.ytw, 3, false) + ` <small>${a.worst}</small>`, 'key') : ''}${kv('Current yield', a.currentYield == null ? '—' : U.fmtPct(a.currentYield, 3, false))}
        ${kv('Macaulay duration', U.fmt(a.mac, 3) + ' y', 'key')}${kv('Modified duration', U.fmt(a.mod, 3))}${kv('Effective duration', U.fmt(a.effDur, 3))}${kv('Convexity', U.fmt(a.cx, 2))}${kv('Effective convexity', U.fmt(a.effCx, 2))}
        ${a.call ? kv('Duration to call', U.fmt(a.call.mod, 3)) : ''}${kv('DV01 per 100', U.fmt(a.dv01, 4))}${kv('DV01 on position', money(a.dv01 * pos), 'key')}${kv('Market value', money(a.dirty * pos))}
        ${a.g != null ? kv('Treasury yield (same maturity)', U.fmtPct(a.tsy, 3, false)) + kv('G-spread', U.fmt(a.g * 1e4, 1) + 'bp', 'key') + kv('Z-spread', U.fmt(a.z * 1e4, 1) + 'bp') : ''}
        ${kv('Last · next coupon', s.freq ? `${iso(a.prev)} · ${iso(a.next)}` : '—')}${kv('Coupons left', a.nCpn)}</div>`;
      const I = interpret(s, a, H);
      $('#yInt').innerHTML = I.html;
      const dur = a.call && a.worst === 'call' ? a.call.mod : a.mod;
      $('#yRisk').innerHTML = `<div class="riskmeter">${[['LOW', 3], ['MODERATE', 7], ['HIGH', 12], ['VERY HIGH', 30]].map(([l, hi], i) => `<span class="${I.band === l ? 'on ' + I.bcls : ''}">${l}<em>${['< 3', '3–7', '7–12', '12+'][i]}</em></span>`).join('')}</div>
        <div class="kvgrid mt">${kv('Price change for +1% yield', U.fmtPct((priceAt(s, a, 0.01) - a.clean) / a.dirty, 2), 'down')}${kv('Price change for −1% yield', U.fmtPct((priceAt(s, a, -0.01) - a.clean) / a.dirty, 2), 'up')}
          ${kv(`${H}-month return, yields unchanged`, U.fmtPct(I.carry, 2), U.cls(I.carry))}${kv('Breakeven yield rise', isFinite(I.be) ? U.fmt(I.be * 1e4, 0) + 'bp' : '—')}${kv('Duration used for the rating', U.fmt(dur, 2))}</div>`;
      // scenarios
      const shocks = [-300, -200, -100, -50, -25, 0, 25, 50, 100, 200, 300];
      $('#ySc').innerHTML = `<div class="tblwrap"><table class="tbl"><thead><tr><th class="r">Yield shift</th><th class="r">New yield</th><th class="r">Clean price</th><th class="r">Price change</th><th class="r">% change</th><th class="r">P&amp;L on position</th><th class="r">Duration estimate</th><th class="r">+ convexity</th><th class="r">Estimate error</th><th class="r">${H}m total return</th></tr></thead><tbody>${shocks.map(bp => {
        const dy = bp / 1e4, p = priceAt(s, a, dy), ch = p - a.clean, e1 = -a.mod * dy * a.dirty, e2 = e1 + 0.5 * a.cx * dy * dy * a.dirty, hr = horizon(s, a, H, dy);
        return `<tr class="${bp === 0 ? 'self' : ''}"><td class="r ${U.cls(-bp)}">${bp > 0 ? '+' : ''}${bp}bp</td><td class="r">${U.fmt((a.y + dy) * 100, 3)}%</td><td class="r">${U.fmt(p, 3)}</td><td class="r ${U.cls(ch)}">${U.fmtSigned(ch, 3)}</td><td class="r ${U.cls(ch)}">${U.fmtPct(ch / a.dirty, 2)}</td><td class="r ${U.cls(ch)}">${money(ch * pos)}</td><td class="r muted">${U.fmtSigned(e1, 3)}</td><td class="r muted">${U.fmtSigned(e2, 3)}</td><td class="r small">${U.fmtSigned(ch - e2, 3)}</td><td class="r ${U.cls(hr)}">${U.fmtPct(hr, 2)}</td></tr>`;
      }).join('')}</tbody></table></div><p class="hint">Duration is a straight-line estimate, so its error grows with the square of the move; convexity fixes most of it.${a.call && a.worst === 'call' ? ' This callable bond is priced to maturity cash flows here; when yields fall its real upside is capped at the call price.' : ''}</p>`;
      // charts
      const col = CK.colors(), ys = U.linspace(Math.max(-0.01, a.y - 0.03), a.y + 0.03, 61);
      CK.xy($('#yPy'), { series: [{ name: 'Price', data: ys.map(y => [y * 100, priceAt(s, a, y - a.y)]), color: col.accent, width: 2.2 }, { name: 'Duration', data: ys.map(y => [y * 100, a.clean - a.mod * (y - a.y) * a.dirty]), color: col.muted, dash: [5, 3] },
        { name: 'Duration + convexity', data: ys.map(y => [y * 100, a.clean + (-a.mod * (y - a.y) + 0.5 * a.cx * (y - a.y) ** 2) * a.dirty]), color: col.key, dash: [2, 2] }], marks: [{ x: a.y * 100, y: a.clean, color: col.text, label: 'today' }],
        hlines: a.call ? [{ y: a.call.price, label: 'call price', color: col.down }] : [], xFmt: v => v.toFixed(1) + '%', yFmt: v => v.toFixed(1) });
      const hs = [-200, -100, -50, 0, 50, 100, 200], hv = hs.map(bp => horizon(s, a, H, bp / 1e4));
      CK.bars($('#yHz'), { labels: hs.map(b => (b > 0 ? '+' : '') + b + 'bp'), values: hv, fmt: v => U.fmtPct(v, 1), colors: hv.map(v => v >= 0 ? col.up : col.down) });
      $('#yHzH').textContent = `Coupons plus price change over ${H} months if yields jump by the amount shown today. Breakeven: +${isFinite(I.be) ? U.fmt(I.be * 1e4, 0) : '—'}bp.`;
      $('#yFul').innerHTML = fulcrum(a) + `<p class="hint">Each circle is a payment, sized by what it is worth today. Macaulay duration is where the seesaw balances: ${s.freq ? 'higher coupons put more weight early and pull it left; ' : 'with one payment the balance point is the maturity itself; '}longer maturity and lower yields push it right.</p>`;
      if (a.krd) {
        CK.bars($('#yKrd'), { labels: a.krd.map(k => k.key < 1 ? k.key * 12 + 'm' : k.key + 'y'), values: a.krd.map(k => k.krd), fmt: v => v.toFixed(2) });
        const top = [...a.krd].sort((p, q) => q.krd - p.krd)[0];
        $('#yKrdH').textContent = `Sum ${U.fmt(U.sum(a.krd.map(k => k.krd)), 2)} ≈ effective duration. Most of the risk sits at the ${top.key < 1 ? top.key * 12 + '-month' : top.key + '-year'} point of the curve: that is the yield to watch.`;
      } else $('#yKrdH').textContent = 'Needs the Treasury curve.';
      $('#yCf').innerHTML = `<table class="tbl"><thead><tr><th>Date</th><th class="r">Years</th><th class="r">Cash flow</th><th class="r">Present value</th><th class="r">% of price</th><th class="r">Duration share</th></tr></thead><tbody>${a.flows.map(f => `<tr><td>${iso(f.date)}</td><td class="r">${U.fmt(f.t, 2)}</td><td class="r">${U.fmt(f.cf, 3)}</td><td class="r">${U.fmt(f.pv, 3)}</td><td class="r muted">${U.fmtPct(f.pv / a.dirty, 1, false)}</td><td class="r">${U.fmt(f.k / a.f * f.pv / a.dirty, 3)}y</td></tr>`).join('')}</tbody></table>`;
    },
    addToPort() {
      if (!this.last) return; const p = U.store.get('bondPort', []);
      p.push({ ...this.st, label: $('#yDesc').textContent }); U.store.set('bondPort', p.slice(-30)); APP.toast('Added to the bond portfolio (saved in this browser).', 'ok'); this.port();
    },
    port() {
      const box = $('#yPort'); if (!box) return;
      const list = U.store.get('bondPort', []), liab = U.store.get('bondLiab', '');
      if (!list.length) { box.innerHTML = '<div class="empty small">Add bonds with <b>Add to bond portfolio</b> to see the combined duration, DV01 and rate-shock P&amp;L of a ladder or a fund.</div>'; return; }
      // a callable priced to its call date carries the call date's (shorter) rate risk
      const risk = a => a.call && a.worst === 'call' ? { ...a, mac: a.call.mac, mod: a.call.mod, cx: a.call.cx, dv01: a.call.dv01, y: a.ytw } : a;
      const save = this.st, rows = list.map((st, i) => { this.st = st; try { const s = this.spec(), a0 = analyze(s, this.curve), a = risk(a0); return { i, st, s, a, a0, mv: a0.dirty * s.notional / 100 }; } catch (e) { return { i, st, err: e.message }; } });
      this.st = save;
      const ok = rows.filter(r => r.a), MV = U.sum(ok.map(r => r.mv)), w = r => MV ? r.mv / MV : 0, money = v => (v <= -0.5 ? '−$' : '$') + U.fmt(Math.abs(v), 0);
      const pMac = U.sum(ok.map(r => w(r) * r.a.mac)), pMod = U.sum(ok.map(r => w(r) * r.a.mod)), pCx = U.sum(ok.map(r => w(r) * r.a.cx)), pY = U.sum(ok.map(r => w(r) * r.a.y)), pDv = U.sum(ok.map(r => r.a.dv01 * r.s.notional / 100));
      const shock = bp => U.sum(ok.map(r => { const dy = bp / 1e4; return (-r.a.mod * dy + 0.5 * r.a.cx * dy * dy) * r.a0.dirty * r.s.notional / 100; }));
      box.innerHTML = `<div class="tblwrap"><table class="tbl"><thead><tr><th>Bond</th><th class="r">Face</th><th class="r">Market value</th><th class="r">Weight</th><th class="r">Yield</th><th class="r">Mod. dur</th><th class="r">DV01</th><th class="r">Duration contribution</th><th></th></tr></thead><tbody>${rows.map(r => r.a ? `<tr><td class="wrap clk" data-load="${r.i}">${esc(r.st.label || r.st.maturity)}</td><td class="r">${money(r.s.notional)}</td><td class="r">${money(r.mv)}</td><td class="r muted">${U.fmtPct(w(r), 1, false)}</td><td class="r">${U.fmtPct(r.a.y, 2, false)}${r.a0.call && r.a0.worst === 'call' ? ' <small class="muted">YTW</small>' : ''}</td><td class="r">${U.fmt(r.a.mod, 2)}</td><td class="r">${money(r.a.dv01 * r.s.notional / 100)}</td><td class="r">${U.fmt(w(r) * r.a.mod, 2)}</td><td><button class="chipbtn" data-rm="${r.i}">Remove</button></td></tr>` : `<tr><td colspan="8" class="down">${esc(r.err)}</td><td><button class="chipbtn" data-rm="${r.i}">Remove</button></td></tr>`).join('')}
        <tr class="b"><td>Portfolio</td><td class="r">${money(U.sum(ok.map(r => r.s.notional)))}</td><td class="r">${money(MV)}</td><td class="r">100%</td><td class="r">${U.fmtPct(pY, 2, false)}</td><td class="r">${U.fmt(pMod, 2)}</td><td class="r">${money(pDv)}</td><td class="r">${U.fmt(pMod, 2)}</td><td></td></tr></tbody></table></div>
        <div class="kvgrid c3 mt">${kv('Macaulay duration', U.fmt(pMac, 2) + ' y', 'key')}${kv('Convexity', U.fmt(pCx, 1))}${kv('DV01', money(pDv), 'key')}${kv('P&L if yields +100bp', money(shock(100)), 'down')}${kv('P&L if yields −100bp', money(shock(-100)), 'up')}${kv('Yield (value weighted)', U.fmtPct(pY, 2, false))}</div>
        <div class="row mt"><label class="small muted" for="yLiab">Money needed in (years)</label><input class="num xs" id="yLiab" type="number" step="0.5" min="0" value="${liab}" placeholder="e.g. 7"></div>
        <p class="note small mt">${liab ? (Math.abs(pMac - liab) < 0.5 ? `<span class="up">Immunized:</span> the portfolio's Macaulay duration (${U.fmt(pMac, 1)}y) matches your ${liab}-year horizon, so a parallel rate move now changes the price and the reinvestment income in offsetting ways.` : `The portfolio's Macaulay duration is ${U.fmt(pMac, 1)}y against a ${liab}-year need: ${pMac > liab ? 'you carry more rate risk than the horizon needs (rising yields hurt).' : 'you are short of duration (falling yields hurt through lower reinvestment rates).'} To immunize, ${pMac > liab ? 'shift money into shorter bonds' : 'add longer bonds'} until the two match.`) : 'Enter when you need the money to check whether the portfolio is immunized (duration matched to the horizon).'}</p>`;
    },
  });
})();
