/* =====================================================================
 * API router. One entry point: handle(token, method, pathWithQuery, body).
 * Returns { status, body }. Never throws to the caller.
 * The same router serves the Apps Script web app and the local dev server.
 * ===================================================================== */

const Api = (function () {
  const STAFF = ['reception', 'rooms_controller', 'admin'];

  function parsePath(p) {
    const s = String(p || '');
    const qi = s.indexOf('?');
    const path = qi === -1 ? s : s.slice(0, qi);
    const query = {};
    if (qi !== -1) s.slice(qi + 1).split('&').forEach(function (kv) {
      if (!kv) return;
      const i = kv.indexOf('=');
      try {
        const k = decodeURIComponent(i === -1 ? kv : kv.slice(0, i));
        query[k] = i === -1 ? '' : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' '));
      } catch (e) { throw HttpError_(400, 'Bad request'); }
    });
    return { path: path, query: query };
  }

  function roomTypeMap() {
    const m = {};
    Store.all('RoomTypes').forEach(function (r) { m[r.code] = r.name; });
    return m;
  }

  const safeUrl = function (u) { return /^https?:\/\/[^\s"'<>]+$/i.test(String(u || '').trim()) ? String(u).trim() : null; };

  /** Text in every language, each falling back to English when the hotel left a translation blank. */
  function multi(row, field) {
    const out = { en: row[field] };
    ['ar', 'ru', 'de'].forEach(function (l) { out[l] = row[field + '_' + l] || row[field]; });
    return out;
  }

  function guestContent() {
    const showPlaceholders = Config.get('guest_show_placeholders') !== '0';
    const welcome = { en: Config.get('guest_welcome') };
    ['ar', 'ru', 'de'].forEach(function (l) { welcome[l] = Config.get('guest_welcome_' + l) || welcome.en; });
    return {
      hotelName: Config.get('hotel_name'),
      welcome: welcome,
      links: {
        map: { url: safeUrl(Config.get('hotel_map_url')) },
        website: { url: safeUrl(Config.get('hotel_website_url')) },
      },
      sections: Store.all('GuestContent').filter(function (s) { return s.active && (!s.placeholder || showPlaceholders); }).sort(function (a, b) { return a.sort - b.sort; })
        .map(function (s) {
          return { id: s.id, icon: s.icon, placeholder: s.placeholder, title: multi(s, 'title'), body: multi(s, 'body'), note: multi(s, 'note'),
            highlight: s.highlight ? multi(s, 'highlight') : null };
        }),
    };
  }

  /** Everything the guest page needs in one object. Used by the API and to pre-render the page in doGet. */
  function guestPayload(token) {
    const view = Waiting.guestView(token);
    if (!view) return null;
    return { waitingGuest: view, content: view.phase === 'expired' ? null : guestContent(), version: Store.version() };
  }

  function setting(key, raw) {
    const spec = SETTINGS_SPEC[key];
    const v = raw === null || raw === undefined ? '' : String(raw).trim();
    const label = key.replace(/_/g, ' ');
    if (spec.type === 'bool') return v === '1' || v === 'true' ? '1' : '0';
    if (spec.type === 'url') {
      if (!v) return '';
      if (!safeUrl(v) || v.length > 300) throw HttpError_(400, 'Enter a full web address starting with https:// for ' + label, { field: key });
      return v;
    }
    if (spec.type === 'prefix') {
      if (!/^[A-Za-z]{1,4}$/.test(v)) throw HttpError_(400, 'The Waiting Guest prefix must be 1 to 4 letters', { field: key });
      return v.toUpperCase();
    }
    if (spec.type === 'int' || spec.type === 'num') {
      if (!v && spec.type === 'num') return '';
      const n = Number(v);
      if (!isFinite(n) || n < spec.min || n > spec.max || (spec.type === 'int' && Math.floor(n) !== n)) {
        throw HttpError_(400, 'Enter a number from ' + spec.min + ' to ' + spec.max + ' for ' + label, { field: key });
      }
      return String(n);
    }
    const t = clean_(v, spec.max || 200);
    if (spec.required && !t) throw HttpError_(400, label + ' is required', { field: key });
    return t;
  }

  function settingsView() {
    const values = {};
    Object.keys(SETTINGS_SPEC).forEach(function (k) { values[k] = Config.get(k); });
    return { values: values, placeholders: Store.all('GuestContent').filter(function (s) { return s.active && s.placeholder; }).length };
  }

  function saveSettings(user, input) {
    input = input || {};
    return Locks.run(function () {
      const clean = {};
      Object.keys(input).forEach(function (k) { if (SETTINGS_SPEC[k]) clean[k] = setting(k, input[k]); });
      const warn = toInt_(clean.late_warn_minutes !== undefined ? clean.late_warn_minutes : Config.get('late_warn_minutes'), 30);
      const alert = toInt_(clean.late_alert_minutes !== undefined ? clean.late_alert_minutes : Config.get('late_alert_minutes'), 60);
      if (alert <= warn) throw HttpError_(400, 'The long-wait threshold must be higher than the attention threshold', { field: 'late_alert_minutes' });
      Object.keys(clean).forEach(function (k) { Store.kvSet('Config', k, clean[k]); });
      audit_(user, 'settings.save', Object.keys(clean).join(', '));
      Store.bump();
      return settingsView();
    });
  }

  const CONTENT_FIELDS = ['title', 'body', 'note', 'highlight'];
  const CONTENT_MAX = { title: 60, body: 600, note: 200, highlight: 120 };

  function contentView() {
    return { sections: Store.all('GuestContent').sort(function (a, b) { return a.sort - b.sort; }).map(function (s) {
      const o = { id: s.id, icon: s.icon, sort: s.sort, active: s.active, placeholder: s.placeholder };
      CONTENT_FIELDS.forEach(function (f) { o[f] = s[f]; ['ar', 'ru', 'de'].forEach(function (l) { o[f + '_' + l] = s[f + '_' + l]; }); });
      return o;
    }) };
  }

  function saveContent(user, input) {
    input = input || {};
    return Locks.run(function () {
      const row = Store.find('GuestContent', 'id', String(input.id || ''));
      if (!row) throw HttpError_(404, 'Section not found');
      const patch = {};
      CONTENT_FIELDS.forEach(function (f) {
        ['', '_ar', '_ru', '_de'].forEach(function (l) { if (input[f + l] !== undefined) patch[f + l] = clean_(input[f + l], CONTENT_MAX[f]); });
      });
      if (patch.title !== undefined && !patch.title) throw HttpError_(400, 'The English title is required', { field: 'title' });
      // When the English text changes, drop translations that are still the original placeholder
      // wording, so those guests see the new English text instead of stale placeholder text.
      const defaults = DEFAULT_GUEST_CONTENT.filter(function (d) { return d.id === row.id; })[0];
      if (defaults) {
        ['title', 'body', 'note'].forEach(function (f) {
          if (patch[f] === undefined || patch[f] === row[f]) return;
          ['ar', 'ru', 'de'].forEach(function (l) {
            const original = defaults[f] && defaults[f][l];
            if (input[f + '_' + l] === undefined && original && row[f + '_' + l] === original) patch[f + '_' + l] = '';
          });
        });
      }
      if (input.active !== undefined) patch.active = !!input.active;
      if (input.placeholder !== undefined) patch.placeholder = !!input.placeholder;
      Store.update('GuestContent', row._row, patch);
      audit_(user, 'content.save', row.id);
      Store.bump();
      return contentView();
    });
  }

  function route(token, method, path, query, body) {
    let m;
    body = body || {};

    // ---- public: guest page (the unguessable token is the only credential) ----
    if ((m = path.match(/^\/api\/guest\/([A-Za-z0-9_-]+)$/)) && method === 'GET') {
      const v = Store.version();
      if (query.v !== undefined && String(query.v) === String(v) && query.have === '1') return { status: 200, body: { unchanged: true, version: v } };
      // seen=1: the page is visible on the guest's screen (records first QR opening / first sight of "room ready")
      if (query.seen === '1') Waiting.markSeen(m[1]);
      const payload = guestPayload(m[1]);
      if (!payload) throw HttpError_(404, 'This link is not valid');
      return { status: 200, body: payload };
    }
    if ((m = path.match(/^\/api\/guest\/([A-Za-z0-9_-]+)\/feedback$/)) && method === 'POST') {
      return { status: 200, body: Waiting.feedback(m[1], body) };
    }
    if (path === '/api/login' && method === 'POST') {
      const out = Auth.login(body.username, body.password);
      return { status: 200, body: out };
    }
    if (path === '/api/logout' && method === 'POST') { Auth.logout(token); return { status: 200, body: { ok: true } }; }

    // ---- everything below needs a signed-in staff user ----
    const user = Auth.userFromToken(token);
    if (!user) throw HttpError_(401, 'Sign in required');
    const need = function (roles) { if (roles.indexOf(user.role) === -1) throw HttpError_(403, 'Not allowed for your role'); };

    if (path === '/api/me' && method === 'GET') return { status: 200, body: { user: user } };
    if (path === '/api/me/password' && method === 'POST') return { status: 200, body: Auth.changeOwnPassword(user, body.current, body.next) };
    if (path === '/api/version' && method === 'GET') return { status: 200, body: { version: Store.version() } };
    if (path === '/api/meta' && method === 'GET') {
      return { status: 200, body: {
        roomTypes: roomTypeMap(), statuses: STATUSES, provider: ReservationSource.name,
        lateWarnMinutes: Config.num('late_warn_minutes'), lateAlertMinutes: Config.num('late_alert_minutes'), hotelName: Config.get('hotel_name'),
      } };
    }
    if (path === '/api/metrics' && method === 'GET') return { status: 200, body: Waiting.metrics(query.range) };

    if (path === '/api/search' && method === 'GET') { need(['reception']); return { status: 200, body: Waiting.search(query.q) }; }
    if (path === '/api/waiting-guests' && method === 'GET') return { status: 200, body: { active: Waiting.queue(), completed: Waiting.recentClosed(15) } };
    if (path === '/api/waiting-guests' && method === 'POST') return { status: 201, body: { waitingGuest: Waiting.create(user, body.confirmationNo, body) } };

    if ((m = path.match(/^\/api\/waiting-guests\/(\d+)(?:\/([a-z-]+))?$/))) {
      const id = parseInt(m[1], 10), sub = m[2];
      if (!sub && method === 'GET') {
        const wg = Waiting.get(id);
        return { status: 200, body: { waitingGuest: wg, history: Waiting.history(id), rooms: user.role === 'rooms_controller' ? Waiting.availableRooms(id) : undefined } };
      }
      if (sub === 'qr' && method === 'GET') {
        const url = Links.guestUrl(Store.find('WaitingGuests', 'id', id) ? Store.find('WaitingGuests', 'id', id).qr_token : '');
        if (!Store.find('WaitingGuests', 'id', id)) throw HttpError_(404, 'Waiting Guest not found');
        return { status: 200, body: { url: url, svg: qrSvg_(url) } };
      }
      if (sub === 'assign-room' && method === 'POST') return { status: 200, body: { waitingGuest: Waiting.assignRoom(user, id, body.roomNumber, !!body.manual) } };
      if (sub === 'undo-ready' && method === 'POST') return { status: 200, body: { waitingGuest: Waiting.undoReady(user, id, body.reason) } };
      if (sub === 'status' && method === 'POST') return { status: 200, body: { waitingGuest: Waiting.setStatus(user, id, body.status) } };
      if (sub === 'priority' && method === 'POST') return { status: 200, body: { waitingGuest: Waiting.setPriority(user, id, !!body.priority) } };
      if (sub === 'details' && method === 'POST') return { status: 200, body: { waitingGuest: Waiting.editDetails(user, id, body) } };
      if (sub === 'cancel' && method === 'POST') return { status: 200, body: { waitingGuest: Waiting.cancel(user, id, body.reason) } };
    }

    // ---- admin ----
    if (path === '/api/users' && method === 'GET') { need(['admin']); return { status: 200, body: { users: Auth.listUsers() } }; }
    if (path === '/api/users' && method === 'POST') { need(['admin']); return { status: 201, body: Auth.createUser(user, body) }; }
    if ((m = path.match(/^\/api\/users\/(\d+)\/(active|reset-password|update|delete)$/)) && method === 'POST') {
      need(['admin']);
      const uid = parseInt(m[1], 10);
      const fn = { active: function () { return Auth.setActive(user, uid, !!body.active); }, 'reset-password': function () { return Auth.resetPassword(user, uid); },
        update: function () { return Auth.updateUser(user, uid, body); }, delete: function () { return Auth.deleteUser(user, uid); } }[m[2]];
      return { status: 200, body: fn() };
    }
    if (path === '/api/admin/records' && method === 'GET') { need(['admin']); return { status: 200, body: { records: Waiting.adminList(query.q, query.status) } }; }
    if ((m = path.match(/^\/api\/admin\/records\/(\d+)(?:\/(status|delete))?$/)) && method === 'POST') {
      need(['admin']);
      const rid = parseInt(m[1], 10);
      if (!m[2]) return { status: 200, body: { waitingGuest: Waiting.adminUpdate(user, rid, body) } };
      if (m[2] === 'status') return { status: 200, body: { waitingGuest: Waiting.correctStatus(user, rid, body.status, body.roomNumber, body.reason) } };
      return { status: 200, body: Waiting.adminDelete(user, rid, body.confirm) };
    }
    if (path === '/api/admin/rooms/sync' && method === 'POST') { need(['admin']); return { status: 200, body: RoomGuide.sync(user, body) }; }
    if (path === '/api/admin/reset' && method === 'POST') { need(['admin']); return { status: 200, body: Waiting.resetAll(user, body) }; }
    if (path === '/api/import/arrivals/preview' && method === 'POST') { need(['admin']); return { status: 200, body: Importer.previewArrivals(body) }; }
    if (path === '/api/import/arrivals' && method === 'POST') { need(['admin']); return { status: 200, body: Importer.commitArrivals(user, body) }; }
    if (path === '/api/import/rooms/preview' && method === 'POST') { need(['admin']); return { status: 200, body: Importer.previewRooms(body) }; }
    if (path === '/api/import/rooms' && method === 'POST') { need(['admin']); return { status: 200, body: Importer.commitRooms(user, body) }; }
    if (path === '/api/admin/settings' && method === 'GET') { need(['admin']); return { status: 200, body: settingsView() }; }
    if (path === '/api/admin/settings' && method === 'POST') { need(['admin']); return { status: 200, body: saveSettings(user, body.values) }; }
    if (path === '/api/admin/guest-content' && method === 'GET') { need(['admin']); return { status: 200, body: contentView() }; }
    if (path === '/api/admin/guest-content' && method === 'POST') { need(['admin']); return { status: 200, body: saveContent(user, body) }; }
    if (path === '/api/export/waiting-guests' && method === 'GET') { need(['admin']); return { status: 200, body: { csv: Waiting.exportCsv() } }; }
    if (path === '/api/admin/summary' && method === 'GET') {
      need(['admin']);
      return { status: 200, body: { reservations: Store.all('Reservations').length, rooms: Store.all('Rooms').length, users: Auth.listUsers().length,
        arrivalsToday: Store.all('Reservations').filter(function (r) { return r.arrival_date === todayIso_(); }).length, today: todayIso_(), guestBase: Links.base(),
        active: Waiting.queue() } };
    }
    throw HttpError_(404, 'Not found');
  }

  function handle(token, method, pathWithQuery, body) {
    try {
      Store.reset();
      ensureCurrent_(); // upgrades the sheet once after new code is deployed
      const p = parsePath(pathWithQuery);
      if (typeof pathWithQuery !== 'string' || pathWithQuery.length > 2000) throw HttpError_(400, 'Bad request');
      let b = {};
      if (body && typeof body === 'object') b = body;
      else if (typeof body === 'string' && body) { try { b = JSON.parse(body); } catch (e) { throw HttpError_(400, 'Bad request'); } }
      const out = route(typeof token === 'string' ? token : '', String(method).toUpperCase(), p.path, p.query, b);
      out.t = Date.now(); // server clock, so screens show correct timers even if the PC clock is off
      return out;
    } catch (e) {
      if (e && e.name === 'HttpError') return { status: e.status, body: Object.assign({ error: e.message }, e.extra || {}), t: Date.now() };
      try { console.error(e && e.stack ? e.stack : e); } catch (x) { /* ignore */ }
      return { status: 500, body: { error: 'Something went wrong. Please try again.' }, t: Date.now() };
    }
  }

  return { handle: handle, guestPayload: guestPayload };
})();

/** Render a URL as a self-contained SVG QR code (no external service, nothing leaves Google). */
function qrSvg_(text) {
  const qr = QRCODE_(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), cell = 8, margin = 2, size = (n + margin * 2) * cell;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += 'M' + (c + margin) * cell + ' ' + (r + margin) * cell + 'h' + cell + 'v' + cell + 'h-' + cell + 'z';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="Waiting Guest QR code" shape-rendering="crispEdges"><rect width="' + size + '" height="' + size + '" fill="#fff"/><path d="' + d + '" fill="#2B2118"/></svg>';
}
