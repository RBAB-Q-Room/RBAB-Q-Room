'use strict';
/* Browser end-to-end run against the dev server (needs Playwright + Chromium). Usage: node dev/e2e.js <baseUrl> <password> <screenshotDir> */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const [B, PW, SP] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const errs = [];
  const mk = async (opts = {}) => { const c = await browser.newContext(opts); const p = await c.newPage(); p.on('pageerror', (e) => errs.push('pageerror: ' + e.message)); p.on('console', (m) => m.type() === 'error' && !/fonts|ERR_|Failed to load/.test(m.text()) && errs.push(m.text())); return p; };
  const login = async (p, u, pw = PW) => { await p.goto(B); await p.fill('#lu', u); await p.fill('#lp', pw); await p.click('#loginGo'); await p.waitForSelector('#topbar .wordmark'); };
  const shot = (p, n, o = {}) => p.screenshot({ path: `${SP}/${n}.png`, ...o });
  const rec = await mk({ viewport: { width: 1360, height: 860 } }); await login(rec, 'reception');
  const ctl = await mk({ viewport: { width: 1360, height: 860 } }); await login(ctl, 'controller');

  // wrong password
  const bad = await mk(); await bad.goto(B); await bad.fill('#lu', 'reception'); await bad.fill('#lp', 'wrong'); await bad.click('#loginGo'); await bad.waitForSelector('#loginMsg:not([hidden])'); console.log('bad login ->', await bad.textContent('#loginMsg'));

  // reception: create from imported reservation
  await rec.fill('#q', '51840217'); await rec.waitForSelector('[data-res]'); await shot(rec, 'r1-search');
  await rec.click('[data-res]'); await rec.waitForSelector('#createForm');
  await rec.fill('#fAssoc', 'Layla'); await rec.fill('#fTag', 'T-4471'); await rec.fill('#fPref', 'High floor, quiet'); await rec.fill('#fRem', 'Anniversary');
  await shot(rec, 'r2-form');
  await rec.click('#createBtn'); await rec.waitForSelector('.big-wg'); await rec.waitForSelector('#qrBox svg');
  const wg = await rec.textContent('.big-wg'); console.log('created', wg);
  await shot(rec, 'r3-created');
  const link = await rec.getAttribute('#qrActions a', 'href'); console.log('guest link', link.replace(/t=(.{6}).*/, 't=$1…'));
  // manual entry for a reservation that is not imported
  await rec.click('#nextBtn'); await rec.fill('#q', '99999999'); await rec.waitForSelector('#manualBtn'); await rec.click('#manualBtn'); await rec.waitForSelector('#manualForm');
  await rec.fill('#mName', 'Walk In Guest'); await rec.selectOption('#mType', 'KGA'); await rec.fill('#fAssoc', 'Layla'); await shot(rec, 'r5-manual');
  await rec.click('#createBtn'); await rec.waitForSelector('.big-wg'); console.log('manual created', await rec.textContent('.big-wg'));

  // guest on a phone
  const g = await mk({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await g.goto(link); await g.waitForSelector('.hero h1'); console.log('guest sees:', await g.textContent('h1')); await shot(g, 'g1-preparing', { fullPage: true });

  // controller
  await ctl.waitForFunction(() => document.querySelectorAll('.q').length >= 2, null, { timeout: 15000 }); await shot(ctl, 'c1-queue');
  await ctl.click('.q >> nth=0'); await ctl.waitForSelector('#roomGrid');
  await ctl.click('.rm:not(.other) >> nth=0'); await ctl.click('#assignBtn'); await ctl.waitForSelector('[data-status="ready"]');
  await ctl.click('[data-status="preparing"]'); await ctl.waitForFunction(() => document.querySelector('#detail .pill.st-preparing'));
  await shot(ctl, 'c2-detail');
  await ctl.click('[data-status="ready"]'); await ctl.click('.modal-actions .btn-primary');
  await g.waitForFunction(() => document.querySelector('h1').textContent.includes('ready'), null, { timeout: 15000 });
  console.log('guest live update ->', await g.textContent('h1')); await shot(g, 'g2-ready', { fullPage: true });
  await rec.waitForFunction(() => document.querySelector('#list .pill.st-ready'), null, { timeout: 15000 }); console.log('reception saw ready live');
  await rec.click('#list [data-wg] >> nth=0'); await rec.waitForSelector('#completeBtn:not([disabled])'); await shot(rec, 'r4-verify');
  await rec.click('#completeBtn'); await rec.click('.modal-actions .btn-primary'); await rec.waitForFunction(() => document.querySelector('.panel .pill.st-completed'));
  await g.waitForFunction(() => document.querySelector('h1').textContent.includes('Welcome'), null, { timeout: 15000 }); console.log('completed; guest ->', await g.textContent('h1'));
  // cancel the manual one
  await rec.click('#list [data-wg]'); await rec.waitForSelector('#cancelWgBtn'); await rec.click('#cancelWgBtn'); await rec.fill('#dlgIn', 'Created by mistake'); await rec.click('.modal-actions .btn-primary');
  await rec.waitForFunction(() => document.querySelector('.panel .pill.st-cancelled'), null, { timeout: 15000 }); console.log('cancel ok');

  // admin: import CSV with an Opera style layout (title rows, semicolons not needed), day-first dates
  const adm = await mk({ viewport: { width: 1200, height: 900 } }); await login(adm, 'admin', process.env.ADMIN_PW);
  await adm.click('[data-tab="arrivals"]'); await adm.waitForSelector('#paste');
  const csv = 'Arrivals report,,,,,,\nRixos Bab Al Bahr,,,,,,\nConf No,Guest Name,Arrival,Departure,Room Type,Adults,Children,Phone\n70000001,"Al Farsi, Khalid",29/09/2026,02/10/2026,KGA,2,0,0501234567\n70000002,Anna Weber,29-Sep-2026,03-Oct-2026,SKC,2,2,+49 170 555\n70000003,Bad Date,31/02/2026,01/03/2026,KGA,2,0,\n';
  await adm.fill('#paste', csv); await adm.click('#previewBtn'); await adm.waitForSelector('#commitBtn'); await shot(adm, 'a1-import-preview');
  await adm.click('#commitBtn'); await adm.click('.modal-actions .btn-primary'); await adm.waitForSelector('.ad-cards'); console.log('import ok');
  await rec.fill('#q', '70000001'); await rec.waitForSelector('[data-res]'); console.log('imported reservation searchable:', (await rec.textContent('[data-res] .sub')));
  await adm.click('[data-tab="users"]'); await adm.waitForSelector('#newUser'); await shot(adm, 'a2-users');
  await adm.click('[data-tab="overview"]'); await adm.waitForSelector('.tbl'); await shot(adm, 'a3-overview');
  const gd = await mk({ viewport: { width: 390, height: 844 } }); await gd.emulateMedia({ colorScheme: 'dark' }); await gd.goto(link); await gd.waitForSelector('.hero'); await shot(gd, 'g3-dark');
  const bl = await mk({ viewport: { width: 390, height: 700 } }); await bl.goto(B + '?t=' + 'a'.repeat(40)); await bl.waitForSelector('.err-view'); console.log('invalid link ->', await bl.textContent('.err-view h1'));
  console.log('errors:', errs); await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
