/* =====================================================================
 * Waiting Guest domain logic. One row per guest in the WaitingGuests tab
 * is the single source of truth for Reception, Rooms Controller and the
 * guest QR page. Every change is logged in StatusHistory and bumps the
 * version counter that screens poll.
 * ===================================================================== */

/**
 * Reservation source. The ONLY code that reads reservation data.
 * Today: the Reservations tab, filled by the arrivals-file import.
 * Later: an Opera Cloud adapter can implement the same two methods.
 */
const ReservationSource = {
  name: 'sheet-import',
  findByConfirmation: function (no) {
    const r = Store.find('Reservations', 'confirmation_no', String(no || '').trim());
    return r ? ReservationSource.shape(r) : null;
  },
  searchByConfirmation: function (prefix, limit) {
    const p = String(prefix || '').trim().toLowerCase();
    if (!p) return [];
    return Store.all('Reservations').filter(function (r) { return r.confirmation_no.toLowerCase().indexOf(p) === 0; }).slice(0, limit || 8).map(ReservationSource.shape);
  },
  shape: function (r) {
    return {
      confirmationNo: r.confirmation_no, guestName: r.guest_name, arrivalDate: r.arrival_date, arrivalTime: r.arrival_time,
      departureDate: r.departure_date, roomType: r.room_type, adults: r.adults, children: r.children, phone: r.phone, email: r.email,
      nights: r.nights, ratePlan: r.rate_plan, mealPlan: r.meal_plan, nationality: r.nationality, vipCode: r.vip_code, specialRequests: r.special_requests,
    };
  },
};

const Links = {
  base: function () {
    const override = Config.get('guest_base_url');
    if (override) return override;
    try { return ScriptApp.getService().getUrl(); } catch (e) { return ''; }
  },
  guestUrl: function (token) { return Links.base() + (Links.base().indexOf('?') === -1 ? '?' : '&') + 't=' + token; },
};

const Waiting = (function () {
  // Which role may move a guest INTO which status, and from where.
  const TRANSITIONS = {
    preparing: { roles: ['rooms_controller'], from: ['room_assigned'] },
    ready: { roles: ['rooms_controller'], from: ['room_assigned', 'preparing'] },
    returned: { roles: ['reception'], from: ['ready'] },
    completed: { roles: ['reception'], from: ['ready', 'returned'] },
  };
  const TS = { room_assigned: 'room_assigned_at', preparing: 'preparation_started_at', ready: 'room_ready_at', returned: 'guest_returned_at', completed: 'completed_at' };

  function role(user, roles) {
    if (!user || roles.indexOf(user.role) === -1) throw HttpError(403, 'Not allowed for your role');
  }

  function toStaff(r) {
    return {
      id: r.id, wgNumber: r.wg_number, source: r.source, confirmationNo: r.confirmation_no, guestName: r.guest_name,
      arrivalDate: r.arrival_date, arrivalTime: r.arrival_time, departureDate: r.departure_date, roomType: r.room_type,
      adults: r.adults, children: r.children, phone: r.phone, email: r.email,
      luggageTag: r.luggage_tag, associate: r.associate, preferences: r.preferences, remarks: r.remarks,
      roomNumber: r.room_number, status: r.status, priority: !!r.priority, cancelReason: r.cancel_reason,
      timestamps: {
        guestArrival: r.guest_arrival_at, created: r.created_at, roomAssigned: r.room_assigned_at, preparationStarted: r.preparation_started_at,
        roomReady: r.room_ready_at, guestNotified: r.guest_notified_at, guestReturned: r.guest_returned_at, completed: r.completed_at, cancelled: r.cancelled_at,
      },
    };
  }

  function counter(name) {
    const v = parseInt(Store.kvGet('Meta', name) || '0', 10) + 1;
    Store.kvSet('Meta', name, v);
    return v;
  }

  function log(id, from, to, room, user, note) {
    Store.insert('StatusHistory', { id: counter('history_counter'), waiting_guest_id: id, from_status: from || '', to_status: to, room_number: room || '', changed_at: nowIso(), changed_by: user ? user.id : '', note: note || '' });
  }

  function must(id) {
    const r = Store.find('WaitingGuests', 'id', id);
    if (!r) throw HttpError(404, 'Waiting Guest not found');
    return r;
  }

  function isActive(r) { return ACTIVE_STATUSES.indexOf(r.status) !== -1; }

  function validateManual(m, confirmationNo) {
    m = m || {};
    const errs = [];
    const name = clean(m.guestName, 120);
    const arr = parseDateText(m.arrivalDate);
    const dep = parseDateText(m.departureDate);
    const time = parseTimeText(m.arrivalTime);
    const type = clean(m.roomType, 20).toUpperCase();
    const adults = toInt(m.adults, 0);
    const children = toInt(m.children, 0);
    if (!/^[A-Za-z0-9\-\/]{1,30}$/.test(confirmationNo)) errs.push('Confirmation number is required');
    if (!name) errs.push('Guest name is required');
    if (!arr) errs.push('Arrival date is required');
    if (!dep) errs.push('Departure date is required');
    if (arr && dep && dep < arr) errs.push('Departure is before arrival');
    if (!type) errs.push('Room type is required');
    if (adults < 1 || adults > 20) errs.push('Adults must be 1 to 20');
    if (children < 0 || children > 20) errs.push('Children must be 0 to 20');
    if (time === null) errs.push('Arrival time is not valid');
    if (errs.length) throw HttpError(400, errs.join('. '), { fields: errs });
    return { confirmationNo: confirmationNo, guestName: name, arrivalDate: arr, arrivalTime: time || '', departureDate: dep, roomType: type, adults: adults, children: children, phone: clean(m.phone, 40), email: clean(m.email, 120) };
  }

  function create(user, confirmationNo, input) {
    role(user, ['reception']);
    input = input || {};
    const conf = clean(confirmationNo, 30);
    const associate = clean(input.associate, 80);
    if (!associate) throw HttpError(400, 'Associate name is required', { field: 'associate' });
    return Locks.run(function () {
      let res = ReservationSource.findByConfirmation(conf);
      let source = 'import';
      if (!res) {
        if (!input.manual) throw HttpError(404, 'Reservation not found');
        res = validateManual(input.manual, conf);
        source = 'manual';
      }
      const dup = Store.all('WaitingGuests').filter(function (r) { return r.confirmation_no === res.confirmationNo && isActive(r); })[0];
      if (dup) throw HttpError(409, dup.wg_number + ' is already active for this reservation', { waitingGuest: toStaff(dup) });
      const now = nowIso();
      const id = counter('wg_id');
      const seq = counter('wg_number');
      const row = Store.insert('WaitingGuests', {
        id: id, wg_number: Config.get('wg_prefix') + '-' + String(seq).padStart(Config.num('wg_pad') || 4, '0'), qr_token: randomToken(), source: source,
        confirmation_no: res.confirmationNo, guest_name: res.guestName, arrival_date: res.arrivalDate, arrival_time: res.arrivalTime, departure_date: res.departureDate,
        room_type: res.roomType, adults: res.adults, children: res.children, phone: res.phone, email: res.email,
        luggage_tag: clean(input.luggageTag, 40), associate: associate, preferences: clean(input.preferences, 500), remarks: clean(input.remarks, 500),
        room_number: '', status: 'waiting', priority: false, guest_arrival_at: now, created_at: now, created_by: user.id,
      });
      log(id, '', 'waiting', '', user, source === 'manual' ? 'Reservation entered manually' : '');
      Store.bump();
      return toStaff(row);
    });
  }

  function editDetails(user, id, input) {
    role(user, ['reception']);
    return Locks.run(function () {
      const r = must(id);
      if (!isActive(r)) throw HttpError(409, 'This Waiting Guest is closed');
      const associate = clean(input.associate, 80);
      if (!associate) throw HttpError(400, 'Associate name is required');
      const row = Store.update('WaitingGuests', r._row, { luggage_tag: clean(input.luggageTag, 40), associate: associate, preferences: clean(input.preferences, 500), remarks: clean(input.remarks, 500) });
      log(id, r.status, r.status, r.room_number, user, 'Details edited');
      Store.bump();
      return toStaff(row);
    });
  }

  function assignRoom(user, id, roomNumber) {
    role(user, ['rooms_controller']);
    return Locks.run(function () {
      const wg = must(id);
      if (['waiting', 'room_assigned', 'preparing'].indexOf(wg.status) === -1) throw HttpError(409, 'Room can no longer be changed at this status');
      const room = Store.find('Rooms', 'room_number', clean(roomNumber, 10));
      if (!room) throw HttpError(404, 'Room not found');
      if (room.hk_status === 'out_of_order') throw HttpError(409, 'Room ' + room.room_number + ' is out of order');
      const clash = Store.all('WaitingGuests').filter(function (r) { return r.room_number === room.room_number && isActive(r) && r.id !== id; })[0];
      if (clash) throw HttpError(409, 'Room ' + room.room_number + ' is already held by ' + clash.wg_number);
      const now = nowIso();
      const reassigned = wg.room_number && wg.room_number !== room.room_number;
      const patch = { room_number: room.room_number };
      if (wg.status === 'waiting') { patch.status = 'room_assigned'; patch.room_assigned_at = now; }
      const row = Store.update('WaitingGuests', wg._row, patch);
      log(id, wg.status, row.status, room.room_number, user, reassigned ? 'Room changed from ' + wg.room_number : '');
      Store.bump();
      return toStaff(row);
    });
  }

  function setStatus(user, id, to) {
    const rule = TRANSITIONS[to];
    if (!rule) throw HttpError(400, 'Unknown or unsupported status');
    role(user, rule.roles);
    return Locks.run(function () {
      const wg = must(id);
      if (rule.from.indexOf(wg.status) === -1) throw HttpError(409, 'Cannot move from ' + wg.status + ' to ' + to + '. Refresh: it may have just changed.');
      if (to === 'ready' && !wg.room_number) throw HttpError(409, 'Assign a room first');
      const now = nowIso();
      const patch = { status: to };
      patch[TS[to]] = now;
      if (to === 'ready') patch.guest_notified_at = now;
      let from = wg.status;
      if (to === 'completed' && !wg.guest_returned_at) {
        patch.guest_returned_at = now; // completing straight from Ready: guest is at the desk
        log(id, from, 'returned', wg.room_number, user, 'Recorded automatically on completion');
        from = 'returned';
      }
      const row = Store.update('WaitingGuests', wg._row, patch);
      log(id, from, to, wg.room_number, user, '');
      Store.bump();
      return toStaff(row);
    });
  }

  function cancel(user, id, reason) {
    role(user, ['reception', 'rooms_controller']);
    const why = clean(reason, 200);
    if (why.length < 3) throw HttpError(400, 'Please give a short reason', { field: 'reason' });
    return Locks.run(function () {
      const wg = must(id);
      if (!isActive(wg)) throw HttpError(409, 'This Waiting Guest is already closed');
      const now = nowIso();
      const row = Store.update('WaitingGuests', wg._row, { status: 'cancelled', cancelled_at: now, cancel_reason: why });
      log(id, wg.status, 'cancelled', wg.room_number, user, why);
      Store.bump();
      return toStaff(row);
    });
  }

  function setPriority(user, id, priority) {
    role(user, ['rooms_controller']);
    return Locks.run(function () {
      const wg = must(id);
      if (!isActive(wg)) throw HttpError(409, 'Already closed');
      const row = Store.update('WaitingGuests', wg._row, { priority: !!priority });
      log(id, wg.status, wg.status, wg.room_number, user, priority ? 'Priority on' : 'Priority off');
      Store.bump();
      return toStaff(row);
    });
  }

  // ---- reads -------------------------------------------------------------
  function byAge(a, b) { return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0; }

  function queue() {
    return Store.all('WaitingGuests').filter(isActive).sort(function (a, b) { return (b.priority ? 1 : 0) - (a.priority ? 1 : 0) || byAge(a, b); }).map(toStaff);
  }

  function recentClosed(limit) {
    return Store.all('WaitingGuests').filter(function (r) { return !isActive(r); })
      .sort(function (a, b) { return (b.completed_at || b.cancelled_at) < (a.completed_at || a.cancelled_at) ? -1 : 1; }).slice(0, limit || 15).map(toStaff);
  }

  function get(id) { return toStaff(must(id)); }

  function history(id) {
    must(id);
    const users = {};
    Store.all('Users').forEach(function (u) { users[u.id] = u.display_name; });
    return Store.all('StatusHistory').filter(function (h) { return h.waiting_guest_id === id; }).sort(function (a, b) { return a.id - b.id; })
      .map(function (h) { return { from: h.from_status, to: h.to_status, roomNumber: h.room_number, at: h.changed_at, note: h.note, by: users[h.changed_by] || '' }; });
  }

  /** Reception search: confirmation number, guest name or WG number. */
  function search(term) {
    const t = String(term || '').trim().toLowerCase();
    if (t.length < 2) return { reservations: [], waitingGuests: [] };
    const wgs = Store.all('WaitingGuests').filter(function (r) {
      return r.confirmation_no.toLowerCase().indexOf(t) === 0 || r.guest_name.toLowerCase().indexOf(t) !== -1 || r.wg_number.toLowerCase().indexOf(t) !== -1;
    }).sort(function (a, b) { return (isActive(b) ? 1 : 0) - (isActive(a) ? 1 : 0) || (b.created_at < a.created_at ? -1 : 1); }).slice(0, 20).map(toStaff);
    return { reservations: ReservationSource.searchByConfirmation(t, 8), waitingGuests: wgs };
  }

  function availableRooms(forId) {
    const wg = must(forId);
    const held = {};
    Store.all('WaitingGuests').forEach(function (r) { if (r.room_number && isActive(r) && r.id !== forId) held[r.room_number] = true; });
    return Store.all('Rooms').filter(function (r) { return r.hk_status !== 'out_of_order' && !held[r.room_number]; })
      .map(function (r) { return { roomNumber: r.room_number, building: r.building, floor: r.floor, roomType: r.room_type, hkStatus: r.hk_status, matchesType: r.room_type === wg.room_type }; })
      .sort(function (a, b) { return (b.matchesType ? 1 : 0) - (a.matchesType ? 1 : 0) || (a.roomNumber < b.roomNumber ? -1 : 1); });
  }

  /**
   * What the guest may see. Deliberately excludes phone, email, associate,
   * luggage tag, remarks, preferences, room number, priority and internal ids.
   */
  function guestView(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    const r = Store.find('WaitingGuests', 'qr_token', token);
    if (!r) return null;
    const phase = r.status === 'completed' ? 'completed' : r.status === 'cancelled' ? 'cancelled' : (r.status === 'ready' || r.status === 'returned') ? 'ready' : 'preparing';
    return { wgNumber: r.wg_number, guestName: r.guest_name, confirmationNo: r.confirmation_no, roomType: r.room_type, arrivalDate: r.arrival_date, arrivalTime: r.arrival_time, departureDate: r.departure_date, phase: phase, readyAt: r.room_ready_at };
  }

  /** Real, computed metrics only. Nothing is estimated or fabricated. */
  function metrics() {
    const rows = Store.all('WaitingGuests').filter(function (r) { return r.status !== 'cancelled'; });
    const active = rows.filter(isActive);
    const done = rows.filter(function (r) { return r.status === 'completed'; });
    const secs = function (a, b) { return a && b ? (Date.parse(b) - Date.parse(a)) / 1000 : null; };
    const avg = function (xs) { const v = xs.filter(function (x) { return x !== null; }); return v.length ? Math.round(v.reduce(function (s, x) { return s + x; }, 0) / v.length) : null; };
    const now = nowIso();
    const waitingNow = active.filter(function (r) { return r.status !== 'ready' && r.status !== 'returned'; }).map(function (r) { return secs(r.created_at, now); });
    return {
      total: rows.length, active: active.length, completed: done.length,
      cancelled: Store.all('WaitingGuests').length - rows.length,
      avgWaitToReadySec: avg(rows.map(function (r) { return secs(r.created_at, r.room_ready_at); })),
      avgReadyToReturnSec: avg(rows.map(function (r) { return secs(r.room_ready_at, r.guest_returned_at); })),
      avgTotalSec: avg(done.map(function (r) { return secs(r.created_at, r.completed_at); })),
      longestActiveWaitSec: waitingNow.length ? Math.max.apply(null, waitingNow) : 0,
      readyAwaitingGuest: active.filter(function (r) { return r.status === 'ready'; }).length,
      stillWaitingForRoom: waitingNow.length,
    };
  }

  function exportCsv() {
    const cols = ['wg_number', 'source', 'confirmation_no', 'guest_name', 'arrival_date', 'departure_date', 'room_type', 'adults', 'children', 'luggage_tag', 'associate', 'preferences', 'remarks',
      'room_number', 'status', 'cancel_reason', 'guest_arrival_at', 'created_at', 'room_assigned_at', 'preparation_started_at', 'room_ready_at', 'guest_notified_at', 'guest_returned_at', 'completed_at', 'cancelled_at'];
    const lines = [csvLine(cols)];
    Store.all('WaitingGuests').sort(byAge).forEach(function (r) { lines.push(csvLine(cols.map(function (c) { return r[c]; }))); });
    return lines.join('\r\n');
  }

  return { create: create, editDetails: editDetails, assignRoom: assignRoom, setStatus: setStatus, cancel: cancel, setPriority: setPriority,
    queue: queue, recentClosed: recentClosed, get: get, history: history, search: search, availableRooms: availableRooms, guestView: guestView,
    metrics: metrics, exportCsv: exportCsv, toStaff: toStaff };
})();
