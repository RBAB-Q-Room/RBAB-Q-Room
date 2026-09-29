'use strict';
/* Guest page. No login: the unguessable token in the link is the only credential.
   The server returns guest-safe fields only (no contact details, staff notes or room number).
   The first render uses data embedded in the page by doGet, so there is no loading screen. */
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
    key: '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L21 2M16 7l3 3"/>',
    heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    chev: '<path d="M6 9l6 6 6-6"/>',
    arrow: '<path d="M7 17L17 7M9 7h8v8"/>',
    star: '<path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.3L12 17.1l-5.7 3.1 1.2-6.3L2.8 9.5l6.4-.8z"/>',
  };
  const svg = (n, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n] || ''}</svg>`;

  let lang = 'en', data = null, version = null, timer = null, fails = 0, lastPhase = null, fb = { rating: 0, helpful: '', sent: false };
  const T = (k, vars) => { let s = (WG_I18N[lang] && WG_I18N[lang][k]) || WG_I18N.en[k] || k; if (vars) for (const v in vars) s = s.replace('{' + v + '}', vars[v]); return s; };
  const pick = (o) => (o && (o[lang] || o.en)) || '';
  const fmtD = (d, opts) => (d ? new Date(d + 'T00:00:00').toLocaleDateString(langInfo(lang).locale, opts || { day: 'numeric', month: 'short' }) : '');
  const storedLang = () => { try { const l = localStorage.getItem('wg-guest-lang'); return WG_LANGS.some((x) => x.code === l) ? l : null; } catch (e) { return null; } };
  function applyLang(l) {
    lang = l;
    document.documentElement.lang = l;
    document.documentElement.dir = langInfo(l).dir;
  }

  root.innerHTML = `<div class="g-shell">
    <header class="g-top"><div class="logo-chip"><img src="${WG_ASSETS.logo}" alt="Rixos Bab Al Bahr"></div><div id="gLang"></div></header>
    <main id="gApp"><section class="hero"><div class="skeleton" style="height:18px;width:40%;margin:0 auto;opacity:.4"></div><div class="skeleton" style="height:56px;margin-top:16px;opacity:.4"></div></section></main>
  </div>`;
  const app = $('#gApp');

  function langMenu() {
    $('#gLang').innerHTML = `<details class="lang"><summary aria-label="${esc(T('language'))}">${svg('globe')}<span>${esc(langInfo(lang).name)}</span></summary>
      <div class="lang-list" role="list">${WG_LANGS.map((l) => `<button type="button" role="listitem" data-lang="${l.code}" lang="${l.code}" dir="${l.dir}" aria-current="${l.code === lang}">${l.name}</button>`).join('')}</div></details>`;
    $$('#gLang [data-lang]').forEach((b) => b.addEventListener('click', () => {
      try { localStorage.setItem('wg-guest-lang', b.dataset.lang); } catch (e) { /* remembered for this page only */ }
      const open = $$('.x-item', app).map((d) => d.open);
      applyLang(b.dataset.lang);
      render(false);
      $$('.x-item', app).forEach((d, i) => { d.open = !!open[i]; });
    }));
  }

  function heroHtml(g, c) {
    const steps = [['received', 'stepReceived'], ['assigned', 'stepAssigned'], ['preparing', 'stepPreparing'], ['ready', 'stepReady']];
    const idx = { received: 0, assigned: 1, preparing: 2, ready: 3, completed: 4 }[g.phase];
    const waiting = idx !== undefined && idx < 3;
    const progress = idx === undefined || idx > 3 ? '' : `<ol class="steps" aria-label="${esc(T('progress'))}">${steps.map(([k, label], i) =>
      `<li class="${i < idx || g.phase === 'ready' ? 'done' : ''} ${i === idx && waiting ? 'now' : ''}" ${i === idx ? 'aria-current="step"' : ''}><i></i><span>${esc(T(label))}</span></li>`).join('')}</ol>`;
    if (g.phase === 'ready') {
      return `<section class="hero ready" aria-live="polite" aria-labelledby="st">
        <div class="mark">${svg('key')}</div>
        <div class="eyebrow">${esc(T('readyEyebrow'))}</div>
        <h1 id="st">${esc(T('readyTitle'))}</h1>
        <p class="lead">${esc(T('readyText'))}</p>${progress}
        <div class="ref"><span>${esc(T('reference'))}</span><b dir="ltr">${esc(g.wgNumber)}</b></div>
        <p class="small">${esc(T('readyShow'))}</p></section>`;
    }
    if (g.phase === 'completed') {
      return `<section class="hero done" aria-labelledby="st"><div class="mark">${svg('heart')}</div><h1 id="st">${esc(T('doneTitle'))}</h1><p class="lead">${esc(T('doneText'))}</p></section>`;
    }
    if (g.phase === 'cancelled') {
      return `<section class="hero quiet" aria-labelledby="st"><div class="mark">${svg('info')}</div><h1 id="st">${esc(T('cancelTitle'))}</h1><p class="lead">${esc(T('cancelText'))}</p></section>`;
    }
    return `<section class="hero waiting" aria-live="polite" aria-labelledby="st">
      <div class="mark breathing"><span></span></div>
      <h1 id="st">${esc(T('preparingTitle'))}</h1>
      <p class="lead">${esc(T('preparingSub'))}</p>${progress}
      <p class="note">${esc(T('note_' + g.phase))}</p>
      <div class="ref"><span>${esc(T('reference'))}</span><b dir="ltr">${esc(g.wgNumber)}</b></div></section>`;
  }

  function stayHtml(g) {
    const dates = `${fmtD(g.arrivalDate)} – ${fmtD(g.departureDate, { day: 'numeric', month: 'short', year: 'numeric' })}`;
    return `<section class="stay" aria-label="${esc(T('yourStay'))}"><dl>
      <div><dt>${esc(T('guest'))}</dt><dd>${esc(g.guestName)}</dd></div>
      <div><dt>${esc(T('roomType'))}</dt><dd>${esc(g.roomTypeName || g.roomType)}</dd></div>
      <div><dt>${esc(T('stay'))}</dt><dd>${esc(dates)}</dd></div>
      <div><dt>${esc(T('confirmation'))}</dt><dd dir="ltr">${esc(g.confirmationNo)}</dd></div></dl></section>`;
  }

  function feedbackHtml(g) {
    if (fb.sent || g.feedbackGiven) return fb.sent ? `<section class="fb done" role="status">${svg('heart')}<p>${esc(T('fbThanks'))}</p></section>` : '';
    if (!g.canGiveFeedback) return '';
    return `<section class="fb" aria-labelledby="fbT"><h2 id="fbT">${esc(T('fbTitle'))}</h2>
      <div class="stars" role="radiogroup" aria-label="${esc(T('fbTitle'))}">${[1, 2, 3, 4, 5].map((n) => `<button type="button" role="radio" aria-checked="${fb.rating === n}" class="${fb.rating >= n ? 'on' : ''}" data-star="${n}" aria-label="${esc(T('fbStar', { n }))}">${svg('star')}</button>`).join('')}</div>
      <div class="helpful" ${fb.rating ? '' : 'hidden'}><p>${esc(T('fbHelpful'))}</p><div class="yn">${['yes', 'no'].map((v) => `<button type="button" data-helpful="${v}" aria-pressed="${fb.helpful === v}">${esc(T(v))}</button>`).join('')}</div>
      <button type="button" class="send" id="fbSend">${esc(T('fbSend'))}</button><p class="fb-err" id="fbErr" hidden>${esc(T('fbError'))}</p></div></section>`;
  }

  function discoverHtml(g, c) {
    if (!c || g.phase === 'cancelled') return '';
    const highlights = c.sections.filter((s) => s.highlight && pick(s.highlight));
    const links = [];
    if (c.links.map && c.links.map.url) links.push(`<a class="qlink" href="${esc(c.links.map.url)}" target="_blank" rel="noopener noreferrer">${svg('map')}<span><b>${esc(T('map'))}</b><small>${esc(T('mapSub'))}</small></span>${svg('arrow', 'out')}</a>`);
    if (c.links.website && c.links.website.url) links.push(`<a class="qlink" href="${esc(c.links.website.url)}" target="_blank" rel="noopener noreferrer">${svg('globe')}<span><b>${esc(T('website'))}</b><small>${esc(c.hotelName)}</small></span>${svg('arrow', 'out')}</a>`);
    const waiting = ['received', 'assigned', 'preparing'].includes(g.phase);
    if (!highlights.length && !links.length && !c.sections.length) return '';
    return `<section class="discover" aria-labelledby="dT">
      <h2 id="dT">${esc(waiting ? T('whileWait') : T('explore'))}</h2>
      ${waiting && !pick(c.welcome).toLowerCase().startsWith(T('whileWait').toLowerCase()) ? `<p class="dsub">${esc(pick(c.welcome))}</p>` : ''}
      ${highlights.length ? `<div class="today"><span class="label">${esc(T('happening'))}</span><ul>${highlights.map((s) => `<li>${svg(s.icon)}<span>${esc(pick(s.highlight))}</span></li>`).join('')}</ul></div>` : ''}
      ${links.length ? `<div class="qlinks">${links.join('')}</div>` : ''}
      ${c.sections.length ? `<div class="xlist">${c.sections.map((s) => `<details class="x-item"><summary><span class="ic">${svg(s.icon)}</span><span class="tt">${esc(pick(s.title))}</span>${svg('chev', 'chev')}</summary>
        <div class="body"><p>${esc(pick(s.body))}</p>${pick(s.note) ? `<p class="note2">${esc(pick(s.note))}</p>` : ''}${s.placeholder ? `<span class="soon">${esc(T('detailsSoon'))}</span>` : ''}</div></details>`).join('')}</div>` : ''}
    </section>`;
  }

  function render(animate) {
    langMenu();
    const g = data.waitingGuest, c = data.content;
    if (g.phase === 'expired') {
      app.innerHTML = `<section class="hero quiet"><div class="mark">${svg('lock')}</div><h1>${esc(T('expiredTitle'))}</h1><p class="lead">${esc(T('expiredText'))}</p></section>`;
      document.title = 'Rixos Bab Al Bahr';
      return;
    }
    const becameReady = animate && lastPhase && lastPhase !== 'ready' && g.phase === 'ready';
    app.innerHTML = heroHtml(g, c) + (g.phase === 'cancelled' ? '' : stayHtml(g)) + feedbackHtml(g) + discoverHtml(g, c)
      + `<footer class="g-foot"><span class="live-note"><i></i>${esc(T('live'))}</span><span>${esc(c ? c.hotelName : '')}</span></footer>`;
    wireFeedback();
    if (becameReady) {
      $('.hero', app).classList.add('arrive');
      try { if (navigator.vibrate) navigator.vibrate([120, 60, 120]); } catch (e) { /* not supported */ }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (animate && lastPhase && lastPhase !== g.phase) {
      $('.hero', app).classList.add('step-change');
    }
    document.title = (g.phase === 'ready' ? T('tabTitleReady') : T('tabTitle')) + ' · ' + ((c && c.hotelName) || 'Rixos Bab Al Bahr');
    lastPhase = g.phase;
  }

  function wireFeedback() {
    $$('[data-star]', app).forEach((b) => b.addEventListener('click', () => { fb.rating = Number(b.dataset.star); render(false); const s = $(`[data-star="${fb.rating}"]`, app); if (s) s.focus(); }));
    $$('[data-helpful]', app).forEach((b) => b.addEventListener('click', () => { fb.helpful = fb.helpful === b.dataset.helpful ? '' : b.dataset.helpful; render(false); }));
    const send = $('#fbSend', app);
    if (send) send.addEventListener('click', async () => {
      send.disabled = true;
      const r = await transport('POST', `/api/guest/${encodeURIComponent(token)}/feedback`, { rating: fb.rating, helpful: fb.helpful });
      if (r.status === 200 || r.status === 409) { fb.sent = true; render(false); } else { send.disabled = false; $('#fbErr', app).hidden = false; }
    });
  }

  function invalid() {
    langMenu();
    app.innerHTML = `<section class="hero quiet"><div class="mark">${svg('info')}</div><h1>${esc(T('invalidTitle'))}</h1><p class="lead">${esc(T('invalidText'))}</p></section>`;
  }

  function conn(ok) {
    let el = document.getElementById('conn');
    if (ok) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'conn'; el.className = 'conn'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = T('reconnecting');
  }

  async function load(full) {
    try {
      const visible = !document.hidden;
      const q = [];
      if (!full && version !== null && data) q.push(`v=${version}`, 'have=1');
      if (visible) q.push('seen=1');
      const r = await transport('GET', `/api/guest/${encodeURIComponent(token)}${q.length ? '?' + q.join('&') : ''}`);
      if (r.status === 404) { invalid(); stop(); return; }
      if (r.status === 0 || r.status >= 500) throw new Error('unavailable');
      if (r.status >= 400) throw new Error('bad');
      fails = 0; conn(true);
      if (r.body.unchanged) return;
      version = r.body.version;
      const first = !data;
      const changed = first || JSON.stringify(data.waitingGuest) !== JSON.stringify(r.body.waitingGuest) || JSON.stringify(data.content) !== JSON.stringify(r.body.content);
      data = r.body;
      if (first) applyLang(storedLang() || data.waitingGuest.language || 'en');
      if (changed) render(!first); // only redraw on a real change, so open cards and scroll position stay put
      if (data.waitingGuest.phase === 'expired') stop();
    } catch (e) { fails++; if (fails >= 2) conn(false); }
  }
  function stop() { clearTimeout(timer); timer = null; }
  function loop() {
    stop();
    timer = setTimeout(async () => { if (!document.hidden) await load(false); if (timer !== null || fails) loop(); }, fails ? Math.min(30000, 5000 * (fails + 1)) : 5000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(false); });

  // First paint from the data embedded by the server; then confirm with a live request (this also records the visit).
  const pre = WG.boot.data;
  if (pre && pre.waitingGuest) {
    data = pre; version = pre.version;
    applyLang(storedLang() || pre.waitingGuest.language || 'en');
    render(false);
    if (pre.waitingGuest.phase === 'expired') return;
  } else if (WG.boot.platform === 'gas' && !pre) {
    applyLang(storedLang() || 'en');
  }
  load(true).then(loop);
};
