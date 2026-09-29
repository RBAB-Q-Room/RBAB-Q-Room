'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, createGuest } = require('./helpers');

test('staff endpoints need a valid session and the right role', () => {
  const t = boot();
  const anon = (m, p, b) => t.b.call('', m, p, b);
  for (const [m, p] of [['GET', '/api/waiting-guests'], ['GET', '/api/metrics'], ['GET', '/api/meta'], ['GET', '/api/search?q=abc'], ['GET', '/api/users'], ['GET', '/api/version'], ['GET', '/api/me']]) {
    assert.equal(anon(m, p).status, 401, `${m} ${p} must require sign-in`);
  }
  assert.equal(t.b.call('f'.repeat(64), 'GET', '/api/me').status, 401, 'forged token');
  assert.equal(t.b.call('short', 'GET', '/api/me').status, 401);
  // role matrix
  assert.equal(t.rec('GET', '/api/users').status, 403);
  assert.equal(t.ctl('GET', '/api/users').status, 403);
  assert.equal(t.ctl('GET', '/api/search?q=abc').status, 403, 'controller cannot search reservations');
  assert.equal(t.adm('GET', '/api/search?q=abc').status, 403, 'admin does not act as reception');
  assert.equal(t.rec('POST', '/api/import/arrivals', { csv: 'x' }).status, 403);
  assert.equal(t.ctl('POST', '/api/import/rooms/preview', { csv: 'x' }).status, 403);
  assert.equal(t.rec('GET', '/api/export/waiting-guests').status, 403);
  assert.equal(t.adm('POST', '/api/waiting-guests', { confirmationNo: '51840217', associate: 'a' }).status, 403);
  assert.equal(t.rec('GET', '/api/admin/summary').status, 403);
  assert.equal(t.rec('GET', '/api/nope').status, 404);
  assert.equal(t.rec('DELETE', '/api/waiting-guests/1').status, 404);
});

test('login: wrong password, unknown user, throttling, sessions, deactivation', () => {
  const t = boot();
  const login = (u, p) => t.b.call('', 'POST', '/api/login', { username: u, password: p });
  assert.equal(login('rec', 'nope').status, 401);
  assert.equal(login('nobody', 'nope').status, 401);
  assert.equal(login('rec', 'nope').body.error, login('nobody', 'nope').body.error, 'same message for unknown user and wrong password');
  assert.equal(login('rec', 'Password-rec').status, 200);
  assert.equal(login('REC', 'Password-rec').status, 200, 'username is case-insensitive');
  for (let i = 0; i < 5; i++) login('ctl', 'wrong');
  assert.equal(login('ctl', 'Password-ctl').status, 429, 'locked after repeated failures');
  const ok = login('rec', 'Password-rec');
  assert.ok(!JSON.stringify(ok.body).match(/hash|salt/i));

  // logout kills the session
  const s = login('rec', 'Password-rec').body.token;
  assert.equal(t.b.call(s, 'GET', '/api/me').status, 200);
  t.b.call(s, 'POST', '/api/logout', {});
  assert.equal(t.b.call(s, 'GET', '/api/me').status, 401);

  // deactivating a user ends their access (after the 60 s auth cache)
  const users = t.adm('GET', '/api/users').body.users;
  const rec = users.find((u) => u.username === 'rec');
  assert.equal(t.adm('POST', `/api/users/${rec.id}/active`, { active: false }).status, 200);
  assert.equal(login('rec', 'Password-rec').status, 401);
  t.b.state.cache.clear();
  assert.equal(t.rec('GET', '/api/me').status, 401, 'existing session is dead once the cache expires');
});

test('expired sessions are rejected', () => {
  const t = boot();
  const S = t.b.ev('Store');
  const row = S.all('Sessions')[0];
  S.update('Sessions', row._row, { expires_at: '2000-01-01T00:00:00.000Z' });
  t.b.state.cache.clear();
  assert.equal(t.b.call(t.users.rec.token, 'GET', '/api/me').status, 401);
});

test('passwords are never stored in clear and admin user rules hold', () => {
  const t = boot();
  const rows = JSON.stringify(t.b.state.sheets.Users);
  assert.ok(!rows.includes('Password-rec') && !rows.includes('Password-adm'));
  const created = t.adm('POST', '/api/users', { username: 'new.user', name: 'New User', role: 'reception' });
  assert.equal(created.status, 201);
  assert.ok(created.body.password.length >= 12);
  assert.equal(t.b.call('', 'POST', '/api/login', { username: 'new.user', password: created.body.password }).status, 200);
  assert.equal(t.adm('POST', '/api/users', { username: 'new.user', name: 'Dup', role: 'reception' }).status, 409);
  assert.equal(t.adm('POST', '/api/users', { username: 'NEW.USER', name: 'Dup', role: 'reception' }).status, 409, 'case-insensitive duplicate');
  assert.equal(t.adm('POST', '/api/users', { username: 'x y', name: 'Bad', role: 'reception' }).status, 400);
  assert.equal(t.adm('POST', '/api/users', { username: 'okname', name: 'Bad', role: 'superuser' }).status, 400);
  const admin = t.adm('GET', '/api/users').body.users.find((u) => u.username === 'adm');
  assert.equal(t.adm('POST', `/api/users/${admin.id}/active`, { active: false }).status, 409, 'cannot deactivate the last admin / yourself');
  // reset password invalidates the old one
  const rec = t.adm('GET', '/api/users').body.users.find((u) => u.username === 'rec');
  const reset = t.adm('POST', `/api/users/${rec.id}/reset-password`, {});
  assert.equal(t.b.call('', 'POST', '/api/login', { username: 'rec', password: 'Password-rec' }).status, 401);
  assert.equal(t.b.call('', 'POST', '/api/login', { username: 'rec', password: reset.body.password }).status, 200);
  // change own password
  assert.equal(t.ctl('POST', '/api/me/password', { current: 'wrong', next: 'NewPassword-1' }).status, 403);
  assert.equal(t.ctl('POST', '/api/me/password', { current: 'Password-ctl', next: 'short' }).status, 400);
  assert.equal(t.ctl('POST', '/api/me/password', { current: 'Password-ctl', next: 'NewPassword-1' }).status, 200);
  assert.equal(t.b.call('', 'POST', '/api/login', { username: 'ctl', password: 'NewPassword-1' }).status, 200);
});

test('hostile input is stored as text, never executed or truncated wrongly', () => {
  const t = boot();
  const { wg } = createGuest(t, '51840217', { remarks: '=HYPERLINK("http://evil","x")', preferences: '<script>alert(1)</script>', luggageTag: '+1-2', associate: '@SUM(A1)' });
  const got = t.rec('GET', `/api/waiting-guests/${wg.id}`).body.waitingGuest;
  assert.equal(got.remarks, '=HYPERLINK("http://evil","x")', 'formula-looking text survives verbatim (sheet is plain text)');
  assert.equal(got.preferences, '<script>alert(1)</script>');
  // export neutralises spreadsheet formulas
  const csv = t.adm('GET', '/api/export/waiting-guests').body.csv;
  assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"",""x"")"`), csv);
  assert.ok(csv.includes("'@SUM(A1)") && csv.includes("'+1-2"));
  // over-long input is capped, control characters removed
  const long = createGuest(t, '51840233', { remarks: 'x'.repeat(5000) + '\u0000' }).wg;
  assert.equal(t.rec('GET', `/api/waiting-guests/${long.id}`).body.waitingGuest.remarks.length, 500);
  assert.equal(t.rec('GET', '/api/search?q=' + encodeURIComponent('%')).body.waitingGuests.length, 0);
  assert.ok([401, 404].includes(t.b.call('', 'GET', '/api/guest/' + encodeURIComponent('../../etc/passwd')).status), 'malformed guest path never returns data');
  assert.equal(t.rec('POST', '/api/waiting-guests/abc/status', {}).status, 404);
  assert.equal(t.rec('POST', `/api/waiting-guests/${wg.id}/status`, { status: 'nonsense' }).status, 400);
  assert.equal(t.rec('POST', `/api/waiting-guests/999999/status`, { status: 'completed' }).status, 404);
});

test('the sheet stores everything as text so Google cannot mangle it', () => {
  const t = boot({ demo: false });
  const csv = 'Confirmation Number,Guest Name,Arrival,Departure,Room Type,Adults,Phone\n0012345678901234567,Zero Lead,29/09/2026,30/09/2026,KGA,2,0501234567\n';
  assert.equal(t.adm('POST', '/api/import/arrivals', { csv }).status, 200);
  const r = t.rec('GET', '/api/search?q=0012345678901234567').body.reservations[0];
  assert.equal(r.confirmationNo, '0012345678901234567');
  assert.equal(r.phone, '0501234567', 'leading zero kept');
  assert.match(r.arrivalDate, /^\d{4}-\d{2}-\d{2}$/, 'date stays a plain string');
  const { wg } = createGuest(t, '0012345678901234567', { luggageTag: '007', remarks: '2026-09-29' });
  const got = t.rec('GET', `/api/waiting-guests/${wg.id}`).body.waitingGuest;
  assert.equal(got.luggageTag, '007');
  assert.equal(got.remarks, '2026-09-29');
  // every stored cell in every tab is text
  for (const [name, sd] of Object.entries(t.b.state.sheets)) {
    for (const k of Object.keys(sd.cells)) {
      assert.ok(typeof sd.cells[k] === 'string', `${name}!${k} must be text but is ${JSON.stringify(sd.cells[k])}`);
    }
  }
});

test('rows added below the pre-formatted area are still text', () => {
  const t = boot({ demo: false });
  const sd = t.b.state.sheets.Reservations;
  sd.maxRows = 3; // pretend only a few rows were pre-formatted
  for (const k of Object.keys(sd.fmt)) if (Number(k.split(',')[0]) > 3) delete sd.fmt[k];
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push(`0${1000 + i},Guest ${i},29/09/2026,30/09/2026,KGA,2`);
  const csv = 'Confirmation Number,Guest Name,Arrival,Departure,Room Type,Adults\n' + rows.join('\n');
  assert.equal(t.adm('POST', '/api/import/arrivals', { csv }).status, 200);
  const last = t.b.ev('Store').all('Reservations').pop();
  assert.equal(last.confirmation_no, '01007');
  assert.equal(last.arrival_date, '2026-09-29');
});

test('tampering with the sheet is detected, not silently mis-read', () => {
  const t = boot();
  const sd = t.b.state.sheets.WaitingGuests;
  sd.cells['1,3'] = 'renamed_column'; // someone edits a header cell
  const r = t.rec('GET', '/api/waiting-guests');
  assert.equal(r.status, 500);
  assert.match(r.body.error, /header row of the "WaitingGuests" tab was changed/);
  sd.cells['1,3'] = 'qr_token';
  assert.equal(t.rec('GET', '/api/waiting-guests').status, 200, 'restoring the header fixes it');
});

test('deleting every data row of a full sheet works (Sheets forbids removing all non-frozen rows)', () => {
  const t = boot({ demo: false });
  const sd = t.b.state.sheets.Reservations;
  const rows = ['Confirmation Number,Guest Name,Arrival,Departure,Room Type,Adults'];
  for (let i = 0; i < 40; i++) rows.push(`R${i},G${i},29/09/2026,30/09/2026,KGA,2`);
  assert.equal(t.adm('POST', '/api/import/arrivals', { csv: rows.join('\n') }).status, 200);
  sd.maxRows = t.b.ev('Store').all('Reservations').length + 1; // sheet exactly full
  const csv = 'Confirmation Number,Guest Name,Arrival,Departure,Room Type,Adults\nZ1,Only,29/09/2026,30/09/2026,KGA,2';
  assert.equal(t.adm('POST', '/api/import/arrivals', { csv, replaceAll: true }).status, 200);
  assert.equal(t.b.ev('Store').all('Reservations').length, 1);
});

test('hotel links only allow http(s) and malformed requests return 400, not 500', () => {
  const t = boot();
  t.b.ev('Store').kvSet('Config', 'hotel_website_url', 'javascript:alert(1)');
  const link = createGuestLink(t);
  assert.equal(link.content.links.website.url, null, 'javascript: URLs are dropped');
  t.b.ev('Store').kvSet('Config', 'hotel_website_url', 'https://example.com/hotel');
  assert.equal(createGuestLink(t).content.links.website.url, 'https://example.com/hotel');
  assert.equal(t.b.call(t.users.rec.token, 'GET', '/api/search?q=%E0%A4%A').status, 400, 'broken URL encoding');
  assert.equal(t.b.call(t.users.rec.token, 'POST', '/api/waiting-guests', 'not json {').status, 400);
  assert.equal(typeof t.b.call(t.users.rec.token, 'GET', '/api/version').t, 'number', 'replies carry the server clock');
});

function createGuestLink(t) {
  const { token } = createGuest(t, t.b.ev('Store').all('WaitingGuests').length ? '51840233' : '51840217');
  return t.guest(token).body.content ? t.guest(token).body : t.guest(token).body;
}

test('only doGet, apiCall and guarded editor functions are callable from the browser', () => {
  const { loadBackend } = require('../dev/backend');
  const b = loadBackend();
  const fakeGlobals = new Set(['SpreadsheetApp', 'Utilities', 'CacheService', 'LockService', 'PropertiesService', 'ScriptApp', 'Session', 'Logger', 'HtmlService', 'console']);
  // google.script.run can call every top-level function whose name does not end with "_"
  const callable = Object.keys(b.ctx).filter((k) => typeof b.ctx[k] === 'function' && !k.endsWith('_') && !fakeGlobals.has(k)).sort();
  assert.deepEqual(callable, ['apiCall', 'archiveOld', 'createUserFromEditor', 'doGet', 'installNightlyArchive', 'loadDemoData', 'runSelfTest', 'setup'].sort());
});

test('editor-only functions refuse web visitors (anonymous or not the owner)', () => {
  const { boot } = require('./helpers');
  const t = boot();
  for (const who of ['', 'someone.else@example.com']) {
    t.b.state.activeUser = who;
    for (const fn of ['setup', 'loadDemoData', 'runSelfTest', 'installNightlyArchive', 'archiveOld']) {
      assert.throws(() => t.b.ctx[fn](), /Apps Script editor/, `${fn} must refuse ${who || 'anonymous'}`);
    }
    assert.throws(() => t.b.ctx.createUserFromEditor('evil', 'Evil', 'admin'), /Apps Script editor/);
    assert.throws(() => t.b.ctx.archiveOld({ triggerUid: 'FORGED' }), /Apps Script editor/, 'a forged trigger id is refused');
  }
  assert.ok(!t.b.ev('Store').all('Users').some((u) => u.username === 'evil'), 'no user was created');
  // the owner can, and a real trigger can
  t.b.state.activeUser = 'owner@example.com';
  t.b.ctx.installNightlyArchive();
  t.b.state.activeUser = '';
  const uid = t.b.state && t.b.ctx.ScriptApp.getProjectTriggers()[0].getUniqueId();
  assert.doesNotThrow(() => t.b.ctx.archiveOld({ triggerUid: uid }));
  // if Google returns no email at all (scope missing), everything fails closed
  t.b.state.activeUser = ''; t.b.state.owner = '';
  assert.throws(() => t.b.ctx.setup(), /Apps Script editor/);
});

test('a standalone script creates its own database sheet on setup, once', () => {
  const { loadBackend } = require('../dev/backend');
  const b = loadBackend({ bound: false });
  assert.equal(b.call('', 'GET', '/api/guest/' + 'a'.repeat(64)).status, 500, 'before setup the app reports it is not set up');
  assert.match(b.ctx.setup(), /Created the database sheet/);
  assert.equal(b.state.created, 1);
  assert.doesNotMatch(b.ctx.setup(), /Created the database sheet/);
  assert.equal(b.state.created, 1, 'never creates a second sheet');
});

test('new code upgrades an older sheet automatically on the first request', () => {
  const { boot } = require('./helpers');
  const t = boot();
  const S = t.b.ev('Store');
  S.kvSet('Meta', 'schema_version', '1');
  t.b.state.cache.clear();
  // simulate an old sheet: drop a newer column header and a newer setting
  const sd = t.b.state.sheets.WaitingGuests;
  const cols = t.b.ev('SCHEMA').WaitingGuests.length;
  delete sd.cells['1,' + cols];
  const cfg = S.find('Config', 'key', 'late_warn_minutes'); S.remove('Config', cfg._row);
  assert.equal(t.rec('GET', '/api/waiting-guests').status, 200);
  S.reset();
  assert.equal(S.kvGet('Meta', 'schema_version'), String(t.b.ev('SCHEMA_VERSION')));
  assert.ok(S.find('Config', 'key', 'late_warn_minutes'), 'missing setting restored');
});
