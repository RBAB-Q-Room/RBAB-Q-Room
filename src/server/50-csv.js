/* =====================================================================
 * CSV parsing and column mapping for arrivals / room imports.
 * Excel files must be saved as CSV first (File > Save As > CSV).
 * ===================================================================== */

const Csv = (function () {
  /** RFC 4180 parser; delimiter auto-detected (comma, semicolon, tab). */
  function parse(text) {
    let s = String(text || '');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    const firstLine = s.split(/\r\n|\n|\r/, 1)[0] || '';
    const counts = { ',': 0, ';': 0, '\t': 0 };
    let q = false;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i];
      if (ch === '"') q = !q;
      else if (!q && counts[ch] !== undefined) counts[ch]++;
    }
    const delim = counts[';'] > counts[','] && counts[';'] >= counts['\t'] ? ';' : counts['\t'] > counts[','] ? '\t' : ',';
    const rows = [];
    let row = [], cell = '', inQ = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inQ) {
        if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
        else cell += c;
      } else if (c === '"') inQ = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && s[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        rows.push(row); row = [];
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
  }

  const norm = function (h) { return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, ''); };

  const ARRIVAL_FIELDS = [
    { key: 'confirmation_no', label: 'Confirmation number', required: true, aliases: ['confirmationnumber', 'confirmationno', 'confirmation', 'confno', 'confnumber', 'confirmationnum', 'resno', 'resnumber', 'reservationnumber', 'reservationno', 'cnfno', 'confirmationid'] },
    { key: 'guest_name', label: 'Guest name', required: true, aliases: ['guestname', 'name', 'fullname', 'guest', 'guestfullname', 'lastnamefirstname'] },
    { key: 'arrival_date', label: 'Arrival date', required: true, aliases: ['arrivaldate', 'arrival', 'arrdate', 'arr', 'checkindate', 'checkin'] },
    { key: 'departure_date', label: 'Departure date', required: true, aliases: ['departuredate', 'departure', 'depdate', 'dep', 'checkoutdate', 'checkout'] },
    { key: 'room_type', label: 'Room type', required: true, aliases: ['roomtype', 'roomtypecode', 'roomcategory', 'rtype', 'rt', 'resvroomtype', 'roomtypedescription', 'room'] },
    { key: 'adults', label: 'Adults', required: true, aliases: ['adults', 'adult', 'noofadults', 'numberofadults', 'adl', 'ad', 'pax', 'numadults'] },
    { key: 'children', label: 'Children', required: false, aliases: ['children', 'child', 'noofchildren', 'numberofchildren', 'chd', 'ch', 'kids', 'numchildren'] },
    { key: 'arrival_time', label: 'Arrival time / ETA', required: false, aliases: ['arrivaltime', 'eta', 'etatime', 'arrtime', 'estimatedarrivaltime', 'timeofarrival'] },
    { key: 'phone', label: 'Phone', required: false, aliases: ['phone', 'telephone', 'telephonenumber', 'mobile', 'mobilenumber', 'phoneno', 'phonenumber', 'tel', 'contactnumber', 'contactphone'] },
    { key: 'email', label: 'Email', required: false, aliases: ['email', 'emailaddress', 'mail', 'guestemail'] },
    { key: 'nights', label: 'Nights', required: false, aliases: ['nights', 'numberofnights', 'nonights', 'los', 'lengthofstay'] },
    { key: 'rate_plan', label: 'Rate plan', required: false, aliases: ['rateplan', 'ratecode', 'rate'] },
    { key: 'meal_plan', label: 'Meal plan', required: false, aliases: ['mealplan', 'board', 'boardtype', 'package', 'packages'] },
    { key: 'nationality', label: 'Nationality', required: false, aliases: ['nationality', 'country'] },
    { key: 'vip_code', label: 'VIP', required: false, aliases: ['vip', 'vipcode', 'viplevel', 'viplvl'] },
    { key: 'special_requests', label: 'Special requests', required: false, aliases: ['specialrequests', 'specialrequest', 'requests', 'comments', 'remarks', 'notes', 'reservationnotes'] },
  ];

  const ROOM_FIELDS = [
    { key: 'room_number', label: 'Room number', required: true, aliases: ['roomnumber', 'roomno', 'room', 'roomnum', 'number', 'rm'] },
    { key: 'room_type', label: 'Room type', required: true, aliases: ['roomtype', 'roomtypecode', 'type', 'roomcategory', 'rtype', 'rt'] },
    { key: 'building', label: 'Building', required: false, aliases: ['building', 'block', 'wing', 'tower'] },
    { key: 'floor', label: 'Floor', required: false, aliases: ['floor', 'level', 'storey'] },
    { key: 'hk_status', label: 'Housekeeping status', required: false, aliases: ['hkstatus', 'housekeepingstatus', 'status', 'roomstatus', 'hk'] },
  ];

  /**
   * Find the header row (Opera reports often have title lines above it) and
   * map columns. `override` = { fieldKey: columnIndex } wins over detection.
   */
  function detect(rows, fields, override) {
    let best = { idx: 0, hits: -1, map: {} };
    for (let r = 0; r < Math.min(rows.length, 15); r++) {
      const map = {};
      let hits = 0;
      const used = {};
      fields.forEach(function (f) {
        for (let c = 0; c < rows[r].length; c++) {
          if (used[c]) continue;
          if (f.aliases.indexOf(norm(rows[r][c])) !== -1) { map[f.key] = c; used[c] = true; hits++; break; }
        }
      });
      if (hits > best.hits) best = { idx: r, hits: hits, map: map };
    }
    const map = Object.assign({}, best.map);
    if (override) Object.keys(override).forEach(function (k) {
      const v = override[k];
      if (v === '' || v === null || v === undefined || v === -1) delete map[k];
      else if (fields.some(function (f) { return f.key === k; }) && +v >= 0) map[k] = +v;
    });
    return { headerIndex: best.idx, headers: rows[best.idx] || [], map: map };
  }

  return { parse: parse, detect: detect, ARRIVAL_FIELDS: ARRIVAL_FIELDS, ROOM_FIELDS: ROOM_FIELDS, norm: norm };
})();
