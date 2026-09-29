'use strict';
(async function boot() {
  const root = $('#root');
  if (WG.boot.mode === 'guest') return WG.views.guest(root, WG.boot.token);
  const t = storedToken();
  if (t) {
    WG.token = t;
    try { const { user } = await api('GET', '/api/me'); return mountForUser(user); } catch (e) { if (!e.silent) { forgetToken(); showLogin(); } return; }
  }
  showLogin();
})();
