'use strict';
/* Rooms Controller: dense live queue, timer first, one-click operational actions. */
WG.views.controller = function (root, user) {
  const S = { roomTypes: {}, queue: [], filter: 'all', selectedId: null, seen: new Set(), first: true, late1: 30, late2: 60, pendingRoom: null };
  const typeName = (c) => S.roomTypes[c] || c;
  const FILTERS = [['all', 'All active'], ['waiting', 'Waiting'], ['room_assigned', 'Room Assigned'], ['preparing', 'Being Prepared'], ['ready', 'Ready (awaiting guest)']];
  const inFilter = (g) => S.filter === 'all' || g.status === S.filter || (S.filter === 'ready' && g.status === 'returned');

  root.innerHTML = `<div id="topbar"></div>
    <div class="metrics" id="metrics" aria-label="Live figures"></div>
    <div class="filters" id="filters" role="toolbar" aria-label="Filter queue"></div>
    <div class="rc-body"><main id="queue" aria-live="polite"></main><aside class="detail" id="detail" aria-label="Guest details"></aside></div>`;
  mountTopbar(user, 'Rooms Controller');

  async function loadMetrics() {
    try {
      const m = await api('GET', '/api/metrics');
      $('#metrics').innerHTML = `
        <div class="metric"><span>Active</span><b>${m.active}</b></div>
        <div class="metric"><span>Still waiting for a room</span><b>${m.stillWaitingForRoom}</b></div>
        <div class="metric good"><span>Ready, guest not back</span><b>${m.readyAwaitingGuest}</b></div>
        <div class="metric"><span>Completed</span><b>${m.completed}</b></div>
        <div class="metric"><span>Avg. wait to ready</span><b>${m.avgWaitToReadySec == null ? '-' : fmtDuration(m.avgWaitToReadySec)}</b></div>`;
    } catch (e) { /* metrics are non-critical */ }
  }

  function cls(g) {
    const c = ['q', `s-${g.status}`];
    if (g.priority) c.push('pri');
    if (!['ready', 'returned'].includes(g.status)) {
      const min = (nowMs() - Date.parse(g.timestamps.created)) / 60000;
      if (min >= S.late2) c.push('late2'); else if (min >= S.late1) c.push('late1');
    }
    if (g.id === S.selectedId) c.push('sel');
    return c.join(' ');
  }
  const timerHtml = (g) => ['ready', 'returned'].includes(g.status)
    ? `<div class="timer"><b class="num" data-since="${esc(g.timestamps.roomReady)}">0:00</b><small>Ready for</small></div>`
    : `<div class="timer"><b class="num" data-since="${esc(g.timestamps.created)}">0:00</b><small>Waiting</small></div>`;

  function cardHtml(g, isNew) {
    return `<button class="${cls(g)}${isNew ? ' q-new' : ''}" data-id="${g.id}" aria-label="${esc(g.wgNumber)} ${esc(g.guestName)}">
      <span class="bar"></span>${timerHtml(g)}
      <div class="main">
        <div class="l1"><span class="wg">${esc(g.wgNumber)}</span><span class="nm">${esc(g.guestName)}</span>${g.priority ? '<span class="flag">PRIORITY</span>' : ''}${g.source === 'manual' ? '<span class="type-pill">Manual</span>' : ''}${g.language && g.language !== 'en' ? `<span class="type-pill" title="Guest language">${esc(langInfo(g.language).name)}</span>` : ''}</div>
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
      box.innerHTML = `<div class="card empty">${icon('door')}<b>${S.queue.length ? 'Nothing in this filter' : 'No waiting guests'}</b>${S.queue.length ? 'Try another status filter.' : 'When Reception creates a Waiting Guest it appears here within seconds.'}</div>`;
      return;
    }
    const rank = { waiting: 0, room_assigned: 1, preparing: 2, ready: 3, returned: 4 };
    rows.sort((a, b) => Number(b.priority) - Number(a.priority) || rank[a.status] - rank[b.status] || Date.parse(a.timestamps.created) - Date.parse(b.timestamps.created));
    box.innerHTML = rows.map((g) => cardHtml(g, !S.first && !S.seen.has(g.id))).join('');
    tickTimers();
  }
  async function loadQueue() {
    try {
      const d = await api('GET', '/api/waiting-guests');
      const prev = new Set(S.queue.map((g) => g.id));
      S.queue = d.active;
      renderQueue();
      if (!S.first) for (const g of S.queue) if (!prev.has(g.id)) toast(`New waiting guest ${g.wgNumber}: ${g.guestName}`);
      for (const g of S.queue) S.seen.add(g.id);
      S.first = false;
      loadMetrics();
      if (S.selectedId) { if (S.queue.some((g) => g.id === S.selectedId)) loadDetail(S.selectedId, true); else closeDetail(); }
    } catch (e) { if (!e.offline && !e.silent) toast(e.message, 'err'); }
  }
  $('#queue').addEventListener('click', (e) => { const c = e.target.closest('[data-id]'); if (c) selectGuest(Number(c.dataset.id)); });
  $('#filters').addEventListener('click', (e) => { const c = e.target.closest('[data-f]'); if (c) { S.filter = c.dataset.f; renderQueue(); } });

  /* ---------- detail ---------- */
  function selectGuest(id) { S.selectedId = id; S.pendingRoom = null; $$('#queue .q').forEach((c) => c.classList.toggle('sel', Number(c.dataset.id) === id)); loadDetail(id); }
  function closeDetail() { S.selectedId = null; $('#detail').classList.remove('open'); renderDetailEmpty(); $$('#queue .q.sel').forEach((c) => c.classList.remove('sel')); }
  const renderDetailEmpty = () => { $('#detail').innerHTML = `<div class="card detail-empty empty">${icon('queue')}<b>Select a waiting guest</b>See preferences, assign a room and update status.</div>`; };
  async function loadDetail(id, quiet) {
    const el = $('#detail');
    if (!quiet) { el.classList.add('open'); el.innerHTML = `<div class="card d-card"><div class="skeleton" style="height:30px;width:50%"></div><div class="skeleton" style="height:120px;margin-top:16px"></div></div>`; }
    try {
      const d = await api('GET', `/api/waiting-guests/${id}`);
      if (id !== S.selectedId) return;
      if (document.querySelector('.modal-overlay')) return;
      renderDetail(d);
    } catch (e) { if (!e.silent) el.innerHTML = `<div class="banner err">${esc(e.message)}</div>`; }
  }

  function stepsHtml(g) {
    const t = g.timestamps;
    const items = [['waiting', 'Waiting Guest created', t.created], ['room_assigned', 'Room assigned', t.roomAssigned], ['preparing', 'Room being prepared', t.preparationStarted],
      ['ready', 'Room ready (guest notified via QR)', t.roomReady], ['returned', 'Guest returned', t.guestReturned], ['completed', 'Completed', t.completed]];
    const idx = STATUS_ORDER.indexOf(g.status);
    return `<div class="steps">${items.map(([k, l, ts], i) => `<div class="step ${ts ? 'done' : ''}${i === idx ? ' now' : ''}"><span class="dot"></span><span>${l}</span><span class="ts">${ts ? fmtClock(ts) : ''}</span></div>`).join('')}</div>`;
  }

  function renderDetail(d) {
    const g = d.waitingGuest, ready = ['ready', 'returned'].includes(g.status), done = ['completed', 'cancelled'].includes(g.status);
    const el = $('#detail');
    const pending = S.pendingRoom && S.pendingRoom.id === g.id ? S.pendingRoom.room : (g.roomNumber || null);
    const canPick = ['waiting', 'room_assigned', 'preparing'].includes(g.status);
    const scroll = el.scrollTop;
    el.classList.add('open');
    el.innerHTML = `<div class="card d-card">
      <div class="d-head"><div><div class="label">Waiting Guest</div><h2>${esc(g.wgNumber)}</h2></div><div style="display:flex;gap:8px;align-items:center">${statusPill(g.status)}<button class="icon-btn detail-close" id="dClose" aria-label="Close">✕</button></div></div>
      <div class="d-sub"><b style="color:var(--ink)">${esc(g.guestName)}</b> · ${esc(g.confirmationNo)}</div>
      ${done ? '' : `<div class="d-time"><b class="num" data-since="${esc(ready ? g.timestamps.roomReady : g.timestamps.created)}">0:00</b><span>${ready ? 'Room ready for' : 'Waiting'}</span></div>`}
      <div class="d-sec"><div class="kv">
        <div><span>Room type</span><b>${esc(g.roomType)} · ${esc(typeName(g.roomType))}</b></div><div><span>Guests</span><b>${pax(g)}</b></div>
        <div><span>Arrival</span><b>${fmtDate(g.arrivalDate)} ${esc(g.arrivalTime || '')}</b></div><div><span>Departure</span><b>${fmtDate(g.departureDate)}</b></div>
        <div><span>Luggage tag</span><b>${esc(g.luggageTag || '-')}</b></div><div><span>Associate</span><b>${esc(g.associate || '-')}</b></div>
        <div><span>Guest language</span><b>${esc(langInfo(g.language).name)}</b></div></div></div>
      ${g.preferences || g.remarks ? `<div class="d-sec">${g.preferences ? `<div class="pref-box"><span>Guest preferences</span>${esc(g.preferences)}</div>` : ''}${g.remarks ? `<div class="pref-box rem"><span>Remarks</span>${esc(g.remarks)}</div>` : ''}</div>` : ''}
      <div class="d-sec"><div class="section-label">Room</div>
        ${g.roomNumber ? `<div style="margin-bottom:10px"><span class="muted">Assigned:</span> <b class="serif" style="font-size:22px">${esc(g.roomNumber)}</b></div>` : ''}
        ${canPick ? (d.rooms.length ? `<div class="room-grid" id="roomGrid">${d.rooms.map((r) => `<button class="rm hk-${r.hkStatus}${r.matchesType ? '' : ' other'}${pending === r.roomNumber ? ' on' : ''}" data-room="${esc(r.roomNumber)}" title="${esc(r.roomType)} · ${esc(typeName(r.roomType))}"><b>${esc(r.roomNumber)}</b><small>${esc(r.roomType)} · ${r.hkStatus === 'inspected' ? 'insp.' : esc(r.hkStatus)}</small></button>`).join('')}</div>
          <p class="legend-note">Rooms of the guest's type (${esc(g.roomType)}) are listed first; faded rooms are a different type.</p>
          <button class="btn btn-primary" id="assignBtn" style="margin-top:10px;width:100%" ${pending && pending !== g.roomNumber ? '' : 'disabled'}>${g.roomNumber ? 'Change room' : 'Assign room'}${pending && pending !== g.roomNumber ? ' ' + esc(pending) : ''}</button>`
          : `<div class="banner info">${icon('alert')}<span>No rooms are available. An admin needs to import rooms, or a room must be released.</span></div>`) : ''}
      </div>
      <div class="d-sec"><div class="section-label">Status</div>${stepsHtml(g)}
        <div class="act">
          ${g.status === 'room_assigned' ? `<button class="btn btn-ghost" data-status="preparing">Room being prepared</button>` : ''}
          ${['room_assigned', 'preparing'].includes(g.status) ? `<button class="btn btn-ready" data-status="ready">${icon('key')} Mark room ready</button>` : ''}
          ${g.status === 'waiting' ? `<div class="muted" style="font-size:12.5px">Assign a room to continue.</div>` : ''}
          ${ready ? `<div class="muted" style="font-size:12.5px">Guest has been notified on their QR page. Reception completes the record when the guest returns.</div>` : ''}
          ${!done ? `<label class="toggle"><input type="checkbox" id="priTgl" ${g.priority ? 'checked' : ''}> Operational priority</label><button class="btn btn-ghost btn-sm btn-danger" id="cancelWgBtn" style="align-self:flex-start">Cancel this Waiting Guest</button>` : ''}
        </div></div>
      <div class="d-sec"><div class="section-label">History</div><div class="kv" style="grid-template-columns:1fr">${d.history.map((h) => `<div style="display:flex;justify-content:space-between;gap:10px"><b style="font-weight:600">${esc(STATUS_LABEL[h.to] || h.to)}${h.roomNumber ? ' · ' + esc(h.roomNumber) : ''}${h.note ? ` <span class="muted" style="font-weight:400">(${esc(h.note)})</span>` : ''}</b><span class="muted num">${fmtClock(h.at)} · ${esc(h.by || '')}</span></div>`).join('')}</div></div>
    </div>`;
    el.scrollTop = scroll;
    tickTimers();
    $('#dClose').onclick = closeDetail;
    $$('#roomGrid .rm').forEach((b) => b.onclick = () => { S.pendingRoom = { id: g.id, room: b.dataset.room }; renderDetail(d); });
    const ab = $('#assignBtn');
    if (ab) ab.onclick = () => act(ab, () => api('POST', `/api/waiting-guests/${g.id}/assign-room`, { roomNumber: pending }), `Room ${pending} assigned to ${g.wgNumber}`, () => { S.pendingRoom = null; });
    $$('[data-status]').forEach((b) => b.onclick = async () => {
      const to = b.dataset.status;
      if (to === 'ready') {
        const ok = await confirmDialog({ title: `Mark room ${g.roomNumber} ready?`, body: `${esc(g.guestName)} will see <b>Your room is ready</b> on their QR page within seconds.`, confirmLabel: 'Mark ready' });
        if (!ok) return;
      }
      act(b, () => api('POST', `/api/waiting-guests/${g.id}/status`, { status: to }), to === 'ready' ? `${g.wgNumber} is ready. Guest notified.` : `${g.wgNumber} updated`);
    });
    const p = $('#priTgl');
    if (p) p.onchange = () => act(p, () => api('POST', `/api/waiting-guests/${g.id}/priority`, { priority: p.checked }), p.checked ? 'Priority on' : 'Priority off');
    const xb = $('#cancelWgBtn');
    if (xb) xb.onclick = async () => {
      const reason = await dialog({ title: `Cancel ${g.wgNumber}?`, body: 'Use this when the record was created by mistake or the guest no longer waits. Any assigned room is released.', confirmLabel: 'Cancel Waiting Guest', cancelLabel: 'Keep', input: { label: 'Reason (required)', min: 3, error: 'Please give a short reason' } });
      if (!reason) return;
      act(xb, () => api('POST', `/api/waiting-guests/${g.id}/cancel`, { reason }), `${g.wgNumber} cancelled`);
    };
  }
  async function act(btn, fn, okMsg, after) {
    btn.classList.add('loading'); btn.disabled = true;
    try { await fn(); if (after) after(); toast(okMsg); await loadQueue(); }
    catch (e) { if (!e.silent) toast(e.message, 'err'); btn.classList.remove('loading'); btn.disabled = false; await loadQueue(); }
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.querySelector('.modal-overlay')) closeDetail(); });

  (async function init() {
    try {
      const meta = await api('GET', '/api/meta');
      S.roomTypes = meta.roomTypes; S.late1 = meta.lateWarnMinutes || 30; S.late2 = meta.lateAlertMinutes || 60;
      renderDetailEmpty();
      $('#queue').innerHTML = '<div class="skeleton" style="height:84px"></div><div class="skeleton" style="height:84px"></div><div class="skeleton" style="height:84px"></div>';
      await loadQueue();
      WG.stopLive = live(loadQueue, setLive);
    } catch (e) { if (!e.silent) toast(e.message, 'err'); }
  })();
};
