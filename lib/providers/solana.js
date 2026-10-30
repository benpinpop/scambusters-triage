// Solana public RPC (https://api.mainnet-beta.solana.com, keyless).
//
// Live (2026-10-27): all of getBalance, getSignaturesForAddress and
// getTokenAccountsByOwner (jsonParsed) worked keyless from a Node client.
// getBalance -> result.value (lamports). getSignaturesForAddress returns newest
// first with blockTime (unix s). A malformed address gives JSON-RPC error
// -32602. Volume in/out is not available over plain RPC without parsing every
// transaction, so it stays null.
// Assumption: browsers/extension origins may be throttled harder by the public
// endpoint; HTTP 429/403 are mapped to rate_limited / server errors.

import { ServiceError } from '../errors.js';
import { request } from '../net/queue.js';
import { formatUnits } from '../decimal.js';
import { baseResult, isoFromUnix, httpError } from './util.js';

export const SOURCE = 'Solana public RPC';
const URL_RPC = 'https://api.mainnet-beta.solana.com';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const SIG_LIMIT = 1000;

let rpcId = 0;
async function rpc(method, params) {
  const res = await request('solana', URL_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (res.status === 403) throw new ServiceError('rate_limited', 'Solana public RPC refused the request (HTTP 403, usually throttling).', { status: 403 });
  if (!res.ok && !(res.json && res.json.error)) throw httpError('Solana RPC', res);
  const j = res.json;
  if (!j) throw new ServiceError('bad_response', 'Solana RPC: response was not JSON');
  if (j.error) {
    if (j.error.code === -32602) throw new ServiceError('bad_request', `Solana RPC: ${j.error.message}`);
    if (j.error.code === 429 || /too many requests|rate/i.test(j.error.message || '')) throw new ServiceError('rate_limited', 'Solana RPC: rate limited');
    throw new ServiceError('bad_response', `Solana RPC: ${String(j.error.message || 'error').slice(0, 160)}`);
  }
  return j.result;
}

export async function lookup({ chain, address }) {
  const out = baseResult(chain, address, SOURCE);
  const bal = await rpc('getBalance', [address, { commitment: 'finalized' }]);
  out.balance = formatUnits(bal.value, 9);

  const sigs = await rpc('getSignaturesForAddress', [address, { limit: SIG_LIMIT }]);
  if (!Array.isArray(sigs)) throw new ServiceError('bad_response', 'Solana RPC: unexpected signatures response');
  out.txCount = sigs.length;
  if (sigs.length) out.lastActivity = isoFromUnix(sigs[0].blockTime);
  if (sigs.length >= SIG_LIMIT) {
    out.sampled = { native: sigs.length };
    out.notes.push(`Sampled: showing the newest ${SIG_LIMIT} signatures only; the real count is higher and first-seen is unknown.`);
  } else if (sigs.length) {
    out.firstSeen = isoFromUnix(sigs[sigs.length - 1].blockTime);
  }

  const ta = await rpc('getTokenAccountsByOwner', [address, { mint: USDT_MINT }, { encoding: 'jsonParsed' }]);
  const accts = ta && Array.isArray(ta.value) ? ta.value : [];
  let total = 0n, dec = 6;
  for (const a of accts) {
    const amt = a && a.account && a.account.data && a.account.data.parsed && a.account.data.parsed.info && a.account.data.parsed.info.tokenAmount;
    if (!amt) continue;
    if (Number.isInteger(amt.decimals)) dec = amt.decimals;
    try { total += BigInt(amt.amount); } catch { /* skip */ }
  }
  out.usdtBalance = formatUnits(total, dec);
  out.notes.push('Volume in/out is not available for Solana in this tool. USDT balance covers the SPL USDT mint only.');
  return out;
}
