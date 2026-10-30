// Etherscan V2 multichain adapter: https://api.etherscan.io/v2/api?chainid=<id>
//
// NOTE: Etherscan only accepts the key as the `apikey` query parameter (there is
// no header option), so the key necessarily appears in the request URL. It is
// never logged and never put in error messages by this module.
//
// ---- Live findings (2026-10-27, free-tier key) -------------------------------
// Chains that work on the free plan : eth(1), matic(137), arb(42161)
// Chains that need a paid plan      : bsc(56), avax(43114), op(10). Etherscan
//   answers HTTP 200 {"status":"0","message":"NOTOK","result":"Free API access
//   is not supported for this chain. Please upgrade your api plan ..."}; this
//   adapter maps that to ServiceError('not_supported').
// Other status:"0" bodies seen: "Invalid API Key (#err2)" (bad key),
//   "Missing/Invalid API Key" (no key), "No transactions found" with result []
//   (empty account, NOT an error), and "Max rate limit reached" (rate limit,
//   documented; handled through isRateLimited so the queue backs off).
//
// ---- USDT contracts, verified live via eth_call symbol()/decimals() ----------
// chain  contract                                      decimals  verified via
// eth    0xdAC17F958D2ee523a2206206994597C13D831ec7   6   symbol "USDT", Etherscan proxy
// bsc    0x55d398326f99059fF775485246999027B3197955   18  symbol "USDT", bsc-dataseed.binance.org
// matic  0xc2132D05D31c914a87C6611C10748AEb04B58e8F   6   symbol "USDT0" (same proxy, upgraded by Tether), Etherscan proxy
// arb    0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9   6   symbol "USD₮0" (USDT0, Tether's upgrade of the
//                                                        same proxy), arb1.arbitrum.io and Etherscan proxy
// avax   0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7   6   symbol "USDt", api.avax.network
// op     0x94b008aA00579c1307B0EF2c499aD98a8ce58e58   6   symbol "USDT", mainnet.optimism.io
// Decimals are per chain (BSC is 18). When a tokentx row carries `tokenDecimal`
// that value wins over this table.

import { ServiceError } from '../errors.js';
import { request } from '../net/queue.js';
import { CHAINS } from '../chains.js';
import { formatUnits } from '../decimal.js';
import { baseResult, isoFromUnix, httpError } from './util.js';

export const SOURCE = 'Etherscan V2';
const BASE = 'https://api.etherscan.io/v2/api';

export const USDT = {
  eth:   { contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
  bsc:   { contract: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
  matic: { contract: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
  arb:   { contract: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
  avax:  { contract: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', decimals: 6 },
  op:    { contract: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', decimals: 6 },
};

/** Pagination: PAGE_SIZE x MAX_PAGES transactions examined per list, max. */
export const PAGE_SIZE = 1000;
export const MAX_PAGES = 2;

const msgOf = j => String((j && (typeof j.result === 'string' ? j.result : j.message)) || '');

function isRateLimited(res) {
  const j = res.json;
  if (j && j.status === '0' && /rate limit/i.test(msgOf(j) + ' ' + (j.message || ''))) return { retryAfterMs: 1200 };
  return false;
}

/** One Etherscan call. Returns the parsed body for status "1"; empty list for "no records". */
async function call(chainId, params, key) {
  const qs = new URLSearchParams({ chainid: String(chainId), ...params, apikey: key });
  let res;
  try {
    res = await request('etherscan', `${BASE}?${qs}`, { isRateLimited });
  } catch (e) {
    if (e && e.code === 'rate_limited') {
      e.message = 'Etherscan: rate limit reached (' + (msgOf(e.response && e.response.json) || 'HTTP 429') + ')';
    }
    throw e;
  }
  if (!res.ok && !res.json) throw httpError('Etherscan', res);
  const j = res.json;
  if (!j || typeof j !== 'object') throw new ServiceError('bad_response', 'Etherscan: response was not JSON');
  if (j.jsonrpc) { // proxy module answers JSON-RPC style
    if (j.error) throw new ServiceError('bad_response', `Etherscan: ${j.error.message || 'RPC error'}`);
    return j;
  }
  if (j.status === '1') return j;
  const m = msgOf(j);
  if (/no transactions found|no records found/i.test(m + ' ' + (j.message || ''))) {
    return { status: '1', message: 'No transactions found', result: [] };
  }
  if (/free api access|not supported for this chain|upgrade your api plan/i.test(m)) {
    throw new ServiceError('not_supported', 'Etherscan’s free API plan does not cover this chain (a paid Etherscan plan is required). Use the explorer link instead.', { status: res.status });
  }
  if (/invalid api key|missing\/invalid api key/i.test(m)) {
    throw new ServiceError('invalid_key', 'Etherscan rejected the API key (invalid or missing).', { status: res.status });
  }
  if (/rate limit/i.test(m)) throw new ServiceError('rate_limited', `Etherscan: ${m}`, { status: res.status });
  if (/timeout|timed out/i.test(m)) throw new ServiceError('server', `Etherscan: ${m}`);
  throw new ServiceError('bad_response', `Etherscan: ${(m || j.message || 'unexpected response').slice(0, 160)}`);
}

/** Fetch up to MAX_PAGES pages (oldest first). Returns { rows, truncated }. */
async function paged(chainId, params, key) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const j = await call(chainId, { ...params, page: String(page), offset: String(PAGE_SIZE), sort: 'asc' }, key);
    const part = Array.isArray(j.result) ? j.result : [];
    rows.push(...part);
    if (part.length < PAGE_SIZE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/** Newest single row (used for lastActivity when the ascending list was truncated). */
async function newest(chainId, params, key) {
  const j = await call(chainId, { ...params, page: '1', offset: '1', sort: 'desc' }, key);
  return Array.isArray(j.result) && j.result[0] ? j.result[0] : null;
}

const lc = s => String(s || '').toLowerCase();

export async function lookup({ chain, address }, key) {
  const meta = CHAINS[chain];
  if (!meta || !meta.evmChainId) throw new ServiceError('not_supported', `Etherscan adapter does not handle ${chain}`);
  if (!key) throw new ServiceError('no_key', 'An Etherscan API key is required for EVM lookups.');
  const id = meta.evmChainId;
  const me = lc(address);
  const out = baseResult(chain, address, SOURCE);

  // Balance first: a chain that needs a paid plan fails here after one call.
  const bal = await call(id, { module: 'account', action: 'balance', address, tag: 'latest' }, key);
  out.balance = formatUnits(bal.result, meta.decimals);

  // Normal transactions (oldest first).
  const txParams = { module: 'account', action: 'txlist', address, startblock: '0', endblock: '99999999' };
  const tx = await paged(id, txParams, key);
  out.txCount = tx.rows.length;
  let vin = 0n, vout = 0n;
  for (const t of tx.rows) {
    if (t.isError === '1') continue; // failed txs move no value
    let v;
    try { v = BigInt(t.value || '0'); } catch { continue; }
    if (lc(t.from) === me) vout += v;
    if (lc(t.to) === me) vin += v;
  }
  out.volumeIn.native = formatUnits(vin, meta.decimals);
  out.volumeOut.native = formatUnits(vout, meta.decimals);
  let first = tx.rows.length ? Number(tx.rows[0].timeStamp) : null;
  let last = tx.rows.length ? Number(tx.rows[tx.rows.length - 1].timeStamp) : null;
  const sampled = {};
  if (tx.truncated) {
    sampled.native = tx.rows.length;
    const n = await newest(id, txParams, key);
    if (n) last = Number(n.timeStamp);
  }
  out.notes.push('Native volume comes from normal transactions only; internal (contract) transfers are not included, and failed transactions are excluded.');

  // USDT.
  const usdt = USDT[chain];
  if (usdt) {
    const tb = await call(id, { module: 'account', action: 'tokenbalance', contractaddress: usdt.contract, address, tag: 'latest' }, key);
    const tokParams = { module: 'account', action: 'tokentx', contractaddress: usdt.contract, address };
    const tt = await paged(id, tokParams, key);
    const rowDec = tt.rows.length ? tt.rows[0].tokenDecimal : undefined;
    const dec = rowDec !== undefined && rowDec !== '' && Number.isInteger(Number(rowDec)) ? Number(rowDec) : usdt.decimals;
    out.usdtBalance = formatUnits(tb.result, dec);
    let uin = 0n, uout = 0n;
    for (const t of tt.rows) {
      let v;
      try { v = BigInt(t.value || '0'); } catch { continue; }
      if (lc(t.to) === me) uin += v;
      if (lc(t.from) === me) uout += v;
    }
    out.volumeIn.usdt = formatUnits(uin, dec);
    out.volumeOut.usdt = formatUnits(uout, dec);
    if (tt.rows.length) {
      const f = Number(tt.rows[0].timeStamp), l = Number(tt.rows[tt.rows.length - 1].timeStamp);
      first = first == null ? f : Math.min(first, f);
      last = last == null ? l : Math.max(last, l);
    }
    if (tt.truncated) {
      sampled.usdt = tt.rows.length;
      const n = await newest(id, tokParams, key);
      if (n) last = Math.max(last ?? 0, Number(n.timeStamp));
    }
    out.notes.push(`USDT figures cover only the USDT contract ${usdt.contract} (${dec} decimals).`);
  } else {
    out.notes.push('USDT contract not verified for this chain; USDT figures omitted.');
  }

  out.firstSeen = isoFromUnix(first);
  out.lastActivity = isoFromUnix(last);
  if (sampled.native || sampled.usdt) {
    out.sampled = sampled;
    out.notes.push(`Sampled: only the first ${PAGE_SIZE * MAX_PAGES} entries (oldest first) of the truncated list(s) were examined, so counts and volumes are partial.`);
  }
  return out;
}

/** Cheap key check: balance of the zero address on Ethereum mainnet. */
export async function testKey(key) {
  if (!key) throw new ServiceError('no_key', 'No Etherscan key saved.');
  await call(1, { module: 'account', action: 'balance', address: '0x0000000000000000000000000000000000000000', tag: 'latest' }, key);
  return { message: 'Etherscan accepted the key.' };
}

/**
 * Contract name label via module=contract&action=getsourcecode (works on the free key;
 * EOAs and unverified contracts return an empty ContractName). Returns [] otherwise.
 * tokeninfo is API Pro only and the nametag endpoint is "API Exclusive", so neither is used.
 */
export async function contractNameLabels(chain, address, key) {
  const meta = CHAINS[chain];
  if (!meta || !meta.evmChainId || !key) return [];
  let j;
  try {
    j = await call(meta.evmChainId, { module: 'contract', action: 'getsourcecode', address }, key);
  } catch (e) {
    if (e && e.code === 'not_supported') return [];
    throw e;
  }
  const row = Array.isArray(j.result) ? j.result[0] : null;
  const name = row && typeof row.ContractName === 'string' ? row.ContractName.trim() : '';
  return name ? [{ text: name, source: 'Etherscan', risk: 'none', kind: 'contract' }] : [];
}
