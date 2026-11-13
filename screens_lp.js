/* ============================================================================
   Agula Terminal — LP (Launchpad: tiled functions with saved layouts) · ALRT (alerts manager)
   ========================================================================== */
'use strict';

(() => {
  const { panel, kv, $, $$ } = APP;
  const esc = U.esc;

  // ======================================================================== LP — Launchpad
  const LAYOUTS = { '1x2': [2, 'Side by side'], '2x2': [4, '2 × 2'], '1+2': [3, 'One big + two'], '3x1': [3, 'Three columns'], '2x3': [6, '2 × 3'] };
  const LINKS = [null, 'amber', 'blue', 'green'];        // amber = follows the main security; blue/green link tiles to each other
  const PRESETS = {
    'Equity trader': { layout: '2x2', panes: [['CHART', '$'], ['DES', '$'], ['NEWS', '$'], ['MOST']] },
    'Macro desk': { layout: '2x2', panes: [['WEI'], ['CURVE'], ['FX'], ['GEO']] },
    'Bot desk': { layout: '2x2', panes: [['BOT'], ['CHART', '$'], ['ALRT'], ['MOST']] },
    'Global risk': { layout: '1+2', panes: [['GEO'], ['GLCO'], ['WEI']] },
    'Crypto': { layout: '2x2', panes: [['CRYP'], ['CHART', 'BTC-USD'], ['DES', 'BTC-USD'], ['NEWS', 'BTC-USD']] },
    'Research': { layout: '1x2', panes: [['DCF', '$'], ['DES', '$']] },
  };
  const fromPreset = name => { const p = PRESETS[name]; return { layout: p.layout, panes: p.panes.map(([fn, s], i) => ({ id: 'p' + (i + 1), fn, sym: s === '$' ? APP.state.sym : (s || APP.state.sym), link: s === '$' ? 'amber' : null })) }; };
  let msgWired = false;

  APP.register('LP', {
    title: 'Launchpad · tiled functions', global: false,
    render(root) {
      this.st = U.store.get('lp', null) || fromPreset('Equity trader');
      const saved = U.store.get('lpSaved', {});
      root.classList.add('lproot');
      root.innerHTML = `<div class="toolbar lpbar">
          <div class="seg" id="lpL">${Object.entries(LAYOUTS).map(([k, v]) => `<button data-l="${k}" class="${k === this.st.layout ? 'on' : ''}" title="${v[1]}">${k}</button>`).join('')}</div>
          <select id="lpPre" aria-label="Preset layouts"><option value="">Presets…</option>${Object.keys(PRESETS).map(n => `<option>${esc(n)}</option>`).join('')}</select>
          <select id="lpSaved" aria-label="Saved layouts"><option value="">My layouts…</option>${Object.keys(saved).map(n => `<option>${esc(n)}</option>`).join('')}</select>
          <input class="txt" id="lpName" placeholder="Layout name" style="width:140px"><button class="btn ghost sm" id="lpSave">Save</button><button class="btn ghost sm" id="lpDel">Delete</button>
          <button class="btn ghost sm" id="lpExp">Export</button><label class="btn ghost sm">Import<input type="file" id="lpImp" accept=".json" hidden></label>
          <span class="muted small">Each tile has its own command line. Click a tile's <b>●</b> to link it: <span class="lk amber">●</span> follows the main security, <span class="lk blue">●</span>/<span class="lk green">●</span> tiles follow each other.</span></div>
        <div id="lpGrid" class="lpgrid"></div>`;
      this.grid();
      $('#lpL').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; this.st.layout = b.dataset.l; $$('#lpL button').forEach(x => x.classList.toggle('on', x === b)); this.save(); this.grid(); });
      $('#lpPre').addEventListener('change', e => { if (!e.target.value) return; this.st = fromPreset(e.target.value); this.save(); this.render(root); });
      $('#lpSaved').addEventListener('change', e => { const s = U.store.get('lpSaved', {})[e.target.value]; if (s) { this.st = JSON.parse(JSON.stringify(s)); $('#lpName').value = e.target.value; this.save(); this.render(root); } });
      $('#lpSave').addEventListener('click', () => { const n = $('#lpName').value.trim() || $('#lpSaved').value; if (!n) { APP.toast('Type a name for this layout first.', 'err'); return; } const s = U.store.get('lpSaved', {}); s[n] = this.st; U.store.set('lpSaved', s); APP.toast(`Layout "${n}" saved in this browser.`, 'ok'); this.render(root); });
      $('#lpDel').addEventListener('click', () => { const n = $('#lpSaved').value; if (!n) { APP.toast('Pick a saved layout to delete.', 'err'); return; } const s = U.store.get('lpSaved', {}); delete s[n]; U.store.set('lpSaved', s); this.render(root); });
      $('#lpExp').addEventListener('click', () => APP.saveFile('agula-layouts.json', JSON.stringify({ current: this.st, saved: U.store.get('lpSaved', {}) }, null, 1)));
      $('#lpImp').addEventListener('change', async e => { const f = e.target.files[0]; if (!f) return; try { const j = JSON.parse(await f.text()); if (j.saved) U.store.set('lpSaved', { ...U.store.get('lpSaved', {}), ...j.saved }); if (j.current && j.current.panes) { this.st = j.current; this.save(); } APP.toast('Layouts imported.', 'ok'); this.render(root); } catch (err) { APP.toast('Not an Agula layout file.', 'err'); } });
      if (!msgWired) { msgWired = true; window.addEventListener('message', e => { if (e.origin === location.origin && e.data && e.data.agula === 'pane' && APP.state.screen === 'LP') APP.SCREENS.LP.fromPane(e.data); }); }
    },
    save() { U.store.set('lp', this.st); },
    grid() {
      const n = LAYOUTS[this.st.layout][0];
      while (this.st.panes.length < n) { const k = this.st.panes.length + 1; this.st.panes.push({ id: 'p' + k + '_' + Date.now().toString(36), fn: ['MON', 'NEWS', 'WEI', 'GEO', 'MOST', 'ALRT'][k % 6], sym: APP.state.sym, link: null }); }
      const g = $('#lpGrid'); g.className = 'lpgrid l' + this.st.layout.replace('+', 'p');
      const want = this.st.panes.slice(0, n), have = new Map($$('.lptile', g).map(t => [t.dataset.id, t]));
      have.forEach((t, id) => { if (!want.some(p => p.id === id)) t.remove(); });
      want.forEach((p, i) => {
        let t = have.get(p.id);
        if (!t) {
          t = document.createElement('div'); t.className = 'lptile'; t.dataset.id = p.id;
          t.innerHTML = `<header><button class="lk" data-link title="Link this tile">●</button><b class="lpfn"></b><span class="lpsym"></span><span class="grow"></span><button class="chipbtn" data-reload title="Reload tile">⟳</button><button class="chipbtn" data-max title="Maximize">⤢</button></header><iframe title="Launchpad tile ${i + 1}" loading="lazy"></iframe>`;
          t.querySelector('iframe').src = `${location.pathname}?pane=${encodeURIComponent(p.id)}&fn=${encodeURIComponent(p.fn)}&sym=${encodeURIComponent(p.sym || APP.state.sym)}`;
          t.addEventListener('click', e => this.tileClick(e, p.id));
        }
        t.style.gridArea = 't' + (i + 1); g.appendChild(t); this.head(t, p);
      });
    },
    head(t, p) { t.querySelector('.lpfn').textContent = p.fn; t.querySelector('.lpsym').textContent = APP.SCREENS[p.fn]?.global ? APP.SCREENS[p.fn].title : p.sym; const l = t.querySelector('[data-link]'); l.className = 'lk ' + (p.link || 'none'); l.title = p.link ? `Linked (${p.link}). Click to change.` : 'Not linked. Click to link.'; },
    tileClick(e, id) {
      const p = this.st.panes.find(x => x.id === id), t = $(`.lptile[data-id="${CSS.escape(id)}"]`); if (!p || !t) return;
      if (e.target.closest('[data-link]')) { p.link = LINKS[(LINKS.indexOf(p.link) + 1) % LINKS.length]; this.head(t, p); this.save(); if (p.link === 'amber') this.post(p, APP.state.sym); }
      else if (e.target.closest('[data-max]')) { t.classList.toggle('max'); $('#lpGrid').classList.toggle('hasmax', !!$('.lptile.max')); }
      else if (e.target.closest('[data-reload]')) { const f = t.querySelector('iframe'); f.src = `${location.pathname}?pane=${encodeURIComponent(p.id)}&fn=${encodeURIComponent(p.fn)}&sym=${encodeURIComponent(p.sym)}`; }
    },
    post(p, sym) { const f = $(`.lptile[data-id="${CSS.escape(p.id)}"] iframe`); if (f && f.contentWindow) f.contentWindow.postMessage({ agula: 'link', sym }, location.origin); },
    fromPane(m) {
      const p = this.st.panes.find(x => x.id === m.id); if (!p) return;
      const symChanged = m.sym && m.sym !== p.sym;
      p.fn = m.fn || p.fn; p.sym = m.sym || p.sym; this.save();
      const t = $(`.lptile[data-id="${CSS.escape(p.id)}"]`); if (t) this.head(t, p);
      if (symChanged && p.link) {
        this.st.panes.forEach(o => { if (o !== p && o.link === p.link && o.sym !== p.sym) { o.sym = p.sym; this.post(o, p.sym); } });
        if (p.link === 'amber' && APP.state.sym !== p.sym) { APP.setSym(p.sym, false); }
      }
    },
    onSym(sym) { this.st.panes.forEach(p => { if (p.link === 'amber' && p.sym !== sym) { p.sym = sym; this.post(p, sym); } }); this.save(); },
    destroy() { const r = $('#screen'); if (r) r.classList.remove('lproot'); },
  });

  // ======================================================================== ALRT — alerts manager
  APP.register('ALRT', {
    title: 'Alerts Manager', global: true,
    render(root) {
      const s = HUB.settings, perm = 'Notification' in window ? Notification.permission : 'unsupported';
      root.innerHTML = `<div class="grid alrtgrid">
        ${panel('New alert', `<div class="fields">
            <div class="field"><label>Symbol</label><input class="txt" id="aSym" value="${esc(APP.state.sym)}"></div>
            <div class="field"><label>When</label><select id="aKind"><option value="px>">Price rises to or above</option><option value="px<">Price falls to or below</option><option value="pct>">Day change is at least +</option><option value="pct<">Day change is at least −</option></select></div>
            <div class="field"><label id="aValL">Price</label><input class="num" id="aVal" type="number" step="any"></div>
            <div class="field"><label>Note (optional)</label><input class="txt" id="aNote" maxlength="80" placeholder="e.g. add on breakout"></div></div>
          <label class="chk mt"><input type="checkbox" id="aRep"> Repeat (re-arms when the condition clears; at most every 10 minutes)</label>
          <div class="row mt"><button class="btn" id="aAdd">Add alert</button><span class="muted small" id="aNow"></span></div>
          <h4 class="subh">Quick alerts</h4><div class="row"><button class="btn ghost sm" id="aW3">±3% day move on every watchlist name</button><button class="btn ghost sm" id="aW5">±5% day move on every watchlist name</button></div>`)}
        ${panel('Delivery', `<label class="chk"><input type="checkbox" id="aSnd" ${s.sound ? 'checked' : ''}> Sound</label> <button class="btn ghost sm" id="aTest">Test</button>
          <div class="mt"><label class="chk"><input type="checkbox" id="aNtf" ${s.notify ? 'checked' : ''}> Browser notifications</label> <span class="muted small" id="aPerm">${perm === 'granted' ? 'allowed' : perm === 'denied' ? 'blocked in your browser settings' : perm === 'unsupported' ? 'not supported here' : 'will ask permission'}</span></div>
          <p class="note small mt">Alerts are checked in this browser every ${s.refreshSec} seconds against live (delayed) quotes while Agula is open in a tab. Paper-bot trades (BOT) also arrive here and in the log below.</p>`)}
        ${panel('Active alerts', '<div id="aList"></div>', { cls: 'span2', id: 'aListP' })}
        ${panel('Triggered', '<div id="aLog"></div>', { cls: 'span2', tools: '<button class="btn ghost sm" id="aClr">Clear log</button>' })}
      </div>`;
      const kind = () => $('#aKind').value;
      const prefill = () => { const q = HUB.quote(HUB.resolve($('#aSym').value) || ''); const k = kind(); $('#aValL').textContent = k.startsWith('pct') ? 'Day change %' : 'Price'; if (k.startsWith('pct')) $('#aVal').value = 3; else if (q) $('#aVal').value = +(q.last * (k === 'px>' ? 1.03 : 0.97)).toPrecision(5); $('#aNow').textContent = q ? `Now ${U.fmtPx(q.last)} (${U.fmtPct(q.chgPct)} today)` : ''; };
      $('#aKind').addEventListener('change', prefill); $('#aSym').addEventListener('change', () => { const s2 = HUB.resolve($('#aSym').value); if (s2) { HUB.track('screen', [s2]); HUB.refreshQuote(s2).then(prefill).catch(() => {}); } });
      prefill();
      $('#aAdd').addEventListener('click', () => {
        const sym = HUB.resolve($('#aSym').value); if (!sym) { APP.toast(HUB.why($('#aSym').value), 'err'); return; }
        const k = kind(), v = parseFloat($('#aVal').value); if (!isFinite(v)) { APP.toast('Enter a value.', 'err'); return; }
        const op = k.endsWith('>') ? '>' : '<', isPct = k.startsWith('pct');
        APP.alerts.add(sym, op, isPct ? (op === '<' ? -Math.abs(v) : Math.abs(v)) / 100 : v, { kind: isPct ? 'pct' : 'px', repeat: $('#aRep').checked, note: $('#aNote').value.trim() });
        this.refresh();
      });
      const bulk = p => { let n = 0; APP.state.watch.filter(x => !HUB.RATE.has(x)).forEach(sym => { if (!APP.alerts.list().some(a => a.sym === sym && a.kind === 'pct' && Math.abs(Math.abs(a.px) - p) < 1e-9)) { APP.state.alerts.push({ id: Date.now() + n * 2, sym, op: '>', px: p, kind: 'pct', repeat: true, note: 'watchlist move', created: Date.now(), armed: true }, { id: Date.now() + n * 2 + 1, sym, op: '<', px: -p, kind: 'pct', repeat: true, note: 'watchlist move', created: Date.now(), armed: true }); n++; } }); APP.alerts.save(); APP.toast(`Added ±${p * 100}% alerts on ${n} watchlist names.`, 'ok'); this.refresh(); };
      $('#aW3').addEventListener('click', () => bulk(0.03)); $('#aW5').addEventListener('click', () => bulk(0.05));
      $('#aSnd').addEventListener('change', e => HUB.saveSettings({ sound: e.target.checked }));
      $('#aTest').addEventListener('click', () => { const was = HUB.settings.sound; HUB.settings.sound = true; APP.alerts.beep('alert'); HUB.settings.sound = was; APP.alerts.notify('Agula alert', 'This is how alerts arrive.'); });
      $('#aNtf').addEventListener('change', async e => {
        if (!e.target.checked) { HUB.saveSettings({ notify: false }); return; }
        if (!('Notification' in window)) { APP.toast('This browser has no notifications.', 'err'); e.target.checked = false; return; }
        const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
        $('#aPerm').textContent = p === 'granted' ? 'allowed' : 'blocked in your browser settings';
        HUB.saveSettings({ notify: p === 'granted' }); e.target.checked = p === 'granted';
      });
      $('#aClr').addEventListener('click', () => { APP.alerts.clearLog(); this.refresh(); });
      root.addEventListener('click', e => {
        const d = e.target.closest('[data-del]'); if (d) { APP.alerts.remove(d.dataset.del); this.refresh(); return; }
        const r = e.target.closest('[data-arm]'); if (r) { const a = APP.alerts.list().find(x => String(x.id) === r.dataset.arm); if (a) { a.hit = false; a.armed = true; APP.alerts.save(); this.refresh(); } return; }
        const s2 = e.target.closest('[data-s]'); if (s2) APP.open('DES', s2.dataset.s);
      });
      HUB.track('screen', APP.alerts.list().map(a => a.sym));
      this.refresh();
    },
    refresh() {
      const L = $('#aList'); if (!L) return;
      const list = APP.alerts.list();
      L.innerHTML = list.length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>Symbol</th><th>Condition</th><th class="r">Now</th><th class="r">Distance</th><th>Status</th><th>Note</th><th>Created</th><th></th></tr></thead><tbody>${list.map(a => {
        const q = HUB.quote(a.sym), now = q ? (a.kind === 'pct' ? q.chgPct : q.last) : null;
        const dist = now == null ? null : a.kind === 'pct' ? a.px - now : a.px / now - 1;
        const st = a.hit && !a.repeat ? '<span class="chipst bad">TRIGGERED</span>' : a.repeat && a.armed === false ? '<span class="chipst">WAITING TO RE-ARM</span>' : '<span class="chipst on">ARMED</span>';
        return `<tr><td class="key clk" data-s="${esc(a.sym)}">${esc(a.sym)}</td><td>${esc(APP.alerts.text(a))}${a.repeat ? ' ↻' : ''}</td><td class="r">${now == null ? '—' : a.kind === 'pct' ? U.fmtPct(now) : U.fmtPx(now)}</td><td class="r muted">${dist == null ? '—' : a.kind === 'pct' ? (dist * 100).toFixed(2) + ' pts' : U.fmtPct(dist, 2)}</td><td>${st}</td><td class="muted wrap">${esc(a.note || '')}</td><td class="small muted">${a.created ? new Date(a.created).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' }) : ''}</td><td class="r">${a.hit ? `<button class="chipbtn" data-arm="${a.id}">Re-arm</button>` : ''} <button class="chipbtn" data-del="${a.id}">Delete</button></td></tr>`;
      }).join('')}</tbody></table></div>` : '<div class="empty small">No alerts yet. Add one on the left, or type <b>ALERT NVDA &gt; 200</b> / <b>ALERT TSLA -5%</b> in the command line.</div>';
      const log = APP.alerts.log();
      $('#aLog').innerHTML = log.length ? `<div class="tblwrap short"><table class="tbl"><tbody>${log.map(l => `<tr><td class="small muted">${new Date(l.t).toLocaleString('en-GB', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td><td><span class="chipst ${l.kind === 'bot' ? 'on' : 'bad'}">${l.kind === 'bot' ? 'BOT' : 'ALERT'}</span></td><td class="wrap">${esc(l.text)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty small">Nothing triggered yet.</div>';
    },
    onTick() { clearTimeout(this._t); this._t = setTimeout(() => this.refresh(), 300); },
  });
})();
