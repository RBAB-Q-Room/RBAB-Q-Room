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
      } catch (e) { throw HttpError(400, 'Bad request'); }
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
    const welcome = { en: Config.get('guest_welcome') };
    ['ar', 'ru', 'de'].forEach(function (l) { welcome[l] = Config.get('guest_welcome_' + l) || welcome.en; });
    return {
      hotelName: Config.get('hotel_name'),
      welcome: welcome,
      links: {
        map: { url: safeUrl(Config.get('hotel_map_url')) },
        website: { url: safeUrl(Config.get('hotel_website_url')) },
      },
      sections: Store.all('GuestContent').filter(function (s) { return s.active; }).sort(function (a, b) { return a.sort - b.sort; })
        .map(function (s) { return { id: s.id, icon: s.icon, placeholder: s.placeholder, title: multi(s, 'title'), body: multi(s, 'body'), note: multi(s, 'note') }; }),
    };
  }

  function route(token, method, path, query, body) {
    let m;
    body = body || {};

    // ---- public: guest page (the unguessable token is the only credential) ----
    if ((m = path.match(/^\/api\/guest\/([A-Za-z0-9_-]+)$/)) && method === 'GET') {
      const v = Store.version();
      if (query.v !== undefined && String(query.v) === String(v) && query.have === '1') return { status: 200, body: { unchanged: true, version: v } };
      const view = Waiting.guestView(m[1]);
      if (!view) throw HttpError(404, 'This link is not valid');
      return { status: 200, body: { waitingGuest: view, content: guestContent(), version: v } };
    }
    if (path === '/api/login' && method === 'POST') {
      const out = Auth.login(body.username, body.password);
      return { status: 200, body: out };
    }
    if (path === '/api/logout' && method === 'POST') { Auth.logout(token); return { status: 200, body: { ok: true } }; }

    // ---- everything below needs a signed-in staff user ----
    const user = Auth.userFromToken(token);
    if (!user) throw HttpError(401, 'Sign in required');
    const need = function (roles) { if (roles.indexOf(user.role) === -1) throw HttpError(403, 'Not allowed for your role'); };

    if (path === '/api/me' && method === 'GET') return { status: 200, body: { user: user } };
    if (path === '/api/me/password' && method === 'POST') return { status: 200, body: Auth.changeOwnPassword(user, body.current, body.next) };
    if (path === '/api/version' && method === 'GET') return { status: 200, body: { version: Store.version() } };
    if (path === '/api/meta' && method === 'GET') {
      return { status: 200, body: {
        roomTypes: roomTypeMap(), statuses: STATUSES, provider: ReservationSource.name,
        lateWarnMinutes: Config.num('late_warn_minutes'), lateAlertMinutes: Config.num('late_alert_minutes'), hotelName: Config.get('hotel_name'),
      } };
    }
    if (path === '/api/metrics' && method === 'GET') return { status: 200, body: Waiting.metrics() };

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
        if (!Store.find('WaitingGuests', 'id', id)) throw HttpError(404, 'Waiting Guest not found');
        return { status: 200, body: { url: url, svg: qrSvg(url) } };
      }
      if (sub === 'assign-room' && method === 'POST') return { status: 200, body: { waitingGuest: Waiting.assignRoom(user, id, body.roomNumber) } };
      if (sub === 'status' && method === 'POST') return { status: 200, body: { waitingGuest: Waiting.setStatus(user, id, body.status) } };
      if (sub === 'priority' && method === 'POST') return { status: 200, body: { waitingGuest: Waiting.setPriority(user, id, !!body.priority) } };
      if (sub === 'details' && method === 'POST') return { status: 200, body: { waitingGuest: Waiting.editDetails(user, id, body) } };
      if (sub === 'cancel' && method === 'POST') return { status: 200, body: { waitingGuest: Waiting.cancel(user, id, body.reason) } };
    }

    // ---- admin ----
    if (path === '/api/users' && method === 'GET') { need(['admin']); return { status: 200, body: { users: Auth.listUsers() } }; }
    if (path === '/api/users' && method === 'POST') { need(['admin']); return { status: 201, body: Auth.createUser(user, body) }; }
    if ((m = path.match(/^\/api\/users\/(\d+)\/(active|reset-password)$/)) && method === 'POST') {
      need(['admin']);
      const uid = parseInt(m[1], 10);
      return { status: 200, body: m[2] === 'active' ? Auth.setActive(user, uid, !!body.active) : Auth.resetPassword(user, uid) };
    }
    if (path === '/api/import/arrivals/preview' && method === 'POST') { need(['admin']); return { status: 200, body: Importer.previewArrivals(body) }; }
    if (path === '/api/import/arrivals' && method === 'POST') { need(['admin']); return { status: 200, body: Importer.commitArrivals(user, body) }; }
    if (path === '/api/import/rooms/preview' && method === 'POST') { need(['admin']); return { status: 200, body: Importer.previewRooms(body) }; }
    if (path === '/api/import/rooms' && method === 'POST') { need(['admin']); return { status: 200, body: Importer.commitRooms(user, body) }; }
    if (path === '/api/export/waiting-guests' && method === 'GET') { need(['admin']); return { status: 200, body: { csv: Waiting.exportCsv() } }; }
    if (path === '/api/admin/summary' && method === 'GET') {
      need(['admin']);
      return { status: 200, body: { reservations: Store.all('Reservations').length, rooms: Store.all('Rooms').length, users: Auth.listUsers().length,
        arrivalsToday: Store.all('Reservations').filter(function (r) { return r.arrival_date === todayIso(); }).length, today: todayIso(), guestBase: Links.base(),
        active: Waiting.queue() } };
    }
    throw HttpError(404, 'Not found');
  }

  function handle(token, method, pathWithQuery, body) {
    try {
      Store.reset();
      const p = parsePath(pathWithQuery);
      if (typeof pathWithQuery !== 'string' || pathWithQuery.length > 2000) throw HttpError(400, 'Bad request');
      let b = {};
      if (body && typeof body === 'object') b = body;
      else if (typeof body === 'string' && body) { try { b = JSON.parse(body); } catch (e) { throw HttpError(400, 'Bad request'); } }
      const out = route(typeof token === 'string' ? token : '', String(method).toUpperCase(), p.path, p.query, b);
      out.t = Date.now(); // server clock, so screens show correct timers even if the PC clock is off
      return out;
    } catch (e) {
      if (e && e.name === 'HttpError') return { status: e.status, body: Object.assign({ error: e.message }, e.extra || {}), t: Date.now() };
      try { console.error(e && e.stack ? e.stack : e); } catch (x) { /* ignore */ }
      return { status: 500, body: { error: 'Something went wrong. Please try again.' }, t: Date.now() };
    }
  }

  return { handle: handle };
})();

/** Render a URL as a self-contained SVG QR code (no external service, nothing leaves Google). */
function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), cell = 8, margin = 2, size = (n + margin * 2) * cell;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += 'M' + (c + margin) * cell + ' ' + (r + margin) * cell + 'h' + cell + 'v' + cell + 'h-' + cell + 'z';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="Waiting Guest QR code" shape-rendering="crispEdges"><rect width="' + size + '" height="' + size + '" fill="#fff"/><path d="' + d + '" fill="#2B2118"/></svg>';
}
