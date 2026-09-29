'use strict';
const S = { roomTypes: {}, active: [], completed: [], tab: 'active', selectedId: null, searchTimer: null, seq: 0 };
const typeName = (c) => S.roomTypes[c] || c;
const ASSOCIATE_KEY = 'wg-associate';

/* ---------- list (right column) ---------- */
function rowHtml(g, sel) {
  const t = g.status === 'completed'
    ? `<span class="t">${fmtClock(g.timestamps.completed)}</span>`
    : g.status === 'ready' || g.status === 'returned'
      ? `<span class="t">ready ${fmtClock(g.timestamps.roomReady)}</span>`
      : `<span class="t num" data-since="${g.timestamps.created}">0:00</span>`;
  return `<button class="row${sel ? ' sel' : ''}" data-wg="${g.id}"><div class="top"><span class="wg">${esc(g.wgNumber)}</span><span class="nm">${esc(g.guestName)}</span></div>
    <div class="sub">${esc(g.confirmationNo)} · ${esc(g.roomType)}${g.roomNumber ? '' : ''} · ${esc(g.associate || '')}</div>
    <div class="end">${statusPill(g.status)}${t}</div></button>`;
}
function renderList() {
  const items = S.tab === 'active' ? S.active : S.completed;
  $('#list').innerHTML = items.length
    ? items.map((g) => rowHtml(g, g.id === S.selectedId)).join('')
    : `<div class="empty">${icon('queue')}<b>${S.tab === 'active' ? 'No active waiting guests' : 'Nothing completed yet'}</b>Guests you create will appear here and update live.</div>`;
  tickTimers();
}
async function loadList() {
  try {
    const d = await api('GET', '/api/waiting-guests');
    S.active = d.active; S.completed = d.completed;
    renderList();
    if (S.selectedId) refreshSelected();
  } catch (e) { if (!e.offline) toast(e.message, 'err'); }
}
$('#list').addEventListener('click', (e) => { const r = e.target.closest('[data-wg]'); if (r) openWg(Number(r.dataset.wg)); });
$$('.seg button').forEach((b) => b.addEventListener('click', () => {
  S.tab = b.dataset.tab;
  $$('.seg button').forEach((x) => x.classList.toggle('on', x === b));
  renderList();
}));

/* ---------- search ---------- */
const q = $('#q');
q.addEventListener('input', () => { clearTimeout(S.searchTimer); S.searchTimer = setTimeout(runSearch, 180); });
q.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(S.searchTimer); runSearch(true); }
  if (e.key === 'Escape') { q.value = ''; runSearch(); }
});
document.addEventListener('keydown', (e) => { if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); q.focus(); q.select(); } });

async function runSearch(fromEnter) {
  const term = q.value.trim();
  const box = $('#results');
  const my = ++S.seq;
  if (term.length < 2) { box.innerHTML = ''; $('#hint').hidden = false; return; }
  $('#hint').hidden = true;
  try {
    const d = await api('GET', `/api/search?q=${encodeURIComponent(term)}`);
    if (my !== S.seq) return;
    const activeConf = new Set(d.waitingGuests.filter((w) => w.status !== 'completed').map((w) => w.confirmationNo));
    const res = d.reservations.filter((r) => !activeConf.has(r.confirmationNo));
    let html = '';
    if (d.waitingGuests.length) html += `<div class="group-label">Waiting guests</div>` + d.waitingGuests.map((g) => rowHtml(g, g.id === S.selectedId)).join('');
    if (res.length) html += `<div class="group-label">Reservations</div>` + res.map((r) => `<button class="row res" data-res="${esc(r.confirmationNo)}"><div class="top"><span class="wg">${esc(r.confirmationNo)}</span><span class="nm">${esc(r.guestName)}</span></div>
      <div class="sub">${esc(typeName(r.roomType))} · ${pax(r)} · arrives ${esc(r.arrivalTime || '')}</div><div class="end"><span class="type-pill">${esc(r.roomType)}</span></div></button>`).join('');
    if (!html) html = `<div class="card empty">${icon('search')}<b>No match</b>Check the confirmation number, or search by guest name or WG number for a returning guest.</div>`;
    box.innerHTML = html;
    tickTimers();
    // Fast path: exactly one hit + Enter opens it directly.
    if (fromEnter === true) {
      if (d.waitingGuests.length + res.length === 1) {
        if (d.waitingGuests.length) openWg(d.waitingGuests[0].id); else openReservation(res[0].confirmationNo);
      }
    }
  } catch (e) { if (my === S.seq) box.innerHTML = `<div class="banner err">${esc(e.message)}</div>`; }
}
$('#results').addEventListener('click', (e) => {
  const w = e.target.closest('[data-wg]'), r = e.target.closest('[data-res]');
  if (w) openWg(Number(w.dataset.wg)); else if (r) openReservation(r.dataset.res);
});

/* ---------- reservation -> create ---------- */
async function openReservation(no) {
  S.selectedId = null; renderList();
  const work = $('#work');
  work.innerHTML = `<div class="card panel"><div class="skeleton" style="height:28px;width:40%"></div><div class="skeleton" style="height:90px;margin-top:16px"></div></div>`;
  try {
    const d = await api('GET', `/api/search?q=${encodeURIComponent(no)}`);
    const r = d.reservations.find((x) => x.confirmationNo === no);
    if (!r) throw new Error('Reservation not found');
    let associate = '';
    try { associate = localStorage.getItem(ASSOCIATE_KEY) || ''; } catch {}
    work.innerHTML = `<form class="card panel" id="createForm" novalidate>
      <div class="panel-head"><div><div class="label">Reservation ${esc(r.confirmationNo)}</div><h2 class="serif">${esc(r.guestName)}</h2></div><span class="type-pill">${esc(r.roomType)} · ${esc(typeName(r.roomType))}</span></div>
      <div class="kv">
        <div><span>Arrival</span><b>${fmtDate(r.arrivalDate)}${r.arrivalTime ? ' · ' + esc(r.arrivalTime) : ''}</b></div>
        <div><span>Departure</span><b>${fmtDate(r.departureDate)}</b></div>
        <div><span>Guests</span><b>${pax(r)}</b></div>
        <div><span>Phone</span><b>${esc(r.phone || '-')}</b></div>
        <div><span>Email</span><b>${esc(r.email || '-')}</b></div>
        ${r.mealPlan ? `<div><span>Meal plan</span><b>${esc(r.mealPlan)}</b></div>` : ''}
        ${r.vipCode ? `<div><span>VIP</span><b>${esc(r.vipCode)}</b></div>` : ''}
        ${r.specialRequests ? `<div style="grid-column:1/-1"><span>Reservation requests</span><b>${esc(r.specialRequests)}</b></div>` : ''}
      </div>
      <hr>
      <div class="auto-note">${icon('check')} Phone, email, Waiting Guest number and QR are filled in automatically.</div>
      <div class="form-grid">
        <label class="field"><span>Luggage tag <em class="opt">(optional)</em></span><input class="in" id="fTag" maxlength="40" autocomplete="off"></label>
        <label class="field"><span>Associate name</span><input class="in" id="fAssoc" maxlength="80" value="${esc(associate)}" autocomplete="off" required><span class="field-error" id="assocErr" hidden>Enter your name</span></label>
        <label class="field full"><span>Guest preferences <em class="opt">(optional)</em></span><textarea class="in" id="fPref" maxlength="500" rows="2"></textarea></label>
        <label class="field full"><span>Remarks <em class="opt">(optional)</em></span><textarea class="in" id="fRem" maxlength="500" rows="2"></textarea></label>
      </div>
      <div class="banner err" id="formErr" role="alert" hidden style="margin-top:14px"></div>
      <div class="actions"><button class="btn btn-primary" id="createBtn" type="submit">${icon('plus')} Create Waiting Guest</button><button class="btn btn-ghost" type="button" id="cancelBtn">Cancel</button></div>
    </form>`;
    (associate ? $('#fTag') : $('#fAssoc')).focus();
    $('#cancelBtn').onclick = clearWork;
    $('#createForm').addEventListener('submit', (e) => { e.preventDefault(); submitCreate(r.confirmationNo); });
    $('#createForm').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitCreate(r.confirmationNo); } });
    work.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) { work.innerHTML = `<div class="banner err">${esc(e.message)}</div>`; }
}

async function submitCreate(no) {
  const assoc = $('#fAssoc').value.trim();
  $('#assocErr').hidden = !!assoc;
  $('#fAssoc').setAttribute('aria-invalid', assoc ? 'false' : 'true');
  if (!assoc) { $('#fAssoc').focus(); return; }
  const btn = $('#createBtn');
  btn.classList.add('loading'); $('#formErr').hidden = true;
  try {
    try { localStorage.setItem(ASSOCIATE_KEY, assoc); } catch {}
    const { waitingGuest: g } = await api('POST', '/api/waiting-guests', {
      confirmationNo: no, associate: assoc, luggageTag: $('#fTag').value, preferences: $('#fPref').value, remarks: $('#fRem').value,
    });
    S.selectedId = null; // keep the success panel; live refresh must not replace it
    showCreated(g);
    q.value = ''; $('#results').innerHTML = ''; $('#hint').hidden = false;
    await loadList();
    const row = $(`#list [data-wg="${g.id}"]`); if (row) row.classList.add('flash');
  } catch (e) {
    btn.classList.remove('loading');
    if (e.status === 409 && e.data && e.data.waitingGuest) {
      $('#formErr').innerHTML = `${esc(e.message)}. <button type="button" class="text-btn" id="openExisting">Open ${esc(e.data.waitingGuest.wgNumber)}</button>`;
      $('#openExisting').onclick = () => openWg(e.data.waitingGuest.id);
    } else $('#formErr').textContent = e.message;
    $('#formErr').hidden = false;
  }
}

async function showCreated(g, fresh = true) {
  const url = location.origin + g.guestUrlPath;
  $('#work').innerHTML = `<div class="card success">
    ${fresh ? `<div class="tick">${icon('check')}</div>` : ''}
    <div class="label">${fresh ? 'Waiting Guest created' : 'Guest QR'}</div>
    <div class="big-wg">${esc(g.wgNumber)}</div>
    <div><b>${esc(g.guestName)}</b> · ${esc(g.confirmationNo)}</div>
    <div class="muted" style="margin-top:6px">${fresh ? `Now in the Rooms Controller queue. Waiting timer started at ${fmtClock(g.timestamps.created)}.` : `Status: ${esc(STATUS_LABEL[g.status])}`}</div>
    <div class="qr" id="qrBox" aria-label="Guest QR code"><div class="skeleton" style="aspect-ratio:1"></div></div>
    <div class="muted" style="font-size:12.5px">The guest scans this QR to follow their room status. No login needed.</div>
    <div class="link-row">
      <button class="btn btn-ghost btn-sm" id="copyBtn">${icon('copy')} Copy guest link</button>
      <a class="btn btn-ghost btn-sm" href="${esc(g.guestUrlPath)}" target="_blank" rel="noopener">${icon('link')} Open guest page</a>
      <button class="btn btn-primary btn-sm" id="nextBtn">${icon('plus')} New Waiting Guest</button>
    </div></div>`;
  $('#copyBtn').onclick = async () => { try { await navigator.clipboard.writeText(url); toast('Guest link copied'); } catch { toast('Copy not available here', 'err'); } };
  $('#nextBtn').onclick = () => { clearWork(); q.focus(); };
  try {
    const svg = await (await fetch(`/api/waiting-guests/${g.id}/qr.svg`, { credentials: 'same-origin' })).text();
    $('#qrBox').innerHTML = svg;
  } catch { $('#qrBox').textContent = 'QR unavailable'; }
}

function clearWork() { $('#work').innerHTML = ''; S.selectedId = null; renderList(); }

/* ---------- existing waiting guest: verify + complete ---------- */
async function openWg(id) {
  S.selectedId = id; renderList();
  $$('#results .row').forEach((r) => r.classList.toggle('sel', Number(r.dataset.wg) === id));
  await refreshSelected(true);
}
async function refreshSelected(scroll) {
  const id = S.selectedId;
  if (!id) return;
  try {
    const { waitingGuest: g, history } = await api('GET', `/api/waiting-guests/${id}`);
    if (id !== S.selectedId) return;
    const busy = document.activeElement && document.activeElement.closest && document.activeElement.closest('.modal-overlay');
    if (busy) return;
    renderWg(g, history);
    if (scroll) $('#work').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) { $('#work').innerHTML = `<div class="banner err">${esc(e.message)}</div>`; }
}

function renderWg(g, history) {
  const ready = g.status === 'ready' || g.status === 'returned';
  const canComplete = ready;
  const note = g.status === 'ready' ? `<div class="ready-note">${icon('key')} Room is ready. Verify the guest, then complete.</div>`
    : g.status === 'returned' ? `<div class="ready-note">${icon('key')} Guest is at the desk. Complete to finish.</div>`
    : g.status === 'completed' ? `<div class="banner info">Completed at ${fmtClock(g.timestamps.completed)}. Key activation and the final hotel transaction happen outside this system.</div>`
    : `<div class="banner info">${icon('clock')}<span>Room is not ready yet (${esc(STATUS_LABEL[g.status])}). It cannot be completed until the Rooms Controller marks it ready.</span></div>`;
  $('#work').innerHTML = `<div class="card panel">
    <div class="panel-head"><div><div class="label">Waiting Guest</div><h2 class="serif">${esc(g.wgNumber)}</h2></div>${statusPill(g.status)}</div>
    ${note}
    <div class="verify"><div class="label" style="margin-bottom:8px">Verify guest</div><div class="kv">
      <div><span>Guest name</span><b>${esc(g.guestName)}</b></div><div><span>Confirmation</span><b>${esc(g.confirmationNo)}</b></div>
      <div><span>WG number</span><b>${esc(g.wgNumber)}</b></div><div><span>Arrival → Departure</span><b>${fmtDate(g.arrivalDate)} → ${fmtDate(g.departureDate)}</b></div></div></div>
    <div class="kv">
      <div><span>Room type</span><b>${esc(g.roomType)} · ${esc(typeName(g.roomType))}</b></div><div><span>Guests</span><b>${pax(g)}</b></div>
      <div><span>Luggage tag</span><b>${esc(g.luggageTag || '-')}</b></div><div><span>Associate</span><b>${esc(g.associate || '-')}</b></div>
      ${g.roomNumber && ready ? `<div><span>Assigned room</span><b>${esc(g.roomNumber)}</b></div>` : ''}
      ${g.preferences ? `<div style="grid-column:1/-1"><span>Preferences</span><b>${esc(g.preferences)}</b></div>` : ''}
      ${g.remarks ? `<div style="grid-column:1/-1"><span>Remarks</span><b>${esc(g.remarks)}</b></div>` : ''}
    </div>
    <hr><div class="section-label">History</div>
    <ul class="timeline">${history.map((h) => `<li><span>${esc(STATUS_LABEL[h.to] || h.to)}${h.note ? ` <span class="muted">(${esc(h.note)})</span>` : ''}<span class="muted"> · ${esc(h.by || '')}</span></span><span class="when">${fmtClock(h.at)}</span></li>`).join('')}</ul>
    ${g.status !== 'completed' ? `<div class="actions">
      <button class="btn btn-primary" id="completeBtn" ${canComplete ? '' : 'disabled'}>${icon('check')} Complete Waiting Guest</button>
      ${g.status === 'ready' ? `<button class="btn btn-ghost" id="returnedBtn">Guest returned</button>` : ''}
      <button class="btn btn-ghost" id="qrBtn">${icon('link')} Show QR</button></div>` : `<div class="actions"><button class="btn btn-ghost" id="qrBtn">${icon('link')} Show QR</button></div>`}
  </div>`;
  const cb = $('#completeBtn');
  if (cb && canComplete) cb.onclick = async () => {
    const ok = await confirmDialog({ title: `Complete ${g.wgNumber}?`, body: `Confirm you have verified <b>${esc(g.guestName)}</b> (${esc(g.confirmationNo)}). This closes the Waiting Guest record.`, confirmLabel: 'Complete' });
    if (!ok) return;
    cb.classList.add('loading');
    try { await api('POST', `/api/waiting-guests/${g.id}/status`, { status: 'completed' }); toast(`${g.wgNumber} completed`); await loadList(); }
    catch (e) { cb.classList.remove('loading'); toast(e.message, 'err'); }
  };
  const rb = $('#returnedBtn');
  if (rb) rb.onclick = async () => { rb.classList.add('loading'); try { await api('POST', `/api/waiting-guests/${g.id}/status`, { status: 'returned' }); toast('Marked as returned'); await loadList(); } catch (e) { rb.classList.remove('loading'); toast(e.message, 'err'); } };
  const qb = $('#qrBtn');
  if (qb) qb.onclick = () => { S.selectedId = null; showCreated(g, false); };
}

/* ---------- boot ---------- */
(async function init() {
  try {
    await mountTopbar('Reception');
    S.roomTypes = (await api('GET', '/api/meta')).roomTypes;
    $('#list').innerHTML = '<div class="skeleton" style="height:64px"></div><div class="skeleton" style="height:64px"></div>';
    await loadList();
    live('/api/events', loadList, setLive);
  } catch (e) { if (e.message !== 'Signed out') toast(e.message, 'err'); }
})();
