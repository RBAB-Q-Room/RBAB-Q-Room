'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildAll } = require('../scripts/build');

const DIST = path.join(__dirname, '..', 'dist', 'apps-script');

test('dist/apps-script is up to date with the source (run: npm run build)', () => {
  const built = buildAll();
  for (const [name, body] of Object.entries(built)) {
    assert.equal(fs.readFileSync(path.join(DIST, name), 'utf8'), body, `${name} is stale. Run "npm run build" and commit.`);
  }
});

test('server bundle is valid Apps Script: no Node-only APIs', () => {
  const code = buildAll()['Code.gs'];
  assert.ok(!/\brequire\s*\(/.test(code.replace(/\/\*[\s\S]*?\*\//g, '').split('/* ---- src/server/10-util.js')[1]), 'no require() in server code');
  assert.ok(!/\bprocess\.|\bBuffer\b|\bfs\./.test(code.split('/* ---- src/server/10-util.js')[1]), 'no Node globals in server code');
  for (const fn of ['doGet', 'apiCall', 'setup', 'loadDemoData', 'runSelfTest', 'archiveOld', 'installNightlyArchive', 'createUserFromEditor']) {
    assert.match(code, new RegExp(`function ${fn}\\(`), `${fn} must exist as a top-level function`);
  }
});

test('Index.html is a valid HtmlService template with exactly one scriptlet', () => {
  const html = buildAll()['Index.html'];
  assert.equal((html.match(/<\?/g) || []).length, 1, 'only the boot scriptlet may contain "<?"');
  assert.match(html, /window\.WG_BOOT = <\?!= boot \?>;/);
  assert.equal((html.match(/<\/script>/g) || []).length, 2);
  assert.ok(html.length < 400_000, 'stays small');
  assert.ok(!/https?:\/\/(?!fonts\.g|easymap)[a-z0-9]/i.test(html.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')), 'no unexpected external hosts');
});

test('manifest is deployable as a public web app', () => {
  const m = JSON.parse(buildAll()['appsscript.json']);
  assert.equal(m.runtimeVersion, 'V8');
  assert.equal(m.timeZone, 'Asia/Dubai');
  assert.deepEqual(m.webapp, { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' });
});

test('doGet serves the shell and only injects a validated guest token', () => {
  const { loadBackend } = require('../dev/backend');
  const b = loadBackend({ htmlFile: path.join(DIST, 'Index.html') });
  const page = b.ctx.doGet({ parameter: {} }).getContent();
  assert.match(page, /window\.WG_BOOT = \{"mode":"staff"/);
  const tok = 'a'.repeat(64);
  assert.match(b.ctx.doGet({ parameter: { t: tok } }).getContent(), new RegExp(`"mode":"guest","token":"${tok}"`));
  const evil = b.ctx.doGet({ parameter: { t: '"};alert(1);//' } }).getContent();
  assert.match(evil, /"mode":"staff","token":""/, 'invalid token is dropped, never injected');
  assert.ok(!evil.includes('alert(1)'));
});

test('setup is idempotent and the self-test leaves no trace', () => {
  const { loadBackend } = require('../dev/backend');
  const b = loadBackend();
  const first = b.ctx.setup();
  assert.match(first, /password: \S{14}/);
  const before = JSON.stringify(b.state.sheets.Users);
  assert.match(b.ctx.setup(), /left unchanged/);
  assert.equal(JSON.stringify(b.state.sheets.Users), before, 'second run changes no users');
  b.ctx.loadDemoData();
  const S = b.ev('Store');
  const snapshot = () => JSON.stringify({ r: S.all('Reservations').length, rooms: S.all('Rooms').length, u: S.all('Users').length, w: S.all('WaitingGuests').length, h: S.all('StatusHistory').length, s: S.all('Sessions').length, ctr: ['wg_id', 'wg_number', 'history_counter'].map((k) => S.kvGet('Meta', k) || '0') });
  S.reset();
  const before2 = snapshot();
  const out = b.ctx.runSelfTest();
  assert.match(out, /ALL CHECKS PASSED/);
  S.reset();
  assert.equal(snapshot(), before2, 'self-test removed everything it created and restored the counters');
  // first real guest is still WG-0001
  const rec = b.ev('Auth').login('reception', b.state.log.join('\n').match(/reception \/ (\S+)/)[1]);
  const g = b.call(rec.token, 'POST', '/api/waiting-guests', { confirmationNo: '51840217', associate: 'A' });
  assert.equal(g.body.waitingGuest.wgNumber, 'WG-0001');
});

test('archiveOld moves only old closed records', () => {
  const { boot, createGuest } = require('./helpers');
  const t = boot();
  const a = createGuest(t, '51840217').wg, b2 = createGuest(t, '51840233').wg;
  const room = t.ctl('GET', `/api/waiting-guests/${a.id}`).body.rooms[0].roomNumber;
  t.ctl('POST', `/api/waiting-guests/${a.id}/assign-room`, { roomNumber: room });
  t.ctl('POST', `/api/waiting-guests/${a.id}/status`, { status: 'ready' });
  t.rec('POST', `/api/waiting-guests/${a.id}/status`, { status: 'completed' });
  const S = t.b.ev('Store');
  assert.match(t.b.ctx.archiveOld(), /No Waiting Guests to archive/, 'recent completions stay');
  S.update('WaitingGuests', S.find('WaitingGuests', 'id', a.id)._row, { completed_at: '2020-01-01T00:00:00.000Z' });
  assert.match(t.b.ctx.archiveOld(), /Archived 1/);
  S.reset();
  assert.deepEqual(JSON.parse(JSON.stringify(S.all('WaitingGuests').map((r) => r.id))), [b2.id], 'active guest untouched');
  assert.equal(S.all('StatusHistory').filter((h) => h.waiting_guest_id === a.id).length, 0);
  assert.ok(t.b.state.sheets.Archive, 'archive tab created');
});

test('archive removes contact details from archived records and purges ended reservations', () => {
  const { boot, createGuest } = require('./helpers');
  const t = boot();
  const a = createGuest(t, '51840217').wg;
  const room = t.ctl('GET', `/api/waiting-guests/${a.id}`).body.rooms[0].roomNumber;
  t.ctl('POST', `/api/waiting-guests/${a.id}/assign-room`, { roomNumber: room });
  t.ctl('POST', `/api/waiting-guests/${a.id}/status`, { status: 'ready' });
  t.rec('POST', `/api/waiting-guests/${a.id}/status`, { status: 'completed' });
  const S = t.b.ev('Store');
  S.update('WaitingGuests', S.find('WaitingGuests', 'id', a.id)._row, { completed_at: '2020-01-01T00:00:00.000Z' });
  S.update('Reservations', S.find('Reservations', 'confirmation_no', '51840233')._row, { departure_date: '2020-01-05' });
  const before = S.all('Reservations').length;
  t.b.ctx.archiveOld();
  S.reset();
  assert.equal(S.all('Reservations').length, before - 1, 'ended reservation removed');
  const arch = t.b.state.sheets.Archive;
  const header = []; for (let c = 1; c <= 40; c++) if (arch.cells['1,' + c]) header.push(arch.cells['1,' + c]);
  const row = header.map((h, i) => arch.cells['2,' + (i + 1)]);
  assert.equal(row[header.indexOf('phone')] || '', '', 'phone not archived');
  assert.equal(row[header.indexOf('email')] || '', '', 'email not archived');
  assert.equal(row[header.indexOf('wg_number')], a.wgNumber, 'timings and number are kept');
});
