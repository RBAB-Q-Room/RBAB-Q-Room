'use strict';

function showLogin(message) {
  $('#root').innerHTML = `<main class="auth-gate"><div class="card auth-card">
    <div class="auth-logo"><img src="${WG_ASSETS.logo}" alt="Rixos Bab Al Bahr"></div>
    <h1>Waiting Guest</h1><div class="auth-sub">Sign in to continue</div>
    <form id="loginForm">
      <label class="field"><span>Username</span><input class="in" id="lu" autocomplete="username" autocapitalize="none" autocorrect="off" autofocus required></label>
      <label class="field"><span>Password</span><input class="in" id="lp" type="password" autocomplete="current-password" required></label>
      <div class="banner ${message ? 'info' : 'err'}" id="loginMsg" role="alert" ${message ? '' : 'hidden'}>${esc(message || '')}</div>
      <button class="btn btn-primary" id="loginGo" type="submit">Sign in</button>
    </form></div></main>`;
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const b = $('#loginGo'), msg = $('#loginMsg');
    b.classList.add('loading'); msg.hidden = true; msg.className = 'banner err';
    try {
      const out = await api('POST', '/api/login', { username: $('#lu').value.trim(), password: $('#lp').value });
      rememberToken(out.token);
      mountForUser(out.user);
    } catch (ex) {
      msg.textContent = ex.message; msg.hidden = false; b.classList.remove('loading'); $('#lp').select();
    }
  });
}

function mountForUser(user) {
  const view = user.role === 'reception' ? 'reception' : user.role === 'rooms_controller' ? 'controller' : 'admin';
  WG.views[view]($('#root'), user);
}
