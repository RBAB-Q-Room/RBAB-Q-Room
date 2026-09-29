'use strict';
/* Admin: overview, arrivals/rooms import, users, export. */
WG.views.admin = function (root, user) {
  const S = { tab: 'overview', users: [], metrics: null, summary: null, roomTypes: {}, imp: null };

  root.innerHTML = `<div id="topbar"></div>
    <div class="ad-wrap"><nav class="ad-tabs" role="tablist" id="adTabs">
      <button role="tab" data-tab="overview">Overview</button><button role="tab" data-tab="arrivals">Import arrivals</button>
      <button role="tab" data-tab="rooms">Import rooms</button><button role="tab" data-tab="users">Users</button><button role="tab" data-tab="export">Export</button></nav>
    <main id="adBody" aria-live="polite"></main></div>`;
  mountTopbar(user, 'Admin');

  const tabs = $('#adTabs');
  tabs.addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) go(b.dataset.tab); });
  function go(tab) {
    S.tab = tab; S.imp = null;
    $$('#adTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    ({ overview, arrivals: () => importer('arrivals'), rooms: () => importer('rooms'), users, export: exportView })[tab]();
  }
  const body = () => $('#adBody');
  const err = (e) => { if (!e.silent) toast(e.message, 'err'); };

  /* ---------- overview ---------- */
  async function overview(quiet) {
    if (!quiet) body().innerHTML = '<div class="skeleton" style="height:120px"></div>';
    try {
      const [sum, m] = await Promise.all([api('GET', '/api/admin/summary'), api('GET', '/api/metrics')]);
      S.summary = sum; S.metrics = m;
      const warn = [];
      if (!sum.rooms) warn.push('No rooms yet. Import rooms so the Rooms Controller can assign them.');
      if (!sum.arrivalsToday) warn.push(`No reservations arriving today (${fmtDate(sum.today)}). Import today's arrivals so Reception can look guests up.`);
      body().innerHTML = `${warn.map((w) => `<div class="banner info" style="margin-bottom:10px">${icon('alert')}<span>${esc(w)}</span></div>`).join('')}
        <div class="ad-cards">
          <div class="metric"><span>Reservations loaded</span><b>${sum.reservations}</b></div>
          <div class="metric"><span>Arriving today</span><b>${sum.arrivalsToday}</b></div>
          <div class="metric"><span>Rooms</span><b>${sum.rooms}</b></div>
          <div class="metric"><span>Staff users</span><b>${sum.users}</b></div></div>
        <h3 class="serif ad-h">Live figures <span class="muted" style="font-family:inherit;font-size:12px;font-weight:500">(computed from real records only)</span></h3>
        <div class="ad-cards">
          <div class="metric"><span>Active</span><b>${m.active}</b></div><div class="metric"><span>Completed</span><b>${m.completed}</b></div><div class="metric"><span>Cancelled</span><b>${m.cancelled}</b></div>
          <div class="metric"><span>Avg. wait to ready</span><b>${m.avgWaitToReadySec == null ? '-' : fmtDuration(m.avgWaitToReadySec)}</b></div>
          <div class="metric"><span>Avg. ready to return</span><b>${m.avgReadyToReturnSec == null ? '-' : fmtDuration(m.avgReadyToReturnSec)}</b></div>
          <div class="metric"><span>Avg. total time</span><b>${m.avgTotalSec == null ? '-' : fmtDuration(m.avgTotalSec)}</b></div></div>
        <h3 class="serif ad-h">Active Waiting Guests (read only)</h3>
        <div class="card" style="overflow:auto"><table class="tbl"><thead><tr><th>WG</th><th>Guest</th><th>Status</th><th>Room</th><th>Waiting</th></tr></thead><tbody>
          ${sum.active.length ? sum.active.map((g) => `<tr><td><b>${esc(g.wgNumber)}</b></td><td>${esc(g.guestName)}</td><td>${statusPill(g.status)}</td><td>${esc(g.roomNumber || '-')}</td><td class="num" data-since="${esc(g.timestamps.created)}"${['ready', 'returned'].includes(g.status) ? ` data-until="${esc(g.timestamps.roomReady)}"` : ''}>0:00</td></tr>`).join('') : '<tr><td colspan="5" class="muted" style="text-align:center;padding:24px">No active Waiting Guests</td></tr>'}
        </tbody></table></div>
        <p class="muted" style="font-size:12.5px;margin-top:14px">Guest links open at: <code>${esc(sum.guestBase || 'unknown (deploy the web app first)')}</code></p>`;
      tickTimers();
    } catch (e) { err(e); }
  }

  /* ---------- CSV import (arrivals or rooms) ---------- */
  function importer(kind) {
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
          go('overview');
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
  function exportView() {
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
    go('overview');
    WG.stopLive = live(() => { if (S.tab === 'overview') overview(true); }, setLive, { baseMs: 8000 });
  })();
};
