'use strict';
const { loadBackend } = require('../dev/backend');

/** Fresh backend + set-up sheet + one user per role. */
function boot({ demo = true } = {}) {
  const b = loadBackend();
  b.ctx.setup();
  const Auth = b.ev('Auth');
  const users = {};
  for (const [k, role] of [['rec', 'reception'], ['ctl', 'rooms_controller'], ['adm', 'admin']]) {
    Auth.createUser(null, { username: k, name: k + ' user', role, password: 'Password-' + k });
    users[k] = Auth.login(k, 'Password-' + k);
  }
  if (demo) b.ctx.loadDemoData();
  const as = (k) => (method, path, body) => b.call(users[k].token, method, path, body);
  return { b, users, rec: as('rec'), ctl: as('ctl'), adm: as('adm'), guest: (t) => b.call('', 'GET', '/api/guest/' + t) };
}

/** Create a Waiting Guest via the API and return it with its guest token. */
function createGuest(t, conf = '51840217', extra = {}) {
  const r = t.rec('POST', '/api/waiting-guests', Object.assign({ confirmationNo: conf, associate: 'Layla' }, extra));
  if (r.status !== 201) throw new Error('create failed ' + JSON.stringify(r));
  const wg = r.body.waitingGuest;
  const url = t.rec('GET', `/api/waiting-guests/${wg.id}/qr`).body.url;
  return { wg, token: url.split('t=')[1], url };
}

module.exports = { boot, createGuest };
