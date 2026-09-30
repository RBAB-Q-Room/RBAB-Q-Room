'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { boot, createGuest } = require('./helpers');

const RG_URL = 'https://rbabroomguide.github.io/data.js';
const RG_TEXT = fs.readFileSync(path.join(__dirname, 'fixtures', 'room-guide-data.js'), 'utf8');
const withRoomGuide = (t, reply = { code: 200, text: RG_TEXT }) => { t.b.state.fetch = { [RG_URL]: reply }; };

test('rooms load from the Room Guide project, read as data only', () => {
  const t = boot();
  withRoomGuide(t);
  assert.equal(t.rec('POST', '/api/admin/rooms/sync', {}).status, 403);
  const r = t.adm('POST', '/api/admin/rooms/sync', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.total, 36, '12 rooms from each building; the Posting Interface is skipped');
  const S = t.b.ev('Store'); S.reset();
  const room = S.find('Rooms', 'room_number', '1018');
  assert.equal(room.building, 'Zumroud');
  assert.equal(room.floor, 'Ground Floor');
  assert.equal(room.room_type, 'KGA');
  assert.equal(room.connecting, '1019');
  assert.match(room.features, /BAL/);
  assert.equal(room.source, 'room-guide');
  assert.ok(!S.all('Rooms').some((x) => x.room_type === 'PI'));
  // a second sync changes nothing and keeps housekeeping status
  S.update('Rooms', room._row, { hk_status: 'inspected' });
  const again = t.adm('POST', '/api/admin/rooms/sync', {}).body;
  assert.deepEqual([again.added, again.updated], [0, 0]);
  S.reset();
  assert.equal(S.find('Rooms', 'room_number', '1018').hk_status, 'inspected');
  // details reach the Rooms Controller's picker
  const { wg } = createGuest(t, '51840274'); // KGA
  const pick = t.ctl('GET', `/api/waiting-guests/${wg.id}`).body.rooms.find((x) => x.roomNumber === '1018');
  assert.equal(pick.connecting, '1019');
  assert.ok(pick.features.includes('BAL'));
});

test('Room Guide sync can replace demo rooms but never removes a room in use', () => {
  const t = boot(); // demo data has invented rooms like 1003
  const { wg } = createGuest(t);
  const held = t.ctl('GET', `/api/waiting-guests/${wg.id}`).body.rooms.find((r) => !['1001', '1008'].includes(r.roomNumber)).roomNumber;
  t.ctl('POST', `/api/waiting-guests/${wg.id}/assign-room`, { roomNumber: held });
  withRoomGuide(t);
  const r = t.adm('POST', '/api/admin/rooms/sync', { removeMissing: true }).body;
  assert.ok(r.removed > 0);
  const S = t.b.ev('Store'); S.reset();
  assert.ok(S.find('Rooms', 'room_number', held), 'room held by an active guest is kept');
  assert.equal(S.all('Rooms').filter((x) => x.source !== 'room-guide').length, r.keptHeld);
});

test('Room Guide failures are explained, never half-applied', () => {
  const t = boot();
  const before = JSON.stringify(t.b.ev('Store').all('Rooms'));
  for (const [reply, msg] of [[null, /Could not reach/], [{ code: 404, text: '' }, /returned an error \(404\)/], [{ code: 200, text: '<html>not it</html>' }, /does not contain room data/],
    [{ code: 200, text: 'const RBAB_DATA = {broken' }, /does not contain|could not be read/], [{ code: 200, text: 'const RBAB_DATA = {"buildingOrder":[],"buildings":{}};' }, /no rooms/]]) {
    t.b.state.fetch = reply ? { [RG_URL]: reply } : {};
    const r = t.adm('POST', '/api/admin/rooms/sync', {});
    assert.equal(r.status >= 400, true);
    assert.match(r.body.error, msg);
  }
  // hostile content is data, not code
  t.b.state.fetch = { [RG_URL]: { code: 200, text: 'const RBAB_DATA = {"buildingOrder":["x"],"buildings":{"x":{"label":"X","rooms":{"a":{"room":"=cmd()","type":"KGA"},"b":{"room":"7001","type":"<script>"},"c":{"room":"7002","type":"KGA","description":"<b>ok</b>"}}}}};' } };
  const r = t.adm('POST', '/api/admin/rooms/sync', {});
  assert.equal(r.body.total, 1, 'invalid room numbers and types are skipped');
  t.b.ev('Store').reset();
  assert.equal(t.b.ev('Store').find('Rooms', 'room_number', '7002').description, '<b>ok</b>', 'stored as text; the UI escapes it');
  assert.ok(before.length > 0);
  // the link is an admin setting and must be http(s)
  assert.equal(t.adm('POST', '/api/admin/settings', { values: { room_guide_data_url: 'file:///etc/passwd' } }).status, 400);
});

test('Rooms Controller can type a room number that is not in the list', () => {
  const t = boot();
  const { wg, token } = createGuest(t);
  assert.equal(t.ctl('POST', `/api/waiting-guests/${wg.id}/assign-room`, { roomNumber: 'X-999' }).status, 404, 'without "manual" an unknown room is refused');
  assert.equal(t.ctl('POST', `/api/waiting-guests/${wg.id}/assign-room`, { roomNumber: 'bad room!', manual: true }).status, 400);
  const r = t.ctl('POST', `/api/waiting-guests/${wg.id}/assign-room`, { roomNumber: ' v-12 ', manual: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.waitingGuest.roomNumber, 'V-12');
  assert.equal(r.body.waitingGuest.status, 'room_assigned');
  assert.ok(t.ctl('GET', `/api/waiting-guests/${wg.id}`).body.history.some((h) => /entered manually/.test(h.note)));
  const other = createGuest(t, '51840233').wg;
  assert.equal(t.ctl('POST', `/api/waiting-guests/${other.id}/assign-room`, { roomNumber: 'V-12', manual: true }).status, 409, 'a typed room is protected from double booking too');
  // typing a listed room number uses the list (so out-of-order rooms are still refused)
  const ooo = t.b.ev('Store').all('Rooms').find((x) => x.hk_status === 'out_of_order');
  assert.equal(t.ctl('POST', `/api/waiting-guests/${other.id}/assign-room`, { roomNumber: ooo.room_number, manual: true }).status, 409);
  assert.equal(t.guest(token).body.waitingGuest.phase, 'assigned');
  assert.ok(!JSON.stringify(t.guest(token).body).includes('V-12'), 'the guest never sees the room number');
});

test('Rooms Controller takes back "room ready" marked by mistake; the guest page follows', () => {
  const t = boot();
  const { wg, token } = createGuest(t);
  const room = t.ctl('GET', `/api/waiting-guests/${wg.id}`).body.rooms[0].roomNumber;
  t.ctl('POST', `/api/waiting-guests/${wg.id}/assign-room`, { roomNumber: room });
  assert.equal(t.ctl('POST', `/api/waiting-guests/${wg.id}/undo-ready`, { reason: 'Not ready' }).status, 409, 'only a ready room can be taken back');
  t.ctl('POST', `/api/waiting-guests/${wg.id}/status`, { status: 'ready' });
  t.b.call('', 'GET', `/api/guest/${token}?seen=1`);
  assert.equal(t.guest(token).body.waitingGuest.phase, 'ready');
  assert.equal(t.rec('POST', `/api/waiting-guests/${wg.id}/undo-ready`, { reason: 'x mistake' }).status, 403, 'Reception cannot');
  assert.equal(t.ctl('POST', `/api/waiting-guests/${wg.id}/undo-ready`, { reason: '' }).status, 400, 'reason required');
  const back = t.ctl('POST', `/api/waiting-guests/${wg.id}/undo-ready`, { reason: 'Housekeeping not finished' }).body.waitingGuest;
  assert.equal(back.status, 'preparing');
  assert.equal(back.roomNumber, room, 'room stays assigned');
  assert.equal(back.timestamps.roomReady, '');
  assert.equal(back.timestamps.guestSawReady, '');
  assert.equal(t.guest(token).body.waitingGuest.phase, 'preparing', 'guest page goes back to "being prepared"');
  assert.ok(t.ctl('GET', `/api/waiting-guests/${wg.id}`).body.history.some((h) => /taken back: Housekeeping not finished/.test(h.note)));
  // after the guest is back at Reception only an admin can correct it
  t.ctl('POST', `/api/waiting-guests/${wg.id}/status`, { status: 'ready' });
  t.rec('POST', `/api/waiting-guests/${wg.id}/status`, { status: 'returned' });
  const late = t.ctl('POST', `/api/waiting-guests/${wg.id}/undo-ready`, { reason: 'too late' });
  assert.equal(late.status, 409);
  assert.match(late.body.error, /admin/);
  const m = t.adm('GET', '/api/metrics').body;
  assert.equal(m.readyCount, 1, 'the undone "ready" is not counted');
});

test('admin status correction accepts a typed room number', () => {
  const t = boot();
  const { wg } = createGuest(t);
  const r = t.adm('POST', `/api/admin/records/${wg.id}/status`, { status: 'room_assigned', roomNumber: 'b-7', reason: 'Room outside list' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.waitingGuest.roomNumber, 'B-7');
});

test('history records the real "from" status and previous room', () => {
  const t = boot();
  const { wg } = createGuest(t);
  const rooms = t.ctl('GET', `/api/waiting-guests/${wg.id}`).body.rooms;
  t.ctl('POST', `/api/waiting-guests/${wg.id}/assign-room`, { roomNumber: rooms[0].roomNumber });
  t.ctl('POST', `/api/waiting-guests/${wg.id}/assign-room`, { roomNumber: 'Q-1', manual: true });
  t.adm('POST', `/api/admin/records/${wg.id}/status`, { status: 'preparing', reason: 'test' });
  t.rec('POST', `/api/waiting-guests/${wg.id}/cancel`, { reason: 'Duplicate' });
  const h = t.adm('GET', `/api/waiting-guests/${wg.id}`).body.history.map((x) => [x.from, x.to, x.roomNumber, x.note]);
  assert.deepEqual(h[1].slice(0, 2), ['waiting', 'room_assigned']);
  assert.equal(h[2][3], `Room changed from ${rooms[0].roomNumber}; room number entered manually`);
  assert.deepEqual(h[3].slice(0, 2), ['room_assigned', 'preparing']);
  assert.deepEqual(h[4].slice(0, 2), ['preparing', 'cancelled']);
  assert.ok(t.b.ev('Store').all('Audit').some((a) => a.detail.includes('room_assigned -> preparing')));
});
