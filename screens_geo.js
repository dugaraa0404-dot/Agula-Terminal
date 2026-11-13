/* ============================================================================
   Agula Terminal — GEO: geopolitical risk map from the latest headlines
   Headlines (Google News) are tagged on the server by country, sea lane and theme,
   scored for recency and escalation, and drawn on a Natural Earth world map.
   ========================================================================== */
'use strict';

(() => {
  const { panel, kv, $, $$ } = APP;
  const esc = U.esc;
  const errBox = e => `<div class="empty err">${esc(e.message || e)}</div>`;
  const W = GEOWORLD;
  const toRad = Math.PI / 180;
  function project(lon, lat) {
    const l = lon * toRad, p = lat * toRad, p2 = p * p, p4 = p2 * p2;
    const x = l * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4)));
    const y = p * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4)));
    return [W.tx + W.k * x, W.ty - W.k * y];
  }
  const graticule = (() => {
    const lines = [];
    for (let lon = -180; lon <= 180; lon += 30) { const pts = []; for (let lat = -58; lat <= 84; lat += 2) pts.push(project(lon, lat)); lines.push(pts); }
    for (let lat = -30; lat <= 60; lat += 30) { const pts = []; for (let lon = -180; lon <= 180; lon += 3) pts.push(project(lon, lat)); lines.push(pts); }
    return lines.map(p => 'M' + p.map(q => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join('L')).join('');
  })();
  const outline = (() => { const pts = []; for (let lat = -58; lat <= 84; lat += 2) pts.push(project(-180, lat)); for (let lat = 84; lat >= -58; lat -= 2) pts.push(project(180, lat)); return 'M' + pts.map(q => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join('L') + 'Z'; })();

  // ---------------------------------------------------------------- little illustrations (line art, 24×24)
  const ICON = {
    conflict: '<path d="M12 2.5 19.5 5.5V11c0 4.6-3.2 8.6-7.5 10.3C7.7 19.6 4.5 15.6 4.5 11V5.5z"/><circle cx="12" cy="11.5" r="3.2"/><path d="M12 6.5v2M12 14.5v2M7 11.5h2M15 11.5h2"/>',
    sanctions: '<rect x="5" y="10.5" width="11" height="9" rx="1.5"/><path d="M7.5 10.5V8a3 3 0 0 1 6 0v2.5"/><path d="M10.5 14v2.2"/><path d="m17.5 4.5 4 4M21.5 4.5l-4 4"/>',
    energy: '<path d="M6 4.5h10a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1z"/><path d="M5 9h12M5 16h12"/><path d="M20.5 9.5c0 1.2-.9 2-1.8 2s-1.7-.8-1.7-2c0-1.1 1.7-3 1.7-3s1.8 1.9 1.8 3z"/>',
    shipping: '<path d="M2.5 15.5h19l-2.6 4H5.1z"/><path d="M5 15.5v-3h4v3M9 15.5v-5h4v5M13 15.5v-3h4v3"/><path d="M15 9.5V6h2v3.5"/><path d="M2 21.5c1.3 0 1.3-.8 2.6-.8s1.3.8 2.6.8 1.3-.8 2.6-.8 1.3.8 2.6.8 1.3-.8 2.6-.8 1.3.8 2.6.8 1.3-.8 2.6-.8"/>',
    politics: '<path d="M4 11.5h16v9H4z"/><path d="M8.5 14.5h7"/><path d="M8 11.5V4.5h8v7"/><path d="m10 8 1.4 1.4L14.5 6.2"/>',
    cyber: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 3v3.5M12 3v3.5M15 3v3.5M9 17.5V21M12 17.5V21M15 17.5V21M3 9h3.5M3 12h3.5M3 15h3.5M17.5 9H21M17.5 12H21M17.5 15H21"/>',
    diplomacy: '<path d="M3.5 5.5h10v7h-5l-3 2.5v-2.5h-2z"/><path d="M15.5 9.5h5v7h-2v2.5l-3-2.5h-5v-2"/><path d="M6.5 9h4"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.5 3.9 5.5 3.9 9s-1.3 6.5-3.9 9c-2.6-2.5-3.9-5.5-3.9-9S9.4 5.5 12 3z"/>',
  };
  const icon = (k, cls = '') => `<svg class="gicon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICON[k] || ICON.globe}</svg>`;
  const LEVEL_CLS = { LOW: 'lv0', ELEVATED: 'lv1', HIGH: 'lv2', SEVERE: 'lv3' };
  function riskFill(r) {
    if (r == null) return 'var(--geo-land)';
    const t = U.clamp(r / 100, 0, 1), a = [42, 52, 64], b = [243, 177, 74], c = [255, 99, 120];
    const mix = (p, q, k) => p.map((x, i) => Math.round(x + (q[i] - x) * k));
    const m = t < 0.5 ? mix(a, b, t / 0.5) : mix(b, c, (t - 0.5) / 0.5);
    return `rgb(${m.join(',')})`;
  }
  const ago = ts => { if (!ts) return ''; const m = Math.round((Date.now() - ts) / 60e3); return m < 60 ? m + 'm ago' : m < 1440 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago'; };

  // region from the country's centroid (for the list filter and default markets)
  function regionOf(c) {
    const [lon, lat] = c.ll || [0, 0];
    if (lon < -25) return 'Americas';
    if (c.n === 'Russia' || c.n === 'Belarus') return 'Europe';
    if (c.n === 'Turkey' || c.n === 'Cyprus' || c.n === 'N. Cyprus') return 'Middle East';
    if (lat > 35 && lon < 60 && lon > -25) return ['Kazakhstan', 'Uzbekistan', 'Turkmenistan', 'Kyrgyzstan', 'Tajikistan', 'Afghanistan', 'Azerbaijan', 'Armenia', 'Georgia'].includes(c.n) ? 'Asia-Pacific' : 'Europe';
    if (lon >= 34 && lon <= 63 && lat >= 12 && lat <= 42) return ['Ethiopia', 'Somalia', 'Somaliland', 'Djibouti', 'Eritrea', 'Sudan', 'S. Sudan', 'Egypt'].includes(c.n) ? 'Africa' : 'Middle East';
    if (lon > -20 && lon < 55 && lat < 38) return c.n === 'Israel' || c.n === 'Palestine' || c.n === 'Lebanon' || c.n === 'Jordan' || c.n === 'Syria' ? 'Middle East' : 'Africa';
    if (lon > 60 && lat > 35 && lat < 56 && lon < 80) return 'Asia-Pacific';
    return lat > 45 && lon < 60 ? 'Europe' : 'Asia-Pacific';
  }
  const REGIONS = ['All', 'Americas', 'Europe', 'Middle East', 'Africa', 'Asia-Pacific'];
  const SHORT = { 'United States of America': 'USA', 'United Kingdom': 'UK' };

  let geoTimer = null, keyWired = false;
  APP.register('GEO', {
    title: 'Geopolitical Risk Map · latest news', global: true,
    async render(root) {
      this.theme = U.store.get('geoTheme', null); this.sel = U.store.get('geoSel', null); this.escOnly = false;
      this.region = U.store.get('geoRegion', 'All'); this.sort = U.store.get('geoSort', 'risk'); this.cc = this.cc || new Map(); this.rx = this.rx || new Map();   // country feeds and news-vs-price analyses, kept while Agula is open
      root.innerHTML = `<div class="geohead">
          <div class="georadar" aria-hidden="true">${icon('globe', 'big')}<span class="sweep"></span></div>
          <div><div class="geot">GLOBAL GEOPOLITICAL RISK</div><div class="muted small" id="gAsof">Scanning the latest headlines…</div></div>
          <div id="gGauge" class="gauge"></div><div id="gThemes" class="gthemes"></div>
          <button class="btn ghost sm" id="gRefresh" title="Fetch the latest headlines">⟳ Refresh</button></div>
        <div class="grid geogrid"><div class="stack">
          ${panel('World map · click any country', `<div class="geomapwrap"><div class="geomap" id="gMap"></div><div class="geohover" id="gHover" hidden></div></div><div class="geolegend"><span>Low</span><i></i><span>Severe</span><span class="muted small">grey = no major headlines in the global scan (click it anyway) · ● pulsing = escalation · ◆ sea lanes &amp; blocs · ← → switch country</span></div>`, { id: 'gMapP' })}
          ${panel('News vs prices', '<div id="gRx"><div class="muted small">Pick a country to see how its markets moved with its news.</div></div>', { id: 'gRxP' })}
          <div class="grid g2" id="gHotG">${panel('Hotspots', '<div id="gHot"></div>')}${panel('Market reaction', '<div id="gMkt"></div>')}</div>
          ${panel('Latest tagged headlines', '<div class="toolbar"><label class="chk"><input type="checkbox" id="gEsc"> Escalation only</label><span id="gFilt" class="muted small"></span></div><div id="gFeed"></div>', { id: 'gFeedP' })}</div>
          <div class="stack" id="gSide">
          ${panel('All countries', `<div class="seg gseg" id="gReg">${REGIONS.map(r => `<button data-r="${r}" class="${r === this.region ? 'on' : ''}">${r}</button>`).join('')}</div>
            <div class="row mt"><input class="txt" id="gFilter" placeholder="Filter list" autocomplete="off"><div class="seg" id="gSort"><button data-s="risk" class="${this.sort === 'risk' ? 'on' : ''}">By risk</button><button data-s="az" class="${this.sort === 'az' ? 'on' : ''}">A–Z</button></div></div>
            <div id="gList" class="glist"></div>`, { id: 'gListP' })}
          ${panel('Country situation', `<div class="gpick"><button class="btn ghost sm" id="gPrev" title="Previous country (←)">◀</button><input class="txt" id="gFind" list="gNames" placeholder="Type a country…" autocomplete="off" aria-label="Find a country"><datalist id="gNames">${W.countries.map(c => `<option value="${esc(c.n)}">`).join('')}</datalist><button class="btn ghost sm" id="gNext" title="Next country (→)">▶</button></div><div id="gBrief"><div class="muted small">Loading…</div></div>`, { id: 'gBriefP' })}</div>
        </div><p class="src-note" id="gSrc"></p>`;
      $('#gRefresh').addEventListener('click', () => { this.cc.clear(); this.rx.clear(); this.load(true); });
      $('#gEsc').addEventListener('change', e => { this.escOnly = e.target.checked; this.feed(); });
      $('#gPrev').addEventListener('click', () => this.step(-1)); $('#gNext').addEventListener('click', () => this.step(1));
      const find = $('#gFind'), go = () => { const v = find.value.trim().toLowerCase(); if (!v) return; const hit = W.countries.find(c => c.n.toLowerCase() === v) || W.countries.find(c => c.n.toLowerCase().startsWith(v)) || W.countries.find(c => c.n.toLowerCase().includes(v)) || (this.d?.spots || []).find(s => s.name.toLowerCase().includes(v)); if (hit) { this.pick(hit.d ? hit.n : hit.key); find.value = ''; find.blur(); } };
      find.addEventListener('change', go); find.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      $('#gReg').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; this.region = b.dataset.r; U.store.set('geoRegion', this.region); $$('#gReg button').forEach(x => x.classList.toggle('on', x === b)); this.list(); });
      $('#gSort').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; this.sort = b.dataset.s; U.store.set('geoSort', this.sort); $$('#gSort button').forEach(x => x.classList.toggle('on', x === b)); this.list(); });
      $('#gFilter').addEventListener('input', () => this.list());
      root.addEventListener('click', e => {
        const sy = e.target.closest('[data-sym]'); if (sy) { APP.open('DES', sy.dataset.sym); return; }
        const th = e.target.closest('[data-gtheme]'); if (th) { this.theme = this.theme === th.dataset.gtheme ? null : th.dataset.gtheme; U.store.set('geoTheme', this.theme); this.drawMap(); this.feed(); this.list(); return; }
        const c = e.target.closest('[data-c]'); if (c) { e.preventDefault(); this.pick(c.dataset.c); }
      });
      if (!keyWired) {
        keyWired = true;
        document.addEventListener('keydown', e => {
          if (APP.state.screen !== 'GEO' || e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) return;
          if (e.key === 'ArrowRight' || e.key === ']') { e.preventDefault(); APP.SCREENS.GEO.step(1); } else if (e.key === 'ArrowLeft' || e.key === '[') { e.preventDefault(); APP.SCREENS.GEO.step(-1); }
        });
      }
      this.load();
      clearInterval(geoTimer); geoTimer = setInterval(() => { if (!document.hidden) this.load(); }, 10 * 60e3);
    },
    destroy() { clearInterval(geoTimer); geoTimer = null; },
    async load(fresh) {
      try {
        const d = await HUB.geo(fresh); this.d = d;
        this.byKey = new Map([...d.countries, ...d.spots].map(c => [c.key, c]));
        const assets = [...new Set([...d.countries.slice(0, 8), ...d.spots.slice(0, 4)].flatMap(c => c.assets).concat(['^VIX', 'GC=F', 'BZ=F', 'DX-Y.NYB', 'ITA']))].slice(0, 24);
        HUB.track('screen', assets); HUB.ensureMeta(assets);
        if (!this.sel) this.sel = (d.countries[0] || d.spots[0] || {}).key || 'Mongolia';
        $('#gAsof').innerHTML = `${d.scanned} headlines scanned · ${d.countries.length} countries and ${d.spots.length} sea lanes/blocs in the news · every country can be opened · updated ${new Date(d.asof).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
        $('#gSrc').innerHTML = `Source: ${esc(d.source)}. Risk scores are Agula's keyword model of headline volume, theme and escalation language, weighted to the last 36–48 hours; a country opened from the map gets its own news search. They describe how intense the news is, not a forecast.${d.note ? ' <span class="warn-t">' + esc(d.note) + '</span>' : ''}`;
        this.header(); this.drawMap(); this.hot(); this.market(); this.feed(); this.list(); this.pick(this.sel, true);
      } catch (e) { $('#gMap').innerHTML = errBox(e); $('#gBrief').innerHTML = ''; }
    },
    // best data we have for a place: the global scan, or its own country search once loaded
    info(key) {
      const g = this.byKey?.get(key), c = this.cc.get(key), o = c && c.data;
      if (!o) return g ? { ...g, scan: g } : null;
      if (!g) return { ...o, scan: null, own: o };
      // in the global scan and searched on its own: keep the higher risk and combine everything else
      const themes = { ...g.themes }; Object.entries(o.themes || {}).forEach(([k, n]) => { themes[k] = Math.max(themes[k] || 0, n); });
      const top = Object.entries(themes).sort((x, y) => y[1] - x[1])[0];
      const seen = new Set(), titles = [...(g.heads || []).map(k => this.d.headlines[k]).filter(Boolean), ...(o.headlines || [])].filter(h => { const t = h.title.toLowerCase().slice(0, 60); if (seen.has(t)) return false; seen.add(t); return true; });
      const risk = Math.max(g.risk, o.risk);
      return { ...g, risk, level: risk >= 75 ? 'SEVERE' : risk >= 50 ? 'HIGH' : risk >= 25 ? 'ELEVATED' : 'LOW', themes, topTheme: top ? top[0] : g.topTheme, n: titles.length,
        esc: Math.max(g.esc, o.esc), deesc: Math.max(g.deesc, o.deesc), assets: [...new Set([...(g.assets || []), ...(o.assets || [])])].slice(0, 6), scan: g, own: o };
    },
    riskOf(key) { const i = this.info(key); return i ? i.risk : null; },
    themeRisk(c) {
      if (!c) return null;
      if (!this.theme) return c.risk;
      const n = (c.themes || {})[this.theme] || 0; if (!n) return null;
      return c.risk * Math.min(1, n / Math.max(1, c.n)) * 1.3;
    },
    header() {
      const d = this.d;
      const g = d.index, ang = Math.PI * (1 - g / 100), cx = 60, cy = 58, r = 46, px = cx + r * Math.cos(ang), py = cy - r * Math.sin(ang);
      $('#gGauge').innerHTML = `<svg viewBox="0 0 120 70" aria-label="Global risk ${g} of 100"><defs><linearGradient id="gg" x1="0" x2="1"><stop offset="0" stop-color="#2a3440"/><stop offset=".5" stop-color="#f3b14a"/><stop offset="1" stop-color="#ff6378"/></linearGradient></defs>
        <path d="M14 58a46 46 0 0 1 92 0" fill="none" stroke="url(#gg)" stroke-width="9" stroke-linecap="round"/><line x1="${cx}" y1="${cy}" x2="${px.toFixed(1)}" y2="${py.toFixed(1)}" stroke="var(--text)" stroke-width="2.4" stroke-linecap="round"/><circle cx="${cx}" cy="${cy}" r="4" fill="var(--text)"/></svg>
        <div class="gval"><b class="${LEVEL_CLS[d.level]}">${g.toFixed(0)}</b><span class="${LEVEL_CLS[d.level]}">${d.level}</span></div>`;
      const mx = Math.max(1, ...d.themes.map(t => t.score));
      $('#gThemes').innerHTML = d.themes.map(t => `<button class="gtheme ${this.theme === t.key ? 'on' : ''}" data-gtheme="${t.key}" title="Shade the map by ${esc(t.label)} only">${icon(t.key)}<span><b>${esc(t.label)}</b><em>${t.n} headlines</em><i style="width:${(t.score / mx * 100).toFixed(0)}%"></i></span></button>`).join('');
    },
    // the map is drawn once per data load; selecting a country only moves the highlight
    drawMap() {
      const d = this.d; if (!d) return;
      $$('#gThemes .gtheme').forEach(b => b.classList.toggle('on', b.dataset.gtheme === this.theme));
      const land = W.countries.map(c => { const k = this.info(c.n), r = this.themeRisk(k); return `<path d="${c.d}" fill="${riskFill(r)}" class="${k ? 'has' : 'nod'}" data-c="${esc(c.n)}"></path>`; }).join('');
      const marks = d.countries.filter(c => c.risk >= 20).slice(0, 18).map(c => {
        const wc = W.countries.find(x => x.n === c.key); if (!wc) return '';
        const rr = this.themeRisk(c); if (rr == null) return '';
        const [x, y] = wc.c, rad = 3 + rr / 14, hot = c.esc > c.deesc && c.risk >= 40;
        return `<g class="mk ${hot ? 'hot' : ''}" data-c="${esc(c.key)}" transform="translate(${x},${y})">${hot ? `<circle r="${rad}" class="pulse"/>` : ''}<circle r="${rad.toFixed(1)}" class="dotc"/><text y="${(-rad - 3).toFixed(1)}">${esc(SHORT[c.key] || c.key)}</text></g>`;
      }).join('');
      const spots = d.spots.map(s => { const [x, y] = project(s.lon, s.lat), rr = this.themeRisk(s); if (rr == null) return ''; const z = 3.5 + rr / 18, hot = s.esc > s.deesc && s.risk >= 40;
        return `<g class="mk spot ${hot ? 'hot' : ''}" data-c="${esc(s.key)}" transform="translate(${x.toFixed(1)},${y.toFixed(1)})">${hot ? `<circle r="${z}" class="pulse"/>` : ''}<rect x="${-z}" y="${-z}" width="${2 * z}" height="${2 * z}" transform="rotate(45)"/></g>`; }).join('');
      $('#gMap').innerHTML = `<svg viewBox="0 0 ${W.w} ${W.h}" role="img" aria-label="World map shaded by geopolitical news risk; every country can be clicked"><path d="${outline}" class="ocean"/><path d="${graticule}" class="grat"/><g class="land">${land}</g><g id="gSelG"></g><g>${marks}${spots}</g></svg>`;
      // hover readout (cheap: one listener, no re-render)
      const map = $('#gMap'), hov = $('#gHover');
      map.onmousemove = e => {
        const t = e.target.closest('[data-c]'); if (!t) { hov.hidden = true; return; }
        const k = t.dataset.c, i = this.info(k), nm = (this.byKey.get(k) || {}).name || k;
        hov.hidden = false; hov.innerHTML = `<b>${esc(nm)}</b> ${i ? `<span class="${LEVEL_CLS[i.level]}">${i.risk.toFixed(0)} · ${i.level}</span> · ${i.n} headlines` : '<span class="muted">not in the global scan · click for its news</span>'}`;
        const b = map.getBoundingClientRect(); hov.style.left = Math.min(b.width - 260, e.clientX - b.left + 14) + 'px'; hov.style.top = (e.clientY - b.top + 12) + 'px';
      };
      map.onmouseleave = () => { hov.hidden = true; };
      this.markSel();
    },
    markSel() {
      const sel = this.sel, g = $('#gSelG'); if (!g) return;
      $$('#gMap .land path.sel, #gMap .mk.selm').forEach(x => x.classList.remove('sel', 'selm'));
      const p = $(`#gMap .land path[data-c="${CSS.escape(sel)}"]`);
      g.innerHTML = '';
      if (p) { p.classList.add('sel'); g.innerHTML = `<path d="${p.getAttribute('d')}" class="selo"/>`; }             // outline drawn on top of neighbours
      const m = $(`#gMap .mk.spot[data-c="${CSS.escape(sel)}"]`); if (m) m.classList.add('selm');
      $$('#gHot tr[data-c], #gList [data-c]').forEach(r => r.classList.toggle('self', r.dataset.c === sel));
    },
    hot() {
      const d = this.d, all = [...d.countries, ...d.spots].sort((a, b) => b.risk - a.risk).slice(0, 14);
      $('#gHot').innerHTML = all.length ? `<table class="tbl"><tbody>${all.map(c => `<tr class="clk" data-c="${esc(c.key)}"><td>${icon(c.topTheme || 'globe', 'sm')}</td><td class="wrap"><b>${esc(c.name)}</b><div class="muted small">${c.n} headlines${c.esc ? ` · ${c.esc} escalation` : ''}</div></td><td class="r"><div class="riskbar"><i style="width:${c.risk}%;background:${riskFill(c.risk)}"></i></div></td><td class="r ${LEVEL_CLS[c.level]}">${c.risk.toFixed(0)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty small">No places detected in the latest headlines.</div>';
    },
    order() {
      // the switching order (◀ ▶, arrow keys) follows the list as currently filtered and sorted
      const q = ($('#gFilter')?.value || '').trim().toLowerCase();
      let rows = W.countries.filter(c => (this.region === 'All' || regionOf(c) === this.region) && (!q || c.n.toLowerCase().includes(q))).map(c => ({ key: c.n, name: c.n, region: regionOf(c), i: this.info(c.n) }));
      if (this.region === 'All' && !q) rows = rows.concat((this.d?.spots || []).map(s => ({ key: s.key, name: s.name, region: 'Sea lanes & blocs', i: this.info(s.key) })));
      rows.sort(this.sort === 'az' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => ((b.i?.risk ?? -1) - (a.i?.risk ?? -1)) || a.name.localeCompare(b.name));
      return rows;
    },
    list() {
      const box = $('#gList'); if (!box) return;
      const rows = this.order(); this.rows = rows;
      box.innerHTML = rows.map(r => `<button class="grow2 ${r.key === this.sel ? 'self' : ''}" data-c="${esc(r.key)}"><span class="gn">${esc(r.name)}</span><span class="riskbar"><i style="width:${r.i ? r.i.risk : 0}%;background:${riskFill(r.i ? r.i.risk : null)}"></i></span><span class="gr ${r.i ? LEVEL_CLS[r.i.level] : 'muted'}">${r.i ? r.i.risk.toFixed(0) : '—'}</span><span class="gc muted">${r.i ? r.i.n : ''}</span></button>`).join('') || '<div class="muted small">No country matches.</div>';
      this.markSel();
    },
    step(dir) {
      const rows = this.rows && this.rows.length ? this.rows : this.order(); if (!rows.length) return;
      const i = rows.findIndex(r => r.key === this.sel), n = (i < 0 ? 0 : i + dir + rows.length) % rows.length;
      this.pick(rows[n].key);
      const el = $(`#gList [data-c="${CSS.escape(rows[n].key)}"]`); if (el) el.scrollIntoView({ block: 'nearest' });
    },
    pick(key, quiet) {
      if (!key) return;
      this.sel = key; U.store.set('geoSel', key);
      this.markSel(); this.brief(); this.reaction(key);
      if (!quiet && innerWidth < 900) $('#gBriefP').scrollIntoView({ behavior: 'smooth' });
      const cached = this.cc.get(key);
      if (cached && (cached.data || cached.p)) this.fetchCountry(key); else setTimeout(() => { if (this.sel === key) this.fetchCountry(key); }, quiet ? 0 : 160);
      // prefetch the next two in the list so ▶ is instant
      const rows = this.rows || [], i = rows.findIndex(r => r.key === key);
      // (only once you stop on a country, so holding an arrow key doesn't fire a burst of searches)
      [1, 2, -1].forEach(o => { const r = rows[(i + o + rows.length) % rows.length]; if (r && i >= 0) setTimeout(() => { if (this.sel === key) this.fetchCountry(r.key, true); }, 500 + 300 * Math.abs(o)); });
    },
    async fetchCountry(key, background) {
      if (!W.countries.some(c => c.n === key)) return;            // sea lanes and blocs come from the global scan only
      const have = this.cc.get(key); if (have && (have.data || have.p)) return have.p;
      const wc = W.countries.find(c => c.n === key);
      const p = HUB.geoCountry(key, regionOf(wc)).then(data => {
        this.cc.set(key, { data });
        HUB.track('screen', [...new Set([...(this.d ? [...this.d.countries.slice(0, 8)].flatMap(c => c.assets) : []), ...data.assets, '^VIX', 'GC=F', 'BZ=F', 'DX-Y.NYB', 'ITA'])]);
        if (this.sel === key && APP.state.screen === 'GEO') { this.brief(); }
        const path = $(`#gMap .land path[data-c="${CSS.escape(key)}"]`);    // shade newly opened countries on the map and in the list
        if (path) { path.setAttribute('fill', riskFill(this.themeRisk(this.info(key)))); path.classList.add('has'); path.classList.remove('nod'); }
        if (!background) this.list(); else { const row = $(`#gList [data-c="${CSS.escape(key)}"]`); if (row) { const i = this.info(key); row.querySelector('.gr').textContent = i.risk.toFixed(0); row.querySelector('.gr').className = 'gr ' + LEVEL_CLS[i.level]; row.querySelector('.riskbar i').style.cssText = `width:${i.risk}%;background:${riskFill(i.risk)}`; row.querySelector('.gc').textContent = i.n; } }
        return data;
      }).catch(e => { this.cc.set(key, { err: e.message }); if (this.sel === key) this.brief(); });
      this.cc.set(key, { p });
      return p;
    },
    brief() {
      const key = this.sel, box = $('#gBrief'); if (!box || !key) return;
      const wc = W.countries.find(c => c.n === key), spot = (this.d?.spots || []).find(s => s.key === key);
      const name = spot ? spot.name : key, region = wc ? regionOf(wc) : 'Sea lane / bloc', i = this.info(key), cc = this.cc.get(key) || {};
      const d = this.d || { themes: [] }, labelOf = k => (d.themes.find(t => t.key === k) || {}).label || ({ conflict: 'Conflict & security', sanctions: 'Sanctions & trade', energy: 'Energy & resources', shipping: 'Shipping & supply chains', politics: 'Elections & politics', cyber: 'Cyber & espionage', diplomacy: 'Diplomacy' })[k] || k;
      const loading = wc && !cc.data && !cc.err;
      const pos = this.rows ? this.rows.findIndex(r => r.key === key) : -1;
      $('#gFind').placeholder = `${name} · ${pos >= 0 ? pos + 1 + ' of ' + this.rows.length : ''} · type to jump`;
      if (!i) {
        box.innerHTML = `<div class="gbrief"><div class="gill">${icon('globe', 'big')}</div><div><div class="gname">${esc(name)}</div><div class="muted small">${esc(region)}</div>
          <div class="small mt">${loading ? '<span class="spin"></span> Searching the latest news for ' + esc(name) + '…' : cc.err ? '<span class="down">' + esc(cc.err) + '</span>' : 'No headlines found.'}</div></div></div>`;
        return;
      }
      const ts = Object.entries(i.themes || {}).sort((a, b) => b[1] - a[1]), mx = Math.max(1, ...ts.map(x => x[1]));
      const own = i.own ? i.own.headlines : [], scanHeads = i.scan ? i.scan.heads.map(k => d.headlines[k]).filter(Boolean) : [];
      const seen = new Set(), heads = [...scanHeads, ...own].filter(h => { const k = h.title.toLowerCase().slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => (b.ts || 0) - (a.ts || 0));
      const mood = i.esc > i.deesc ? ['Escalating', 'down'] : i.deesc > i.esc ? ['De-escalating', 'up'] : ['Mixed / steady', 'flat'];
      const situ = [];
      if (!i.n) situ.push(`No significant headlines about ${esc(name)} in the last few days: a quiet news flow.`);
      else {
        situ.push(`<b>${i.n}</b> recent headline${i.n > 1 ? 's' : ''}; the news is mostly about <b>${esc(ts.slice(0, 2).map(t => labelOf(t[0]).toLowerCase()).join(' and ') || 'general affairs')}</b>.`);
        situ.push(i.esc ? `${i.esc} headline${i.esc > 1 ? 's use' : ' uses'} escalation language (attacks, threats, strikes)${i.deesc ? `, ${i.deesc} point${i.deesc > 1 ? '' : 's'} to de-escalation (talks, deals, ceasefires)` : ''}.` : i.deesc ? `The tone leans toward de-escalation (talks, deals, ceasefires).` : 'No escalation language in the headlines.');
        situ.push(`Risk <b class="${LEVEL_CLS[i.level]}">${i.risk.toFixed(0)}/100 (${i.level})</b>${i.level === 'LOW' ? ': unlikely to move markets on its own.' : i.level === 'ELEVATED' ? ': worth watching; local assets can react.' : ': a live story that can move ' + (i.assets || []).slice(0, 3).join(', ') + '.'}`);
      }
      box.innerHTML = `<div class="gbrief"><div class="gill ${LEVEL_CLS[i.level]}">${icon(i.topTheme || 'globe', 'big')}</div><div><div class="gname">${esc(name)}</div>
          <div class="mono"><b class="${LEVEL_CLS[i.level]}">${i.risk.toFixed(0)} · ${i.level}</b> <span class="${mood[1]}">${mood[0]}</span></div>
          <div class="muted small">${esc(region)} · ${i.scan && i.own ? 'global scan + its own news search' : i.scan ? 'in the global scan' : 'its own news search'}${loading ? ' · <span class="spin"></span> adding its own news…' : ''}</div></div></div>
        <div class="gsitu">${situ.map(x => `<p>${x}</p>`).join('')}</div>
        ${ts.length ? `<div class="gtb">${ts.map(([k, n]) => `<div><span>${icon(k, 'sm')} ${esc(labelOf(k))}</span><i style="width:${(n / mx * 100).toFixed(0)}%"></i><b>${n}</b></div>`).join('')}</div>` : ''}
        ${(i.assets || []).length ? `<h4 class="subh">Linked markets</h4><div class="chips">${i.assets.map(sy => `<button class="symchip q" data-sym="${esc(sy)}">${esc(sy)} <span>—</span></button>`).join('')}</div>` : ''}
        <h4 class="subh">Headlines · ${heads.length}</h4><div class="gheads">${heads.slice(0, 25).map(h => this.headHTML(h)).join('') || '<div class="muted small">No headlines.</div>'}</div>`;
      HUB.track('geoSel', i.assets || []);
      this.quotes();
    },
    headHTML(h) {
      const rx = this.rxHeads && this.rxHeads.get(h.title.toLowerCase().slice(0, 60));
      const chips = rx ? Object.entries(rx).slice(0, 2).map(([sy, mv]) => `<span class="rxchip ${U.cls(mv)}" title="${esc(sy)} moved ${U.fmtPct(mv, 2)} in the ~4 trading hours after this headline">${esc(sy)} ${U.fmtPct(mv, 2)}</span>`).join('') : '';
      return `<div class="nw"><a class="nwt" href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a><div class="nwm">${chips}<span>${esc(h.site || '')}</span><span>${ago(h.ts)}</span>${h.esc ? '<span class="chipst bad">ESCALATION</span>' : h.deesc ? '<span class="chipst on">DE-ESCALATION</span>' : ''}${(h.themes || []).map(t => `<span class="gchip">${icon(t, 'xs')}${esc(t)}</span>`).join('')}${[...(h.countries || []), ...(h.spots || [])].filter(k => k !== this.sel).slice(0, 4).map(k => `<a href="#" class="gplace" data-c="${esc(k)}">${esc((this.byKey.get(k) || {}).name || k)}</a>`).join('')}</div></div>`;
    },
    feed() {
      const d = this.d, box = $('#gFeed'); if (!d || !box) return;
      let h = d.headlines; if (this.theme) h = h.filter(x => x.themes.includes(this.theme)); if (this.escOnly) h = h.filter(x => x.esc);
      $('#gFilt').textContent = this.theme ? `Theme: ${d.themes.find(t => t.key === this.theme)?.label || this.theme} (click the theme again to clear)` : '';
      box.innerHTML = h.slice(0, 40).map(x => this.headHTML(x)).join('') || '<div class="empty small">No headlines match.</div>';
    },
    market() {
      const box = $('#gMkt'); if (!box) return;
      const core = [['^VIX', 'Fear gauge'], ['GC=F', 'Safe haven'], ['BZ=F', 'Oil supply risk'], ['DX-Y.NYB', 'Dollar demand'], ['ITA', 'Defense stocks']];
      box.innerHTML = `<table class="tbl"><tbody>${core.map(([s, why]) => { const q = HUB.quote(s); return `<tr class="clk" data-sym="${esc(s)}"><td class="key">${esc(s)}</td><td class="muted wrap">${why}</td><td class="r">${q ? U.fmtPx(q.last) : '—'}</td><td class="r ${q ? U.cls(q.chg) : ''}">${q ? U.fmtPct(q.chgPct) : '—'}</td></tr>`; }).join('')}</tbody></table>
        <p class="hint">Risk-off days usually show VIX, gold and the dollar up together; oil reacts to supply threats (Middle East, Russia, shipping lanes).</p>`;
    },
    // ---------------------------------------------------------------- news vs prices for the selected place
    reaction(key) {
      const box = $('#gRx'); if (!box) return;
      const wc = W.countries.find(c => c.n === key), spot = (this.d?.spots || []).find(s => s.key === key);
      if (!wc && !spot) return;
      const name = spot ? spot.name : key, have = this.rx.get(key);
      this.rxHeads = have && have.data ? have.heads : null;
      if (have && have.data) { this.drawRx(key, have.data); return; }
      box.innerHTML = have && have.err ? `<div class="empty small err">${esc(have.err)}</div>` : `<div class="muted small"><span class="spin"></span> Matching 30 days of ${esc(name)} headlines with the price moves of its markets…</div>`;
      $('#gRxP h3').textContent = `News vs prices · ${name}`;
      if (have && have.err) return;
      clearTimeout(this._rxT);
      this._rxT = setTimeout(() => {                  // only once you stop on a country (holding ◀ ▶ doesn't fire a burst)
        if (this.sel !== key || (this.rx.get(key) || {}).p) return;
        const p = HUB.geoReaction(key, wc ? regionOf(wc) : '').then(r => {
          const heads = new Map(); (r.headlines || []).forEach(h => { if (h.react) heads.set(h.title.toLowerCase().slice(0, 60), h.react); });
          this.rx.set(key, { data: r, heads });
          HUB.track('geoRx', r.assets.filter(a => a.ok).map(a => a.sym));
          if (this.sel === key && APP.state.screen === 'GEO') { this.rxHeads = heads; this.drawRx(key, r); this.brief(); }
        }).catch(e => { this.rx.set(key, { err: e.message }); if (this.sel === key) this.reaction(key); });
        this.rx.set(key, { p });
      }, 450);
    },
    drawRx(key, r) {
      const box = $('#gRx'); if (!box) return;
      $('#gRxP h3').textContent = `News vs prices · ${r.name} · last 30 days`;
      const A = r.assets.filter(a => a.ok), col = CK.colors(), pal = [col.key, col.accent, col.series[2] || '#c79bff', col.series[3] || '#ff8f5c'];
      if (!A.length) { box.innerHTML = '<div class="empty small">No price history for the markets linked to this place.</div>'; return; }
      const nm = s => (HUB.meta(s) || {}).name || s, ratio = a => (a.hotAbs != null && a.calmAbs) ? a.hotAbs / a.calmAbs : null;
      const busy = [...r.series].sort((x, y) => y[1].sev - x[1].sev)[0];
      const tone = r.esc > r.deesc ? 'leans toward <b class="down">escalation</b>' : r.deesc > r.esc ? 'leans toward <b class="up">de-escalation</b>' : 'is mixed';
      const L = [];
      L.push(`<b>News flow.</b> ${r.n} headlines about ${esc(r.name)} in 30 days, ${r.n7} in the last week${busy && busy[1].n ? `; the busiest day was ${busy[0]} (${busy[1].n})` : ''}. The tone ${tone} (${r.esc} escalation vs ${r.deesc} de-escalation headlines).`);
      const cand = A.filter(a => ratio(a) != null && a.nHot >= 2).sort((x, y) => ratio(y) - ratio(x));
      if (cand.length) {
        const a = cand[0], k = ratio(a);
        L.push(`<b>Busy-news days.</b> On the ${a.nHot} days with the most ${esc(r.name)} news, <b>${esc(a.sym)}</b> (${esc(nm(a.sym))}) moved ${U.fmtPct(a.hotAbs, 2, false)} on average, against ${U.fmtPct(a.calmAbs, 2, false)} on quiet days (<b>${U.fmt(k, 1)}×</b>). ${k >= 1.5 ? 'Markets have been <b>reacting to this story</b>.' : k >= 1.15 ? 'A mild link: news days were somewhat more volatile.' : k < 0.85 ? 'News days were calmer than usual: this story is not what has been moving prices.' : 'No clear link between the news and price swings.'}`);
      } else L.push(`<b>Busy-news days.</b> Too few days with notable ${esc(r.name)} news in the last month to compare with quiet days.`);
      const sens = A.filter(a => a.sens != null).sort((x, y) => y.sens - x.sens)[0];
      if (sens) L.push(`<b>Right after headlines.</b> In the ~4 trading hours after the ${sens.nReact} most important headlines, <b>${esc(sens.sym)}</b> moved ${U.fmt(sens.sens, 1)}× its typical 4-hour move${sens.sens >= 1.5 ? ': <b>a clear reaction</b>.' : sens.sens >= 1.1 ? ': a small reaction.' : ': no reaction beyond normal noise.'}${sens.riskoffHit != null && sens.nEsc >= 3 ? ` After escalation headlines it moved the risk-off way ${U.fmtPct(sens.riskoffHit, 0, false)} of the time (${sens.nEsc} cases).` : ''}`);
      const odd = A.filter(a => a.z != null && Math.abs(a.z) >= 2);
      L.push(odd.length ? `<b>Today.</b> ${odd.map(a => `<b>${esc(a.sym)}</b> is ${a.today > 0 ? 'up' : 'down'} ${U.fmtPct(Math.abs(a.today), 2, false)}, ${U.fmt(Math.abs(a.z), 1)}× its normal daily move`).join('; ')}: unusual. ${r.n7 ? 'Check whether the latest headlines explain it.' : 'There is little local news this week, so look for a global driver.'}`
        : `<b>Today.</b> The linked markets are moving within normal ranges (no move above 2× its usual daily size).`);
      const th = A.map(a => a.riskoff > 0 ? `${a.sym} ↑` : `${a.sym} ↓`).join(' · ');
      box.innerHTML = `<div class="rxwrap"><div class="interp rxtext">${L.map(x => `<p>${x}</p>`).join('')}<p class="hint">Risk-off direction (what bad news usually does): ${esc(th)}. A month of headlines gives a hint, not proof: global news (the Fed, US data, oil) often moves these markets more than local stories.</p></div>
        <div><div class="cv"><canvas id="gRxP1"></canvas></div><div class="cv rxbars"><canvas id="gRxN"></canvas></div></div></div>
        <div class="tblwrap"><table class="tbl"><thead><tr><th>Market</th><th class="r">Last</th><th class="r">Today</th><th class="r" title="Today's move divided by the typical daily move (60 days)">vs normal</th><th class="r">1W</th><th class="r">1M</th>
          <th class="r" title="Average size of the daily move on the busiest news days vs quiet days">Busy-news days</th><th class="r" title="Rank correlation between daily news intensity and the size of the daily move">News ↔ move</th><th class="r" title="Average move in the ~4 trading hours after major headlines, relative to a typical 4-hour move">After headlines</th><th class="r" title="Share of escalation headlines followed by a move in the risk-off direction">Risk-off hit</th></tr></thead>
          <tbody>${r.assets.map(a => !a.ok ? `<tr><td class="key">${esc(a.sym)}</td><td colspan="9" class="muted">no price history</td></tr>` : `<tr class="clk" data-sym="${esc(a.sym)}"><td><span class="key">${esc(a.sym)}</span> <span class="muted small">${esc(nm(a.sym))}</span></td><td class="r">${U.fmtPx(a.last)}</td>
            <td class="r ${U.cls(a.today)}">${U.fmtPct(a.today, 2)}</td><td class="r ${a.z != null && Math.abs(a.z) >= 2 ? 'key' : 'muted'}">${a.z == null ? '—' : U.fmt(a.z, 1) + 'σ'}</td><td class="r ${U.cls(a.w1)}">${U.fmtPct(a.w1, 1)}</td><td class="r ${U.cls(a.m1)}">${U.fmtPct(a.m1, 1)}</td>
            <td class="r">${ratio(a) == null ? '—' : `<b class="${ratio(a) >= 1.5 ? 'key' : ''}">${U.fmt(ratio(a), 1)}×</b>`}</td><td class="r">${a.corrAbs == null ? '—' : U.fmt(a.corrAbs, 2)}</td><td class="r">${a.sens == null ? '—' : `<b class="${a.sens >= 1.5 ? 'key' : ''}">${U.fmt(a.sens, 1)}×</b> <span class="muted small">${a.nReact}</span>`}</td><td class="r">${a.riskoffHit == null ? '—' : U.fmtPct(a.riskoffHit, 0, false) + ` <span class="muted small">${a.nEsc}</span>`}</td></tr>`).join('')}</tbody></table></div>`;
      // the most important headlines of the month and what the linked markets did right after each one
      const big = (r.headlines || []).filter(h => h.react).sort((x, y) => (y.sev || 0) - (x.sev || 0)).slice(0, 8);
      if (big.length) box.insertAdjacentHTML('beforeend', `<h4 class="subh">Headlines and what followed (~4 trading hours)</h4><div class="rxheads">${big.map(h => `<div class="nw"><a class="nwt" href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a><div class="nwm">${Object.entries(h.react).map(([sy, mv]) => { const a = A.find(x => x.sym === sy), with_ = h.esc && a && Math.sign(mv) === a.riskoff; return `<span class="rxchip ${U.cls(mv)}" title="${esc(sy)} moved ${U.fmtPct(mv, 2)} after this headline${a && a.typ4h ? '; a typical 4-hour move is ' + U.fmtPct(a.typ4h, 2, false) : ''}">${esc(sy)} ${U.fmtPct(mv, 2)}${a && a.typ4h && Math.abs(mv) > 2 * a.typ4h ? ' ★' : ''}</span>`; }).join('')}<span>${esc(h.site || '')}</span><span>${ago(h.ts)}</span>${h.esc ? '<span class="chipst bad">ESCALATION</span>' : h.deesc ? '<span class="chipst on">DE-ESCALATION</span>' : ''}</div></div>`).join('')}</div><p class="hint">★ = more than twice a typical 4-hour move. Headlines published while a market is closed are measured from its next trading hours.</p>`);
      // prices rebased to 100 with the busiest news days shaded, and the daily news bars underneath (same dates)
      const t = d => Date.parse(d + 'T12:00:00Z'), hot = r.series.filter(x => x[1].sev >= r.hotCut && x[1].n);
      const lines = A.slice(0, 4).filter(a => a.path.length > 2).map((a, i) => ({ name: a.sym, data: a.path.map(p => [t(p[0]), p[1] / a.path[0][1] * 100]), color: pal[i], width: i ? 1.4 : 2 }));
      const bands = hot.map(x => ({ x0: t(x[0]) - 43200e3, x1: t(x[0]) + 43200e3, color: col.key + '22' }));
      const xr = [t(r.series[0][0]) - 43200e3, t(U.last(r.series)[0]) + 43200e3], xf = v => new Date(v).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
      if (lines.length) CK.xy($('#gRxP1'), { series: lines, vbands: bands, xmin: xr[0], xmax: xr[1], xFmt: xf, yFmt: v => v.toFixed(0), hlines: [{ y: 100 }] });
      CK.xy($('#gRxN'), { series: [{ type: 'bar', name: 'Headlines', data: r.series.map(x => [t(x[0]), x[1].n]), color: col.muted }, { type: 'bar', name: 'Escalation', data: r.series.map(x => [t(x[0]), x[1].esc]), color: col.down }],
        xmin: xr[0], xmax: xr[1], xFmt: xf, yFmt: v => U.fmt(v, 0), ymin: 0, zeroY: true, legend: true });
    },
    quotes() { $$('#gBrief .symchip.q').forEach(el => { const s = el.dataset.sym, q = HUB.quote(s), sp = el.querySelector('span'); if (q && sp) { sp.textContent = U.fmtPct(q.chgPct); sp.className = U.cls(q.chg); } }); },
    onTick() { this.quotes(); clearTimeout(this._t); this._t = setTimeout(() => this.market(), 300); },
  });
})();
