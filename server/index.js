'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { open } = require('./db');
const auth = require('./auth');
const bus = require('./bus');
const { seed } = require('./seed');
const roomTypes = require('./roomTypes');
const guestContent = require('./guestContent');
const { qrSvg } = require('./qr');
const { createMockReservationProvider } = require('./providers/reservations');
const { createMockRoomProvider } = require('./providers/rooms');
const { createWaitingService, HttpError, STATUSES } = require('./waiting');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json',
};

function createApp({ db = open(), autoSeed = true, quiet = false } = {}) {
  if (autoSeed) seed(db, { quiet });
  // Swap these two for Opera-backed providers later; nothing else changes.
  const reservations = createMockReservationProvider(db);
  const rooms = createMockRoomProvider(db);
  const waiting = createWaitingService(db, { reservations, rooms });

  const loginLimit = auth.rateLimiter(10, 60_000);
  const guestLimit = auth.rateLimiter(120, 60_000);

  const send = (res, status, body, headers = {}) => {
    const isJson = typeof body === 'object' && !Buffer.isBuffer(body);
    res.writeHead(status, {
      'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(isJson ? JSON.stringify(body) : body);
  };

  const readJson = (req) =>
    new Promise((resolve, reject) => {
      if (!/^application\/json/i.test(req.headers['content-type'] || '')) return reject(new HttpError(415, 'JSON required'));
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 32_768) { reject(new HttpError(413, 'Too large')); req.destroy(); }
        else chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); }
        catch { reject(new HttpError(400, 'Invalid JSON')); }
      });
    });

  const baseUrl = (req) => config.publicBaseUrl || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;

  function sse(req, res, filter) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const onChange = (e) => { if (filter(e)) res.write(`event: change\ndata: ${JSON.stringify({ kind: e.kind })}\n\n`); };
    bus.on('change', onChange);
    const hb = setInterval(() => res.write(': hb\n\n'), 25_000);
    req.on('close', () => { clearInterval(hb); bus.off('change', onChange); });
  }

  function serveStatic(res, file, extraHeaders = {}) {
    const full = path.normalize(path.join(PUBLIC, file));
    if (!full.startsWith(PUBLIC + path.sep)) return send(res, 404, 'Not found');
    fs.readFile(full, (err, data) => {
      if (err) return send(res, 404, 'Not found');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...extraHeaders });
      res.end(data);
    });
  }

  async function handleApi(req, res, url, user) {
    const { pathname } = url;
    const m = req.method;
    const need = (role) => {
      if (!user) throw new HttpError(401, 'Sign in required');
      if (role && user.role !== role) throw new HttpError(403, 'Not allowed for your role');
    };
    const ip = req.socket.remoteAddress || '';
    let mt;

    // ---- public guest endpoints (token is the only credential) ----
    if ((mt = pathname.match(/^\/api\/guest\/([\w-]+)(\/events)?$/)) && m === 'GET') {
      if (!guestLimit(ip)) throw new HttpError(429, 'Too many requests');
      const view = waiting.guestView(mt[1]);
      if (!view) throw new HttpError(404, 'This link is not valid');
      if (mt[2]) return sse(req, res, (e) => e.token === mt[1]);
      return send(res, 200, { waitingGuest: view, content: guestContent() });
    }

    if (pathname === '/api/login' && m === 'POST') {
      if (!loginLimit(ip)) throw new HttpError(429, 'Too many attempts. Try again in a minute.');
      const body = await readJson(req);
      const out = auth.login(db, body.username, body.password);
      if (!out) throw new HttpError(401, 'Incorrect username or password');
      return send(res, 200, { user: out.user }, { 'Set-Cookie': auth.sessionCookie(out.token) });
    }
    if (pathname === '/api/logout' && m === 'POST') {
      auth.logout(db, auth.parseCookies(req.headers.cookie)[auth.COOKIE]);
      return send(res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie('', true) });
    }
    if (pathname === '/api/me' && m === 'GET') { need(); return send(res, 200, { user }); }

    // ---- staff endpoints ----
    need();
    if (pathname === '/api/meta' && m === 'GET') return send(res, 200, { roomTypes, statuses: STATUSES, provider: reservations.name });
    if (pathname === '/api/events' && m === 'GET') return sse(req, res, () => true);
    if (pathname === '/api/metrics' && m === 'GET') return send(res, 200, waiting.metrics());

    if (pathname === '/api/search' && m === 'GET') {
      need('reception');
      return send(res, 200, waiting.search(url.searchParams.get('q')));
    }
    if (pathname === '/api/waiting-guests' && m === 'GET') {
      return send(res, 200, { active: waiting.queue(), completed: waiting.recentCompleted() });
    }
    if (pathname === '/api/waiting-guests' && m === 'POST') {
      const b = await readJson(req);
      return send(res, 201, { waitingGuest: waiting.create(user, b.confirmationNo, b) });
    }
    if ((mt = pathname.match(/^\/api\/waiting-guests\/(\d+)(?:\/(\w[\w.-]*))?$/))) {
      const id = Number(mt[1]);
      const sub = mt[2];
      if (!sub && m === 'GET') {
        const wg = waiting.get(id);
        return send(res, 200, {
          waitingGuest: wg,
          history: waiting.history(id),
          rooms: user.role === 'rooms_controller' ? waiting.availableRooms(id) : undefined,
        });
      }
      if (sub === 'qr.svg' && m === 'GET') {
        const wg = waiting.get(id);
        return send(res, 200, qrSvg(baseUrl(req) + wg.guestUrlPath), { 'Content-Type': 'image/svg+xml' });
      }
      if (sub === 'assign-room' && m === 'POST') {
        const b = await readJson(req);
        return send(res, 200, { waitingGuest: waiting.assignRoom(user, id, b.roomNumber) });
      }
      if (sub === 'status' && m === 'POST') {
        const b = await readJson(req);
        return send(res, 200, { waitingGuest: waiting.setStatus(user, id, b.status) });
      }
      if (sub === 'priority' && m === 'POST') {
        const b = await readJson(req);
        return send(res, 200, { waitingGuest: waiting.setPriority(user, id, !!b.priority) });
      }
    }
    throw new HttpError(404, 'Not found');
  }

  const SECURITY = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  };

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://localhost');
    const user = auth.userFromToken(db, auth.parseCookies(req.headers.cookie)[auth.COOKIE]);
    try {
      if (url.pathname.startsWith('/api/')) {
        // CSRF defence in depth on top of SameSite=Strict.
        if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)
          throw new HttpError(403, 'Cross-origin request blocked');
        return await handleApi(req, res, url, user);
      }
      if (/^\/waiting\/[\w-]+\/?$/.test(url.pathname)) return serveStatic(res, 'guest.html', { 'Cache-Control': 'no-store' });
      const home = user ? (user.role === 'reception' ? '/reception' : '/controller') : '/login';
      if (url.pathname === '/') { res.writeHead(302, { Location: home }); return res.end(); }
      if (['/reception', '/controller'].includes(url.pathname)) {
        const role = url.pathname === '/reception' ? 'reception' : 'rooms_controller';
        if (!user) { res.writeHead(302, { Location: '/login' }); return res.end(); }
        if (user.role !== role) { res.writeHead(302, { Location: home }); return res.end(); }
        return serveStatic(res, `${url.pathname.slice(1)}.html`);
      }
      if (url.pathname === '/login') return serveStatic(res, 'login.html');
      if (/^\/(css|js|assets)\//.test(url.pathname)) return serveStatic(res, url.pathname.slice(1));
      return send(res, 404, 'Not found');
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      if (res.headersSent) return res.end();
      const status = e instanceof HttpError ? e.status : 500;
      send(res, status, { error: e instanceof HttpError ? e.message : 'Server error', ...(e.extra || {}) });
    }
  });

  return { server, db, waiting };
}

module.exports = { createApp };

if (require.main === module) {
  const { server } = createApp();
  server.listen(config.port, () => console.log(`Waiting Guest running at http://localhost:${config.port}`));
}
