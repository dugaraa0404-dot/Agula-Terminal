/* ============================================================================
   Agula Terminal — NEWS: market news by theme, next to the prices each theme moves
   ========================================================================== */
'use strict';

(() => {
  const { panel, $, $$ } = APP;
  const esc = U.esc;

  // Names in headlines -> symbols (shown as clickable chips under each headline)
  const ENTITIES = [
    [/\bApple\b/i, 'AAPL'], [/\bMicrosoft\b/i, 'MSFT'], [/\bNvidia\b/i, 'NVDA'], [/\bAmazon\b/i, 'AMZN'], [/\b(Alphabet|Google)\b/i, 'GOOGL'],
    [/\bMeta\b/, 'META'], [/\bTesla\b/i, 'TSLA'], [/\bJPMorgan\b/i, 'JPM'], [/\bGoldman\b/i, 'GS'], [/\bMorgan Stanley\b/i, 'MS'], [/\bBank of America\b/i, 'BAC'],
    [/\bExxon/i, 'XOM'], [/\bChevron\b/i, 'CVX'], [/\bBerkshire\b/i, 'BRK-B'], [/\bOracle\b/i, 'ORCL'], [/\bNetflix\b/i, 'NFLX'], [/\bBroadcom\b/i, 'AVGO'],
    [/\bAMD\b/, 'AMD'], [/\bIntel\b/i, 'INTC'], [/\bTSMC\b|\bTaiwan Semiconductor\b/i, 'TSM'], [/\bWalmart\b/i, 'WMT'], [/\bBoeing\b/i, 'BA'],
    [/\bEli Lilly\b|\bLilly\b/i, 'LLY'], [/\bUnitedHealth\b/i, 'UNH'], [/\bRio Tinto\b/i, 'RIO'], [/\bBitcoin\b/i, 'BTC-USD'], [/\bEther(eum)?\b/i, 'ETH-USD'],
    [/\bgold\b/i, 'GC=F'], [/\b(oil|crude|OPEC)\b/i, 'CL=F'], [/\bcopper\b/i, 'HG=F'], [/\bnatural gas\b/i, 'NG=F'], [/\b(Treasur(y|ies)|bond yields?)\b/i, '^TNX'],
    [/\bdollar\b/i, 'DX-Y.NYB'], [/\byen\b/i, 'JPY=X'], [/\byuan\b/i, 'CNY=X'], [/\btugrik\b|\btögrög\b/i, 'MNT=X'], [/\beuro\b/i, 'EURUSD=X'],
    [/\bS&P 500\b/i, '^GSPC'], [/\bNasdaq\b/i, '^NDX'], [/\bDow\b/, '^DJI'], [/\bNikkei\b/i, '^N225'], [/\bHang Seng\b/i, '^HSI'], [/\bVIX\b/, '^VIX'],
  ];
  const tickersIn = title => [...new Set(ENTITIES.filter(([re]) => re.test(title)).map(([, s]) => s))].slice(0, 4);

  // A "normal" daily move per asset class, to compare today's move against.
  const TYPICAL = { IDX: 0.01, EQ: 0.018, ETF: 0.012, FX: 0.005, CMDTY: 0.015, CRYPTO: 0.03, RATE: 0.05 };
  const moveOf = sym => {
    const q = HUB.quote(sym); if (!q || !isFinite(q.chgPct)) return null;
    const cls = HUB.cls(sym), rate = HUB.RATE.has(sym);
    const typical = sym === '^VIX' ? 0.05 : sym === 'DX-Y.NYB' ? 0.004 : TYPICAL[cls] || 0.015;
    return { q, rate, size: (rate ? Math.abs(q.chg) : Math.abs(q.chgPct)) / typical, txt: rate ? U.fmtBp(q.chg / 100) : U.fmtPct(q.chgPct, 2) };
  };
  const ago = ts => { if (!ts) return ''; const m = Math.round((Date.now() - ts) / 60e3); return m < 1 ? 'now' : m < 60 ? m + 'm ago' : m < 1440 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago'; };
  const heatLabel = h => h == null ? '—' : h < 0.6 ? 'calm' : h < 1.2 ? 'normal' : h < 2 ? 'active' : 'hot';

  APP.register('NEWS', {
    title: 'Market News by Theme', global: true,
    themeFor(text) {   // "FED", "mongolia", "energy & commodities" -> theme key
      const t = String(text).toLowerCase().trim(); if (!t) return null;
      const list = this.data ? this.data.themes : KEYS.map(k => ({ key: k, label: k }));
      const hit = list.find(x => x.key === t) || list.find(x => x.label.toLowerCase().startsWith(t)) || list.find(x => x.key.startsWith(t.slice(0, 3)));
      return hit ? hit.key : null;
    },
    async render(root, { sym }) {
      this.sym = sym; this.filter = '';
      root.innerHTML = `<div class="grid g3 newsgrid">
        <div class="stack">
          ${panel('Themes · how hard each is moving its markets today', '<div id="nThemes"><div class="muted small">Loading headlines…</div></div><div class="hint">Heat compares today\'s moves in each theme\'s markets with a normal day for that asset class: 1.0 is a typical day, 2.0 is twice as big.</div>')}
          ${panel('Market reaction', '<div id="nReact"></div>', { badge: 'YAHOO' })}
        </div>
        <div class="stack span2">
          ${panel('<span id="nTitle">Headlines</span>', '<div class="row"><input class="txt wide" id="nFilter" placeholder="Filter these headlines, e.g. tariff, Powell, Nvidia"></div><div id="nList" class="mt"></div>', { badge: 'GOOGLE NEWS' })}
          ${panel('Latest across all themes', '<div id="nLatest"></div>')}
          ${panel(`${esc(sym)} · company news`, '<div id="nCo"><div class="muted small">Loading…</div></div>', { badge: 'YAHOO' })}
        </div></div>`;
      $('#nFilter').addEventListener('input', e => { this.filter = e.target.value.trim().toLowerCase(); this.drawList(); });
      root.addEventListener('click', e => {
        const t = e.target.closest('[data-theme]'); if (t) { this.theme = t.dataset.theme; this.drawThemes(); this.drawList(); this.drawReaction(); return; }
        const s = e.target.closest('[data-s]'); if (s) { e.preventDefault(); APP.open('DES', s.dataset.s); }
      });
      HUB.news(sym).then(n => { if ($('#nCo')) $('#nCo').innerHTML = n && n.length ? n.slice(0, 10).map(x => this.item(x)).join('') : '<div class="muted small">No recent company news.</div>'; })
        .catch(e => { if ($('#nCo')) $('#nCo').innerHTML = `<div class="muted small">${esc(e.message)}</div>`; });
      try { this.data = await HUB.headlines(); } catch (e) { $('#nThemes').innerHTML = `<div class="empty err">${esc(e.message)}</div>`; return; }
      if (!this.theme || !this.data.themes.some(t => t.key === this.theme)) this.theme = this.data.themes[0].key;
      const all = [...new Set(this.data.themes.flatMap(t => t.watch))];
      HUB.track('screen', all); HUB.ensureMeta(all);
      await Promise.all(all.filter(s => !HUB.quote(s)).map(s => HUB.refreshQuote(s).catch(() => null)));
      HUB.sparks(all).then(sp => { this.sparks = sp; this.drawReaction(); }).catch(() => {});
      this.drawThemes(); this.drawList(); this.drawReaction(); this.drawLatest();
    },
    cur() { return this.data && this.data.themes.find(t => t.key === this.theme); },
    heat(t) { const m = t.watch.map(moveOf).filter(Boolean); return m.length ? U.mean(m.map(x => x.size)) : null; },
    item(x, tag) {
      const ts = x.ts || (typeof x.date === 'number' ? x.date * 1000 : Date.parse(x.date));
      const chips = tickersIn(x.title || '').map(s => { const m = moveOf(s); return `<a href="#" class="symchip" data-s="${esc(s)}" title="${esc(HUB.meta(s).name)}">${esc(s)}${m ? ` <span class="${U.cls(m.q.chg)}">${m.txt}</span>` : ''}</a>`; }).join('');
      return `<div class="nw"><a class="nwt" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>
        <div class="nwm">${tag ? `<span class="pill">${esc(tag)}</span> ` : ''}<span>${esc(x.site || '')}</span>${isFinite(ts) ? `<span title="${esc(new Date(ts).toLocaleString())}">${ago(ts)}</span>` : ''}${chips}</div></div>`;
    },
    drawThemes() {
      const el = $('#nThemes'); if (!el || !this.data) return;
      el.innerHTML = this.data.themes.map(t => {
        const h = this.heat(t), day = t.items.filter(x => x.ts && Date.now() - x.ts < 864e5).length;
        const top = t.watch.map(s => [s, moveOf(s)]).filter(x => x[1]).sort((a, b) => b[1].size - a[1].size)[0];
        return `<button class="theme ${t.key === this.theme ? 'on' : ''}" data-theme="${t.key}">
          <span class="tl"><b>${esc(t.label)}</b><small>${day} in 24h${t.error && !t.items.length ? ' · offline' : ''}</small></span>
          <span class="heat"><i style="width:${Math.min(100, (h || 0) / 2.5 * 100)}%" class="${h >= 2 ? 'hot' : h >= 1.2 ? 'act' : ''}"></i></span>
          <span class="hv">${h == null ? '—' : U.fmt(h, 1)} <small>${heatLabel(h)}</small></span>
          <span class="tm">${top ? `${esc(top[0])} <span class="${U.cls(top[1].q.chg)}">${top[1].txt}</span>` : ''}</span></button>`;
      }).join('');
    },
    drawList() {
      const t = this.cur(), el = $('#nList'); if (!t || !el) return;
      $('#nTitle').textContent = `Headlines · ${t.label}`;
      const rows = t.items.filter(x => !this.filter || (x.title + ' ' + x.site).toLowerCase().includes(this.filter));
      el.innerHTML = (t.error ? `<div class="warnbox">${esc(t.error)}</div>` : '') +
        (rows.length ? rows.map(x => this.item(x)).join('') : `<div class="muted small">${this.filter ? 'No headlines match the filter.' : 'No headlines.'}</div>`);
    },
    drawReaction() {
      const t = this.cur(), el = $('#nReact'); if (!t || !el) return;
      el.innerHTML = `<table class="tbl"><tbody>${t.watch.map((s, i) => { const m = moveOf(s), q = m && m.q;
        return `<tr class="clk" data-s="${esc(s)}"><td><b class="key">${esc(s)}</b><div class="muted small">${esc(HUB.meta(s).name)}</div></td>
          <td class="r">${q ? U.fmtPx(q.last) : '—'}</td><td class="r ${q ? U.cls(q.chg) : ''}">${m ? m.txt : '—'}</td><td class="sp"><canvas class="spk" id="nsp-${i}"></canvas></td></tr>`; }).join('')}</tbody></table>
        <div class="hint">The markets this theme usually moves. Click one for its overview.</div>`;
      if (this.sparks) t.watch.forEach((s, i) => { const v = this.sparks[s], c = document.getElementById('nsp-' + i); if (v && v.length > 2 && c) CK.spark(c, v); });
    },
    drawLatest() {
      const el = $('#nLatest'); if (!el || !this.data) return;
      const seen = new Set(), all = [];
      this.data.themes.forEach(t => t.items.forEach(x => { const k = x.title.toLowerCase().slice(0, 60); if (!seen.has(k)) { seen.add(k); all.push([x, t.label]); } }));
      all.sort((a, b) => (b[0].ts || 0) - (a[0].ts || 0));
      el.innerHTML = all.length ? all.slice(0, 15).map(([x, l]) => this.item(x, l)).join('') : '<div class="muted small">No headlines yet.</div>';
    },
    onTick(syms) {
      if (!this.data || this._t) return;
      this._t = setTimeout(() => { this._t = null; if (APP.state.screen === 'NEWS') { this.drawThemes(); this.drawReaction(); } }, 1500);
    },
  });
  const KEYS = ['markets', 'fed', 'economy', 'geopolitics', 'energy', 'asia', 'tech', 'earnings', 'crypto', 'mongolia'];
})();
