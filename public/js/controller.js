'use strict';
// Operational cue thresholds (minutes). Purely visual, adjust to hotel standard.
const LATE1_MIN = 30, LATE2_MIN = 60;

const S = { roomTypes: {}, queue: [], filter: 'all', selectedId: null, seen: new Set(), first: true, detail: null };
const typeName = (c) => S.roomTypes[c] || c;
const FILTERS = [
  ['all', 'All active'], ['waiting', 'Waiting'], ['room_assigned', 'Room Assigned'], ['preparing', 'Being Prepared'], ['ready', 'Ready (awaiting guest)'],
];
const inFilter = (g) => S.filter === 'all' || g.status === S.filter || (S.filter === 'ready' && g.status === 'returned');

/* ---------- metrics (real, computed on the server) ---------- */
async function loadMetrics() {
  try {
    const m = await api('GET', '/api/metrics');
    const box = $('#metrics');
    const wait = S.queue.filter((g) => !['ready', 'returned'].includes(g.status));
    box.innerHTML = `
      <div class="metric"><span>Active</span><b>${m.active}</b></div>
      <div class="metric ${wait.length ? '' : ''}"><span>Still waiting for a room</span><b>${wait.length}</b></div>
      <div class="metric good"><span>Ready, guest not back</span><b>${m.readyAwaitingGuest}</b></div>
      <div class="metric"><span>Completed today</span><b>${m.completed}</b></div>
      <div class="metric"><span>Avg. wait to ready</span><b>${m.avgWaitToReadySec == null ? '-' : fmtDuration(m.avgWaitToReadySec)}</b></div>`;
  } catch {}
}

/* ---------- queue ---------- */
function cls(g) {
  const c = ['q', `s-${g.status}`];
  if (g.priority) c.push('pri');
  if (!['ready', 'returned'].includes(g.status)) {
    const min = (Date.now() - Date.parse(g.timestamps.created)) / 60000;
    if (min >= LATE2_MIN) c.push('late2'); else if (min >= LATE1_MIN) c.push('late1');
  }
  if (g.id === S.selectedId) c.push('sel');
  return c.join(' ');
}
function timerHtml(g) {
  if (['ready', 'returned'].includes(g.status)) {
    return `<div class="timer"><b class="num" data-since="${g.timestamps.roomReady}">0:00</b><small>Ready for</small></div>`;
  }
  return `<div class="timer"><b class="num" data-since="${g.timestamps.created}">0:00</b><small>Waiting</small></div>`;
}
function cardHtml(g, isNew) {
  return `<button class="${cls(g)}${isNew ? ' q-new' : ''}" data-id="${g.id}" aria-label="${esc(g.wgNumber)} ${esc(g.guestName)}">
    <span class="bar"></span>${timerHtml(g)}
    <div class="main">
      <div class="l1"><span class="wg">${esc(g.wgNumber)}</span><span class="nm">${esc(g.guestName)}</span>${g.priority ? '<span class="flag">PRIORITY</span>' : ''}</div>
      <div class="l2"><span>${icon('key')}${esc(g.confirmationNo)}</span><span class="type-pill">${esc(g.roomType)}</span><span>${icon('user')}${g.adults}A${g.children ? ` ${g.children}C` : ''}</span>
        <span>${icon('clock')}Arr ${esc(g.arrivalTime || fmtClock(g.timestamps.guestArrival))}</span>${g.luggageTag ? `<span>${icon('bag')}${esc(g.luggageTag)}</span>` : ''}<span>${esc(g.associate || '')}</span></div>
      ${g.preferences || g.remarks ? `<div class="l3">${g.preferences ? `<span class="note" title="${esc(g.preferences)}">Pref: ${esc(g.preferences)}</span>` : ''}${g.remarks ? `<span class="note rem" title="${esc(g.remarks)}">Rem: ${esc(g.remarks)}</span>` : ''}</div>` : ''}
    </div>
    <div class="side">${statusPill(g.status)}${g.roomNumber ? `<div class="room">${esc(g.roomNumber)}</div>` : '<div class="room none">No room yet</div>'}</div>
  </button>`;
}
function renderFilters() {
  $('#filters').innerHTML = FILTERS.map(([k, l]) => {
    const n = S.queue.filter((g) => (k === 'all' ? true : k === 'ready' ? ['ready', 'returned'].includes(g.status) : g.status === k)).length;
    return `<button class="chip${S.filter === k ? ' on' : ''}" data-f="${k}">${l}<i>${n}</i></button>`;
  }).join('');
}
function renderQueue() {
  renderFilters();
  const rows = S.queue.filter(inFilter);
  const box = $('#queue');
  if (!rows.length) {
    box.innerHTML = `<div class="card empty">${icon('door')}<b>${S.queue.length ? 'Nothing in this filter' : 'No waiting guests'}</b>${S.queue.length ? 'Try another status filter.' : 'When Reception creates a Waiting Guest it appears here instantly.'}</div>`;
    return;
  }
  // Waiting first (longest wait first), then in-progress, then ready. Server already sorts priority then age.
  const rank = { waiting: 0, room_assigned: 1, preparing: 2, ready: 3, returned: 4 };
  rows.sort((a, b) => b.priority - a.priority || rank[a.status] - rank[b.status] || Date.parse(a.timestamps.created) - Date.parse(b.timestamps.created));
  box.innerHTML = rows.map((g) => cardHtml(g, !S.first && !S.seen.has(g.id))).join('');
  tickTimers();
}
async function loadQueue() {
  try {
    const d = await api('GET', '/api/waiting-guests');
    const prev = new Map(S.queue.map((g) => [g.id, g.status]));
    S.queue = d.active;
    renderQueue();
    for (const g of S.queue) S.seen.add(g.id);
    if (!S.first) for (const g of S.queue) if (!prev.has(g.id)) toast(`New waiting guest ${g.wgNumber}: ${g.guestName}`);
    S.first = false;
    loadMetrics();
    if (S.selectedId) { if (S.queue.some((g) => g.id === S.selectedId)) loadDetail(S.selectedId, true); else closeDetail(); }
  } catch (e) { if (!e.offline) toast(e.message, 'err'); }
}
$('#queue').addEventListener('click', (e) => { const c = e.target.closest('[data-id]'); if (c) selectGuest(Number(c.dataset.id)); });
$('#filters').addEventListener('click', (e) => { const c = e.target.closest('[data-f]'); if (c) { S.filter = c.dataset.f; renderQueue(); } });

/* ---------- detail ---------- */
function selectGuest(id) { S.selectedId = id; $$('#queue .q').forEach((c) => c.classList.toggle('sel', Number(c.dataset.id) === id)); loadDetail(id); }
function closeDetail() { S.selectedId = null; S.detail = null; $('#detail').classList.remove('open'); renderDetailEmpty(); $$('#queue .q.sel').forEach((c) => c.classList.remove('sel')); }
function renderDetailEmpty() {
  $('#detail').innerHTML = `<div class="card detail-empty empty">${icon('queue')}<b>Select a waiting guest</b>See preferences, assign a room and update status.</div>`;
}
async function loadDetail(id, quiet) {
  const el = $('#detail');
  if (!quiet) { el.classList.add('open'); el.innerHTML = `<div class="card d-card"><div class="skeleton" style="height:30px;width:50%"></div><div class="skeleton" style="height:120px;margin-top:16px"></div></div>`; }
  try {
    const d = await api('GET', `/api/waiting-guests/${id}`);
    if (id !== S.selectedId) return;
    // Keep the room the controller is hovering/selecting stable during a live refresh.
    S.detail = d;
    renderDetail(d, quiet);
  } catch (e) { el.innerHTML = `<div class="banner err">${esc(e.message)}</div>`; }
}

function stepsHtml(g) {
  const t = g.timestamps;
  const items = [['waiting', 'Waiting Guest created', t.created], ['room_assigned', 'Room assigned', t.roomAssigned], ['preparing', 'Room being prepared', t.preparationStarted],
    ['ready', 'Room ready (guest notified via QR)', t.roomReady], ['returned', 'Guest returned', t.guestReturned], ['completed', 'Completed', t.completed]];
  const idx = STATUS_ORDER.indexOf(g.status);
  return `<div class="steps">${items.map(([k, l, ts], i) => `<div class="step ${ts ? 'done' : i === idx ? 'now' : ''}${i === idx ? ' now' : ''}"><span class="dot"></span><span>${l}</span><span class="ts">${ts ? fmtClock(ts) : ''}</span></div>`).join('')}</div>`;
}

function renderDetail(d, quiet) {
  const g = d.waitingGuest, ready = ['ready', 'returned'].includes(g.status), done = g.status === 'completed';
  const el = $('#detail');
  // Preserve pending room choice across live refreshes.
  const pending = S.pendingRoom && S.pendingRoom.id === g.id ? S.pendingRoom.room : (g.roomNumber || null);
  const canPick = ['waiting', 'room_assigned', 'preparing'].includes(g.status);
  el.classList.add('open');
  el.innerHTML = `<div class="card d-card">
    <div class="d-head"><div><div class="label">Waiting Guest</div><h2>${esc(g.wgNumber)}</h2></div><div style="display:flex;gap:8px;align-items:center">${statusPill(g.status)}<button class="icon-btn detail-close" id="dClose" aria-label="Close">✕</button></div></div>
    <div class="d-sub"><b style="color:var(--ink)">${esc(g.guestName)}</b> · ${esc(g.confirmationNo)}</div>
    ${done ? '' : `<div class="d-time"><b class="num" ${ready ? `data-since="${g.timestamps.roomReady}"` : `data-since="${g.timestamps.created}"`}>0:00</b><span>${ready ? 'Room ready for' : 'Waiting'}</span></div>`}
    <div class="d-sec"><div class="kv">
      <div><span>Room type</span><b>${esc(g.roomType)} · ${esc(typeName(g.roomType))}</b></div><div><span>Guests</span><b>${pax(g)}</b></div>
      <div><span>Arrival</span><b>${fmtDate(g.arrivalDate)} ${esc(g.arrivalTime || '')}</b></div><div><span>Departure</span><b>${fmtDate(g.departureDate)}</b></div>
      <div><span>Luggage tag</span><b>${esc(g.luggageTag || '-')}</b></div><div><span>Associate</span><b>${esc(g.associate || '-')}</b></div></div></div>
    ${g.preferences || g.remarks ? `<div class="d-sec">${g.preferences ? `<div class="pref-box"><span>Guest preferences</span>${esc(g.preferences)}</div>` : ''}${g.remarks ? `<div class="pref-box rem"><span>Remarks</span>${esc(g.remarks)}</div>` : ''}</div>` : ''}
    <div class="d-sec"><div class="section-label">Room</div>
      ${g.roomNumber ? `<div style="margin-bottom:10px"><span class="muted">Assigned:</span> <b class="serif" style="font-size:22px">${esc(g.roomNumber)}</b></div>` : ''}
      ${canPick ? `<div class="room-grid" id="roomGrid">${d.rooms.map((r) => `<button class="rm hk-${r.hkStatus}${r.matchesType ? '' : ' other'}${pending === r.roomNumber ? ' on' : ''}" data-room="${esc(r.roomNumber)}" title="${esc(r.roomType)} · ${esc(typeName(r.roomType))}"><b>${esc(r.roomNumber)}</b><small>${esc(r.roomType)} · ${r.hkStatus === 'inspected' ? 'insp.' : esc(r.hkStatus)}</small></button>`).join('')}</div>
        <p class="legend-note">Rooms of the guest's type (${esc(g.roomType)}) are listed first; faded rooms are a different type. Mock room data.</p>
        <button class="btn btn-primary" id="assignBtn" style="margin-top:10px;width:100%" ${pending && pending !== g.roomNumber ? '' : 'disabled'}>${g.roomNumber ? 'Change room' : 'Assign room'}${pending && pending !== g.roomNumber ? ' ' + esc(pending) : ''}</button>` : ''}
    </div>
    <div class="d-sec"><div class="section-label">Status</div>${stepsHtml(g)}
      <div class="act">
        ${g.status === 'room_assigned' ? `<button class="btn btn-ghost" data-status="preparing">Room being prepared</button>` : ''}
        ${['room_assigned', 'preparing'].includes(g.status) ? `<button class="btn btn-ready" data-status="ready">${icon('key')} Mark room ready</button>` : ''}
        ${g.status === 'waiting' ? `<div class="muted" style="font-size:12.5px">Assign a room to continue.</div>` : ''}
        ${ready ? `<div class="muted" style="font-size:12.5px">Guest has been notified on their QR page. Reception completes the record when the guest returns.</div>` : ''}
        ${!done ? `<label class="toggle"><input type="checkbox" id="priTgl" ${g.priority ? 'checked' : ''}> Operational priority</label>` : ''}
      </div></div>
    <div class="d-sec"><div class="section-label">History</div><div class="kv" style="grid-template-columns:1fr">${d.history.map((h) => `<div style="display:flex;justify-content:space-between;gap:10px"><b style="font-weight:600">${esc(STATUS_LABEL[h.to] || h.to)}${h.roomNumber ? ' · ' + esc(h.roomNumber) : ''}${h.note ? ` <span class="muted" style="font-weight:400">(${esc(h.note)})</span>` : ''}</b><span class="muted num">${fmtClock(h.at)} · ${esc(h.by || '')}</span></div>`).join('')}</div></div>
  </div>`;
  tickTimers();
  $('#dClose').onclick = closeDetail;
  $$('#roomGrid .rm').forEach((b) => b.onclick = () => { S.pendingRoom = { id: g.id, room: b.dataset.room }; renderDetail(d, true); });
  const ab = $('#assignBtn');
  if (ab) ab.onclick = () => act(ab, () => api('POST', `/api/waiting-guests/${g.id}/assign-room`, { roomNumber: pending }), `Room ${pending} assigned to ${g.wgNumber}`, () => { S.pendingRoom = null; });
  $$('[data-status]').forEach((b) => b.onclick = async () => {
    const to = b.dataset.status;
    if (to === 'ready') {
      const ok = await confirmDialog({ title: `Mark room ${g.roomNumber} ready?`, body: `${esc(g.guestName)} will immediately see <b>Your room is ready</b> on their QR page.`, confirmLabel: 'Mark ready' });
      if (!ok) return;
    }
    act(b, () => api('POST', `/api/waiting-guests/${g.id}/status`, { status: to }), to === 'ready' ? `${g.wgNumber} is ready. Guest notified.` : `${g.wgNumber} updated`);
  });
  const p = $('#priTgl');
  if (p) p.onchange = () => act(p, () => api('POST', `/api/waiting-guests/${g.id}/priority`, { priority: p.checked }), p.checked ? 'Priority on' : 'Priority off');
}
async function act(btn, fn, okMsg, after) {
  btn.classList.add('loading'); btn.disabled = true;
  try { await fn(); if (after) after(); toast(okMsg); await loadQueue(); }
  catch (e) { toast(e.message, 'err'); btn.classList.remove('loading'); btn.disabled = false; await loadQueue(); }
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.querySelector('.modal-overlay')) closeDetail(); });

(async function init() {
  try {
    await mountTopbar('Rooms Controller');
    S.roomTypes = (await api('GET', '/api/meta')).roomTypes;
    renderDetailEmpty();
    $('#queue').innerHTML = '<div class="skeleton" style="height:84px"></div><div class="skeleton" style="height:84px"></div><div class="skeleton" style="height:84px"></div>';
    await loadQueue();
    live('/api/events', loadQueue, setLive);
  } catch (e) { if (e.message !== 'Signed out') toast(e.message, 'err'); }
})();
