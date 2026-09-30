/* =====================================================================
 * Room list from the Room Guide project.
 * Room Guide publishes every room (building, floor, type, connecting room,
 * feature codes) in its data.js. We fetch that file and read it strictly as
 * JSON data: nothing from it is ever executed.
 * ===================================================================== */

const RoomGuide = (function () {
  const MAX_BYTES = 3000000;
  const SKIP_TYPES = { PI: true }; // "Posting Interface": not a bookable room

  /** Extract the RBAB_DATA object literal (pure JSON) from the data.js text. */
  function parse(text) {
    const s = String(text || '');
    const at = s.indexOf('RBAB_DATA');
    const start = s.indexOf('{', at);
    const end = s.lastIndexOf('}');
    if (at === -1 || start === -1 || end <= start) throw HttpError_(502, 'The Room Guide file does not contain room data');
    let data;
    try { data = JSON.parse(s.slice(start, end + 1)); } catch (e) { throw HttpError_(502, 'The Room Guide room data could not be read'); }
    if (!data || !data.buildings || !Array.isArray(data.buildingOrder)) throw HttpError_(502, 'The Room Guide room data has an unexpected format');
    const rooms = [];
    const types = {};
    data.buildingOrder.forEach(function (bk) {
      const b = data.buildings[bk];
      if (!b || !b.rooms) return;
      const floors = b.floors || {};
      Object.keys(b.rooms).forEach(function (k) {
        const r = b.rooms[k] || {};
        const num = String(r.room == null ? k : r.room).trim();
        const type = String(r.type || '').trim().toUpperCase();
        if (!/^[A-Za-z0-9-]{1,10}$/.test(num) || !/^[A-Z0-9/]{1,10}$/.test(type) || SKIP_TYPES[type]) return;
        const floorLabel = floors[r.floor] && floors[r.floor].label ? floors[r.floor].label : String(r.floor || '');
        rooms.push({
          room_number: num,
          building: clean_(b.label || bk, 40),
          floor: clean_(floorLabel, 30),
          room_type: type,
          description: clean_(r.description, 80),
          connecting: r.connecting ? clean_(String(r.connecting), 10) : '',
          features: (Array.isArray(r.codes) ? r.codes : []).map(function (c) { return String(c).replace(/[^A-Za-z0-9]/g, '').slice(0, 10); }).filter(Boolean).slice(0, 30).join(','),
        });
        if (r.description && !types[type]) types[type] = clean_(r.description, 80);
      });
    });
    if (!rooms.length) throw HttpError_(502, 'The Room Guide file has no rooms');
    return { rooms: rooms, types: types };
  }

  function fetchText(url) {
    let res;
    try { res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true }); }
    catch (e) { throw HttpError_(502, 'Could not reach the Room Guide at ' + url + '. Check the link in Settings.'); }
    if (res.getResponseCode() !== 200) throw HttpError_(502, 'The Room Guide link returned an error (' + res.getResponseCode() + '). Check the link in Settings.');
    const text = res.getContentText();
    if (text.length > MAX_BYTES) throw HttpError_(413, 'The Room Guide file is unexpectedly large');
    return text;
  }

  /**
   * Add or update every room from Room Guide. Housekeeping status already in the
   * sheet is kept. With removeMissing, rooms that are not in Room Guide are removed
   * (never a room held by an active Waiting Guest).
   */
  function sync(user, input) {
    input = input || {};
    const url = Config.get('room_guide_data_url');
    if (!url) throw HttpError_(400, 'Set the Room Guide data link in Settings first');
    const parsed = parse(fetchText(url));
    return Locks.run(function () {
      const existing = {};
      Store.all('Rooms').forEach(function (r) { existing[r.room_number] = r; });
      const seen = {};
      const inserts = [];
      let added = 0, updated = 0, removed = 0, kept = 0;
      parsed.rooms.forEach(function (r) {
        seen[r.room_number] = true;
        const rec = Object.assign({}, r, { source: 'room-guide' });
        const cur = existing[r.room_number];
        if (cur) {
          rec.hk_status = cur.hk_status; // keep live housekeeping status
          const same = ['building', 'floor', 'room_type', 'description', 'connecting', 'features', 'source'].every(function (k) { return String(cur[k]) === String(rec[k]); });
          if (!same) { Store.update('Rooms', cur._row, rec); updated++; }
        } else { rec.hk_status = ''; inserts.push(rec); added++; }
      });
      Store.insertMany('Rooms', inserts);
      if (input.removeMissing) {
        const held = {};
        Store.all('WaitingGuests').forEach(function (w) { if (w.room_number && ACTIVE_STATUSES.indexOf(w.status) !== -1) held[w.room_number] = true; });
        Store.reset();
        Store.all('Rooms').filter(function (r) { return !seen[r.room_number]; }).sort(function (a, b) { return b._row - a._row; }).forEach(function (r) {
          if (held[r.room_number]) { kept++; return; }
          Store.remove('Rooms', r._row); removed++;
        });
      }
      // room type names from Room Guide, only for codes the sheet does not know yet
      const knownTypes = {};
      Store.all('RoomTypes').forEach(function (t) { knownTypes[t.code] = t; });
      const newTypes = [];
      Object.keys(parsed.types).forEach(function (code) {
        const t = knownTypes[code];
        if (!t) newTypes.push({ code: code, name: parsed.types[code] });
        else if (!t.name || t.name === code) Store.update('RoomTypes', t._row, { name: parsed.types[code] });
      });
      Store.insertMany('RoomTypes', newTypes);
      audit_(user, 'rooms.sync', added + ' added, ' + updated + ' updated, ' + removed + ' removed from ' + url);
      Store.bump();
      return { total: parsed.rooms.length, added: added, updated: updated, removed: removed, keptHeld: kept, source: url };
    });
  }

  return { parse: parse, sync: sync };
})();
