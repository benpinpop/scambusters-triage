// Tron via Tronscan (https://apilist.tronscanapi.com), header TRON-PRO-API-KEY.
//
// Live findings (2026-10-27):
//  - Keyless requests get HTTP 401 with an HTML "401 Authorization Required"
//    page, so a key is REQUIRED (needsKey: 'tronscan'). A wrong key gets 401
//    {"Error":"ApiKey not exists"}. /api/system/status works keyless, so it is
//    not usable for testKey.
//  - GET /api/accountv2?address=  -> balance (sun, number) + balanceStr,
//    transactions_in, transactions_out, transactions (= in + out, exact),
//    date_created (ms), latest_operation_time (ms), withPriceTokens[]
//    ({tokenId, tokenType, balance (string), tokenDecimal, tokenAbbr}); USDT is
//    the entry with tokenId === TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t. Missing
//    entry means the account holds none. Invalid address -> HTTP 400
//    {"message":"address is not a valid address"}.
//  - GET /api/transfer?address=&limit<=50&start=&sort=timestamp (asc). Returns
//    TRX and TRC-10 transfers (tokenInfo.tokenId === '_' is TRX), `amount` in
//    sun, transferFromAddress / transferToAddress, contractRet 'SUCCESS'.
//  - GET /api/token_trc20/transfers?relatedAddress=&contract_address=&limit<=50
//    &start=&sort=timestamp -> token_transfers[] ({from_address, to_address,
//    quant (string), finalResult, tokenInfo.tokenDecimal, block_ts ms}). The
//    `total` field is unreliable (10000 even with no rows), so fullness of the
//    page is used to detect truncation.

import { ServiceError } from '../errors.js';
import { request } from '../net/queue.js';
import { formatUnits } from '../decimal.js';
import { baseResult, isoFromUnix, httpError } from './util.js';
import { mkLabel, finalizeLabels } from './labels.js';

export const SOURCE = 'Tronscan';
const BASE = 'https://apilist.tronscanapi.com/api';
export const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
export const USDT_DECIMALS = 6;
export const PAGE_SIZE = 50; // API maximum
export const MAX_PAGES = 4;  // 200 transfers per list

async function get(path, params, key) {
  if (!key) throw new ServiceError('no_key', 'A Tronscan API key is required (keyless requests get HTTP 401).');
  const qs = new URLSearchParams(params);
  const res = await request('tronscan', `${BASE}${path}?${qs}`, { headers: { 'TRON-PRO-API-KEY': key } });
  if (res.status === 401) {
    throw new ServiceError('invalid_key', 'Tronscan rejected the API key.', { status: 401 });
  }
  if (res.status === 400) {
    const msg = res.json && (res.json.message || res.json.Error);
    throw new ServiceError('bad_request', `Tronscan: ${msg || 'bad request'}`, { status: 400 });
  }
  if (!res.ok) throw httpError('Tronscan', res);
  if (!res.json || typeof res.json !== 'object') throw new ServiceError('bad_response', 'Tronscan: response was not JSON');
  return res.json;
}

async function pagedList(path, params, listField, key) {
  const rows = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const j = await get(path, { ...params, limit: String(PAGE_SIZE), start: String(page * PAGE_SIZE), sort: 'timestamp' }, key);
    const part = Array.isArray(j[listField]) ? j[listField] : null;
    if (!part) throw new ServiceError('bad_response', `Tronscan: missing ${listField}`);
    rows.push(...part);
    if (part.length < PAGE_SIZE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

/** Labels from the accountv2 tag fields (no extra request). */
export function accountLabels(acct) {
  const out = [];
  const S = 'Tronscan';
  for (const t of new Set([acct.addressTag, acct.publicTag].filter(Boolean))) out.push(mkLabel(t, S));
  if (acct.name) out.push(mkLabel(acct.name, S, { kind: 'contract' }));
  if (acct.blueTag) out.push(mkLabel(acct.blueTag, S, { risk: 'none' }));
  if (acct.redTag) out.push(mkLabel(acct.redTag, S, { risk: 'high', kind: 'scam' }));
  if (acct.greyTag) out.push(mkLabel(acct.greyTag, S, { risk: 'caution' }));
  if (acct.feedbackRisk === true) out.push(mkLabel('Reported as risky (Tronscan user feedback)', S, { risk: 'caution', kind: 'other' }));
  return out;
}

/** /api/security/account/data -> flag labels. Verified live: {send_ad_by_memo, has_fraud_transaction, fraud_token_creator, is_black_list}. */
export async function securityLabels(address, key) {
  const j = await get('/security/account/data', { address }, key);
  const out = [];
  const S = 'Tronscan';
  if (j.is_black_list === true) out.push(mkLabel('Blacklisted (Tronscan/USDT blacklist)', S, { risk: 'high', kind: 'scam' }));
  if (j.fraud_token_creator === true) out.push(mkLabel('Fraudulent token creator', S, { risk: 'high', kind: 'scam' }));
  if (j.has_fraud_transaction === true) out.push(mkLabel('Involved in fraud transactions', S, { risk: 'caution', kind: 'other' }));
  if (j.send_ad_by_memo === true) out.push(mkLabel('Sends advertising memos (spam)', S, { risk: 'caution', kind: 'other' }));
  return out;
}

/** Standalone label lookup: accountv2 tags + security flags (2 calls). */
export async function lookupLabels({ address }, key) {
  const acct = await get('/accountv2', { address }, key);
  const sec = await securityLabels(address, key);
  return finalizeLabels([...accountLabels(acct), ...sec]);
}

export async function lookup({ chain, address }, key) {
  const out = baseResult(chain, address, SOURCE);
  const acct = await get('/accountv2', { address }, key);

  const tagLabels = accountLabels(acct);
  if (acct.address === undefined && acct.balance === undefined) {
    out.txCount = 0;
    out.balance = '0';
    out.usdtBalance = '0';
    out.volumeIn = { native: '0', usdt: '0' };
    out.volumeOut = { native: '0', usdt: '0' };
    out.notes.push('Tronscan has no record of this address (never activated).');
    return out;
  }

  out.balance = formatUnits(acct.balanceStr ?? acct.balance ?? 0, 6);
  const tin = Number(acct.transactions_in), tout = Number(acct.transactions_out);
  out.txCount = Number.isFinite(Number(acct.transactions)) ? Number(acct.transactions)
    : (Number.isFinite(tin) && Number.isFinite(tout) ? tin + tout : null);
  out.firstSeen = isoFromUnix(acct.date_created, true);
  out.lastActivity = isoFromUnix(acct.latest_operation_time, true);

  const tokens = Array.isArray(acct.withPriceTokens) ? acct.withPriceTokens : [];
  const t = tokens.find(x => x && x.tokenId === USDT_TRC20);
  out.usdtBalance = t ? formatUnits(t.balance, Number.isInteger(t.tokenDecimal) ? t.tokenDecimal : USDT_DECIMALS) : '0';

  // Labels: tags already in accountv2 plus one security call (failure is non-fatal).
  let sec = [];
  try { sec = await securityLabels(address, key); } catch (e) { out.notes.push('Tronscan risk flags unavailable: ' + (e && e.message || 'error')); }
  out.labels = finalizeLabels([...tagLabels, ...sec]);

  const sampled = {};
  const me = address;

  // TRX volume. Skip the calls for an account with no transactions.
  if (out.txCount === 0) {
    out.volumeIn.native = '0'; out.volumeOut.native = '0';
    out.volumeIn.usdt = '0'; out.volumeOut.usdt = '0';
    return out;
  }
  const trx = await pagedList('/transfer', { address }, 'data', key);
  let nin = 0n, nout = 0n;
  for (const r of trx.rows) {
    const isTrx = (r.tokenInfo && r.tokenInfo.tokenId === '_') || r.tokenName === '_';
    if (!isTrx || (r.contractRet && r.contractRet !== 'SUCCESS')) continue;
    let v;
    try { v = BigInt(r.amount ?? 0); } catch { continue; }
    if (r.transferToAddress === me) nin += v;
    if (r.transferFromAddress === me) nout += v;
  }
  out.volumeIn.native = formatUnits(nin, 6);
  out.volumeOut.native = formatUnits(nout, 6);
  if (trx.truncated) sampled.native = trx.rows.length;

  // USDT (TRC-20) volume.
  const tt = await pagedList('/token_trc20/transfers', { relatedAddress: address, contract_address: USDT_TRC20 }, 'token_transfers', key);
  let uin = 0n, uout = 0n;
  for (const r of tt.rows) {
    if (r.finalResult && r.finalResult !== 'SUCCESS') continue;
    if (r.contract_address && r.contract_address !== USDT_TRC20) continue;
    let v;
    try { v = BigInt(r.quant ?? 0); } catch { continue; }
    if (r.to_address === me) uin += v;
    if (r.from_address === me) uout += v;
  }
  const dec = tt.rows[0] && tt.rows[0].tokenInfo && Number.isInteger(tt.rows[0].tokenInfo.tokenDecimal)
    ? tt.rows[0].tokenInfo.tokenDecimal : USDT_DECIMALS;
  out.volumeIn.usdt = formatUnits(uin, dec);
  out.volumeOut.usdt = formatUnits(uout, dec);
  if (tt.truncated) sampled.usdt = tt.rows.length;

  out.notes.push('TRX volume counts TRX transfers only (TRC-10 and contract-internal TRX are excluded); USDT volume is TRC-20 USDT only. Failed transfers are excluded.');
  if (sampled.native || sampled.usdt) {
    out.sampled = sampled;
    out.notes.push(`Sampled: only the first ${PAGE_SIZE * MAX_PAGES} entries (oldest first) of the truncated list(s) were examined, so volumes are partial. Transaction count is exact.`);
  }
  return out;
}

export async function testKey(key) {
  if (!key) throw new ServiceError('no_key', 'No Tronscan key saved.');
  await get('/accountv2', { address: USDT_TRC20 }, key);
  return { message: 'Tronscan accepted the key.' };
}
