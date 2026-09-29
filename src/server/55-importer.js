/* =====================================================================
 * Import of arrivals (reservations) and rooms from CSV.
 * Two steps: preview (nothing saved) then commit. Rows are validated and
 * every problem is reported with its line number.
 * ===================================================================== */

const Importer = (function () {
  const MAX_ROWS = 5000;
  const MAX_CHARS = 2000000;

  const HK_MAP = {
    clean: 'clean', vc: 'clean', vacantclean: 'clean', cl: 'clean',
    inspected: 'inspected', insp: 'inspected', ins: 'inspected', vi: 'inspected', vacantinspected: 'inspected', ready: 'inspected',
    dirty: 'dirty', vd: 'dirty', vacantdirty: 'dirty', di: 'dirty', dt: 'dirty',
    outoforder: 'out_of_order', ooo: 'out_of_order', oos: 'out_of_order', outofservice: 'out_of_order', ooi: 'out_of_order',
  };

  function limit(text) {
    if (typeof text !== 'string' || !text.trim()) throw HttpError_(400, 'The file is empty');
    if (text.length > MAX_CHARS) throw HttpError_(413, 'File is too large (max about 2 MB). Split it into smaller files.');
  }

  function cell(row, map, key) { return map[key] === undefined ? '' : String(row[map[key]] === undefined ? '' : row[map[key]]).trim(); }

  function knownTypes() {
    const t = {};
    Store.all('RoomTypes').forEach(function (r) { t[r.code.toUpperCase()] = true; });
    return t;
  }

  function analyzeArrivals(text, override) {
    limit(text);
    const rows = Csv.parse(text);
    const det = Csv.detect(rows, Csv.ARRIVAL_FIELDS, override);
    const missing = Csv.ARRIVAL_FIELDS.filter(function (f) { return f.required && det.map[f.key] === undefined; }).map(function (f) { return f.key; });
    const data = rows.slice(det.headerIndex + 1);
    if (data.length > MAX_ROWS) throw HttpError_(413, 'Too many rows (max ' + MAX_ROWS + ' per import)');
    const out = { fields: Csv.ARRIVAL_FIELDS.map(function (f) { return { key: f.key, label: f.label, required: f.required }; }), headers: det.headers, map: det.map, missing: missing, headerLine: det.headerIndex + 1, total: data.length, valid: [], errors: [], warnings: [] };
    if (missing.length) return out;
    const types = knownTypes();
    const seen = {};
    const unknownTypes = {};
    data.forEach(function (row, i) {
      const line = det.headerIndex + 2 + i;
      const m = det.map;
      const conf = cell(row, m, 'confirmation_no');
      const name = cell(row, m, 'guest_name');
      const arr = parseDateText_(cell(row, m, 'arrival_date'));
      const dep = parseDateText_(cell(row, m, 'departure_date'));
      const type = cell(row, m, 'room_type').toUpperCase();
      const adultsRaw = cell(row, m, 'adults');
      const childRaw = cell(row, m, 'children');
      const time = parseTimeText_(cell(row, m, 'arrival_time'));
      const errs = [];
      if (!conf) errs.push('missing confirmation number');
      else if (!/^[A-Za-z0-9\-\/]{1,30}$/.test(conf)) errs.push('confirmation number has unexpected characters');
      if (!name) errs.push('missing guest name');
      if (!arr) errs.push('arrival date not understood: "' + cell(row, m, 'arrival_date') + '"');
      if (!dep) errs.push('departure date not understood: "' + cell(row, m, 'departure_date') + '"');
      if (arr && dep && dep < arr) errs.push('departure is before arrival');
      if (!type) errs.push('missing room type');
      const adults = parseInt(adultsRaw, 10);
      if (isNaN(adults) || adults < 1 || adults > 20) errs.push('adults must be a number from 1 to 20');
      const children = childRaw === '' ? 0 : parseInt(childRaw, 10);
      if (isNaN(children) || children < 0 || children > 20) errs.push('children must be a number from 0 to 20');
      if (time === null) errs.push('arrival time not understood: "' + cell(row, m, 'arrival_time') + '"');
      if (errs.length) { out.errors.push({ line: line, message: errs.join('; '), confirmation: conf }); return; }
      if (seen[conf]) out.warnings.push({ line: line, message: 'duplicate confirmation ' + conf + ' in file: the later row is used' });
      seen[conf] = true;
      if (!types[type] && !unknownTypes[type]) { unknownTypes[type] = true; out.warnings.push({ line: line, message: 'room type "' + type + '" is not in the RoomTypes tab (imported anyway)' }); }
      const nights = m.nights !== undefined && cell(row, m, 'nights') !== '' ? toInt_(cell(row, m, 'nights'), '') : Math.round((Date.parse(dep) - Date.parse(arr)) / 86400000);
      out.valid.push({
        confirmation_no: conf, guest_name: clean_(name, 120), arrival_date: arr, arrival_time: time || '', departure_date: dep, room_type: type,
        adults: adults, children: children, phone: clean_(cell(row, m, 'phone'), 40), email: clean_(cell(row, m, 'email'), 120), nights: nights,
        rate_plan: clean_(cell(row, m, 'rate_plan'), 60), meal_plan: clean_(cell(row, m, 'meal_plan'), 60), nationality: clean_(cell(row, m, 'nationality'), 40),
        vip_code: clean_(cell(row, m, 'vip_code'), 20), special_requests: clean_(cell(row, m, 'special_requests'), 300),
      });
    });
    return out;
  }

  function summarize(a) {
    return {
      fields: a.fields, headers: a.headers, map: a.map, missing: a.missing, headerLine: a.headerLine,
      total: a.total, validCount: a.valid.length, errorCount: a.errors.length, warningCount: a.warnings.length,
      errors: a.errors.slice(0, 50), warnings: a.warnings.slice(0, 20), sample: a.valid.slice(0, 8),
    };
  }

  function previewArrivals(body) { return summarize(analyzeArrivals(body.csv, body.map)); }

  function commitArrivals(user, body) {
    const a = analyzeArrivals(body.csv, body.map);
    if (a.missing.length) throw HttpError_(400, 'Required columns are not mapped: ' + a.missing.join(', '));
    if (!a.valid.length) throw HttpError_(400, 'There are no valid rows to import');
    if (a.errors.length && !body.allowErrors) throw HttpError_(409, a.errors.length + ' row(s) have errors. Fix the file, or import the valid rows only.', { errorCount: a.errors.length });
    return Locks.run(function () {
      // last occurrence of a confirmation number wins
      const byConf = {};
      a.valid.forEach(function (r) { byConf[r.confirmation_no] = r; });
      const now = nowIso_();
      let added = 0, updated = 0;
      if (body.replaceAll) Store.clear('Reservations');
      const existing = {};
      Store.all('Reservations').forEach(function (r) { existing[r.confirmation_no] = r; });
      const inserts = [];
      Object.keys(byConf).forEach(function (k) {
        const rec = Object.assign({}, byConf[k], { imported_at: now });
        if (existing[k]) { Store.update('Reservations', existing[k]._row, rec); updated++; }
        else { inserts.push(rec); added++; }
      });
      Store.insertMany('Reservations', inserts);
      audit_(user, 'import.arrivals', added + ' added, ' + updated + ' updated, ' + a.errors.length + ' skipped' + (body.replaceAll ? ', replaced all' : ''));
      Store.bump();
      return { added: added, updated: updated, skipped: a.errors.length };
    });
  }

  function analyzeRooms(text, override) {
    limit(text);
    const rows = Csv.parse(text);
    const det = Csv.detect(rows, Csv.ROOM_FIELDS, override);
    const missing = Csv.ROOM_FIELDS.filter(function (f) { return f.required && det.map[f.key] === undefined; }).map(function (f) { return f.key; });
    const data = rows.slice(det.headerIndex + 1);
    if (data.length > MAX_ROWS) throw HttpError_(413, 'Too many rows (max ' + MAX_ROWS + ' per import)');
    const out = { fields: Csv.ROOM_FIELDS.map(function (f) { return { key: f.key, label: f.label, required: f.required }; }), headers: det.headers, map: det.map, missing: missing, headerLine: det.headerIndex + 1, total: data.length, valid: [], errors: [], warnings: [] };
    if (missing.length) return out;
    const seen = {};
    data.forEach(function (row, i) {
      const line = det.headerIndex + 2 + i;
      const m = det.map;
      const num = cell(row, m, 'room_number');
      const type = cell(row, m, 'room_type').toUpperCase();
      const hkRaw = cell(row, m, 'hk_status');
      const hk = hkRaw === '' ? 'dirty' : HK_MAP[Csv.norm(hkRaw)];
      const errs = [];
      if (!/^[A-Za-z0-9\-]{1,10}$/.test(num)) errs.push('room number missing or has unexpected characters');
      if (!type) errs.push('missing room type');
      if (!hk) errs.push('housekeeping status not understood: "' + hkRaw + '"');
      if (errs.length) { out.errors.push({ line: line, message: errs.join('; '), confirmation: num }); return; }
      if (seen[num]) out.warnings.push({ line: line, message: 'duplicate room ' + num + ' in file: the later row is used' });
      seen[num] = true;
      out.valid.push({ room_number: num, building: clean_(cell(row, m, 'building'), 40), floor: clean_(cell(row, m, 'floor'), 10), room_type: type, hk_status: hk });
    });
    return out;
  }

  function previewRooms(body) { return summarize(analyzeRooms(body.csv, body.map)); }

  function commitRooms(user, body) {
    const a = analyzeRooms(body.csv, body.map);
    if (a.missing.length) throw HttpError_(400, 'Required columns are not mapped: ' + a.missing.join(', '));
    if (!a.valid.length) throw HttpError_(400, 'There are no valid rows to import');
    if (a.errors.length && !body.allowErrors) throw HttpError_(409, a.errors.length + ' row(s) have errors. Fix the file, or import the valid rows only.', { errorCount: a.errors.length });
    return Locks.run(function () {
      const byNum = {};
      a.valid.forEach(function (r) { byNum[r.room_number] = r; });
      const existing = {};
      Store.all('Rooms').forEach(function (r) { existing[r.room_number] = r; });
      let added = 0, updated = 0;
      const inserts = [];
      Object.keys(byNum).forEach(function (k) {
        if (existing[k]) { Store.update('Rooms', existing[k]._row, byNum[k]); updated++; }
        else { inserts.push(byNum[k]); added++; }
      });
      Store.insertMany('Rooms', inserts);
      // room types seen in the file but unknown get a code-only entry so they show in pickers
      const types = knownTypes();
      const newTypes = [];
      Object.keys(byNum).forEach(function (k) {
        const t = byNum[k].room_type;
        if (!types[t]) { types[t] = true; newTypes.push({ code: t, name: t }); }
      });
      Store.insertMany('RoomTypes', newTypes);
      audit_(user, 'import.rooms', added + ' added, ' + updated + ' updated');
      Store.bump();
      return { added: added, updated: updated, skipped: a.errors.length };
    });
  }

  return { previewArrivals: previewArrivals, commitArrivals: commitArrivals, previewRooms: previewRooms, commitRooms: commitRooms };
})();
