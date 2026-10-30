// End-to-end test: loads a COPY of the extension into real Chrome (headless),
// serves test/fixture.html locally, and points the ScamBusters base URL at a
// local mock server (the real API is never contacted).
// Usage: node run.mjs <projectDir> <puppeteerModulesDir> [--live]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const [, , P, MODS] = process.argv;
const LIVE = process.argv.includes('--live');
const require = createRequire(path.join(MODS, 'x.js'));
const puppeteer = require('puppeteer-core');
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), 'shots');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, cond, extra = '') => { results.push({ name, ok: !!cond, extra }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  -- ' + extra : ''}`); };

// ------------------------------------------------------------ servers
const mockCalls = [];
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/mock/api/')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      mockCalls.push({ method: req.method, path: u.pathname, auth: req.headers.authorization, ctype: req.headers['content-type'], query: u.search, body });
      const send = (s, j) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
      const site = u.pathname.endsWith('/check') ? u.searchParams.get('site_url') : (JSON.parse(body || '{}').site_url || '');
      const host = (() => { try { return new URL(/^https?:/.test(site) ? site : 'https://' + site).hostname.replace(/^www\./, ''); } catch { return ''; } })();
      if (u.pathname.endsWith('/check')) {
        if (host.startsWith('stale')) return send(200, { site_url: site, site_key: host, has_wallets: true, latest_wallet_collected_utc: '2026-01-01T00:00:00Z', stale: true, is_reported: true, site_status: 'active' });
        if (host.startsWith('ratelimit')) return send(429, { error: 'Rate limit exceeded: 50 check requests per minute.' });
        return send(200, { site_url: site, site_key: host, has_wallets: false, latest_wallet_collected_utc: null, stale: false, is_reported: false, site_status: 'unknown' });
      }
      if (u.pathname.endsWith('/submit')) {
        if (host.startsWith('notapproved')) return send(403, { error: 'Your account is not approved to submit. DM Sam Mabry (I4G) in Discord and share your scraper source code via GitHub (invite smabryCFRL as a collaborator) to request approval. Meanwhile, GET /api/check is available with your key.' });
        if (host.startsWith('expired')) return send(403, { error: 'Your API key has expired. Use /rotate-api-key in Discord to get a new one.' });
        if (host.startsWith('ratelimit')) return send(429, { error: 'Rate limit exceeded: 50 submissions per minute.' });
        if (host.startsWith('bad')) return send(400, { errors: ['site_url is not a valid URL: \'x\'', 'wallets[0].chain \'fakecoin\' is not a recognized chain.'] });
        if (host.startsWith('unavail')) return send(503, { error: 'Submission approval check is temporarily unavailable. Please retry shortly.' });
        const j = JSON.parse(body);
        return send(201, { submission_id: 'cb489690df08445b986b1f6eacadff5b', submission_key: '23723be4112639fc54e220258d4a393c8654916d', queued_ts_utc: '2026-10-27T16:15:23Z', site_url: j.site_url, wallet_count: (j.wallets || []).length, status: 'queued' });
      }
      send(404, { error: 'nope' });
    });
    return;
  }
  const f = path.join(P, 'test', decodeURIComponent(u.pathname));
  if (!f.startsWith(path.join(P, 'test')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'text/plain' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

// ------------------------------------------------------------ extension copy
const EXT = fs.mkdtempSync(path.join(os.tmpdir(), 'sbext-'));
fs.cpSync(P, EXT, { recursive: true, filter: s => !/[\\/](test|node_modules)([\\/]|$)/.test(s.slice(P.length)) });
const man = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
man.host_permissions.push('http://127.0.0.1/*');       // test-only: page access + mock API
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(man, null, 2));
const sbFile = path.join(EXT, 'background', 'scambusters.js');
fs.writeFileSync(sbFile, fs.readFileSync(sbFile, 'utf8').replace("'https://scambuster.intelligenceforgood.org'", `'${BASE}/mock'`));
if (!fs.readFileSync(sbFile, 'utf8').includes(`${BASE}/mock`)) throw new Error('mock patch failed');

const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true, pipe: true, protocolTimeout: 90000, enableExtensions: [EXT],
  args: ['--no-first-run', '--no-default-browser-check'],
});
try {
  const swT = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('background/service-worker.js'), { timeout: 15000 });
  const extId = new URL(swT.url()).host;
  check('service worker started (module SW, all imports resolve)', !!extId, extId);
  const sw = await swT.worker();
  const swErrors = [];
  sw.on('console', m => { if (m.type() === 'error') swErrors.push(m.text()); });

  // Panel page (real UI) and a raw-protocol helper page.
  const panel = await browser.newPage();
  const panelErrors = [];
  panel.on('pageerror', e => panelErrors.push(String(e)));
  panel.on('console', m => { if (m.type() === 'error') panelErrors.push(m.text()); });
  await panel.setViewport({ width: 420, height: 900 });
  await panel.goto(`chrome-extension://${extId}/sidepanel/panel.html`);

  const fixture = await browser.newPage();
  await fixture.goto(`${BASE}/fixture.html`, { waitUntil: 'load' });
  await fixture.bringToFront();

  // Raw protocol client running inside the panel page (an extension origin).
  await panel.evaluate(() => {
    window.__rpc = (() => {
      const port = chrome.runtime.connect({ name: 'sidepanel' });
      let n = 1e6; const pend = new Map(); let last = null;
      port.onMessage.addListener(m => {
        if (m.type === 'response') { const p = pend.get(m.reqId); if (p) { pend.delete(m.reqId); p(m); } }
        if (m.type === 'state') last = m.state;
      });
      return { call: (type, payload = {}) => new Promise(r => { const reqId = ++n; pend.set(reqId, r); setTimeout(() => { if (pend.delete(reqId)) r({ ok: false, error: { code: 'timeout', message: 'rpc timeout ' + type } }); }, 45000); port.postMessage({ reqId, type, ...payload }); }), last: () => last };
    })();
  });
  const rpc = (type, payload) => panel.evaluate((t, p) => window.__rpc.call(t, p), type, payload || {});
  const winId = await panel.evaluate(async () => (await chrome.windows.getCurrent()).id);
  const hello = await rpc('panel/hello', { windowId: winId });
  check('panel/hello returns state for the fixture tab', hello.ok && /fixture\.html$/.test(hello.data.state.url), hello.data && hello.data.state.url);

  const waitState = async (pred, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const s = await panel.evaluate(() => window.__rpc.last());
      if (s && pred(s)) return s;
      await new Promise(r => setTimeout(r, 250));
    }
    return panel.evaluate(() => window.__rpc.last());
  };

  // ---------------- detection
  let st = await waitState(s => s.scan.status === 'done');
  check('auto scan on open completed', st.scan.status === 'done', `frames=${st.scan.frames} ${st.scan.durationMs}ms`);
  check('scanned more than one frame (srcdoc iframe)', st.scan.frames >= 2, `frames=${st.scan.frames}`);
  const chains = [...new Set(st.wallets.map(w => w.chain))].sort();
  check('wallets detected for many chains', chains.length >= 10, chains.join(','));
  const ids = st.wallets.map(w => w.id);
  check('no duplicate wallet ids', new Set(ids).size === ids.length, `${ids.length} wallets`);
  const evm5aa = st.wallets.filter(w => w.normalized === '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed');
  check('checksummed + lowercase copies of an EVM address dedupe to one row', evm5aa.length === 1);
  check('rejected list contains checksum failures', st.rejected.length >= 4, st.rejected.map(r => r.chainGuess + ':' + r.reason.slice(0, 30)).join(' | '));
  check('no rejected entry also appears as a valid wallet', !st.rejected.some(r => st.wallets.some(w => w.address === r.raw)));
  const bep = st.wallets.find(w => w.normalized === '0x55d398326f99059ff775485246999027b3197955');
  check('context suggests BSC for the BEP20 address', bep && bep.suggestedChain === 'bsc', bep && `suggested=${bep.suggestedChain}`);
  check('SOL detected only with low confidence', st.wallets.filter(w => w.chain === 'sol').every(w => w.validation === 'unverified'));
  check('zero-width-split address reassembled', st.wallets.some(w => w.address === '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'));
  const xrpX = st.wallets.find(w => w.chain === 'xrp' && w.address === 'r9cZA1mLK5R5Am25ArfXFmqgNwjZgnfk59');
  check('X-address decoded to classic address', !!xrpX, xrpX ? `tag='${xrpX.xrpDestTag}'` : 'missing');
  const n0 = st.wallets.length;

  // dynamic content after the scan: the page appends a brand-new address; only the MutationObserver can see it
  check('timed fixture injection (new-only addresses) present', st.wallets.some(w => w.address === '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'));
  await fixture.evaluate(() => { const p = document.createElement('p'); p.textContent = 'Fresh deposit address: 0x52908400098527886E0F7030069857D2E4169EE7'; document.body.appendChild(p); });
  st = await waitState(s => s.wallets.length > n0, 12000);
  check('MutationObserver picked up injected addresses', st.wallets.length > n0, `${n0} -> ${st.wallets.length}`);
  const n1 = st.wallets.length;
  const rs = await rpc('scan/run');
  st = await waitState(s => s.scan.status === 'done');
  check('re-scan merges, no duplicates', rs.ok && st.wallets.length === n1, `added=${rs.data && rs.data.added}, total=${st.wallets.length}`);

  // badge
  const badge = await sw.evaluate(async () => { const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); return chrome.action.getBadgeText({ tabId: t.id }); });
  check('toolbar badge shows wallet count', badge === String(st.wallets.length), `badge=${badge}`);

  // ---------------- manual add / validation
  let r = await rpc('wallet/add', { input: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD', chain: 'auto' });
  check('manual add rejects bad EIP-55 with specific reason', !r.ok && /EIP-55/.test(r.error.message), r.error && r.error.message);
  r = await rpc('wallet/add', { input: '\u200b0x52908400098527886E0F7030069857D2E4169EE7 ', chain: 'auto' });
  check('manual add of ambiguous EVM asks for chain', r.ok && r.data.needsChain, JSON.stringify(r.data));
  r = await rpc('wallet/add', { input: '0x52908400098527886E0F7030069857D2E4169EE7', chain: 'matic' });
  check('manual add with chosen chain works', r.ok && r.data.wallet.chain === 'matic' && r.data.wallet.source === 'manual');
  r = await rpc('wallet/add', { input: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', chain: 'auto' });
  check('manual duplicate refused', !r.ok && r.error.code === 'duplicate');
  r = await rpc('wallet/add', { input: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', chain: 'btc' });
  check('wrong explicit chain refused with reason', !r.ok && /XRP/.test(r.error.message), r.error && r.error.message);
  await rpc('scan/run');
  st = await waitState(s => s.scan.status === 'done');
  check('manual entries survive re-scan', st.wallets.some(w => w.id === 'matic:0x52908400098527886e0f7030069857d2e4169ee7'));
  const evm = st.wallets.find(w => w.family === 'evm' && w.chain === 'eth');
  r = await rpc('wallet/setChain', { walletId: evm.id, chain: 'bsc' });
  st = await waitState(s => s.wallets.some(w => w.id === 'bsc:' + evm.normalized));
  check('EVM chain switcher changes chain/id', r.ok && st.wallets.some(w => w.id === 'bsc:' + evm.normalized));
  r = await rpc('wallet/setChain', { walletId: st.wallets.find(w => w.chain === 'trx').id, chain: 'eth' });
  check('non-EVM wallet cannot switch chain', !r.ok);

  // ---------------- keywords
  r = await rpc('keywords/run');
  check('keyword scan returns a score', r.ok && typeof r.data.score === 'number', r.ok ? `score=${r.data.score} band=${r.data.band} crypto=${r.data.cryptoContext} frames=${r.data.frames}` : JSON.stringify(r.error));
  const before = await fixture.evaluate(() => document.body.innerHTML.length);
  r = await rpc('keywords/highlight', { on: true });
  const marks = await fixture.evaluate(() => document.querySelectorAll('mark[data-sb-triage]').length);
  check('highlight adds marks to the page', r.ok && marks > 0, `marks=${marks}`);
  r = await rpc('keywords/highlight', { on: false });
  const after = await fixture.evaluate(() => [document.querySelectorAll('mark[data-sb-triage]').length, document.body.innerHTML.length]);
  check('highlight is reversible', r.ok && after[0] === 0 && after[1] === before, `marks=${after[0]} len ${before}->${after[1]}`);

  // ---------------- keys + ScamBusters (MOCK server only)
  r = await rpc('keys/save', { service: 'scambusters', value: 'sb_notakey' });
  check('invalid SB key format refused', !r.ok && r.error.code === 'invalid_format');
  r = await rpc('keys/save', { service: 'scambusters', value: 'sb_' + '0123456789abcdef'.repeat(2) });
  check('valid-format SB key saved; status masked', r.ok && r.data.keys.scambusters.state === 'saved' && !JSON.stringify(r.data).includes('0123456789abcdef0123'), r.data && r.data.keys.scambusters.masked);
  r = await rpc('sb/check', { siteUrl: 'https://unknown.test' });
  check('check -> Unsubmitted', r.ok && r.data.state === 'unsubmitted', JSON.stringify(r.error || r.data.state));
  r = await rpc('sb/check', { siteUrl: 'stale.test' });
  check('check -> stale wallets', r.ok && r.data.state === 'stale');
  const chk = mockCalls.find(c => c.path.endsWith('/check'));
  check('check uses Bearer header, no Content-Type, site_url param', chk && /^Bearer sb_[0-9a-f]{32}$/.test(chk.auth) && !chk.ctype && /site_url=/.test(chk.query));

  const sel = st.wallets.filter(w => w.selected).slice(0, 5).map(w => w.id);
  await rpc('wallet/select', { all: true, selected: false });
  r = await rpc('sb/submit', { siteUrl: 'https://scam-example.test', walletIds: sel });
  const sub = mockCalls.filter(c => c.path.endsWith('/submit')).pop();
  const body = sub && JSON.parse(sub.body);
  check('submit 201 queued with submission_id', r.ok && r.data.status === 'queued' && r.data.submission_id, JSON.stringify(r.data || r.error));
  check('submit body: site_url, wallets with canonical lowercase chains', body && body.site_url && body.wallets.length === sel.length && body.wallets.every(w => /^[a-z]+$/.test(w.chain)) && sub.ctype === 'application/json');
  r = await rpc('sb/submit', { siteUrl: 'https://scam-example.test', walletIds: [] });
  check('second submit within minutes warns (recent_submit)', !r.ok && r.error.code === 'recent_submit', r.error && r.error.message);
  r = await rpc('sb/submit', { siteUrl: 'https://scam-example.test', walletIds: [], force: true });
  const sub2 = mockCalls.filter(c => c.path.endsWith('/submit')).pop();
  check('site-only submit omits wallets entirely', r.ok && !('wallets' in JSON.parse(sub2.body)));
  for (const [host, code] of [['notapproved', 'not_approved'], ['expired', 'expired_key'], ['bad', 'bad_request'], ['unavail', 'unavailable'], ['ratelimit', 'rate_limited']]) {
    r = await rpc('sb/submit', { siteUrl: `https://${host}.test`, walletIds: [], force: true });
    const extra = r.error ? `${r.error.code}${r.error.details ? ' details=' + r.error.details.length : ''}${r.error.retryAfterMs ? ' retry=' + r.error.retryAfterMs : ''}` : '';
    check(`submit error mapped: ${host} -> ${code}`, !r.ok && r.error.code === code && (code !== 'bad_request' || r.error.details.length === 2), extra);
  }
  r = await rpc('sb/submit', { siteUrl: 'https://after-429.test', walletIds: [], force: true });
  const calls = mockCalls.filter(c => c.path.endsWith('/submit')).length;
  check('after 429, submit blocked client-side (no blind retry)', !r.ok && r.error.code === 'rate_limited' && !mockCalls.some(c => c.body.includes('after-429')), `submit calls=${calls}`);
  const tooMany = Array.from({ length: 31 }, (_, i) => st.wallets[i % st.wallets.length].id);
  r = await rpc('sb/submit', { siteUrl: 'https://x.test', walletIds: [...new Set(tooMany)].length > 30 ? tooMany : [...Array(31).keys()].map(String) });
  check('>30 wallets blocked or invalid ids refused (never sent)', !r.ok);

  // ---------------- log
  r = await rpc('log/list');
  check('log has submit entries', r.ok && r.data.entries.some(e => e.type === 'submit' && e.submission_id));
  check('log never contains the key', !JSON.stringify(r.data).includes('0123456789abcdef0123'));

  // ---------------- live on-chain (only with --live; read-only public addresses)
  if (LIVE) {
    const env = Object.fromEntries(fs.readFileSync(path.join(P, 'test', '.env.test'), 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => l.split('=').map(s => s.trim())));
    await rpc('keys/save', { service: 'etherscan', value: env.ETHERSCAN_API_KEY });
    await rpc('keys/save', { service: 'tronscan', value: env.TRONSCAN_API_KEY });
    const targets = st.wallets.filter(w => ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'].includes(w.address));
    for (const w of targets) await rpc('onchain/lookup', { walletId: w.id, force: true });
    st = await waitState(s => targets.every(w => s.onchain[w.id] && ['done', 'error'].includes(s.onchain[w.id].status)), 90000);
    for (const w of targets) {
      const o = st.onchain[w.id];
      check(`live lookup in extension: ${w.chain} ${w.address.slice(0, 10)}`, o && o.status === 'done',
        o && o.status === 'done' ? `tx=${o.data.txCount} bal=${o.data.balance} usdt=${o.data.usdtBalance} labels=${(o.data.labels || []).map(l => l.text + '/' + l.risk).join(';')}` : JSON.stringify(o && o.error));
    }
    r = await rpc('rdap/lookup');
    check('RDAP on 127.0.0.1 gives a readable error (IP, no domain)', !r.ok, r.error && r.error.message);
  }

  // ---------------- UI screenshots of the real panel
  // The real side panel lives in the tab's window. Emulate: open panel.html in its own window
  // but make chrome.windows.getCurrent() report the fixture's window.
  const ui = await browser.newPage();
  ui.on('pageerror', e => panelErrors.push(String(e)));
  await ui.setViewport({ width: 420, height: 1000 });
  await ui.evaluateOnNewDocument(w => { const orig = chrome.windows.getCurrent.bind(chrome.windows); chrome.windows.getCurrent = async (...a) => ({ ...(await orig(...a)), id: w }); }, winId);
  await ui.goto(`chrome-extension://${extId}/sidepanel/panel.html`);
  await fixture.bringToFront();
  await new Promise(r => setTimeout(r, 2000));
  for (const tab of ['Overview', 'Wallets', 'On-chain', 'Content', 'Log', 'Settings']) {
    await ui.evaluate(name => { const b = [...document.querySelectorAll('[role=tab]')].find(x => x.textContent.trim().startsWith(name)); if (b) b.click(); }, tab);
    await new Promise(r => setTimeout(r, 600));
    await ui.screenshot({ path: path.join(OUT, `${tab}.png`), fullPage: true }).catch(e => console.log('screenshot failed', tab, e.message));
  }
  await ui.evaluate(() => { const b = [...document.querySelectorAll('[role=tab]')].find(x => x.textContent.trim().startsWith('Wallets')); if (b) b.click(); });
  await new Promise(r => setTimeout(r, 500));
  const walletsShown = await ui.evaluate(() => document.body.innerText.includes('TR7NHq') || [...document.querySelectorAll('[title]')].some(e => e.title.includes('TR7NHq')));
  check('real panel UI renders the fixture wallets', walletsShown);
  check('no uncaught errors in panel', panelErrors.length === 0, panelErrors.slice(0, 3).join(' | '));
  check('no console errors in service worker', swErrors.length === 0, swErrors.slice(0, 3).join(' | '));

  // restricted page in the fixture's window
  const cp = await browser.newPage();
  await cp.goto('chrome://version').catch(() => {});
  await cp.bringToFront();
  st = await waitState(s => s.page.kind === 'restricted', 5000);
  check('chrome:// page shows restricted state', st.page.kind === 'restricted', st.page.reason);
  await new Promise(r => setTimeout(r, 800));
  await ui.screenshot({ path: path.join(OUT, 'Restricted.png') }).catch(e => console.log('screenshot failed restricted', e.message));
} finally {
  await browser.close();
  srv.close();
  fs.rmSync(EXT, { recursive: true, force: true });
}
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
