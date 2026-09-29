/* =====================================================================
 * Store: thin typed layer over the Google Sheet (one tab = one table).
 *
 * Design rules that avoid classic Sheets pitfalls:
 *  - Every column is formatted as plain text ('@'), so Sheets never turns
 *    "2026-09-29" into a date, drops the leading zero of a phone number,
 *    rounds a long confirmation number, or evaluates "=..." as a formula.
 *  - Values are always written as strings and parsed on read.
 *  - All writes happen inside Locks.run(), which re-reads fresh data, so two
 *    staff members clicking at once can never double-assign a room or get
 *    the same Waiting Guest number.
 *  - A version counter is bumped on every write; screens poll it cheaply.
 * ===================================================================== */

const Store = (function () {
  let ss = null;
  let memo = {};

  function spreadsheet() {
    if (ss) return ss;
    try { ss = SpreadsheetApp.getActive(); } catch (e) { ss = null; }
    if (!ss) {
      const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
      if (!id) throw HttpError_(500, 'The system is not set up yet. The owner must run setup() in the Apps Script editor.');
      ss = SpreadsheetApp.openById(id);
    }
    return ss;
  }

  function sheet(name) {
    const sh = spreadsheet().getSheetByName(name);
    if (!sh) throw HttpError_(500, 'The "' + name + '" tab is missing. Run setup() once from the Apps Script editor.');
    return sh;
  }

  function fromCell(v, t) {
    if (v instanceof Date) v = Utilities.formatDate(v, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'"); // defensive: Sheets auto-parsed a value
    if (t === 'i') { const n = parseInt(String(v).trim(), 10); return isNaN(n) ? 0 : n; }
    if (t === 'b') return v === true || v === 1 || String(v).trim() === '1' || String(v).toUpperCase() === 'TRUE';
    return v === null || v === undefined ? '' : String(v);
  }

  function toCell(v, t) {
    if (t === 'i') return v === '' || v === null || v === undefined ? '' : String(parseInt(v, 10));
    if (t === 'b') return v ? '1' : '';
    return v === null || v === undefined ? '' : String(v);
  }

  function rowToObj(cols, arr, rowNo) {
    const o = { _row: rowNo };
    for (let i = 0; i < cols.length; i++) o[cols[i][0]] = fromCell(arr[i], cols[i][1]);
    return o;
  }

  function objToRow(cols, o) {
    return cols.map(function (c) { return toCell(o[c[0]], c[1]); });
  }

  function all(name) {
    if (memo[name]) return memo[name];
    const cols = SCHEMA[name];
    const sh = sheet(name);
    const last = Math.max(sh.getLastRow(), 1);
    // One read gets the header row and the data. Positions are used, so the header must be intact.
    const vals = sh.getRange(1, 1, last, cols.length).getValues();
    for (let c = 0; c < cols.length; c++) {
      if (String(vals[0][c]) !== cols[c][0]) {
        throw HttpError_(500, 'The header row of the "' + name + '" tab was changed (column ' + (c + 1) + ' should be "' + cols[c][0] + '"). Restore it, or run setup().');
      }
    }
    let rows = [];
    for (let i = 1; i < vals.length; i++) {
      // skip fully blank rows
      let blank = true;
      for (let j = 0; j < vals[i].length; j++) if (String(vals[i][j]) !== '') { blank = false; break; }
      if (!blank) rows.push(rowToObj(cols, vals[i], i + 1));
    }
    memo[name] = rows;
    return rows;
  }

  function insert(name, obj) {
    const cols = SCHEMA[name];
    const sh = sheet(name);
    const rowNo = sh.getLastRow() + 1;
    // Rows added beyond the formatted area would default to "General" and get auto-converted, so format first.
    sh.getRange(rowNo, 1, 1, cols.length).setNumberFormat('@').setValues([objToRow(cols, obj)]);
    const o = rowToObj(cols, objToRow(cols, obj), rowNo);
    if (memo[name]) memo[name].push(o);
    return o;
  }

  function insertMany(name, objs) {
    if (!objs.length) return;
    const cols = SCHEMA[name];
    const sh = sheet(name);
    const start = sh.getLastRow() + 1;
    sh.getRange(start, 1, objs.length, cols.length).setNumberFormat('@').setValues(objs.map(function (o) { return objToRow(cols, o); }));
    memo[name] = null;
  }

  function update(name, rowNo, patch) {
    const cols = SCHEMA[name];
    const cur = all(name).filter(function (r) { return r._row === rowNo; })[0];
    if (!cur) throw HttpError_(404, 'Row not found');
    const next = Object.assign({}, cur, patch);
    const cells = objToRow(cols, next);
    sheet(name).getRange(rowNo, 1, 1, cols.length).setValues([cells]);
    const fresh = rowToObj(cols, cells, rowNo);
    Object.keys(fresh).forEach(function (k) { cur[k] = fresh[k]; });
    return cur;
  }

  /** Sheets refuses to delete every non-frozen row, so always keep an empty row below the data. */
  function slack(sh) {
    if (sh.getMaxRows() - sh.getLastRow() < 2) sh.insertRowsAfter(sh.getMaxRows(), 2);
  }

  function remove(name, rowNo) {
    const sh = sheet(name);
    slack(sh);
    sh.deleteRow(rowNo);
    memo[name] = null;
  }

  /** Replace every data row of a table (used by "replace all" imports). */
  function clear(name) {
    const sh = sheet(name);
    const last = sh.getLastRow();
    if (last >= 2) { slack(sh); sh.deleteRows(2, last - 1); }
    memo[name] = null;
  }

  function find(name, col, val) {
    const rows = all(name);
    for (let i = 0; i < rows.length; i++) if (rows[i][col] === val) return rows[i];
    return null;
  }

  // ---- key/value tables ------------------------------------------------
  function kvGet(name, key) {
    const r = find(name, 'key', key);
    return r ? r.value : null;
  }
  function kvSet(name, key, value) {
    const r = find(name, 'key', key);
    if (r) update(name, r._row, { value: String(value) });
    else insert(name, { key: key, value: String(value) });
  }

  // ---- version counter (screens poll this; cheap, cached) ---------------
  function version() {
    const cache = CacheService.getScriptCache();
    const c = cache.get('wg:ver');
    if (c !== null && c !== undefined) return parseInt(c, 10);
    const v = parseInt(kvGet('Meta', 'version') || '0', 10);
    cache.put('wg:ver', String(v), 21600);
    return v;
  }
  function bump() {
    const v = parseInt(kvGet('Meta', 'version') || '0', 10) + 1;
    kvSet('Meta', 'version', v);
    CacheService.getScriptCache().put('wg:ver', String(v), 21600);
    return v;
  }

  // ---- setup ------------------------------------------------------------
  /** For a standalone script (not opened from a Sheet): create the database sheet once. */
  function bootstrap() {
    let bound = null;
    try { bound = SpreadsheetApp.getActive(); } catch (e) { bound = null; }
    const props = PropertiesService.getScriptProperties();
    if (bound || props.getProperty('SPREADSHEET_ID')) return false;
    const created = SpreadsheetApp.create('Waiting Guest Database');
    props.setProperty('SPREADSHEET_ID', created.getId());
    ss = created;
    return true;
  }

  function ensureSchema() {
    const book = spreadsheet();
    Object.keys(SCHEMA).forEach(function (name) {
      const cols = SCHEMA[name];
      let sh = book.getSheetByName(name);
      if (!sh) sh = book.insertSheet(name);
      const width = cols.length;
      const rows = Math.max(sh.getMaxRows(), 1000);
      sh.getRange(1, 1, rows, width).setNumberFormat('@'); // plain text, always
      sh.getRange(1, 1, 1, width).setValues([cols.map(function (c) { return c[0]; })]).setFontWeight('bold');
      sh.setFrozenRows(1);
    });
    memo = {};
  }

  function reset() { memo = {}; }

  return { all: all, insert: insert, insertMany: insertMany, update: update, remove: remove, clear: clear, find: find,
    kvGet: kvGet, kvSet: kvSet, version: version, bump: bump, ensureSchema: ensureSchema, bootstrap: bootstrap, reset: reset, spreadsheet: spreadsheet };
})();

const Locks = {
  /** Run fn while holding the script-wide lock, with fresh reads. */
  run: function (fn) {
    const lock = LockService.getScriptLock();
    let got = false;
    try { got = lock.tryLock(20000); } catch (e) { got = false; }
    if (!got) throw HttpError_(503, 'The system is busy. Please try again in a moment.');
    try {
      Store.reset();
      return fn();
    } finally {
      lock.releaseLock();
    }
  },
};

const Config = {
  get: function (key) {
    const v = Store.kvGet('Config', key);
    return v === null || v === '' ? (CONFIG_DEFAULTS[key] === undefined ? '' : CONFIG_DEFAULTS[key]) : v;
  },
  num: function (key) { return toInt_(Config.get(key), toInt_(CONFIG_DEFAULTS[key], 0)); },
};

function audit_(user, action, detail) {
  Store.insert('Audit', { at: nowIso_(), user_id: user ? user.id : '', action: action, detail: clean_(detail, 500) });
}
