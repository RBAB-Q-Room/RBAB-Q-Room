'use strict';
/* Browser end-to-end run against the dev server (needs Playwright + Chromium).
   Usage: ADMIN_PW=... node dev/e2e.js <baseUrl> <demoPassword> <screenshotDir>
   Three separate browsers (Reception, Rooms Controller, guest phone) share one record. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const [B, PW, SP] = process.argv.slice(2);
const ok = (cond, msg) => { if (!cond) throw new Error('CHECK FAILED: ' + msg); console.log('  ✓ ' + msg); };

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  const errs = [];
  const mk = async (opts = {}) => {
    const c = await browser.newContext(opts); const p = await c.newPage();
    p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    p.on('console', (m) => m.type() === 'error' && !/fonts|ERR_|Failed to load/.test(m.text()) && errs.push(m.text()));
    return p;
  };
  const login = async (p, u, pw = PW) => { await p.goto(B); await p.fill('#lu', u); await p.fill('#lp', pw); await p.click('#loginGo'); await p.waitForSelector('#topbar .wordmark'); };
  const shot = async (p, n, o = {}) => { await p.waitForTimeout(450); await p.screenshot({ path: `${SP}/${n}.png`, ...o }); };

  console.log('Sign-in');
  const bad = await mk(); await bad.goto(B); await bad.fill('#lu', 'reception'); await bad.fill('#lp', 'wrong'); await bad.click('#loginGo');
  await bad.waitForSelector('#loginMsg:not([hidden])'); ok(/Incorrect/.test(await bad.textContent('#loginMsg')), 'wrong password is refused with a clear message');
  const rec = await mk({ viewport: { width: 1366, height: 900 } }); await login(rec, 'reception');
  const ctl = await mk({ viewport: { width: 1440, height: 900 } }); await login(ctl, 'controller');

  console.log('Reception creates a Waiting Guest');
  await rec.fill('#q', 'mansoori'); await rec.waitForSelector('[data-res]'); ok(true, 'reservation found by guest name');
  await rec.fill('#q', '51840217'); await rec.press('#q', 'Enter'); await rec.waitForSelector('#createForm'); ok(true, 'Enter on a single result opens the reservation');
  await shot(rec, 'r1-reservation');
  await rec.fill('#fAssoc', ''); await rec.click('#createBtn'); await rec.waitForSelector('#assocErr:not([hidden])'); ok(true, 'associate is required; form keeps its data');
  await rec.fill('#fAssoc', 'Layla'); await rec.fill('#fTag', 'T-4471'); await rec.click('.tagbtn[data-tag="occasion"]'); await rec.fill('#fPref', 'High floor, quiet'); await rec.fill('#fRem', 'Anniversary, arrange flowers');
  await shot(rec, 'r2-form');
  await rec.click('#createBtn'); await rec.waitForSelector('#qrBox svg');
  const wg = (await rec.textContent('.big-wg')).trim(); ok(/^WG-\d{4}$/.test(wg), `number generated: ${wg}`);
  ok(/not opened/.test(await rec.textContent('#scanState')), 'QR panel says the guest has not opened the page yet');
  await shot(rec, 'r3-created');
  const link = await rec.getAttribute('#qrActions a', 'href');

  console.log('Duplicate and second guest');
  await rec.click('#nextBtn'); await rec.fill('#q', '51840217'); await rec.waitForTimeout(700);
  ok(!(await rec.$('#results [data-res]')), 'reservation with an active Waiting Guest is not offered twice');
  await rec.fill('#q', '51840251'); await rec.waitForSelector('[data-res]'); await rec.click('[data-res]'); await rec.fill('#fAssoc', 'Layla'); await rec.click('#createBtn'); await rec.waitForSelector('.big-wg');

  console.log('Guest scans the QR');
  const g = await mk({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const t0 = Date.now(); await g.goto(link); await g.waitForSelector('.hero h1'); const firstPaint = Date.now() - t0;
  ok(/تجهيز/.test(await g.textContent('h1')), `UAE guest's page opens in Arabic, status on first paint (${firstPaint} ms, no loading screen)`);
  await g.click('#gLang summary'); await g.click('[data-lang="en"]');
  ok(/being prepared/.test(await g.textContent('h1')), 'guest switches to English: "Your room is being prepared"');
  ok((await g.textContent('.stay')).includes('Deluxe King View'), 'guest sees the room type name, not the code');
  ok(!(await g.content()).includes('T-4471') && !(await g.content()).includes('Layla') && !(await g.content()).includes('+971'), 'guest page shows no staff notes, associate or phone');
  await shot(g, 'g1-waiting', { fullPage: true });
  await rec.waitForFunction(() => /following/.test(document.querySelector('#list') ? document.body.textContent : ''), null, { timeout: 15000 }).catch(() => {});

  console.log('Rooms Controller');
  await ctl.waitForFunction(() => document.querySelectorAll('.q').length >= 2, null, { timeout: 15000 });
  const vipCard = await ctl.textContent('.q:has-text("Dmitri")'); ok(/VIP/.test(vipCard), 'VIP reason is shown on the card');
  await shot(ctl, 'c1-queue');
  await ctl.fill('#cq', 'mansoori'); await ctl.waitForTimeout(200); ok((await ctl.$$('.q')).length === 1, 'queue search filters to one guest');
  await ctl.fill('#cq', '');
  await ctl.click('.q:has-text("Mansoori")'); await ctl.waitForSelector('#detail .rm');
  ok(/opened|following/.test(await ctl.textContent('#detail .tl')), 'timeline shows the guest opened their page');
  await ctl.click('#detail .room-grid .rm >> nth=0'); await ctl.click('#assignBtn'); await ctl.waitForSelector('[data-status="preparing"]');
  await g.waitForFunction(() => /Room selected/.test(document.querySelector('.steps [aria-current="step"]')?.textContent || ''), null, { timeout: 15000 });
  ok(true, 'guest progress moves to "Room selected" live');
  await ctl.click('[data-status="preparing"]'); await ctl.waitForFunction(() => document.querySelector('#detail .pill.st-preparing'));
  await shot(ctl, 'c2-detail');
  await ctl.click('[data-status="ready"]'); await ctl.click('.modal-actions .btn-primary');
  await g.waitForFunction(() => /ready/.test(document.querySelector('h1').textContent), null, { timeout: 15000 });
  ok(/return to Reception/.test(await g.textContent('.hero')), 'guest sees "Your room is ready" with the instruction to return to Reception');
  await shot(g, 'g2-ready', { fullPage: true });
  await ctl.waitForFunction(() => /seen "room ready"/.test(document.querySelector('#detail').textContent), null, { timeout: 15000 });
  ok(true, 'Rooms Controller sees that the guest has seen "room ready"');

  console.log('Reception completes');
  await rec.waitForFunction(() => document.querySelector('#list .pill.st-ready'), null, { timeout: 15000 }); ok(true, 'Reception list shows "Room Ready" live');
  await rec.fill('#q', wg.replace('WG-', 'wg ')); await rec.waitForSelector('#results [data-wg]'); ok(true, `search by "${wg.replace('WG-', 'wg ')}" finds the guest`);
  await rec.click('#results [data-wg]'); await rec.waitForSelector('#completeBtn:not([disabled])');
  await shot(rec, 'r4-verify');
  await rec.click('#completeBtn'); await rec.click('.modal-actions .btn-primary'); await rec.waitForFunction(() => document.querySelector('.panel .pill.st-completed'));
  await g.waitForFunction(() => /Welcome/.test(document.querySelector('h1').textContent), null, { timeout: 15000 }); ok(true, 'guest page moves to "Welcome"');
  await g.click('[data-star="5"]'); await g.click('[data-helpful="yes"]'); await g.click('#fbSend'); await g.waitForSelector('.fb.done'); ok(true, 'guest leaves 5-star feedback in two taps');
  await shot(g, 'g3-done', { fullPage: true });

  console.log('Cancel and edge cases');
  await rec.click('#list [data-wg]'); await rec.waitForSelector('#cancelWgBtn'); await rec.click('#cancelWgBtn'); await rec.click('.modal-actions .btn-primary');
  await rec.waitForSelector('.modal-box .field-error:not([hidden])'); ok(true, 'cancel requires a reason');
  await rec.fill('#dlgIn', 'Created by mistake'); await rec.click('.modal-actions .btn-primary');
  await rec.waitForFunction(() => document.querySelector('.panel .pill.st-cancelled'), null, { timeout: 15000 }); ok(true, 'record cancelled');
  const bl = await mk({ viewport: { width: 390, height: 700 } }); await bl.goto(B + '?t=' + 'a'.repeat(64)); await bl.waitForSelector('.hero h1'); ok(/not valid/.test(await bl.textContent('h1')), 'an unknown link shows "not valid"');

  console.log('Management');
  const adm = await mk({ viewport: { width: 1280, height: 1000 } }); await login(adm, 'admin', process.env.ADMIN_PW);
  await adm.waitForSelector('.chart svg'); ok(/Measured/.test(await adm.textContent('#adBody')) && /Illustrative/i.test(await adm.textContent('#adBody')), 'analytics separates measured figures from the illustrative business case');
  await adm.fill('#bc_manual_minutes', '6'); await adm.fill('#bc_print_pieces', '2'); await adm.fill('#bc_print_cost', '0.4');
  ok(/AED/.test(await adm.textContent('#bcRes')), 'business case recalculates as assumptions are typed');
  await adm.click('#bcSave'); await adm.waitForTimeout(600);
  await shot(adm, 'a1-analytics', { fullPage: true });
  await adm.click('[data-tab="guest"]'); await adm.waitForSelector('#gpForm');
  await adm.click('[data-sec="pools"]'); await adm.fill('#c_body', 'Main pool open all day.'); await adm.fill('#c_highlight', 'Aqua gym at 16:00, main pool'); await adm.uncheck('#c_ph'); await adm.click('#gpSave'); await adm.waitForTimeout(700);
  await shot(adm, 'a2-guestpage');
  await adm.click('[data-tab="settings"]'); await adm.waitForSelector('#stForm'); await adm.fill('#s_late_alert_minutes', '5'); await adm.fill('#s_late_warn_minutes', '10'); await adm.click('#stSave');
  await adm.waitForSelector('#stErr:not([hidden])'); ok(/higher than/.test(await adm.textContent('#stErr')), 'invalid thresholds are explained, not saved');
  await adm.click('[data-tab="data"]'); await adm.waitForSelector('#paste');
  const csv = 'Arrivals report,,,,,,\nConf No,Guest Name,Arrival,Departure,Room Type,Adults,Children\n70000001,"Al Farsi, Khalid",29/09/2026,02/10/2026,KGA,2,0\n70000003,Bad Date,31/02/2026,01/03/2026,KGA,2,0\n';
  await adm.fill('#paste', csv); await adm.click('#previewBtn'); await adm.waitForSelector('#commitBtn'); ok(/Line 4/.test(await adm.textContent('#impOut')), 'import preview reports the bad row by line number');
  await shot(adm, 'a3-import');

  console.log('Guest page after content edit, in Arabic and on a small phone');
  const { token2 } = {};
  const g2 = await mk({ viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ar' });
  await rec.click('#nextBtn').catch(() => {}); await rec.fill('#q', '51840291'); await rec.waitForSelector('[data-res]'); await rec.click('[data-res]');
  ok(await rec.inputValue('#fLang') === 'ar', 'Arabic pre-selected for a UAE guest');
  await rec.fill('#fAssoc', 'Layla'); await rec.click('#createBtn'); await rec.waitForSelector('#qrActions a');
  await g2.goto(await rec.getAttribute('#qrActions a', 'href')); await g2.waitForSelector('.hero h1');
  ok(await g2.evaluate(() => document.documentElement.dir) === 'rtl', 'Arabic guest page is right-to-left');
  ok(/أكوا|Aqua gym/.test(await g2.textContent('.today')), '"Happening today" shows the new highlight');
  const overflow = await g2.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  ok(!overflow, 'no horizontal scroll at 360px');
  await shot(g2, 'g4-arabic', { fullPage: true });
  await g2.click('#gLang summary'); await g2.click('[data-lang="ru"]'); ok(/готовится/.test(await g2.textContent('h1')), 'language switch to Russian');
  await shot(g2, 'g5-russian');

  console.log('Tablet Rooms Controller');
  const tab = await mk({ viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, hasTouch: true }); await login(tab, 'controller');
  await tab.waitForSelector('.q'); await tab.click('.q >> nth=0'); await tab.waitForSelector('#detail.open .d-card'); await shot(tab, 'c3-tablet');
  ok(!(await tab.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'tablet layout has no horizontal scroll');

  const dark = await mk({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' }); await dark.goto(link); await dark.waitForSelector('.hero'); await shot(dark, 'g6-dark');
  console.log('\nconsole errors:', errs.length ? errs : 'none');
  await browser.close();
  if (errs.length) process.exit(2);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
