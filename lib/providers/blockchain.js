// Bitcoin via Blockchain.com: GET https://blockchain.info/rawaddr/<addr>?limit=0
//
// Live (2026-10-27): keyless works, sends `access-control-allow-origin: *`.
// Real body for 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa:
//   {"hash160":"62e9...","address":"1A1z...","n_tx":67174,"n_unredeemed":81110,
//    "total_received":10770069914,"total_sent":0,"final_balance":10770069914,"txs":[]}
// All amounts are satoshi (integers). An invalid address gives HTTP 404.
// `api_code` is optional and is NOT validated by this endpoint (a bogus code
// still returned 200), so testKey() can only confirm the request path works.
// First-seen / last-activity would need extra calls, so they stay null.

import { ServiceError } from '../errors.js';
import { request } from '../net/queue.js';
import { formatUnits } from '../decimal.js';
import { baseResult, httpError, rawInt } from './util.js';

export const SOURCE = 'Blockchain.com';
const BASE = 'https://blockchain.info/rawaddr/';

async function fetchRaw(address, key) {
  let url = `${BASE}${encodeURIComponent(address)}?limit=0`;
  if (key) url += `&api_code=${encodeURIComponent(key)}`;
  const res = await request('blockchain', url);
  if (res.status === 404) throw new ServiceError('not_found', 'Blockchain.com does not know this address (invalid or malformed).', { status: 404 });
  if (res.status === 400) throw new ServiceError('bad_request', 'Blockchain.com rejected the address.', { status: 400 });
  if (!res.ok) throw httpError('Blockchain.com', res);
  const j = res.json;
  if (!j || typeof j !== 'object' || j.n_tx === undefined || j.final_balance === undefined) {
    throw new ServiceError('bad_response', 'Blockchain.com: unexpected response shape');
  }
  return { j, res };
}

export async function lookup({ chain, address }, key) {
  const { j, res } = await fetchRaw(address, key);
  const out = baseResult(chain, address, SOURCE);
  out.txCount = Number(j.n_tx);
  out.balance = formatUnits(rawInt(res, 'final_balance'), 8);
  out.volumeIn.native = formatUnits(rawInt(res, 'total_received'), 8);
  out.volumeOut.native = formatUnits(rawInt(res, 'total_sent'), 8);
  out.notes.push('Totals are exact (whole address history). First-seen and last-activity are not fetched.');
  return out;
}

export async function testKey(key) {
  await fetchRaw('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', key);
  return { message: key
    ? 'Blockchain.com responded. Note: this endpoint does not validate api_code, so the code itself could not be verified.'
    : 'Blockchain.com responded (no key is needed for basic lookups).' };
}
