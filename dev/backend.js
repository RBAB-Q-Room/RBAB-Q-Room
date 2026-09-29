'use strict';
/** Loads the REAL built Code.gs into a sandbox with the fake Google services. */
const vm = require('node:vm');
const { buildCode } = require('../scripts/build');
const { createGoogle } = require('./fakeGoogle');

function loadBackend(opts = {}) {
  const google = createGoogle(opts);
  const ctx = vm.createContext({ ...google.globals });
  vm.runInContext(buildCode(), ctx, { filename: 'Code.gs' });
  const ev = (expr) => vm.runInContext(expr, ctx);
  return {
    ctx, google, state: google.state, ev,
    // JSON round-trip mimics google.script.run serialization (and gives plain same-realm objects)
    call: (token, method, path, body) => JSON.parse(JSON.stringify(ctx.apiCall(token, method, path, body === undefined ? null : JSON.parse(JSON.stringify(body))))),
    fn: (name) => ctx[name],
    Store: ev('Store'), Auth: ev('Auth'), Waiting: ev('Waiting'), Config: ev('Config'),
  };
}

module.exports = { loadBackend };
