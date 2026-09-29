'use strict';
$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const b = $('#go'), err = $('#err');
  err.hidden = true; b.classList.add('loading');
  try {
    const { user } = await api('POST', '/api/login', { username: $('#u').value.trim(), password: $('#p').value });
    location.href = user.role === 'reception' ? '/reception' : '/controller';
  } catch (ex) {
    err.textContent = ex.message; err.hidden = false; b.classList.remove('loading'); $('#p').select();
  }
});
