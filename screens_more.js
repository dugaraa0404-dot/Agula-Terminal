/* ============================================================================
   Agula Terminal — OPT · PORT · CURVE · FX · SCRN (real data)
   ========================================================================== */
'use strict';

(() => {
  const { panel, kv, $, $$ } = APP;
  const esc = U.esc;
  const errBox = e => `<div class="empty err">${esc(e.message || e)}</div>`;
  const dte = exp => Math.max(0.5, (Date.parse(exp + 'T21:00:00Z') - Date.now()) / U.DAY);

  // ======================================================================== OPT — real option chains
  const optLegs = new Map();
  APP.register('OPT', {
    title: 'Options & Volatility',
    async render(root, { sym }) {
      root.innerHTML = '<div class="empty">Loading option chains…</div>';
      let bars, info;
      try { [bars, info] = await Promise.all([HUB.history(sym, '1D'), HUB.expirations(sym)]); } catch (e) { root.innerHTML = errBox(e); return; }
      const exps = info.expirations || [];
      this.source = info.source || 'Yahoo Finance';
      const q = HUB.quote(sym) || await HUB.refreshQuote(sym) || { last: U.last(bars).c };
      let divY = 0; try { const i = await HUB.profile(sym); divY = i.dividendRate && q.last ? i.dividendRate / q.last : 0; } catch (e) { /* none */ }
      const c = bars.map(b => b.c);
      this.ctx = { sym, S: q.last, q: divY, bars, rv1m: Q.realizedVol(c, 21), rv3m: Q.realizedVol(c, 63), rv1y: Q.realizedVol(c, 252), exps: exps || [] };
      if (!exps.length) {
        const msg = info.status === 'unavailable'
          ? `Option prices for ${esc(sym)} couldn't be loaded right now: Yahoo Finance refused this server's request and the Cboe backup didn't answer. This is usually temporary. <button class="btn ghost sm" id="oRetry">Try again</button>`
          : `${esc(sym)} has no exchange-listed options. US stocks, ETFs and some indices (e.g. ^SPX) have option chains; FX pairs, futures and crypto do not.`;
        root.innerHTML = `<div class="warnbox">${msg} The pricer below still works with realized volatility.</div><div class="grid g2">${panel('Pricer', this.pricerHTML(q.last, this.ctx.rv3m || 0.3, divY))}</div>`;
        $('#oPr').addEventListener('change', () => this.pricer()); this.pricer();
        const rb = $('#oRetry'); if (rb) rb.addEventListener('click', () => this.render(root, { sym }));
        return;
      }
      const near30 = exps.reduce((best, e, i) => Math.abs(dte(e) - 30) < Math.abs(dte(exps[best]) - 30) ? i : best, 0);
      this.expIdx = this.expIdx != null && this.expIdx < exps.length && this.sym === sym ? this.expIdx : near30; this.sym = sym;
      root.innerHTML = `
        <div class="kvgrid c6 strip" id="oStrip"></div>
        <div class="grid optgrid">
          ${panel(`Option chain · ${esc(this.source)}`, `<div class="row"><label class="small" for="oExp">Expiry</label><select id="oExp">${exps.map((e, i) => `<option value="${i}" ${i === this.expIdx ? 'selected' : ''}>${e} (${Math.round(dte(e))}d)</option>`).join('')}</select><label class="chk"><input type="checkbox" id="oNear" checked> Strikes near the money</label></div><div id="oChain" class="tblwrap mt"><div class="muted small">Loading…</div></div><div class="hint">Bid/ask, IV, volume and open interest from ${esc(this.source)}${/delayed/i.test(this.source) ? '' : ' (delayed)'}; Greeks computed from each contract's implied volatility. Click a bid to sell or an ask to buy.</div>`, { cls: 'span2' })}
          ${panel('Implied-volatility smile', '<div class="cv sm"><canvas id="oSmile"></canvas></div><div class="hint">Out-of-the-money puts left of spot, calls right.</div><h4 class="subh">ATM term structure vs realized</h4><div class="cv sm"><canvas id="oTerm"></canvas></div>')}
          ${panel('Strategy builder', `<div class="row"><select id="oPreset"><option value="">Load a strategy…</option>${Object.keys(PRESETS).map(p => `<option>${p}</option>`).join('')}</select><button class="btn ghost sm" id="oClear">Clear legs</button></div><div id="oLegs" class="tblwrap mt"></div><div id="oStratKv" class="kvgrid c3 mt"></div>`, { cls: 'span2' })}
          ${panel('Payoff', `<div class="row"><label class="small" for="oDays">Days forward</label><input type="range" id="oDays" min="0" max="30" value="0"><span id="oDaysV" class="mono small">0d</span></div><div class="cv"><canvas id="oPay"></canvas></div>`)}
          ${panel('Pricer', this.pricerHTML(q.last, this.ctx.rv3m, divY))}
          ${panel('Volatility surface · implied vol by expiry and moneyness', '<div class="cv tall"><canvas id="oSurf"></canvas></div><div id="oSurfNote" class="hint"></div>', { cls: 'span2' })}
        </div>`;
      $('#oExp').addEventListener('change', e => { this.expIdx = +e.target.value; this.loadChain(); });
      $('#oNear').addEventListener('change', () => this.drawChain());
      $('#oChain').addEventListener('click', e => { const t = e.target.closest('[data-leg]'); if (!t) return; const [type, K, side] = t.dataset.leg.split('|'); this.addLeg(type, +K, this.ctx.exps[this.expIdx], side === 'B' ? 1 : -1); });
      $('#oPreset').addEventListener('change', async e => { const name = e.target.value; e.target.value = ''; if (name) await this.preset(name); });
      $('#oClear').addEventListener('click', () => { optLegs.set(sym, []); this.strategy(); });
      $('#oLegs').addEventListener('click', e => { const x = e.target.closest('[data-rm]'); if (x) { optLegs.get(sym).splice(+x.dataset.rm, 1); this.strategy(); } });
      $('#oLegs').addEventListener('change', e => { const i = e.target.closest('[data-q]'); if (i) { optLegs.get(sym)[+i.dataset.q].qty = parseFloat(i.value) || 0; this.strategy(); } });
      $('#oDays').addEventListener('input', e => { $('#oDaysV').textContent = e.target.value + 'd'; this.payoff(); });
      $('#oPr').addEventListener('change', () => this.pricer());
      if (!optLegs.has(sym)) optLegs.set(sym, []);
      await this.loadChain();
      if (!optLegs.get(sym).length) await this.preset('Bull call spread');
      this.pricer(); this.surface();
    },
    pricerHTML(S, v, q) {
      return `<div class="fields" id="oPr">
        <div class="field"><label for="p_type">Type</label><select id="p_type"><option value="C">Call</option><option value="P">Put</option></select></div>
        <div class="field"><label for="p_S">Spot</label><input class="num" id="p_S" type="number" step="any" value="${(+S).toFixed(4)}"></div>
        <div class="field"><label for="p_K">Strike</label><input class="num" id="p_K" type="number" step="any" value="${(+S).toFixed(2)}"></div>
        <div class="field"><label for="p_d">Days to expiry</label><input class="num" id="p_d" type="number" step="1" value="30"></div>
        <div class="field"><label for="p_v">Volatility %</label><input class="num" id="p_v" type="number" step="0.1" value="${(v * 100).toFixed(1)}"></div>
        <div class="field"><label for="p_r">Rate %</label><input class="num" id="p_r" type="number" step="0.05" value="${(HUB.rf() * 100).toFixed(2)}"></div>
        <div class="field"><label for="p_q">Dividend yield %</label><input class="num" id="p_q" type="number" step="0.05" value="${(q * 100).toFixed(2)}"></div>
        <div class="field"><label for="p_mkt">Market price → implied vol</label><input class="num" id="p_mkt" type="number" step="any" placeholder="optional"></div>
      </div><div id="oPrOut"></div>`;
    },
    async loadChain() {
      const { sym, exps } = this.ctx, exp = exps[this.expIdx];
      $('#oChain').innerHTML = '<div class="muted small">Loading…</div>';
      try { this.chainData = await HUB.chain(sym, exp); this.chainData.T = dte(exp) / 365; } catch (e) { $('#oChain').innerHTML = errBox(e); return; }
      this.drawChain(); this.smile(); this.strip();
    },
    rows() {
      const ch = this.chainData; if (!ch) return [];
      const byK = new Map();
      ch.calls.forEach(c => byK.set(c.K, { K: c.K, c }));
      ch.puts.forEach(p => { const r = byK.get(p.K) || { K: p.K }; r.p = p; byK.set(p.K, r); });
      return [...byK.values()].sort((a, b) => a.K - b.K);
    },
    ivOf(o, type, K) {
      // prefer Yahoo's IV; if missing, back it out of the mid price
      const { S, q } = this.ctx, T = this.chainData.T, r = HUB.rf();
      if (o && o.iv > 0.01 && o.iv < 4) return o.iv;
      const mid = o && o.bid > 0 && o.ask > 0 ? (o.bid + o.ask) / 2 : o?.last;
      const v = mid ? Q.impliedVol(mid, S, K, T, r, q, type) : NaN;
      return isFinite(v) ? v : null;
    },
    drawChain() {
      const { S, q } = this.ctx, T = this.chainData.T, r = HUB.rf();
      let rows = this.rows();
      if ($('#oNear')?.checked) { const i = rows.findIndex(x => x.K >= S); rows = rows.slice(Math.max(0, i - 10), i + 10); }
      const cell = (x, d = 2) => U.isNum(x) ? U.fmt(x, d) : '—';
      $('#oChain').innerHTML = `<table class="tbl chain"><thead><tr><th colspan="7" class="c">CALLS · ${esc(this.ctx.exps[this.expIdx])} · ${Math.round(T * 365)} days</th><th></th><th colspan="7" class="c">PUTS</th></tr>
        <tr><th class="r">Vol</th><th class="r">OI</th><th class="r">Δ</th><th class="r">Θ/day</th><th class="r">IV</th><th class="r">Bid</th><th class="r">Ask</th><th class="c key">Strike</th><th class="r">Bid</th><th class="r">Ask</th><th class="r">IV</th><th class="r">Θ/day</th><th class="r">Δ</th><th class="r">OI</th><th class="r">Vol</th></tr></thead><tbody>
        ${rows.map(x => {
          const cv = x.c ? this.ivOf(x.c, 'C', x.K) : null, pv = x.p ? this.ivOf(x.p, 'P', x.K) : null;
          const gc = cv ? Q.greeks(S, x.K, T, r, q, cv, 'C') : null, gp = pv ? Q.greeks(S, x.K, T, r, q, pv, 'P') : null, itmC = x.K < S;
          return `<tr><td class="r muted ${itmC ? 'itm' : ''}">${x.c ? U.fmt(x.c.vol, 0) : ''}</td><td class="r muted ${itmC ? 'itm' : ''}">${x.c ? U.fmt(x.c.oi, 0) : ''}</td><td class="r ${itmC ? 'itm' : ''}">${gc ? cell(gc.delta) : '—'}</td><td class="r ${itmC ? 'itm' : ''}">${gc ? cell(gc.theta, 3) : '—'}</td><td class="r ${itmC ? 'itm' : ''}">${cv ? U.fmt(cv * 100, 1) : '—'}</td>
            <td class="r bid ${itmC ? 'itm' : ''}" ${x.c ? `data-leg="C|${x.K}|S"` : ''}>${x.c ? cell(x.c.bid) : ''}</td><td class="r ask ${itmC ? 'itm' : ''}" ${x.c ? `data-leg="C|${x.K}|B"` : ''}>${x.c ? cell(x.c.ask) : ''}</td>
            <td class="c key strike">${U.fmtPx(x.K)}</td>
            <td class="r bid ${!itmC ? 'itm' : ''}" ${x.p ? `data-leg="P|${x.K}|S"` : ''}>${x.p ? cell(x.p.bid) : ''}</td><td class="r ask ${!itmC ? 'itm' : ''}" ${x.p ? `data-leg="P|${x.K}|B"` : ''}>${x.p ? cell(x.p.ask) : ''}</td>
            <td class="r ${!itmC ? 'itm' : ''}">${pv ? U.fmt(pv * 100, 1) : '—'}</td><td class="r ${!itmC ? 'itm' : ''}">${gp ? cell(gp.theta, 3) : '—'}</td><td class="r ${!itmC ? 'itm' : ''}">${gp ? cell(gp.delta) : '—'}</td><td class="r muted ${!itmC ? 'itm' : ''}">${x.p ? U.fmt(x.p.oi, 0) : ''}</td><td class="r muted ${!itmC ? 'itm' : ''}">${x.p ? U.fmt(x.p.vol, 0) : ''}</td></tr>`; }).join('')}
      </tbody></table>`;
    },
    atmIV(rows, S) {
      const near = [...rows].sort((a, b) => Math.abs(a.K - S) - Math.abs(b.K - S)).slice(0, 4);
      const ivs = near.flatMap(x => [x.c && this.ivOf(x.c, 'C', x.K), x.p && this.ivOf(x.p, 'P', x.K)]).filter(v => v);
      return ivs.length ? U.mean(ivs) : null;
    },
    strip() {
      const { S, rv1m, rv3m, rv1y, sym } = this.ctx, rows = this.rows(), T = this.chainData.T, iv = this.atmIV(rows, S);
      const pick = k => { const x = rows.reduce((b, r) => Math.abs(r.K - k) < Math.abs(b.K - k) ? r : b, rows[0]); return x; };
      const c105 = pick(S * 1.05), p95 = pick(S * 0.95), rr = c105?.c && p95?.p ? (this.ivOf(c105.c, 'C', c105.K) || 0) - (this.ivOf(p95.p, 'P', p95.K) || 0) : null;
      const em = iv ? S * iv * Math.sqrt(T) : null;
      const pcOI = U.sum(this.chainData.puts.map(p => p.oi || 0)) / Math.max(1, U.sum(this.chainData.calls.map(c => c.oi || 0)));
      $('#oStrip').innerHTML = kv('Spot', U.fmtPx(S)) + kv(`ATM IV (${Math.round(T * 365)}d)`, U.fmtPct(iv, 1, false)) + kv('Realized vol 1m / 3m', `${U.fmtPct(rv1m, 1, false)} / ${U.fmtPct(rv3m, 1, false)}`) +
        kv('IV − realized 1m', U.fmtPct(iv - rv1m, 1), U.cls(iv - rv1m)) + kv('Skew 105C − 95P', U.fmtPct(rr, 1), U.cls(rr)) + kv('Move ±1σ', em ? '±' + U.fmtPx(em) + ` (${U.fmtPct(em / S, 1, false)})` : '—') + kv('Put/call open interest', U.fmt(pcOI, 2));
    },
    smile() {
      const { S } = this.ctx, rows = this.rows(), col = CK.colors();
      const pts = rows.map(x => { const o = x.K < S ? x.p : x.c, t = x.K < S ? 'P' : 'C'; const v = o ? this.ivOf(o, t, x.K) : null; return v && (o.oi > 0 || o.bid > 0) ? [x.K / S * 100, v * 100] : null; }).filter(Boolean).filter(p => p[0] > 60 && p[0] < 150);
      CK.xy($('#oSmile'), { series: [{ name: this.ctx.exps[this.expIdx], data: pts, color: col.accent, points: true }], xFmt: v => v.toFixed(0) + '%', yFmt: v => v.toFixed(1) + '%', vlines: [{ x: 100, label: 'spot' }], hlines: [{ y: this.ctx.rv1m * 100, label: 'realized 1m', color: col.key }] });
    },
    async surface() {
      const { sym, S } = this.ctx, col = CK.colors();
      let slices; try { slices = await HUB.surface(sym, S); } catch (e) { const n = $('#oSurfNote'); if (n) n.textContent = e.message; return; }
      if (!slices.length || !$('#oSurf')) return;
      const ms = [0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2];
      const interp = (pts, m) => { if (m < pts[0][0] || m > U.last(pts)[0]) return null; for (let i = 1; i < pts.length; i++) if (m <= pts[i][0]) { const w = (m - pts[i - 1][0]) / (pts[i][0] - pts[i - 1][0] || 1); return pts[i - 1][1] + w * (pts[i][1] - pts[i - 1][1]); } return null; };
      const vals = slices.map(s => ms.map(m => interp(s.points, m)));
      const flat = vals.flat().filter(v => v != null), lo = Math.min(...flat), hi = Math.max(...flat);
      CK.heatmap($('#oSurf'), { rows: slices.map(s => `${s.expiry.slice(5)} (${Math.round(dte(s.expiry))}d)`), cols: ms.map(m => Math.round(m * 100) + '%'), values: vals, fmt: v => v == null ? '' : (v * 100).toFixed(1), color: v => v == null ? CK.colors().grid : CK.seqColor((v - lo) / (hi - lo || 1)), padL: 104 });
      $('#oSurfNote').textContent = 'Out-of-the-money contracts with a bid or open interest, linearly interpolated in moneyness; blank where no strikes trade.';
      const ts = slices.map(s => [dte(s.expiry), (interp(s.points, 1) || null) * 100]).filter(p => p[1]);
      CK.xy($('#oTerm'), { series: [{ name: 'ATM implied', data: ts, color: col.accent, points: true }], hlines: [{ y: this.ctx.rv1m * 100, label: 'realized 1m', color: col.key }, { y: this.ctx.rv1y * 100, label: 'realized 1y', color: col.muted }], xFmt: v => v.toFixed(0) + 'd', yFmt: v => v.toFixed(1) + '%' });
    },
    contract(type, K, exp) {
      const ch = exp === this.ctx.exps[this.expIdx] ? this.chainData : null;
      const list = ch ? (type === 'C' ? ch.calls : ch.puts) : null; return list ? list.find(o => o.K === K) : null;
    },
    addLeg(type, K, exp, qty, silent, o) {
      const { S, sym } = this.ctx, legs = optLegs.get(sym) || [];
      if (type === 'S') legs.push({ type: 'S', K: 0, exp: null, T: 0, qty, premium: S, iv: null });
      else {
        o = o || this.contract(type, K, exp); const T = dte(exp) / 365;
        const mid = o && o.bid > 0 && o.ask > 0 ? (o.bid + o.ask) / 2 : o?.last;
        let iv = o && o.iv > 0.01 ? o.iv : null; if (!iv && mid) iv = Q.impliedVol(mid, S, K, T, HUB.rf(), this.ctx.q, type);
        if (!mid || !iv || !isFinite(iv)) { APP.toast(`No usable price for the ${K} ${type === 'C' ? 'call' : 'put'}.`, 'err'); return; }
        legs.push({ type, K, exp, T, qty, premium: mid, iv });
      }
      optLegs.set(sym, legs); if (!silent) { this.strategy(); APP.toast(`${qty > 0 ? 'Bought' : 'Sold'} ${Math.abs(qty)} ${type === 'S' ? 'shares' : `${exp} ${U.fmtPx(K)} ${type === 'C' ? 'call' : 'put'}`}`, 'ok', 2000); }
    },
    async preset(name) {
      const { S, sym, exps } = this.ctx, legs = PRESETS[name];
      const near = d => exps.reduce((b, e) => Math.abs(dte(e) - d) < Math.abs(dte(b) - d) ? e : b, exps[0]);
      optLegs.set(sym, []);
      for (const [t, m, days, qn] of legs) {
        if (t === 'S') { this.addLeg('S', 0, null, qn, true); continue; }
        const exp = near(days); let ch = exp === exps[this.expIdx] ? this.chainData : await HUB.chain(sym, exp);
        const list = t === 'C' ? ch.calls : ch.puts, target = S * (1 + m);
        const o = list.filter(x => (x.bid > 0 || x.last > 0)).reduce((b, x) => !b || Math.abs(x.K - target) < Math.abs(b.K - target) ? x : b, null);
        if (o) this.addLeg(t, o.K, exp, qn, true, o);
      }
      this.strategy();
    },
    strategy() {
      const { S, sym, q } = this.ctx, legs = optLegs.get(sym) || [], r = HUB.rf();
      $('#oLegs').innerHTML = legs.length ? `<table class="tbl"><thead><tr><th>Leg</th><th class="r">Qty</th><th class="r">Strike</th><th class="r">Expiry</th><th class="r">Premium</th><th class="r">IV</th><th class="r">Δ</th><th></th></tr></thead><tbody>
        ${legs.map((L, i) => { const g = L.type === 'S' ? { delta: 1 } : Q.greeks(S, L.K, L.T, r, q, L.iv, L.type); return `<tr><td>${L.type === 'S' ? 'Shares' : L.type === 'C' ? 'Call' : 'Put'}</td><td class="r"><input class="num xs" data-q="${i}" type="number" step="1" value="${L.qty}"></td><td class="r">${L.type === 'S' ? '—' : U.fmtPx(L.K)}</td><td class="r">${L.type === 'S' ? '—' : esc(L.exp)}</td><td class="r">${U.fmtPx(L.premium)}</td><td class="r">${L.iv ? U.fmt(L.iv * 100, 1) + '%' : '—'}</td><td class="r">${U.fmt(g.delta, 2)}</td><td><button class="x" data-rm="${i}" title="Remove leg">×</button></td></tr>`; }).join('')}</tbody></table>`
        : '<div class="muted small">No legs. Load a strategy or click prices in the chain.</div>';
      const opts = legs.filter(l => l.type !== 'S');
      const net = { delta: 0, gamma: 0, vega: 0, theta: 0, cost: 0 };
      legs.forEach(L => { if (L.type === 'S') { net.delta += L.qty; net.cost += L.qty * L.premium; return; } const g = Q.greeks(S, L.K, L.T, r, q, L.iv, L.type), m = L.qty * 100; net.delta += m * g.delta; net.gamma += m * g.gamma; net.vega += m * g.vega; net.theta += m * g.theta; net.cost += m * L.premium; });
      const T1 = opts.length ? Math.min(...opts.map(l => l.T)) : 30 / 365, v1 = opts.length ? U.mean(opts.map(l => l.iv)) : (this.ctx.rv3m || 0.3), sig = v1 * Math.sqrt(T1);
      const grid = U.linspace(S * Math.exp(-4.5 * sig), S * Math.exp(4.5 * sig), 361);
      const pay = legs.length ? Q.strategyPayoff(legs, S, 0, r, q, null, grid) : [];
      const be = []; for (let i = 1; i < pay.length; i++) if ((pay[i - 1].atExp <= 0) !== (pay[i].atExp <= 0)) { const a = pay[i - 1], b = pay[i]; be.push(a.x + (b.x - a.x) * (-a.atExp) / (b.atExp - a.atExp)); }
      const mx = pay.length ? Math.max(...pay.map(p => p.atExp)) : 0, mn = pay.length ? Math.min(...pay.map(p => p.atExp)) : 0;
      const slopeR = pay.length ? pay[pay.length - 1].atExp - pay[pay.length - 2].atExp : 0, slopeL = pay.length ? pay[1].atExp - pay[0].atExp : 0;
      const mu = Math.log(S) + (r - q - 0.5 * v1 * v1) * T1;
      let pop = 0; for (let i = 1; i < grid.length; i++) { if ((pay[i].atExp + pay[i - 1].atExp) / 2 > 0) pop += U.ncdf((Math.log(grid[i]) - mu) / sig) - U.ncdf((Math.log(grid[i - 1]) - mu) / sig); }
      this.pay = { grid, pay, be, T1, sig };
      $('#oStratKv').innerHTML = legs.length ? kv(net.cost >= 0 ? 'Net debit' : 'Net credit', U.fmt(Math.abs(net.cost), 2)) + kv('Max profit', slopeR > 1e-6 ? 'Unlimited' : U.fmt(mx, 0), 'up') + kv('Max loss', (slopeR < -1e-6 || slopeL > 1e-6) ? 'Unlimited' : U.fmt(mn, 0), 'down') +
        kv('Breakeven(s)', be.length ? be.map(x => U.fmtPx(x)).join(' · ') : 'none') + kv('Probability of profit', U.fmtPct(pop, 0, false)) + kv('Position Δ / Γ', `${U.fmt(net.delta, 1)} / ${U.fmt(net.gamma, 3)}`) +
        kv('Vega per vol pt', U.fmt(net.vega, 1)) + kv('Theta per day', U.fmt(net.theta, 1), U.cls(net.theta)) + kv('First expiry', Math.round(T1 * 365) + ' days') : '';
      const dz = $('#oDays'); if (dz) { dz.max = Math.max(1, Math.round(T1 * 365)); if (+dz.value > +dz.max) { dz.value = dz.max; $('#oDaysV').textContent = dz.max + 'd'; } }
      this.payoff();
    },
    payoff() {
      const p = this.pay, el = $('#oPay'); if (!el || !p) return;
      const { S, sym, q } = this.ctx, legs = optLegs.get(sym) || [], col = CK.colors(); if (!legs.length) return;
      const shift = (+($('#oDays')?.value || 0)) / 365;
      const now = Q.strategyPayoff(legs, S, shift, HUB.rf(), q, null, p.grid);
      CK.xy(el, { series: [{ name: 'At first expiry', data: p.pay.map(x => [x.x, x.atExp]), color: col.key, width: 2 }, { name: shift ? `In ${Math.round(shift * 365)} days` : 'Today', data: now.map(x => [x.x, x.now]), color: col.accent }],
        hlines: [{ y: 0, color: col.dim, dash: [] }], vlines: [{ x: S, label: 'spot', color: col.text }, ...p.be.map(b => ({ x: b, color: col.muted, label: 'BE' }))],
        vbands: [{ x0: S * Math.exp(-p.sig), x1: S * Math.exp(p.sig), color: col.accent + '10' }, { x0: S * Math.exp(-2 * p.sig), x1: S * Math.exp(2 * p.sig), color: col.accent + '08' }], xFmt: v => U.fmtPx(v), yFmt: v => U.fmtBig(v, 1) });
    },
    pricer() {
      const g = id => parseFloat($('#p_' + id).value), type = $('#p_type').value;
      const S = g('S'), K = g('K'), T = Math.max(g('d'), 0.01) / 365, v = g('v') / 100, r = g('r') / 100, qd = g('q') / 100, mkt = g('mkt');
      if (![S, K, T, v, r, qd].every(isFinite) || S <= 0 || K <= 0 || v <= 0) { $('#oPrOut').innerHTML = '<div class="muted small">Enter positive spot, strike, days and volatility.</div>'; return; }
      const gk = Q.greeks(S, K, T, r, qd, v, type), am = Q.binomial(S, K, T, r, qd, v, type, true, 300), eu = Q.binomial(S, K, T, r, qd, v, type, false, 300), mc = Q.monteCarloOption(S, K, T, r, qd, v, type, 20000);
      const asian = Q.monteCarloOption(S, K, T, r, qd, v, type, 10000, 'asian', 40), iv = isFinite(mkt) ? Q.impliedVol(mkt, S, K, T, r, qd, type) : null;
      $('#oPrOut').innerHTML = `<div class="kvgrid c2 mt">${kv('Black-Scholes', U.fmt(gk.price, 4), 'key')}${kv('Binomial (American)', U.fmt(am, 4))}${kv('Early-exercise premium', U.fmt(am - eu, 4))}
        ${kv('Monte Carlo', `${U.fmt(mc.price, 4)} ± ${U.fmt(mc.se * 1.96, 4)}`)}${kv('Asian (average price) MC', U.fmt(asian.price, 4))}${kv('Probability ITM', U.fmtPct(gk.probITM, 1, false))}
        ${kv('Delta', U.fmt(gk.delta, 4))}${kv('Gamma', U.fmt(gk.gamma, 5))}${kv('Vega (1 vol pt)', U.fmt(gk.vega, 4))}${kv('Theta (per day)', U.fmt(gk.theta, 4), U.cls(gk.theta))}${kv('Rho (1%)', U.fmt(gk.rho, 4))}${kv('Vanna', U.fmt(gk.vanna, 5))}
        ${kv('Volga', U.fmt(gk.volga, 5))}${kv('Charm (Δ per day)', U.fmt(gk.charm, 5))}${iv != null ? kv('Implied vol from market price', isFinite(iv) ? U.fmtPct(iv, 2, false) : 'below intrinsic', 'key') : ''}</div>`;
    },
    onTick(syms) { if (this.ctx && syms.includes(this.ctx.sym)) { const q = HUB.quote(this.ctx.sym); if (q && Math.abs(q.last / this.ctx.S - 1) > 0.001 && this.chainData) { this.ctx.S = q.last; this.strip(); this.strategy(); } } },
  });
  const PRESETS = { // [type, moneyness offset, target days, qty]
    'Long call': [['C', 0, 30, 1]], 'Long put': [['P', 0, 30, 1]],
    'Covered call': [['S', 0, 0, 100], ['C', 0.05, 30, -1]], 'Protective put': [['S', 0, 0, 100], ['P', -0.05, 30, 1]],
    'Bull call spread': [['C', 0, 30, 1], ['C', 0.05, 30, -1]], 'Bear put spread': [['P', 0, 30, 1], ['P', -0.05, 30, -1]],
    'Long straddle': [['C', 0, 30, 1], ['P', 0, 30, 1]], 'Long strangle': [['C', 0.05, 30, 1], ['P', -0.05, 30, 1]],
    'Iron condor': [['P', -0.1, 30, 1], ['P', -0.05, 30, -1], ['C', 0.05, 30, -1], ['C', 0.1, 30, 1]],
    'Call butterfly': [['C', -0.05, 30, 1], ['C', 0, 30, -2], ['C', 0.05, 30, 1]],
    'Collar': [['S', 0, 0, 100], ['P', -0.05, 30, 1], ['C', 0.05, 30, -1]],
    'Calendar spread': [['C', 0, 30, -1], ['C', 0, 90, 1]],
  };

  // ======================================================================== PORT
  const STRESS = [
    ['Equity sell-off', { m: -0.20, r: -0.004, o: -0.10, d: 0.03 }],
    ['2008-style credit crisis', { m: -0.40, r: -0.015, o: -0.50, d: 0.10 }],
    ['2020-style pandemic shock', { m: -0.30, r: -0.010, o: -0.60, d: 0.05 }],
    ['2022-style inflation & rate shock', { m: -0.20, r: 0.025, o: 0.40, d: 0.12 }],
    ['Oil supply shock', { m: -0.08, r: 0.003, o: 0.50, d: 0.02 }],
    ['Soft-landing rally', { m: 0.12, r: -0.005, o: -0.05, d: -0.03 }],
    ['Dollar surge', { m: -0.05, r: 0.002, o: -0.05, d: 0.08 }],
  ];
  const EXAMPLE = [['AAPL', 50], ['MSFT', 30], ['NVDA', 60], ['JPM', 40], ['XOM', 60], ['JNJ', 40], ['GLD', 30], ['BTC-USD', 0.1]];
  APP.register('PORT', {
    title: 'Portfolio & Risk', global: true,
    async render(root) {
      this.pos = (U.store.get('port', null) || EXAMPLE.map(([s, q]) => ({ sym: s, qty: q, cost: null }))).filter(p => HUB.resolve(p.sym));
      this.horizon = this.horizon || 1;
      root.innerHTML = `
        <div class="kvgrid c6 strip" id="pStrip"><div class="muted small">Loading prices…</div></div>
        <div class="grid g3">
          ${panel('Positions', `<div id="pPos" class="tblwrap"></div><div class="row mt"><input class="txt" id="pAddS" placeholder="Symbol (e.g. TSLA)"><input class="num" id="pAddQ" type="number" placeholder="Quantity"><button class="btn" id="pAdd">Add</button><button class="btn ghost" id="pDef">Load example</button></div><div class="hint">The example portfolio is illustrative; its cost prices default to prices one year ago. Edit anything; changes stay in this browser.</div>`, { cls: 'span2' })}
          ${panel('Allocation', '<div class="cv"><canvas id="pAlloc"></canvas></div>')}
          ${panel('Value at risk', `<div class="seg" id="pHor"><button data-h="1" class="${this.horizon === 1 ? 'on' : ''}">1 day</button><button data-h="10" class="${this.horizon === 10 ? 'on' : ''}">10 days</button></div><div id="pVar" class="tblwrap"></div>`)}
          ${panel('Simulated P&amp;L distribution', '<div class="cv"><canvas id="pMc"></canvas></div>')}
          ${panel('Risk contribution · 95% VaR', '<div class="cv"><canvas id="pComp"></canvas></div>')}
          ${panel('Backtest · current weights vs S&amp;P 500, 1 year', '<div class="cv"><canvas id="pCurve"></canvas></div>', { cls: 'span2' })}
          ${panel('Drawdown', '<div class="cv"><canvas id="pDD"></canvas></div>')}
          ${panel('Efficient frontier · expected return vs volatility', '<div class="cv tall"><canvas id="pFront"></canvas></div>', { cls: 'span2' })}
          ${panel('Optimal weights', '<div id="pW" class="tblwrap"></div>')}
          ${panel('Correlation (1 year, daily)', '<div class="cv tall"><canvas id="pCorr"></canvas></div>', { cls: 'span2' })}
          ${panel('Stress tests · linear factor model', '<div id="pStress" class="tblwrap"></div>')}
        </div>`;
      $('#pAdd').addEventListener('click', async () => { const s = HUB.resolve($('#pAddS').value), qn = parseFloat($('#pAddQ').value); if (!s) { APP.toast(HUB.why($('#pAddS').value), 'err'); return; } if (!(qn > 0)) { APP.toast('Enter a positive quantity', 'err'); return; } const q = HUB.quote(s) || await HUB.refreshQuote(s).catch(() => null); if (!q) { APP.toast(`No price for ${s}`, 'err'); return; } this.pos.push({ sym: s, qty: qn, cost: +q.last.toFixed(4) }); this.save(); this.compute(); });
      $('#pDef').addEventListener('click', () => { this.pos = EXAMPLE.map(([s, q]) => ({ sym: s, qty: q, cost: null })); this.save(); this.compute(); });
      $('#pPos').addEventListener('change', e => { const i = e.target.closest('[data-i]'); if (!i) return; const p = this.pos[+i.dataset.i], v = parseFloat(i.value); if (!isFinite(v)) return; p[i.dataset.f] = v; this.save(); this.compute(); });
      $('#pPos').addEventListener('click', e => { const x = e.target.closest('[data-rm]'); if (x) { this.pos.splice(+x.dataset.rm, 1); this.save(); this.compute(); return; } const s = e.target.closest('[data-s]'); if (s && !e.target.closest('input')) APP.open('DES', s.dataset.s); });
      $('#pHor').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; this.horizon = +b.dataset.h; $$('#pHor button').forEach(x => x.classList.toggle('on', x === b)); this.risk(); });
      $('#pW').addEventListener('click', e => { const b = e.target.closest('[data-apply]'); if (b) this.apply(b.dataset.apply); });
      await this.compute();
    },
    save() { U.store.set('port', this.pos); },
    async compute() {
      if (!this.pos.length) { $('#pPos').innerHTML = '<div class="muted small">No positions. Add one below or load the example.</div>'; return; }
      HUB.track('screen', this.pos.map(p => p.sym));
      const [hist, factors] = await Promise.all([Promise.all(this.pos.map(p => HUB.history(p.sym, '1D').catch(() => null))), Promise.all(['^GSPC', '^TNX', 'CL=F', 'DX-Y.NYB'].map(s => HUB.history(s, '1D').catch(() => null)))]);
      const okIdx = hist.map((h, i) => h && h.length > 60 ? i : -1).filter(i => i >= 0);
      if (okIdx.length < 1) { $('#pPos').innerHTML = errBox('No price history for these positions.'); return; }
      const pos = okIdx.map(i => this.pos[i]), H = okIdx.map(i => hist[i]);
      pos.forEach((p, k) => { if (p.cost == null) { const b = H[k]; p.cost = +b[Math.max(0, b.length - 253)].c.toFixed(4); } }); this.save();
      const key = t => U.isoDate(t), sets = H.map(h => new Set(h.map(b => key(b.t))));
      const dates = [...sets[0]].filter(d => sets.every(s => s.has(d))).sort().slice(-505);   // crypto trades daily: align on shared dates
      const closes = H.map(h => { const m = new Map(h.map(b => [key(b.t), b.c])); return dates.map(d => m.get(d)); });
      const px = pos.map((p, i) => HUB.quote(p.sym)?.last ?? U.last(H[i]).c);
      const mv = pos.map((p, i) => p.qty * px[i]), V = U.sum(mv), w = mv.map(x => x / V);
      const R = closes.map(c => U.returns(c).slice(-252));
      const fmap = factors.map(f => f ? new Map(f.map(b => [key(b.t), b.c])) : null);
      this.d = { pos, closes, px, mv, V, w, R, dates, fmap };
      $('#pPos').innerHTML = `<table class="tbl"><thead><tr><th>Symbol</th><th class="r">Quantity</th><th class="r">Cost</th><th class="r">Price</th><th class="r">Value</th><th class="r">Weight</th><th class="r">Day P&amp;L</th><th class="r">Total P&amp;L</th><th></th></tr></thead><tbody>
        ${pos.map((p, i) => { const q = HUB.quote(p.sym), day = q ? p.qty * q.chg : 0, tot = p.qty * (px[i] - p.cost), k = this.pos.indexOf(p); return `<tr><td class="key clk" data-s="${esc(p.sym)}" title="${esc(HUB.meta(p.sym).name)}">${esc(p.sym)}</td><td class="r"><input class="num xs" data-i="${k}" data-f="qty" type="number" step="any" value="${p.qty}"></td><td class="r"><input class="num xs" data-i="${k}" data-f="cost" type="number" step="any" value="${p.cost}"></td>
          <td class="r">${U.fmtPx(px[i])}</td><td class="r">${U.fmtBig(mv[i])}</td><td class="r">${U.fmtPct(w[i], 1, false)}</td><td class="r ${U.cls(day)}">${U.fmtSigned(day, 0)}</td><td class="r ${U.cls(tot)}">${U.fmtSigned(tot, 0)}</td><td><button class="x" data-rm="${k}" title="Remove">×</button></td></tr>`; }).join('')}
        </tbody></table>${okIdx.length < this.pos.length ? '<div class="warnbox">Some positions have no price history and are excluded from risk.</div>' : ''}<div class="hint">Values in each instrument's quote currency; mixing currencies adds FX risk that is not converted here.</div>`;
      CK.bars($('#pAlloc'), { horizontal: true, labels: pos.map(p => p.sym), values: w, fmt: v => U.fmtPct(v, 1, false), colors: pos.map((_, i) => CK.colors().series[i % 8]), padL: 72 });
      this.risk(); this.backtest(); this.frontier(); this.corr(); this.stress();
    },
    benchR() { const d = this.d, m = d.fmap[0]; if (!m) return null; const dts = d.dates.slice(-d.R[0].length - 1); const r = dts.slice(1).map((t, i) => m.get(t) / m.get(dts[i]) - 1); return r.every(isFinite) ? r : null; },
    risk() {
      const d = this.d; if (!d) return;
      const vs = Q.varSuite(d.w, d.R, d.V, this.horizon), pr = Q.portfolioReturns(d.w, d.R), br = this.benchR();
      const beta = br ? U.cov(pr, br) / U.variance(br) : NaN, vol = U.std(pr) * Math.sqrt(252), ret = U.mean(pr) * 252, eq = pr.reduce((a, r) => (a.push(U.last(a) * (1 + r)), a), [1]), mdd = U.maxDrawdown(eq).mdd;
      const dayPL = U.sum(d.pos.map(p => { const q = HUB.quote(p.sym); return q ? p.qty * q.chg : 0; })), totPL = U.sum(d.pos.map((p, i) => p.qty * (d.px[i] - p.cost)));
      $('#pStrip').innerHTML = kv('Market value', U.fmtBig(d.V)) + kv('Day P&L', U.fmtSigned(dayPL, 0), U.cls(dayPL)) + kv('Unrealized P&L', U.fmtSigned(totPL, 0), U.cls(totPL)) + kv('Volatility (ann.)', U.fmtPct(vol, 1, false)) +
        kv('Beta vs S&P 500', U.fmt(beta, 2)) + kv('Sharpe 1y', U.fmt((ret - HUB.rf()) / vol, 2)) + kv('Max drawdown 1y', U.fmtPct(mdd, 1), 'down') + kv(`VaR 95% ${this.horizon}d (hist.)`, U.fmtBig(vs.rows[0].hist), 'down');
      const r = vs.rows;
      $('#pVar').innerHTML = `<table class="tbl"><thead><tr><th>Method</th><th class="r">VaR 95%</th><th class="r">CVaR 95%</th><th class="r">VaR 99%</th><th class="r">CVaR 99%</th></tr></thead><tbody>
        <tr><td>Historical</td><td class="r">${U.fmtBig(r[0].hist)}</td><td class="r">${U.fmtBig(r[0].histES)}</td><td class="r">${U.fmtBig(r[1].hist)}</td><td class="r">${U.fmtBig(r[1].histES)}</td></tr>
        <tr><td>Parametric (normal)</td><td class="r">${U.fmtBig(r[0].param)}</td><td class="r">${U.fmtBig(r[0].paramES)}</td><td class="r">${U.fmtBig(r[1].param)}</td><td class="r">${U.fmtBig(r[1].paramES)}</td></tr>
        <tr><td>Cornish-Fisher</td><td class="r">${U.fmtBig(r[0].cf)}</td><td class="r">—</td><td class="r">${U.fmtBig(r[1].cf)}</td><td class="r">—</td></tr>
        <tr><td>Monte Carlo (10,000)</td><td class="r">${U.fmtBig(r[0].mc)}</td><td class="r">${U.fmtBig(r[0].mcES)}</td><td class="r">${U.fmtBig(r[1].mc)}</td><td class="r">${U.fmtBig(r[1].mcES)}</td></tr>
      </tbody></table><div class="hint">Losses over ${this.horizon} trading day${this.horizon > 1 ? 's' : ''} from the last year of daily returns. Skew ${U.fmt(vs.skew, 2)}, excess kurtosis ${U.fmt(vs.kurt, 2)}.</div>`;
      const col = CK.colors(), q95 = U.quantile(vs.sims, 0.05) * d.V;
      CK.hist($('#pMc'), { values: vs.sims.map(x => x * d.V), bins: 50, xFmt: v => U.fmtBig(v, 0), vlines: [{ x: q95, label: 'VaR 95%', color: col.down }], colorFn: x => x < q95 ? col.down + 'cc' : col.accent + '88' });
      CK.bars($('#pComp'), { horizontal: true, labels: d.pos.map(p => p.sym), values: vs.component, fmt: v => U.fmtBig(v, 1), padL: 72, colors: vs.component.map(v => v >= 0 ? col.down : col.up) });
    },
    backtest() {
      const d = this.d, pr = Q.portfolioReturns(d.w, d.R), dts = d.dates.slice(-pr.length - 1), col = CK.colors(), T = dts.map(t => Date.parse(t));
      const eq = pr.reduce((a, r) => (a.push(U.last(a) * (1 + r)), a), [100]);
      const m = d.fmap[0], b0 = m && m.get(dts[0]), bs = m ? dts.map(t => m.get(t) / b0 * 100) : null;
      CK.xy($('#pCurve'), { series: [{ name: 'Portfolio', data: eq.map((v, i) => [T[i], v]), color: col.accent }, bs ? { name: 'S&P 500', data: bs.map((v, i) => [T[i], v]), color: col.muted } : null].filter(Boolean), xFmt: t => new Date(t).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }), yFmt: v => v.toFixed(0) });
      CK.xy($('#pDD'), { series: [{ name: 'Drawdown', data: U.drawdownSeries(eq).map((v, i) => [T[i], v * 100]), color: col.down, fill: true }], xFmt: t => new Date(t).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }), yFmt: v => v.toFixed(0) + '%', legend: false });
    },
    frontier() {
      const d = this.d; if (d.pos.length < 2) { $('#pW').innerHTML = '<div class="muted small">Add at least two positions.</div>'; return; }
      const rf = HUB.rf(), C0 = U.covMatrix(d.R).map(r => r.map(x => x * 252)), C = C0.map((r, i) => r.map((x, j) => i === j ? x : x * 0.85));
      const br = this.benchR(), betas = d.R.map(r => br ? U.cov(r, br) / U.variance(br) : 1);
      const mu = d.R.map((r, i) => 0.5 * U.clamp(U.mean(r) * 252, -0.3, 0.6) + 0.5 * (rf + betas[i] * 0.05));
      const fr = Q.efficientFrontier(mu, C, rf, 36), cloud = Q.randomPortfolios(mu, C, 1200, rf), rp = Q.riskParity(C);
      const pt = w => ({ ret: U.dot(w, mu), vol: Math.sqrt(U.quad(w, C)) }), cur = pt(d.w), rpp = pt(rp), col = CK.colors();
      this.opt = { mu, C, fr, rp };
      CK.xy($('#pFront'), { series: [{ type: 'scatter', data: cloud.map(p => [p.vol * 100, p.ret * 100]), color: col.dim, r: 1.6, alpha: 0.5 }, { name: 'Efficient frontier', data: fr.pts.map(p => [p.vol * 100, p.ret * 100]), color: col.accent, width: 2 },
        { name: 'Capital market line', data: [[0, rf * 100], [fr.maxSharpe.vol * 140, (rf + fr.maxSharpe.sharpe * fr.maxSharpe.vol * 1.4) * 100]], color: col.key, dash: [5, 4], width: 1 }],
        marks: [{ x: cur.vol * 100, y: cur.ret * 100, color: col.text, label: 'Current' }, { x: fr.minVar.vol * 100, y: fr.minVar.ret * 100, color: col.up, label: 'Min variance' }, { x: fr.maxSharpe.vol * 100, y: fr.maxSharpe.ret * 100, color: col.key, label: 'Max Sharpe' }, { x: rpp.vol * 100, y: rpp.ret * 100, color: col.series[3], label: 'Risk parity', align: 'right' }],
        xFmt: v => v.toFixed(0) + '%', yFmt: v => v.toFixed(1) + '%', hover: false, xmin: 0 });
      const rows = [['Current', d.w], ['Min variance', fr.minVar.w], ['Max Sharpe', fr.maxSharpe.w], ['Risk parity', rp]];
      $('#pW').innerHTML = `<table class="tbl"><thead><tr><th></th>${rows.map(r => `<th class="r">${r[0]}</th>`).join('')}</tr></thead><tbody>
        ${d.pos.map((p, i) => `<tr><td class="key">${esc(p.sym)}</td>${rows.map(r => `<td class="r">${U.fmtPct(r[1][i], 1, false)}</td>`).join('')}</tr>`).join('')}
        <tr class="b"><td>Exp. return</td>${rows.map(r => `<td class="r">${U.fmtPct(pt(r[1]).ret, 1, false)}</td>`).join('')}</tr>
        <tr class="b"><td>Volatility</td>${rows.map(r => `<td class="r">${U.fmtPct(pt(r[1]).vol, 1, false)}</td>`).join('')}</tr>
        <tr class="b"><td>Sharpe</td>${rows.map(r => `<td class="r">${U.fmt((pt(r[1]).ret - rf) / pt(r[1]).vol, 2)}</td>`).join('')}</tr>
        <tr><td></td><td></td>${['minVar', 'maxSharpe', 'rp'].map(k => `<td class="r"><button class="btn ghost sm" data-apply="${k}">Apply</button></td>`).join('')}</tr>
      </tbody></table><div class="hint">Expected returns blend each asset's 1-year history with CAPM (beta × 5% premium, risk-free ${U.fmtPct(rf, 2, false)} from FRED); correlations shrunk 15%. Long-only, fully invested.</div>`;
    },
    apply(k) {
      const d = this.d, o = this.opt, w = k === 'minVar' ? o.fr.minVar.w : k === 'maxSharpe' ? o.fr.maxSharpe.w : o.rp;
      d.pos.forEach((p, i) => { const prec = d.px[i] > 1000 ? 4 : d.px[i] > 10 ? 0 : 2; p.qty = +((w[i] * d.V) / d.px[i]).toFixed(prec); });
      this.save(); APP.toast('Rebalanced to target weights at current prices', 'ok'); this.compute();
    },
    corr() { const d = this.d, syms = d.pos.map(p => p.sym); CK.heatmap($('#pCorr'), { rows: syms, cols: syms, values: U.corrFromCov(U.covMatrix(d.R)), fmt: v => v.toFixed(2), color: v => CK.divergingColor(v, 1, 0.95), padL: 72 }); },
    stress() {
      const d = this.d, dts = d.dates, n = d.R[0].length, s = d.fmap.map(m => m ? dts.slice(-n - 1).map(t => m.get(t)) : null);
      const ok = s.every(a => a && a.every(isFinite));
      const X = ok ? U.range(n, i => [1, s[0][i + 1] / s[0][i] - 1, (s[1][i + 1] - s[1][i]) / 100, s[2][i + 1] / s[2][i] - 1, s[3][i + 1] / s[3][i] - 1]) : null;
      const loads = d.R.map(r => {
        if (!X) return [0, 1, 0, 0, 0];
        const XtX = U.range(5, i => U.range(5, j => U.sum(X.map(x => x[i] * x[j])) + (i === j && i > 0 ? 1e-6 : 0))), Xty = U.range(5, i => U.sum(X.map((x, t) => x[i] * r[t])));
        try { return U.solveLinear(XtX, Xty); } catch (e) { return [0, 1, 0, 0, 0]; }
      });
      const res = STRESS.map(([name, sc]) => { const per = d.pos.map((p, i) => d.mv[i] * (loads[i][1] * sc.m + loads[i][2] * sc.r + loads[i][3] * sc.o + loads[i][4] * sc.d)); return { name, sc, total: U.sum(per), per }; });
      $('#pStress').innerHTML = `<table class="tbl"><thead><tr><th>Scenario</th><th class="r">P&amp;L</th><th class="r">%</th><th>Worst</th></tr></thead><tbody>
        ${res.map(r => { const wi = r.per.indexOf(Math.min(...r.per)); return `<tr><td class="wrap">${r.name}<div class="muted small">S&amp;P ${U.fmtPct(r.sc.m, 0)} · 10y ${U.fmtBp(r.sc.r)} · oil ${U.fmtPct(r.sc.o, 0)} · USD ${U.fmtPct(r.sc.d, 0)}</div></td><td class="r ${U.cls(r.total)}">${U.fmtBig(r.total, 1)}</td><td class="r ${U.cls(r.total)}">${U.fmtPct(r.total / d.V, 1)}</td><td class="muted">${esc(d.pos[wi].sym)}</td></tr>`; }).join('')}
      </tbody></table><div class="hint">Each holding's daily returns over the last year are regressed on the S&amp;P 500, the 10-year Treasury yield, WTI oil and the US Dollar Index; the scenario shocks are applied to those sensitivities.</div>`;
    },
  });

  // ======================================================================== CURVE — FRED
  const tenLab = t => t < 0.99 ? Math.round(t * 12) + 'M' : Math.round(t) + 'Y';
  APP.register('CURVE', {
    title: 'US Treasury Curve & Bond Analytics', global: true,
    async render(root) {
      this.shift = this.shift || { par: 0, twist: 0, fly: 0 };
      const today = new Date(), mat = new Date(Date.UTC(today.getUTCFullYear() + 10, today.getUTCMonth(), 15));
      root.innerHTML = `
        <div class="toolbar"><span id="cvDate" class="muted small">Loading Treasury yields…</span></div>
        <div class="kvgrid c6 strip" id="cvStrip"></div>
        <div class="grid g3">
          ${panel('Par yield curve', '<div class="cv"><canvas id="cvPar"></canvas></div>', { cls: 'span2' })}
          ${panel('Curve shift', `<div class="fields">
            <div class="field"><label for="sh_par">Parallel shift <span id="shv_par" class="mono"></span></label><input type="range" id="sh_par" min="-200" max="200" step="5" value="${this.shift.par}"></div>
            <div class="field"><label for="sh_twist">Steepener (+) / flattener (−) at 30y <span id="shv_twist" class="mono"></span></label><input type="range" id="sh_twist" min="-150" max="150" step="5" value="${this.shift.twist}"></div>
            <div class="field"><label for="sh_fly">Belly vs wings (butterfly) <span id="shv_fly" class="mono"></span></label><input type="range" id="sh_fly" min="-100" max="100" step="5" value="${this.shift.fly}"></div></div>
            <button class="btn ghost sm" id="shReset">Reset</button><div id="shOut" class="mt"></div>`)}
          ${panel('Fitted, zero and forward curves', '<div class="cv"><canvas id="cvZero"></canvas></div><div id="cvFit" class="hint"></div>', { cls: 'span2' })}
          ${panel('Spread history', '<div class="cv"><canvas id="cvSpr"></canvas></div>')}
          ${panel('Bond calculator', `<div class="fields" id="bIn">
              <div class="field"><label for="b_cpn">Coupon %</label><input class="num" id="b_cpn" type="number" step="0.125" value="4.25"></div>
              <div class="field"><label for="b_mat">Maturity</label><input class="txt" id="b_mat" type="date" value="${mat.toISOString().slice(0, 10)}"></div>
              <div class="field"><label for="b_freq">Coupons a year</label><select id="b_freq"><option value="2" selected>2</option><option value="1">1</option><option value="4">4</option></select></div>
              <div class="field"><label for="b_dc">Day count</label><select id="b_dc"><option>ACT/ACT</option><option>30/360</option></select></div>
              <div class="field"><label for="b_mode">Solve for</label><select id="b_mode"><option value="price">Price from yield</option><option value="yield">Yield from price</option><option value="curve">Price off the curve + spread</option></select></div>
              <div class="field"><label for="b_val" id="b_valL">Yield %</label><input class="num" id="b_val" type="number" step="0.01" value="4.30"></div>
            </div><div id="bOut" class="kvgrid c3 mt"></div>`, { cls: 'span2' })}
          ${panel('Key-rate durations', '<div class="cv sm"><canvas id="bKrd"></canvas></div><div id="bShift" class="mt"></div>')}
          ${panel('Price–yield relationship', '<div class="cv"><canvas id="bPy"></canvas></div>', { cls: 'span2' })}
          ${panel('Cash flows', '<div id="bCf" class="tblwrap short"></div>')}
        </div>`;
      ['par', 'twist', 'fly'].forEach(k => $('#sh_' + k).addEventListener('input', e => { this.shift[k] = +e.target.value; this.drawCurves(); this.bond(); }));
      $('#shReset').addEventListener('click', () => { this.shift = { par: 0, twist: 0, fly: 0 }; ['par', 'twist', 'fly'].forEach(k => $('#sh_' + k).value = 0); this.drawCurves(); this.bond(); });
      $('#bIn').addEventListener('change', e => { if (e.target.id === 'b_mode') { const m = e.target.value; $('#b_valL').textContent = m === 'price' ? 'Yield %' : m === 'yield' ? 'Clean price' : 'Spread to curve (bp)'; $('#b_val').value = m === 'price' ? '4.30' : m === 'yield' ? '99.50' : '0'; } this.bond(); });
      try { this.data = await HUB.curve(); } catch (e) { $('#cvDate').innerHTML = `<span class="down">${esc(e.message)}</span> <button class="btn ghost sm" id="cvRetry">Try again</button>`; $('#cvRetry').addEventListener('click', () => this.render(root)); return; }
      const fit = Q.fitNSS(this.data.now.map(x => x[0]), this.data.now.map(x => x[1]));
      this.data.nss = fit.p; this.fit = fit;
      $('#cvDate').textContent = `${this.data.source} · as of ${this.data.date}`;
      this.drawCurves(); this.bond(); this.spreads();
    },
    shiftFn() { const s = this.shift; return t => (s.par + s.twist * U.clamp(Math.log(t / 5) / Math.log(30 / 5), -1, 1) + s.fly * (2 * Math.exp(-Math.pow(Math.log(t / 5), 2) / 0.5) - 1)) / 1e4; },
    curves() {
      const sf = this.shiftFn(), dense = U.range(60, i => (i + 1) / 2).map(t => [t, Q.nss(this.data.nss, t)]), ten = dense.map(x => x[0]);
      return { sf, base: Q.bootstrapPar(ten, dense.map(x => x[1])), shifted: Q.bootstrapPar(ten, dense.map(x => x[1] + sf(x[0]))) };
    },
    drawCurves() {
      const d = this.data, col = CK.colors(), c = this.curves(), pts = arr => arr.map(x => [Math.log(x[0] * 12), x[1] * 100]);
      const xt = [1 / 12, 0.25, 1, 2, 5, 10, 30].map(t => Math.log(t * 12)), s = this.shift;
      ['par', 'twist', 'fly'].forEach(k => { const el = document.getElementById('shv_' + k); if (el) el.textContent = (s[k] > 0 ? '+' : '') + s[k] + 'bp'; });
      const anyShift = s.par || s.twist || s.fly;
      CK.xy($('#cvPar'), { series: [{ name: 'Now', data: pts(d.now), color: col.accent, width: 2.2, points: true }, { name: '1 week ago', data: pts(d.w1), color: col.series[2], dash: [3, 3] }, { name: '1 month ago', data: pts(d.m1), color: col.key, dash: [5, 3] }, { name: '1 year ago', data: pts(d.y1), color: col.muted, dash: [2, 3] },
        anyShift ? { name: 'Shifted', data: pts(d.now.map(x => [x[0], x[1] + c.sf(x[0])])), color: col.down, width: 2 } : null].filter(Boolean), xTicks: xt, xFmt: v => tenLab(Math.exp(v) / 12), yFmt: v => v.toFixed(2) + '%' });
      const grid = U.linspace(0.5, 29, 58);
      CK.xy($('#cvZero'), { series: [{ name: 'Fitted par (NSS)', data: grid.map(t => [t, Q.nss(d.nss, t) * 100]), color: col.accent }, { name: 'Observed par', type: 'scatter', data: d.now.map(x => [x[0], x[1] * 100]), color: col.text, r: 3 },
        { name: 'Zero (cont.)', data: grid.map(t => [t, c.base.fn(t) * 100]), color: col.key }, { name: '1y forward', data: grid.map(t => [t, Q.forwardRate(c.base.fn, t, t + 1) * 100]), color: col.series[3] }], xFmt: v => v.toFixed(0) + 'y', yFmt: v => v.toFixed(2) + '%' });
      const rmse = Math.sqrt(U.mean(this.fit.resid.map(x => x * x))) * 1e4;
      $('#cvFit').textContent = `Nelson-Siegel-Svensson fitted to ${d.now.length} par-yield tenors by least squares (RMSE ${rmse.toFixed(1)}bp); zero and forward rates are bootstrapped from the fitted par curve.`;
      const y = t => (d.now.find(x => Math.abs(x[0] - t) < 1e-6) || [0, NaN])[1], yo = t => (d.y1.find(x => Math.abs(x[0] - t) < 1e-6) || [0, NaN])[1];
      $('#cvStrip').innerHTML = [0.25, 2, 5, 10, 30].map(t => kv(tenLab(t), U.fmtPct(y(t), 2, false) + ` <small class="${U.cls(y(t) - yo(t))}">${U.fmtBp(y(t) - yo(t))} 1y</small>`)).join('') + kv('2s10s', U.fmt((y(10) - y(2)) * 1e4, 0) + 'bp', U.cls(y(10) - y(2)));
      $('#shOut').innerHTML = anyShift ? `<table class="tbl"><thead><tr><th>Tenor</th><th class="r">Now</th><th class="r">Shifted</th><th class="r">Change</th></tr></thead><tbody>${[2, 5, 10, 30].map(t => `<tr><td>${tenLab(t)}</td><td class="r">${U.fmtPct(y(t), 2, false)}</td><td class="r">${U.fmtPct(y(t) + c.sf(t), 2, false)}</td><td class="r ${U.cls(c.sf(t))}">${U.fmtBp(c.sf(t))}</td></tr>`).join('')}</tbody></table>` : '<div class="muted small">Move a slider to shift the curve and reprice the bond.</div>';
    },
    spreads() {
      const sp = this.data.spreads, col = CK.colors(), toT = a => a.slice(-750).map(([d, v]) => [Date.parse(d), v * 100]);
      CK.xy($('#cvSpr'), { series: [{ name: '10y − 2y', data: toT(sp.T10Y2Y || []), color: col.accent }, { name: '10y − 3m', data: toT(sp.T10Y3M || []), color: col.key }], hlines: [{ y: 0, color: col.dim }], xFmt: t => new Date(t).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }), yFmt: v => v.toFixed(0) + 'bp' });
    },
    bond() {
      if (!this.data) return;
      const g = id => $('#b_' + id).value, settle = new Date(); settle.setUTCHours(0, 0, 0, 0);
      const maturity = new Date(g('mat') + 'T00:00:00Z'), coupon = parseFloat(g('cpn')) / 100, freq = +g('freq'), conv = g('dc'), mode = g('mode'), val = parseFloat(g('val'));
      if (!(maturity > settle) || !isFinite(coupon) || !isFinite(val)) { $('#bOut').innerHTML = '<div class="muted small">Enter a maturity after today, a coupon and a value.</div>'; return; }
      const c = this.curves(); let b;
      try {
        if (mode === 'price') b = Q.bondAnalytics({ coupon, freq, settle, maturity, ytm: val / 100, conv });
        else if (mode === 'yield') b = Q.bondAnalytics({ coupon, freq, settle, maturity, clean: val, conv });
        else b = Q.bondAnalytics({ coupon, freq, settle, maturity, conv, zeroFn: c.base.fn, spread: val / 1e4 });
      } catch (e) { $('#bOut').innerHTML = errBox(e); return; }
      const pvAt = (fn, s) => b.flows.reduce((a, f) => a + f.cf * Math.exp(-(fn(f.tYears) + s) * f.tYears), 0);
      const z = U.bisect(s => pvAt(c.base.fn, s) - b.dirty, -0.05, 0.5, 1e-10), T = (maturity - settle) / U.DAY / 365.25, curveY = Q.parYield(c.base.fn, T);
      $('#bOut').innerHTML = kv('Clean price', U.fmt(b.clean, 4), 'key') + kv('Accrued interest', U.fmt(b.accrued, 4)) + kv('Dirty price', U.fmt(b.dirty, 4)) + kv('Yield to maturity', U.fmtPct(b.ytm, 3, false), 'key') + kv('Current yield', U.fmtPct(b.currentYield, 3, false)) + kv('Spread to Treasury curve', U.fmtBp(b.ytm - curveY)) +
        kv('Z-spread', U.fmtBp(z)) + kv('Macaulay duration', U.fmt(b.macaulay, 3) + 'y') + kv('Modified duration', U.fmt(b.modified, 3)) + kv('Convexity', U.fmt(b.convexity, 2)) + kv('DV01 per 100', U.fmt(b.dv01, 4)) + kv('Next coupon', b.next.toISOString().slice(0, 10));
      const krd = Q.keyRateDurations(b.flows.map(f => ({ ...f, cf: f.cf * Math.exp(-z * f.tYears) })), c.base.fn);
      CK.bars($('#bKrd'), { labels: krd.map(k => tenLab(k.key)), values: krd.map(k => k.krd), fmt: v => v.toFixed(2) });
      const full = pvAt(c.shifted.fn, z), dyMat = c.sf(T), approx = b.dirty * (-b.modified * dyMat + 0.5 * b.convexity * dyMat * dyMat);
      $('#bShift').innerHTML = (this.shift.par || this.shift.twist || this.shift.fly) ? `<div class="kvgrid c2">${kv('Yield change at maturity', U.fmtBp(dyMat))}${kv('Full repricing', U.fmtSigned(full - b.dirty, 3), U.cls(full - b.dirty))}${kv('Duration + convexity', U.fmtSigned(approx, 3))}${kv('Approximation error', U.fmt(full - b.dirty - approx, 4))}</div>` : '<div class="muted small">Shift the curve to compare full repricing with the duration/convexity estimate.</div>';
      const col = CK.colors(), ys = U.linspace(Math.max(0.0001, b.ytm - 0.03), b.ytm + 0.03, 61);
      CK.xy($('#bPy'), { series: [{ name: 'Price', data: ys.map(y => [y * 100, b.dirtyFromY(y) - b.accrued]), color: col.accent, width: 2 }, { name: 'Duration only', data: ys.map(y => [y * 100, b.clean + b.dirty * (-b.modified * (y - b.ytm))]), color: col.muted, dash: [4, 3] },
        { name: 'Duration + convexity', data: ys.map(y => [y * 100, b.clean + b.dirty * (-b.modified * (y - b.ytm) + 0.5 * b.convexity * (y - b.ytm) ** 2)]), color: col.key, dash: [2, 2] }], marks: [{ x: b.ytm * 100, y: b.clean, color: col.text, label: 'today' }], xFmt: v => v.toFixed(1) + '%', yFmt: v => v.toFixed(1) });
      $('#bCf').innerHTML = `<table class="tbl"><thead><tr><th>Date</th><th class="r">Cash flow</th><th class="r">PV</th></tr></thead><tbody>${b.flows.map(f => `<tr><td>${f.date.toISOString().slice(0, 10)}</td><td class="r">${U.fmt(f.cf, 3)}</td><td class="r">${U.fmt(f.pv, 3)}</td></tr>`).join('')}</tbody></table>`;
    },
  });

  // ======================================================================== FX
  const CCY = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'CNY', 'MNT'];
  const PAIR = { EUR: ['EURUSD=X', 1], GBP: ['GBPUSD=X', 1], AUD: ['AUDUSD=X', 1], JPY: ['JPY=X', -1], CHF: ['CHF=X', -1], CAD: ['CAD=X', -1], CNY: ['CNY=X', -1], MNT: ['MNT=X', -1] };
  const usdVal = (c, prev) => { if (c === 'USD') return 1; const [s, d] = PAIR[c], q = HUB.quote(s); if (!q) return NaN; const v = prev ? q.prev : q.last; return d > 0 ? v : 1 / v; };
  APP.register('FX', {
    title: 'Foreign Exchange', global: true,
    async render(root) {
      root.innerHTML = `
        <div class="grid g3">
          ${panel('Cross rates · units of column currency per 1 row currency', '<div id="fxM" class="tblwrap"><div class="muted small">Loading…</div></div>', { cls: 'span2' })}
          ${panel('Converter', `<div class="fields"><div class="field"><label for="fxA">Amount</label><input class="num" id="fxA" type="number" value="1000000"></div>
            <div class="field"><label for="fxF">From</label><select id="fxF">${CCY.map(c => `<option ${c === 'USD' ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
            <div class="field"><label for="fxT">To</label><select id="fxT">${CCY.map(c => `<option ${c === 'MNT' ? 'selected' : ''}>${c}</option>`).join('')}</select></div></div><div id="fxOut" class="bignum mt"></div><div id="fxFwd" class="tblwrap mt"></div>`)}
          ${panel('Short-term interest rates (editable)', '<div id="fxIr" class="fields"><div class="muted small">Loading…</div></div>')}
          ${panel('Carry-to-risk vs USD · 1 year', '<div class="cv"><canvas id="fxCarry"></canvas></div>', { cls: 'span2' })}
          ${panel('1-month performance vs USD', '<div class="cv"><canvas id="fxPerf"></canvas></div>')}
          ${panel('Correlation of daily moves vs USD · 1 year', '<div class="cv tall"><canvas id="fxCorr"></canvas></div>', { cls: 'span2' })}
        </div>`;
      $('#fxA').addEventListener('input', () => this.convert()); $('#fxF').addEventListener('change', () => this.convert()); $('#fxT').addEventListener('change', () => this.convert());
      const syms = Object.values(PAIR).map(p => p[0]);
      HUB.track('screen', syms);
      await Promise.all(syms.filter(s => !HUB.quote(s)).map(s => HUB.refreshQuote(s).catch(() => null)));
      try { const r = await HUB.fxRates(); this.rates = this.rates || Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.rate])); this.rsrc = r; } catch (e) { this.rates = this.rates || { USD: 0.04, EUR: 0.02, GBP: 0.0375, JPY: 0.0075, CHF: 0, CAD: 0.025, AUD: 0.036, CNY: 0.014, MNT: 0.125 }; this.rsrc = {}; }
      $('#fxIr').innerHTML = CCY.map(c => `<div class="field"><label for="ir_${c}" title="${esc((this.rsrc[c] || {}).source || '')}">${c} <span class="muted small">${esc(((this.rsrc[c] || {}).source || '').replace('FRED ', ''))}${(this.rsrc[c] || {}).date ? ' · ' + this.rsrc[c].date : ''}</span></label><div class="inwrap"><input class="num" id="ir_${c}" type="number" step="0.05" value="${(this.rates[c] * 100).toFixed(2)}"><em>%</em></div></div>`).join('');
      CCY.forEach(c => $('#ir_' + c).addEventListener('change', e => { this.rates[c] = parseFloat(e.target.value) / 100; this.convert(); this.carry(); }));
      this.hist = {}; await Promise.all(syms.map(async s => { try { this.hist[s] = await HUB.history(s, '1D'); } catch (e) { /* skip */ } }));
      this.matrix(); this.convert(); this.carry(); this.corr();
    },
    matrix() {
      const now = CCY.map(c => usdVal(c)), prev = CCY.map(c => usdVal(c, true));
      $('#fxM').innerHTML = `<table class="tbl fxm"><thead><tr><th></th>${CCY.map(c => `<th class="r">${c}</th>`).join('')}</tr></thead><tbody>${CCY.map((r, i) => `<tr><th>${r}</th>${CCY.map((c, j) => {
        if (i === j) return '<td class="r muted">—</td>';
        const x = now[i] / now[j], ch = x / (prev[i] / prev[j]) - 1; if (!isFinite(x)) return '<td class="r muted">n/a</td>';
        return `<td class="r" style="background:${CK.divergingColor(ch, 0.01, 0.7)}" title="${r}/${c} ${U.fmtPct(ch, 2)} today">${U.fmt(x, x >= 1000 ? 1 : x >= 10 ? 3 : 5)}</td>`; }).join('')}</tr>`).join('')}</tbody></table><div class="hint">Yahoo Finance FX rates; colour shows today's move of the row currency against the column currency.</div>`;
    },
    convert() {
      const a = parseFloat($('#fxA').value), f = $('#fxF').value, t = $('#fxT').value; if (!isFinite(a) || !this.rates) return;
      const x = usdVal(f) / usdVal(t);
      $('#fxOut').innerHTML = `${U.fmt(a, 2)} ${f} = <b>${U.fmt(a * x, x * a > 1000 ? 2 : 4)} ${t}</b><div class="muted small">1 ${f} = ${U.fmt(x, 6)} ${t} · 1 ${t} = ${U.fmt(1 / x, 6)} ${f}</div>`;
      const rb = this.rates[f], rq = this.rates[t];
      $('#fxFwd').innerHTML = `<table class="tbl"><thead><tr><th>Forward ${f}/${t}</th><th class="r">Outright</th><th class="r">Points</th></tr></thead><tbody>${[['1 month', 1 / 12], ['3 months', 0.25], ['6 months', 0.5], ['1 year', 1]].map(([l, T]) => { const F = x * (1 + rq * T) / (1 + rb * T); return `<tr><td>${l}</td><td class="r">${U.fmt(F, 6)}</td><td class="r ${U.cls(F - x)}">${U.fmtSigned((F - x) / x * 1e4, 1)}bp</td></tr>`; }).join('')}</tbody></table><div class="hint">Covered interest parity: F = S × (1 + r<sub>${t}</sub>T) / (1 + r<sub>${f}</sub>T). Holding ${f} against ${t} earns ${U.fmtPct(rb - rq, 2)} a year in carry.</div>`;
    },
    series(c) { const [s, d] = PAIR[c], h = this.hist[s]; return h ? h.map(b => ({ t: b.t, v: d > 0 ? b.c : 1 / b.c })) : null; },
    carry() {
      const res = CCY.filter(c => c !== 'USD').map(c => { const s = this.series(c); if (!s) return null; const v = s.map(x => x.v); return { c, carry: this.rates[c] - this.rates.USD, vol: Q.realizedVol(v, 252), m1: U.last(v) / v[v.length - 22] - 1 }; }).filter(Boolean).map(r => ({ ...r, ratio: r.carry / r.vol })).sort((a, b) => b.ratio - a.ratio);
      CK.bars($('#fxCarry'), { horizontal: true, labels: res.map(r => `${r.c} (${U.fmtPct(r.carry, 1)} / ${U.fmtPct(r.vol, 0, false)} vol)`), values: res.map(r => r.ratio), fmt: v => U.fmt(v, 2), padL: 190 });
      const p = [...res].sort((a, b) => b.m1 - a.m1);
      CK.bars($('#fxPerf'), { horizontal: true, labels: p.map(r => r.c), values: p.map(r => r.m1), fmt: v => U.fmtPct(v, 2), padL: 50 });
    },
    corr() {
      const cs = CCY.filter(c => c !== 'USD' && this.series(c)), ser = cs.map(c => new Map(this.series(c).map(x => [U.isoDate(x.t), x.v])));
      const dates = [...ser[0].keys()].filter(d => ser.every(m => m.has(d))).sort().slice(-253);
      const R = ser.map(m => U.returns(dates.map(d => m.get(d))));
      CK.heatmap($('#fxCorr'), { rows: cs, cols: cs, values: U.corrFromCov(U.covMatrix(R)), fmt: v => v.toFixed(2), color: v => CK.divergingColor(v, 1, 0.95), padL: 44 });
    },
    onTick() { if (!this._t) this._t = setTimeout(() => { this._t = null; if (APP.state.screen === 'FX' && $('#fxM') && this.rates) { this.matrix(); this.convert(); } }, 2000); },
  });

  // ======================================================================== SCRN
  const SCOLS = [['sym', 'Ticker'], ['sector', 'Sector'], ['price', 'Price'], ['chg', '1D'], ['mom1m', '1M'], ['mom6m', '6M'], ['mom12m', '12M'], ['vol', 'Vol'], ['beta', 'Beta'], ['cap', 'Mkt cap $bn'], ['pe', 'P/E'], ['fpe', 'Fwd P/E'], ['evebitda', 'EV/EBITDA'], ['ps', 'P/S'], ['growth', 'Rev growth'], ['margin', 'Op margin'], ['fcfy', 'FCF yld'], ['dy', 'Div yld'], ['tgtup', 'Target up'], ['rsi', 'RSI'], ['score', 'Score']];
  const PCT = new Set(['chg', 'mom1m', 'mom6m', 'mom12m', 'vol', 'growth', 'margin', 'fcfy', 'dy', 'tgtup']);
  const SIGNED = new Set(['chg', 'mom1m', 'mom6m', 'mom12m', 'tgtup', 'growth']);
  const FIELDS = SCOLS.map(c => c[0]).filter(k => k !== 'sym' && k !== 'sector');
  APP.register('SCRN', {
    title: 'Equity Screener · US large caps', global: true,
    async render(root) {
      this.sort = this.sort || ['score', -1]; this.expr = this.expr ?? ''; this.sector = this.sector || '';
      root.innerHTML = `
        <div class="toolbar"><input class="txt wide" id="sx" placeholder="Filter, e.g. pe < 25 and fcfy > 3% and mom6m > 0" value="${esc(this.expr)}"><select id="sSec"><option value="">All sectors</option></select>
          ${['tgtup > 15%', 'pe < 20 and growth > 5%', 'mom6m > 10% and vol < 30%', 'fcfy > 4% and beta < 1', 'score > 0.5'].map(x => `<button class="chipbtn" data-x="${x}">${x}</button>`).join('')}</div>
        <div id="sErr" class="small down"></div>
        <div class="grid g3">${panel('Results', '<div id="sTbl" class="tblwrap"><div class="muted small">Loading 65 companies from Yahoo Finance… the first load can take 20–60 seconds.</div></div><div class="hint">Fields: ' + FIELDS.join(', ') + '. Percentages can be written as 5% or 0.05. Click a header to sort, a row to open the company.</div>', { cls: 'span2' })}
          ${panel('Factor map', `<div class="row"><select id="sX">${FIELDS.map(f => `<option ${f === 'vol' ? 'selected' : ''}>${f}</option>`).join('')}</select><span class="muted">vs</span><select id="sY">${FIELDS.map(f => `<option ${f === 'mom12m' ? 'selected' : ''}>${f}</option>`).join('')}</select></div><div class="cv tall"><canvas id="sSc"></canvas></div>`)}</div>`;
      $('#sx').addEventListener('change', e => { this.expr = e.target.value; this.draw(); });
      $('#sSec').addEventListener('change', e => { this.sector = e.target.value; this.draw(); });
      root.addEventListener('click', e => { const b = e.target.closest('[data-x]'); if (b) { $('#sx').value = this.expr = b.dataset.x; this.draw(); } const h = e.target.closest('[data-sort]'); if (h) { const k = h.dataset.sort; this.sort = [k, this.sort[0] === k ? -this.sort[1] : -1]; this.draw(); } const r = e.target.closest('tr[data-s]'); if (r) APP.open('DES', r.dataset.s); });
      $('#sX').addEventListener('change', () => this.scatter()); $('#sY').addEventListener('change', () => this.scatter());
      let u; try { u = await HUB.universe(); } catch (e) { $('#sTbl').innerHTML = errBox(e); return; }
      window.AGULA_UNIVERSE = u.rows;
      this.rows = u.rows.map(r => ({ ...r }));
      const z = k => { const v = this.rows.map(r => r[k]).filter(U.isNum), m = U.mean(v), s = U.std(v) || 1; return r => U.isNum(r[k]) ? U.clamp((r[k] - m) / s, -3, 3) : 0; };
      const zf = z('fcfy'), zt = z('tgtup'), zm = z('mom6m'), zq = z('margin'), zv = z('vol');
      this.rows.forEach(r => r.score = (zf(r) + zt(r) + zm(r) + zq(r) - zv(r)) / 5);
      $('#sSec').innerHTML = '<option value="">All sectors</option>' + [...new Set(this.rows.map(r => r.sector))].sort().map(s => `<option ${s === this.sector ? 'selected' : ''}>${esc(s)}</option>`).join('');
      this.asof = u.asof; this.draw();
    },
    draw() {
      if (!this.rows) return;
      let rows = this.rows.filter(r => !this.sector || r.sector === this.sector);
      $('#sErr').textContent = '';
      if (this.expr.trim()) { try { const f = Q.compileExpr(this.expr, FIELDS); rows = rows.filter(f); } catch (e) { $('#sErr').textContent = e.message; } }
      const [k, d] = this.sort; rows.sort((a, b) => ((a[k] ?? -Infinity) > (b[k] ?? -Infinity) ? 1 : -1) * d);
      const fmt = (c, v) => v == null || (typeof v === 'number' && !isFinite(v)) ? '—' : c === 'sym' ? `<b class="key">${esc(v)}</b>` : c === 'sector' ? `<span class="muted">${esc(v)}</span>` : PCT.has(c) ? `<span class="${SIGNED.has(c) ? U.cls(v) : ''}">${U.fmtPct(v, 1, SIGNED.has(c))}</span>` : c === 'price' ? U.fmtPx(v) : c === 'cap' ? U.fmt(v, 0) : ['pe', 'fpe', 'evebitda', 'ps'].includes(c) ? U.fmtX(v) : c === 'score' ? `<span class="${U.cls(v)}">${U.fmt(v, 2)}</span>` : U.fmt(v, c === 'rsi' ? 0 : 2);
      $('#sTbl').innerHTML = `<table class="tbl scrn"><thead><tr>${SCOLS.map(([c, l]) => `<th class="${c === 'sym' || c === 'sector' ? '' : 'r'} srt ${k === c ? 'on' : ''}" data-sort="${c}">${l}${k === c ? (d > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead><tbody>
        ${rows.map(r => `<tr class="clk" data-s="${esc(r.sym)}" title="${esc(r.name)}">${SCOLS.map(([c]) => `<td class="${c === 'sym' || c === 'sector' ? '' : 'r'}">${fmt(c, r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table>
        <div class="muted small mt">${rows.length} of ${this.rows.length} companies · data as of ${new Date(this.asof).toLocaleString()}. Score = average z-score of FCF yield, analyst target upside, 6-month momentum, operating margin and low volatility. Source: Yahoo Finance.</div>`;
      this.shown = rows; this.scatter();
    },
    scatter() {
      if (!this.rows) return;
      const x = $('#sX').value, y = $('#sY').value, rows = this.shown || this.rows, mc = Math.max(...rows.map(r => r.cap || 0)) || 1;
      const f = k => PCT.has(k) ? (v => (v * 100).toFixed(0) + '%') : (v => U.fmt(v, 1));
      CK.xy($('#sSc'), { series: [{ type: 'scatter', data: rows.filter(r => U.isNum(r[x]) && U.isNum(r[y])).map(r => [r[x], r[y], CK.divergingColor(r.score, 1.2), 3 + 9 * Math.sqrt((r.cap || 0) / mc), r.sym]) }], xFmt: f(x), yFmt: f(y), hover: false, legend: false });
    },
  });
})();
