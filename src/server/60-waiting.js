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
      suggestedLanguage: suggestLanguage_(r.nationality),
    };
  },
};

const LANGUAGE_BY_COUNTRY = (function () {
  const m = {};
  const put = function (lang, list) { list.split(',').forEach(function (c) { m[c.trim().toUpperCase()] = lang; }); };
  put('ar', 'AE,ARE,SA,SAU,QA,QAT,KW,KWT,BH,BHR,OM,OMN,JO,JOR,LB,LBN,SY,SYR,IQ,IRQ,EG,EGY,LY,LBY,TN,TUN,DZ,DZA,MA,MAR,SD,SDN,YE,YEM,PS,PSE,' +
    'UNITED ARAB EMIRATES,UAE,SAUDI ARABIA,QATAR,KUWAIT,BAHRAIN,OMAN,JORDAN,LEBANON,SYRIA,IRAQ,EGYPT,LIBYA,TUNISIA,ALGERIA,MOROCCO,SUDAN,YEMEN,PALESTINE');
  put('ru', 'RU,RUS,BY,BLR,KZ,KAZ,KG,KGZ,RUSSIA,RUSSIAN FEDERATION,BELARUS,KAZAKHSTAN,KYRGYZSTAN');
  put('de', 'DE,DEU,AT,AUT,CH,CHE,GERMANY,AUSTRIA,SWITZERLAND');
  return m;
})();

/** A default only: Reception can always change the guest's language. */
function suggestLanguage_(nationality) {
  return LANGUAGE_BY_COUNTRY[String(nationality || '').trim().toUpperCase()] || 'en';
}
function normLanguage_(v, fallback) {
  const l = String(v || '').trim().toLowerCase();
  return LANGUAGES.indexOf(l) !== -1 ? l : (fallback || 'en');
}

const Links = {
  base: function () {
    const override = Config.get('guest_base_url');
    if (override) return override;
    try { return ScriptApp.getService().getUrl(); } catch (e) { return ''; }
  },
  guestUrl: function (token) { return Links.base() + (Links.base().indexOf('?') === -1 ? '?' : '&') + 't=' + token; },
};

function cleanTags_(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(',');
  const out = [];
  list.forEach(function (t) { t = String(t).trim().toLowerCase(); if (GUEST_TAGS.indexOf(t) !== -1 && out.indexOf(t) === -1) out.push(t); });
  return out.join(',');
}
function parseTags_(s) { return String(s || '').split(',').filter(function (t) { return GUEST_TAGS.indexOf(t) !== -1; }); }

/** Lowercase, remove accents, keep letters/digits/spaces: "Jürgen  O'Neil" -> "jurgen oneil". */
function fold_(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9\u0600-\u06ff\u0400-\u04ff ]+/g, '').replace(/\s+/g, ' ').trim();
}
/** Local calendar date and hour of an ISO timestamp, in the hotel's time zone. */
function localParts_(iso) {
  if (!iso) return null;
  const s = Utilities.formatDate(new Date(iso), Session.getScriptTimeZone(), 'yyyy-MM-dd HH');
  return { date: s.slice(0, 10), hour: parseInt(s.slice(11, 13), 10) };
}

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
    if (!user || roles.indexOf(user.role) === -1) throw HttpError_(403, 'Not allowed for your role');
  }

  function toStaff(r) {
    return {
      id: r.id, wgNumber: r.wg_number, source: r.source, confirmationNo: r.confirmation_no, guestName: r.guest_name,
      arrivalDate: r.arrival_date, arrivalTime: r.arrival_time, departureDate: r.departure_date, roomType: r.room_type,
      adults: r.adults, children: r.children, phone: r.phone, email: r.email,
      luggageTag: r.luggage_tag, associate: r.associate, preferences: r.preferences, remarks: r.remarks,
      roomNumber: r.room_number, status: r.status, priority: !!r.priority, cancelReason: r.cancel_reason, language: normLanguage_(r.language),
      vipCode: r.vip_code, tags: parseTags_(r.tags), createSeconds: r.create_seconds || null,
      feedback: r.feedback_at ? { rating: r.feedback_rating, helpful: r.feedback_helpful, at: r.feedback_at } : null,
      timestamps: {
        guestArrival: r.guest_arrival_at, created: r.created_at, roomAssigned: r.room_assigned_at, preparationStarted: r.preparation_started_at,
        roomReady: r.room_ready_at, guestNotified: r.guest_notified_at, guestReturned: r.guest_returned_at, completed: r.completed_at, cancelled: r.cancelled_at,
        qrOpened: r.qr_first_opened_at, guestSawReady: r.guest_seen_ready_at,
      },
    };
  }

  function counter(name) {
    const v = parseInt(Store.kvGet('Meta', name) || '0', 10) + 1;
    Store.kvSet('Meta', name, v);
    return v;
  }

  function log(id, from, to, room, user, note) {
    Store.insert('StatusHistory', { id: counter('history_counter'), waiting_guest_id: id, from_status: from || '', to_status: to, room_number: room || '', changed_at: nowIso_(), changed_by: user ? user.id : '', note: note || '' });
  }

  function must(id) {
    const r = Store.find('WaitingGuests', 'id', id);
    if (!r) throw HttpError_(404, 'Waiting Guest not found');
    return r;
  }

  function isActive(r) { return ACTIVE_STATUSES.indexOf(r.status) !== -1; }

  function validateManual(m, confirmationNo) {
    m = m || {};
    const errs = [];
    const name = clean_(m.guestName, 120);
    const arr = parseDateText_(m.arrivalDate);
    const dep = parseDateText_(m.departureDate);
    const time = parseTimeText_(m.arrivalTime);
    const type = clean_(m.roomType, 20).toUpperCase();
    const adults = toInt_(m.adults, 0);
    const children = toInt_(m.children, 0);
    if (!/^[A-Za-z0-9\-\/]{1,30}$/.test(confirmationNo)) errs.push('Confirmation number is required');
    if (!name) errs.push('Guest name is required');
    if (!arr) errs.push('Arrival date is required');
    if (!dep) errs.push('Departure date is required');
    if (arr && dep && dep < arr) errs.push('Departure is before arrival');
    if (!type) errs.push('Room type is required');
    if (adults < 1 || adults > 20) errs.push('Adults must be 1 to 20');
    if (children < 0 || children > 20) errs.push('Children must be 0 to 20');
    if (time === null) errs.push('Arrival time is not valid');
    if (errs.length) throw HttpError_(400, errs.join('. '), { fields: errs });
    return { confirmationNo: confirmationNo, guestName: name, arrivalDate: arr, arrivalTime: time || '', departureDate: dep, roomType: type, adults: adults, children: children, phone: clean_(m.phone, 40), email: clean_(m.email, 120) };
  }

  function create(user, confirmationNo, input) {
    role(user, ['reception']);
    input = input || {};
    const conf = clean_(confirmationNo, 30);
    const associate = clean_(input.associate, 80);
    if (!associate) throw HttpError_(400, 'Associate name is required', { field: 'associate' });
    return Locks.run(function () {
      let res = ReservationSource.findByConfirmation(conf);
      let source = 'import';
      if (!res) {
        if (!input.manual) throw HttpError_(404, 'Reservation not found');
        res = validateManual(input.manual, conf);
        source = 'manual';
      }
      const dup = Store.all('WaitingGuests').filter(function (r) { return r.confirmation_no === res.confirmationNo && isActive(r); })[0];
      if (dup) throw HttpError_(409, dup.wg_number + ' is already active for this reservation', { waitingGuest: toStaff(dup) });
      const now = nowIso_();
      const id = counter('wg_id');
      const seq = counter('wg_number');
      const row = Store.insert('WaitingGuests', {
        id: id, wg_number: Config.get('wg_prefix') + '-' + String(seq).padStart(Config.num('wg_pad') || 4, '0'), qr_token: randomToken_(), source: source,
        confirmation_no: res.confirmationNo, guest_name: res.guestName, arrival_date: res.arrivalDate, arrival_time: res.arrivalTime, departure_date: res.departureDate,
        room_type: res.roomType, adults: res.adults, children: res.children, phone: res.phone, email: res.email,
        luggage_tag: clean_(input.luggageTag, 40), associate: associate, preferences: clean_(input.preferences, 500), remarks: clean_(input.remarks, 500),
        room_number: '', status: 'waiting', priority: false, guest_arrival_at: now, created_at: now, created_by: user.id,
        language: normLanguage_(input.language, suggestLanguage_(res.nationality)),
        vip_code: clean_(res.vipCode, 20), tags: cleanTags_(input.tags),
        // Measured time Reception spent from opening the reservation to pressing Create (seconds).
        create_seconds: (function (n) { return n >= 1 && n <= 1800 ? n : ''; })(toInt_(input.createSeconds, 0)),
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
      if (!isActive(r)) throw HttpError_(409, 'This Waiting Guest is closed');
      const associate = clean_(input.associate, 80);
      if (!associate) throw HttpError_(400, 'Associate name is required');
      const row = Store.update('WaitingGuests', r._row, { luggage_tag: clean_(input.luggageTag, 40), associate: associate, preferences: clean_(input.preferences, 500), remarks: clean_(input.remarks, 500), language: normLanguage_(input.language, r.language || 'en'),
        tags: input.tags === undefined ? r.tags : cleanTags_(input.tags) });
      log(id, r.status, r.status, r.room_number, user, 'Details edited');
      Store.bump();
      return toStaff(row);
    });
  }

  /** A room number typed by hand: letters, digits and dashes only, e.g. "1204" or "V-12". */
  function manualRoom(v) {
    const n = clean_(v, 10).toUpperCase().replace(/\s+/g, '');
    if (!/^[A-Z0-9-]{1,10}$/.test(n)) throw HttpError_(400, 'Enter a room number using letters, numbers or a dash', { field: 'roomNumber' });
    return n;
  }

  /**
   * Assign or change the room. `manual` allows a room number that is not in the
   * imported rooms list (typed by the Rooms Controller); it is marked in the timeline.
   */
  function assignRoom(user, id, roomNumber, manual) {
    role(user, ['rooms_controller']);
    return Locks.run(function () {
      const wg = must(id);
      if (['waiting', 'room_assigned', 'preparing'].indexOf(wg.status) === -1) throw HttpError_(409, 'Room can no longer be changed at this status');
      const typed = manual ? manualRoom(roomNumber) : clean_(roomNumber, 10);
      const listed = Store.find('Rooms', 'room_number', typed) || (manual ? Store.all('Rooms').filter(function (r) { return r.room_number.toUpperCase() === typed; })[0] : null);
      if (!listed && !manual) throw HttpError_(404, 'Room not found');
      const room = listed || { room_number: typed, hk_status: '' };
      if (room.hk_status === 'out_of_order') throw HttpError_(409, 'Room ' + room.room_number + ' is out of order');
      const clash = Store.all('WaitingGuests').filter(function (r) { return r.room_number === room.room_number && isActive(r) && r.id !== id; })[0];
      if (clash) throw HttpError_(409, 'Room ' + room.room_number + ' is already held by ' + clash.wg_number);
      const now = nowIso_();
      // Store.update refreshes the row object in place, so read "before" values first
      const fromStatus = wg.status, prevRoom = wg.room_number;
      const reassigned = prevRoom && prevRoom !== room.room_number;
      const patch = { room_number: room.room_number };
      if (wg.status === 'waiting') { patch.status = 'room_assigned'; patch.room_assigned_at = now; }
      const row = Store.update('WaitingGuests', wg._row, patch);
      const note = (reassigned ? 'Room changed from ' + prevRoom : '') + (!listed ? (reassigned ? '; ' : '') + 'room number entered manually' : '');
      log(id, fromStatus, row.status, room.room_number, user, note);
      Store.bump();
      return toStaff(row);
    });
  }

  /**
   * Rooms Controller: take back "room ready" marked by mistake. The record returns to
   * "being prepared", the guest page goes back to "being prepared", and the ready
   * timestamps are cleared so the analytics stay true. Only while the guest has not
   * yet returned to Reception.
   */
  function undoReady(user, id, reason) {
    role(user, ['rooms_controller']);
    const why = clean_(reason, 200);
    if (why.length < 3) throw HttpError_(400, 'Please give a short reason', { field: 'reason' });
    return Locks.run(function () {
      const wg = must(id);
      if (wg.status !== 'ready') throw HttpError_(409, wg.status === 'returned' || wg.status === 'completed' ? 'The guest is already back at Reception. Ask an admin to correct this record.' : 'Only a room marked ready can be taken back');
      const row = Store.update('WaitingGuests', wg._row, {
        status: 'preparing', preparation_started_at: wg.preparation_started_at || nowIso_(),
        room_ready_at: '', guest_notified_at: '', guest_seen_ready_at: '',
      });
      log(id, 'ready', 'preparing', wg.room_number, user, 'Room ready taken back: ' + why);
      audit_(user, 'record.undo_ready', wg.wg_number + ' (' + why + ')');
      Store.bump();
      return toStaff(row);
    });
  }

  function setStatus(user, id, to) {
    const rule = TRANSITIONS[to];
    if (!rule) throw HttpError_(400, 'Unknown or unsupported status');
    role(user, rule.roles);
    return Locks.run(function () {
      const wg = must(id);
      if (rule.from.indexOf(wg.status) === -1) throw HttpError_(409, 'Cannot move from ' + wg.status + ' to ' + to + '. Refresh: it may have just changed.');
      if (to === 'ready' && !wg.room_number) throw HttpError_(409, 'Assign a room first');
      const now = nowIso_();
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
    const why = clean_(reason, 200);
    if (why.length < 3) throw HttpError_(400, 'Please give a short reason', { field: 'reason' });
    return Locks.run(function () {
      const wg = must(id);
      if (!isActive(wg)) throw HttpError_(409, 'This Waiting Guest is already closed');
      const now = nowIso_();
      const fromStatus = wg.status;
      const row = Store.update('WaitingGuests', wg._row, { status: 'cancelled', cancelled_at: now, cancel_reason: why });
      log(id, fromStatus, 'cancelled', wg.room_number, user, why);
      Store.bump();
      return toStaff(row);
    });
  }

  // ---- admin: correct, edit, delete, reset ----------------------------------
  const STATUS_TS = ['room_assigned_at', 'preparation_started_at', 'room_ready_at', 'guest_returned_at', 'completed_at']; // in workflow order

  /** Admin: fix any field of a record, including the reservation snapshot. */
  function adminUpdate(user, id, input) {
    role(user, ['admin']);
    input = input || {};
    return Locks.run(function () {
      const r = must(id);
      const conf = clean_(input.confirmationNo !== undefined ? input.confirmationNo : r.confirmation_no, 30);
      const res = validateManual({
        guestName: input.guestName !== undefined ? input.guestName : r.guest_name,
        arrivalDate: input.arrivalDate !== undefined ? input.arrivalDate : r.arrival_date,
        departureDate: input.departureDate !== undefined ? input.departureDate : r.departure_date,
        arrivalTime: input.arrivalTime !== undefined ? input.arrivalTime : r.arrival_time,
        roomType: input.roomType !== undefined ? input.roomType : r.room_type,
        adults: input.adults !== undefined ? input.adults : r.adults,
        children: input.children !== undefined ? input.children : r.children,
        phone: r.phone, email: r.email,
      }, conf);
      if (conf !== r.confirmation_no && isActive(r)) {
        const dup = Store.all('WaitingGuests').filter(function (x) { return x.id !== id && x.confirmation_no === conf && isActive(x); })[0];
        if (dup) throw HttpError_(409, dup.wg_number + ' is already active for confirmation ' + conf);
      }
      const associate = input.associate !== undefined ? clean_(input.associate, 80) : r.associate;
      if (!associate) throw HttpError_(400, 'Associate name is required', { field: 'associate' });
      const row = Store.update('WaitingGuests', r._row, {
        confirmation_no: res.confirmationNo, guest_name: res.guestName, arrival_date: res.arrivalDate, arrival_time: res.arrivalTime,
        departure_date: res.departureDate, room_type: res.roomType, adults: res.adults, children: res.children,
        luggage_tag: input.luggageTag !== undefined ? clean_(input.luggageTag, 40) : r.luggage_tag, associate: associate,
        preferences: input.preferences !== undefined ? clean_(input.preferences, 500) : r.preferences,
        remarks: input.remarks !== undefined ? clean_(input.remarks, 500) : r.remarks,
        language: normLanguage_(input.language, r.language || 'en'),
        tags: input.tags === undefined ? r.tags : cleanTags_(input.tags),
        vip_code: input.vipCode !== undefined ? clean_(input.vipCode, 20) : r.vip_code,
      });
      log(id, r.status, r.status, r.room_number, user, 'Record corrected by admin');
      audit_(user, 'record.edit', r.wg_number);
      Store.bump();
      return toStaff(row);
    });
  }

  /**
   * Admin: set any status (e.g. undo a room marked ready by mistake, reopen a
   * completed record). Timestamps of later steps are cleared so metrics stay true.
   */
  function correctStatus(user, id, to, roomNumber, reason) {
    role(user, ['admin']);
    if (STATUSES.indexOf(to) === -1) throw HttpError_(400, 'Unknown status');
    const why = clean_(reason, 200);
    if (why.length < 3) throw HttpError_(400, 'Please give a short reason', { field: 'reason' });
    return Locks.run(function () {
      const r = must(id);
      if (to === r.status) throw HttpError_(409, 'The record already has this status');
      const now = nowIso_();
      const patch = { status: to };
      const needsRoom = ['room_assigned', 'preparing', 'ready', 'returned', 'completed'].indexOf(to) !== -1;
      let room = r.room_number;
      if (needsRoom) {
        if (roomNumber) {
          const typed = manualRoom(roomNumber);
          const rm = Store.all('Rooms').filter(function (x) { return x.room_number.toUpperCase() === typed; })[0];
          room = rm ? rm.room_number : typed; // a room not in the imported list is allowed for corrections
        }
        if (!room) throw HttpError_(409, 'Choose a room for this status');
        if (to !== 'completed') {
          const clash = Store.all('WaitingGuests').filter(function (x) { return x.room_number === room && isActive(x) && x.id !== id; })[0];
          if (clash) throw HttpError_(409, 'Room ' + room + ' is already held by ' + clash.wg_number);
        }
      } else room = '';
      patch.room_number = room;
      const reached = { waiting: 0, room_assigned: 1, preparing: 2, ready: 3, returned: 4, completed: 5, cancelled: -1 }[to];
      STATUS_TS.forEach(function (col, i) {
        if (to === 'cancelled') return;
        if (i >= reached) patch[col] = '';
        else if (!r[col] && i !== 1) patch[col] = now; // steps before the new one must have a time (preparation is optional)
      });
      if (to !== 'cancelled') { patch.cancelled_at = ''; patch.cancel_reason = ''; }
      else { patch.cancelled_at = now; patch.cancel_reason = why; }
      if (reached < 3 && to !== 'cancelled') { patch.guest_notified_at = ''; patch.guest_seen_ready_at = ''; }
      if (to === 'ready' && !r.guest_notified_at) patch.guest_notified_at = now;
      const reachedTs = { room_assigned: 'room_assigned_at', preparing: 'preparation_started_at', ready: 'room_ready_at', returned: 'guest_returned_at', completed: 'completed_at' }[to];
      if (reachedTs) patch[reachedTs] = now;
      const fromStatus = r.status;
      const row = Store.update('WaitingGuests', r._row, patch);
      log(id, fromStatus, to, room, user, 'Corrected by admin: ' + why);
      audit_(user, 'record.status', r.wg_number + ' ' + fromStatus + ' -> ' + to + ' (' + why + ')');
      Store.bump();
      return toStaff(row);
    });
  }

  /** Admin: permanently delete one record and its history. The guest link stops working. */
  function adminDelete(user, id, confirmWg) {
    role(user, ['admin']);
    return Locks.run(function () {
      const r = must(id);
      if (String(confirmWg || '').trim().toUpperCase() !== r.wg_number.toUpperCase()) throw HttpError_(400, 'Type ' + r.wg_number + ' to confirm', { field: 'confirm' });
      Store.all('StatusHistory').filter(function (h) { return h.waiting_guest_id === id; }).sort(function (a, b) { return b._row - a._row; })
        .forEach(function (h) { Store.remove('StatusHistory', h._row); });
      Store.remove('WaitingGuests', must(id)._row);
      audit_(user, 'record.delete', r.wg_number + ' (' + r.confirmation_no + ')');
      Store.bump();
      return { ok: true };
    });
  }

  /**
   * Admin: wipe all Waiting Guests and their history (e.g. after testing) and restart
   * numbering at 1. Optionally also remove all imported reservations.
   * Users, rooms, settings and guest-page content are kept.
   */
  function resetAll(user, input) {
    role(user, ['admin']);
    input = input || {};
    if (String(input.confirm || '').trim() !== 'RESET') throw HttpError_(400, 'Type RESET to confirm', { field: 'confirm' });
    return Locks.run(function () {
      const n = Store.all('WaitingGuests').length;
      Store.clear('WaitingGuests');
      Store.clear('StatusHistory');
      ['wg_id', 'wg_number', 'history_counter'].forEach(function (k) { Store.kvSet('Meta', k, 0); });
      let res = 0;
      if (input.reservations) { res = Store.all('Reservations').length; Store.clear('Reservations'); }
      audit_(user, 'data.reset', n + ' waiting guest record(s)' + (input.reservations ? ', ' + res + ' reservation(s)' : ''));
      Store.bump();
      return { waitingGuests: n, reservations: res };
    });
  }

  /** Admin: every record (active and closed), newest first, optionally filtered. */
  function adminList(q, status) {
    const t = fold_(q);
    return Store.all('WaitingGuests')
      .filter(function (r) { return !status || status === 'all' || (status === 'active' ? isActive(r) : r.status === status); })
      .filter(function (r) { return !t || [r.guest_name, r.wg_number, r.confirmation_no, r.room_number, r.luggage_tag].some(function (x) { return fold_(x).indexOf(t) !== -1; }); })
      .sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; }).slice(0, 300).map(toStaff);
  }

  function setPriority(user, id, priority) {
    role(user, ['rooms_controller']);
    return Locks.run(function () {
      const wg = must(id);
      if (!isActive(wg)) throw HttpError_(409, 'Already closed');
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

  /**
   * Staff search, forgiving: confirmation number, guest name (accents and case
   * ignored, any word order), Waiting Guest number ("wg 12", "0012", "12"),
   * room number or luggage tag.
   */
  function search(term) {
    const raw = String(term || '').trim();
    const t = fold_(raw);
    if (t.length < 2 && !/^\d$/.test(t)) return { reservations: [], waitingGuests: [] };
    const words = t.split(' ');
    const digits = raw.replace(/\D/g, '');
    const compact = t.replace(/ /g, '');
    // "12", "0012", "wg 12", "WG-0012" all mean Waiting Guest 12 (short numbers only, so confirmation numbers don't collide)
    const wgMatch = raw.match(/^(?:[a-z]{1,4}\s*-?\s*)?0*(\d{1,5})$/i);
    const wgNum = wgMatch && (/^[a-z]/i.test(raw) || digits.length <= 5) ? parseInt(wgMatch[1], 10) : null;
    const hit = function (r) {
      const name = fold_(r.guest_name);
      if (words.every(function (w) { return name.indexOf(w) !== -1; })) return true;
      if (r.confirmation_no.toLowerCase().indexOf(compact) === 0) return true;
      const wg = r.wg_number.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (wg.indexOf(compact) !== -1) return true;
      if (wgNum !== null && parseInt(r.wg_number.replace(/\D/g, ''), 10) === wgNum) return true;
      if (r.room_number && r.room_number.toLowerCase() === compact) return true;
      if (r.luggage_tag && fold_(r.luggage_tag).replace(/ /g, '') === compact) return true;
      return false;
    };
    const wgs = Store.all('WaitingGuests').filter(hit)
      .sort(function (a, b) { return (isActive(b) ? 1 : 0) - (isActive(a) ? 1 : 0) || (b.created_at < a.created_at ? -1 : 1); }).slice(0, 20).map(toStaff);
    const res = ReservationSource.searchByConfirmation(raw.replace(/\s/g, ''), 8);
    if (res.length < 8 && /[a-z\u0600-\u06ff\u0400-\u04ff]/.test(t)) {
      // also find arrivals by name, so Reception can search "mansoori" before a record exists
      const seen = {};
      res.forEach(function (r) { seen[r.confirmationNo] = true; });
      Store.all('Reservations').filter(function (r) { return !seen[r.confirmation_no] && words.every(function (w) { return fold_(r.guest_name).indexOf(w) !== -1; }); })
        .slice(0, 8 - res.length).forEach(function (r) { res.push(ReservationSource.shape(r)); });
    }
    return { reservations: res, waitingGuests: wgs };
  }

  function availableRooms(forId) {
    const wg = must(forId);
    const held = {};
    Store.all('WaitingGuests').forEach(function (r) { if (r.room_number && isActive(r) && r.id !== forId) held[r.room_number] = true; });
    return Store.all('Rooms').filter(function (r) { return r.hk_status !== 'out_of_order' && !held[r.room_number]; })
      .map(function (r) { return { roomNumber: r.room_number, building: r.building, floor: r.floor, roomType: r.room_type, hkStatus: r.hk_status, matchesType: r.room_type === wg.room_type, connecting: r.connecting, features: r.features ? r.features.split(',') : [] }; })
      .sort(function (a, b) { return (b.matchesType ? 1 : 0) - (a.matchesType ? 1 : 0) || (a.roomNumber < b.roomNumber ? -1 : 1); });
  }

  const PHASE = { waiting: 'received', room_assigned: 'assigned', preparing: 'preparing', ready: 'ready', returned: 'ready', completed: 'completed', cancelled: 'cancelled' };

  function validToken(token) { return typeof token === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(token); }

  function expired(r) {
    const closedAt = r.completed_at || r.cancelled_at;
    if (!closedAt) return false;
    return Date.now() - Date.parse(closedAt) > Math.max(1, Config.num('qr_expire_hours')) * 3600e3;
  }

  /**
   * What the guest may see. A fixed whitelist: never phone, email, associate,
   * luggage tag, remarks, preferences, room number, priority, VIP or internal ids.
   * After a record has been closed for qr_expire_hours, only the phase is shown.
   */
  function guestView(token) {
    if (!validToken(token)) return null;
    const r = Store.find('WaitingGuests', 'qr_token', token);
    if (!r) return null;
    if (expired(r)) return { phase: 'expired', language: normLanguage_(r.language) };
    const type = Store.find('RoomTypes', 'code', r.room_type);
    return {
      wgNumber: r.wg_number, guestName: r.guest_name, confirmationNo: r.confirmation_no,
      roomType: r.room_type, roomTypeName: type && type.name && type.name !== r.room_type ? type.name : '',
      arrivalDate: r.arrival_date, arrivalTime: r.arrival_time, departureDate: r.departure_date,
      phase: PHASE[r.status] || 'received', readyAt: r.room_ready_at, language: normLanguage_(r.language),
      canGiveFeedback: r.status === 'completed' && !r.feedback_at, feedbackGiven: !!r.feedback_at,
    };
  }

  /**
   * The guest's page is on screen: record the first QR opening and the first time
   * the guest saw "room ready". Real events only; each is written once.
   */
  function markSeen(token) {
    if (!validToken(token)) return;
    const peek = Store.find('WaitingGuests', 'qr_token', token);
    if (!peek || expired(peek)) return;
    const readyNow = peek.status === 'ready' || peek.status === 'returned';
    if (peek.qr_first_opened_at && (!readyNow || peek.guest_seen_ready_at)) return;
    Locks.run(function () {
      const r = Store.find('WaitingGuests', 'qr_token', token);
      if (!r) return;
      const patch = {};
      const now = nowIso_();
      if (!r.qr_first_opened_at) patch.qr_first_opened_at = now;
      if ((r.status === 'ready' || r.status === 'returned') && !r.guest_seen_ready_at) patch.guest_seen_ready_at = now;
      if (!Object.keys(patch).length) return;
      Store.update('WaitingGuests', r._row, patch);
      Store.bump();
    });
  }

  function feedback(token, body) {
    if (!validToken(token)) throw HttpError_(404, 'This link is not valid');
    body = body || {};
    const rating = toInt_(body.rating, 0);
    if (rating < 1 || rating > 5) throw HttpError_(400, 'Please choose 1 to 5 stars');
    const helpful = body.helpful === 'yes' || body.helpful === 'no' ? body.helpful : '';
    return Locks.run(function () {
      const r = Store.find('WaitingGuests', 'qr_token', token);
      if (!r || expired(r)) throw HttpError_(404, 'This link is not valid');
      if (r.status !== 'completed') throw HttpError_(409, 'Feedback opens after check-in');
      if (r.feedback_at) throw HttpError_(409, 'Thank you, we already have your feedback');
      Store.update('WaitingGuests', r._row, { feedback_rating: rating, feedback_helpful: helpful, feedback_at: nowIso_() });
      Store.bump();
      return { ok: true };
    });
  }

  /**
   * Real, computed metrics only. Nothing is estimated or fabricated.
   * range: 'today' (hotel time zone), '7d' or '30d'. Live figures (active,
   * waiting now) are always "right now".
   */
  function metrics(range) {
    const days = range === '30d' ? 30 : range === '7d' ? 7 : 1;
    const today = todayIso_();
    const start = new Date(Date.parse(today + 'T00:00:00Z') - (days - 1) * 86400000).toISOString().slice(0, 10);
    const all = Store.all('WaitingGuests');
    const now = nowIso_();
    const secs = function (a, b) { return a && b ? Math.max(0, (Date.parse(b) - Date.parse(a)) / 1000) : null; };
    const avg = function (xs) { const v = xs.filter(function (x) { return x !== null && x !== undefined && x !== ''; }); return v.length ? Math.round(v.reduce(function (s, x) { return s + Number(x); }, 0) / v.length) : null; };
    const inRange = function (iso) { const p = localParts_(iso); return !!p && p.date >= start && p.date <= today; };

    const active = all.filter(isActive);
    const waitingNow = active.filter(function (r) { return r.status !== 'ready' && r.status !== 'returned'; });
    const created = all.filter(function (r) { return inRange(r.created_at); });
    const real = created.filter(function (r) { return r.status !== 'cancelled'; });
    const done = all.filter(function (r) { return r.status === 'completed' && inRange(r.completed_at); });
    const readyIn = all.filter(function (r) { return r.room_ready_at && inRange(r.room_ready_at); });
    const aware = readyIn.map(function (r) { return secs(r.room_ready_at, r.guest_seen_ready_at); });
    const fb = all.filter(function (r) { return r.feedback_at && inRange(r.feedback_at); });

    const hourly = []; for (let h = 0; h < 24; h++) hourly.push(0);
    const daily = {};
    for (let d = 0; d < days; d++) daily[new Date(Date.parse(start + 'T00:00:00Z') + d * 86400000).toISOString().slice(0, 10)] = 0;
    real.forEach(function (r) { const p = localParts_(r.created_at); hourly[p.hour]++; if (daily[p.date] !== undefined) daily[p.date]++; });

    return {
      range: days === 1 ? 'today' : days + 'd', from: start, to: today,
      // right now
      active: active.length,
      stillWaitingForRoom: waitingNow.length,
      readyAwaitingGuest: active.filter(function (r) { return r.status === 'ready'; }).length,
      longestActiveWaitSec: waitingNow.length ? Math.max.apply(null, waitingNow.map(function (r) { return secs(r.created_at, now); })) : 0,
      // in range
      created: real.length,
      cancelled: created.length - real.length,
      completed: done.length,
      avgWaitToReadySec: avg(real.map(function (r) { return secs(r.created_at, r.room_ready_at); })),
      avgReadyToReturnSec: avg(readyIn.map(function (r) { return secs(r.room_ready_at, r.guest_returned_at); })),
      avgTotalSec: avg(done.map(function (r) { return secs(r.created_at, r.completed_at); })),
      avgCreateSec: avg(real.map(function (r) { return r.create_seconds || null; })),
      qrOpened: real.filter(function (r) { return !!r.qr_first_opened_at; }).length,
      readyCount: readyIn.length,
      awareCount: aware.filter(function (x) { return x !== null; }).length,
      avgAwarenessSec: avg(aware),
      feedbackCount: fb.length,
      avgRating: fb.length ? Math.round(fb.reduce(function (s, r) { return s + r.feedback_rating; }, 0) / fb.length * 10) / 10 : null,
      helpfulYes: fb.filter(function (r) { return r.feedback_helpful === 'yes'; }).length,
      helpfulAnswered: fb.filter(function (r) { return r.feedback_helpful; }).length,
      hourly: hourly,
      daily: Object.keys(daily).map(function (k) { return { date: k, count: daily[k] }; }),
    };
  }

  function exportCsv() {
    const cols = ['wg_number', 'source', 'confirmation_no', 'guest_name', 'arrival_date', 'departure_date', 'room_type', 'adults', 'children', 'luggage_tag', 'associate', 'preferences', 'remarks',
      'language', 'vip_code', 'tags', 'room_number', 'status', 'cancel_reason', 'guest_arrival_at', 'created_at', 'room_assigned_at', 'preparation_started_at', 'room_ready_at', 'guest_notified_at', 'qr_first_opened_at', 'guest_seen_ready_at', 'guest_returned_at', 'completed_at', 'cancelled_at', 'create_seconds', 'feedback_rating', 'feedback_helpful'];
    const lines = [csvLine_(cols)];
    Store.all('WaitingGuests').sort(byAge).forEach(function (r) { lines.push(csvLine_(cols.map(function (c) { return r[c]; }))); });
    return lines.join('\r\n');
  }

  return { undoReady: undoReady, adminUpdate: adminUpdate, correctStatus: correctStatus, adminDelete: adminDelete, resetAll: resetAll, adminList: adminList,
    create: create, editDetails: editDetails, assignRoom: assignRoom, setStatus: setStatus, cancel: cancel, setPriority: setPriority,
    queue: queue, recentClosed: recentClosed, get: get, history: history, search: search, availableRooms: availableRooms, guestView: guestView, markSeen: markSeen, feedback: feedback,
    metrics: metrics, exportCsv: exportCsv, toStaff: toStaff };
})();
