'use strict';
/* Guest page. No login: the unguessable token in the link is the only credential.
   The server returns guest-safe fields only (no phone, email, staff notes or room number). */
WG.views.guest = function (root, token) {
  const ICON = {
    sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
    pool: '<path d="M2 18c1.5 0 1.5 1 3 1s1.5-1 3-1 1.5 1 3 1 1.5-1 3-1 1.5 1 3 1 1.5-1 3-1M2 13c1.5 0 1.5 1 3 1s1.5-1 3-1 1.5 1 3 1 1.5-1 3-1 1.5 1 3 1 1.5-1 3-1M8 12V5a2 2 0 0 1 4 0M14 12V5a2 2 0 0 1 4 0M8 8h6"/>',
    beach: '<path d="M12 12L3 21M12 3a9 9 0 0 1 9 9H3a9 9 0 0 1 9-9zM2 21h20"/>',
    dining: '<path d="M7 3v8a2 2 0 0 0 2 2v8M5 3v6M9 3v6M17 21V3c-2.5 1-4 3.5-4 7 0 2 1 3 4 3"/>',
    activity: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>',
    wifi: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a14 14 0 0 1 20 0"/><circle cx="12" cy="19.5" r=".8"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
    map: '<path d="M9 20l-6-3V5l6 3m0 12l6-3m-6 3V8m6 9l6 3V7l-6-3m0 15V5m0 0L9 8"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    hourglass: '<path d="M6 2h12M6 22h12M7 2v4a5 5 0 0 0 2 4l3 2-3 2a5 5 0 0 0-2 4v4M17 2v4a5 5 0 0 1-2 4l-3 2 3 2a5 5 0 0 1 2 4v4"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L21 2M16 7l3 3"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/>',
    chev: '<path d="M6 9l6 6 6-6"/>',
  };
  const svg = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n] || ''}</svg>`;
  const fmtD = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString(langInfo(lang).locale, { weekday: 'short', day: 'numeric', month: 'short' }) : '-');
  const T = (k) => (WG_I18N[lang] && WG_I18N[lang][k]) || WG_I18N.en[k] || k;
  const pick = (o) => (o && (o[lang] || o.en)) || '';
  const HERO = {
    preparing: { cls: '', icon: 'hourglass', eyebrow: 'roomStatus', title: 'preparingTitle', text: null },
    ready: { cls: 'ready', icon: 'key', eyebrow: 'roomStatus', title: 'readyTitle', text: 'readyText' },
    completed: { cls: 'done', icon: 'heart', eyebrow: 'doneEyebrow', title: 'doneTitle', text: 'doneText' },
    cancelled: { cls: 'done', icon: 'info', eyebrow: 'cancelEyebrow', title: 'cancelTitle', text: 'cancelText' },
  };

  let lang = 'en';
  const storedLang = () => { try { const l = localStorage.getItem('wg-guest-lang'); return WG_LANGS.some((x) => x.code === l) ? l : null; } catch (e) { return null; } };
  function applyLang(l) {
    lang = l;
    const info = langInfo(l);
    document.documentElement.lang = l;
    document.documentElement.dir = info.dir;
  }

  let data = null, phase = null, version = null, timer = null, fails = 0;
  root.innerHTML = `<div class="g-shell"><header class="g-top"><div class="logo-chip"><img src="${WG_ASSETS.logo}" alt="Rixos Bab Al Bahr"></div></header>
    <main id="gApp" aria-live="polite"><div class="hero skeleton-hero"><div class="skeleton" style="height:22px;width:50%;margin:0 auto"></div><div class="skeleton" style="height:64px;margin-top:18px"></div></div></main>
    <footer class="g-foot">Rixos Bab Al Bahr</footer></div>`;
  const app = $('#gApp');

  function render() {
    const { waitingGuest: g, content: c } = data;
    const h = HERO[g.phase] || HERO.preparing;
    const welcome = pick(c.welcome);
    const idx = { preparing: 1, ready: 2, completed: 3, cancelled: 0 }[g.phase];
    const P = [T('stepReceived'), T('stepPreparing'), T('stepReady')];
    const prog = g.phase === 'cancelled' ? '' : `<div class="progress" aria-label="Progress">${P.map((l, i) => {
      const on = i < idx || (i === idx && g.phase !== 'preparing') || g.phase === 'completed';
      const cur = i === idx && g.phase === 'preparing';
      return `<div class="p ${on ? 'on' : ''} ${cur ? 'cur' : ''}"><i></i>${l}</div>${i < P.length - 1 ? `<div class="ln ${i < idx ? 'on' : ''}"></div>` : ''}`;
    }).join('')}</div><div style="height:14px"></div>`;
    const link = (l, ic, label, sub) => l && l.url
      ? `<a class="link-btn" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${svg(ic)}${esc(label)}<small>${esc(sub)}</small></a>`
      : `<div class="link-btn off" aria-disabled="true">${svg(ic)}${esc(label)}<small>${esc(T('comingSoon'))}</small></div>`;
    const showInfo = g.phase !== 'cancelled';
    const switcher = `<nav class="lang" aria-label="${esc(T('language'))}">${WG_LANGS.map((l) => `<button type="button" data-lang="${l.code}" lang="${l.code}" class="${l.code === lang ? 'on' : ''}" aria-pressed="${l.code === lang}">${l.name}</button>`).join('')}</nav>`;
    app.innerHTML = `${switcher}
      <section class="hero ${h.cls}" aria-labelledby="st">
        <div class="badge">${svg(h.icon)}</div><div class="eyebrow">${esc(T(h.eyebrow))}</div>
        <h1 id="st">${esc(T(h.title))}</h1><p>${esc(h.text ? T(h.text) : welcome)}</p>
        <div class="ref"><span>${esc(T('wgNumber'))}</span><b dir="ltr">${esc(g.wgNumber)}</b></div>
      </section>
      <section class="card g-card" aria-label="${esc(T('guest'))}"><div class="kv">
        <div><span>${esc(T('guest'))}</span><b>${esc(g.guestName)}</b></div><div><span>${esc(T('confirmation'))}</span><b dir="ltr" style="text-align:start">${esc(g.confirmationNo)}</b></div>
        <div><span>${esc(T('roomType'))}</span><b dir="ltr" style="text-align:start">${esc(g.roomType)}</b></div><div><span>${esc(T('arrival'))}</span><b>${fmtD(g.arrivalDate)}${g.arrivalTime ? `${langInfo(lang).dir === 'rtl' ? ' ' : ' · '}<bdi dir="ltr">${esc(g.arrivalTime)}</bdi>` : ''}</b></div></div>${prog}</section>
      ${showInfo ? `<h2 class="sec-title wait-title">${esc(g.phase === 'ready' ? T('around') : T('whileWait'))}</h2>
      <p class="wait-sub">${esc(g.phase === 'ready' ? T('aroundSub') : welcome)}</p>
      <div class="links">${link(c.links.map, 'map', T('map'), T('mapSub'))}${link(c.links.website, 'globe', T('website'), c.hotelName)}</div>
      <div class="cards">${c.sections.map((s) => `<details class="tile"><summary><span class="ic">${svg(s.icon)}</span><span class="tt">${esc(pick(s.title))}</span><span class="chev">${svg('chev')}</span></summary>
        <div class="body">${esc(pick(s.body))}${pick(s.note) ? `<div style="margin-top:8px;font-size:12.5px">${esc(pick(s.note))}</div>` : ''}${s.placeholder ? `<div><span class="soon">${esc(T('detailsSoon'))}</span></div>` : ''}</div></details>`).join('')}</div>
      <p class="notice">${esc(T('notice'))}</p>` : ''}`;
    $$('.lang button', app).forEach((b) => b.addEventListener('click', () => {
      try { localStorage.setItem('wg-guest-lang', b.dataset.lang); } catch (e) { /* remembered for this page only */ }
      const wasOpen = $$('details.tile', app).map((d) => d.open); // keep the cards the guest had opened
      applyLang(b.dataset.lang);
      render();
      $$('details.tile', app).forEach((d, i) => { d.open = !!wasOpen[i]; });
    }));
    if (phase && phase !== g.phase) {
      try { navigator.vibrate && navigator.vibrate(g.phase === 'ready' ? [120, 60, 120] : 40); } catch (e) { /* not supported */ }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
    document.title = (g.phase === 'ready' ? T('tabTitleReady') : T('tabTitle')) + ' · Rixos Bab Al Bahr';
    phase = g.phase;
  }

  function conn(ok) {
    let el = document.getElementById('conn');
    if (ok) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'conn'; el.className = 'conn'; el.textContent = T('reconnecting'); document.body.appendChild(el); }
  }

  async function load() {
    try {
      const r = await transport('GET', `/api/guest/${encodeURIComponent(token)}${version !== null && data ? `?v=${version}&have=1` : ''}`);
      if (r.status === 404) { applyLang(storedLang() || 'en'); app.innerHTML = `<div class="err-view"><h1>${esc(T('invalidTitle'))}</h1><p class="muted">${esc(T('invalidText'))}</p></div>`; stop(); return; }
      if (r.status === 0 || r.status >= 500) throw new Error('unavailable');
      if (r.status >= 400) throw new Error('bad');
      fails = 0; conn(true);
      if (r.body.unchanged) return;
      version = r.body.version;
      const changed = !data || JSON.stringify(data.waitingGuest) !== JSON.stringify(r.body.waitingGuest);
      const firstLoad = !data;
      data = r.body;
      if (firstLoad) applyLang(storedLang() || data.waitingGuest.language || 'en'); // guest's own choice wins over Reception's
      if (changed || firstLoad) render(); // only redraw on a real change, so open cards and scroll position are left alone
    } catch (e) { fails++; if (fails >= 2) conn(false); }
  }
  function stop() { clearTimeout(timer); timer = null; }
  function loop() {
    stop();
    timer = setTimeout(async () => { if (!document.hidden) await load(); loop(); }, fails ? Math.min(30000, 6000 * (fails + 1)) : 6000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && timer !== null) load(); });
  load().then(loop);
};
