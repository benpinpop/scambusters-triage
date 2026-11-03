import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROFILE, siteTagOf } from '../lib/autofill/profile.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const src = readFileSync(here('../content/autofill.js'), 'utf8');
const fixture = readFileSync(here('./autofill-fixture.html'), 'utf8');

function loadJsdom() {
  const p = process.env.SB_JSDOM_PATH;
  if (!p) return null;
  try { return createRequire(p.replace(/[\\/]*$/, '/') + 'x.js')('jsdom'); } catch { return null; }
}
const jsdom = loadJsdom();

function boot(html = fixture, url = 'https://shop-x.example/signup') {
  const dom = new jsdom.JSDOM(html, { runScripts: 'outside-only', url });
  const w = dom.window;
  const sent = [];
  w.chrome = { runtime: { id: 'test', sendMessage: (m) => { sent.push(m); return Promise.resolve({}); } } };
  w.eval(src);
  return { w, sent, api: w.__sbAutofill, doc: w.document };
}
const args = (extra = {}) => ({ mode: 'url', profile: { ...DEFAULT_PROFILE, custom: [] }, siteTag: '', flags: {}, highlight: true, ...extra });
const row = (r, label) => r.fields.find((f) => f.label === label);

test('autofill.js against autofill-fixture.html', async (t) => {
  if (!jsdom) return t.skip('jsdom not available: set SB_JSDOM_PATH (npm i jsdom --prefix <dir>)');

  await t.test('fills the five defaults and confirm fields', () => {
    const { api, doc, w } = boot();
    const r = api.run(args());
    assert.equal(doc.getElementById('u').value, 'username1202');
    assert.equal(doc.getElementById('e').value, 'example@example.com');
    assert.equal(doc.getElementById('e2').value, 'example@example.com');
    assert.equal(doc.getElementById('pw').value, 'Password1*');
    assert.equal(doc.getElementById('pw2').value, 'Password1*');
    assert.equal(doc.getElementById('country').value, 'US');
    assert.equal(doc.getElementById('dial').value, '+1');
    assert.equal(r.used.email, 'example@example.com');
    assert.equal(r.detected, true);
    assert.equal(w.__sbAutofill, api);
    w.eval(src); // re-injection is a no-op
    assert.equal(w.__sbAutofill, api);
  });

  await t.test('phone is formatted to the field', () => {
    const { api, doc } = boot();
    api.run(args());
    assert.equal(doc.getElementById('ph').value, '(202) 555-0123');
    assert.equal(doc.getElementById('ph10').value, '2025550123');
  });

  await t.test('skips traps, prefilled, newsletter and out-of-form fields', () => {
    const { api, doc } = boot();
    const r = api.run(args());
    assert.equal(doc.getElementById('hp').value, '');
    assert.equal(doc.getElementById('hp2').value, '');
    assert.equal(doc.getElementById('captcha').value, '');
    assert.equal(doc.getElementById('ref').value, '');
    assert.equal(doc.getElementById('prefilled').value, 'keepme');
    assert.equal(doc.getElementById('news').value, '');
    assert.equal(doc.getElementById('foot-plain').value, '');
    assert.equal(row(r, 'footer_email') && row(r, 'footer_email').status, 'skipped');
    // empty optional profile fields are reported, not filled
    assert.equal(doc.getElementById('fn').value, '');
  });

  await t.test('never submits and sends nothing to the page origin', () => {
    const { api, doc, w } = boot();
    let submitted = false;
    doc.getElementById('signup').addEventListener('submit', () => { submitted = true; });
    api.run(args());
    assert.equal(submitted, false);
    assert.equal(w.document.cookie, '');
  });

  await t.test('fires input and change events so frameworks notice', () => {
    const { api, doc } = boot();
    const seen = [];
    doc.getElementById('e').addEventListener('input', () => seen.push('input'));
    doc.getElementById('e').addEventListener('change', () => seen.push('change'));
    api.run(args());
    assert.deepEqual(seen, ['input', 'change']);
  });

  await t.test('second run fills nothing new', () => {
    const { api } = boot();
    api.run(args());
    const again = api.run(args());
    assert.equal(again.fields.filter((f) => f.status === 'filled').length, 0);
  });

  await t.test('extra profile fields and custom fields', () => {
    const { api, doc } = boot();
    api.run(args({ profile: { ...DEFAULT_PROFILE, firstName: 'Sam', lastName: 'Lee', dob: '1990-04-05', custom: [{ label: 'security answer', value: 'blue' }] } }));
    assert.equal(doc.getElementById('fn').value, 'Sam');
    assert.equal(doc.getElementById('ln').value, 'Lee');
    assert.equal(doc.getElementById('dob').value, '1990-04-05');
    assert.equal(doc.getElementById('custom').value, 'blue');
  });

  await t.test('site tags with maxlength fallback', () => {
    const { api, doc } = boot();
    doc.getElementById('u').setAttribute('maxlength', '14');
    api.run(args({ siteTag: siteTagOf('www.shop-x.com'), flags: { siteTagEmail: true, siteTagUsername: true } }));
    assert.equal(doc.getElementById('e').value, 'example+shopx@example.com');
    assert.equal(doc.getElementById('u').value, 'username1202'); // 12 + 5 > 14: plain
  });

  await t.test('terms box ticked only when asked, marketing never', () => {
    const off = boot();
    off.api.run(args());
    assert.equal(off.doc.getElementById('tos').checked, false);
    const on = boot();
    const r = on.api.run(args({ checkTerms: true }));
    assert.equal(on.doc.getElementById('tos').checked, true);
    assert.equal(on.doc.getElementById('promo').checked, false);
    assert.equal(r.terms, 1);
  });

  await t.test('dry run changes nothing and says what it would do', () => {
    const { api, doc } = boot();
    const r = api.run(args({ dryRun: true }));
    assert.equal(doc.getElementById('u').value, '');
    assert.equal(doc.getElementById('u').style.outline, '');
    assert.ok(r.fields.some((f) => f.status === 'would-fill'));
    assert.ok(!r.fields.some((f) => f.status === 'filled'));
  });

  await t.test('undo restores values, outlines and checkboxes', () => {
    const { api, doc } = boot();
    api.run(args({ checkTerms: true }));
    assert.equal(doc.getElementById('u').style.outline.includes('2px'), true);
    const u = api.undo();
    assert.ok(u.restored >= 7);
    assert.equal(doc.getElementById('u').value, '');
    assert.equal(doc.getElementById('country').selectedIndex, 0);
    assert.equal(doc.getElementById('tos').checked, false);
    assert.equal(doc.getElementById('u').style.outline, '');
    assert.equal(doc.getElementById('prefilled').value, 'keepme');
  });

  await t.test('dom mode needs a password/username field; url mode does not', () => {
    const plain = '<input id="e" type="email" name="email">';
    const a = boot(plain);
    a.api.run(args({ mode: 'dom' }));
    assert.equal(a.doc.getElementById('e').value, '');
    const b = boot(plain);
    b.api.run(args({ mode: 'url' }));
    assert.equal(b.doc.getElementById('e').value, 'example@example.com');
    const c = boot('<input id="e" type="email" name="email"><input type="password">');
    c.api.run(args({ mode: 'dom' }));
    assert.equal(c.doc.getElementById('e').value, 'example@example.com');
  });

  await t.test('login form: one password, remembered email', () => {
    const { api, doc } = boot('<form><input id="id" name="email"><input id="pw" type="password" autocomplete="current-password"></form>', 'https://x.example/login');
    api.run(args());
    assert.equal(doc.getElementById('id').value, 'example@example.com');
    assert.equal(doc.getElementById('pw').value, 'Password1*');
  });

  await t.test('country combobox is left for the user', () => {
    const { api, doc } = boot('<form><input id="c" name="country" role="combobox"><input type="password"></form>');
    const r = api.run(args());
    assert.equal(doc.getElementById('c').value, '');
    assert.equal(row(r, 'country').status, 'manual');
  });

  await t.test('deposit amount: filled only on deposit pages, respects min/decimals, skips withdraw/address', () => {
    const page = '<h1>Deposit funds</h1><form>' +
      '<input id="a" name="amount" type="number" min="250">' +
      '<input id="b" name="deposit_amount" type="text" placeholder="0.00">' +
      '<input id="z" name="amount" type="text" value="0">' +
      '<input id="w" name="withdraw_amount" type="text">' +
      '<input id="addr" name="deposit_address" type="text">' +
      '<input id="q" name="quantity" type="number">' +
      '<input id="age" name="age" type="number">' +
      '</form>';
    const on = boot(page, 'https://x.example/wallet');
    on.api.run(args({ depositFill: true, profile: { ...DEFAULT_PROFILE, custom: [] } }));
    assert.equal(on.doc.getElementById('a').value, '250'); // raised to the field minimum
    assert.equal(on.doc.getElementById('b').value, '100.00'); // decimal placeholder
    assert.equal(on.doc.getElementById('z').value, '100'); // a starter "0" counts as empty
    for (const id of ['w', 'addr', 'q', 'age']) assert.equal(on.doc.getElementById(id).value, '', id);

    const off = boot(page, 'https://x.example/wallet');
    off.api.run(args({ depositFill: false }));
    assert.equal(off.doc.getElementById('b').value, '');

    const notDeposit = boot('<h1>Shop</h1><input id="b" name="amount" type="text">', 'https://x.example/cart');
    notDeposit.api.run(args({ depositFill: true }));
    assert.equal(notDeposit.doc.getElementById('b').value, '');

    const byUrl = boot('<input id="b" name="amount" type="text">', 'https://x.example/deposit');
    byUrl.api.run(args({ depositFill: true, deposit: true }));
    assert.equal(byUrl.doc.getElementById('b').value, '100');

    const domMode = boot('<h1>Add funds to your account</h1><input id="b" name="amount" type="text">');
    domMode.api.run(args({ mode: 'dom', depositFill: true }));
    assert.equal(domMode.doc.getElementById('b').value, '100');
  });

  await t.test('watch asks the worker again when inputs appear, and stops on request', async () => {
    const { api, doc, sent, w } = boot('<form><input type="password"></form>');
    w.chrome.runtime.sendMessage = (m) => { sent.push(m); return Promise.resolve({ stop: true }); };
    api.watch();
    const inp = doc.createElement('input');
    doc.body.appendChild(inp);
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(JSON.stringify(sent), JSON.stringify([{ type: 'autofill/retry' }]));
    doc.body.appendChild(doc.createElement('input'));
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(sent.length, 1); // observer stopped after {stop:true}
  });
});
