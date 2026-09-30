'use strict';
/**
 * Local development server. Serves the same Index.html as Apps Script and
 * routes browser calls to the SAME server code (Code.gs) running against a
 * fake Google Sheet stored in dev/data.json. Not used in production.
 *   npm run dev      then open http://localhost:3000
 */
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const { loadBackend } = require('./backend');
const { buildIndex } = require('../scripts/build');

const PORT = Number(process.env.PORT || 3000);
const FILE = process.env.WG_DEV_DATA || path.join(__dirname, 'data.json');

function start(port = PORT, file = FILE) {
  const fresh = !fs.existsSync(file);
  const url = `http://localhost:${port}/`;
  const b = loadBackend({ persistFile: file, scriptUrl: url });
  // Room Guide's data.js, as Google would fetch it (real file if WG_ROOMGUIDE_FILE is set, else the test sample)
  const rgFile = process.env.WG_ROOMGUIDE_FILE || path.join(__dirname, '..', 'tests', 'fixtures', 'room-guide-data.js');
  b.state.fetch = (u) => (/data\.js$/.test(u) && fs.existsSync(rgFile) ? { code: 200, text: fs.readFileSync(rgFile, 'utf8') } : null);
  if (fresh) {
    b.ctx.setup();
    const pw = process.env.WG_DEV_PASSWORD;
    if (pw) {
      b.ev('Auth').createUser(null, { username: 'reception', name: 'Reception Desk (demo)', role: 'reception', password: pw });
      b.ev('Auth').createUser(null, { username: 'controller', name: 'Rooms Controller (demo)', role: 'rooms_controller', password: pw });
    }
    b.ctx.loadDemoData();
    console.log(b.state.log.join('\n\n'));
  }
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, url);
    if (req.method === 'POST' && u.pathname === '/rpc') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let out;
        try {
          const { token, method, path: p, body } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          out = b.call(token, method, p, body);
        } catch (e) { out = { status: 400, body: { error: 'Bad request' } }; }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(out));
      });
      return;
    }
    if (u.pathname === '/') {
      const t = u.searchParams.get('t') || '';
      // Same as doGet in production: guest status embedded in the page for an instant first paint.
      const ok = /^[A-Za-z0-9_-]{20,64}$/.test(t);
      let data = null;
      if (ok) { try { b.ev('Store').reset(); data = JSON.parse(JSON.stringify(b.ev('Api').guestPayload(t))); } catch (e) { data = null; } }
      const boot = JSON.stringify({ mode: ok ? 'guest' : 'staff', token: ok ? t : '', platform: 'dev', data }).replace(/</g, '\\u003c');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(buildIndex().replace('<?!= boot ?>', () => boot));
    }
    res.writeHead(404); res.end('Not found');
  });
  return new Promise((resolve) => server.listen(port, () => { console.log(`Waiting Guest (dev) at ${url}`); resolve({ server, backend: b }); }));
}

module.exports = { start };
if (require.main === module) start();
