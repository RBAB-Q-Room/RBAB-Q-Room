'use strict';
const crypto = require('node:crypto');
const config = require('./config');
const { tx } = require('./db');
const bus = require('./bus');

const STATUSES = ['waiting', 'room_assigned', 'preparing', 'ready', 'returned', 'completed'];
const ACTIVE = STATUSES.slice(0, 5);

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Which role may move a guest INTO which status, and from where.
const TRANSITIONS = {
  preparing: { role: 'rooms_controller', from: ['room_assigned'] },
  ready: { role: 'rooms_controller', from: ['room_assigned', 'preparing'] },
  returned: { role: 'reception', from: ['ready'] },
  completed: { role: 'reception', from: ['ready', 'returned'] },
};

const TS_COLUMN = {
  room_assigned: 'room_assigned_at',
  preparing: 'preparation_started_at',
  ready: 'room_ready_at',
  returned: 'guest_returned_at',
  completed: 'completed_at',
};

const clean = (v, max) => {
  if (v == null) return null;
  const s = String(v).trim().slice(0, max);
  return s || null;
};

function toStaff(r) {
  return {
    id: r.id,
    wgNumber: r.wg_number,
    qrToken: r.qr_token,
    guestUrlPath: `/waiting/${r.qr_token}`,
    confirmationNo: r.confirmation_no,
    guestName: r.guest_name,
    arrivalDate: r.arrival_date,
    arrivalTime: r.arrival_time,
    departureDate: r.departure_date,
    roomType: r.room_type,
    adults: r.adults,
    children: r.children,
    phone: r.phone,
    email: r.email,
    luggageTag: r.luggage_tag,
    associate: r.associate,
    preferences: r.preferences,
    remarks: r.remarks,
    roomNumber: r.room_number,
    status: r.status,
    priority: !!r.priority,
    timestamps: {
      guestArrival: r.guest_arrival_at,
      created: r.created_at,
      roomAssigned: r.room_assigned_at,
      preparationStarted: r.preparation_started_at,
      roomReady: r.room_ready_at,
      guestNotified: r.guest_notified_at,
      guestReturned: r.guest_returned_at,
      completed: r.completed_at,
    },
  };
}

function createWaitingService(db, { reservations, rooms }) {
  const q = (sql, ...p) => db.prepare(sql).all(...p);
  const one = (sql, ...p) => db.prepare(sql).get(...p);

  const byId = (id) => one('SELECT * FROM waiting_guests WHERE id = ?', id);
  const must = (id) => {
    const r = byId(id);
    if (!r) throw new HttpError(404, 'Waiting Guest not found');
    return r;
  };

  function nextNumber() {
    const row = one("SELECT value FROM counters WHERE name = 'wg'");
    const v = (row ? row.value : 0) + 1;
    db.prepare("INSERT INTO counters (name, value) VALUES ('wg', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value").run(v);
    return `${config.wgPrefix}-${String(v).padStart(config.wgPad, '0')}`;
  }

  function log(id, from, to, room, user, note) {
    db.prepare(
      'INSERT INTO status_history (waiting_guest_id, from_status, to_status, room_number, changed_at, changed_by, note) VALUES (?,?,?,?,?,?,?)'
    ).run(id, from, to, room, new Date().toISOString(), user ? user.id : null, note || null);
  }

  function changed(row, kind) {
    bus.emit('change', { kind, id: row.id, token: row.qr_token, wgNumber: row.wg_number });
  }

  function requireRole(user, role) {
    if (!user || user.role !== role) throw new HttpError(403, 'Not allowed for your role');
  }

  return {
    toStaff,

    create(user, confirmationNo, input = {}) {
      requireRole(user, 'reception');
      const res = reservations.findByConfirmation(confirmationNo);
      if (!res) throw new HttpError(404, 'Reservation not found');
      const associate = clean(input.associate, 80);
      if (!associate) throw new HttpError(400, 'Associate name is required', { field: 'associate' });

      const row = tx(db, () => {
        const existing = one(
          `SELECT * FROM waiting_guests WHERE confirmation_no = ? AND status != 'completed'`,
          res.confirmationNo
        );
        if (existing) {
          throw new HttpError(409, `${existing.wg_number} is already active for this reservation`, {
            waitingGuest: toStaff(existing),
          });
        }
        const now = new Date().toISOString();
        const info = db
          .prepare(
            `INSERT INTO waiting_guests (wg_number, qr_token, confirmation_no, guest_name, arrival_date, arrival_time,
               departure_date, room_type, adults, children, phone, email, luggage_tag, associate, preferences, remarks,
               status, guest_arrival_at, created_at, created_by)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'waiting', ?,?,?)`
          )
          .run(
            nextNumber(),
            crypto.randomBytes(24).toString('base64url'),
            res.confirmationNo, res.guestName, res.arrivalDate, res.arrivalTime, res.departureDate,
            res.roomType, res.adults, res.children, res.phone, res.email,
            clean(input.luggageTag, 40), associate, clean(input.preferences, 500), clean(input.remarks, 500),
            now, now, user.id
        );
        log(info.lastInsertRowid, null, 'waiting', null, user);
        return byId(info.lastInsertRowid);
      });
      changed(row, 'created');
      return toStaff(row);
    },

    get(id) {
      return toStaff(must(id));
    },

    history(id) {
      must(id);
      return q(
        `SELECT h.from_status, h.to_status, h.room_number, h.changed_at, h.note, u.display_name AS by
         FROM status_history h LEFT JOIN users u ON u.id = h.changed_by
         WHERE h.waiting_guest_id = ? ORDER BY h.id`,
        id
      ).map((h) => ({ from: h.from_status, to: h.to_status, roomNumber: h.room_number, at: h.changed_at, note: h.note, by: h.by }));
    },

    /** Active queue: priority first, then longest waiting. */
    queue({ includeCompleted = false } = {}) {
      const rows = includeCompleted
        ? q('SELECT * FROM waiting_guests ORDER BY (status = "completed"), priority DESC, created_at')
        : q(`SELECT * FROM waiting_guests WHERE status != 'completed' ORDER BY priority DESC, created_at`);
      return rows.map(toStaff);
    },

    recentCompleted(limit = 15) {
      return q(`SELECT * FROM waiting_guests WHERE status = 'completed' ORDER BY completed_at DESC LIMIT ?`, limit).map(toStaff);
    },

    /** Reception search: Confirmation Number, Guest Name or Waiting Guest Number. */
    search(term) {
      const t = String(term || '').trim().replace(/[%_]/g, '');
      if (t.length < 2) return { reservations: [], waitingGuests: [] };
      const like = `%${t}%`;
      const wgs = q(
        `SELECT * FROM waiting_guests WHERE confirmation_no LIKE ? OR guest_name LIKE ? OR wg_number LIKE ?
         ORDER BY (status = 'completed'), created_at DESC LIMIT 20`,
        `${t}%`, like, like
      ).map(toStaff);
      return { reservations: reservations.searchByConfirmation(t), waitingGuests: wgs };
    },

    /** Rooms the controller can pick from: not out of order, not held by another active guest. */
    availableRooms(forId) {
      const wg = must(forId);
      const held = new Set(
        q(`SELECT room_number FROM waiting_guests WHERE room_number IS NOT NULL AND status != 'completed' AND id != ?`, forId).map((r) => r.room_number)
      );
      return rooms
        .list()
        .filter((r) => r.hkStatus !== 'out_of_order' && !held.has(r.roomNumber))
        .map((r) => ({ ...r, matchesType: r.roomType === wg.room_type }))
        .sort((a, b) => Number(b.matchesType) - Number(a.matchesType) || a.roomNumber.localeCompare(b.roomNumber));
    },

    assignRoom(user, id, roomNumber) {
      requireRole(user, 'rooms_controller');
      const row = tx(db, () => {
        const wg = must(id);
        if (!['waiting', 'room_assigned', 'preparing'].includes(wg.status))
          throw new HttpError(409, 'Room can no longer be changed at this status');
        const room = rooms.get(roomNumber);
        if (!room) throw new HttpError(404, 'Room not found');
        if (room.hkStatus === 'out_of_order') throw new HttpError(409, 'Room is out of order');
        const clash = one(
          `SELECT wg_number FROM waiting_guests WHERE room_number = ? AND status != 'completed' AND id != ?`,
          room.roomNumber, id
        );
        if (clash) throw new HttpError(409, `Room ${room.roomNumber} is already held by ${clash.wg_number}`);
        const now = new Date().toISOString();
        const from = wg.status;
        const reassigned = wg.room_number && wg.room_number !== room.roomNumber;
        if (from === 'waiting') {
          db.prepare(`UPDATE waiting_guests SET room_number = ?, status = 'room_assigned', room_assigned_at = ? WHERE id = ?`).run(room.roomNumber, now, id);
        } else {
          db.prepare('UPDATE waiting_guests SET room_number = ? WHERE id = ?').run(room.roomNumber, id);
        }
        log(id, from, from === 'waiting' ? 'room_assigned' : from, room.roomNumber, user, reassigned ? `Room changed from ${wg.room_number}` : null);
        return byId(id);
      });
      changed(row, 'updated');
      return toStaff(row);
    },

    setStatus(user, id, to) {
      const rule = TRANSITIONS[to];
      if (!rule) throw new HttpError(400, 'Unknown or unsupported status');
      requireRole(user, rule.role);
      const row = tx(db, () => {
        const wg = must(id);
        if (!rule.from.includes(wg.status)) throw new HttpError(409, `Cannot move from ${wg.status} to ${to}`);
        if (to === 'ready' && !wg.room_number) throw new HttpError(409, 'Assign a room first');
        const now = new Date().toISOString();
        const sets = [`status = ?`, `${TS_COLUMN[to]} = ?`];
        const vals = [to, now];
        if (to === 'ready') { sets.push('guest_notified_at = ?'); vals.push(now); }
        if (to === 'completed' && !wg.guest_returned_at) {
          // Reception completing straight from Ready: guest is physically at the desk.
          sets.push('guest_returned_at = ?'); vals.push(now);
          log(id, wg.status, 'returned', wg.room_number, user, 'Recorded automatically on completion');
        }
        db.prepare(`UPDATE waiting_guests SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
        log(id, to === 'completed' && !wg.guest_returned_at ? 'returned' : wg.status, to, wg.room_number, user);
        return byId(id);
      });
      changed(row, 'updated');
      return toStaff(row);
    },

    setPriority(user, id, priority) {
      requireRole(user, 'rooms_controller');
      const wg = must(id);
      if (wg.status === 'completed') throw new HttpError(409, 'Already completed');
      db.prepare('UPDATE waiting_guests SET priority = ? WHERE id = ?').run(priority ? 1 : 0, id);
      log(id, wg.status, wg.status, wg.room_number, user, priority ? 'Priority on' : 'Priority off');
      const row = byId(id);
      changed(row, 'updated');
      return toStaff(row);
    },

    /**
     * What the guest may see. Deliberately excludes phone, email, associate,
     * luggage tag, remarks, preferences, room number, priority and internal ids.
     */
    guestView(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 64) return null;
      const r = one('SELECT * FROM waiting_guests WHERE qr_token = ?', token);
      if (!r) return null;
      const phase = r.status === 'completed' ? 'completed' : ['ready', 'returned'].includes(r.status) ? 'ready' : 'preparing';
      return {
        wgNumber: r.wg_number,
        guestName: r.guest_name,
        confirmationNo: r.confirmation_no,
        roomType: r.room_type,
        arrivalDate: r.arrival_date,
        arrivalTime: r.arrival_time,
        departureDate: r.departure_date,
        phase,
        readyAt: r.room_ready_at,
        completedAt: r.completed_at,
        updatedAt: new Date().toISOString(),
      };
    },

    /** Real, computed metrics only. Nothing here is estimated or fabricated. */
    metrics() {
      const rows = q('SELECT * FROM waiting_guests').map(toStaff);
      const active = rows.filter((r) => r.status !== 'completed');
      const done = rows.filter((r) => r.status === 'completed');
      const secs = (a, b) => (a && b ? (Date.parse(b) - Date.parse(a)) / 1000 : null);
      const avg = (xs) => {
        const v = xs.filter((x) => x != null);
        return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null;
      };
      const now = new Date().toISOString();
      return {
        total: rows.length,
        active: active.length,
        completed: done.length,
        avgWaitToReadySec: avg(rows.map((r) => secs(r.timestamps.created, r.timestamps.roomReady))),
        avgReadyToReturnSec: avg(rows.map((r) => secs(r.timestamps.roomReady, r.timestamps.guestReturned))),
        avgTotalSec: avg(done.map((r) => secs(r.timestamps.created, r.timestamps.completed))),
        longestActiveWaitSec: active.length ? Math.max(...active.filter((r) => r.status !== 'ready' && r.status !== 'returned').map((r) => secs(r.timestamps.created, now)), 0) : 0,
        readyAwaitingGuest: active.filter((r) => r.status === 'ready').length,
      };
    },
  };
}

module.exports = { createWaitingService, HttpError, STATUSES, ACTIVE };
