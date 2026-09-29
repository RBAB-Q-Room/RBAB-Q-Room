'use strict';
process.env.WG_DEV_PASSWORD = 'test-only-password';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { open } = require('../server/db');

async function boot() {
  const { server } = createApp({ db: open(':memory:'), quiet: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return async (method, path, body) => {
      const res = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = text; }
      return { status: res.status, json, headers: res.headers };
    };
  };
  return { server, client };
}

test('complete journey keeps one source of truth in sync', async (t) => {
  const { server, client } = await boot();
  t.after(() => server.close());
  const reception = client(), controller = client(), guest = client();

  assert.equal((await reception('GET', '/api/waiting-guests')).status, 401);
  assert.equal((await reception('POST', '/api/login', { username: 'reception', password: 'nope' })).status, 401);
  assert.equal((await reception('POST', '/api/login', { username: 'reception', password: 'test-only-password' })).status, 200);
  assert.equal((await controller('POST', '/api/login', { username: 'controller', password: 'test-only-password' })).status, 200);

  // Reception: search + create
  const found = await reception('GET', '/api/search?q=51840217');
  assert.equal(found.json.reservations[0].guestName, 'Hassan Al Mansoori');
  assert.equal((await reception('POST', '/api/waiting-guests', { confirmationNo: '51840217' })).status, 400); // associate required
  const created = await reception('POST', '/api/waiting-guests', {
    confirmationNo: '51840217', associate: 'Layla', luggageTag: 'T-4471', preferences: 'High floor', remarks: 'Internal note',
  });
  assert.equal(created.status, 201);
  const wg = created.json.waitingGuest;
  assert.match(wg.wgNumber, /^WG-\d{4}$/);
  assert.ok(wg.qrToken.length >= 30);
  assert.equal(wg.status, 'waiting');
  assert.equal(wg.phone, '+971 50 555 0142'); // taken from reservation, not typed
  // duplicate active blocked
  assert.equal((await reception('POST', '/api/waiting-guests', { confirmationNo: '51840217', associate: 'X' })).status, 409);

  // Controller sees it immediately
  const q = await controller('GET', '/api/waiting-guests');
  assert.equal(q.json.active[0].wgNumber, wg.wgNumber);

  // Guest page: limited data only
  const g1 = await guest('GET', `/api/guest/${wg.qrToken}`);
  assert.equal(g1.json.waitingGuest.phase, 'preparing');
  const leaked = JSON.stringify(g1.json.waitingGuest);
  for (const secret of ['Layla', 'T-4471', 'Internal note', 'High floor', '+971', 'example.com', '"id"']) assert.ok(!leaked.includes(secret), secret);
  assert.equal((await guest('GET', '/api/guest/not-a-real-token-aaaaaaaaaaaaaaaa')).status, 404);

  // Role enforcement
  assert.equal((await reception('POST', `/api/waiting-guests/${wg.id}/assign-room`, { roomNumber: '1001' })).status, 403);
  assert.equal((await controller('POST', `/api/waiting-guests/${wg.id}/status`, { status: 'ready' })).status, 409); // no room yet

  // Controller: assign, prepare, ready
  const rooms = (await controller('GET', `/api/waiting-guests/${wg.id}`)).json.rooms;
  const room = rooms.find((r) => r.matchesType && r.hkStatus !== 'out_of_order');
  assert.ok(room);
  assert.equal((await controller('POST', `/api/waiting-guests/${wg.id}/assign-room`, { roomNumber: room.roomNumber })).json.waitingGuest.status, 'room_assigned');
  assert.equal((await controller('POST', `/api/waiting-guests/${wg.id}/status`, { status: 'preparing' })).json.waitingGuest.status, 'preparing');
  assert.equal((await guest('GET', `/api/guest/${wg.qrToken}`)).json.waitingGuest.phase, 'preparing');
  const ready = await controller('POST', `/api/waiting-guests/${wg.id}/status`, { status: 'ready' });
  assert.equal(ready.json.waitingGuest.status, 'ready');
  assert.ok(ready.json.waitingGuest.timestamps.roomReady && ready.json.waitingGuest.timestamps.guestNotified);

  // Guest sees ready on the very same link, without room number
  const g2 = await guest('GET', `/api/guest/${wg.qrToken}`);
  assert.equal(g2.json.waitingGuest.phase, 'ready');
  assert.ok(!JSON.stringify(g2.json).includes(`"${room.roomNumber}"`));

  // Controller cannot complete; reception can
  assert.equal((await controller('POST', `/api/waiting-guests/${wg.id}/status`, { status: 'completed' })).status, 403);
  const s = await reception('GET', `/api/search?q=${wg.wgNumber}`);
  assert.equal(s.json.waitingGuests[0].status, 'ready');
  const done = await reception('POST', `/api/waiting-guests/${wg.id}/status`, { status: 'completed' });
  assert.equal(done.json.waitingGuest.status, 'completed');
  assert.ok(done.json.waitingGuest.timestamps.completed && done.json.waitingGuest.timestamps.guestReturned);
  assert.equal((await guest('GET', `/api/guest/${wg.qrToken}`)).json.waitingGuest.phase, 'completed');

  // History and metrics are real
  const hist = (await reception('GET', `/api/waiting-guests/${wg.id}`)).json.history.map((h) => h.to);
  assert.deepEqual(hist, ['waiting', 'room_assigned', 'preparing', 'ready', 'returned', 'completed']);
  const m = (await reception('GET', '/api/metrics')).json;
  assert.equal(m.completed, 1);
  assert.equal(m.active, 0);

  // Same reservation can be re-created after completion, with a new unique number/token
  const again = await reception('POST', '/api/waiting-guests', { confirmationNo: '51840217', associate: 'Layla' });
  assert.equal(again.status, 201);
  assert.notEqual(again.json.waitingGuest.wgNumber, wg.wgNumber);
  assert.notEqual(again.json.waitingGuest.qrToken, wg.qrToken);
});

test('a room cannot be held by two active guests; staff pages need login', async (t) => {
  const { server, client } = await boot();
  t.after(() => server.close());
  const reception = client(), controller = client(), anon = client();
  await reception('POST', '/api/login', { username: 'reception', password: 'test-only-password' });
  await controller('POST', '/api/login', { username: 'controller', password: 'test-only-password' });
  const a = (await reception('POST', '/api/waiting-guests', { confirmationNo: '51840233', associate: 'A' })).json.waitingGuest;
  const b = (await reception('POST', '/api/waiting-guests', { confirmationNo: '51840251', associate: 'A' })).json.waitingGuest;
  const roomNo = (await controller('GET', `/api/waiting-guests/${a.id}`)).json.rooms[0].roomNumber;
  assert.equal((await controller('POST', `/api/waiting-guests/${a.id}/assign-room`, { roomNumber: roomNo })).status, 200);
  assert.equal((await controller('POST', `/api/waiting-guests/${b.id}/assign-room`, { roomNumber: roomNo })).status, 409);
  const page = await anon('GET', '/controller');
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login');
});
