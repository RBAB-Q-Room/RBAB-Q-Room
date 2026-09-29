'use strict';
/* Reception: fast search, auto-filled reservation, four manual fields, QR; later verify and complete. */
WG.views.reception = function (root, user) {
  const S = { roomTypes: {}, active: [], completed: [], tab: 'active', selectedId: null, searchTimer: null, seq: 0 };
  const typeName = (c) => S.roomTypes[c] || c;
  const ASSOCIATE_KEY = 'wg-associate';

  root.innerHTML = `<div id="topbar"></div>
  <div class="rc-wrap">
    <main class="rc-main">
      <div class="search-box" role="search">
        ${icon('search')}
        <label for="q" class="sr-only">Search</label>
        <input id="q" type="search" placeholder="Confirmation number, guest name, WG number, room or luggage tag" autocomplete="off" inputmode="search" autofocus>
        <kbd>/</kbd>
      </div>
      <div class="hint muted" id="hint">New arrival: type the <b>confirmation number</b>. Guest returning: search by name, confirmation or <b>WG number</b>. <button class="linkish" id="manualLink">Reservation not found? Enter it manually</button></div>
      <div id="results" aria-live="polite"></div>
      <div id="work"></div>
    </main>
    <aside class="rc-side">
      <div class="side-head"><h2 class="serif">Waiting guests</h2>
        <div class="seg" role="tablist"><button role="tab" data-tab="active" class="on">Active</button><button role="tab" data-tab="completed">Closed</button></div></div>
      <div id="list"></div>
    </aside>
  </div>`;
  mountTopbar(user, 'Reception');

  /* ---------- list (right column) ---------- */
  function rowHtml(g, sel) {
    const t = g.status === 'completed' ? `<span class="t">${fmtClock(g.timestamps.completed)}</span>`
      : g.status === 'cancelled' ? `<span class="t">${fmtClock(g.timestamps.cancelled)}</span>`
      : g.status === 'ready' || g.status === 'returned' ? `<span class="t">ready ${fmtClock(g.timestamps.roomReady)}</span>`
      : `<span class="t num" data-since="${esc(g.timestamps.created)}">0:00</span>`;
    return `<button class="row${sel ? ' sel' : ''}" data-wg="${g.id}"><div class="top"><span class="nm">${esc(g.guestName)}</span><span class="wg">${esc(g.wgNumber)}</span>${g.timestamps.qrOpened && !['completed', 'cancelled'].includes(g.status) ? '<span class="seen-dot" title="Guest opened their page" aria-label="Guest opened their page"></span>' : ''}</div>
      <div class="sub">${esc(g.confirmationNo)} · ${esc(g.roomType)} · ${esc(g.associate || '')}</div>
      <div class="end">${statusPill(g.status)}${t}</div></button>`;
  }
  function renderList() {
    const items = S.tab === 'active' ? S.active : S.completed;
    $('#list').innerHTML = items.length ? items.map((g) => rowHtml(g, g.id === S.selectedId)).join('')
      : `<div class="empty">${icon('queue')}<b>${S.tab === 'active' ? 'No active waiting guests' : 'Nothing closed yet'}</b>Guests you create will appear here and update live.</div>`;
    tickTimers();
  }
  async function loadList() {
    try {
      const d = await api('GET', '/api/waiting-guests');
      S.active = d.active; S.completed = d.completed;
      renderList();
      refreshScanState();
      if (S.selectedId) refreshSelected();
    } catch (e) { if (!e.offline && !e.silent) toast(e.message, 'err'); }
  }
  $('#list').addEventListener('click', (e) => { const r = e.target.closest('[data-wg]'); if (r) openWg(Number(r.dataset.wg)); });
  $$('.seg button').forEach((b) => b.addEventListener('click', () => {
    S.tab = b.dataset.tab; $$('.seg button').forEach((x) => x.classList.toggle('on', x === b)); renderList();
  }));

  /* ---------- search ---------- */
  const q = $('#q');
  q.addEventListener('input', () => { clearTimeout(S.searchTimer); S.searchTimer = setTimeout(() => runSearch(false), 220); });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { clearTimeout(S.searchTimer); runSearch(true); }
    if (e.key === 'Escape') { q.value = ''; runSearch(false); }
  });
  document.addEventListener('keydown', (e) => { if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); q.focus(); q.select(); } });
  $('#manualLink').onclick = () => openManual(q.value.trim());

  async function runSearch(fromEnter) {
    const term = q.value.trim();
    const box = $('#results');
    const my = ++S.seq;
    if (term.length < 2) { box.innerHTML = ''; $('#hint').hidden = false; return; }
    $('#hint').hidden = true;
    try {
      const d = await api('GET', `/api/search?q=${encodeURIComponent(term)}`);
      if (my !== S.seq) return;
      const activeConf = new Set(d.waitingGuests.filter((w) => !['completed', 'cancelled'].includes(w.status)).map((w) => w.confirmationNo));
      const res = d.reservations.filter((r) => !activeConf.has(r.confirmationNo));
      let html = '';
      if (d.waitingGuests.length) html += `<div class="group-label">Waiting guests</div>` + d.waitingGuests.map((g) => rowHtml(g, g.id === S.selectedId)).join('');
      if (res.length) html += `<div class="group-label">Reservations</div>` + res.map((r) => `<button class="row res" data-res="${esc(r.confirmationNo)}"><div class="top"><span class="wg">${esc(r.confirmationNo)}</span><span class="nm">${esc(r.guestName)}</span></div>
        <div class="sub">${esc(typeName(r.roomType))} · ${pax(r)}${r.arrivalTime ? ' · arrives ' + esc(r.arrivalTime) : ''}</div><div class="end"><span class="type-pill">${esc(r.roomType)}</span></div></button>`).join('');
      if (!html) html = `<div class="card empty">${icon('search')}<b>No match</b>Check the confirmation number, or search a returning guest by name or WG number.<div style="margin-top:12px"><button class="btn btn-ghost btn-sm" id="manualBtn">Enter reservation manually</button></div></div>`;
      box.innerHTML = html; tickTimers();
      const mb = $('#manualBtn'); if (mb) mb.onclick = () => openManual(term);
      if (fromEnter === true && d.waitingGuests.length + res.length === 1) {
        if (d.waitingGuests.length) openWg(d.waitingGuests[0].id); else openReservation(res[0].confirmationNo);
      }
    } catch (e) { if (my === S.seq && !e.silent) box.innerHTML = `<div class="banner err">${esc(e.message)}</div>`; }
  }
  $('#results').addEventListener('click', (e) => {
    const w = e.target.closest('[data-wg]'), r = e.target.closest('[data-res]');
    if (w) openWg(Number(w.dataset.wg)); else if (r) openReservation(r.dataset.res);
  });

  /* ---------- shared operational fields ---------- */
  const rememberedAssociate = () => { try { return localStorage.getItem(ASSOCIATE_KEY) || ''; } catch (e) { return ''; } };
  const recentAssociates = () => { try { return JSON.parse(localStorage.getItem('wg-associates') || '[]').slice(0, 8); } catch (e) { return []; } };
  const rememberAssociate = (name) => {
    try {
      localStorage.setItem(ASSOCIATE_KEY, name);
      localStorage.setItem('wg-associates', JSON.stringify([name].concat(recentAssociates().filter((n) => n !== name)).slice(0, 8)));
    } catch (e) { /* storage unavailable: nothing to remember */ }
  };
  const tagChips = (selected = []) => `<div class="field full"><span>Quick tags <em class="opt">(optional, one tap)</em></span><div class="tagrow" role="group" aria-label="Quick tags">${Object.keys(TAG_LABEL).map((t) =>
    `<button type="button" class="tagbtn" data-tag="${t}" aria-pressed="${selected.includes(t)}">${esc(TAG_LABEL[t])}</button>`).join('')}</div></div>`;
  const readTags = (scope) => $$('.tagbtn[aria-pressed="true"]', scope).map((b) => b.dataset.tag);
  document.addEventListener('click', (e) => { const b = e.target.closest('.tagbtn'); if (b) b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'); });
  const opFields = (associate, lang = 'en') => `<div class="form-grid">
    <label class="field"><span>Luggage tag <em class="opt">(optional)</em></span><input class="in" id="fTag" maxlength="40" autocomplete="off"></label>
    <label class="field"><span>Associate name</span><input class="in" id="fAssoc" maxlength="80" value="${esc(associate)}" autocomplete="off" list="assocList" required><datalist id="assocList">${recentAssociates().map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist><span class="field-error" id="assocErr" hidden>Enter your name</span></label>
    <label class="field full"><span>Guest language <em class="opt">(for their QR page)</em></span><select class="in" id="fLang">${langOptions(lang)}</select></label>
    ${tagChips()}
    <label class="field full"><span>Guest preferences <em class="opt">(optional)</em></span><textarea class="in" id="fPref" maxlength="500" rows="2" placeholder="For the room team, e.g. high floor, twin beds"></textarea></label>
    <label class="field full"><span>Remarks <em class="opt">(optional)</em></span><textarea class="in" id="fRem" maxlength="500" rows="2"></textarea></label></div>`;

  /* ---------- reservation -> create ---------- */
  async function openReservation(no) {
    S.selectedId = null; renderList();
    const work = $('#work');
    work.innerHTML = `<div class="card panel"><div class="skeleton" style="height:28px;width:40%"></div><div class="skeleton" style="height:90px;margin-top:16px"></div></div>`;
    try {
      const d = await api('GET', `/api/search?q=${encodeURIComponent(no)}`);
      const r = d.reservations.find((x) => x.confirmationNo === no);
      if (!r) throw new Error('Reservation not found');
      const associate = rememberedAssociate();
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
        </div><hr>
        <div class="auto-note">${icon('check')} Phone, email, Waiting Guest number and QR are filled in automatically.</div>
        ${opFields(associate, r.suggestedLanguage)}
        <div class="banner err" id="formErr" role="alert" hidden style="margin-top:14px"></div>
        <div class="actions"><button class="btn btn-primary" id="createBtn" type="submit">${icon('plus')} Create Waiting Guest</button><button class="btn btn-ghost" type="button" id="cancelBtn">Cancel</button></div>
      </form>`;
      S.formOpenedAt = Date.now(); // measured: time from opening the reservation to pressing Create
      (associate ? $('#fTag') : $('#fAssoc')).focus();
      $('#cancelBtn').onclick = clearWork;
      $('#createForm').addEventListener('submit', (e) => { e.preventDefault(); submitCreate(r.confirmationNo, null); });
      $('#createForm').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitCreate(r.confirmationNo, null); } });
      work.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) { if (!e.silent) work.innerHTML = `<div class="banner err">${esc(e.message)}</div>`; }
  }

  /* ---------- manual fallback (reservation missing from the imported arrivals) ---------- */
  function openManual(term) {
    S.selectedId = null; renderList();
    const today = new Date(), iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const tomorrow = new Date(today.getTime() + 86400000);
    const types = Object.keys(S.roomTypes).sort();
    const associate = rememberedAssociate();
    $('#work').innerHTML = `<form class="card panel" id="manualForm" novalidate>
      <div class="panel-head"><div><div class="label">Manual entry</div><h2 class="serif">Reservation not in the arrivals list</h2></div></div>
      <div class="banner info" style="margin-bottom:14px">${icon('alert')}<span>Use this only when the confirmation number is not found. Copy the details exactly from Opera. The record is marked <b>Manual entry</b>.</span></div>
      <div class="form-grid">
        <label class="field"><span>Confirmation number</span><input class="in" id="mConf" maxlength="30" value="${/^[A-Za-z0-9\-\/]+$/.test(term) ? esc(term) : ''}" autocomplete="off" required></label>
        <label class="field"><span>Guest name</span><input class="in" id="mName" maxlength="120" autocomplete="off" required></label>
        <label class="field"><span>Arrival date</span><input class="in" id="mArr" type="date" value="${iso(today)}" required></label>
        <label class="field"><span>Departure date</span><input class="in" id="mDep" type="date" value="${iso(tomorrow)}" required></label>
        <label class="field"><span>Room type</span><select class="in" id="mType" required><option value="">Select…</option>${types.map((c) => `<option value="${esc(c)}">${esc(c)} · ${esc(S.roomTypes[c])}</option>`).join('')}</select></label>
        <label class="field"><span>Arrival time <em class="opt">(optional)</em></span><input class="in" id="mTime" type="time"></label>
        <label class="field"><span>Adults</span><input class="in" id="mAd" type="number" min="1" max="20" value="2" required></label>
        <label class="field"><span>Children</span><input class="in" id="mCh" type="number" min="0" max="20" value="0"></label>
        <label class="field"><span>Phone <em class="opt">(optional)</em></span><input class="in" id="mPh" maxlength="40" autocomplete="off"></label>
        <label class="field"><span>Email <em class="opt">(optional)</em></span><input class="in" id="mEm" maxlength="120" autocomplete="off"></label>
      </div><hr>${opFields(associate)}
      <div class="banner err" id="formErr" role="alert" hidden style="margin-top:14px"></div>
      <div class="actions"><button class="btn btn-primary" id="createBtn" type="submit">${icon('plus')} Create Waiting Guest</button><button class="btn btn-ghost" type="button" id="cancelBtn">Cancel</button></div></form>`;
    $('#cancelBtn').onclick = clearWork;
    S.formOpenedAt = Date.now();
    (/^[A-Za-z0-9\-\/]+$/.test(term) ? $('#mName') : $('#mConf')).focus();
    $('#manualForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const manual = { guestName: $('#mName').value, arrivalDate: $('#mArr').value, departureDate: $('#mDep').value, roomType: $('#mType').value, arrivalTime: $('#mTime').value,
        adults: $('#mAd').value, children: $('#mCh').value, phone: $('#mPh').value, email: $('#mEm').value };
      submitCreate($('#mConf').value.trim(), manual);
    });
    $('#work').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function submitCreate(no, manual) {
    const assoc = $('#fAssoc').value.trim();
    $('#assocErr').hidden = !!assoc;
    $('#fAssoc').setAttribute('aria-invalid', assoc ? 'false' : 'true');
    if (!assoc) { $('#fAssoc').focus(); return; }
    const btn = $('#createBtn');
    if (btn.classList.contains('loading')) return; // guard against double clicks
    btn.classList.add('loading'); $('#formErr').hidden = true;
    try {
      rememberAssociate(assoc);
      const { waitingGuest: g } = await api('POST', '/api/waiting-guests', {
        confirmationNo: no, associate: assoc, luggageTag: $('#fTag').value, preferences: $('#fPref').value, remarks: $('#fRem').value, language: $('#fLang').value, tags: readTags($('#work')), createSeconds: S.formOpenedAt ? Math.round((Date.now() - S.formOpenedAt) / 1000) : null, manual,
      });
      S.selectedId = null; // keep the success panel; live refresh must not replace it
      await showQr(g, true);
      q.value = ''; $('#results').innerHTML = ''; $('#hint').hidden = false;
      await loadList();
      const row = $(`#list [data-wg="${g.id}"]`); if (row) row.classList.add('flash');
    } catch (e) {
      btn.classList.remove('loading');
      if (e.silent) return;
      if (e.status === 409 && e.data && e.data.waitingGuest) {
        $('#formErr').innerHTML = `${esc(e.message)}. <button type="button" class="text-btn" id="openExisting">Open ${esc(e.data.waitingGuest.wgNumber)}</button>`;
        $('#openExisting').onclick = () => openWg(e.data.waitingGuest.id);
      } else $('#formErr').textContent = e.message;
      $('#formErr').hidden = false;
    }
  }

  async function showQr(g, fresh) {
    $('#work').innerHTML = `<div class="card success">
      ${fresh ? `<div class="tick">${icon('check')}</div>` : ''}
      <div class="label">${fresh ? 'Waiting Guest created' : 'Guest QR'}</div>
      <div class="big-wg">${esc(g.wgNumber)}</div>
      <div><b>${esc(g.guestName)}</b> · ${esc(g.confirmationNo)}</div>
      <div class="muted" style="margin-top:6px">${fresh ? `Now in the Rooms Controller queue. Waiting timer started at ${fmtClock(g.timestamps.created)}.` : `Status: ${esc(STATUS_LABEL[g.status])}`}</div>
      <div class="qr" id="qrBox" aria-label="Guest QR code"><div class="skeleton" style="aspect-ratio:1"></div></div>
      <div class="scan-state" id="scanState" data-wg="${g.id}">${engagementHtml(g)}</div>
      <div class="muted" style="font-size:12.5px">The guest scans this QR to follow their room status in <b>${esc(langInfo(g.language).name)}</b>. No login or app needed.</div>
      <div class="link-row" id="qrActions"><button class="btn btn-primary btn-sm" id="nextBtn">${icon('plus')} New Waiting Guest</button></div></div>`;
    $('#nextBtn').onclick = () => { clearWork(); q.focus(); };
    try {
      const { url, svg } = await api('GET', `/api/waiting-guests/${g.id}/qr`);
      $('#qrBox').innerHTML = svg;
      $('#qrActions').insertAdjacentHTML('afterbegin', `<button class="btn btn-ghost btn-sm" id="copyBtn">${icon('copy')} Copy guest link</button><a class="btn btn-ghost btn-sm" href="${esc(url)}" target="_blank" rel="noopener">${icon('link')} Open guest page</a>`);
      $('#copyBtn').onclick = async () => toast((await copyText(url)) ? 'Guest link copied' : 'Could not copy. Use "Open guest page".', 'ok');
    } catch (e) { $('#qrBox').textContent = 'QR unavailable'; }
  }

  function clearWork() { $('#work').innerHTML = ''; S.selectedId = null; S.formOpenedAt = null; renderList(); }

  /** Keep the "has the guest scanned it?" line on the QR panel live. */
  function refreshScanState() {
    const el = $('#scanState');
    if (!el) return;
    const g = S.active.concat(S.completed).find((x) => x.id === Number(el.dataset.wg));
    if (g) { const html = engagementHtml(g); if (el.innerHTML !== html) el.innerHTML = html; }
  }

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
      if (document.querySelector('.modal-overlay')) return; // never redraw under an open dialog
      renderWg(g, history);
      if (scroll) $('#work').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) { if (!e.silent) $('#work').innerHTML = `<div class="banner err">${esc(e.message)}</div>`; }
  }

  function editDialog(g) {
    const ov = document.createElement('div');
    ov.className = 'modal-overlay';
    ov.innerHTML = `<form class="modal-box" style="max-width:480px" role="dialog" aria-modal="true" aria-labelledby="edT"><h2 id="edT">Edit ${esc(g.wgNumber)}</h2>
      <div style="display:flex;flex-direction:column;gap:12px;margin-top:12px">
      <label class="field"><span>Luggage tag</span><input class="in" id="eTag" maxlength="40" value="${esc(g.luggageTag)}"></label>
      <label class="field"><span>Associate name</span><input class="in" id="eAssoc" maxlength="80" value="${esc(g.associate)}" required></label>
      <label class="field"><span>Guest language (QR page)</span><select class="in" id="eLang">${langOptions(g.language)}</select></label>
      ${tagChips(g.tags || [])}
      <label class="field"><span>Guest preferences</span><textarea class="in" id="ePref" maxlength="500" rows="2">${esc(g.preferences)}</textarea></label>
      <label class="field"><span>Remarks</span><textarea class="in" id="eRem" maxlength="500" rows="2">${esc(g.remarks)}</textarea></label>
      <div class="banner err" id="edErr" hidden></div></div>
      <div class="modal-actions"><button type="button" class="btn btn-ghost" data-r="0">Cancel</button><button class="btn btn-primary" type="submit" id="edGo">Save</button></div></form>`;
    document.body.appendChild(ov);
    const close = () => ov.remove();
    $('[data-r="0"]', ov).onclick = close;
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    ov.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const b = $('#edGo', ov); b.classList.add('loading');
      try {
        await api('POST', `/api/waiting-guests/${g.id}/details`, { luggageTag: $('#eTag', ov).value, associate: $('#eAssoc', ov).value, language: $('#eLang', ov).value, tags: readTags(ov), preferences: $('#ePref', ov).value, remarks: $('#eRem', ov).value });
        close(); toast('Details updated'); await loadList();
      } catch (ex) { b.classList.remove('loading'); $('#edErr', ov).textContent = ex.message; $('#edErr', ov).hidden = false; }
    });
  }

  function renderWg(g, history) {
    const ready = g.status === 'ready' || g.status === 'returned', closed = ['completed', 'cancelled'].includes(g.status);
    const note = g.status === 'ready' ? `<div class="ready-note">${icon('key')} Room is ready. Verify the guest, then complete.</div>`
      : g.status === 'returned' ? `<div class="ready-note">${icon('key')} Guest is at the desk. Complete to finish.</div>`
      : g.status === 'completed' ? `<div class="banner info">Completed at ${fmtClock(g.timestamps.completed)}. Key activation and the final hotel transaction happen outside this system.</div>`
      : g.status === 'cancelled' ? `<div class="banner err">Cancelled at ${fmtClock(g.timestamps.cancelled)}: ${esc(g.cancelReason)}</div>`
      : `<div class="banner info">${icon('clock')}<span>Room is not ready yet (${esc(STATUS_LABEL[g.status])}). It cannot be completed until the Rooms Controller marks it ready.</span></div>`;
    $('#work').innerHTML = `<div class="card panel">
      <div class="panel-head"><div><div class="label">Waiting Guest · ${esc(g.wgNumber)}</div><h2 class="serif">${esc(g.guestName)}</h2></div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${g.source === 'manual' ? '<span class="type-pill">Manual entry</span>' : ''}${statusPill(g.status)}</div></div>
      ${note}
      <div class="verify"><div class="label" style="margin-bottom:8px">Verify with the guest</div><div class="kv">
        <div><span>Guest name</span><b>${esc(g.guestName)}</b></div><div><span>Confirmation</span><b class="num">${esc(g.confirmationNo)}</b></div>
        <div><span>WG number</span><b class="num">${esc(g.wgNumber)}</b></div>${g.roomNumber && ready ? `<div><span>Room</span><b class="num">${esc(g.roomNumber)}</b></div>` : `<div><span>Stay</span><b>${fmtDate(g.arrivalDate)} → ${fmtDate(g.departureDate)}</b></div>`}</div></div>
      <div class="actions top">
        ${!closed ? `<button class="btn btn-primary" id="completeBtn" ${ready ? '' : 'disabled'}>${icon('check')} Complete Waiting Guest</button>` : ''}
        ${g.status === 'ready' ? `<button class="btn btn-ghost" id="returnedBtn">Guest is at the desk</button>` : ''}
      </div>
      <div class="actions sec">
        <button class="btn btn-ghost btn-sm" id="qrBtn">${icon('link')} Show QR</button>
        ${!closed ? `<button class="btn btn-ghost btn-sm" id="editBtn">Edit details</button><button class="btn btn-ghost btn-sm btn-danger" id="cancelWgBtn">Cancel record…</button>` : ''}
      </div>
      ${!closed ? `<div class="eng-line">${engagementHtml(g)}</div>` : ''}
      <hr>${detailGroupsHtml(g, typeName)}
      <hr><div class="section-label">Timeline</div>${timelineHtml(g, history)}
    </div>`;
    const cb = $('#completeBtn');
    if (cb && ready) cb.onclick = async () => {
      const ok = await confirmDialog({ title: `Complete ${g.wgNumber}?`, body: `Confirm you have verified <b>${esc(g.guestName)}</b> (${esc(g.confirmationNo)}). This closes the Waiting Guest record.`, confirmLabel: 'Complete' });
      if (!ok) return;
      cb.classList.add('loading');
      try { await api('POST', `/api/waiting-guests/${g.id}/status`, { status: 'completed' }); toast(`${g.wgNumber} completed`); await loadList(); }
      catch (e) { cb.classList.remove('loading'); if (!e.silent) toast(e.message, 'err'); await loadList(); }
    };
    const rb = $('#returnedBtn');
    if (rb) rb.onclick = async () => { rb.classList.add('loading'); try { await api('POST', `/api/waiting-guests/${g.id}/status`, { status: 'returned' }); toast('Marked as returned'); await loadList(); } catch (e) { rb.classList.remove('loading'); if (!e.silent) toast(e.message, 'err'); await loadList(); } };
    $('#qrBtn').onclick = () => { S.selectedId = null; showQr(g, false); };
    const eb = $('#editBtn'); if (eb) eb.onclick = () => editDialog(g);
    const xb = $('#cancelWgBtn');
    if (xb) xb.onclick = async () => {
      const reason = await dialog({ title: `Cancel ${g.wgNumber}?`, body: 'Use this when the record was created by mistake or the guest no longer waits. The guest page will stop showing room updates.', confirmLabel: 'Cancel Waiting Guest', cancelLabel: 'Keep', input: { label: 'Reason (required)', min: 3, error: 'Please give a short reason' } });
      if (!reason) return;
      try { await api('POST', `/api/waiting-guests/${g.id}/cancel`, { reason }); toast(`${g.wgNumber} cancelled`); await loadList(); } catch (e) { if (!e.silent) toast(e.message, 'err'); }
    };
  }

  /* ---------- boot ---------- */
  (async function init() {
    try {
      S.roomTypes = (await api('GET', '/api/meta')).roomTypes;
      $('#list').innerHTML = '<div class="skeleton" style="height:64px"></div><div class="skeleton" style="height:64px"></div>';
      await loadList();
      WG.stopLive = live(loadList, setLive);
    } catch (e) { if (!e.silent) toast(e.message, 'err'); }
  })();
};
