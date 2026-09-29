'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, createGuest } = require('./helpers');

test('the complete journey keeps one source of truth in sync', () => {
  const t = boot();
  const found = t.rec('GET', '/api/search?q=51840217');
  assert.equal(found.body.reservations[0].guestName, 'Hassan Al Mansoori');
  assert.equal(t.rec('POST', '/api/waiting-guests', { confirmationNo: '51840217' }).status, 400, 'associate is required');

  const { wg, token, url } = createGuest(t, '51840217', { luggageTag: 'T-4471', preferences: 'High floor', remarks: 'Internal note' });
  assert.match(wg.wgNumber, /^WG-\d{4}$/);
  assert.equal(wg.status, 'waiting');
  assert.equal(wg.phone, '+971 50 555 0142', 'phone comes from the reservation, not typed');
  assert.equal(wg.timestamps.created, wg.timestamps.guestArrival);
  assert.match(url, /^https:\/\/script\.google\.com\/macros\/s\/TEST\/exec\?t=[0-9a-f]{64}$/);
  assert.equal(t.rec('POST', '/api/waiting-guests', { confirmationNo: '51840217', associate: 'X' }).status, 409, 'no duplicate active guest');

  // Rooms Controller sees it immediately
  assert.equal(t.ctl('GET', '/api/waiting-guests').body.active[0].wgNumber, wg.wgNumber);
  assert.equal(t.guest(token).body.waitingGuest.phase, 'preparing');

  // rules and roles
  assert.equal(t.rec('POST', `/api/waiting-guests/${wg.id}/assign-room`, { roomNumber: '1001' }).status, 403);
  assert.equal(t.ctl('POST', `/api/waiting-guests/${wg.id}/status`, { status: 'ready' }).status, 409, 'cannot be ready without a room');
  assert.equal(t.ctl('POST', `/api/waiting-guests/${wg.id}/status`, { status: 'preparing' }).status, 409, 'cannot skip room assignment');

  const rooms = t.ctl('GET', `/api/waiting-guests/${wg.id}`).body.rooms;
  const room = rooms.find((r) => r.matchesType);
  assert.ok(room, 'a room of the right type is offered first');
  assert.equal(rooms[0].matchesType, true);
  const assigned = t.ctl('POST', `/api/waiting-guests/${wg.id}/assign-room`, { roomNumber: room.roomNumber });
  assert.equal(assigned.body.waitingGuest.status, 'room_assigned');
  assert.equal(t.ctl('POST', `/api/waiting-guests/${wg.id}/status`, { status: 'preparing' }).body.waitingGuest.status, 'preparing');
  const ready = t.ctl('POST', `/api/waiting-guests/${wg.id}/status`, { status: 'ready' }).body.waitingGuest;
  assert.ok(ready.timestamps.roomReady && ready.timestamps.guestNotified);
  assert.equal(t.guest(token).body.waitingGuest.phase, 'ready', 'the same QR link now shows ready');

  // Controller cannot complete; reception verifies by WG number, then completes
  assert.equal(t.ctl('POST', `/api/waiting-guests/${wg.id}/status`, { status: 'completed' }).status, 403);
  assert.equal(t.rec('GET', `/api/search?q=${wg.wgNumber}`).body.waitingGuests[0].status, 'ready');
  assert.equal(t.rec('GET', '/api/search?q=hassan').body.waitingGuests[0].id, wg.id, 'search by name');
  const done = t.rec('POST', `/api/waiting-guests/${wg.id}/status`, { status: 'completed' }).body.waitingGuest;
  assert.ok(done.timestamps.completed && done.timestamps.guestReturned);
  assert.equal(t.guest(token).body.waitingGuest.phase, 'completed');
  assert.equal(t.rec('POST', `/api/waiting-guests/${wg.id}/status`, { status: 'completed' }).status, 409, 'cannot complete twice');

  const hist = t.rec('GET', `/api/waiting-guests/${wg.id}`).body.history.map((h) => h.to);
  assert.deepEqual(hist, ['waiting', 'room_assigned', 'preparing', 'ready', 'returned', 'completed']);
  const m = t.rec('GET', '/api/metrics').body;
  assert.equal(m.completed, 1); assert.equal(m.active, 0);
  assert.equal(typeof m.avgWaitToReadySec, 'number');

  // reservation can get a fresh record afterwards, with a new number and a new token
  const again = createGuest(t, '51840217');
  assert.notEqual(again.wg.wgNumber, wg.wgNumber);
  assert.notEqual(again.token, token);
});

test('guest page exposes only guest-safe fields', () => {
  const t = boot();
  const { token } = createGuest(t, '51840217', { luggageTag: 'T-4471', preferences: 'High floor', remarks: 'Internal note' });
  const body = JSON.stringify(t.guest(token).body);
  for (const secret of ['Layla', 'T-4471', 'High floor', 'Internal note', '+971', 'example.com', 'phone', 'email', 'associate', 'luggage', 'remarks', 'created_by', 'roomNumber']) {
    assert.ok(!body.includes(secret), 'guest response must not contain: ' + secret);
  }
  assert.deepEqual(Object.keys(t.guest(token).body.waitingGuest).sort(), ['arrivalDate', 'arrivalTime', 'confirmationNo', 'departureDate', 'guestName', 'language', 'phase', 'readyAt', 'roomType', 'wgNumber'], 'exact whitelist of guest fields');
  assert.equal(t.guest('x'.repeat(40)).status, 404);
  assert.equal(t.guest('short').status, 404);
  assert.equal(t.b.call('', 'GET', '/api/guest/' + '0'.repeat(64)).status, 404);
  const wg = t.ctl('GET', '/api/waiting-guests').body.active[0];
  const room = t.ctl('GET', `/api/waiting-guests/${wg.id}`).body.rooms[0].roomNumber;
  t.ctl('POST', `/api/waiting-guests/${wg.id}/assign-room`, { roomNumber: room });
  t.ctl('POST', `/api/waiting-guests/${wg.id}/status`, { status: 'ready' });
  assert.ok(!JSON.stringify(t.guest(token).body).includes(`"${room}"`), 'room number is not shown to the guest');
});

test('a room can be held by only one active guest, and changing it frees the old one', () => {
  const t = boot();
  const a = createGuest(t, '51840233').wg, b = createGuest(t, '51840251').wg;
  const room = t.ctl('GET', `/api/waiting-guests/${a.id}`).body.rooms[0].roomNumber;
  assert.equal(t.ctl('POST', `/api/waiting-guests/${a.id}/assign-room`, { roomNumber: room }).status, 200);
  assert.equal(t.ctl('POST', `/api/waiting-guests/${b.id}/assign-room`, { roomNumber: room }).status, 409);
  assert.ok(!t.ctl('GET', `/api/waiting-guests/${b.id}`).body.rooms.some((r) => r.roomNumber === room), 'held room is not offered');
  const other = t.ctl('GET', `/api/waiting-guests/${a.id}`).body.rooms.find((r) => r.roomNumber !== room).roomNumber;
  assert.equal(t.ctl('POST', `/api/waiting-guests/${a.id}/assign-room`, { roomNumber: other }).body.waitingGuest.roomNumber, other);
  assert.equal(t.ctl('POST', `/api/waiting-guests/${b.id}/assign-room`, { roomNumber: room }).status, 200, 'released room can be reused');
  assert.equal(t.ctl('POST', `/api/waiting-guests/${b.id}/assign-room`, { roomNumber: 'NOPE' }).status, 404);
  const ooo = t.b.ev('Store').all('Rooms').find((r) => r.hk_status === 'out_of_order');
  assert.ok(ooo);
  assert.equal(t.ctl('POST', `/api/waiting-guests/${a.id}/assign-room`, { roomNumber: ooo.room_number }).status, 409);
});

test('cancel, edit details, priority and manual entry', () => {
  const t = boot();
  const { wg } = createGuest(t, '51840268');
  assert.equal(t.rec('POST', `/api/waiting-guests/${wg.id}/details`, { luggageTag: 'B-9', associate: 'Sami', preferences: 'Quiet', remarks: '' }).body.waitingGuest.luggageTag, 'B-9');
  assert.equal(t.rec('POST', `/api/waiting-guests/${wg.id}/details`, { associate: '' }).status, 400);
  assert.equal(t.ctl('POST', `/api/waiting-guests/${wg.id}/details`, { associate: 'x' }).status, 403);
  assert.equal(t.ctl('POST', `/api/waiting-guests/${wg.id}/priority`, { priority: true }).body.waitingGuest.priority, true);
  assert.equal(t.rec('POST', `/api/waiting-guests/${wg.id}/priority`, { priority: false }).status, 403);
  assert.equal(t.rec('POST', `/api/waiting-guests/${wg.id}/cancel`, { reason: '' }).status, 400);
  const room = t.ctl('GET', `/api/waiting-guests/${wg.id}`).body.rooms[0].roomNumber;
  t.ctl('POST', `/api/waiting-guests/${wg.id}/assign-room`, { roomNumber: room });
  const c = t.rec('POST', `/api/waiting-guests/${wg.id}/cancel`, { reason: 'Created by mistake' });
  assert.equal(c.body.waitingGuest.status, 'cancelled');
  assert.equal(t.rec('POST', `/api/waiting-guests/${wg.id}/cancel`, { reason: 'again' }).status, 409);
  assert.equal(t.rec('GET', '/api/waiting-guests').body.active.length, 0);
  const g2 = createGuest(t, '51840251').wg;
  assert.ok(t.ctl('GET', `/api/waiting-guests/${g2.id}`).body.rooms.some((r) => r.roomNumber === room), 'cancelled guest freed the room');
  assert.equal(t.rec('GET', '/api/metrics').body.cancelled, 1);

  assert.equal(t.rec('POST', '/api/waiting-guests', { confirmationNo: '99999999', associate: 'A' }).status, 404);
  assert.equal(t.rec('POST', '/api/waiting-guests', { confirmationNo: '99999999', associate: 'A', manual: { guestName: '' } }).status, 400);
  const m = t.rec('POST', '/api/waiting-guests', { confirmationNo: '99999999', associate: 'A', manual: { guestName: 'Walk In', arrivalDate: '2026-09-29', departureDate: '2026-10-01', roomType: 'kga', adults: 2, children: 0, arrivalTime: '9:05' } });
  assert.equal(m.status, 201);
  assert.equal(m.body.waitingGuest.source, 'manual');
  assert.equal(m.body.waitingGuest.roomType, 'KGA');
  assert.equal(m.body.waitingGuest.arrivalTime, '09:05');
  assert.equal(t.rec('POST', '/api/waiting-guests', { confirmationNo: '88888888', associate: 'A', manual: { guestName: 'X', arrivalDate: '2026-10-05', departureDate: '2026-10-01', roomType: 'KGA', adults: 2 } }).status, 400, 'departure before arrival');
});

test('numbers are unique and sequential, tokens are unpredictable', () => {
  const t = boot();
  const seen = [], tokens = new Set();
  for (const c of ['51840217', '51840233', '51840251', '51840268', '51840274']) {
    const g = createGuest(t, c);
    seen.push(g.wg.wgNumber); tokens.add(g.token);
    assert.match(g.token, /^[0-9a-f]{64}$/);
  }
  assert.equal(tokens.size, 5);
  assert.deepEqual(seen, ['WG-0001', 'WG-0002', 'WG-0003', 'WG-0004', 'WG-0005']);
});

test('a busy system fails cleanly instead of corrupting data', () => {
  const t = boot();
  t.b.state.lockBusy = true;
  assert.equal(t.rec('POST', '/api/waiting-guests', { confirmationNo: '51840217', associate: 'A' }).status, 503);
  t.b.state.lockBusy = false;
  assert.equal(t.rec('GET', '/api/waiting-guests').body.active.length, 0, 'nothing was written');
  assert.equal(t.rec('POST', '/api/waiting-guests', { confirmationNo: '51840217', associate: 'A' }).status, 201);
});

test('version counter changes on every write and only then', () => {
  const t = boot();
  const v0 = t.rec('GET', '/api/version').body.version;
  t.rec('GET', '/api/waiting-guests'); t.rec('GET', '/api/metrics');
  assert.equal(t.rec('GET', '/api/version').body.version, v0);
  const { wg, token } = createGuest(t);
  assert.ok(t.rec('GET', '/api/version').body.version > v0);
  const full = t.guest(token).body;
  assert.equal(t.b.call('', 'GET', `/api/guest/${token}?v=${full.version}&have=1`).body.unchanged, true);
  t.ctl('POST', `/api/waiting-guests/${wg.id}/priority`, { priority: true });
  assert.equal(t.b.call('', 'GET', `/api/guest/${token}?v=${full.version}&have=1`).body.unchanged, undefined);
});
