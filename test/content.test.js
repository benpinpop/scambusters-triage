import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const contentSrc = readFileSync(here('../content/content.js'), 'utf8');
const fixtureHtml = readFileSync(here('./fixture.html'), 'utf8');

function loadJsdom() {
  const p = process.env.SB_JSDOM_PATH;
  if (!p) return null;
  try { return createRequire(p.replace(/[\\/]*$/, '/') + 'x.js')('jsdom'); } catch { return null; }
}
const jsdom = loadJsdom();

function boot(html = fixtureHtml) {
  const dom = new jsdom.JSDOM(html, { runScripts: 'outside-only', url: 'https://scam.example/' });
  const w = dom.window;
  const sent = [];
  w.chrome = { runtime: { id: 'test', sendMessage: (m) => { sent.push(m); return Promise.resolve(); } } };
  w.eval(contentSrc);
  return { w, sent, api: w.__sbTriage };
}
const byRaw = (r, raw) => r.candidates.find((c) => c.raw === raw);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('content.js against fixture.html', async (t) => {
  if (!jsdom) return t.skip('jsdom not available: set SB_JSDOM_PATH (npm i jsdom --prefix <dir>)');
  const { w, sent, api } = boot();
  const doc = w.document;

  // The fixture script does not run in outside-only mode, so build the shadow root here.
  const root = doc.getElementById('shadow-host').attachShadow({ mode: 'open' });
  const sp = doc.createElement('p');
  sp.textContent = 'Shadow deposit: 0x52908400098527886E0F7030069857D2E4169EE7';
  root.appendChild(sp);

  assert.equal(typeof api.scan, 'function');
  w.eval(contentSrc); // re-injection is a no-op
  assert.equal(w.__sbTriage, api);

  await t.test('scan finds candidates from every source', () => {
    const r = api.scan();
    assert.equal(r.isTop, true);
    assert.equal(r.frameUrl, 'https://scam.example/');
    assert.equal(typeof r.durationMs, 'number');
    const btc = byRaw(r, '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
    assert.ok(btc);
    assert.equal(btc.source, 'text');
    assert.match(btc.context, /legacy/);
    assert.ok(btc.context.length <= 120);
    assert.ok(btc.contexts.length >= 2 && btc.contexts.length <= 3, 'zero-width copy merged: ' + btc.contexts.length);
    const bsc = byRaw(r, '0x55d398326f99059fF775485246999027B3197955');
    assert.match(bsc.context, /BEP20/);
    for (const a of [
      'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
      'addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x',
      'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
      'ppm2qsznhks23z7629mms6s4cwef74vcwvn0h829pq',
      'X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ',
      '0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae',
      '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe',
      '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      'LUEweDxDA4WhvWiNXXSxjM9CYzHPJv4QQF',
      'XjhqDGJH37VEpecoDGmtJrmEB7VoD8Lb39',
      '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb', // invalid look-alike is still a (liberal) candidate
    ]) assert.ok(byRaw(r, a), 'missing ' + a);
    assert.equal(byRaw(r, '0x52908400098527886E0F7030069857D2E4169EE7').source, 'shadow');
    assert.equal(new Set(r.candidates.map((c) => c.raw)).size, r.candidates.length);
    assert.ok(!byRaw(r, '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe'), '39 hex digits is not a candidate');
  });

  await t.test('attribute, input, href, shadow sources', () => {
    const { w: w2, api: a2 } = boot(`<body>
      <span data-wallet="0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed">x</span>
      <input readonly value="TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t">
      <a href="ethereum:0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359@56/transfer?value=1">e</a>
      <a href="bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a">b</a>
      <a href="https://p.example/c?address=DEA5vGb2NpAwCiCp5yTE16F3DueQUVivQp">q</a>
      <a href="solana:TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA">s</a>
      <div id="h"></div><script>var x="1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"</script></body>`);
    const h = w2.document.getElementById('h').attachShadow({ mode: 'open' });
    const s = w2.document.createElement('span');
    s.textContent = 'MGv9cSYnaRSTZNzYaN7bhbgmozoGkKBvCn';
    h.appendChild(s);
    const r = a2.scan();
    const d = byRaw(r, '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
    assert.deepEqual([d.source, d.attr], ['attr', 'data-wallet']);
    assert.equal(byRaw(r, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t').source, 'input');
    const e = byRaw(r, '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359');
    assert.deepEqual([e.source, e.scheme], ['href', 'ethereum']);
    assert.equal(byRaw(r, 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a').scheme, 'bitcoincash');
    assert.equal(byRaw(r, 'DEA5vGb2NpAwCiCp5yTE16F3DueQUVivQp').source, 'href');
    assert.equal(byRaw(r, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').scheme, 'solana');
    assert.equal(byRaw(r, 'MGv9cSYnaRSTZNzYaN7bhbgmozoGkKBvCn').source, 'shadow');
    assert.ok(!byRaw(r, '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'), 'script contents are skipped');
    w2.close();
  });

  await t.test('highlight / clearHighlight round-trips the DOM', () => {
    const before = doc.body.innerHTML;
    const res = api.highlight(['guaranteed profit', 'risk-free', 'don’t miss out', "don't miss out", '100% safe', 'usdt']);
    assert.ok(res.count >= 4, 'count ' + res.count);
    const marks = [...doc.querySelectorAll('mark[data-sb-triage]')];
    assert.equal(marks.length, res.count);
    assert.ok(marks.some((m) => /don.t miss out/i.test(m.textContent)), 'curly quote matched');
    api.clearHighlight();
    assert.equal(doc.querySelectorAll('mark[data-sb-triage]').length, 0);
    assert.equal(doc.body.innerHTML, before);
    assert.equal(api.highlight([]).count, 0);
  });

  await t.test('collectText works without innerText', () => {
    const c = api.collectText();
    assert.match(c.title, /TEST FIXTURE/);
    assert.match(c.metaDescription, /Guaranteed 300%/);
    assert.match(c.text, /Guaranteed 300% Daily Returns/);
    assert.match(c.text, /QR code for Litecoin/);
    assert.match(c.text, /Shadow deposit/);
    assert.ok(c.text.length <= 500 * 1024);
  });

  await t.test('later-injected address shows in the next scan; mutation message sent', async () => {
    const p = doc.createElement('p');
    p.textContent = 'Late wallet (Dash): XjhqDGJH37VEpecoDGmtJrmEB7VoD8Lb39 and Lite 3Qx9fQwQ1o8dTn2WmZy4B7Kq5a1Ns8Vh2a';
    p.setAttribute('data-late', 'x');
    doc.body.appendChild(p);
    const after = api.scan();
    assert.ok(byRaw(after, 'XjhqDGJH37VEpecoDGmtJrmEB7VoD8Lb39'));
    await sleep(1400);
    assert.ok(sent.length >= 1, 'mutation message sent');
    assert.equal(sent[0].type, 'content/mutation');
    assert.ok(Array.isArray(sent[0].result.candidates));
    // highlight/clear are self-inflicted and must not trigger another message
    await sleep(2300);
    const n = sent.length;
    api.highlight(['guaranteed']);
    api.clearHighlight();
    await sleep(2300);
    assert.equal(sent.length, n);
    w.close();
  });
});
