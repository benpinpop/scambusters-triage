// XRP Ledger public JSON-RPC (https://xrplcluster.com/, keyless).
//
// Live (2026-10-27): account_info -> result.account_data.Balance (string, drops).
// account_tx -> result.transactions[] with tx.date (seconds since 2000-01-01
// "ripple epoch") and result.marker when more pages exist. Errors arrive as
// HTTP 200 {"result":{"error":"actNotFound"|"actMalformed"|"slowDown",...,"status":"error"}}.
// actNotFound means the account was never funded/activated: reported as zeros
// plus a note. Volume is not computed (payments can be in issued currencies).

import { ServiceError } from '../errors.js';
import { request } from '../net/queue.js';
import { formatUnits } from '../decimal.js';
import { baseResult, isoFromUnix, httpError } from './util.js';

export const SOURCE = 'XRPL (xrplcluster.com)';
const URL_RPC = 'https://xrplcluster.com/';
export const TX_LIMIT = 400;
const RIPPLE_EPOCH = 946684800;

const isRl = res => !!(res.json && res.json.result && /^(slowDown|tooBusy)$/.test(res.json.result.error || ''));

async function rpc(method, params) {
  const res = await request('xrpl', URL_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params: [params] }),
    isRateLimited: isRl,
  });
  if (!res.ok && !(res.json && res.json.result)) throw httpError('XRPL', res);
  const r = res.json && res.json.result;
  if (!r) throw new ServiceError('bad_response', 'XRPL: unexpected response');
  return r;
}

const rippleToIso = d => (Number.isFinite(Number(d)) && Number(d) > 0) ? isoFromUnix(Number(d) + RIPPLE_EPOCH) : null;
const txDate = e => e && ((e.tx && e.tx.date) ?? (e.tx_json && e.tx_json.date) ?? e.date);

export async function lookup({ chain, address }) {
  const out = baseResult(chain, address, SOURCE);
  const info = await rpc('account_info', { account: address, ledger_index: 'validated' });
  if (info.error === 'actNotFound') {
    out.txCount = 0;
    out.balance = '0';
    out.notes.push('Account not found on the XRP Ledger: it was never funded/activated (or has been deleted).');
    return out;
  }
  if (info.error === 'actMalformed') throw new ServiceError('bad_request', 'XRPL: malformed account address');
  if (info.error) throw new ServiceError('bad_response', `XRPL: ${info.error_message || info.error}`);
  if (!info.account_data || info.account_data.Balance === undefined) throw new ServiceError('bad_response', 'XRPL: account_info had no Balance');
  out.balance = formatUnits(info.account_data.Balance, 6);

  const tx = await rpc('account_tx', { account: address, limit: TX_LIMIT, forward: true, ledger_index_min: -1, ledger_index_max: -1 });
  if (tx.error) throw new ServiceError('bad_response', `XRPL: ${tx.error_message || tx.error}`);
  const list = Array.isArray(tx.transactions) ? tx.transactions : [];
  out.txCount = list.length;
  out.firstSeen = list.length ? rippleToIso(txDate(list[0])) : null;
  if (tx.marker) {
    out.sampled = { native: list.length };
    const lastTx = await rpc('account_tx', { account: address, limit: 1, forward: false, ledger_index_min: -1, ledger_index_max: -1 });
    const e = lastTx.transactions && lastTx.transactions[0];
    out.lastActivity = rippleToIso(txDate(e));
    out.notes.push(`Sampled: the account has more than ${TX_LIMIT} transactions; the count shows the first ${list.length} only.`);
  } else {
    out.lastActivity = list.length ? rippleToIso(txDate(list[list.length - 1])) : null;
  }
  out.notes.push('Volume in/out is not available for XRP Ledger accounts in this tool.');
  return out;
}
