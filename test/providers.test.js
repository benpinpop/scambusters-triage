// Unit tests for the on-chain provider adapters and the RDAP / URLScan clients.
// fetch is mocked; nothing here touches the network. Mock bodies copy the shapes
// observed in live calls (2026-10-27).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { POLICIES } from '../lib/net/queue.js';
import { lookupWallet, lookupSupport, lookupLabels, testKey } from '../lib/providers/index.js';
import { rdapLookup, mapRdap } from '../lib/intel/rdap.js';
import { urlscanSearch, urlscanSubmit, urlscanResult } from '../lib/intel/urlscan.js';

for (const p of Object.values(POLICIES)) { p.minIntervalMs = 0; delete p.windows; }

const realFetch = globalThis.fetch;
let calls;
// Label endpoints are answered with "nothing known" and not recorded, unless a test
// installs its own handler with mockLabelsWith().
let labelHandler = null;
const LABEL_URL = /api\.coingecko\.com|metadata\.services\.blockscout\.com|api\.xrpscan\.com|walletexplorer\.com|action=getsourcecode|\/api\/security\/account\/data/;
const setLabels = fn => { labelHandler = fn; };
function defaultLabelBody(u) {
  if (u.includes('api.coingecko.com')) return {};
  if (u.includes('metadata.services.blockscout.com')) return { addresses: {} };
  if (u.includes('xrpscan')) return { accountName: null, advisory: null };
  if (u.includes('walletexplorer')) return { found: false };
  if (u.includes('getsourcecode')) return { status: '1', message: 'OK', result: [{ SourceCode: '', ABI: 'Contract source code not verified', ContractName: '' }] };
  return { send_ad_by_memo: false, has_fraud_transaction: false, fraud_token_creator: false, is_black_list: false };
}
function mock(handler) {
  calls = [];
  labelHandler = null;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    let r;
    if (LABEL_URL.test(u) && !labelHandler) r = { body: defaultLabelBody(u) };
    else { calls.push({ url: u, init }); r = await ((labelHandler && LABEL_URL.test(u)) ? labelHandler : handler)(u, init); }
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    const headers = new Map(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    return { status: r.status ?? 200, ok: (r.status ?? 200) < 300, headers: { get: k => headers.get(k.toLowerCase()) ?? null }, text: async () => text };
  };
}
afterEach(() => { globalThis.fetch = realFetch; });
beforeEach(() => { calls = []; });

const ADDR = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const ME = ADDR.toLowerCase();
const OTHER = '0x300c0212ae183e96707aefe198372433d60eccb6';
const ok = result => ({ body: { status: '1', message: 'OK', result } });
const q = u => new URL(u).searchParams;

function ethTx(i, { from = OTHER, to = ME, value = '1000', isError = '0', ts = 1455749271 + i } = {}) {
  return { blockNumber: String(i), timeStamp: String(ts), hash: '0x' + i, from, to, value, isError };
}
function tokTx(i, { from = OTHER, to = ME, value = '2069000000', dec = '6', ts = 1718284331 + i } = {}) {
  return { blockNumber: String(i), timeStamp: String(ts), from, to, contractAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7', value, tokenName: 'Tether USD', tokenSymbol: 'USDT', tokenDecimal: dec };
}

// ------------------------------------------------------------------ Etherscan
test('etherscan: normal eth lookup maps balance, volumes, USDT, first/last', async () => {
  mock(u => {
    const p = q(u);
    assert.equal(p.get('chainid'), '1');
    assert.ok(p.get('apikey'));
    switch (p.get('action')) {
      case 'balance': return ok('375739405726523274');
      case 'txlist': return ok([
        ethTx(1, { to: ME, value: '500000000000000000' }),
        ethTx(2, { from: ME, to: OTHER, value: '100000000000000000' }),
        ethTx(3, { from: ME, to: OTHER, value: '999', isError: '1' }), // failed: ignored in volume
      ]);
      case 'tokenbalance': return ok('2258162236');
      case 'tokentx': return ok([tokTx(1, { value: '2069000000' }), tokTx(2, { from: ME, to: OTHER, value: '9000000' })]);
      default: throw new Error('unexpected ' + u);
    }
  });
  const r = await lookupWallet({ chain: 'eth', address: ADDR }, { etherscan: 'KEY' });
  assert.equal(r.chain, 'eth');
  assert.equal(r.nativeSymbol, 'ETH');
  assert.equal(r.balance, '0.375739405726523274');
  assert.equal(r.txCount, 3);
  assert.equal(r.volumeIn.native, '0.5');
  assert.equal(r.volumeOut.native, '0.1');
  assert.equal(r.usdtBalance, '2258.162236');
  assert.equal(r.volumeIn.usdt, '2069');
  assert.equal(r.volumeOut.usdt, '9');
  assert.equal(r.sampled, false);
  assert.equal(r.source, 'Etherscan V2');
  assert.equal(r.explorerUrl, `https://etherscan.io/address/${ADDR}`);
  assert.match(r.firstSeen, /^2016-02-17T/);
  assert.ok(r.notes.some(n => /internal/i.test(n)));
  assert.ok(!('raw' in r));
});

test('etherscan: empty account ("No transactions found") is zeros, not an error', async () => {
  mock(u => {
    const a = q(u).get('action');
    if (a === 'balance') return ok('0');
    if (a === 'tokenbalance') return ok('0');
    return { body: { status: '0', message: 'No transactions found', result: [] } };
  });
  const r = await lookupWallet({ chain: 'eth', address: ADDR }, { etherscan: 'KEY' });
  assert.equal(r.txCount, 0);
  assert.equal(r.balance, '0');
  assert.equal(r.volumeIn.native, '0');
  assert.equal(r.usdtBalance, '0');
  assert.equal(r.firstSeen, null);
  assert.equal(r.sampled, false);
});

test('etherscan: rate-limit body is retried through the queue', async () => {
  let n = 0;
  mock(u => {
    const a = q(u).get('action');
    if (a === 'balance' && n++ === 0) return { body: { status: '0', message: 'NOTOK', result: 'Max rate limit reached, please use API Key for higher rate limit' } };
    if (a === 'balance') return ok('5');
    if (a === 'tokenbalance') return ok('0');
    return { body: { status: '0', message: 'No transactions found', result: [] } };
  });
  const r = await lookupWallet({ chain: 'eth', address: ADDR }, { etherscan: 'KEY' });
  assert.equal(r.balance, '0.000000000000000005');
  assert.equal(n, 2); // first call limited, second succeeded
});

test('etherscan: rate limit that persists surfaces rate_limited', async () => {
  const saved = POLICIES.etherscan.minIntervalMs;
  mock(() => ({ body: { status: '0', message: 'NOTOK', result: 'Max rate limit reached' } }));
  await assert.rejects(
    () => lookupWallet({ chain: 'eth', address: ADDR }, { etherscan: 'KEY' }),
    e => e.code === 'rate_limited' && /rate limit/i.test(e.message),
  );
  POLICIES.etherscan.minIntervalMs = saved;
}, { timeout: 15000 });

test('etherscan: invalid key -> invalid_key', async () => {
  mock(() => ({ body: { status: '0', message: 'NOTOK', result: 'Invalid API Key (#err2)' } }));
  await assert.rejects(() => lookupWallet({ chain: 'eth', address: ADDR }, { etherscan: 'BAD' }), e => e.code === 'invalid_key');
  await assert.rejects(() => testKey('etherscan', 'BAD'), e => e.code === 'invalid_key');
});

test('etherscan: paid-plan chain -> not_supported from the Etherscan adapter after one call', async () => {
  const { lookup } = await import('../lib/providers/etherscan.js');
  mock(() => ({ body: { status: '0', message: 'NOTOK', result: 'Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage. https://etherscan.io/apis' } }));
  await assert.rejects(() => lookup({ chain: 'bsc', address: ADDR }, 'KEY'), e => e.code === 'not_supported' && /paid/i.test(e.message));
  assert.equal(calls.length, 1);
  assert.equal(q(calls[0].url).get('chainid'), '56');
});

test('etherscan: missing key -> no_key without any request', async () => {
  mock(() => { throw new Error('should not fetch'); });
  await assert.rejects(() => lookupWallet({ chain: 'eth', address: ADDR }, { etherscan: '' }), e => e.code === 'no_key');
  await assert.rejects(() => lookupWallet({ chain: 'eth', address: ADDR }, {}), e => e.code === 'no_key');
  assert.equal(calls.length, 0);
});

test('etherscan: hitting the page cap sets sampled and fetches the newest row', async () => {
  mock(u => {
    const p = q(u);
    const a = p.get('action');
    if (a === 'balance') return ok('1');
    if (a === 'tokenbalance') return ok('0');
    if (a === 'tokentx') return { body: { status: '0', message: 'No transactions found', result: [] } };
    // txlist: 1000 rows on both pages, newest row on the desc request
    if (p.get('sort') === 'desc') return ok([ethTx(9999, { ts: 1800000000 })]);
    const page = Number(p.get('page'));
    return ok(Array.from({ length: 1000 }, (_, i) => ethTx(page * 1000 + i, { value: '1' })));
  });
  const r = await lookupWallet({ chain: 'eth', address: ADDR }, { etherscan: 'KEY' });
  assert.deepEqual(r.sampled, { native: 2000 });
  assert.equal(r.txCount, 2000);
  assert.equal(r.volumeIn.native, '0.000000000000002');
  assert.equal(new Date(r.lastActivity).getTime(), 1800000000 * 1000);
  assert.ok(r.notes.some(n => /sampled/i.test(n)));
  // never asks for a third page
  assert.ok(!calls.some(c => q(c.url).get('page') === '3'));
});

test('etherscan: 18-decimal USDT on BSC is formatted exactly (BigInt)', async () => {
  const big = '123456789012345678901234567'; // 123456789.012345678901234567 USDT, beyond 2^53
  mock(u => {
    const p = q(u);
    assert.equal(p.get('chainid'), '56');
    const a = p.get('action');
    if (a === 'balance') return ok('1000000000000000001');
    if (a === 'tokenbalance') {
      assert.equal(p.get('contractaddress'), '0x55d398326f99059fF775485246999027B3197955');
      return ok(big);
    }
    if (a === 'tokentx') return ok([tokTx(1, { value: big, dec: '18' }), tokTx(2, { from: ME, to: OTHER, value: '1', dec: '18' })]);
    return { body: { status: '0', message: 'No transactions found', result: [] } };
  });
  const r = await lookupWallet({ chain: 'bsc', address: ADDR }, { etherscan: 'KEY' });
  assert.equal(r.nativeSymbol, 'BNB');
  assert.equal(r.balance, '1.000000000000000001');
  assert.equal(r.usdtBalance, '123456789.012345678901234567');
  assert.equal(r.volumeIn.usdt, '123456789.012345678901234567');
  assert.equal(r.volumeOut.usdt, '0.000000000000000001');
});

test('etherscan: testKey ok', async () => {
  mock(() => ok('0'));
  const r = await testKey('etherscan', 'KEY');
  assert.match(r.message, /accepted/i);
});

// ------------------------------------------------------------------ Blockchain.com
test('blockchain: rawaddr limit=0 mapping (satoshi -> BTC)', async () => {
  mock(() => ({ body: '{"hash160":"62e9","address":"1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa","n_tx":67174,"n_unredeemed":81110,"total_received":10770069914,"total_sent":0,"final_balance":10770069914,"txs":[]}' }));
  const r = await lookupWallet({ chain: 'btc', address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa' }, {});
  assert.equal(r.txCount, 67174);
  assert.equal(r.balance, '107.70069914');
  assert.equal(r.volumeIn.native, '107.70069914');
  assert.equal(r.volumeOut.native, '0');
  assert.equal(r.usdtBalance, null);
  assert.equal(r.source, 'Blockchain.com');
  assert.match(calls[0].url, /rawaddr\/1A1z.*\?limit=0$/);
  assert.ok(!/api_code/.test(calls[0].url));
});

test('blockchain: api_code only sent when a key exists; 404 -> not_found', async () => {
  mock(() => ({ status: 404, body: 'Invalid Bitcoin Address' }));
  await assert.rejects(() => lookupWallet({ chain: 'btc', address: '1bad' }, { blockchain: 'CODE' }), e => e.code === 'not_found');
  assert.match(calls[0].url, /api_code=CODE/);
});

// ------------------------------------------------------------------ Tronscan
const TUSDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TADDR = 'TSBHPFbPUUntP8d3mZ4KzdCNJnFJDsDGCq';
const TOTHER = 'TDY65riaD8aA2KhbTT2W8AxhLKnYJFHweG';
function tronMock({ trxRows = [], usdtRows = [], acct } = {}) {
  mock(u => {
    const url = new URL(u);
    if (url.pathname === '/api/accountv2') {
      return { body: acct || { address: TADDR, balance: 27452117134, balanceStr: '27452117134', transactions_in: 450898, transactions_out: 345860, transactions: 796758, date_created: 1787058654000, latest_operation_time: 1793127996000, withPriceTokens: [
        { tokenId: '_', tokenType: 'trc10', balance: '27452117134', tokenDecimal: 6, tokenAbbr: 'trx' },
        { tokenId: TUSDT, tokenType: 'trc20', balance: '40137050660', tokenDecimal: 6, tokenAbbr: 'USDT' }] } };
    }
    const start = Number(url.searchParams.get('start'));
    assert.equal(url.searchParams.get('limit'), '50');
    if (url.pathname === '/api/transfer') return { body: { total: 1130, data: trxRows.slice(start, start + 50) } };
    if (url.pathname === '/api/token_trc20/transfers') return { body: { total: 10000, rangeTotal: 10000, token_transfers: usdtRows.slice(start, start + 50) } };
    throw new Error('unexpected ' + u);
  });
}
const trxRow = (from, to, amount, extra = {}) => ({ transferFromAddress: from, transferToAddress: to, amount, tokenName: '_', contractRet: 'SUCCESS', tokenInfo: { tokenId: '_', tokenDecimal: 6 }, ...extra });
const usdtRow = (from, to, quant) => ({ from_address: from, to_address: to, quant, contract_address: TUSDT, finalResult: 'SUCCESS', tokenInfo: { tokenId: TUSDT, tokenDecimal: 6 } });

test('tronscan: maps accountv2 + transfers, sends TRON-PRO-API-KEY header only', async () => {
  tronMock({
    trxRows: [trxRow(TOTHER, TADDR, 10000), trxRow(TADDR, TOTHER, 2500000), trxRow(TOTHER, TADDR, 5, { contractRet: 'OUT_OF_ENERGY' }), trxRow(TOTHER, TADDR, 7, { tokenName: 'BTT', tokenInfo: { tokenId: '1002000' } })],
    usdtRows: [usdtRow(TOTHER, TADDR, '100000000'), usdtRow(TADDR, TOTHER, '46773717')],
  });
  const r = await lookupWallet({ chain: 'trx', address: TADDR }, { tronscan: 'TKEY' });
  assert.equal(r.balance, '27452.117134');
  assert.equal(r.usdtBalance, '40137.05066');
  assert.equal(r.txCount, 796758);
  assert.equal(r.volumeIn.native, '0.01');
  assert.equal(r.volumeOut.native, '2.5');
  assert.equal(r.volumeIn.usdt, '100');
  assert.equal(r.volumeOut.usdt, '46.773717');
  assert.equal(r.sampled, false);
  assert.equal(r.firstSeen, new Date(1787058654000).toISOString());
  assert.equal(calls[0].init.headers['TRON-PRO-API-KEY'], 'TKEY');
  assert.ok(!calls[0].url.includes('TKEY'));
});

test('tronscan: sampled when the 4-page cap is reached with full pages', async () => {
  const rows = Array.from({ length: 300 }, () => trxRow(TOTHER, TADDR, 1000000));
  tronMock({ trxRows: rows, usdtRows: [] });
  const r = await lookupWallet({ chain: 'trx', address: TADDR }, { tronscan: 'TKEY' });
  assert.deepEqual(r.sampled, { native: 200 });
  assert.equal(r.volumeIn.native, '200');
  assert.equal(r.volumeIn.usdt, '0');
  assert.equal(r.txCount, 796758); // exact count from accountv2, not the sample
});

test('tronscan: account without USDT token entry -> "0"', async () => {
  tronMock({ acct: { address: TADDR, balance: 973, balanceStr: '973', transactions_in: 0, transactions_out: 0, transactions: 0, withPriceTokens: [{ tokenId: '_', tokenType: 'trc10', balance: '973', tokenDecimal: 6 }] } });
  const r = await lookupWallet({ chain: 'trx', address: TADDR }, { tronscan: 'TKEY' });
  assert.equal(r.usdtBalance, '0');
  assert.equal(r.balance, '0.000973');
  assert.equal(r.volumeIn.native, '0');
  assert.equal(calls.length, 1); // no transfer calls for an account with 0 txs
});

test('tronscan: no key -> no_key; bad key -> invalid_key', async () => {
  mock(() => ({ status: 401, body: { Error: 'ApiKey not exists' } }));
  await assert.rejects(() => lookupWallet({ chain: 'trx', address: TADDR }, { tronscan: '' }), e => e.code === 'no_key');
  await assert.rejects(() => lookupWallet({ chain: 'trx', address: TADDR }, { tronscan: 'BAD' }), e => e.code === 'invalid_key');
  await assert.rejects(() => testKey('tronscan', 'BAD'), e => e.code === 'invalid_key');
});

test('tronscan: invalid address 400 -> bad_request', async () => {
  mock(() => ({ status: 400, body: { message: 'address is not a valid address' } }));
  await assert.rejects(() => lookupWallet({ chain: 'trx', address: 'x' }, { tronscan: 'K' }), e => e.code === 'bad_request' && /valid address/.test(e.message));
});

// ------------------------------------------------------------------ XRPL
test('xrpl: balance in drops, tx sample, marker -> sampled', async () => {
  mock((u, init) => {
    const b = JSON.parse(init.body);
    if (b.method === 'account_info') return { body: { result: { account_data: { Account: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', Balance: '56786636999' }, status: 'success', validated: true } } };
    const p = b.params[0];
    if (p.forward === false) return { body: { result: { transactions: [{ tx: { date: 468000000 } }], status: 'success' } } };
    return { body: { result: { transactions: Array.from({ length: 400 }, (_, i) => ({ tx: { date: 410908190 + i } })), marker: { ledger: 60661, seq: 0 }, status: 'success' } } };
  });
  const r = await lookupWallet({ chain: 'xrp', address: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh' }, {});
  assert.equal(r.balance, '56786.636999');
  assert.equal(r.txCount, 400);
  assert.deepEqual(r.sampled, { native: 400 });
  assert.equal(r.firstSeen, new Date((410908190 + 946684800) * 1000).toISOString());
  assert.equal(r.lastActivity, new Date((468000000 + 946684800) * 1000).toISOString());
  assert.equal(r.nativeSymbol, 'XRP');
});

test('xrpl: actNotFound -> unfunded account, zero values + note, not an error', async () => {
  mock(() => ({ body: { result: { account: 'rUnfunded', error: 'actNotFound', error_code: 19, error_message: 'Account not found.', status: 'error', validated: true } } }));
  const r = await lookupWallet({ chain: 'xrp', address: 'rUnfunded' }, {});
  assert.equal(r.balance, '0');
  assert.equal(r.txCount, 0);
  assert.ok(r.notes.some(n => /never funded|activated/i.test(n)));
  assert.equal(calls.length, 1);
});

test('xrpl: actMalformed -> bad_request', async () => {
  mock(() => ({ body: { result: { error: 'actMalformed', error_message: 'Account malformed.', status: 'error' } } }));
  await assert.rejects(() => lookupWallet({ chain: 'xrp', address: 'nope' }, {}), e => e.code === 'bad_request');
});

// ------------------------------------------------------------------ Solana
test('solana: balance, signatures, USDT SPL via jsonParsed', async () => {
  mock((u, init) => {
    const b = JSON.parse(init.body);
    if (b.method === 'getBalance') return { body: { jsonrpc: '2.0', result: { context: { slot: 1 }, value: 230130698 }, id: b.id } };
    if (b.method === 'getSignaturesForAddress') return { body: { jsonrpc: '2.0', result: [{ blockTime: 1793126012, err: null, signature: 'a' }, { blockTime: 1700000000, err: null, signature: 'b' }], id: b.id } };
    return { body: { jsonrpc: '2.0', result: { context: {}, value: [
      { account: { data: { parsed: { info: { tokenAmount: { amount: '654299087', decimals: 6 } } } } } },
      { account: { data: { parsed: { info: { tokenAmount: { amount: '1', decimals: 6 } } } } } }] }, id: b.id } };
  });
  const r = await lookupWallet({ chain: 'sol', address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, {});
  assert.equal(r.balance, '0.230130698');
  assert.equal(r.txCount, 2);
  assert.equal(r.sampled, false);
  assert.equal(r.usdtBalance, '654.299088');
  assert.equal(r.firstSeen, new Date(1700000000 * 1000).toISOString());
  assert.equal(r.lastActivity, new Date(1793126012 * 1000).toISOString());
});

test('solana: 1000 signatures -> sampled; invalid param -> bad_request', async () => {
  mock((u, init) => {
    const b = JSON.parse(init.body);
    if (b.method === 'getBalance') return { body: { jsonrpc: '2.0', result: { value: 1 }, id: 1 } };
    if (b.method === 'getSignaturesForAddress') return { body: { jsonrpc: '2.0', result: Array.from({ length: 1000 }, (_, i) => ({ blockTime: 1793126012 - i })), id: 1 } };
    return { body: { jsonrpc: '2.0', result: { value: [] }, id: 1 } };
  });
  const r = await lookupWallet({ chain: 'sol', address: 'Vote111111111111111111111111111111111111111' }, {});
  assert.deepEqual(r.sampled, { native: 1000 });
  assert.equal(r.firstSeen, null);
  assert.equal(r.usdtBalance, '0');

  mock(() => ({ body: { jsonrpc: '2.0', error: { code: -32602, message: 'Invalid param: WrongSize' }, id: 1 } }));
  await assert.rejects(() => lookupWallet({ chain: 'sol', address: 'bad' }, {}), e => e.code === 'bad_request');
});

// ------------------------------------------------------------------ BlockCypher
test('blockcypher: exact BigInt formatting above 2^53 (DOGE) and url shape', async () => {
  mock(() => ({ body: '{"address":"DH5y","total_received":4385334472513834500,"total_sent":4385328250373838912,"balance":6222064676660,"unconfirmed_balance":0,"final_balance":6222064676660,"n_tx":1485,"unconfirmed_n_tx":0,"final_n_tx":1485}' }));
  const r = await lookupWallet({ chain: 'doge', address: 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L' }, {});
  assert.equal(r.txCount, 1485);
  assert.equal(r.balance, '62220.6467666');
  assert.equal(r.volumeIn.native, '43853344725.138345');
  assert.equal(r.volumeOut.native, '43853282503.73838912');
  assert.match(calls[0].url, /^https:\/\/api\.blockcypher\.com\/v1\/doge\/main\/addrs\/DH5y.*\/balance$/);
});

test('blockcypher: 429 and invalid address mapping', async () => {
  const saved = POLICIES.blockcypher.minIntervalMs;
  mock(() => ({ status: 404, body: { error: 'Address xyz is invalid: non-matching checksum.' } }));
  await assert.rejects(() => lookupWallet({ chain: 'ltc', address: 'xyz' }, {}), e => e.code === 'bad_request');
  mock(() => ({ status: 200, body: { error: 'Limits reached.' } }));
  await assert.rejects(() => lookupWallet({ chain: 'ltc', address: 'Lxyz' }, {}), e => e.code === 'rate_limited');
  POLICIES.blockcypher.minIntervalMs = saved;
});

// ------------------------------------------------------------------ dispatcher
test('lookupSupport / unsupported chains', async () => {
  assert.deepEqual(lookupSupport('eth'), { supported: true, provider: 'Etherscan V2', needsKey: 'etherscan' });
  assert.equal(lookupSupport('trx').needsKey, 'tronscan');
  assert.equal(lookupSupport('btc').needsKey, null);
  assert.equal(lookupSupport('bch').supported, false);
  assert.equal(lookupSupport('ada').supported, false);
  await assert.rejects(() => lookupWallet({ chain: 'ada', address: 'addr1' }, {}), e => e.code === 'not_supported');
  await assert.rejects(() => lookupWallet({ chain: 'bch', address: 'bitcoincash:q' }, {}), e => e.code === 'not_supported');
  await assert.rejects(() => testKey('nope', 'x'), e => e.code === 'bad_request');
});

// ------------------------------------------------------------------ RDAP
const RDAP_GOOGLE = {
  objectClassName: 'domain', handle: '2138514_DOMAIN_COM-VRSN', ldhName: 'GOOGLE.COM',
  status: ['client delete prohibited', 'server transfer prohibited'],
  entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'MarkMonitor Inc.']]], publicIds: [{ type: 'IANA Registrar ID', identifier: '292' }] }],
  events: [
    { eventAction: 'registration', eventDate: '1997-09-15T04:00:00Z' },
    { eventAction: 'expiration', eventDate: '2028-09-14T04:00:00Z' },
    { eventAction: 'last changed', eventDate: '2019-09-09T15:39:04Z' },
    { eventAction: 'last update of RDAP database', eventDate: '2026-10-27T19:10:28Z' }],
  nameservers: [{ ldhName: 'NS1.GOOGLE.COM' }, { ldhName: 'NS2.GOOGLE.COM' }],
};

test('rdap: maps registrar, dates, ageDays, nameservers', async () => {
  mock(() => ({ body: RDAP_GOOGLE }));
  const r = await rdapLookup('www.google.com');
  assert.equal(calls[0].url, 'https://rdap.org/domain/google.com');
  assert.equal(r.domain, 'google.com');
  assert.equal(r.registrar, 'MarkMonitor Inc.');
  assert.equal(r.created, '1997-09-15T04:00:00Z');
  assert.equal(r.updated, '2019-09-09T15:39:04Z');
  assert.equal(r.expires, '2028-09-14T04:00:00Z');
  assert.deepEqual(r.nameservers, ['ns1.google.com', 'ns2.google.com']);
  assert.equal(r.status.length, 2);
  assert.ok(r.ageDays > 10000);
  const fixed = mapRdap('google.com', RDAP_GOOGLE, Date.parse('1997-10-15T04:00:00Z'));
  assert.equal(fixed.ageDays, 30);
});

test('rdap: 404 retries the parent domain, stops at 2 labels', async () => {
  mock(u => (u.endsWith('/a.b.example.com') || u.endsWith('/b.example.com') ? { status: 404, body: { errorCode: 404 } } : { body: RDAP_GOOGLE }));
  const r = await rdapLookup('a.b.example.com');
  assert.deepEqual(calls.map(c => c.url.split('/').pop()), ['a.b.example.com', 'b.example.com', 'example.com']);
  assert.equal(r.registrar, 'MarkMonitor Inc.');

  mock(() => ({ status: 404, body: {} }));
  await assert.rejects(() => rdapLookup('x.example.io'), e => e.code === 'not_found');
  assert.equal(calls.length, 2); // x.example.io, example.io; never "io"
});

test('rdap: co.uk style names stop at 3 labels', async () => {
  mock(() => ({ status: 404, body: {} }));
  await assert.rejects(() => rdapLookup('login.shop.example.co.uk'), e => e.code === 'not_found');
  assert.deepEqual(calls.map(c => c.url.split('/').pop()), ['login.shop.example.co.uk', 'shop.example.co.uk', 'example.co.uk']);
});

test('rdap: rdap.org 403 falls back to the IANA bootstrap registry', async () => {
  mock(u => {
    if (u.startsWith('https://rdap.org/')) return { status: 403, body: '<html>challenge</html>' };
    if (u === 'https://data.iana.org/rdap/dns.json') return { body: { services: [[['com', 'net'], ['https://rdap.verisign.com/com/v1/']]] } };
    assert.equal(u, 'https://rdap.verisign.com/com/v1/domain/google.com');
    return { body: RDAP_GOOGLE };
  });
  const r = await rdapLookup('google.com');
  assert.equal(r.registrar, 'MarkMonitor Inc.');
});

test('rdap: IP / single label rejected', async () => {
  await assert.rejects(() => rdapLookup('192.168.0.1'), e => e.code === 'bad_request');
  await assert.rejects(() => rdapLookup('localhost'), e => e.code === 'bad_request');
});

// ------------------------------------------------------------------ URLScan
const UUID = '01a17eb5-0b7f-758f-9a5c-b71162ae8107';

test('urlscan search: maps rows, builds screenshot + result URLs, keyless ok', async () => {
  mock(() => ({ body: { results: [{
    task: { visibility: 'public', method: 'api', domain: 'zhrene.fitness', time: '2026-10-27T18:52:46.342Z', uuid: UUID, url: 'https://zhrene.fitness/' },
    page: { server: 'cloudflare', ip: '104.20.23.154', url: 'https://example.com/', domain: 'example.com', asnname: 'CLOUDFLARENET - Cloudflare, Inc., US', asn: 'AS13335', country: 'US' },
    result: `https://urlscan.io/api/v1/result/${UUID}/`, screenshot: `https://urlscan.io/screenshots/${UUID}.png`,
  }], total: 42, has_more: true } }));
  const r = await urlscanSearch('Example.com');
  assert.equal(calls[0].url, 'https://urlscan.io/api/v1/search/?q=domain%3Aexample.com&size=10');
  assert.equal(calls[0].init.headers['API-Key'], undefined);
  assert.equal(r.total, 42);
  assert.deepEqual(r.results[0], {
    uuid: UUID, time: '2026-10-27T18:52:46.342Z', url: 'https://example.com/', ip: '104.20.23.154', asn: 'AS13335',
    asnname: 'CLOUDFLARENET - Cloudflare, Inc., US', country: 'US', server: 'cloudflare',
    screenshot: `https://urlscan.io/screenshots/${UUID}.png`, resultUrl: `https://urlscan.io/result/${UUID}/`,
  });
  await urlscanSearch('example.com', 'K');
  assert.equal(calls.at(-1).init.headers['API-Key'], 'K');
});

test('urlscan search: 429 carries retryAfterMs', async () => {
  mock(() => ({ status: 429, headers: { 'x-rate-limit-reset-after': '9' }, body: { message: 'Rate limit exceeded' } }));
  await assert.rejects(() => urlscanSearch('example.com'), e => e.code === 'rate_limited' && e.retryAfterMs >= 0);
}, { timeout: 30000 });

test('urlscan submit: body, header, response; errors', async () => {
  mock((u, init) => {
    assert.equal(u, 'https://urlscan.io/api/v1/scan/');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['API-Key'], 'K');
    assert.deepEqual(JSON.parse(init.body), { url: 'https://evil.example/', visibility: 'unlisted' });
    return { body: { message: 'Submission successful', uuid: UUID, result: `https://urlscan.io/result/${UUID}/`, api: `https://urlscan.io/api/v1/result/${UUID}/`, visibility: 'unlisted', url: 'https://evil.example/' } };
  });
  const r = await urlscanSubmit('https://evil.example/', 'unlisted', 'K');
  assert.deepEqual(r, { uuid: UUID, resultUrl: `https://urlscan.io/result/${UUID}/`, screenshot: `https://urlscan.io/screenshots/${UUID}.png` });

  mock(() => ({ status: 400, body: { message: 'DNS Error - Could not resolve domain', description: 'The domain could not be resolved', status: 400 } }));
  await assert.rejects(() => urlscanSubmit('https://nxdomain.invalid/', 'unlisted', 'K'), e => e.code === 'bad_request' && /DNS/.test(e.message) && Array.isArray(e.details));
  mock(() => ({ status: 401, body: { message: 'API key is invalid' } }));
  await assert.rejects(() => urlscanSubmit('https://x.example/', 'public', 'BAD'), e => e.code === 'invalid_key');
  await assert.rejects(() => urlscanSubmit('https://x.example/', 'public', ''), e => e.code === 'no_key');
});

test('urlscan result: 404 -> null (pending); done -> verdict + page', async () => {
  mock(() => ({ status: 404, body: { message: 'Not Found', status: 404 } }));
  assert.equal(await urlscanResult(UUID, 'K'), null);

  mock(() => ({ body: {
    page: { url: 'https://evil.example/login', domain: 'evil.example', ip: '1.2.3.4', asn: 'AS1', asnname: 'EVIL-NET', country: 'RU', server: 'nginx' },
    verdicts: { overall: { score: 100, malicious: true, categories: ['phishing'], brands: ['paypal'], hasVerdicts: true },
      urlscan: { score: 100, categories: ['phishing'], brands: [{ key: 'paypal', name: 'PayPal', country: ['US'], vertical: ['payments'] }] } },
    task: { uuid: UUID } } }));
  const r = await urlscanResult(UUID, 'K');
  assert.equal(r.uuid, UUID);
  assert.deepEqual(r.verdict, { score: 100, malicious: true, categories: ['phishing'], brands: ['paypal', 'PayPal'] });
  assert.deepEqual(r.page, { ip: '1.2.3.4', asn: 'AS1', asnname: 'EVIL-NET', country: 'RU', server: 'nginx', domain: 'evil.example', url: 'https://evil.example/login' });
  assert.equal(r.screenshot, `https://urlscan.io/screenshots/${UUID}.png`);

  mock(() => ({ status: 410, body: {} }));
  await assert.rejects(() => urlscanResult(UUID, 'K'), e => e.code === 'not_found');
  await assert.rejects(() => urlscanResult('../etc', 'K'), e => e.code === 'bad_request');
});

// ------------------------------------------------------------------ public RPC fallback
const hex32 = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
function rpcMock() {
  mock((u, init) => {
    if (u.includes('etherscan.io')) return { body: { status: '0', message: 'NOTOK', result: 'Free API access is not supported for this chain. Please upgrade your api plan' } };
    const b = JSON.parse(init.body);
    if (b.method === 'eth_getBalance') return { body: { jsonrpc: '2.0', id: b.id, result: '0xde0b6b3a7640001' } }; // 1000000000000000001 wei
    if (b.method === 'eth_getTransactionCount') return { body: { jsonrpc: '2.0', id: b.id, result: '0x2a' } };
    if (b.method === 'eth_call') {
      assert.equal(b.params[0].data, '0x70a08231' + '0'.repeat(24) + ME.slice(2));
      return { body: { jsonrpc: '2.0', id: b.id, result: hex32(123456789012345678901234567n) } };
    }
    throw new Error('unexpected ' + b.method);
  });
}

test('evmrpc: no Etherscan key -> public RPC for bsc (18-decimal USDT exact)', async () => {
  rpcMock();
  const r = await lookupWallet({ chain: 'bsc', address: ADDR }, {});
  assert.equal(calls.length, 3);
  assert.ok(calls.every(c => c.url === 'https://bsc-dataseed.binance.org'));
  assert.equal(r.source, 'Public RPC (bsc-dataseed.binance.org)');
  assert.equal(r.balance, '1.000000000000000001');
  assert.equal(r.txCount, 42);
  assert.equal(r.usdtBalance, '123456789.012345678901234567');
  assert.deepEqual(r.volumeIn, { native: null, usdt: null });
  assert.deepEqual(r.volumeOut, { native: null, usdt: null });
  assert.equal(r.sampled, false);
  assert.ok(r.notes.some(n => /outgoing transactions only \(nonce\)/.test(n)));
  assert.equal(r.explorerUrl, `https://bscscan.com/address/${ADDR}`);
});

test('evmrpc: avax / op use their own RPC host and 6-decimal USDT', async () => {
  rpcMock();
  const a = await lookupWallet({ chain: 'avax', address: ADDR }, {});
  assert.equal(a.source, 'Public RPC (api.avax.network)');
  assert.equal(a.usdtBalance, '123456789012345678901.234567');
  const o = await lookupWallet({ chain: 'op', address: ADDR }, {});
  assert.equal(o.source, 'Public RPC (mainnet.optimism.io)');
});

test('evmrpc: with an Etherscan key, falls back only on not_supported', async () => {
  rpcMock();
  const r = await lookupWallet({ chain: 'bsc', address: ADDR }, { etherscan: 'KEY' });
  assert.equal(calls.length, 4); // 1 etherscan balance + 3 rpc
  assert.match(r.source, /^Public RPC/);

  mock(() => ({ body: { status: '0', message: 'NOTOK', result: 'Invalid API Key (#err2)' } }));
  await assert.rejects(() => lookupWallet({ chain: 'bsc', address: ADDR }, { etherscan: 'BAD' }), e => e.code === 'invalid_key');
});

test('evmrpc: eth/matic/arb without a key still no_key; rpc errors map', async () => {
  for (const c of ['eth', 'matic', 'arb']) await assert.rejects(() => lookupWallet({ chain: c, address: ADDR }, {}), e => e.code === 'no_key');
  assert.deepEqual(lookupSupport('bsc'), { supported: true, provider: 'Public RPC', needsKey: null });
  mock(() => ({ status: 429, body: 'slow down' }));
  await assert.rejects(() => lookupWallet({ chain: 'op', address: ADDR }, {}), e => e.code === 'rate_limited');
  mock(() => ({ body: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'execution reverted' } } }));
  await assert.rejects(() => lookupWallet({ chain: 'op', address: ADDR }, {}), e => e.code === 'bad_response');
}, { timeout: 30000 });

// ------------------------------------------------------------------ labels
const BINANCE = '0x28C6c06298d514Db089934071355E5743bf21d60';
const bsMeta = tags => ({ addresses: { [BINANCE]: { tags } } });
const tag = (name, tagType = 'name', slug = name.toLowerCase().replace(/\W+/g, '-'), meta = '{}') => ({ slug, name, tagType, ordinal: 0, meta });
const noTx = u => { const a = q(u).get('action'); return a === 'balance' || a === 'tokenbalance' ? ok('0') : { body: { status: '0', message: 'No transactions found', result: [] } }; };

test('labels: OnchainResult always has labels[] (empty when nothing known)', async () => {
  mock(noTx);
  const eth = await lookupWallet({ chain: 'eth', address: ADDR }, { etherscan: 'K' });
  assert.deepEqual(eth.labels, []);
});

test('labels: Blockscout metadata -> Binance 14 (exchange, none), deduped, protocol tags skipped', async () => {
  mock(() => { throw new Error('unused'); });
  setLabels(u => {
    assert.match(u, /metadata\.services\.blockscout\.com\/api\/v1\/metadata\?addresses=0x28C6.*&chainId=56$/);
    return { body: bsMeta([tag('Binance 14'), tag('binance 14'), tag('Exchange', 'generic'), tag('Binance', 'protocol')]) };
  });
  const ls = await lookupLabels({ chain: 'bsc', address: BINANCE }, {});
  assert.deepEqual(ls.map(l => l.text).sort(), ['Binance 14', 'Exchange']);
  assert.ok(ls.every(l => l.risk === 'none' && l.kind === 'exchange' && l.source === 'Blockscout'));
});

test('labels: risk mapping (phishing high, gambling caution) and warning notes', async () => {
  mock(() => { throw new Error('unused'); });
  setLabels(() => ({ body: bsMeta([
    tag('Fake_Phishing123', 'name'), tag('Gambling', 'generic'),
    tag('x', 'note', 'n', JSON.stringify({ alertStatus: 'warning', data: 'Reported drainer contract' })),
    tag('y', 'note', 'n2', JSON.stringify({ alertStatus: 'info', data: 'Burn address' })), tag('Bridge', 'name')]) }));
  const ls = await lookupLabels({ chain: 'eth', address: BINANCE }, {});
  const by = Object.fromEntries(ls.map(l => [l.text, l]));
  assert.equal(by['Fake_Phishing123'].risk, 'high');
  assert.equal(by['Fake_Phishing123'].kind, 'scam');
  assert.equal(by['Gambling'].risk, 'caution');
  assert.equal(by['Reported drainer contract'].risk, 'high');
  assert.equal(by['Bridge'].risk, 'none');
  assert.ok(!by['Burn address']);
  assert.equal(ls[0].risk, 'high');
});

test('labels: Etherscan ContractName only when Blockscout has none and a key exists', async () => {
  mock(() => { throw new Error('unused'); });
  let sc = 0;
  setLabels(u => {
    if (u.includes('blockscout')) return { body: { addresses: {} } };
    sc++;
    assert.equal(q(u).get('chainid'), '1');
    return { body: { status: '1', message: 'OK', result: [{ SourceCode: '...', ContractName: 'TetherToken' }] } };
  });
  assert.deepEqual(await lookupLabels({ chain: 'eth', address: ADDR }, {}), []);
  assert.equal(sc, 0);
  const ls = await lookupLabels({ chain: 'eth', address: ADDR }, { etherscan: 'K' });
  assert.deepEqual(ls, [{ text: 'TetherToken', source: 'Etherscan', risk: 'none', kind: 'contract' }]);
  setLabels(u => (u.includes('blockscout') ? { body: { addresses: {} } } : { body: { status: '0', message: 'NOTOK', result: 'Free API access is not supported for this chain. Please upgrade your api plan' } }));
  assert.deepEqual(await lookupLabels({ chain: 'bsc', address: ADDR }, { etherscan: 'K' }), []);
});

test('labels: lookupLabels throws on real failures; lookupWallet turns them into a note', async () => {
  mock(noTx);
  setLabels(() => ({ status: 500, body: 'oops' }));
  await assert.rejects(() => lookupLabels({ chain: 'eth', address: ADDR }, {}), e => e.code === 'server');
  assert.deepEqual(await lookupLabels({ chain: 'sol', address: 'x' }, {}), []);
  const r = await lookupWallet({ chain: 'eth', address: ADDR }, { etherscan: 'K' });
  assert.deepEqual(r.labels, []);
  assert.ok(r.notes.some(n => /labels unavailable/i.test(n)));
});

test('labels: Tronscan tags + security flags (USDT contract blacklisted -> high)', async () => {
  tronMock({ acct: { address: TUSDT, name: 'TetherToken', publicTag: 'USDT Token', blueTag: 'USDT', redTag: '', greyTag: '', feedbackRisk: false, balance: 1, balanceStr: '1', transactions: 0, transactions_in: 0, transactions_out: 0, withPriceTokens: [] } });
  setLabels(u => { assert.ok(u.includes('/api/security/account/data')); return { body: { send_ad_by_memo: false, has_fraud_transaction: false, fraud_token_creator: false, is_black_list: true } }; });
  const r = await lookupWallet({ chain: 'trx', address: TUSDT }, { tronscan: 'K' });
  const texts = r.labels.map(l => l.text);
  assert.ok(texts.includes('TetherToken') && texts.includes('USDT Token') && texts.includes('USDT'));
  assert.equal(r.labels[0].risk, 'high');
  assert.match(r.labels[0].text, /Blacklisted/);
});

test('labels: Tronscan Binance tag, red tag high, grey caution, standalone lookup', async () => {
  mock(u => {
    if (u.includes('/api/accountv2')) return { body: { address: TADDR, addressTag: 'Binance-Hot 4', publicTag: 'Binance-Hot 4', name: '', blueTag: '', redTag: 'Scam Token Creator', greyTag: 'Suspicious', feedbackRisk: true } };
    throw new Error('unexpected ' + u);
  });
  setLabels(() => ({ body: { send_ad_by_memo: true, has_fraud_transaction: true, fraud_token_creator: false, is_black_list: false } }));
  const ls = await lookupLabels({ chain: 'trx', address: TADDR }, { tronscan: 'K' });
  const by = Object.fromEntries(ls.map(l => [l.text, l]));
  assert.equal(by['Binance-Hot 4'].kind, 'exchange');
  assert.equal(by['Scam Token Creator'].risk, 'high');
  assert.equal(by['Suspicious'].risk, 'caution');
  assert.equal(by['Sends advertising memos (spam)'].risk, 'caution');
  assert.equal(calls.length, 2); // accountv2 + security
  assert.deepEqual(await lookupLabels({ chain: 'trx', address: TADDR }, {}), []);
});

test('labels: XRPScan accountName / advisory, BTC WalletExplorer', async () => {
  mock(() => { throw new Error('unused'); });
  setLabels(u => (u.includes('xrpscan')
    ? { body: { Account: 'rEb8', accountName: { name: 'Binance', desc: '1', verified: true }, advisory: null } }
    : { body: { found: true, label: 'Binance.com', wallet_id: '00000b55c1bcbc1f' } }));
  const x = await lookupLabels({ chain: 'xrp', address: 'rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh' }, {});
  assert.deepEqual(x, [{ text: 'Binance', source: 'XRPScan', risk: 'none', kind: 'exchange' }]);
  const b = await lookupLabels({ chain: 'btc', address: '1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s' }, {});
  assert.equal(b[0].text, 'Binance.com');
  assert.equal(b[0].source, 'WalletExplorer');
  setLabels(() => ({ body: { accountName: null, advisory: { description: 'reported scam' } } }));
  assert.equal((await lookupLabels({ chain: 'xrp', address: 'rX' }, {}))[0].risk, 'high');
  setLabels(() => ({ status: 404, body: {} }));
  assert.deepEqual(await lookupLabels({ chain: 'xrp', address: 'rX' }, {}), []);
  setLabels(() => ({ body: { found: false } }));
  assert.deepEqual(await lookupLabels({ chain: 'btc', address: '1x' }, {}), []);
});

// ------------------------------------------------------------------ USD prices
test('price: btc/eth/trx lookups get usdPrice from CoinGecko; failure is soft', async () => {
  const { resetPriceCache } = await import('../lib/providers/price.js');
  resetPriceCache();
  mock(u => { throw new Error('unexpected ' + u); });
  setLabels(async u => (u.includes('api.coingecko.com')
    ? { body: { bitcoin: { usd: 65000.5 }, ethereum: { usd: 3000 }, tron: { usd: 0.25 } } }
    : { body: defaultLabelBody(u) }));
  globalThis.fetch = (f => async (u, i) => f(u, i))(globalThis.fetch);
  const real = globalThis.fetch;
  globalThis.fetch = async (u, i) => (String(u).includes('blockchain.info')
    ? { status: 200, ok: true, headers: { get: () => null }, text: async () => JSON.stringify({ n_tx: 1, final_balance: 150000000, total_received: 150000000, total_sent: 0 }) }
    : real(u, i));
  const r = await lookupWallet({ chain: 'btc', address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa' }, {});
  assert.equal(r.usdPrice, 65000.5);
  resetPriceCache();
});

test('price: unavailable price leaves usdPrice null and the lookup succeeds', async () => {
  const { resetPriceCache } = await import('../lib/providers/price.js');
  resetPriceCache();
  mock(() => ({ status: 200, body: { n_tx: 1, final_balance: 100, total_received: 100, total_sent: 0 } }));
  setLabels(null);
  const r = await lookupWallet({ chain: 'btc', address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa' }, {});
  assert.equal(r.usdPrice, null);
  assert.equal(r.balance, '0.000001');
  resetPriceCache();
});

test('decimal: roundDecimal and usdValue are exact', async () => {
  const { roundDecimal, usdValue } = await import('../lib/decimal.js');
  assert.equal(roundDecimal('1.005', 2), '1.01');
  assert.equal(roundDecimal('0.00004999', 4), '0.0000');
  assert.equal(roundDecimal('12', 2), '12.00');
  assert.equal(roundDecimal('0.375739405726523274', 2), '0.38');
  assert.equal(usdValue('0.5', 65000.5), '32500.25');
  assert.equal(usdValue('10', 0.25), '2.50');
  assert.equal(usdValue('1', null), null);
});
