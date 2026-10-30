// Dev-only: stubs globalThis.chrome with a fake worker and canned TabState, then loads the panel.
// Query params: ?scenario=restricted|no_access|empty   ?tab=wallets   ?theme (ignored; use prefers-color-scheme)
const q = new URLSearchParams(location.search);
const scenario = q.get('scenario') || 'full';
const now = Date.now();
const clone = o => JSON.parse(JSON.stringify(o));

const W = [
  { id: 'eth:0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae', chain: 'eth', address: '0xDe0B295669a9FD93d5F28D9Ec85E40f4cb697BAe', normalized: '0xde0b295669a9fd93d5f28d9ec85e40f4cb697bae', family: 'evm', validation: 'checksum', kind: 'EIP-55', source: 'auto', contexts: ['Send USDT (BEP20) to this address to claim your 500% bonus', 'Deposit address'], foundIn: 'text', suggestedChain: 'bsc', selected: true, xrpDestTag: '' },
  { id: 'btc:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', chain: 'btc', address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', normalized: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', family: 'btc', validation: 'checksum', kind: 'Bech32 (v0 P2WPKH)', source: 'auto', contexts: ['BTC wallet'], foundIn: 'attr', suggestedChain: null, selected: true, xrpDestTag: '' },
  { id: 'trx:TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', chain: 'trx', address: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', normalized: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE', family: 'trx', validation: 'checksum', kind: 'Base58Check', source: 'manual', contexts: [], foundIn: 'manual', suggestedChain: null, selected: true, xrpDestTag: '' },
  { id: 'xrp:rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh', chain: 'xrp', address: 'rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh', normalized: 'rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh', family: 'xrp', validation: 'checksum', kind: 'XRP classic', source: 'auto', contexts: ['XRP deposit'], foundIn: 'input', suggestedChain: null, selected: false, xrpDestTag: '12345', labels: [{ text: 'Mixer-linked', source: 'Tronscan', risk: 'caution' }] },
  { id: 'sol:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', chain: 'sol', address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', normalized: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', family: 'sol', validation: 'unverified', kind: 'Base58 32 bytes', source: 'auto', contexts: ['Solana address'], foundIn: 'text', suggestedChain: null, selected: false, xrpDestTag: '' },
  { id: 'ltc:LdP8Qox1VAhCzLJNqrr74YovaWYyNBUWvL', chain: 'ltc', address: 'LdP8Qox1VAhCzLJNqrr74YovaWYyNBUWvL', normalized: 'LdP8Qox1VAhCzLJNqrr74YovaWYyNBUWvL', family: 'ltc', validation: 'no_checksum', kind: 'P2PKH', source: 'auto', contexts: ['<img src=x onerror=alert(1)> LTC'], foundIn: 'href', suggestedChain: null, selected: false, xrpDestTag: '' },
];

function fullState() {
  const w = clone(W);
  return {
    tabId: 7, url: 'https://free-btc-doubler.example/claim?ref=abc', origin: 'https://free-btc-doubler.example', hostname: 'free-btc-doubler.example',
    page: { kind: 'ok' },
    scan: { status: 'done', at: now - 60000, frames: 3, durationMs: 142 },
    wallets: w,
    rejected: [
      { raw: '0xde0b295669a9fd93d5f28d9ec85e40f4cb697baf', chainGuess: 'eth', reason: 'Mixed-case EIP-55 checksum does not match', context: 'Wallet: 0xde0b…' },
      { raw: '1BoatSLRHtKNngkdXEeobR76b53LETtpyX', chainGuess: 'btc', reason: 'Bad Base58Check checksum', context: '' },
    ],
    check: { status: 'done', at: now, data: { site_url: 'https://free-btc-doubler.example', site_key: 'free-btc-doubler.example', has_wallets: true, latest_wallet_collected_utc: '2026-09-02T10:15:00Z', stale: true, is_reported: true, site_status: 'active', state: 'stale', queriedUrl: 'https://free-btc-doubler.example' } },
    submit: { status: 'error', at: now, retryAt: now + 90000, error: { code: 'rate_limited', message: 'Too many submissions from this key.', retryAfterMs: 90000, guidance: 'Wait for the countdown, then submit again.' } },
    onchain: {
      [w[0].id]: { status: 'done', at: now, data: { chain: 'eth', address: w[0].address, nativeSymbol: 'ETH', txCount: 10000, balance: '12345.678901234567890123', usdtBalance: '1234567.89', volumeIn: { native: '98765432.1', usdt: '5000000' }, volumeOut: { native: '98700000', usdt: '4900000.5' }, sampled: { native: 10000, usdt: 5000 }, firstSeen: '2023-01-02T03:04:05Z', lastActivity: '2026-10-01T12:00:00Z', labels: [{ text: 'Phishing', source: 'Etherscan', risk: 'high', kind: 'phish-hack' }, { text: 'Exchange Deposit', source: 'Blockscout', risk: 'none' }], notes: ['Volume covers only the sampled transactions.', 'Internal transactions are not included.'], source: 'Etherscan V2', explorerUrl: 'https://etherscan.io/address/' + w[0].address } },
      [w[1].id]: { status: 'loading' },
      [w[2].id]: { status: 'error', at: now, retryAt: now + 45000, error: { code: 'rate_limited', message: 'Tronscan rate limit reached.', retryAfterMs: 45000 } },
      [w[3].id]: { status: 'error', error: { code: 'no_key', message: 'No Etherscan key set.', guidance: 'Add a key in Settings.' } },
      [w[4].id]: { status: 'error', error: { code: 'not_supported', message: 'On-chain lookup is not supported for Solana yet.' } },
    },
    keywords: { status: 'done', highlighted: true, data: { score: 78, band: 'High', cryptoContext: true, cryptoHits: 14, categories: [{ category: 'guaranteed returns', hits: 4, points: 32 }, { category: 'urgency', hits: 3, points: 18 }, { category: 'giveaway', hits: 2, points: 20 }, { category: 'wallet connect', hits: 1, points: 8 }], top: [{ keyword: 'double your bitcoin', category: 'giveaway', weight: 10, count: 2, points: 20 }, { keyword: 'guaranteed profit', category: 'guaranteed returns', weight: 8, count: 3, points: 24 }, { keyword: 'limited time', category: 'urgency', weight: 6, count: 3, points: 18 }], frames: 3, chars: 14200 } },
    rdap: { status: 'done', data: { domain: 'free-btc-doubler.example', registrar: 'NameCheap, Inc.', created: new Date(now - 12 * 864e5).toISOString(), updated: null, expires: '2027-09-30T00:00:00Z', ageDays: 12, status: ['client transfer prohibited'], nameservers: ['ns1.example-dns.com', 'ns2.example-dns.com'], source: 'rdap.org' } },
    urlscan: {
      search: { status: 'done', data: { total: 14, results: [
        { uuid: 'a1', time: '2026-10-20T10:00:00Z', url: 'https://free-btc-doubler.example/claim', ip: '104.21.5.9', asn: 'AS13335', asnname: 'CLOUDFLARENET', country: 'US', server: 'cloudflare', screenshot: 'https://urlscan.io/screenshots/a1.png', resultUrl: 'https://urlscan.io/result/a1/', malicious: true },
        { uuid: 'a2', time: '2026-10-11T08:30:00Z', url: 'https://free-btc-doubler.example/', ip: '104.21.5.9', asn: 'AS13335', asnname: 'CLOUDFLARENET', country: 'US', server: 'cloudflare', screenshot: 'https://urlscan.io/screenshots/a2.png', resultUrl: 'https://urlscan.io/result/a2/' }] } },
      scan: { status: 'done', phase: 'done', data: { uuid: 'b1', resultUrl: 'https://urlscan.io/result/b1/', screenshot: 'https://urlscan.io/screenshots/b1.png', verdict: { score: 100, malicious: true, categories: ['phishing'], brands: ['Binance'] }, page: { ip: '104.21.5.9', asn: 'AS13335', asnname: 'CLOUDFLARENET', country: 'US', server: 'cloudflare', domain: 'free-btc-doubler.example', url: 'https://free-btc-doubler.example/claim' } } },
    },
  };
}

function makeState() {
  if (scenario === 'restricted') return { tabId: 1, url: 'chrome://extensions', origin: '', hostname: 'extensions', page: { kind: 'restricted', reason: 'Chrome internal pages (chrome://) cannot be scanned.' }, scan: { status: 'idle' }, wallets: [], rejected: [], check: { status: 'idle' }, submit: { status: 'idle' }, onchain: {}, keywords: { status: 'idle', highlighted: false }, rdap: { status: 'idle' }, urlscan: { search: { status: 'idle' }, scan: { status: 'idle' } } };
  if (scenario === 'no_access') { const s = makeState2(); s.page = { kind: 'no_access' }; return s; }
  if (scenario === 'empty') { const s = makeState2(); s.wallets = []; s.rejected = []; s.onchain = {}; s.check = { status: 'idle' }; s.submit = { status: 'idle' }; s.keywords = { status: 'idle', highlighted: false }; s.rdap = { status: 'idle' }; s.urlscan = { search: { status: 'idle' }, scan: { status: 'idle' } }; return s; }
  return fullState();
}
function makeState2() { return fullState(); }

let state = makeState();
let settings = { autoScan: false, autoOnchain: false, autoCheck: true, urlscanVisibility: 'unlisted', allSites: false };
let keys = {
  scambusters: { state: 'saved', masked: 'sb_…1a2b', savedAt: now - 26 * 864e5, ageDays: 26, warn: true },
  urlscan: { state: 'saved', masked: '1234…cdef', ageDays: 3 },
  blockchain: { state: 'not_set' },
  etherscan: { state: 'invalid' },
  tronscan: { state: 'not_set' },
};
const logEntries = [
  { at: now - 3600e3, type: 'submit', siteUrl: 'https://free-btc-doubler.example', status: 'queued', submission_id: 'sub_9f8e7d', wallet_count: 3 },
  { at: now - 7200e3, type: 'check', siteUrl: 'https://other.example', status: 'unsubmitted' },
  { at: now - 9000e3, type: 'submit', siteUrl: 'https://bad.example', status: 'error', error: { message: 'Key expired' } },
];

const listeners = [];
let disconnectCbs = [];
const push = o => setTimeout(() => listeners.forEach(f => f(o)), 0);
const pushState = () => push({ type: 'state', state: clone(state) });

function handle(msg) {
  const p = msg;
  const ok = data => ({ type: 'response', reqId: p.reqId, ok: true, data });
  const bad = (code, message, extra) => ({ type: 'response', reqId: p.reqId, ok: false, error: { code, message, ...extra } });
  const wal = id => state.wallets.find(w => w.id === id);
  switch (p.type) {
    case 'panel/hello': return ok({ state: clone(state), settings, keys });
    case 'scan/run': return ok({ added: 0, rejected: 0 });
    case 'wallet/add':
      if (/^amb/.test(p.input) && p.chain === 'auto') return ok({ needsChain: true, options: ['eth', 'bsc', 'matic'] });
      if (/^bad/.test(p.input)) return bad('invalid_address', 'Not a valid address: checksum mismatch for the Bitcoin Base58Check format.');
      return ok({ wallet: W[0] });
    case 'wallet/remove': state.wallets = state.wallets.filter(w => w.id !== p.walletId); pushState(); return ok({});
    case 'wallet/select':
      state.wallets.forEach(w => { if (p.all || w.id === p.walletId) w.selected = p.selected; }); pushState(); return ok({});
    case 'wallet/setChain': { const w = wal(p.walletId); if (w) w.chain = p.chain; pushState(); return ok({ wallet: w }); }
    case 'wallet/setDestTag': { const w = wal(p.walletId); if (w) w.xrpDestTag = p.tag; pushState(); return ok({}); }
    case 'sb/check': return ok(state.check.data);
    case 'sb/submit':
      if (!p.force && p.siteUrl.indexOf('recent') < 0 && !globalThis.__sawRecent) { globalThis.__sawRecent = true; return bad('recent_submit', 'This site was submitted from this browser 4 minutes ago.'); }
      return ok({ httpStatus: 201, status: 'queued', submission_id: 'sub_123abc', submission_key: 'k', queued_ts_utc: new Date().toISOString(), site_url: p.siteUrl, wallet_count: p.walletIds.length });
    case 'onchain/lookup': return ok({});
    case 'keywords/run': return ok(state.keywords.data);
    case 'keywords/highlight': state.keywords.highlighted = p.on; pushState(); return ok({ count: 5 });
    case 'rdap/lookup': return ok(state.rdap.data);
    case 'urlscan/search': return ok(state.urlscan.search.data);
    case 'urlscan/scan': return bad('no_key', 'No URLScan key is set.');
    case 'settings/set': Object.assign(settings, p.patch); push({ type: 'settings', settings, keys }); return ok({ settings });
    case 'keys/save': keys[p.service] = { state: 'saved', masked: '…' + p.value.slice(-4), ageDays: 0 }; push({ type: 'settings', settings, keys }); return ok({ keys });
    case 'keys/clear': keys[p.service] = { state: 'not_set' }; push({ type: 'settings', settings, keys }); return ok({ keys });
    case 'keys/test': return p.service === 'etherscan' ? bad('invalid_key', 'Etherscan rejected the key.', { guidance: 'Check the key at etherscan.io/myapikey.' }) : ok({ message: 'Key works.' });
    case 'log/list': return ok({ entries: logEntries });
    case 'log/clear': logEntries.length = 0; return ok({});
    default: return bad('unknown', 'Unknown request ' + p.type);
  }
}

globalThis.chrome = {
  runtime: {
    connect() {
      const l = [];
      listeners.push(...[]);
      const port = {
        name: 'sidepanel',
        onMessage: { addListener: f => { l.push(f); listeners.push(f); } },
        onDisconnect: { addListener: f => disconnectCbs.push(f) },
        postMessage(m) { setTimeout(() => l.forEach(f => f(handle(m))), 60); },
      };
      return port;
    },
  },
  windows: { getCurrent: async () => ({ id: 1 }) },
  permissions: {
    contains: async () => settings.allSites,
    request: async () => true,
    remove: async () => true,
  },
  tabs: { create: o => { console.log('tabs.create', o); (globalThis.__opened ||= []).push(o.url); } },
};
globalThis.__harness = { pushState, state: () => state, disconnect: () => disconnectCbs.forEach(f => f()) };

// Simulate a worker-pushed update a moment after load (proves in-place re-render).
await import('../sidepanel/panel.js');
const tab = q.get('tab');
if (tab) setTimeout(() => document.getElementById('tab-' + tab)?.click(), 300);
