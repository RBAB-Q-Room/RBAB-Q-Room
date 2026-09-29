/* =====================================================================
 * Web app entry points.
 *   doGet(e)   serves the app shell (staff sign-in, or guest page when ?t=...)
 *   apiCall()  the ONE function the browser calls (google.script.run)
 * ===================================================================== */

function doGet(e) {
  const params = (e && e.parameter) || {};
  const t = typeof params.t === 'string' && /^[A-Za-z0-9_-]{20,64}$/.test(params.t) ? params.t : '';
  const tpl = HtmlService.createTemplateFromFile('Index');
  // JSON is escaped so it cannot break out of the script tag.
  tpl.boot = JSON.stringify({ mode: t ? 'guest' : 'staff', token: t, platform: 'gas' }).replace(/</g, '\\u003c');
  return tpl.evaluate()
    .setTitle(t ? 'Your room · Rixos Bab Al Bahr' : 'Waiting Guest')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .addMetaTag('referrer', 'no-referrer')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** Called from the browser. Always returns { status, body }; never throws. */
function apiCall(token, method, path, body) {
  // Round-trip through JSON so the reply is plain data (no undefined values), which google.script.run requires.
  return JSON.parse(JSON.stringify(Api.handle(token, method, path, body)));
}
