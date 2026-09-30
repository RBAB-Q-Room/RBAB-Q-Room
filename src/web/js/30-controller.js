'use strict';
/* Rooms Controller: who is waiting, for how long, which room, and who needs attention.
   The queue is sorted by transparent priority; every reason is shown on the card. */
WG.views.controller = function (root, user) {
  const S = { roomTypes: {}, queue: [], filter: 'all', sort: 'priority', q: '', selectedId: null, seen: new Set(), first: true, cfg: { warn: 30, alert: 60 }, pendingRoom: null, detail: null };
  const typeName = (c) => S.roomTypes[c] || c;
  const LEVEL_RANK = { high: 0, attention: 1, normal: 2 };
  const FILTERS = [['all', 'All active'], ['attention', 'Needs attention'], ['waiting', 'Waiting'], ['room_assigned', 'Room assigned'], ['preparing', 'Being prepared'], ['ready', 'Ready, guest not back']];

  root.innerHTML = `<div id="topbar"></div>
    <div class="rc-shell">
      <div class="metrics" id="metrics" aria-label="Live figures"></div>
      <div class="toolbar">
        <div class="search-box compact" role="search">${icon('search')}<label for="cq" class="sr-only">Filter the queue</label>
          <input id="cq" type="search" placeholder="Name, WG number, confirmation, room, tag" autocomplete="off"><kbd>/</kbd></div>
        <div class="chips" id="filters" role="toolbar" aria-label="Filter queue"></div>
        <label class="sortsel"><span class="sr-only">Sort</span><select id="sortSel" class="in"><option value="priority">Priority first</option><option value="wait">Longest wait</option><option value="arrival">Arrival time</option></select></label>
      </div>
      <div class="rc-body"><main id="queue" aria-live="polite" aria-label="Waiting guest queue"></main><aside class="detail" id="detail" aria-label="Guest details"></aside></div>
    </div>`;
  mountTopbar(user, 'Rooms Controller');

  /* ---------- live figures ---------- */
  async function loadMetrics() {
    try {
      const m = await api('GET', '/api/metrics?range=today');
      const att = S.queue.filter((g) => priorityOf(g, S.cfg).level !== 'normal').length;
      $('#metrics').innerHTML = `
        <div class="metric"><span>Waiting for a room</span><b>${m.stillWaitingForRoom}</b></div>
        <div class="metric ${att ? 'hot' : ''}"><span>Need attention</span><b>${att}</b></div>
        <div class="metric"><span>Longest wait now</span><b>${m.stillWaitingForRoom ? fmtWait(m.longestActiveWaitSec) : '-'}</b></div>
        <div class="metric good"><span>Ready, guest not back</span><b>${m.readyAwaitingGuest}</b></div>
        <div class="metric"><span>Avg. wait to ready today</span><b>${m.avgWaitToReadySec == null ? '-' : fmtDuration(m.avgWaitToReadySec)}</b></div>`;
    } catch (e) { /* figures are secondary; the queue still works */ }
  }

  /* ---------- queue ---------- */
  const matches = (g) => {
    if (!S.q) return true;
    const hay = [g.guestName, g.wgNumber, g.confirmationNo, g.roomNumber, g.luggageTag, g.associate, g.roomType].join(' ').toLowerCase();
    return S.q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
  };
  const inFilter = (g) => {
    if (S.filter === 'all') return true;
    if (S.filter === 'attention') return priorityOf(g, S.cfg).level !== 'normal';
    if (S.filter === 'ready') return g.status === 'ready' || g.status === 'returned';
    return g.status === S.filter;
  };

  function cardHtml(g, isNew) {
    const p = priorityOf(g, S.cfg);
    const ready = ['ready', 'returned'].includes(g.status);
    const since = ready ? g.timestamps.roomReady : g.timestamps.created;
    return `<button class="q s-${g.status} lvl-${p.level}${g.id === S.selectedId ? ' sel' : ''}${isNew ? ' q-new' : ''}" data-id="${g.id}" data-waitbox aria-label="${esc(g.wgNumber)}, ${esc(g.guestName)}, ${esc(STATUS_LABEL[g.status])}${p.level === 'high' ? ', high priority' : ''}">
      <span class="bar"></span>
      <div class="timer"><b class="num" data-since="${esc(since)}" ${ready ? '' : `data-levels="${S.cfg.warn},${S.cfg.alert}"`}>${fmtWait((nowMs() - Date.parse(since)) / 1000)}</b><small>${ready ? 'ready for' : 'waiting'}</small></div>
      <div class="main">
        <div class="l1">${p.level === 'high' ? '<span class="flag">High priority</span>' : ''}<span class="nm">${esc(g.guestName)}</span><span class="wg">${esc(g.wgNumber)}</span></div>
        <div class="l2"><span class="type-pill">${esc(g.roomType)}</span><span>${pax(g)}</span>${g.luggageTag ? `<span>${icon('bag')}${esc(g.luggageTag)}</span>` : ''}<span class="muted">Arr ${esc(g.arrivalTime || fmtClock(g.timestamps.guestArrival))}</span></div>
        ${p.reasons.length || g.preferences ? `<div class="l3">${reasonChips(p)}${g.preferences ? `<span class="note" title="${esc(g.preferences)}">${esc(g.preferences)}</span>` : ''}</div>` : ''}
      </div>
      <div class="side">${statusPill(g.status)}${g.roomNumber ? `<div class="room">${esc(g.roomNumber)}</div>` : '<div class="room none">No room</div>'}</div>
    </button>`;
  }

  function sortRows(rows) {
    const age = (g) => Date.parse(g.timestamps.created);
    return rows.sort((a, b) => {
      const ra = ['ready', 'returned'].includes(a.status), rb = ['ready', 'returned'].includes(b.status);
      if (ra !== rb) return ra ? 1 : -1; // guests still waiting for a room always come first
      if (S.sort === 'arrival') return String(a.arrivalTime || '99').localeCompare(String(b.arrivalTime || '99')) || age(a) - age(b);
      if (S.sort === 'priority') { const d = LEVEL_RANK[priorityOf(a, S.cfg).level] - LEVEL_RANK[priorityOf(b, S.cfg).level]; if (d) return d; }
      return age(a) - age(b);
    });
  }

  function renderFilters() {
    $('#filters').innerHTML = FILTERS.map(([k, l]) => {
      const n = S.queue.filter((g) => { const f = S.filter; S.filter = k; const r = inFilter(g); S.filter = f; return r; }).length;
      return `<button class="chip${S.filter === k ? ' on' : ''}${k === 'attention' && n ? ' warn' : ''}" data-f="${k}" aria-pressed="${S.filter === k}">${l}<i>${n}</i></button>`;
    }).join('');
  }

  function renderQueue() {
    renderFilters();
    const rows = sortRows(S.queue.filter((g) => inFilter(g) && matches(g)));
    const box = $('#queue');
    if (!rows.length) {
      const why = S.q ? ['No match', `Nothing in the active queue matches "${esc(S.q)}".`] : S.queue.length ? ['Nothing here', 'Try another filter.'] : ['No waiting guests', 'When Reception creates a Waiting Guest, it appears here within seconds.'];
      box.innerHTML = `<div class="card empty">${icon('door')}<b>${why[0]}</b>${why[1]}</div>`;
      return;
    }
    const waiting = rows.filter((g) => !['ready', 'returned'].includes(g.status));
    const ready = rows.filter((g) => ['ready', 'returned'].includes(g.status));
    box.innerHTML = (waiting.length ? `<h2 class="qhead">Waiting for a room <span>${waiting.length}</span></h2>${waiting.map((g) => cardHtml(g, !S.first && !S.seen.has(g.id))).join('')}` : '')
      + (ready.length ? `<h2 class="qhead">Room ready, guest not back yet <span>${ready.length}</span></h2>${ready.map((g) => cardHtml(g, !S.first && !S.seen.has(g.id))).join('')}` : '');
    tickTimers();
  }

  async function loadQueue() {
    try {
      const d = await api('GET', '/api/waiting-guests');
      const prev = new Set(S.queue.map((g) => g.id));
      S.queue = d.active;
      renderQueue();
      if (!S.first) for (const g of S.queue) if (!prev.has(g.id)) toast(`New waiting guest: ${g.guestName} (${g.wgNumber})`);
      for (const g of S.queue) S.seen.add(g.id);
      S.first = false;
      loadMetrics();
      if (S.selectedId) { if (S.queue.some((g) => g.id === S.selectedId)) loadDetail(S.selectedId, true); else closeDetail(); }
    } catch (e) { if (!e.offline && !e.silent) toast(e.message, 'err'); }
  }
  // re-sort every minute: waiting times cross thresholds even when nothing else changes
  setInterval(() => { if (!document.querySelector('.modal-overlay')) { renderQueue(); } }, 60000);

  $('#queue').addEventListener('click', (e) => { const c = e.target.closest('[data-id]'); if (c) selectGuest(Number(c.dataset.id)); });
  $('#filters').addEventListener('click', (e) => { const c = e.target.closest('[data-f]'); if (c) { S.filter = c.dataset.f; renderQueue(); } });
  $('#sortSel').addEventListener('change', (e) => { S.sort = e.target.value; renderQueue(); });
  $('#cq').addEventListener('input', (e) => { S.q = e.target.value.trim(); renderQueue(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); $('#cq').focus(); }
    if (e.key === 'Escape' && !document.querySelector('.modal-overlay')) { if (document.activeElement === $('#cq') && S.q) { $('#cq').value = ''; S.q = ''; renderQueue(); } else closeDetail(); }
  });

  /* ---------- detail ---------- */
  function selectGuest(id) { S.selectedId = id; S.pendingRoom = null; S.roomQ = ''; S.typedRoom = ''; $$('#queue .q').forEach((c) => c.classList.toggle('sel', Number(c.dataset.id) === id)); loadDetail(id); }
  function closeDetail() { S.selectedId = null; $('#detail').classList.remove('open'); renderDetailEmpty(); $$('#queue .q.sel').forEach((c) => c.classList.remove('sel')); }
  const renderDetailEmpty = () => { $('#detail').innerHTML = `<div class="card detail-empty empty">${icon('queue')}<b>Select a guest</b>Assign a room, update the status and see the full timeline.</div>`; };
  async function loadDetail(id, quiet) {
    const el = $('#detail');
    if (!quiet) { el.classList.add('open'); el.innerHTML = `<div class="card d-card"><div class="skeleton" style="height:30px;width:50%"></div><div class="skeleton" style="height:120px;margin-top:16px"></div></div>`; }
    try {
      const d = await api('GET', `/api/waiting-guests/${id}`);
      if (id !== S.selectedId || document.querySelector('.modal-overlay')) return;
      S.detail = d;
      renderDetail(d);
    } catch (e) { if (!e.silent) el.innerHTML = `<div class="banner err">${esc(e.message)}</div>`; }
  }

  /* Room picker: search the list (number, building, floor, view, feature), or type any room number. */
  const roomLine = (r) => [r.floor, ...roomFeatures(r, 2)].filter(Boolean).join(' · ');
  function roomListHtml(d, pending) {
    const g = d.waitingGuest;
    const q = (S.roomQ || '').trim().toLowerCase();
    const hit = (r) => !q || [r.roomNumber, r.building, r.floor, r.roomType, typeName(r.roomType), ...roomFeatures(r, 99)].join(' ').toLowerCase().includes(q);
    const rooms = d.rooms.filter(hit);
    const btn = (r) => `<button class="rm hk-${esc(r.hkStatus || 'na')}${pending === r.roomNumber ? ' on' : ''}" data-room="${esc(r.roomNumber)}" aria-pressed="${pending === r.roomNumber}"
      title="${esc([r.roomNumber, r.roomType + ' · ' + typeName(r.roomType), r.building, r.floor, ...roomFeatures(r, 99), r.connecting ? 'connects to ' + r.connecting : '', r.hkStatus].filter(Boolean).join(' · '))}">
      <b>${esc(r.roomNumber)}</b><small>${esc(r.matchesType ? roomLine(r) : r.roomType)}</small>${r.hkStatus ? `<i class="hk">${esc(r.hkStatus === 'out_of_order' ? 'OOO' : r.hkStatus)}</i>` : ''}</button>`;
    const same = rooms.filter((r) => r.matchesType), other = rooms.filter((r) => !r.matchesType);
    const byBuilding = (list) => {
      const groups = {};
      list.forEach((r) => { (groups[r.building || 'Rooms'] = groups[r.building || 'Rooms'] || []).push(r); });
      return Object.keys(groups).map((b) => `<div class="rm-b">${esc(b)} <span>${groups[b].length}</span></div><div class="room-grid">${groups[b].map(btn).join('')}</div>`).join('');
    };
    if (!rooms.length) return `<p class="muted small" style="padding:8px 2px">${q ? `No free room matches "${esc(S.roomQ)}". You can type the room number above.` : 'No rooms in the list. Type the room number above, or ask an admin to load rooms from Room Guide.'}</p>`;
    return `${same.length ? `<div class="rm-head">${esc(g.roomType)} · ${esc(typeName(g.roomType))} <span>${same.length} free</span></div>${byBuilding(same)}` : `<div class="muted small">No free ${esc(g.roomType)} rooms${q ? ' match this search' : ''}.</div>`}
      ${other.length ? `<details class="rm-other" ${same.length && !q ? '' : 'open'}><summary>Other room types <span>${other.length}</span></summary>${byBuilding(other)}</details>` : ''}`;
  }
  function roomPicker(d, pending) {
    const g = d.waitingGuest;
    return `<div class="rm-tools">
        <div class="rm-type"><label for="rmTyped" class="label">Room number</label><div class="rm-type-row"><input class="in" id="rmTyped" maxlength="10" autocomplete="off" inputmode="text" placeholder="Type, e.g. 2104" value="${esc(S.typedRoom || '')}"><button class="btn btn-ghost" id="rmTypedGo" type="button">Use</button></div></div>
        ${d.rooms.length > 8 ? `<div class="search-box compact rm-search">${icon('search')}<label for="rmQ" class="sr-only">Search rooms</label><input id="rmQ" type="search" placeholder="Search: building, floor, sea view, balcony…" value="${esc(S.roomQ || '')}" autocomplete="off"></div>` : ''}
      </div>
      <div id="rmList">${roomListHtml(d, pending)}</div>
      <p class="legend-note">Rooms and features come from Room Guide. Housekeeping status is only shown if it was imported; it is not live from Opera.</p>
      ${pending && pending !== g.roomNumber ? `<button class="btn btn-primary" id="assignBtn" style="width:100%">${g.roomNumber ? 'Change to' : 'Assign'} room ${esc(pending)}</button>` : `<p class="pick-hint">${g.roomNumber ? 'Tap another room, or type a number, to change it.' : 'Tap a room, or type its number, to assign it.'}</p>`}`;
  }

  function renderDetail(d) {
    const g = d.waitingGuest, ready = ['ready', 'returned'].includes(g.status), done = ['completed', 'cancelled'].includes(g.status);
    const p = priorityOf(g, S.cfg);
    const el = $('#detail');
    const pending = S.pendingRoom && S.pendingRoom.id === g.id ? S.pendingRoom.room : (g.roomNumber || null);
    const canPick = ['waiting', 'room_assigned', 'preparing'].includes(g.status);
    const scroll = el.scrollTop;
    const next = g.status === 'waiting' ? 'Assign a room'
      : g.status === 'room_assigned' ? 'Start preparation, or mark ready if the room is already clean'
      : g.status === 'preparing' ? 'Mark the room ready when it is inspected'
      : ready ? 'Waiting for the guest to return to Reception' : '';
    el.classList.add('open');
    el.innerHTML = `<div class="card d-card lvl-${p.level}" data-waitbox>
      <div class="d-head"><div><div class="label">${esc(g.wgNumber)}</div><h2>${esc(g.guestName)}</h2></div>
        <div class="d-head-r">${statusPill(g.status)}<button class="icon-btn detail-close" id="dClose" aria-label="Close details">✕</button></div></div>
      ${done ? '' : `<div class="d-time"><div><b class="num" data-since="${esc(ready ? g.timestamps.roomReady : g.timestamps.created)}" ${ready ? '' : `data-levels="${S.cfg.warn},${S.cfg.alert}"`}>-</b><span>${ready ? 'room ready for' : 'waiting'}</span></div>
        <div class="d-room"><span>Room</span><b>${esc(g.roomNumber || '-')}</b></div></div>`}
      ${p.reasons.length ? `<div class="d-why">${p.level === 'high' ? '<span class="flag">High priority</span>' : p.level === 'attention' ? '<span class="flag soft">Attention</span>' : ''}${reasonChips(p)}</div>` : ''}
      ${next ? `<div class="d-next">${icon('clock')}<span><b>Next:</b> ${next}</span></div>` : ''}
      ${g.preferences || g.remarks ? `<div class="d-notes">${g.preferences ? `<div class="pref-box"><span>Guest preferences</span>${esc(g.preferences)}</div>` : ''}${g.remarks ? `<div class="pref-box rem"><span>Remarks</span>${esc(g.remarks)}</div>` : ''}</div>` : ''}
      <div class="d-sec act">
        ${g.status === 'room_assigned' ? `<button class="btn btn-ghost" data-status="preparing">Start room preparation</button>` : ''}
        ${['room_assigned', 'preparing'].includes(g.status) ? `<button class="btn btn-ready" data-status="ready">${icon('key')} Mark room ${esc(g.roomNumber)} ready</button>` : ''}
        ${ready ? `<div class="eng-line">${engagementHtml(g)}</div>` : ''}
        ${g.status === 'ready' ? `<button class="btn btn-ghost btn-sm undo" id="undoReadyBtn">${icon('clock')} Room not ready after all? Take it back</button>` : ''}
      </div>
      ${canPick ? `<div class="d-sec"><div class="section-label">${g.roomNumber ? 'Change room' : 'Assign a room'}</div>${roomPicker(d, pending)}</div>` : ''}
      <div class="d-sec">${detailGroupsHtml(g, typeName)}</div>
      <div class="d-sec"><div class="section-label">Timeline</div>${timelineHtml(g, d.history)}</div>
      ${!done ? `<div class="d-sec d-foot"><label class="toggle"><input type="checkbox" id="priTgl" ${g.priority ? 'checked' : ''}> Mark as priority</label><button class="btn btn-ghost btn-sm btn-danger" id="cancelWgBtn">Cancel record…</button></div>` : ''}
    </div>`;
    el.scrollTop = scroll;
    tickTimers();
    $('#dClose').onclick = closeDetail;
    const list = $('#rmList');
    if (list) list.addEventListener('click', (e) => {
      const b = e.target.closest('.rm'); if (!b) return;
      S.pendingRoom = { id: g.id, room: b.dataset.room }; S.typedRoom = '';
      renderDetail(d); const again = $(`#detail .rm[data-room="${b.dataset.room}"]`); if (again) again.focus();
    });
    const rq = $('#rmQ');
    if (rq) rq.addEventListener('input', () => { S.roomQ = rq.value; $('#rmList').innerHTML = roomListHtml(d, pending); });
    const typed = $('#rmTyped'), typedGo = $('#rmTypedGo');
    const useTyped = async () => {
      const v = typed.value.trim().toUpperCase().replace(/\s+/g, '');
      S.typedRoom = typed.value;
      if (!v) { typed.focus(); return; }
      if (!/^[A-Z0-9-]{1,10}$/.test(v)) { toast('Use letters, numbers or a dash for the room number', 'err'); typed.focus(); return; }
      const listed = d.rooms.find((r) => r.roomNumber.toUpperCase() === v);
      if (listed) { S.pendingRoom = { id: g.id, room: listed.roomNumber }; S.typedRoom = ''; renderDetail(d); return; }
      const ok = await confirmDialog({ title: `Assign room ${v}?`, body: `Room <b>${esc(v)}</b> is not in the free-room list: it may be missing from Room Guide, out of order, or held by another guest. Assign it anyway? It will be marked as entered manually.`, confirmLabel: `Assign ${v}` });
      if (!ok) return;
      act(typedGo, () => api('POST', `/api/waiting-guests/${g.id}/assign-room`, { roomNumber: v, manual: true }), `Room ${v} assigned to ${g.guestName}`, () => { S.pendingRoom = null; S.typedRoom = ''; });
    };
    if (typedGo) typedGo.onclick = useTyped;
    if (typed) typed.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); useTyped(); } });
    const ab = $('#assignBtn');
    if (ab) ab.onclick = () => act(ab, () => api('POST', `/api/waiting-guests/${g.id}/assign-room`, { roomNumber: pending }), `Room ${pending} assigned to ${g.guestName}`, () => { S.pendingRoom = null; });
    const ub = $('#undoReadyBtn');
    if (ub) ub.onclick = async () => {
      const reason = await dialog({ title: `Take back "room ready" for ${g.roomNumber}?`, body: `${esc(g.guestName)}'s page goes back to <b>Your room is being prepared</b>, and the record returns to "Room Being Prepared". Use this when the room was marked ready by mistake.`, confirmLabel: 'Take back', cancelLabel: 'Keep ready', input: { label: 'Reason (required)', min: 3, error: 'Please give a short reason' } });
      if (!reason) return;
      act(ub, () => api('POST', `/api/waiting-guests/${g.id}/undo-ready`, { reason }), `Room ${g.roomNumber} is back to "being prepared"`);
    };
    $$('[data-status]').forEach((b) => b.onclick = async () => {
      const to = b.dataset.status;
      if (to === 'ready') {
        const ok = await confirmDialog({ title: `Room ${g.roomNumber} is ready?`, body: `${esc(g.guestName)}'s page will change to <b>Your room is ready</b> within a few seconds, asking them to return to Reception.`, confirmLabel: 'Yes, mark ready' });
        if (!ok) return;
      }
      act(b, () => api('POST', `/api/waiting-guests/${g.id}/status`, { status: to }), to === 'ready' ? `Room ${g.roomNumber} ready. ${g.guestName} is being notified on their page.` : 'Room preparation started');
    });
    const pt = $('#priTgl');
    if (pt) pt.onchange = () => act(pt, () => api('POST', `/api/waiting-guests/${g.id}/priority`, { priority: pt.checked }), pt.checked ? 'Marked as priority' : 'Priority removed');
    const xb = $('#cancelWgBtn');
    if (xb) xb.onclick = async () => {
      const reason = await dialog({ title: `Cancel ${g.wgNumber}?`, body: 'Use this only for a record created by mistake or a guest who no longer waits. Any assigned room is released.', confirmLabel: 'Cancel record', cancelLabel: 'Keep', input: { label: 'Reason (required)', min: 3, error: 'Please give a short reason' } });
      if (!reason) return;
      act(xb, () => api('POST', `/api/waiting-guests/${g.id}/cancel`, { reason }), `${g.wgNumber} cancelled`);
    };
  }

  async function act(btn, fn, okMsg, after) {
    if (btn.classList.contains('loading')) return;
    btn.classList.add('loading'); btn.disabled = true;
    try { await fn(); if (after) after(); toast(okMsg); await loadQueue(); }
    catch (e) {
      if (!e.silent) toast(e.status === 409 ? `${e.message}` : e.message, 'err');
      btn.classList.remove('loading'); btn.disabled = false; await loadQueue();
    }
  }

  (async function init() {
    try {
      const meta = await api('GET', '/api/meta');
      S.roomTypes = meta.roomTypes; S.cfg = { warn: meta.lateWarnMinutes || 30, alert: meta.lateAlertMinutes || 60 };
      renderDetailEmpty();
      $('#queue').innerHTML = '<div class="skeleton" style="height:84px"></div><div class="skeleton" style="height:84px;margin-top:10px"></div><div class="skeleton" style="height:84px;margin-top:10px"></div>';
      await loadQueue();
      WG.stopLive = live(loadQueue, setLive);
    } catch (e) { if (!e.silent) toast(e.message, 'err'); }
  })();
};
