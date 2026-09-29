'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('reception','rooms_controller')),
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);

-- Mock reservation source. In future replaced by an Opera adapter
-- (see server/providers/reservations.js); nothing else reads this table.
CREATE TABLE IF NOT EXISTS reservations (
  confirmation_no TEXT PRIMARY KEY,
  guest_name TEXT NOT NULL,
  arrival_date TEXT NOT NULL,
  arrival_time TEXT,
  departure_date TEXT NOT NULL,
  room_type TEXT NOT NULL,
  adults INTEGER NOT NULL,
  children INTEGER NOT NULL DEFAULT 0,
  phone TEXT,
  email TEXT,
  nights INTEGER,
  rate_plan TEXT,
  meal_plan TEXT,
  nationality TEXT,
  vip_code TEXT,
  special_requests TEXT
);

-- Mock room inventory (see server/providers/rooms.js).
CREATE TABLE IF NOT EXISTS rooms (
  room_number TEXT PRIMARY KEY,
  building TEXT NOT NULL,
  floor TEXT NOT NULL,
  room_type TEXT NOT NULL,
  hk_status TEXT NOT NULL CHECK (hk_status IN ('clean','inspected','dirty','out_of_order'))
);

-- The single source of truth. Reception, Rooms Controller and the guest QR
-- page all read and write this one row.
CREATE TABLE IF NOT EXISTS waiting_guests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wg_number TEXT NOT NULL UNIQUE,
  qr_token TEXT NOT NULL UNIQUE,
  -- reservation snapshot at creation time
  confirmation_no TEXT NOT NULL,
  guest_name TEXT NOT NULL,
  arrival_date TEXT NOT NULL,
  arrival_time TEXT,
  departure_date TEXT NOT NULL,
  room_type TEXT NOT NULL,
  adults INTEGER NOT NULL,
  children INTEGER NOT NULL DEFAULT 0,
  phone TEXT,
  email TEXT,
  -- operational, entered by Reception
  luggage_tag TEXT,
  associate TEXT,
  preferences TEXT,
  remarks TEXT,
  -- operational, managed by Rooms Controller
  room_number TEXT REFERENCES rooms(room_number),
  status TEXT NOT NULL CHECK (status IN ('waiting','room_assigned','preparing','ready','returned','completed')),
  priority INTEGER NOT NULL DEFAULT 0,
  -- timestamps (ISO 8601 UTC)
  guest_arrival_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  room_assigned_at TEXT,
  preparation_started_at TEXT,
  room_ready_at TEXT,
  guest_notified_at TEXT,
  guest_returned_at TEXT,
  completed_at TEXT,
  created_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_wg_status ON waiting_guests(status);
CREATE INDEX IF NOT EXISTS idx_wg_conf ON waiting_guests(confirmation_no);

CREATE TABLE IF NOT EXISTS status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  waiting_guest_id INTEGER NOT NULL REFERENCES waiting_guests(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  room_number TEXT,
  changed_at TEXT NOT NULL,
  changed_by INTEGER REFERENCES users(id),
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_hist_wg ON status_history(waiting_guest_id);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
`;

function open(file = config.dbFile) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

/** Run fn inside a transaction; rolls back on throw. */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { open, tx };
