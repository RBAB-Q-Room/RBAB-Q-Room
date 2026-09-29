'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { boot, createGuest } = require('./helpers');

const i18n = (() => {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src/web/js/45-i18n.js'), 'utf8') + ';this.out = { WG_I18N, WG_LANGS };', ctx);
  return JSON.parse(JSON.stringify(ctx.out));
})();

test('every guest-page string exists in all four languages, with matching placeholders', () => {
  assert.deepEqual(i18n.WG_LANGS.map((l) => l.code), ['en', 'ar', 'ru', 'de']);
  assert.equal(i18n.WG_LANGS.find((l) => l.code === 'ar').dir, 'rtl');
  const keys = Object.keys(i18n.WG_I18N.en).sort();
  for (const l of ['ar', 'ru', 'de']) {
    assert.deepEqual(Object.keys(i18n.WG_I18N[l]).sort(), keys, `${l} has exactly the English keys`);
    for (const k of keys) {
      const v = i18n.WG_I18N[l][k];
      assert.ok(typeof v === 'string' && v.trim().length > 0, `${l}.${k} is not empty`);
      assert.equal(/\{\w+\}/.test(v), /\{\w+\}/.test(i18n.WG_I18N.en[k]), `${l}.${k} placeholder parity`);
    }
    assert.notEqual(i18n.WG_I18N[l].readyTitle, i18n.WG_I18N.en.readyTitle, `${l} is actually translated`);
  }
  assert.match(i18n.WG_I18N.ar.readyTitle, /[؀-ۿ]/);
  assert.match(i18n.WG_I18N.ru.readyTitle, /[Ѐ-ӿ]/);
});

test('Reception sets the guest language; it defaults from nationality and can be changed', () => {
  const t = boot();
  // reservations: Al Mansoori (AE), Dmitri (RU), Jonas (DE), Emily (GB)
  const res = (c) => t.rec('GET', `/api/search?q=${c}`).body.reservations[0];
  assert.equal(res('51840217').suggestedLanguage, 'ar');
  assert.equal(res('51840251').suggestedLanguage, 'ru');
  assert.equal(res('51840274').suggestedLanguage, 'de');
  assert.equal(res('51840233').suggestedLanguage, 'en');

  // explicit choice wins; missing choice falls back to the suggestion; junk falls back safely
  assert.equal(createGuest(t, '51840217', { language: 'de' }).wg.language, 'de');
  assert.equal(createGuest(t, '51840251').wg.language, 'ru');
  assert.equal(createGuest(t, '51840274', { language: 'klingon' }).wg.language, 'de', 'invalid language uses the suggestion');
  assert.equal(createGuest(t, '51840233', { language: 'AR' }).wg.language, 'ar', 'case-insensitive');

  // editable later, and the guest page follows
  const { wg, token } = createGuest(t, '51840268');
  assert.equal(wg.language, 'en');
  assert.equal(t.guest(token).body.waitingGuest.language, 'en');
  const edited = t.rec('POST', `/api/waiting-guests/${wg.id}/details`, { associate: 'A', language: 'ru' });
  assert.equal(edited.body.waitingGuest.language, 'ru');
  assert.equal(t.guest(token).body.waitingGuest.language, 'ru');
  assert.equal(t.rec('POST', `/api/waiting-guests/${wg.id}/details`, { associate: 'A', language: 'zz' }).body.waitingGuest.language, 'ru', 'an invalid value keeps the current language');
  assert.equal(t.rec('POST', `/api/waiting-guests/${wg.id}/details`, { associate: 'A' }).body.waitingGuest.language, 'ru', 'editing other details keeps the language');
  assert.equal(t.ctl('GET', '/api/waiting-guests').body.active.every((g) => ['en', 'ar', 'ru', 'de'].includes(g.language)), true);
  // manual entries too
  const m = t.rec('POST', '/api/waiting-guests', { confirmationNo: '99999999', associate: 'A', language: 'ar', manual: { guestName: 'Walk In', arrivalDate: '2026-09-29', departureDate: '2026-09-30', roomType: 'KGA', adults: 2 } });
  assert.equal(m.body.waitingGuest.language, 'ar');
  assert.match(t.adm('GET', '/api/export/waiting-guests').body.csv.split('\r\n')[0], /,language,/);
});

test('guest content is served in every language with English as the fallback', () => {
  const t = boot();
  const { token } = createGuest(t);
  const c = t.guest(token).body.content;
  assert.equal(c.welcome.en, 'While you wait, feel free to enjoy the resort.');
  for (const l of ['ar', 'ru', 'de']) assert.notEqual(c.welcome[l], c.welcome.en);
  const pools = c.sections.find((s) => s.id === 'pools');
  assert.equal(pools.title.en, 'Pools'); assert.equal(pools.title.ru, 'Бассейны'); assert.equal(pools.title.ar, 'المسابح'); assert.equal(pools.title.de, 'Pools');
  // hotel leaves a translation blank: English is used instead of an empty card
  const S = t.b.ev('Store');
  S.update('GuestContent', S.find('GuestContent', 'id', 'beach')._row, { body_de: '', title_ru: '' });
  const beach = t.guest(token).body.content.sections.find((s) => s.id === 'beach');
  assert.equal(beach.body.de, beach.body.en);
  assert.equal(beach.title.ru, beach.title.en);
  assert.equal(beach.title.ar, 'الشاطئ', 'other languages unaffected');
  // hotel supplies real text in one language only
  S.update('GuestContent', S.find('GuestContent', 'id', 'wifi')._row, { body_de: 'Netzwerk: Rixos-Gast', placeholder: false });
  const wifi = t.guest(token).body.content.sections.find((s) => s.id === 'wifi');
  assert.equal(wifi.body.de, 'Netzwerk: Rixos-Gast');
  assert.equal(wifi.placeholder, false);
  // the guest response still leaks nothing new
  assert.ok(!JSON.stringify(t.guest(token).body.waitingGuest).match(/nationality|Layla|phone/));
});

test('nationality names and codes map to a language, unknown stays English', () => {
  const t = boot({ demo: false });
  const f = t.b.ev('suggestLanguage_');
  for (const [n, l] of [['AE', 'ar'], ['United Arab Emirates', 'ar'], ['sau', 'ar'], ['EG', 'ar'], ['RU', 'ru'], ['Russian Federation', 'ru'], ['kz', 'ru'], ['DE', 'de'], ['Austria', 'de'], ['CH', 'de'], ['GB', 'en'], ['CN', 'en'], ['', 'en'], [null, 'en']]) assert.equal(f(n), l, String(n));
});
