// LTC / DOGE / DASH via keyless BlockCypher:
//   GET https://api.blockcypher.com/v1/{ltc|doge|dash}/main/addrs/<addr>/balance
//
// Live (2026-10-27) body for an LTC address:
//   {"address":"Ld..","total_received":468500128706909,"total_sent":468500109354570,
//    "balance":19352339,"unconfirmed_balance":0,"final_balance":19352339,
//    "n_tx":122,"unconfirmed_n_tx":0,"final_n_tx":122}
// Amounts are in the smallest unit (8 decimals). Invalid address -> HTTP 404
// {"error": "..."} or {"error":"Address ... is invalid ..."}; the
// x-ratelimit-remaining header was already 1 after a handful of calls, so the
// keyless limits are tight. Responses send access-control-allow-origin: *.

import { ServiceError } from '../errors.js';
import { request } from '../net/queue.js';
import { formatUnits } from '../decimal.js';
import { baseResult, httpError, rawInt } from './util.js';

export const SOURCE = 'BlockCypher';
const NETS = { ltc: 'ltc', doge: 'doge', dash: 'dash' };

export async function lookup({ chain, address }) {
  const net = NETS[chain];
  if (!net) throw new ServiceError('not_supported', `BlockCypher adapter does not handle ${chain}`);
  const res = await request('blockcypher', `https://api.blockcypher.com/v1/${net}/main/addrs/${encodeURIComponent(address)}/balance`);
  const errText = res.json && res.json.error ? String(res.json.error) : '';
  if (res.status === 429 || /limits? reached|rate limit/i.test(errText)) {
    throw new ServiceError('rate_limited', 'BlockCypher keyless rate limit reached (about 100 requests/hour).', { status: 429 });
  }
  if (res.status === 404 || res.status === 400 || /invalid/i.test(errText)) {
    throw new ServiceError('bad_request', `BlockCypher: ${errText.slice(0, 160) || 'address rejected'}`, { status: res.status });
  }
  if (!res.ok) throw httpError('BlockCypher', res);
  const j = res.json;
  if (!j || j.final_balance === undefined || j.n_tx === undefined) throw new ServiceError('bad_response', 'BlockCypher: unexpected response shape');

  const out = baseResult(chain, address, SOURCE);
  out.txCount = Number(j.final_n_tx ?? j.n_tx);
  out.balance = formatUnits(rawInt(res, 'final_balance'), 8);
  out.volumeIn.native = formatUnits(rawInt(res, 'total_received'), 8);
  out.volumeOut.native = formatUnits(rawInt(res, 'total_sent'), 8);
  out.notes.push('Keyless BlockCypher: first-seen and last-activity are not fetched (separate paid-quota calls).');
  return out;
}
