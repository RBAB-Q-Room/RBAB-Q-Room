'use strict';
/* Management: measured analytics, an illustrative business case, the guest page content,
   settings, data imports and staff users. Measured figures and assumptions are never mixed. */
WG.views.admin = function (root, user) {
  const S = { tab: 'analytics', range: 'today', users: [], roomTypes: {}, imp: null, settings: null, content: null, editId: null, editLang: 'en' };
  const TABS = [['analytics', 'Analytics'], ['guest', 'Guest page'], ['settings', 'Settings'], ['data', 'Data'], ['users', 'Users']];

  root.innerHTML = `<div id="topbar"></div>
    <div class="ad-wrap"><nav class="ad-tabs" role="tablist" id="adTabs">${TABS.map(([k, l]) => `<button role="tab" data-tab="${k}" aria-selected="false">${l}</button>`).join('')}</nav>
    <main id="adBody" aria-live="polite"></main></div>`;
  mountTopbar(user, 'Management');

  $('#adTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) go(b.dataset.tab); });
  function go(tab) {
    S.tab = tab; S.imp = null;
    $$('#adTabs button').forEach((b) => { b.classList.toggle('on', b.dataset.tab === tab); b.setAttribute('aria-selected', b.dataset.tab === tab); });
    ({ analytics, guest: guestPage, settings, data: dataTab, users })[tab]();
  }
  const body = () => $('#adBody');
  const err = (e) => { if (!e.silent) toast(e.message, 'err'); };
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + '%' : '-');
  const tile = (label, value, sub, cls = '') => `<div class="metric ${cls}"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;

  /* ---------- analytics (measured) ---------- */
  async function analytics(quiet) {
    if (!quiet) body().innerHTML = '<div class="skeleton" style="height:120px"></div><div class="skeleton" style="height:240px;margin-top:14px"></div>';
    try {
      const [m, st, sum] = await Promise.all([api('GET', `/api/metrics?range=${S.range}`), api('GET', '/api/admin/settings'), api('GET', '/api/admin/summary')]);
      S.settings = st.values;
      const rangeName = { today: 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days' }[S.range];
      const warn = [];
      if (!sum.rooms) warn.push('No rooms yet. Import rooms (Data tab) so the Rooms Controller can assign them.');
      if (!sum.arrivalsToday) warn.push(`No reservations arriving today (${fmtDate(sum.today)}). Import today's arrivals (Data tab) so Reception can look guests up.`);
      if (st.placeholders && S.settings.guest_show_placeholders !== '0') warn.push(`${st.placeholders} resort sections on the guest page still show placeholder text. Edit them in the Guest page tab.`);
      body().innerHTML = `${warn.map((w) => `<div class="banner info">${icon('alert')}<span>${esc(w)}</span></div>`).join('')}
        <div class="ad-row"><h2 class="serif ad-h">Right now</h2></div>
        <div class="ad-cards">
          ${tile('Waiting for a room', m.stillWaitingForRoom)}
          ${tile('Longest wait now', m.stillWaitingForRoom ? fmtWait(m.longestActiveWaitSec) : '-', '', m.longestActiveWaitSec / 60 >= Number(S.settings.late_alert_minutes) ? 'hot' : '')}
          ${tile('Ready, guest not back', m.readyAwaitingGuest, '', 'good')}
          ${tile('Active records', m.active)}
        </div>
        <div class="ad-row"><h2 class="serif ad-h">${rangeName} <span class="measured">Measured</span></h2>
          <div class="seg" role="tablist" aria-label="Period">${[['today', 'Today'], ['7d', '7 days'], ['30d', '30 days']].map(([k, l]) => `<button role="tab" data-range="${k}" class="${S.range === k ? 'on' : ''}" aria-selected="${S.range === k}">${l}</button>`).join('')}</div></div>
        <div class="ad-cards">
          ${tile('Waiting guests', m.created, m.cancelled ? `${m.cancelled} cancelled, not counted` : '')}
          ${tile('Completed', m.completed)}
          ${tile('Avg. wait until room ready', fmtDuration(m.avgWaitToReadySec))}
          ${tile('Avg. room ready → guest back', fmtDuration(m.avgReadyToReturnSec))}
          ${tile('Guest saw "room ready"', m.readyCount ? `${fmtDuration(m.avgAwarenessSec)}` : '-', m.readyCount ? `avg. after ready · ${m.awareCount} of ${m.readyCount} guests looked` : 'no rooms ready yet')}
          ${tile('Guests who opened their QR page', pct(m.qrOpened, m.created), m.created ? `${m.qrOpened} of ${m.created}` : '')}
          ${tile('Avg. time to create a Waiting Guest', fmtDuration(m.avgCreateSec), 'Reception, from reservation to QR')}
          ${tile('Guest rating', m.feedbackCount ? `${m.avgRating} / 5` : '-', m.feedbackCount ? `${m.feedbackCount} response${m.feedbackCount === 1 ? '' : 's'} · status page helpful ${pct(m.helpfulYes, m.helpfulAnswered)}` : 'no feedback yet')}
        </div>
        <section class="card chart-card"><h3>Waiting guests by hour of arrival <small>${rangeName}, hotel time</small></h3>${barChart(m.hourly.map((v, h) => ({ label: String(h).padStart(2, '0') + ':00', short: h % 3 === 0 ? String(h).padStart(2, '0') : '', value: v })), 'hour')}</section>
        ${S.range !== 'today' ? `<section class="card chart-card"><h3>Waiting guests per day <small>${rangeName}</small></h3>${barChart(m.daily.map((d, i) => ({ label: fmtDate(d.date), short: (m.daily.length <= 7 || i % 5 === 0) ? new Date(d.date + 'T00:00:00').toLocaleDateString([], { day: 'numeric', month: 'short' }) : '', value: d.count })), 'day')}</section>` : ''}
        ${businessCase(m)}`;
      $$('[data-range]').forEach((b) => b.onclick = () => { S.range = b.dataset.range; analytics(); });
      wireCharts();
      wireBusinessCase(m);
    } catch (e) { err(e); }
  }

  /** Single-series column chart: thin bars from one baseline, peak labelled, hover tooltip, table view. */
  function barChart(points, unit) {
    // drawn at the real container width so bars and labels are never stretched
    const W = Math.max(300, Math.min(1080, (body().clientWidth || 720) - 40)), H = 190, padL = 30, padB = 24, padT = 16;
    const max = Math.max(1, ...points.map((p) => p.value));
    const step = max <= 5 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : Math.ceil(max / 5 / 10) * 10;
    const top = Math.ceil(max / step) * step;
    const y = (v) => padT + (H - padT - padB) * (1 - v / top);
    const slot = (W - padL) / points.length;
    const bw = Math.max(4, Math.min(24, slot - 2));
    const peak = points.reduce((a, p, i) => (p.value > points[a].value ? i : a), 0);
    const ticks = []; for (let v = 0; v <= top; v += step) ticks.push(v);
    const bars = points.map((p, i) => {
      const x = padL + slot * i + (slot - bw) / 2, h = y(0) - y(p.value), r = Math.min(4, h / 2);
      const path = p.value ? `M${x},${y(0)} V${y(p.value) + r} Q${x},${y(p.value)} ${x + r},${y(p.value)} H${x + bw - r} Q${x + bw},${y(p.value)} ${x + bw},${y(p.value) + r} V${y(0)} Z` : '';
      return `<g class="bar-g" data-tip="${esc(p.label)}: ${p.value} waiting guest${p.value === 1 ? '' : 's'}">
        <rect class="hit" x="${padL + slot * i}" y="${padT}" width="${slot}" height="${H - padT - padB}"></rect>
        ${path ? `<path class="bar" d="${path}"></path>` : ''}
        ${i === peak && p.value ? `<text class="peak" x="${x + bw / 2}" y="${y(p.value) - 5}" text-anchor="middle">${p.value}</text>` : ''}
        ${p.short ? `<text class="xl" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(p.short)}</text>` : ''}</g>`;
    }).join('');
    const total = points.reduce((a, p) => a + p.value, 0);
    return `<div class="chart" role="img" aria-label="${total} waiting guests, peak ${points[peak].value} at ${esc(points[peak].label)}">
      <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${ticks.map((v) => `<line class="grid" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"></line><text class="yl" x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('')}${bars}</svg>
      <div class="tip" hidden></div></div>
      ${total ? '' : '<p class="muted chart-empty">No waiting guests in this period yet.</p>'}
      <details class="as-table"><summary>Show as table</summary><div class="table-wrap"><table class="tbl"><thead><tr><th>${unit === 'hour' ? 'Hour' : 'Day'}</th><th>Waiting guests</th></tr></thead><tbody>${points.map((p) => `<tr><td>${esc(p.label)}</td><td class="num">${p.value}</td></tr>`).join('')}</tbody></table></div></details>`;
  }
  function wireCharts() {
    $$('.chart').forEach((c) => {
      const tip = $('.tip', c);
      c.addEventListener('pointermove', (e) => {
        const g = e.target.closest('.bar-g');
        if (!g) { tip.hidden = true; return; }
        $$('.bar-g.hl', c).forEach((x) => x !== g && x.classList.remove('hl')); g.classList.add('hl');
        const r = c.getBoundingClientRect();
        tip.textContent = g.dataset.tip; tip.hidden = false;
        tip.style.left = Math.min(r.width - tip.offsetWidth - 4, Math.max(4, e.clientX - r.left - tip.offsetWidth / 2)) + 'px';
        tip.style.top = Math.max(0, e.clientY - r.top - 40) + 'px';
      });
      c.addEventListener('pointerleave', () => { tip.hidden = true; $$('.bar-g.hl', c).forEach((x) => x.classList.remove('hl')); });
    });
  }

  /* ---------- business case (illustrative, from editable assumptions) ---------- */
  const BC = [
    ['bc_daily_checkins', 'Check-ins per day', ''],
    ['bc_waiting_pct', 'Share of check-ins that wait', '%'],
    ['bc_manual_minutes', 'Reception minutes per paper Waiting Card', 'min'],
    ['bc_digital_minutes', 'Reception minutes per digital Waiting Guest', 'min', 'blank = measured'],
    ['bc_print_pieces', 'Printed pieces per paper Waiting Card', ''],
    ['bc_print_cost', 'Cost per printed piece', 'AED'],
    ['bc_comm_minutes', 'Minutes of manual follow-up per waiting guest', 'min'],
    ['bc_qr_adoption_pct', 'Guests who follow the QR page', '%', 'blank = measured'],
  ];
  function bcCalc(v, m) {
    const n = (k) => (v[k] === '' || v[k] == null ? null : Number(v[k]));
    const measuredDigital = m.avgCreateSec != null ? m.avgCreateSec / 60 : null;
    const measuredAdoption = m.created ? (m.qrOpened / m.created) * 100 : null;
    const perDay = n('bc_daily_checkins') != null && n('bc_waiting_pct') != null ? n('bc_daily_checkins') * n('bc_waiting_pct') / 100 : null;
    const digital = n('bc_digital_minutes') != null ? n('bc_digital_minutes') : measuredDigital;
    const adoption = n('bc_qr_adoption_pct') != null ? n('bc_qr_adoption_pct') : measuredAdoption;
    const out = { perDay, digital, digitalMeasured: n('bc_digital_minutes') == null && measuredDigital != null, adoption, adoptionMeasured: n('bc_qr_adoption_pct') == null && measuredAdoption != null };
    out.deskMin = perDay != null && n('bc_manual_minutes') != null && digital != null ? perDay * Math.max(0, n('bc_manual_minutes') - digital) : null;
    out.printAed = perDay != null && n('bc_print_pieces') != null && n('bc_print_cost') != null ? perDay * n('bc_print_pieces') * n('bc_print_cost') : null;
    out.printPieces = perDay != null && n('bc_print_pieces') != null ? perDay * n('bc_print_pieces') : null;
    out.commMin = perDay != null && n('bc_comm_minutes') != null && adoption != null ? perDay * n('bc_comm_minutes') * adoption / 100 : null;
    return out;
  }
  const hrs = (min) => (min == null ? null : min >= 60 ? `${(min / 60).toFixed(min >= 600 ? 0 : 1)} h` : `${Math.round(min)} min`);
  const aed = (x) => (x == null ? null : 'AED ' + Math.round(x).toLocaleString());
  function bcOutputs(c) {
    const need = (what) => `<span class="need">Enter ${what}</span>`;
    const row = (label, day, fmt, needWhat) => `<tr><th scope="row">${label}</th>${day == null ? `<td colspan="3">${need(needWhat)}</td>` : `<td>${fmt(day)}</td><td>${fmt(day * 30)}</td><td>${fmt(day * 365)}</td>`}</tr>`;
    return `<table class="tbl bc-out"><thead><tr><th></th><th>Per day</th><th>Per month</th><th>Per year</th></tr></thead><tbody>
      ${row('Waiting guests (potential)', c.perDay, (x) => Math.round(x).toLocaleString(), 'check-ins and waiting share')}
      ${row('Reception time recovered', c.deskMin, hrs, 'minutes per paper card' + (c.digital == null ? ' and per digital record' : ''))}
      ${row('Follow-up time avoided', c.commMin, hrs, 'follow-up minutes' + (c.adoption == null ? ' and QR adoption' : ''))}
      ${row('Printed pieces avoided', c.printPieces, (x) => Math.round(x).toLocaleString(), 'printed pieces per card')}
      ${row('Printing cost avoided', c.printAed, aed, 'pieces per card and cost per piece')}
    </tbody></table>
    <p class="bc-basis">${c.digitalMeasured ? `Digital time uses the measured average (${c.digital.toFixed(1)} min). ` : ''}${c.adoptionMeasured ? `QR adoption uses the measured rate (${Math.round(c.adoption)}%). ` : ''}Months are 30 days.</p>`;
  }
  function businessCase(m) {
    const v = S.settings;
    return `<section class="card bc" id="bc"><div class="bc-head"><h2 class="serif">Business case</h2><span class="illustrative">Illustrative · based on current assumptions</span></div>
      <p class="muted">These figures are estimates from the assumptions below, not measured hotel results. Replace each assumption with the hotel's own numbers. Measured figures are shown above and never mixed in, except where an assumption is left blank and says "measured".</p>
      <div class="bc-grid">
        <form id="bcForm" class="bc-in">${BC.map(([k, label, unit, hint]) => `<label class="field"><span>${label}${hint ? ` <em class="opt">(${hint})</em>` : ''}</span><div class="unit-in"><input class="in num" id="${k}" name="${k}" inputmode="decimal" value="${esc(v[k])}" placeholder="${hint ? 'measured' : 'not set'}">${unit ? `<i>${unit}</i>` : ''}</div></label>`).join('')}
          <div class="actions"><button class="btn btn-primary" id="bcSave" type="submit">Save assumptions</button></div></form>
        <div class="bc-res" id="bcRes">${bcOutputs(bcCalc(v, m))}</div>
      </div>
      <p class="bc-note">No physical Waiting Card is printed in the new process. The printing figures show what the hotel no longer spends, once the real cost per piece is entered.</p></section>`;
  }
  function wireBusinessCase(m) {
    const form = $('#bcForm'); if (!form) return;
    const read = () => { const v = Object.assign({}, S.settings); BC.forEach(([k]) => { v[k] = $('#' + k).value.trim(); }); return v; };
    form.addEventListener('input', () => { $('#bcRes').innerHTML = bcOutputs(bcCalc(read(), m)); });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const b = $('#bcSave'); b.classList.add('loading');
      const values = {}; BC.forEach(([k]) => { values[k] = $('#' + k).value.trim(); });
      try { S.settings = (await api('POST', '/api/admin/settings', { values })).values; toast('Assumptions saved'); }
      catch (ex) { err(ex); if (ex.data && ex.data.field && $('#' + ex.data.field)) $('#' + ex.data.field).focus(); }
      finally { b.classList.remove('loading'); }
    });
  }

  /* ---------- guest page content ---------- */
  const LANG_TABS = [['en', 'English'], ['ar', 'العربية'], ['ru', 'Русский'], ['de', 'Deutsch']];
  async function guestPage() {
    body().innerHTML = '<div class="skeleton" style="height:240px"></div>';
    try {
      S.content = (await api('GET', '/api/admin/guest-content')).sections;
      if (!S.editId || !S.content.some((x) => x.id === S.editId)) S.editId = S.content[0] && S.content[0].id;
      renderGuestPage();
    } catch (e) { err(e); }
  }
  function renderGuestPage() {
    const sec = S.content.find((x) => x.id === S.editId);
    const sfx = S.editLang === 'en' ? '' : '_' + S.editLang;
    const dir = S.editLang === 'ar' ? 'rtl' : 'ltr';
    body().innerHTML = `<div class="gp">
      <aside class="card gp-list"><h2 class="serif">Resort sections</h2><p class="muted">What guests see under "While you wait".</p>
        <ul>${S.content.map((x) => `<li><button data-sec="${esc(x.id)}" class="${x.id === S.editId ? 'on' : ''}"><span>${esc(x.title)}</span>${!x.active ? '<em class="st off">Hidden</em>' : x.placeholder ? '<em class="st ph">Placeholder</em>' : '<em class="st ok">Live</em>'}</button></li>`).join('')}</ul></aside>
      ${sec ? `<form class="card panel gp-edit" id="gpForm" novalidate>
        <div class="panel-head"><div><div class="label">Editing</div><h2 class="serif">${esc(sec.title)}</h2></div></div>
        <div class="seg" role="tablist" aria-label="Language">${LANG_TABS.map(([k, l]) => `<button type="button" role="tab" data-elang="${k}" class="${S.editLang === k ? 'on' : ''}" aria-selected="${S.editLang === k}">${l}</button>`).join('')}</div>
        ${S.editLang !== 'en' ? '<p class="muted small">Leave a field blank to show the English text in this language.</p>' : ''}
        <label class="field"><span>Title</span><input class="in" id="c_title" maxlength="60" dir="${dir}" value="${esc(sec['title' + sfx])}" placeholder="${S.editLang === 'en' ? '' : esc(sec.title)}"></label>
        <label class="field"><span>Description</span><textarea class="in" id="c_body" maxlength="600" rows="4" dir="${dir}" placeholder="${S.editLang === 'en' ? 'Opening hours, location, what to know' : esc(sec.body)}">${esc(sec['body' + sfx])}</textarea></label>
        <label class="field"><span>Small print <em class="opt">(optional)</em></span><input class="in" id="c_note" maxlength="200" dir="${dir}" value="${esc(sec['note' + sfx])}"></label>
        <label class="field"><span>Happening today <em class="opt">(optional, shown at the top, e.g. "Aqua gym at 16:00, main pool")</em></span><input class="in" id="c_highlight" maxlength="120" dir="${dir}" value="${esc(sec['highlight' + sfx])}"></label>
        <div class="gp-toggles"><label class="toggle"><input type="checkbox" id="c_active" ${sec.active ? 'checked' : ''}> Show this section to guests</label>
          <label class="toggle"><input type="checkbox" id="c_ph" ${sec.placeholder ? 'checked' : ''}> Still placeholder text</label></div>
        <div class="banner err" id="gpErr" hidden></div>
        <div class="actions"><button class="btn btn-primary" id="gpSave" type="submit">Save ${esc(LANG_TABS.find((l) => l[0] === S.editLang)[1])} text</button></div>
      </form>` : '<div class="card empty">No sections.</div>'}</div>`;
    $$('[data-sec]').forEach((b) => b.onclick = () => { S.editId = b.dataset.sec; renderGuestPage(); });
    $$('[data-elang]').forEach((b) => b.onclick = () => { S.editLang = b.dataset.elang; renderGuestPage(); });
    const form = $('#gpForm');
    if (form) form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const b = $('#gpSave'); b.classList.add('loading'); $('#gpErr').hidden = true;
      const payload = { id: sec.id, active: $('#c_active').checked, placeholder: $('#c_ph').checked };
      ['title', 'body', 'note', 'highlight'].forEach((f) => { payload[f + sfx] = $('#c_' + f).value; });
      try { S.content = (await api('POST', '/api/admin/guest-content', payload)).sections; toast('Saved. Guests see it within seconds.'); renderGuestPage(); }
      catch (ex) { b.classList.remove('loading'); $('#gpErr').textContent = ex.message; $('#gpErr').hidden = false; }
    });
  }

  /* ---------- settings ---------- */
  const SETTINGS_FORM = [
    ['Hotel', [['hotel_name', 'Hotel name'], ['hotel_map_url', 'Hotel map link', 'url'], ['hotel_website_url', 'Hotel website link', 'url']]],
    ['Waiting times', [['late_warn_minutes', 'Attention after (minutes)', 'num'], ['late_alert_minutes', 'Long wait after (minutes)', 'num']]],
    ['Guest page', [['guest_welcome', 'Welcome line (English)'], ['guest_welcome_ar', 'Welcome line (Arabic)', 'rtl'], ['guest_welcome_ru', 'Welcome line (Russian)'], ['guest_welcome_de', 'Welcome line (German)'],
      ['guest_show_placeholders', 'Show sections that still have placeholder text', 'bool'], ['qr_expire_hours', 'Guest link closes after check-in (hours)', 'num']]],
    ['Records and security', [['wg_prefix', 'Waiting Guest number prefix'], ['archive_after_days', 'Archive closed records after (days)', 'num'], ['session_hours', 'Staff sign-in lasts (hours)', 'num']]],
  ];
  async function settings() {
    body().innerHTML = '<div class="skeleton" style="height:240px"></div>';
    try {
      const st = await api('GET', '/api/admin/settings');
      S.settings = st.values;
      body().innerHTML = `<form class="card panel" id="stForm" novalidate><h2 class="serif">Settings</h2>
        ${SETTINGS_FORM.map(([group, fields]) => `<fieldset class="st-group"><legend>${group}</legend><div class="form-grid">${fields.map(([k, label, kind]) => kind === 'bool'
          ? `<label class="toggle full"><input type="checkbox" id="s_${k}" ${S.settings[k] === '1' ? 'checked' : ''}> ${label}</label>`
          : `<label class="field ${kind === 'url' || k.startsWith('guest_welcome') ? 'full' : ''}"><span>${label}</span><input class="in" id="s_${k}" value="${esc(S.settings[k])}" ${kind === 'num' ? 'inputmode="numeric"' : ''} ${kind === 'url' ? 'inputmode="url" placeholder="https://"' : ''} ${kind === 'rtl' ? 'dir="rtl"' : ''}></label>`).join('')}</div></fieldset>`).join('')}
        <div class="banner err" id="stErr" hidden></div>
        <div class="actions"><button class="btn btn-primary" id="stSave" type="submit">Save settings</button></div></form>`;
      $('#stForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const b = $('#stSave'); b.classList.add('loading'); $('#stErr').hidden = true;
        $$('#stForm [aria-invalid]').forEach((x) => x.removeAttribute('aria-invalid'));
        const values = {};
        SETTINGS_FORM.forEach(([, fields]) => fields.forEach(([k, , kind]) => { const el = $('#s_' + k); values[k] = kind === 'bool' ? (el.checked ? '1' : '0') : el.value; }));
        try { S.settings = (await api('POST', '/api/admin/settings', { values })).values; toast('Settings saved'); }
        catch (ex) {
          $('#stErr').textContent = ex.message; $('#stErr').hidden = false;
          const f = ex.data && ex.data.field && $('#s_' + ex.data.field); if (f) { f.setAttribute('aria-invalid', 'true'); f.focus(); }
        } finally { b.classList.remove('loading'); }
      });
    } catch (e) { err(e); }
  }

  /* ---------- data: imports and export ---------- */
  function dataTab() {
    body().innerHTML = `<div class="seg data-seg" role="tablist">${[['arrivals', "Today's arrivals"], ['rooms', 'Rooms'], ['export', 'Export']].map(([k, l], i) => `<button role="tab" data-dt="${k}" class="${i === 0 ? 'on' : ''}">${l}</button>`).join('')}</div><div id="dataHost"></div>`;
    const show = (k) => {
      $$('[data-dt]').forEach((b) => b.classList.toggle('on', b.dataset.dt === k));
      S.imp = null;
      if (k === 'export') exportView($('#dataHost')); else importer(k, $('#dataHost'));
    };
    $$('[data-dt]').forEach((b) => b.onclick = () => show(b.dataset.dt));
    show('arrivals');
  }

  /* ---------- CSV import (arrivals or rooms) ---------- */
  function importer(kind, host) {
    const body = () => host;
    const isArr = kind === 'arrivals';
    const base = isArr ? '/api/import/arrivals' : '/api/import/rooms';
    S.imp = { csv: '', map: null, replaceAll: false };
    body().innerHTML = `<div class="card panel"><h2 class="serif">${isArr ? "Import today's arrivals" : 'Import rooms'}</h2>
      <p class="muted">${isArr ? 'Export the arrivals report from Opera and save it as <b>CSV</b> (in Excel: File → Save As → CSV). Dates are read day first (dd/mm/yyyy).' : 'Upload a CSV of rooms with room number, room type, and optionally building, floor and housekeeping status.'} Nothing is saved until you review the preview and confirm.</p>
      <div class="drop" id="drop"><input type="file" id="file" accept=".csv,.txt,text/csv" class="sr-only"><label for="file" class="btn btn-ghost">${icon('upload')} Choose CSV file</label><span class="muted" id="fname">or paste the contents below</span></div>
      <textarea class="in mono" id="paste" rows="5" placeholder="Paste CSV text here" spellcheck="false"></textarea>
      <div class="actions"><button class="btn btn-primary" id="previewBtn">Preview</button></div>
      <div id="impOut"></div></div>`;
    $('#file').addEventListener('change', async (e) => {
      const f = e.target.files[0]; if (!f) return;
      if (f.size > 2_000_000) return toast('File is too large (max about 2 MB)', 'err');
      $('#paste').value = await f.text(); $('#fname').textContent = f.name;
    });
    $('#previewBtn').onclick = () => preview();
    async function preview(map) {
      const csv = $('#paste').value;
      if (!csv.trim()) return toast('Choose a file or paste CSV first', 'err');
      const b = $('#previewBtn'); b.classList.add('loading');
      try {
        S.imp.csv = csv; S.imp.map = map || null;
        const p = await api('POST', base + '/preview', { csv, map: map || undefined });
        renderPreview(p);
      } catch (e) { err(e); } finally { b.classList.remove('loading'); }
    }
    function renderPreview(p) {
      const sel = (f) => `<label class="field"><span>${esc(f.label)}${f.required ? ' *' : ''}</span><select class="in mapSel" data-key="${f.key}"><option value="">(not in file)</option>${p.headers.map((h, i) => `<option value="${i}" ${p.map[f.key] === i ? 'selected' : ''}>${esc(h || 'Column ' + (i + 1))}</option>`).join('')}</select></label>`;
      const canImport = !p.missing.length && p.validCount > 0;
      $('#impOut').innerHTML = `<hr><div class="section-label">Columns found (header on line ${p.headerLine})</div>
        <details ${p.missing.length ? 'open' : ''} class="map"><summary>${p.missing.length ? `<b style="color:var(--danger)">Required columns missing: ${p.missing.map(esc).join(', ')}. Match them below.</b>` : 'Review or change column matching'}</summary>
        <div class="form-grid" style="margin-top:12px">${p.fields.map(sel).join('')}</div><div class="actions"><button class="btn btn-ghost btn-sm" id="remap">Re-check with these columns</button></div></details>
        <div class="ad-cards" style="margin-top:12px"><div class="metric good"><span>Valid rows</span><b>${p.validCount}</b></div><div class="metric ${p.errorCount ? 'hot' : ''}"><span>Rows with errors</span><b>${p.errorCount}</b></div><div class="metric"><span>Warnings</span><b>${p.warningCount}</b></div></div>
        ${p.errorCount ? `<div class="banner err" style="margin-top:12px"><span><b>These rows will be skipped:</b><br>${p.errors.map((x) => `Line ${x.line}: ${esc(x.message)}`).join('<br>')}${p.errorCount > p.errors.length ? `<br>…and ${p.errorCount - p.errors.length} more` : ''}</span></div>` : ''}
        ${p.warningCount ? `<div class="banner info" style="margin-top:10px"><span>${p.warnings.map((x) => `Line ${x.line}: ${esc(x.message)}`).join('<br>')}</span></div>` : ''}
        ${p.sample.length ? `<div class="section-label" style="margin-top:14px">First rows as they will be saved</div><div style="overflow:auto"><table class="tbl"><thead><tr>${Object.keys(p.sample[0]).map((k) => `<th>${esc(k)}</th>`).join('')}</tr></thead><tbody>${p.sample.map((r) => `<tr>${Object.keys(r).map((k) => `<td>${esc(r[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : ''}
        ${isArr ? `<label class="toggle" style="margin-top:14px"><input type="checkbox" id="replaceAll"> Replace all existing reservations (removes older ones)</label>` : ''}
        <div class="actions"><button class="btn btn-primary" id="commitBtn" ${canImport ? '' : 'disabled'}>Import ${p.validCount} row${p.validCount === 1 ? '' : 's'}${p.errorCount ? ' (skip errors)' : ''}</button></div>`;
      const rm = $('#remap'); if (rm) rm.onclick = () => { const map = {}; $$('.mapSel').forEach((s) => { map[s.dataset.key] = s.value === '' ? -1 : Number(s.value); }); preview(map); };
      $('#commitBtn').onclick = async () => {
        const replaceAll = isArr && $('#replaceAll').checked;
        const ok = await confirmDialog({ title: `Import ${p.validCount} row${p.validCount === 1 ? '' : 's'}?`, body: replaceAll ? '<b>All existing reservations will be replaced.</b> Waiting Guests already created are not affected.' : 'Existing rows with the same key are updated; new ones are added.', confirmLabel: 'Import' });
        if (!ok) return;
        const b = $('#commitBtn'); b.classList.add('loading');
        try {
          const r = await api('POST', base, { csv: S.imp.csv, map: S.imp.map || undefined, allowErrors: true, replaceAll });
          toast(`Imported: ${r.added} added, ${r.updated} updated${r.skipped ? `, ${r.skipped} skipped` : ''}`);
          go('analytics');
        } catch (e) { b.classList.remove('loading'); err(e); }
      };
    }
  }

  /* ---------- users ---------- */
  async function users() {
    body().innerHTML = '<div class="skeleton" style="height:120px"></div>';
    try {
      S.users = (await api('GET', '/api/users')).users;
      body().innerHTML = `<div class="card panel"><h2 class="serif">Staff users</h2>
        <p class="muted">Passwords are generated for you and shown once. Share them privately; staff can change them from the top bar.</p>
        <div style="overflow:auto"><table class="tbl"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>
        ${S.users.map((u) => `<tr><td><b>${esc(u.name)}</b></td><td>${esc(u.username)}</td><td>${esc(ROLE_NAME[u.role] || u.role)}</td><td>${u.active ? '<span class="pill st-ready">Active</span>' : '<span class="pill st-completed">Inactive</span>'}</td>
          <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" data-reset="${u.id}">Reset password</button> <button class="btn btn-ghost btn-sm" data-active="${u.id}" data-to="${u.active ? 0 : 1}">${u.active ? 'Deactivate' : 'Activate'}</button></td></tr>`).join('')}</tbody></table></div>
        <hr><h3 class="serif" style="font-size:18px">Add a user</h3>
        <form id="newUser" class="form-grid" style="margin-top:12px">
          <label class="field"><span>Full name</span><input class="in" id="nuName" maxlength="80" required></label>
          <label class="field"><span>Username</span><input class="in" id="nuUser" maxlength="32" autocapitalize="none" required></label>
          <label class="field"><span>Role</span><select class="in" id="nuRole"><option value="reception">Reception</option><option value="rooms_controller">Rooms Controller</option><option value="admin">Admin</option></select></label>
          <div class="field"><span>&nbsp;</span><button class="btn btn-primary" type="submit" id="nuGo">${icon('plus')} Create user</button></div></form></div>`;
      $('#newUser').addEventListener('submit', async (e) => {
        e.preventDefault(); const b = $('#nuGo'); b.classList.add('loading');
        try { const r = await api('POST', '/api/users', { name: $('#nuName').value, username: $('#nuUser').value, role: $('#nuRole').value }); await shownPassword(`User created: ${r.user.username}`, r.password); users(); }
        catch (ex) { b.classList.remove('loading'); err(ex); }
      });
      body().onclick = async (e) => {
        const r = e.target.closest('[data-reset]'), a = e.target.closest('[data-active]');
        if (r) {
          const u = S.users.find((x) => x.id === Number(r.dataset.reset));
          if (!(await confirmDialog({ title: `Reset password for ${u.username}?`, body: 'Their current password stops working and they are signed out.', confirmLabel: 'Reset' }))) return;
          try { const out = await api('POST', `/api/users/${u.id}/reset-password`, {}); await shownPassword(`New password for ${u.username}`, out.password); } catch (ex) { err(ex); }
        }
        if (a) { try { await api('POST', `/api/users/${a.dataset.active}/active`, { active: a.dataset.to === '1' }); users(); } catch (ex) { err(ex); } }
      };
    } catch (e) { err(e); }
  }
  function shownPassword(title, pw) {
    return dialog({ title, body: `<p>Copy this password now. It is <b>not shown again</b>.</p><div class="pw-box" id="pwShow">${esc(pw)}</div>`, confirmLabel: 'I have copied it', cancelLabel: '' });
  }

  /* ---------- export ---------- */
  function exportView(host) {
    const body = () => host;
    body().innerHTML = `<div class="card panel"><h2 class="serif">Export Waiting Guests</h2>
      <p class="muted">Every Waiting Guest with all timestamps (created, room assigned, preparation started, room ready, guest notified, guest returned, completed). Use it to compare the digital process with the old manual one. Contains guest names: handle it as confidential.</p>
      <div class="actions"><button class="btn btn-primary" id="exGo">${icon('download')} Download CSV</button></div></div>`;
    $('#exGo').onclick = async () => {
      const b = $('#exGo'); b.classList.add('loading');
      try {
        const { csv } = await api('GET', '/api/export/waiting-guests');
        const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
        const a = document.createElement('a'); a.href = url; a.download = `waiting-guests-${new Date().toISOString().slice(0, 10)}.csv`; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      } catch (e) { err(e); } finally { b.classList.remove('loading'); }
    };
  }

  (async function init() {
    try { S.roomTypes = (await api('GET', '/api/meta')).roomTypes; } catch (e) { err(e); }
    go('analytics');
    WG.stopLive = live(() => { if (S.tab === 'analytics' && !document.querySelector('#bcForm:focus-within')) analytics(true); }, setLive, { baseMs: 8000 });
  })();
};
