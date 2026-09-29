'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');

const HEADER = 'Confirmation Number,Guest Name,Arrival,Departure,Room Type,Adults,Children,Phone,Email';

test('date and time parsing (day first, several formats, real dates only)', () => {
  const t = boot({ demo: false });
  const d = t.b.ev('parseDateText_'), tm = t.b.ev('parseTimeText_');
  assert.equal(d('2026-09-29'), '2026-09-29');
  assert.equal(d('29/09/2026'), '2026-09-29');
  assert.equal(d('29-09-2026'), '2026-09-29');
  assert.equal(d('29.09.26'), '2026-09-29');
  assert.equal(d('5/1/2026'), '2026-01-05', 'day first');
  assert.equal(d('29-Sep-2026'), '2026-09-29');
  assert.equal(d('29 September 2026'), '2026-09-29');
  assert.equal(d('1 Sept 2026'), '2026-09-01');
  assert.equal(d('2026-09-29T10:00:00Z'), '2026-09-29');
  assert.equal(d('46294'), '2026-09-29', 'Excel serial');
  assert.equal(d('31/02/2026'), null);
  assert.equal(d('13/13/2026'), null);
  assert.equal(d('2026-02-30'), null);
  assert.equal(d('tomorrow'), null);
  assert.equal(d(''), null);
  assert.equal(tm('10:40'), '10:40'); assert.equal(tm('9:05'), '09:05'); assert.equal(tm('10:40:59'), '10:40');
  assert.equal(tm('1:15 PM'), '13:15'); assert.equal(tm('12:00 AM'), '00:00'); assert.equal(tm('12:30pm'), '12:30');
  assert.equal(tm(''), ''); assert.equal(tm('25:00'), null); assert.equal(tm('10:75'), null); assert.equal(tm('soon'), null);
});

test('CSV parsing: quotes, embedded commas and newlines, BOM, semicolons, tabs, CRLF', () => {
  const t = boot({ demo: false });
  const parse = t.b.ev('Csv').parse;
  assert.deepEqual(JSON.parse(JSON.stringify(parse('a,b\r\n"x, y","he said ""hi"""\r\n'))), [['a', 'b'], ['x, y', 'he said "hi"']]);
  assert.deepEqual(JSON.parse(JSON.stringify(parse('a,b\n"line1\nline2",z'))), [['a', 'b'], ['line1\nline2', 'z']]);
  assert.deepEqual(JSON.parse(JSON.stringify(parse('﻿a;b\n1;2'))), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(JSON.parse(JSON.stringify(parse('a\tb\n1\t2'))), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(JSON.parse(JSON.stringify(parse('a,b\n\n,\n1,2\n'))), [['a', 'b'], ['1', '2']], 'blank lines ignored');
});

test('arrivals import: preview finds the header under title rows, reports errors with line numbers, saves nothing', () => {
  const t = boot({ demo: false });
  const csv = ['Arrivals,,,,,,,,', 'Rixos Bab Al Bahr,,,,,,,,', HEADER,
    '80000001,"Al Farsi, Khalid",29/09/2026,02/10/2026,KGA,2,0,0501234567,k@example.com',
    '80000002,Anna Weber,29-Sep-2026,03-Oct-2026,SKC,2,2,,',
    '80000003,Bad Date,31/02/2026,01/03/2026,KGA,2,0,,',
    '80000004,,29/09/2026,30/09/2026,KGA,2,0,,',
    '80000005,No Adults,29/09/2026,30/09/2026,KGA,,0,,',
    '80000006,Backwards,05/10/2026,01/10/2026,KGA,2,0,,',
    '80000007,Weird Type,29/09/2026,30/09/2026,ZZZ,2,0,,',
    '80000001,Duplicate Row,29/09/2026,30/09/2026,KGA,2,0,,'].join('\n');
  const p = t.adm('POST', '/api/import/arrivals/preview', { csv });
  assert.equal(p.status, 200);
  assert.equal(p.body.headerLine, 3);
  assert.deepEqual(p.body.missing, []);
  assert.equal(p.body.validCount, 4);
  assert.equal(p.body.errorCount, 4);
  const lines = p.body.errors.map((e) => e.line);
  assert.deepEqual(lines, [6, 7, 8, 9]);
  assert.match(p.body.errors[0].message, /arrival date not understood/);
  assert.match(p.body.errors[2].message, /adults/);
  assert.match(p.body.errors[3].message, /before arrival/);
  assert.ok(p.body.warnings.some((w) => /duplicate confirmation 80000001/.test(w.message)));
  assert.ok(p.body.warnings.some((w) => /"ZZZ"/.test(w.message)));
  assert.equal(t.b.ev('Store').all('Reservations').length, 0, 'preview saves nothing');
  // errors block a plain commit but allowErrors imports the valid rows
  assert.equal(t.adm('POST', '/api/import/arrivals', { csv }).status, 409);
  const c = t.adm('POST', '/api/import/arrivals', { csv, allowErrors: true });
  assert.deepEqual([c.body.added, c.body.updated, c.body.skipped], [3, 0, 4]);
  const kept = t.b.ev('Store').all('Reservations').find((r) => r.confirmation_no === '80000001');
  assert.equal(kept.guest_name, 'Duplicate Row', 'the later duplicate wins');
  // re-import updates instead of duplicating
  const again = t.adm('POST', '/api/import/arrivals', { csv, allowErrors: true });
  assert.deepEqual([again.body.added, again.body.updated], [0, 3]);
  assert.equal(t.b.ev('Store').all('Reservations').length, 3);
});

test('arrivals import: column mapping, manual override, missing columns, alternative headers', () => {
  const t = boot({ demo: false });
  const csv = 'Res No;Name;Arr;Dep;RT;Adl;Chd\n900;Test Guest;29/09/2026;01/10/2026;KGA;2;1';
  const p = t.adm('POST', '/api/import/arrivals/preview', { csv });
  assert.equal(p.body.validCount, 1, 'semicolon file with abbreviated headers is understood');
  assert.equal(p.body.sample[0].children, 1);
  assert.equal(p.body.sample[0].nights, 2);
  const bad = 'Reference,Who,From,To,Category,People\nX1,A,29/09/2026,01/10/2026,KGA,2';
  const b = t.adm('POST', '/api/import/arrivals/preview', { csv: bad }).body;
  assert.ok(b.missing.includes('confirmation_no') && b.missing.includes('guest_name'));
  assert.equal(t.adm('POST', '/api/import/arrivals', { csv: bad }).status, 400);
  const map = { confirmation_no: 0, guest_name: 1, arrival_date: 2, departure_date: 3, room_type: 4, adults: 5 };
  const fixed = t.adm('POST', '/api/import/arrivals/preview', { csv: bad, map }).body;
  assert.deepEqual(fixed.missing, []);
  assert.equal(fixed.validCount, 1);
  assert.equal(t.adm('POST', '/api/import/arrivals', { csv: bad, map }).status, 200);
  assert.equal(t.rec('GET', '/api/search?q=X1').body.reservations[0].guestName, 'A');
});

test('arrivals import: limits and replace-all', () => {
  const t = boot({ demo: false });
  assert.equal(t.adm('POST', '/api/import/arrivals/preview', { csv: '' }).status, 400);
  assert.equal(t.adm('POST', '/api/import/arrivals/preview', { csv: 'x'.repeat(2_100_000) }).status, 413);
  const rows = ['Confirmation Number,Guest Name,Arrival,Departure,Room Type,Adults'];
  for (let i = 0; i < 5001; i++) rows.push(`C${i},G,29/09/2026,30/09/2026,KGA,2`);
  assert.equal(t.adm('POST', '/api/import/arrivals/preview', { csv: rows.join('\n') }).status, 413);
  const a = 'Confirmation Number,Guest Name,Arrival,Departure,Room Type,Adults\nA1,One,29/09/2026,30/09/2026,KGA,2\nA2,Two,29/09/2026,30/09/2026,KGA,2';
  t.adm('POST', '/api/import/arrivals', { csv: a });
  const b = 'Confirmation Number,Guest Name,Arrival,Departure,Room Type,Adults\nB1,Three,29/09/2026,30/09/2026,KGA,2';
  t.adm('POST', '/api/import/arrivals', { csv: b, replaceAll: true });
  assert.deepEqual(JSON.parse(JSON.stringify(t.b.ev('Store').all('Reservations').map((r) => r.confirmation_no))), ['B1']);
});

test('importing does not disturb Waiting Guests that already exist', () => {
  const t = boot();
  const created = t.rec('POST', '/api/waiting-guests', { confirmationNo: '51840217', associate: 'A' }).body.waitingGuest;
  const csv = 'Confirmation Number,Guest Name,Arrival,Departure,Room Type,Adults\n51840217,Changed Name,29/09/2026,30/09/2026,SKD,3';
  t.adm('POST', '/api/import/arrivals', { csv, replaceAll: true });
  const still = t.rec('GET', `/api/waiting-guests/${created.id}`).body.waitingGuest;
  assert.equal(still.guestName, 'Hassan Al Mansoori', 'the Waiting Guest keeps its snapshot of the reservation');
  assert.equal(still.roomType, 'KGAOV');
});

test('rooms import: housekeeping status names, validation, room types added', () => {
  const t = boot({ demo: false });
  const csv = ['Room,Type,Building,Floor,HK Status', '1001,KGA,Zumroud,10,VC', '1002,KGA,Zumroud,10,Dirty', '1003,NEW,Zumroud,10,OOO', '1004,KGA,Zumroud,10,Inspected', 'bad room!,KGA,,,', '1005,KGA,,,mystery'].join('\n');
  const p = t.adm('POST', '/api/import/rooms/preview', { csv });
  assert.equal(p.body.validCount, 4); assert.equal(p.body.errorCount, 2);
  assert.equal(t.adm('POST', '/api/import/rooms', { csv }).status, 409);
  const c = t.adm('POST', '/api/import/rooms', { csv, allowErrors: true });
  assert.equal(c.body.added, 4);
  const rooms = t.b.ev('Store').all('Rooms');
  assert.deepEqual(JSON.parse(JSON.stringify(rooms.map((r) => r.hk_status))), ['clean', 'dirty', 'out_of_order', 'inspected']);
  assert.ok(t.b.ev('Store').all('RoomTypes').some((r) => r.code === 'NEW'), 'unknown room type gets an entry');
  t.adm('POST', '/api/import/rooms', { csv: 'Room Number,Room Type,HK Status\n1001,KGA,Dirty' });
  assert.equal(t.b.ev('Store').all('Rooms').find((r) => r.room_number === '1001').hk_status, 'dirty', 'existing room updated');
});

test('export contains every timestamp for later analysis', () => {
  const t = boot();
  const g = t.rec('POST', '/api/waiting-guests', { confirmationNo: '51840217', associate: 'A' }).body.waitingGuest;
  const room = t.ctl('GET', `/api/waiting-guests/${g.id}`).body.rooms[0].roomNumber;
  t.ctl('POST', `/api/waiting-guests/${g.id}/assign-room`, { roomNumber: room });
  t.ctl('POST', `/api/waiting-guests/${g.id}/status`, { status: 'preparing' });
  t.ctl('POST', `/api/waiting-guests/${g.id}/status`, { status: 'ready' });
  t.rec('POST', `/api/waiting-guests/${g.id}/status`, { status: 'completed' });
  const lines = t.adm('GET', '/api/export/waiting-guests').body.csv.split('\r\n');
  const head = lines[0].split(',');
  for (const col of ['guest_arrival_at', 'created_at', 'room_assigned_at', 'preparation_started_at', 'room_ready_at', 'guest_notified_at', 'guest_returned_at', 'completed_at']) assert.ok(head.includes(col), col);
  const row = lines[1].split(',');
  for (const col of ['created_at', 'room_assigned_at', 'preparation_started_at', 'room_ready_at', 'guest_notified_at', 'guest_returned_at', 'completed_at']) assert.match(row[head.indexOf(col)], /^\d{4}-\d{2}-\d{2}T/, col);
});
