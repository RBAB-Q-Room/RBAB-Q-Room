'use strict';
/* Shared helpers for the staff apps. Vanilla JS, same approach as Room Guide. */
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
  star: '<path d="M12 2l3 6.9 7.4.6-5.6 4.9 1.7 7.3L12 17.8 5.5 21.7l1.7-7.3L1.6 9.5 9 8.9z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  queue: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  door: '<path d="M4 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M2 21h20M12 12h.01"/>',
  bed: '<path d="M2 18V6M2 14h20v4M22 14v-3a3 3 0 0 0-3-3h-8v6"/><circle cx="6.5" cy="11" r="1.5"/>',
};
const icon = (n) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ''}</svg>`;

const STATUS_LABEL = {
  waiting: 'Waiting', room_assigned: 'Room Assigned', preparing: 'Room Being Prepared',
  ready: 'Room Ready', returned: 'Guest Returned', completed: 'Completed',
};
const STATUS_ORDER = ['waiting', 'room_assigned', 'preparing', 'ready', 'returned', 'completed'];
const statusPill = (s) => `<span class="pill st-${s}">${STATUS_LABEL[s] || s}</span>`;

/* ---------- API ---------- */
async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw Object.assign(new Error('Cannot reach the server. Check your connection.'), { offline: true });
  }
  if (res.status === 401 && !path.startsWith('/api/login')) { location.href = '/login'; throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong'), { status: res.status, data });
  return data;
}

/* ---------- Live sync (SSE, with reconnect + polling safety net) ---------- */
function live(url, onChange, onState = () => {}) {
  let es, timer, poll;
  const fire = () => { clearTimeout(timer); timer = setTimeout(onChange, 60); };
  const open = () => {
    es = new EventSource(url);
    es.addEventListener('change', fire);
    es.onopen = () => { onState(true); fire(); };
    es.onerror = () => onState(false);
  };
  open();
  poll = setInterval(onChange, 30000); // safety net if a proxy drops the stream
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fire(); });
  return () => { es.close(); clearInterval(poll); };
}

/* ---------- Time ---------- */
const parseTs = (t) => (t ? Date.parse(t) : null);
function fmtDuration(sec) {
  if (sec == null || isNaN(sec)) return '-';
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}:${String(s).padStart(2, '0')}`;
}
const fmtClock = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-');
const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '-');
const pax = (g) => `${g.adults} adult${g.adults === 1 ? '' : 's'}${g.children ? `, ${g.children} child${g.children === 1 ? '' : 'ren'}` : ''}`;

/* ---------- Toasts ---------- */
function toast(msg, type = '') {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${type === 'err' ? '' : icon('check')}<span>${esc(msg)}</span>`;
  box.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, type === 'err' ? 5000 : 2600);
}

function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal-box" role="dialog" aria-modal="true" aria-labelledby="cdT"><h2 id="cdT">${esc(title)}</h2><div class="muted">${body}</div>
      <div class="modal-actions"><button class="btn btn-ghost" data-r="0">Cancel</button><button class="btn btn-primary" data-r="1">${esc(confirmLabel)}</button></div></div>`;
    const done = (v) => { ov.remove(); document.removeEventListener('keydown', key); resolve(v); };
    const key = (e) => { if (e.key === 'Escape') done(false); };
    ov.addEventListener('click', (e) => { if (e.target === ov) done(false); const r = e.target.closest('[data-r]'); if (r) done(r.dataset.r === '1'); });
    document.addEventListener('keydown', key);
    document.body.appendChild(ov);
    $('[data-r="1"]', ov).focus();
  });
}

/* ---------- Theme + top bar ---------- */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const b = $('#themeToggle');
  if (b) b.innerHTML = `<svg class="i" viewBox="0 0 24 24">${ICONS[t === 'dark' ? 'sun' : 'moon']}</svg>`;
}
(function initTheme() {
  let t = 'light';
  try { t = localStorage.getItem('wg-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); } catch {}
  document.documentElement.dataset.theme = t;
})();

async function mountTopbar(tagline) {
  const { user } = await api('GET', '/api/me');
  const roleName = user.role === 'reception' ? 'Reception' : 'Rooms Controller';
  $('#topbar').innerHTML = `<header class="topbar"><div class="topbar-inner">
    <div class="brand"><div class="logo-chip"><img src="/assets/rixos-logo.png" alt="Rixos Bab Al Bahr"></div><div class="divider"></div>
      <div><div class="wordmark">Waiting Guest</div><div class="tagline">${esc(tagline)}</div></div></div>
    <div class="header-actions">
      <span class="live-dot" id="liveDot" title="Live connection">Live</span>
      <span class="user-chip"><b>${esc(user.name)}</b> · ${roleName}</span>
      <button class="icon-btn" id="themeToggle" title="Toggle dark mode" aria-label="Toggle dark mode"></button>
      <button class="text-btn" id="logoutBtn">${icon('out')} Sign out</button>
    </div></div></header>`;
  applyTheme(document.documentElement.dataset.theme);
  $('#themeToggle').onclick = () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('wg-theme', t); } catch {}
    applyTheme(t);
  };
  $('#logoutBtn').onclick = async () => { await api('POST', '/api/logout', {}); location.href = '/login'; };
  return user;
}
const setLive = (ok) => { const d = $('#liveDot'); if (d) { d.classList.toggle('off', !ok); d.textContent = ok ? 'Live' : 'Reconnecting'; } };

/** Live-ticking elapsed timers: any element with data-since (ISO) and optional data-until. */
function tickTimers() {
  const now = Date.now();
  for (const el of $$('[data-since]')) {
    const from = Date.parse(el.dataset.since);
    const to = el.dataset.until ? Date.parse(el.dataset.until) : now;
    el.textContent = fmtDuration((to - from) / 1000);
  }
}
setInterval(tickTimers, 1000);
