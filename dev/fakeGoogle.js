'use strict';
/**
 * A faithful-enough fake of the Google Apps Script services this app uses,
 * for local development and automated tests. It deliberately reproduces the
 * behaviours that cause real-world bugs:
 *  - cells NOT formatted as plain text auto-convert "2026-09-29" to a Date,
 *    numeric text to a number (dropping leading zeros), and "=..." to a formula;
 *  - Utilities digests return SIGNED bytes;
 *  - the script lock can be forced busy.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');

function createGoogle({ persistFile = null, scriptUrl = 'https://script.google.com/macros/s/TEST/exec', htmlFile = null, timeZone = 'Asia/Dubai', bound = true } = {}) {
  // activeUser: the owner in the editor; '' for an anonymous web-app visitor (see requireEditor_).
  const state = { sheets: {}, props: {}, cache: new Map(), lockBusy: false, log: [], apiCalls: 0, activeUser: 'owner@example.com', owner: 'owner@example.com', bound, created: 0 };

  if (persistFile && fs.existsSync(persistFile)) {
    const saved = JSON.parse(fs.readFileSync(persistFile, 'utf8'));
    state.sheets = saved.sheets; state.props = saved.props || {};
  }
  const save = () => { if (persistFile) fs.writeFileSync(persistFile, JSON.stringify({ sheets: state.sheets, props: state.props })); };

  const key = (r, c) => r + ',' + c;
  const coerce = (v, text) => {
    if (v === null || v === undefined) return '';
    if (text) return String(v);              // '@' format: stored verbatim as text
    if (typeof v === 'string') {
      if (/^=/.test(v)) return '#NAME?';       // formula evaluated
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return { __date: v };   // auto-parsed to a date
      if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);           // auto-parsed to a number
    }
    return v;
  };
  const read = (cell) => (cell && cell.__date ? new Date(cell.__date + 'T00:00:00Z') : cell === undefined ? '' : cell);

  function makeSheet(name) {
    const sd = state.sheets[name] || (state.sheets[name] = { cells: {}, fmt: {}, maxRows: 1000, maxCols: 26, frozen: 0 });
    const lastRow = () => { let m = 0; for (const k of Object.keys(sd.cells)) { const [r] = k.split(',').map(Number); if (sd.cells[k] !== '' && r > m) m = r; } return m; };
    const lastCol = () => { let m = 0; for (const k of Object.keys(sd.cells)) { const c = Number(k.split(',')[1]); if (sd.cells[k] !== '' && c > m) m = c; } return m; };
    const range = (r, c, nr = 1, nc = 1) => {
      const api = {
        getValues: () => { state.apiCalls++; const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(read(sd.cells[key(r + i, c + j)])); out.push(row); } return out; },
        setValues: (vals) => {
          state.apiCalls++;
          if (vals.length !== nr || vals.some((row) => row.length !== nc)) throw new Error('Range dimensions do not match values');
          for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sd.cells[key(r + i, c + j)] = coerce(vals[i][j], sd.fmt[key(r + i, c + j)] === '@');
          sd.maxRows = Math.max(sd.maxRows, r + nr - 1); save(); return api;
        },
        setNumberFormat: (f) => { state.apiCalls++; for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) sd.fmt[key(r + i, c + j)] = f; sd.maxRows = Math.max(sd.maxRows, r + nr - 1); return api; },
        setFontWeight: () => api,
      };
      return api;
    };
    const sheet = {
      getLastRow: lastRow, getLastColumn: lastCol, getMaxRows: () => sd.maxRows,
      getRange: range, setFrozenRows: (n) => { sd.frozen = n; },
      insertRowsAfter: (after, n) => { sd.maxRows += n; save(); },
      deleteRow: (r) => sheet.deleteRows(r, 1),
      deleteRows: (r, n) => {
        state.apiCalls++;
        // Real Sheets: "You can't delete all the non-frozen rows in a sheet."
        if (r <= sd.frozen + 1 && r + n - 1 >= sd.maxRows) throw new Error("You can't delete all the non-frozen rows in a sheet.");
        const next = {};
        for (const k of Object.keys(sd.cells)) { const [rr, cc] = k.split(',').map(Number); if (rr < r) next[k] = sd.cells[k]; else if (rr >= r + n) next[key(rr - n, cc)] = sd.cells[k]; }
        sd.cells = next; save();
      },
    };
    return sheet;
  }

  const SpreadsheetApp = {
    getActive: () => (state.bound ? SpreadsheetApp._book : null),
    create: () => { state.created++; return Object.assign({ getId: () => 'SHEET_ID_1', getUrl: () => 'https://docs.google.com/spreadsheets/d/SHEET_ID_1/edit' }, SpreadsheetApp._book); },
    openById: () => SpreadsheetApp._book,
    _book: {
      getSheetByName: (n) => (state.sheets[n] ? makeSheet(n) : null),
      insertSheet: (n) => { if (state.sheets[n]) throw new Error('Sheet exists'); const s = makeSheet(n); save(); return s; },
    },
  };

  const signed = (buf) => Array.from(buf).map((b) => (b > 127 ? b - 256 : b));
  const Utilities = {
    DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
    getUuid: () => crypto.randomUUID(),
    computeDigest: (algo, value) => signed(crypto.createHash('sha256').update(String(value)).digest()),
    computeHmacSha256Signature: (value, k) => signed(crypto.createHmac('sha256', String(k)).update(String(value)).digest()),
    formatDate: (d, tz, fmt) => {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d)
        .reduce((a, p) => { a[p.type] = p.value; return a; }, {});
      return fmt.replace("yyyy", parts.year).replace("MM", parts.month).replace("dd", parts.day).replace("HH", parts.hour).replace("mm", parts.minute).replace("ss", parts.second);
    },
  };

  const CacheService = {
    getScriptCache: () => ({
      get: (k) => { const e = state.cache.get(k); if (!e) return null; if (e.exp < Date.now()) { state.cache.delete(k); return null; } return e.v; },
      put: (k, v, ttl = 600) => { state.cache.set(k, { v: String(v), exp: Date.now() + ttl * 1000 }); },
      remove: (k) => { state.cache.delete(k); },
    }),
  };

  const LockService = {
    getScriptLock: () => ({
      held: false,
      tryLock() { if (state.lockBusy) return false; this.held = true; return true; },
      releaseLock() { this.held = false; },
    }),
  };

  const PropertiesService = { getScriptProperties: () => ({ getProperty: (k) => (k in state.props ? state.props[k] : null), setProperty: (k, v) => { state.props[k] = v; save(); } }) };
  const triggers = [];
  const ScriptApp = {
    getService: () => ({ getUrl: () => scriptUrl }),
    getProjectTriggers: () => triggers,
    deleteTrigger: (t) => { const i = triggers.indexOf(t); if (i >= 0) triggers.splice(i, 1); },
    newTrigger: (fn) => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ create: () => { const t = { getHandlerFunction: () => fn, getUniqueId: () => 'TRIG' + (triggers.length + 1) }; triggers.push(t); return t; } }) }) }) }),
  };
  const Session = {
    getScriptTimeZone: () => timeZone,
    getActiveUser: () => ({ getEmail: () => state.activeUser }),
    getEffectiveUser: () => ({ getEmail: () => state.owner }),
  };
  const Logger = { log: (m) => { state.log.push(String(m)); } };
  const HtmlService = {
    XFrameOptionsMode: { DEFAULT: 'DEFAULT' },
    createTemplateFromFile: () => {
      const tpl = { evaluate: () => {
        const out = { title: '', meta: {}, setTitle(t) { this.title = t; return this; }, addMetaTag(k, v) { if (k !== 'viewport') throw new Error("The meta tag that you've specified is not allowed in this context."); this.meta[k] = v; return this; }, setXFrameOptionsMode() { return this; },
          getContent: () => fs.readFileSync(htmlFile, 'utf8').replace(/<\?!= boot \?>/g, tpl.boot) };
        return out;
      } };
      return tpl;
    },
  };

  return { globals: { SpreadsheetApp, Utilities, CacheService, LockService, PropertiesService, ScriptApp, Session, Logger, HtmlService, console }, state };
}

module.exports = { createGoogle };
