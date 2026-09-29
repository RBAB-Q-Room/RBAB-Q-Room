'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { open } = require('./db');
const { createUser } = require('./auth');

const TYPES = require('./roomTypes');

const iso = (offsetDays) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

// Mock data only. Names and numbers are fictional.
const RESERVATIONS = [
  ['51840217', 'Hassan Al Mansoori', '10:40', 4, 'KGAOV', 2, 0, '+971 50 555 0142', 'h.almansoori@example.com', 'Bed & Breakfast', 'AE', null, 'Quiet room if possible'],
  ['51840233', 'Emily Carter', '11:15', 7, 'SKC', 2, 2, '+44 7700 900123', 'emily.carter@example.com', 'All Inclusive', 'GB', null, 'Cot required'],
  ['51840251', 'Dmitri Volkov', '09:55', 5, 'KGEOV', 2, 0, '+7 900 555 01 17', 'd.volkov@example.com', 'All Inclusive', 'RU', 'VIP1', 'Anniversary stay'],
  ['51840268', 'Priya Nair', '12:05', 3, 'TWA', 2, 0, '+91 98450 55021', 'priya.nair@example.com', 'Half Board', 'IN', null, null],
  ['51840274', 'Jonas Becker', '10:10', 6, 'KGA', 1, 0, '+49 151 5550 1188', 'jonas.becker@example.com', 'All Inclusive', 'DE', null, 'Late arrival flight expected'],
  ['51840291', 'Fatima Al Zaabi', '13:20', 2, 'SKD', 2, 1, '+971 55 555 0186', 'fatima.alzaabi@example.com', 'Bed & Breakfast', 'AE', 'VIP2', 'Connecting room requested'],
  ['51840305', 'Marco Rossi', '11:50', 5, 'TWAOV', 2, 0, '+39 333 555 0109', 'marco.rossi@example.com', 'All Inclusive', 'IT', null, 'High floor'],
  ['51840312', 'Aisha Khan', '10:25', 7, 'SKB', 2, 3, '+92 300 5550 144', 'aisha.khan@example.com', 'All Inclusive', 'PK', null, 'Family with young children'],
  ['51840329', 'Oliver Smith', '14:00', 3, 'KGE', 2, 0, '+44 7700 900456', 'oliver.smith@example.com', 'Half Board', 'GB', null, null],
  ['51840346', 'Chen Wei', '12:40', 4, 'KGEOV', 2, 0, '+86 138 0013 8000', 'chen.wei@example.com', 'All Inclusive', 'CN', null, 'Non-smoking'],
  ['51840358', 'Sofia Lindqvist', '09:30', 8, 'KGAOV', 2, 1, '+46 70 555 01 63', 'sofia.lindqvist@example.com', 'All Inclusive', 'SE', null, null],
  ['51840371', 'Omar Haddad', '15:10', 2, 'SKC', 2, 2, '+962 79 555 0170', 'omar.haddad@example.com', 'Bed & Breakfast', 'JO', null, 'Adjoining rooms if available'],
];

function roomList() {
  // Small mock inventory, spread over the three buildings.
  const plan = [
    ['zumroud', '10', ['KGA', 'KGAOV', 'KGE', 'KGEOV', 'TWA']],
    ['zumroud', '11', ['KGA', 'KGAOV', 'KGE', 'KGEOV', 'TWAOV']],
    ['zumroud', '12', ['KGA', 'KGAOV', 'KGE', 'KGEOV', 'TWA']],
    ['amwaj', '21', ['KGA', 'KGAOV', 'SKB', 'SKC', 'TWA']],
    ['amwaj', '22', ['KGE', 'KGEOV', 'SKB', 'SKC', 'TWAOV']],
    ['marmar', '31', ['KGAOV', 'KGEOV', 'SKC', 'SKD', 'TWAOV']],
    ['marmar', '32', ['KGA', 'KGE', 'SKB', 'SKD', 'TWA']],
  ];
  const hk = ['clean', 'inspected', 'clean', 'dirty', 'clean', 'inspected', 'dirty', 'clean'];
  const out = [];
  let i = 0;
  for (const [building, floorNo, types] of plan) {
    types.forEach((type, idx) => {
      const status = i % 23 === 7 ? 'out_of_order' : hk[i % hk.length];
      out.push([`${floorNo}${String(idx + 1).padStart(2, '0')}`, building, floorNo, type, status]);
      i++;
    });
  }
  return out;
}

function seed(db, { reset = false, quiet = false } = {}) {
  if (reset) {
    for (const t of ['status_history', 'waiting_guests', 'sessions', 'users', 'reservations', 'rooms', 'counters'])
      db.exec(`DELETE FROM ${t}`);
  }
  const creds = [];
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
    const shared = process.env.WG_DEV_PASSWORD;
    for (const [username, displayName, role] of [
      ['reception', 'Reception Desk', 'reception'],
      ['controller', 'Rooms Controller', 'rooms_controller'],
    ]) {
      // No password is stored in the repo. Random per database unless overridden.
      const password = shared || crypto.randomBytes(9).toString('base64url');
      createUser(db, { username, displayName, role, password });
      creds.push({ username, role, password });
    }
  }
  const insRes = db.prepare(
    `INSERT OR REPLACE INTO reservations (confirmation_no, guest_name, arrival_date, arrival_time, departure_date, room_type,
       adults, children, phone, email, nights, rate_plan, meal_plan, nationality, vip_code, special_requests)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const [no, name, time, nights, type, ad, ch, phone, email, meal, nat, vip, req] of RESERVATIONS) {
    insRes.run(no, name, iso(0), time, iso(nights), type, ad, ch, phone, email, nights, 'Mock rate', meal, nat, vip, req);
  }
  const insRoom = db.prepare('INSERT OR IGNORE INTO rooms (room_number, building, floor, room_type, hk_status) VALUES (?,?,?,?,?)');
  for (const r of roomList()) insRoom.run(...r);

  if (creds.length && !quiet) {
    const lines = ['Development logins (mock data, generated for this database):', ...creds.map((c) => `  ${c.role.padEnd(17)} ${c.username} / ${c.password}`)];
    console.log(lines.join('\n'));
    try {
      fs.writeFileSync(path.join(path.dirname(config.dbFile), 'dev-credentials.txt'), lines.join('\n') + '\n', { mode: 0o600 });
    } catch { /* non-fatal */ }
  }
  return creds;
}

module.exports = { seed, TYPES };

if (require.main === module) {
  const db = open();
  seed(db, { reset: process.argv.includes('--reset') });
  console.log('Seeded mock reservations and rooms.');
}
