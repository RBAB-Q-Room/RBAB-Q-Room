/* =====================================================================
 * Waiting Guest: shared utilities.
 * Runs inside Google Apps Script (V8). Keep this file free of Node APIs.
 * ===================================================================== */

/** Error that maps to an HTTP-like status returned to the client. */
function HttpError_(status, message, extra) {
  const e = new Error(message);
  e.name = 'HttpError';
  e.status = status;
  e.extra = extra || null;
  return e;
}

function nowIso_() { return new Date().toISOString(); }

/** Trim, cap length, empty -> ''. Always returns a string. */
function clean_(v, max) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max || 200);
}

function toInt_(v, dflt) {
  const n = parseInt(String(v === null || v === undefined ? '' : v).trim(), 10);
  return isNaN(n) ? (dflt === undefined ? 0 : dflt) : n;
}

/** Signed byte array (what Utilities returns) -> lowercase hex. */
function bytesToHex_(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

function sha256Hex_(text) {
  return bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8));
}

/** 244 bits of randomness as 64 hex chars (two v4 UUIDs, no dashes). */
function randomToken_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

/** Human-friendly random password, no ambiguous characters. */
function randomPassword_(len) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const hex = randomToken_();
  let out = '';
  for (let i = 0; i < (len || 14); i++) out += alphabet.charAt(parseInt(hex.substr(i * 2, 2), 16) % alphabet.length);
  return out;
}

/** Guard against spreadsheet formula injection when exporting to CSV/Sheets. */
function csvSafe_(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

function csvLine_(cells) {
  return cells.map(function (c) {
    const s = csvSafe_(c);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',');
}

function isoDate_(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return y + '-' + (m < 10 ? '0' : '') + m + '-' + (d < 10 ? '0' : '') + d;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/**
 * Parse the date formats an Opera export is likely to contain into YYYY-MM-DD.
 * Numeric day/month order is DAY FIRST (dd/mm/yyyy), as used in the UAE.
 * Returns null when the text is not a real date.
 */
function parseDateText_(raw) {
  const s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!s) return null;
  let m;
  if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})(?:[T ].*)?$/))) return isoDate_(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2}|\d{4})$/))) return isoDate_(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  if ((m = s.match(/^(\d{1,2})[-\/. ]([A-Za-z]{3,9})[-\/. ,]+(\d{2}|\d{4})$/))) {
    const mon = MONTHS[m[2].toLowerCase().slice(0, 4)] || MONTHS[m[2].toLowerCase().slice(0, 3)];
    return mon ? isoDate_(m[3].length === 2 ? 2000 + +m[3] : +m[3], mon, +m[1]) : null;
  }
  if ((m = s.match(/^(\d{5})$/))) { // Excel serial date
    const dt = new Date(Date.UTC(1899, 11, 30) + parseInt(m[1], 10) * 86400000);
    return isoDate_(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  return null;
}

/** Parse 10:40, 9:05, 10:40:00, 10:40 AM, 1:15pm into HH:MM. '' when empty, null when invalid. */
function parseTimeText_(raw) {
  const s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!s) return '';
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/);
  if (!m) return null;
  let h = +m[1];
  const mi = +m[2];
  if (m[3]) {
    const pm = m[3].toLowerCase() === 'pm';
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (pm ? 12 : 0);
  }
  if (h > 23 || mi > 59) return null;
  return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
}

function todayIso_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
