'use strict';
/* Guest page. No login: the unguessable token in the URL is the only credential.
   Everything shown comes from /api/guest/<token>, which exposes guest-safe fields only. */
const token = location.pathname.split('/').filter(Boolean).pop();
const app = document.getElementById('app');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
  chev: '<path d="M6 9l6 6 6-6"/>',
};
const svg = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n] || ''}</svg>`;
const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) : '-');

const HERO = {
  preparing: { cls: '', icon: 'hourglass', eyebrow: 'Room status', title: 'Your room is being prepared', text: null },
  ready: { cls: 'ready', icon: 'key', eyebrow: 'Room status', title: 'Your room is ready', text: 'Please proceed to Reception to complete your check-in and collect your room keys.' },
  completed: { cls: 'done', icon: 'heart', eyebrow: 'Check-in complete', title: 'Welcome. Enjoy your stay', text: 'Your check-in is complete. We hope you have a wonderful stay.' },
};

let last = { phase: null }, data = null;

function render() {
  const { waitingGuest: g, content: c } = data;
  const h = HERO[g.phase];
  const text = h.text || c.welcome;
  const idx = { preparing: 1, ready: 2, completed: 3 }[g.phase];
  const P = ['Received', 'Preparing', 'Ready'];
  const prog = P.map((l, i) => {
    const on = i < idx || (i === idx && g.phase !== 'preparing') || (g.phase === 'completed');
    const cur = i === idx && g.phase === 'preparing';
    return `<div class="p ${on ? 'on' : ''} ${cur ? 'cur' : ''}"><i></i>${l}</div>${i < P.length - 1 ? `<div class="ln ${i < idx ? 'on' : ''}"></div>` : ''}`;
  }).join('');
  const website = c.links.website, map = c.links.map;
  const link = (l, ic, sub) => l && l.url
    ? `<a class="link-btn" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${svg(ic)}${esc(l.label)}<small>${sub}</small></a>`
    : `<div class="link-btn off" aria-disabled="true">${svg(ic)}${esc(l ? l.label : '')}<small>Coming soon</small></div>`;
  app.innerHTML = `
    <section class="hero ${h.cls}" aria-labelledby="st">
      <div class="badge">${svg(h.icon)}</div>
      <div class="eyebrow">${h.eyebrow}</div>
      <h1 id="st">${h.title}</h1>
      <p>${esc(text)}</p>
      <div class="ref"><span>Waiting Guest number</span><b>${esc(g.wgNumber)}</b></div>
    </section>
    <section class="card g-card" aria-label="Your details">
      <div class="kv">
        <div><span>Guest</span><b>${esc(g.guestName)}</b></div>
        <div><span>Confirmation</span><b>${esc(g.confirmationNo)}</b></div>
        <div><span>Room type</span><b>${esc(g.roomType)}</b></div>
        <div><span>Arrival</span><b>${fmtDate(g.arrivalDate)}${g.arrivalTime ? ' · ' + esc(g.arrivalTime) : ''}</b></div>
      </div>
      <div class="progress" aria-label="Progress">${prog}</div><div style="height:14px"></div>
    </section>
    <h2 class="sec-title wait-title">${g.phase === 'ready' ? 'Around the resort' : 'While you wait'}</h2>
    <p class="wait-sub">${g.phase === 'ready' ? 'Everything you need, whenever you want it.' : esc(c.welcome)}</p>
    <div class="links">${link(map, 'map', 'Find your way around')}${link(website, 'globe', 'Rixos Bab Al Bahr')}</div>
    <div class="cards">${c.sections.map((s) => `<details class="tile"><summary><span class="ic">${svg(s.icon)}</span><span class="tt">${esc(s.title)}</span><span class="chev">${svg('chev')}</span></summary>
      <div class="body">${esc(s.body)}${s.note ? `<div style="margin-top:8px;font-size:12.5px">${esc(s.note)}</div>` : ''}${s.placeholder ? '<div><span class="soon">Details coming soon</span></div>' : ''}</div></details>`).join('')}</div>
    <p class="notice">This page updates automatically. Keep it open or scan your QR again at any time.</p>`;
  if (last.phase && last.phase !== g.phase) {
    try { navigator.vibrate && navigator.vibrate(g.phase === 'ready' ? [120, 60, 120] : 40); } catch {}
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  document.title = g.phase === 'ready' ? 'Your room is ready · Rixos Bab Al Bahr' : 'Your room · Rixos Bab Al Bahr';
  last = { phase: g.phase };
}

async function load() {
  try {
    const res = await fetch(`/api/guest/${encodeURIComponent(token)}`, { cache: 'no-store' });
    if (res.status === 404) { app.innerHTML = `<div class="err-view"><h1>This link is not valid</h1><p class="muted">Please ask a member of the Reception team to help you.</p></div>`; return; }
    if (!res.ok) throw new Error();
    const next = await res.json();
    // Re-render only when the phase changes, so open cards and scroll position are left alone.
    const changed = !data || data.waitingGuest.phase !== next.waitingGuest.phase;
    data = next;
    if (changed) render();
    conn(true);
  } catch { conn(false); }
}
function conn(ok) {
  let el = document.getElementById('conn');
  if (ok) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'conn'; el.className = 'conn'; el.textContent = 'Reconnecting…'; document.body.appendChild(el); }
}

load();
if ('EventSource' in window) {
  const es = new EventSource(`/api/guest/${encodeURIComponent(token)}/events`);
  es.addEventListener('change', load);
  es.onopen = load;
}
setInterval(load, 20000); // safety net if the live stream is blocked
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
