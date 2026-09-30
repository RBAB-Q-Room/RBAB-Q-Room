/* =====================================================================
 * Setup, self-test and maintenance. Run these from the Apps Script editor
 * (pick the function in the toolbar, press Run).
 * ===================================================================== */

/**
 * Only the script owner, running a function from the Apps Script editor, may
 * pass. Every top-level function without a trailing underscore can also be
 * called by web-app visitors through google.script.run, so each editor-only
 * function starts with this check. It fails closed: if Google returns no
 * email (missing userinfo.email scope, anonymous visitor), it refuses.
 */
function requireEditor_() {
  let active = '', effective = '';
  try {
    active = Session.getActiveUser().getEmail();
    effective = Session.getEffectiveUser().getEmail();
  } catch (e) { /* no email available */ }
  if (!active || active !== effective) {
    throw new Error('Run this from the Apps Script editor while signed in as the owner of the script.');
  }
}

/**
 * RUN ONCE. Creates the database sheet (if the script is not attached to one),
 * every tab, the default room types and guest content, and the first admin
 * login. The admin password is shown in the log ONCE.
 * Safe to run again: it never overwrites existing data.
 */
function setup() {
  requireEditor_();
  const msg = setup_();
  Logger.log(msg);
  return msg;
}

function setup_() {
  const createdSheet = Store.bootstrap();
  migrate_();
  let created = null;
  if (!Store.all('Users').length) {
    created = Auth.createUser(null, { username: 'admin', name: 'Administrator', role: 'admin' });
  }
  return (createdSheet ? 'Created the database sheet "Waiting Guest Database" in your Google Drive.\n' : '') + (created
    ? 'SETUP COMPLETE.\nFirst admin login (shown once, copy it now):\n  username: admin\n  password: ' + created.password + '\nNext: deploy as a web app, sign in, change this password, then create Reception and Rooms Controller users.'
    : 'SETUP COMPLETE. Tabs are up to date. Existing users were left unchanged.');
}

/**
 * Bring the sheet up to the current schema: new tabs, new columns (always
 * appended at the end, so existing data never moves), default rows and any
 * new settings. Idempotent.
 */
function migrate_() {
  Store.ensureSchema();
  Locks.run(function () {
    if (!Store.all('RoomTypes').length) Store.insertMany('RoomTypes', DEFAULT_ROOM_TYPES.map(function (t) { return { code: t[0], name: t[1] }; }));
    if (!Store.all('GuestContent').length) Store.insertMany('GuestContent', DEFAULT_GUEST_CONTENT.map(guestContentRow_));
    const have = {};
    Store.all('Config').forEach(function (r) { have[r.key] = true; });
    Store.insertMany('Config', Object.keys(CONFIG_DEFAULTS).filter(function (k) { return !have[k]; }).map(function (k) { return { key: k, value: CONFIG_DEFAULTS[k] }; }));
    if (Store.kvGet('Meta', 'version') === null) Store.kvSet('Meta', 'version', 1);
    Store.kvSet('Meta', 'schema_version', SCHEMA_VERSION);
  });
  CacheService.getScriptCache().put('wg:schema', String(SCHEMA_VERSION), 21600);
}

/**
 * Called before every API request. After new code is pasted in, the first
 * request upgrades the sheet automatically, so nobody has to remember to run
 * setup() again. Cheap: one cache read in the normal case.
 */
function ensureCurrent_() {
  const cache = CacheService.getScriptCache();
  if (cache.get('wg:schema') === String(SCHEMA_VERSION)) return;
  let current = null;
  try { current = Store.kvGet('Meta', 'schema_version'); } catch (e) { current = null; }
  if (current === String(SCHEMA_VERSION)) { cache.put('wg:schema', String(SCHEMA_VERSION), 21600); return; }
  migrate_();
}

/**
 * OPTIONAL demo data for testing only (mock reservations arriving today,
 * mock rooms, a demo Reception and Rooms Controller login). Never run this
 * on the live sheet. Passwords are printed to the log once.
 */
function loadDemoData() {
  requireEditor_();
  setup_();
  const today = todayIso_();
  const plus = function (n) { const d = new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000); return d.toISOString().slice(0, 10); };
  const R = [
    ['51840217', 'Hassan Al Mansoori', '10:40', 4, 'KGAOV', 2, 0, '+971 50 555 0142', 'h.almansoori@example.com', 'Bed & Breakfast', 'AE', '', 'Quiet room if possible'],
    ['51840233', 'Emily Carter', '11:15', 7, 'SKC', 2, 2, '+44 7700 900123', 'emily.carter@example.com', 'All Inclusive', 'GB', '', 'Cot required'],
    ['51840251', 'Dmitri Volkov', '09:55', 5, 'KGEOV', 2, 0, '+7 900 555 01 17', 'd.volkov@example.com', 'All Inclusive', 'RU', 'VIP1', 'Anniversary stay'],
    ['51840268', 'Priya Nair', '12:05', 3, 'TWA', 2, 0, '+91 98450 55021', 'priya.nair@example.com', 'Half Board', 'IN', '', ''],
    ['51840274', 'Jonas Becker', '10:10', 6, 'KGA', 1, 0, '+49 151 5550 1188', 'jonas.becker@example.com', 'All Inclusive', 'DE', '', ''],
    ['51840291', 'Fatima Al Zaabi', '13:20', 2, 'SKD', 2, 1, '+971 55 555 0186', 'fatima.alzaabi@example.com', 'Bed & Breakfast', 'AE', 'VIP2', 'Connecting room requested'],
    ['51840305', 'Marco Rossi', '11:50', 5, 'TWAOV', 2, 0, '+39 333 555 0109', 'marco.rossi@example.com', 'All Inclusive', 'IT', '', 'High floor'],
    ['51840312', 'Aisha Khan', '10:25', 7, 'SKB', 2, 3, '+92 300 5550 144', 'aisha.khan@example.com', 'All Inclusive', 'PK', '', 'Family with young children'],
  ];
  // Real room list from Room Guide when Google can reach it; invented demo rooms otherwise.
  if (!Store.all('Rooms').length) { try { RoomGuide.sync(null, {}); } catch (e) { /* fall back to demo rooms below */ } Store.reset(); }
  Locks.run(function () {
    const have = {};
    Store.all('Reservations').forEach(function (r) { have[r.confirmation_no] = true; });
    Store.insertMany('Reservations', R.filter(function (r) { return !have[r[0]]; }).map(function (r) {
      return { confirmation_no: r[0], guest_name: r[1], arrival_date: today, arrival_time: r[2], departure_date: plus(r[3]), room_type: r[4], adults: r[5], children: r[6], phone: r[7], email: r[8], nights: r[3], rate_plan: 'Mock rate', meal_plan: r[9], nationality: r[10], vip_code: r[11], special_requests: r[12], imported_at: nowIso_() };
    }));
    if (!Store.all('Rooms').length) {
      const types = ['KGA', 'KGAOV', 'KGE', 'KGEOV', 'TWA', 'TWAOV', 'SKB', 'SKC', 'SKD'];
      const hk = ['clean', 'inspected', 'clean', 'dirty', 'clean', 'inspected', 'dirty', 'clean'];
      const rooms = [];
      ['10', '11', '12', '21', '22', '31'].forEach(function (fl, f) {
        for (let i = 1; i <= 8; i++) rooms.push({ room_number: fl + (i < 10 ? '0' : '') + i, building: f < 3 ? 'Zumroud' : f < 5 ? 'Amwaj' : 'Marmar', floor: fl, room_type: types[(f * 3 + i) % types.length], hk_status: (f + i) % 13 === 0 ? 'out_of_order' : hk[(f + i) % hk.length] });
      });
      Store.insertMany('Rooms', rooms);
    }
    Store.bump();
  });
  const out = [];
  [['reception', 'Reception Desk (demo)', 'reception'], ['controller', 'Rooms Controller (demo)', 'rooms_controller']].forEach(function (u) {
    if (!Store.all('Users').some(function (x) { return x.username === u[0]; })) {
      const c = Auth.createUser(null, { username: u[0], name: u[1], role: u[2] });
      out.push(u[0] + ' / ' + c.password);
    }
  });
  const msg = 'DEMO DATA LOADED (testing only).\n' + (out.length ? 'Demo logins (shown once):\n  ' + out.join('\n  ') : 'Demo users already existed.');
  Logger.log(msg);
  return msg;
}

/** Add a login from the editor if you cannot reach the app: createUserFromEditor('name','Full Name','reception') */
function createUserFromEditor(username, name, role) {
  requireEditor_();
  const c = Auth.createUser(null, { username: username, name: name, role: role });
  Logger.log('User created. Username: ' + c.user.username + '  Password (shown once): ' + c.password);
  return c;
}

/**
 * Run this after deploying to prove the real Google environment works.
 * It creates a temporary test guest, walks it through the whole journey,
 * checks what the guest can and cannot see, then removes every trace.
 */
function runSelfTest() {
  requireEditor_();
  const log = [];
  const check = function (cond, label) { log.push((cond ? 'PASS  ' : 'FAIL  ') + label); if (!cond) throw new Error('Self-test failed: ' + label); };
  const stamp = String(Date.now()).slice(-6);
  const rec = { username: 'selftest-rec-' + stamp, role: 'reception' }, ctl = { username: 'selftest-ctl-' + stamp, role: 'rooms_controller' };
  const conf = 'ST' + stamp, room = 'ST' + stamp.slice(-4);
  let wgId = null;
  Store.reset();
  const savedCounters = {};
  ['wg_id', 'wg_number', 'history_counter'].forEach(function (k) { savedCounters[k] = Store.kvGet('Meta', k); });
  try {
    const a = Auth.createUser(null, { username: rec.username, name: 'Self test reception', role: 'reception', password: 'SelfTest-' + stamp + 'a' });
    const b = Auth.createUser(null, { username: ctl.username, name: 'Self test controller', role: 'rooms_controller', password: 'SelfTest-' + stamp + 'b' });
    rec.id = a.user.id; ctl.id = b.user.id;
    Locks.run(function () {
      Store.insert('Reservations', { confirmation_no: conf, guest_name: 'Self Test', arrival_date: todayIso_(), arrival_time: '10:00', departure_date: todayIso_(), room_type: 'KGA', adults: 2, children: 1, phone: '+971 00 000 0000', email: 'selftest@example.com', nights: 1, imported_at: nowIso_() });
      Store.insert('Rooms', { room_number: room, building: 'TEST', floor: '0', room_type: 'KGA', hk_status: 'clean' });
    });
    const t0 = Date.now();
    const rs = Auth.login(rec.username, 'SelfTest-' + stamp + 'a'), cs = Auth.login(ctl.username, 'SelfTest-' + stamp + 'b');
    const loginMs = Math.round((Date.now() - t0) / 2);
    check(!!rs.token && !!cs.token, 'staff can sign in (' + loginMs + ' ms each)');
    check(loginMs < 4000, 'sign-in is fast enough. If this fails, lower auth_rounds in the Config tab');
    const call = function (s, m, p, body) { return Api.handle(s.token, m, p, body); };
    const created = call(rs, 'POST', '/api/waiting-guests', { confirmationNo: conf, associate: 'Self test', luggageTag: 'T-1', remarks: 'secret remark' });
    check(created.status === 201, 'reception creates a Waiting Guest');
    const wg = created.body.waitingGuest; wgId = wg.id;
    check(/^[A-Z]+-\d+$/.test(wg.wgNumber), 'Waiting Guest number generated: ' + wg.wgNumber);
    const qr = call(rs, 'GET', '/api/waiting-guests/' + wg.id + '/qr');
    check(qr.status === 200 && qr.body.svg.indexOf('<svg') === 0 && /[?&]t=[0-9a-f]{64}$/.test(qr.body.url), 'QR generated with an unguessable link');
    const token = qr.body.url.split('t=')[1];
    check(call(cs, 'GET', '/api/waiting-guests').body.active.some(function (g) { return g.id === wg.id; }), 'guest appears in the Rooms Controller queue');
    const g1 = Api.handle('', 'GET', '/api/guest/' + token);
    check(g1.status === 200 && g1.body.waitingGuest.phase === 'received', 'guest page shows the request was received');
    const leak = JSON.stringify(g1.body.waitingGuest);
    check(['selftest@example.com', '+971 00', 'T-1', 'secret remark', 'Self test"'].every(function (s) { return leak.indexOf(s) === -1; }), 'guest page hides phone, email, luggage tag, remarks, associate');
    check(call(rs, 'POST', '/api/waiting-guests/' + wg.id + '/assign-room', { roomNumber: room }).status === 403, 'reception cannot assign rooms');
    check(call(cs, 'POST', '/api/waiting-guests/' + wg.id + '/status', { status: 'ready' }).status === 409, 'cannot mark ready before a room is assigned');
    check(call(cs, 'POST', '/api/waiting-guests/' + wg.id + '/assign-room', { roomNumber: room }).status === 200, 'controller assigns a room');
    check(call(cs, 'POST', '/api/waiting-guests/' + wg.id + '/status', { status: 'ready' }).status === 200, 'controller marks room ready');
    check(Api.handle('', 'GET', '/api/guest/' + token).body.waitingGuest.phase === 'ready', 'the same QR page now shows "room ready"');
    check(call(rs, 'POST', '/api/waiting-guests/' + wg.id + '/status', { status: 'completed' }).status === 200, 'reception completes it');
    check(Api.handle('', 'GET', '/api/guest/' + token).body.waitingGuest.phase === 'completed', 'guest page shows completed');
    log.push('\nALL CHECKS PASSED. Test data is being removed.');
  } finally {
    Locks.run(function () {
      // remove every trace of the test
      [['WaitingGuests', 'id', wgId], ['Reservations', 'confirmation_no', conf], ['Rooms', 'room_number', room], ['Users', 'id', rec.id], ['Users', 'id', ctl.id]].forEach(function (t) {
        if (t[2] === null || t[2] === undefined) return;
        const r = Store.find(t[0], t[1], t[2]);
        if (r) Store.remove(t[0], r._row);
      });
      Store.all('StatusHistory').filter(function (h) { return h.waiting_guest_id === wgId; }).reverse().forEach(function (h) { Store.remove('StatusHistory', h._row); });
      Store.all('Sessions').filter(function (s) { return s.user_id === rec.id || s.user_id === ctl.id; }).reverse().forEach(function (s) { Store.remove('Sessions', s._row); });
      Object.keys(savedCounters).forEach(function (k) { Store.kvSet('Meta', k, savedCounters[k] === null ? '0' : savedCounters[k]); }); // leave real numbering untouched
      Store.bump();
    });
  }
  const out = log.join('\n');
  Logger.log(out);
  return out;
}

/** Move old completed/cancelled Waiting Guests to the Archive tab to keep the sheet fast. */
function archiveOld(e) {
  // Runs from the nightly trigger, or by the owner from the editor. The trigger id is
  // checked against this project's own triggers so a web visitor cannot fake it.
  const uid = e && e.triggerUid ? String(e.triggerUid) : '';
  const fromTrigger = uid && ScriptApp.getProjectTriggers().some(function (t) { return t.getUniqueId() === uid; });
  if (!fromTrigger) requireEditor_();
  const days = Config.num('archive_after_days') || 30;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return Locks.run(function () {
    const book = Store.spreadsheet();
    let arch = book.getSheetByName('Archive');
    const cols = SCHEMA.WaitingGuests.map(function (c) { return c[0]; });
    if (!arch) { arch = book.insertSheet('Archive'); arch.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold'); arch.getRange(1, 1, 2000, cols.length).setNumberFormat('@'); }
    // Reservations whose stay has ended are personal data with no further use: remove them.
    const cutoffDate = cutoff.slice(0, 10);
    const stale = Store.all('Reservations').filter(function (r) { return r.departure_date < cutoffDate; });
    stale.slice().sort(function (a, b) { return b._row - a._row; }).forEach(function (r) { Store.remove('Reservations', r._row); });
    const old = Store.all('WaitingGuests').filter(function (r) { return ACTIVE_STATUSES.indexOf(r.status) === -1 && (r.completed_at || r.cancelled_at) < cutoff; });
    if (!old.length) { if (stale.length) Store.bump(); return 'No Waiting Guests to archive. Removed ' + stale.length + ' old reservation(s).'; }
    // Phone and email are blanked in the archive: it keeps the timings for analysis without contact details.
    arch.getRange(arch.getLastRow() + 1, 1, old.length, cols.length).setNumberFormat('@').setValues(old.map(function (r) {
      return cols.map(function (c) { return c === 'phone' || c === 'email' ? '' : String(r[c] === true ? '1' : r[c] === false ? '' : r[c]); });
    }));
    old.slice().sort(function (a, b) { return b._row - a._row; }).forEach(function (r) { Store.remove('WaitingGuests', r._row); });
    const ids = {}; old.forEach(function (r) { ids[r.id] = true; });
    Store.all('StatusHistory').filter(function (h) { return ids[h.waiting_guest_id]; }).reverse().forEach(function (h) { Store.remove('StatusHistory', h._row); });
    Store.bump();
    return 'Archived ' + old.length + ' record(s) and removed ' + stale.length + ' old reservation(s).';
  });
}

/** Optional: run once to archive automatically every night. */
function installNightlyArchive() {
  requireEditor_();
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'archiveOld') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('archiveOld').timeBased().everyDays(1).atHour(4).create();
  Logger.log('Nightly archive installed (04:00).');
}
