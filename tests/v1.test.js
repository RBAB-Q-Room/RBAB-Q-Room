'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { boot, createGuest } = require('./helpers');

const seen = (t, token) => t.b.call('', 'GET', `/api/guest/${token}?seen=1`);
const toReady = (t, wg) => {
  const room = t.ctl('GET', `/api/waiting-guests/${wg.id}`).body.rooms[0].roomNumber;
  t.ctl('POST', `/api/waiting-guests/${wg.id}/assign-room`, { roomNumber: room });
  t.ctl('POST', `/api/waiting-guests/${wg.id}/status`, { status: 'ready' });
  return room;
};

test('guest engagement is recorded from real page views only, once each', () => {
  const t = boot();
  const { wg, token } = createGuest(t);
  // fetching without seen=1 (e.g. a link preview) records nothing
  t.guest(token);
  let g = t.rec('GET', `/api/waiting-guests/${wg.id}`).body.waitingGuest;
  assert.equal(g.timestamps.qrOpened, '');
  assert.equal(seen(t, token).status, 200);
  g = t.rec('GET', `/api/waiting-guests/${wg.id}`).body.waitingGuest;
  assert.match(g.timestamps.qrOpened, /^\d{4}-/);
  assert.equal(g.timestamps.guestSawReady, '', 'not ready yet, so not "seen ready"');
  const first = g.timestamps.qrOpened;
  toReady(t, wg);
  seen(t, token); seen(t, token);
  g = t.rec('GET', `/api/waiting-guests/${wg.id}`).body.waitingGuest;
  assert.equal(g.timestamps.qrOpened, first, 'first opening is never overwritten');
  assert.match(g.timestamps.guestSawReady, /^\d{4}-/);
  const m = t.adm('GET', '/api/metrics?range=today').body;
  assert.equal(m.readyCount, 1);
  assert.equal(m.awareCount, 1);
  assert.equal(typeof m.avgAwarenessSec, 'number');
  assert.equal(m.qrOpened, 1);
});

test('guest feedback: only after completion, once, validated', () => {
  const t = boot();
  const { wg, token } = createGuest(t);
  const fb = (b) => t.b.call('', 'POST', `/api/guest/${token}/feedback`, b);
  assert.equal(fb({ rating: 5 }).status, 409, 'not before check-in is complete');
  toReady(t, wg);
  t.rec('POST', `/api/waiting-guests/${wg.id}/status`, { status: 'completed' });
  assert.equal(t.guest(token).body.waitingGuest.canGiveFeedback, true);
  assert.equal(fb({ rating: 0 }).status, 400);
  assert.equal(fb({ rating: 9 }).status, 400);
  assert.equal(fb({ rating: 4, helpful: 'yes' }).status, 200);
  assert.equal(fb({ rating: 1 }).status, 409, 'only once');
  assert.equal(t.guest(token).body.waitingGuest.canGiveFeedback, false);
  assert.deepEqual(t.rec('GET', `/api/waiting-guests/${wg.id}`).body.waitingGuest.feedback.rating, 4);
  const m = t.adm('GET', '/api/metrics').body;
  assert.equal(m.feedbackCount, 1); assert.equal(m.avgRating, 4); assert.equal(m.helpfulYes, 1);
  assert.equal(t.b.call('', 'POST', `/api/guest/${'b'.repeat(64)}/feedback`, { rating: 5 }).status, 404);
});

test('guest links expire after completion and then reveal nothing personal', () => {
  const t = boot();
  const { wg, token } = createGuest(t);
  toReady(t, wg);
  t.rec('POST', `/api/waiting-guests/${wg.id}/status`, { status: 'completed' });
  assert.equal(t.guest(token).body.waitingGuest.phase, 'completed');
  const S = t.b.ev('Store');
  S.update('WaitingGuests', S.find('WaitingGuests', 'id', wg.id)._row, { completed_at: new Date(Date.now() - 25 * 3600e3).toISOString() });
  const r = t.guest(token).body;
  assert.equal(r.waitingGuest.phase, 'expired');
  assert.equal(r.content, null);
  assert.ok(!JSON.stringify(r).includes('Mansoori') && !JSON.stringify(r).includes('51840217'), 'no name or confirmation after expiry');
  assert.equal(t.b.call('', 'POST', `/api/guest/${token}/feedback`, { rating: 5 }).status, 404);
});

test('search is forgiving: name words any order, accents, WG number forms, room, luggage tag', () => {
  const t = boot();
  const { wg } = createGuest(t, '51840217', { luggageTag: 'T-4471' });
  const room = toReady(t, wg);
  const ids = (q) => t.rec('GET', '/api/search?q=' + encodeURIComponent(q)).body.waitingGuests.map((g) => g.id);
  for (const q of ['mansoori hassan', 'HASSAN', 'Mansoorí', wg.wgNumber, 'wg 1', 'WG-0001', '0001', '1', room, 't4471', 'T-4471', '518402']) {
    assert.deepEqual(ids(q), [wg.id], `"${q}" finds the guest`);
  }
  assert.deepEqual(ids('zz'), []);
  // arrivals can be found by name before a Waiting Guest exists
  const res = t.rec('GET', '/api/search?q=carter').body.reservations;
  assert.equal(res[0].confirmationNo, '51840233');
});

test('VIP, tags and measured creation time are captured and editable', () => {
  const t = boot();
  const vip = createGuest(t, '51840251', { tags: ['occasion', 'bogus', 'accessibility', 'occasion'], createSeconds: 37 }).wg;
  assert.equal(vip.vipCode, 'VIP1');
  assert.deepEqual(vip.tags, ['occasion', 'accessibility']);
  assert.equal(vip.createSeconds, 37);
  const odd = createGuest(t, '51840217', { createSeconds: 99999 }).wg;
  assert.equal(odd.createSeconds, null, 'implausible timings are not recorded');
  const edited = t.rec('POST', `/api/waiting-guests/${vip.id}/details`, { associate: 'A', tags: ['accessibility'] }).body.waitingGuest;
  assert.deepEqual(edited.tags, ['accessibility']);
  assert.equal(t.adm('GET', '/api/metrics').body.avgCreateSec, 37);
  // the guest never sees VIP or tags
  const tok = t.rec('GET', `/api/waiting-guests/${vip.id}/qr`).body.url.split('t=')[1];
  assert.ok(!/VIP|occasion|accessib/i.test(JSON.stringify(t.guest(tok).body.waitingGuest)));
});

test('metrics are per hotel day with an hourly profile, and cancelled records are excluded', () => {
  const t = boot();
  createGuest(t, '51840217'); const b = createGuest(t, '51840233').wg;
  t.rec('POST', `/api/waiting-guests/${b.id}/cancel`, { reason: 'Mistake' });
  const S = t.b.ev('Store');
  // one old record from 3 days ago
  const old = createGuest(t, '51840251').wg;
  S.update('WaitingGuests', S.find('WaitingGuests', 'id', old.id)._row, { created_at: new Date(Date.now() - 3 * 86400e3).toISOString() });
  const today = t.adm('GET', '/api/metrics?range=today').body;
  assert.equal(today.created, 1); assert.equal(today.cancelled, 1);
  assert.equal(today.hourly.length, 24);
  assert.equal(today.hourly.reduce((a, x) => a + x, 0), 1);
  const week = t.adm('GET', '/api/metrics?range=7d').body;
  assert.equal(week.created, 2);
  assert.equal(week.daily.length, 7);
  assert.equal(week.daily.reduce((a, d) => a + d.count, 0), 2);
  assert.equal(today.active, 2, 'live figures are "right now", not ranged');
});

test('admin settings: validated, audited, applied; other roles refused', () => {
  const t = boot();
  const cur = t.adm('GET', '/api/admin/settings').body;
  assert.equal(cur.values.bc_waiting_pct, '65');
  assert.equal(cur.placeholders, 7);
  assert.equal(t.rec('GET', '/api/admin/settings').status, 403);
  const bad = (values) => t.adm('POST', '/api/admin/settings', { values });
  assert.equal(bad({ hotel_website_url: 'javascript:alert(1)' }).status, 400);
  assert.equal(bad({ late_warn_minutes: '45', late_alert_minutes: '30' }).status, 400, 'long wait must exceed attention');
  assert.equal(bad({ wg_prefix: 'WG1' }).status, 400);
  assert.equal(bad({ bc_waiting_pct: '140' }).status, 400);
  assert.equal(bad({ hotel_name: '' }).status, 400);
  const ok = t.adm('POST', '/api/admin/settings', { values: { hotel_website_url: 'https://example.com', late_warn_minutes: '20', bc_print_cost: '0.5', bc_manual_minutes: '', wg_prefix: 'rb', unknown_key: 'x', guest_show_placeholders: '0' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.values.wg_prefix, 'RB');
  assert.equal(t.rec('GET', '/api/meta').body.lateWarnMinutes, 20);
  assert.ok(!t.b.ev('Store').find('Config', 'key', 'unknown_key'), 'unknown keys are ignored');
  assert.equal(createGuest(t).wg.wgNumber, 'RB-0001');
  // placeholders hidden from guests when switched off
  const { token } = createGuest(t, '51840233');
  assert.equal(t.guest(token).body.content.sections.length, 0);
  assert.equal(t.guest(token).body.content.links.website.url, 'https://example.com');
  assert.ok(t.b.ev('Store').all('Audit').some((a) => a.action === 'settings.save'));
});

test('admin edits guest-page content in four languages; guests see it immediately', () => {
  const t = boot();
  const { token } = createGuest(t);
  assert.equal(t.rec('POST', '/api/admin/guest-content', { id: 'pools' }).status, 403);
  assert.equal(t.adm('POST', '/api/admin/guest-content', { id: 'nope', title: 'x' }).status, 404);
  assert.equal(t.adm('POST', '/api/admin/guest-content', { id: 'pools', title: '' }).status, 400);
  const r = t.adm('POST', '/api/admin/guest-content', { id: 'pools', body: 'Main pool open to all guests.', body_ar: 'المسبح الرئيسي', highlight: 'Aqua gym 16:00 at the main pool', placeholder: false, extra: 'ignored' });
  assert.equal(r.status, 200);
  const pools = t.guest(token).body.content.sections.find((s) => s.id === 'pools');
  assert.equal(pools.body.en, 'Main pool open to all guests.');
  assert.equal(pools.body.ar, 'المسبح الرئيسي');
  assert.equal(pools.body.de, 'Main pool open to all guests.', 'blank translation falls back to English');
  assert.equal(pools.highlight.en, 'Aqua gym 16:00 at the main pool');
  assert.equal(pools.placeholder, false);
  t.adm('POST', '/api/admin/guest-content', { id: 'pools', active: false });
  assert.ok(!t.guest(token).body.content.sections.some((s) => s.id === 'pools'), 'hidden sections disappear');
});

test('doGet pre-renders the guest status into the page, and nothing for staff', () => {
  const { loadBackend } = require('../dev/backend');
  const DIST = path.join(__dirname, '..', 'dist', 'apps-script', 'Index.html');
  const t = boot();
  const { token } = createGuest(t);
  const b = t.b;
  b.google.globals.HtmlService.createTemplateFromFile = loadBackend({ htmlFile: DIST }).ctx.HtmlService.createTemplateFromFile;
  const page = b.ctx.doGet({ parameter: { t: token } }).getContent();
  const m = page.match(/window\.WG_BOOT = (\{.*?\});<\/script>/s);
  const data = JSON.parse(m[1]);
  assert.equal(data.mode, 'guest');
  assert.equal(data.data.waitingGuest.phase, 'received');
  assert.ok(!page.includes('+971'), 'guest-safe fields only');
  const staff = JSON.parse(b.ctx.doGet({ parameter: {} }).getContent().match(/window\.WG_BOOT = (\{.*?\});<\/script>/s)[1]);
  assert.equal(staff.data, null);
  const bad = JSON.parse(b.ctx.doGet({ parameter: { t: 'c'.repeat(64) } }).getContent().match(/window\.WG_BOOT = (\{.*?\});<\/script>/s)[1]);
  assert.equal(bad.data, null, 'unknown token: no data, page shows "not valid"');
  // pre-render does not count as the guest viewing the page
  assert.equal(t.rec('GET', '/api/waiting-guests').body.active[0].timestamps.qrOpened, '');
});
