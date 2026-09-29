'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, createGuest } = require('./helpers');

const toReady = (t, wg) => {
  const room = t.ctl('GET', `/api/waiting-guests/${wg.id}`).body.rooms[0].roomNumber;
  t.ctl('POST', `/api/waiting-guests/${wg.id}/assign-room`, { roomNumber: room });
  t.ctl('POST', `/api/waiting-guests/${wg.id}/status`, { status: 'ready' });
  return room;
};

test('only admins can list, edit, correct, delete and reset', () => {
  const t = boot();
  const { wg } = createGuest(t);
  for (const who of ['rec', 'ctl']) {
    assert.equal(t[who]('GET', '/api/admin/records').status, 403);
    assert.equal(t[who]('POST', `/api/admin/records/${wg.id}`, { guestName: 'X' }).status, 403);
    assert.equal(t[who]('POST', `/api/admin/records/${wg.id}/status`, { status: 'waiting', reason: 'xxx' }).status, 403);
    assert.equal(t[who]('POST', `/api/admin/records/${wg.id}/delete`, { confirm: wg.wgNumber }).status, 403);
    assert.equal(t[who]('POST', '/api/admin/reset', { confirm: 'RESET' }).status, 403);
    assert.equal(t[who]('POST', '/api/users/1/delete', {}).status, 403);
  }
  assert.equal(t.b.call('', 'POST', '/api/admin/reset', { confirm: 'RESET' }).status, 401);
});

test('admin edits a record, including reservation details, with validation', () => {
  const t = boot();
  const { wg, token } = createGuest(t);
  const r = t.adm('POST', `/api/admin/records/${wg.id}`, { guestName: 'Hassan Al-Mansoori', roomType: 'kge', adults: 3, luggageTag: 'T-9', vipCode: 'VIP3', tags: ['accessibility'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.waitingGuest.guestName, 'Hassan Al-Mansoori');
  assert.equal(r.body.waitingGuest.roomType, 'KGE');
  assert.equal(r.body.waitingGuest.adults, 3);
  assert.deepEqual(r.body.waitingGuest.tags, ['accessibility']);
  assert.equal(t.guest(token).body.waitingGuest.guestName, 'Hassan Al-Mansoori', 'guest page shows the correction');
  assert.equal(t.adm('POST', `/api/admin/records/${wg.id}`, { guestName: '' }).status, 400);
  assert.equal(t.adm('POST', `/api/admin/records/${wg.id}`, { departureDate: '2000-01-01' }).status, 400);
  assert.equal(t.adm('POST', `/api/admin/records/${wg.id}`, { associate: '' }).status, 400);
  const other = createGuest(t, '51840233').wg;
  assert.equal(t.adm('POST', `/api/admin/records/${other.id}`, { confirmationNo: wg.confirmationNo }).status, 409, 'no two active records for one confirmation');
  const hist = t.adm('GET', `/api/waiting-guests/${wg.id}`).body.history;
  assert.ok(hist.some((h) => /corrected by admin/i.test(h.note)));
  assert.ok(t.b.ev('Store').all('Audit').some((a) => a.action === 'record.edit'));
});

test('admin corrects a status: undo "ready", reopen a completed record, with honest timestamps', () => {
  const t = boot();
  const { wg, token } = createGuest(t);
  const room = toReady(t, wg);
  assert.equal(t.adm('POST', `/api/admin/records/${wg.id}/status`, { status: 'preparing', reason: '' }).status, 400, 'reason required');
  const back = t.adm('POST', `/api/admin/records/${wg.id}/status`, { status: 'preparing', reason: 'Marked ready by mistake' }).body.waitingGuest;
  assert.equal(back.status, 'preparing');
  assert.equal(back.roomNumber, room, 'room kept');
  assert.equal(back.timestamps.roomReady, '', 'ready time cleared so metrics stay true');
  assert.equal(back.timestamps.guestNotified, '');
  assert.equal(t.guest(token).body.waitingGuest.phase, 'preparing', 'guest page goes back too');
  const toWaiting = t.adm('POST', `/api/admin/records/${wg.id}/status`, { status: 'waiting', reason: 'Room swapped' }).body.waitingGuest;
  assert.equal(toWaiting.roomNumber, '', 'going back to waiting releases the room');
  assert.equal(toWaiting.timestamps.roomAssigned, '');
  toReady(t, wg);
  t.rec('POST', `/api/waiting-guests/${wg.id}/status`, { status: 'completed' });
  const reopened = t.adm('POST', `/api/admin/records/${wg.id}/status`, { status: 'ready', reason: 'Completed wrong guest' }).body.waitingGuest;
  assert.equal(reopened.status, 'ready');
  assert.equal(reopened.timestamps.completed, '');
  assert.equal(reopened.timestamps.guestReturned, '');
  assert.equal(t.adm('POST', `/api/admin/records/${wg.id}/status`, { status: 'ready', reason: 'again' }).status, 409);
  assert.equal(t.adm('POST', `/api/admin/records/${wg.id}/status`, { status: 'bogus', reason: 'xxx' }).status, 400);
  // a room held by another active guest cannot be used in a correction
  const b = createGuest(t, '51840233').wg;
  assert.equal(t.adm('POST', `/api/admin/records/${b.id}/status`, { status: 'room_assigned', roomNumber: reopened.roomNumber, reason: 'test' }).status, 409);
  assert.equal(t.adm('POST', `/api/admin/records/${b.id}/status`, { status: 'room_assigned', reason: 'test' }).status, 409, 'a room is needed');
  const cancelled = t.adm('POST', `/api/admin/records/${b.id}/status`, { status: 'cancelled', reason: 'Duplicate' }).body.waitingGuest;
  assert.equal(cancelled.cancelReason, 'Duplicate');
});

test('admin deletes a record only after typing its number; its link stops working', () => {
  const t = boot();
  const { wg, token } = createGuest(t);
  assert.equal(t.adm('POST', `/api/admin/records/${wg.id}/delete`, { confirm: 'WG-9999' }).status, 400);
  assert.equal(t.adm('POST', `/api/admin/records/${wg.id}/delete`, { confirm: wg.wgNumber.toLowerCase() }).status, 200);
  assert.equal(t.guest(token).status, 404);
  assert.equal(t.rec('GET', '/api/waiting-guests').body.active.length, 0);
  assert.equal(t.b.ev('Store').all('StatusHistory').filter((h) => h.waiting_guest_id === wg.id).length, 0);
  assert.equal(t.adm('POST', `/api/admin/records/${wg.id}/delete`, { confirm: wg.wgNumber }).status, 404);
  assert.ok(t.b.ev('Store').all('Audit').some((a) => a.action === 'record.delete'));
  assert.equal(createGuest(t).wg.wgNumber, 'WG-0002', 'numbers are never reused after a single delete');
});

test('reset wipes test records, restarts numbering, keeps users, rooms and settings', () => {
  const t = boot();
  createGuest(t); createGuest(t, '51840233');
  const S = t.b.ev('Store');
  const rooms = S.all('Rooms').length, users = S.all('Users').length;
  assert.equal(t.adm('POST', '/api/admin/reset', { confirm: 'reset' }).status, 400, 'must type RESET exactly');
  const r = t.adm('POST', '/api/admin/reset', { confirm: 'RESET' });
  assert.deepEqual(r.body, { waitingGuests: 2, reservations: 0 });
  S.reset();
  assert.equal(S.all('WaitingGuests').length, 0);
  assert.equal(S.all('StatusHistory').length, 0);
  assert.equal(S.all('Rooms').length, rooms);
  assert.equal(S.all('Users').length, users);
  assert.ok(S.all('Reservations').length > 0, 'reservations kept unless asked');
  assert.equal(createGuest(t).wg.wgNumber, 'WG-0001', 'numbering restarts');
  const r2 = t.adm('POST', '/api/admin/reset', { confirm: 'RESET', reservations: true });
  assert.equal(r2.body.waitingGuests, 1);
  S.reset();
  assert.equal(S.all('Reservations').length, 0);
  assert.equal(t.adm('GET', '/api/waiting-guests').status, 200, 'the app keeps working on an empty sheet');
});

test('admin edits and deletes users with safety rules', () => {
  const t = boot();
  const users = () => t.adm('GET', '/api/users').body.users;
  const rec = users().find((u) => u.username === 'rec');
  const adm = users().find((u) => u.username === 'adm');
  const { wg } = createGuest(t, '51840268'); // created by rec, whose account is deleted below
  assert.equal(t.adm('POST', `/api/users/${rec.id}/update`, { name: 'Front Desk 1', role: 'rooms_controller' }).status, 200);
  assert.equal(users().find((u) => u.id === rec.id).role, 'rooms_controller');
  t.b.state.cache.clear();
  assert.equal(t.rec('GET', '/api/me').status, 401, 'role change signs the user out');
  assert.equal(t.adm('POST', `/api/users/${rec.id}/update`, { role: 'king' }).status, 400);
  assert.equal(t.adm('POST', `/api/users/${rec.id}/update`, { name: '' }).status, 400);
  assert.equal(t.adm('POST', `/api/users/${adm.id}/update`, { role: 'reception' }).status, 409, 'cannot demote yourself / last admin');
  assert.equal(t.adm('POST', `/api/users/${adm.id}/delete`, {}).status, 409, 'cannot delete yourself');
  assert.equal(t.adm('POST', `/api/users/${rec.id}/delete`, {}).status, 200);
  assert.ok(!users().some((u) => u.id === rec.id));
  assert.equal(t.b.call('', 'POST', '/api/login', { username: 'rec', password: 'Password-rec' }).status, 401);
  assert.equal(t.adm('GET', `/api/waiting-guests/${wg.id}`).status, 200, 'history still loads after its author is deleted');
  assert.equal(t.adm('POST', '/api/users/9999/delete', {}).status, 404);
});
