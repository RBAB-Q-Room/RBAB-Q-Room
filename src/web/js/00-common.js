'use strict';
/* Shared client code. Runs inside Google Apps Script's HtmlService (production)
   and in the local dev server; only the transport differs. */
const WG = { views: {}, boot: window.WG_BOOT || {}, token: null, stopLive: null, skew: 0 };
/** Server-corrected clock: hotel PCs are often a few minutes off, which would make waiting timers wrong. */
const nowMs = () => Date.now() + WG.skew;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICONS = {
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  bag: '<rect x="5" y="8" width="14" height="13" rx="2"/><path d="M9 8V5a3 3 0 0 1 6 0v3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 3.5"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2L21 2M16 7l3 3"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  queue: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  door: '<path d="M4 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M2 21h20M12 12h.01"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  alert: '<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>',
};
const icon = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;

const STATUS_LABEL = {
  waiting: 'Waiting', room_assigned: 'Room Assigned', preparing: 'Room Being Prepared', ready: 'Room Ready',
  returned: 'Guest Returned', completed: 'Completed', cancelled: 'Cancelled',
};
const statusPill = (s) => `<span class="pill st-${s}">${STATUS_LABEL[s] || esc(s)}</span>`;

/* ---------- transport: Apps Script (google.script.run) or dev server (fetch) ---------- */
function transport(method, path, body) {
  const token = WG.token || '';
  if (window.google && window.google.script && window.google.script.run) {
    return new Promise((resolve) => {
      window.google.script.run
        .withSuccessHandler((r) => resolve(r && typeof r.status === 'number' ? r : { status: 500, body: { error: 'Unexpected reply from the server' } }))
        .withFailureHandler(() => resolve({ status: 0, body: { error: 'Cannot reach the server. Check your connection.' } }))
        .apiCall(token, method, path, body || null);
    });
  }
  return fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, method, path, body: body || null }) })
    .then((r) => r.json())
    .catch(() => ({ status: 0, body: { error: 'Cannot reach the server. Check your connection.' } }));
}

async function api(method, path, body) {
  const t0 = Date.now();
  const r = await transport(method, path, body);
  if (typeof r.t === 'number') WG.skew = r.t - (t0 + Date.now()) / 2; // assume symmetric latency
  if (r.status === 401 && path !== '/api/login') { forgetToken(); showLogin('Your session has ended. Please sign in again.'); throw Object.assign(new Error('Signed out'), { status: 401, silent: true }); }
  if (r.status === 0) throw Object.assign(new Error(r.body.error), { offline: true });
  if (r.status >= 400) throw Object.assign(new Error((r.body && r.body.error) || 'Something went wrong'), { status: r.status, data: r.body });
  return r.body;
}

function rememberToken(t) { WG.token = t; try { sessionStorage.setItem('wg-token', t); } catch (e) { /* storage blocked: stay signed in for this page only */ } }
function forgetToken() { WG.token = null; try { sessionStorage.removeItem('wg-token'); } catch (e) { /* ignore */ } if (WG.stopLive) { WG.stopLive(); WG.stopLive = null; } }
function storedToken() { try { return sessionStorage.getItem('wg-token'); } catch (e) { return null; } }

/* ---------- live sync: poll a tiny version counter, refetch only when it changes ---------- */
function live(onChange, onState = () => {}, { baseMs = 4000 } = {}) {
  let last = null, timer = null, fails = 0, stopped = false, busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    if (document.hidden) { schedule(); return; }
    busy = true;
    try {
      const { version } = await api('GET', '/api/version');
      fails = 0; onState(true);
      if (last === null || version !== last) onChange(); // first tick also refreshes, so nothing changed since page load is missed
      last = version;
    } catch (e) { if (e.silent) { stopped = true; return; } fails++; onState(false); }
    busy = false; schedule();
  };
  const schedule = () => { clearTimeout(timer); if (!stopped) timer = setTimeout(tick, fails ? Math.min(30000, baseMs * (fails + 1)) : baseMs); };
  const onVis = () => { if (!document.hidden) { clearTimeout(timer); tick(); } };
  document.addEventListener('visibilitychange', onVis);
  tick();
  return () => { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); };
}

/* ---------- time ---------- */
/** Averages and delays: "45 s", "12 min", "1h 05m". */
function fmtDuration(sec) {
  if (sec == null || isNaN(sec)) return '-';
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
/** Live waiting timers for staff: minutes, not ticking seconds ("<1 min", "12 min", "1h 05m"). */
function fmtWait(sec) {
  if (sec == null || isNaN(sec)) return '-';
  const m = Math.floor(Math.max(0, sec) / 60);
  return m < 1 ? '<1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
const fmtClock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '-'); // hotel operations run on the 24-hour clock
const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '-');
const pax = (g) => `${g.adults} adult${g.adults === 1 ? '' : 's'}${g.children ? `, ${g.children} child${g.children === 1 ? '' : 'ren'}` : ''}`;
function tickTimers() {
  const now = nowMs();
  for (const el of $$('[data-since]')) {
    const sec = ((el.dataset.until ? Date.parse(el.dataset.until) : now) - Date.parse(el.dataset.since)) / 1000;
    const txt = fmtWait(sec);
    if (el.textContent !== txt) el.textContent = txt;
    // an element with data-levels="warn,alert" (minutes) gets its wait level as a class
    if (el.dataset.levels) {
      const [w, a] = el.dataset.levels.split(',').map(Number);
      const lvl = sec / 60 >= a ? 'long' : sec / 60 >= w ? 'attention' : 'normal';
      const host = el.closest('[data-waitbox]') || el;
      if (host.dataset.wait !== lvl) host.dataset.wait = lvl;
    }
  }
}
setInterval(tickTimers, 1000);

/* ---------- toasts, dialogs ---------- */
function toast(msg, type = '') {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${type === 'err' ? icon('alert') : icon('check')}<span>${esc(msg)}</span>`;
  box.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, type === 'err' ? 5500 : 2600);
}

function dialog({ title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', input = null }) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="dlgT"><h2 id="dlgT">${esc(title)}</h2><div class="muted">${body || ''}</div>
      ${input ? `<label class="field" style="margin-top:14px"><span>${esc(input.label)}</span><input class="in" id="dlgIn" maxlength="200" autocomplete="off"></label><div class="field-error" id="dlgErr" hidden>${esc(input.error || 'Required')}</div>` : ''}
      <div class="modal-actions">${cancelLabel ? `<button class="btn btn-ghost" data-r="0">${esc(cancelLabel)}</button>` : ''}<button class="btn btn-primary" data-r="1">${esc(confirmLabel)}</button></div></div>`;
    const done = (v) => { ov.remove(); document.removeEventListener('keydown', key); resolve(v); };
    const submit = () => {
      if (!input) return done(true);
      const v = $('#dlgIn', ov).value.trim();
      if (v.length < (input.min || 1)) { $('#dlgErr', ov).hidden = false; return; }
      done(v);
    };
    const key = (e) => { if (e.key === 'Escape') done(false); if (e.key === 'Enter' && input) { e.preventDefault(); submit(); } };
    ov.addEventListener('click', (e) => { if (e.target === ov) return done(false); const r = e.target.closest('[data-r]'); if (r) r.dataset.r === '1' ? submit() : done(false); });
    document.addEventListener('keydown', key);
    document.body.appendChild(ov);
    (input ? $('#dlgIn', ov) : $('[data-r="1"]', ov)).focus();
  });
}
const confirmDialog = (o) => dialog(o);

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* iframe may block the clipboard API */ }
  try {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch (e) { return false; }
}

/* ---------- theme + top bar ---------- */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const b = $('#themeToggle');
  if (b) b.innerHTML = `<svg class="i" viewBox="0 0 24 24">${ICONS[t === 'dark' ? 'sun' : 'moon']}</svg>`;
}
(function initTheme() {
  let t = 'light';
  try { t = localStorage.getItem('wg-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); } catch (e) { /* default light */ }
  document.documentElement.dataset.theme = t;
})();

const ROLE_NAME = { reception: 'Reception', rooms_controller: 'Rooms Controller', admin: 'Admin' };

function mountTopbar(user, tagline) {
  $('#topbar').innerHTML = `<header class="topbar"><div class="topbar-inner">
    <div class="brand"><div class="logo-chip"><img src="${WG_ASSETS.logo}" alt="Rixos Bab Al Bahr"></div><div class="divider"></div>
      <div><div class="wordmark">Waiting Guest</div><div class="tagline">${esc(tagline)}</div></div></div>
    <div class="header-actions">
      <span class="live-dot" id="liveDot" title="Live connection">Live</span>
      <span class="user-chip"><b>${esc(user.name)}</b></span>
      <button class="icon-btn" id="themeToggle" title="Toggle dark mode" aria-label="Toggle dark mode"></button>
      <button class="text-btn" id="pwBtn" title="Change my password">Password</button>
      <button class="text-btn" id="logoutBtn">${icon('out')} Sign out</button>
    </div></div></header>`;
  applyTheme(document.documentElement.dataset.theme);
  $('#themeToggle').onclick = () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('wg-theme', t); } catch (e) { /* ignore */ }
    applyTheme(t);
  };
  $('#logoutBtn').onclick = async () => { try { await api('POST', '/api/logout', {}); } catch (e) { /* ignore */ } forgetToken(); location.reload(); };
  $('#pwBtn').onclick = changePasswordDialog;
}
const setLive = (ok) => { const d = $('#liveDot'); if (d) { d.classList.toggle('off', !ok); d.textContent = ok ? 'Live' : 'Reconnecting'; } };

function changePasswordDialog() {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  ov.innerHTML = `<form class="modal-box" role="dialog" aria-modal="true" aria-labelledby="pwT"><h2 id="pwT">Change password</h2>
    <div style="display:flex;flex-direction:column;gap:12px;margin-top:12px">
    <label class="field"><span>Current password</span><input class="in" id="pwCur" type="password" autocomplete="current-password" required></label>
    <label class="field"><span>New password (8+ characters)</span><input class="in" id="pwNew" type="password" autocomplete="new-password" required minlength="8"></label>
    <div class="banner err" id="pwErr" hidden></div></div>
    <div class="modal-actions"><button type="button" class="btn btn-ghost" data-r="0">Cancel</button><button class="btn btn-primary" type="submit" id="pwGo">Save</button></div></form>`;
  document.body.appendChild(ov);
  $('#pwCur', ov).focus();
  const close = () => ov.remove();
  $('[data-r="0"]', ov).onclick = close;
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
  ov.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const b = $('#pwGo', ov); b.classList.add('loading'); $('#pwErr', ov).hidden = true;
    try { await api('POST', '/api/me/password', { current: $('#pwCur', ov).value, next: $('#pwNew', ov).value }); toast('Password changed'); close(); }
    catch (ex) { b.classList.remove('loading'); $('#pwErr', ov).textContent = ex.message; $('#pwErr', ov).hidden = false; }
  });
}

/* ---------- shared staff building blocks ---------- */
const TAG_LABEL = { occasion: 'Special occasion', accessibility: 'Accessibility' };
const WAIT_LABEL = { normal: 'On track', attention: 'Attention', long: 'Long wait' };

/**
 * Transparent priority: every reason is shown to staff, nothing is a hidden score.
 * High: marked priority by the Rooms Controller, or waiting past the long-wait threshold,
 *       or past the attention threshold for a VIP or accessibility guest.
 * Attention: past the attention threshold, or VIP / accessibility.
 */
function priorityOf(g, cfg) {
  const waitingForRoom = ['waiting', 'room_assigned', 'preparing'].includes(g.status);
  const min = (nowMs() - Date.parse(g.timestamps.created)) / 60000;
  const wait = !waitingForRoom ? 'normal' : min >= cfg.alert ? 'long' : min >= cfg.warn ? 'attention' : 'normal';
  const reasons = [];
  if (g.priority) reasons.push({ k: 'manual', t: 'Marked priority', strong: true });
  if (wait !== 'normal') reasons.push({ k: 'wait', t: `Waiting ${fmtWait(min * 60)}`, strong: wait === 'long' });
  if (g.vipCode) reasons.push({ k: 'vip', t: `VIP ${g.vipCode.replace(/^VIP/i, '').trim()}`.trim() });
  (g.tags || []).forEach((t) => reasons.push({ k: t, t: TAG_LABEL[t] || t }));
  if (g.children) reasons.push({ k: 'family', t: `Family · ${g.children} ${g.children === 1 ? 'child' : 'children'}`, info: true });
  const sensitive = !!g.vipCode || (g.tags || []).includes('accessibility');
  const level = !waitingForRoom ? 'normal'
    : g.priority || wait === 'long' || (wait === 'attention' && sensitive) ? 'high'
    : wait === 'attention' || sensitive ? 'attention' : 'normal';
  return { level, wait, reasons, waitingForRoom };
}

const reasonChips = (p, max = 9) => p.reasons.slice(0, max).map((r) => `<span class="why ${r.strong ? 'strong' : ''} ${r.info ? 'info' : ''} why-${r.k}">${esc(r.t)}</span>`).join('');

/** Timeline: staff actions from the status history, plus real guest events (QR opened, saw "room ready"). */
function timelineHtml(g, history) {
  const ev = history.map((h) => {
    let t = STATUS_LABEL[h.to] || h.to;
    if (h.to === 'waiting' && !h.from) t = 'Waiting Guest created';
    else if (/Room changed from/.test(h.note || '')) t = `Room changed to ${h.roomNumber} (was ${(h.note.match(/Room changed from ([^;]+)/) || [])[1]})`;
    else if (h.to === 'room_assigned' && h.from !== h.to) t = `Room ${h.roomNumber} assigned`;
    else if (/entered manually/.test(h.note || '')) t = `Room ${h.roomNumber} assigned`;
    else if (h.to === 'preparing') t = 'Room preparation started';
    else if (h.to === 'ready') t = 'Room ready · guest page updated';
    else if (h.from === h.to) t = h.note || 'Updated';
    const note = /entered manually/.test(h.note || '') ? 'typed by hand, not in the room list' : h.from === h.to || h.to === 'room_assigned' ? '' : h.note;
    return { at: h.at, t, note, by: h.by, kind: h.to };
  });
  if (g.timestamps.qrOpened) ev.push({ at: g.timestamps.qrOpened, t: 'Guest opened their room status page', by: 'Guest', kind: 'guest' });
  if (g.timestamps.guestSawReady) {
    const d = (Date.parse(g.timestamps.guestSawReady) - Date.parse(g.timestamps.roomReady)) / 1000;
    ev.push({ at: g.timestamps.guestSawReady, t: `Guest saw "room ready" · ${fmtDuration(d)} after`, by: 'Guest', kind: 'guest' });
  }
  if (g.feedback) ev.push({ at: g.feedback.at, t: `Guest feedback · ${'★'.repeat(g.feedback.rating)}${g.feedback.helpful ? ` · status page helpful: ${g.feedback.helpful}` : ''}`, by: 'Guest', kind: 'guest' });
  ev.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return `<ol class="tl">${ev.map((e) => `<li class="tl-${e.kind === 'guest' ? 'guest' : 'staff'}"><time>${fmtClock(e.at)}</time><div><b>${esc(e.t)}</b>${e.note ? `<span class="muted"> · ${esc(e.note)}</span>` : ''}${e.by ? `<small>${esc(e.by)}</small>` : ''}</div></li>`).join('')}</ol>`;
}

/** Waiting Guest details, grouped the way staff think: guest, stay, operations. */
function detailGroupsHtml(g, typeName) {
  const row = (label, value, wide) => value ? `<div${wide ? ' class="wide"' : ''}><dt>${label}</dt><dd>${value}</dd></div>` : '';
  return `<div class="groups">
    <section><h3>Guest</h3><dl>
      ${row('Name', esc(g.guestName), true)}
      ${row('Confirmation', `<span class="num">${esc(g.confirmationNo)}</span>`)}
      ${row('Guests', pax(g))}
      ${row('Guest language', esc(langInfo(g.language).name))}
      ${row('VIP', g.vipCode ? esc(g.vipCode) : '')}
      ${row('Source', g.source === 'manual' ? 'Manual entry' : '')}
    </dl></section>
    <section><h3>Stay</h3><dl>
      ${row('Arrival', `${fmtDate(g.arrivalDate)}${g.arrivalTime ? ' · ' + esc(g.arrivalTime) : ''}`)}
      ${row('Departure', fmtDate(g.departureDate))}
      ${row('Room type', `${esc(g.roomType)} · ${esc(typeName(g.roomType))}`, true)}
    </dl></section>
    <section><h3>Operational</h3><dl>
      ${row('Luggage tag', esc(g.luggageTag || '-'))}
      ${row('Associate', esc(g.associate || '-'))}
      ${row('Tags', (g.tags || []).map((t) => esc(TAG_LABEL[t] || t)).join(', '))}
      ${row('Preferences', g.preferences ? esc(g.preferences) : '', true)}
      ${row('Remarks', g.remarks ? esc(g.remarks) : '', true)}
    </dl></section>
  </div>`;
}

/** Guest engagement as one short line for staff. */
function engagementHtml(g) {
  if (g.timestamps.guestSawReady) return `<span class="eng ok">Guest has seen "room ready"</span>`;
  if (['ready', 'returned'].includes(g.status)) return g.timestamps.qrOpened ? `<span class="eng warn">Guest has not looked since the room became ready</span>` : `<span class="eng warn">Guest has not opened their page</span>`;
  if (g.timestamps.qrOpened) return `<span class="eng ok">Guest is following their status</span>`;
  return `<span class="eng">Guest has not opened their page yet</span>`;
}

/** Room Guide feature codes in plain words (most useful first). */
const ROOM_FEATURE = {
  COS: 'Sea view', BEA: 'Beach view', POO: 'Pool view', GAR: 'Garden view', ROA: 'Road view', MAN: 'Entrance view', CAV: 'Car park view',
  HCA: 'Accessible', INT: 'Connecting', TER: 'Terrace', BAL: 'Balcony', S: 'Small balcony', KTC: 'Kitchenette', COR: 'Corner room',
  KGB: 'King bed', TWB: 'Twin beds', BBE: 'Bunk bed', SOF: 'Sofa bed', '2EXBED': '2 extra beds', '1EXBED': '1 extra bed', SA: 'Small room', NSM: 'Non-smoking', GRD: 'Ground floor',
};
const FEATURE_ORDER = Object.keys(ROOM_FEATURE);
function roomFeatures(r, max) {
  return (r.features || []).filter((c) => ROOM_FEATURE[c]).sort((a, b) => FEATURE_ORDER.indexOf(a) - FEATURE_ORDER.indexOf(b)).slice(0, max).map((c) => ROOM_FEATURE[c]);
}
