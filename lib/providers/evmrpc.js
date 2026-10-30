// Keyless public JSON-RPC fallback for EVM chains the Etherscan free plan does
// not cover (bsc, avax, op). Verified keyless on 2026-10-27 for eth_call.
// Gives: native balance, nonce (= OUTGOING transaction count only) and the USDT
// balance via eth_call balanceOf. No volumes, first-seen or last-activity.
// Queue policy: 'evmrpc' (falls back to 'default' if the policy is missing).

import { ServiceError } from '../errors.js';
import { request } from '../net/queue.js';
import { CHAINS } from '../chains.js';
import { formatUnits } from '../decimal.js';
import { USDT } from './etherscan.js';
import { baseResult, httpError } from './util.js';

export const RPC = {
  bsc:  'https://bsc-dataseed.binance.org',
  avax: 'https://api.avax.network/ext/bc/C/rpc',
  op:   'https://mainnet.optimism.io',
};
export const RPC_CHAINS = Object.keys(RPC);
export const SOURCE = 'Public RPC';

let rpcId = 0;
async function rpc(url, method, params) {
  const res = await request('evmrpc', url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  if (res.status === 429 || res.status === 403) {
    throw new ServiceError('rate_limited', `Public RPC (${new URL(url).host}) refused the request (HTTP ${res.status}).`, { status: res.status });
  }
  if (!res.ok && !(res.json && res.json.error)) throw httpError('Public RPC', res);
  const j = res.json;
  if (!j) throw new ServiceError('bad_response', 'Public RPC: response was not JSON');
  if (j.error) {
    const m = String(j.error.message || 'error');
    if (/rate|limit|too many/i.test(m)) throw new ServiceError('rate_limited', `Public RPC: ${m.slice(0, 120)}`);
    throw new ServiceError('bad_response', `Public RPC: ${m.slice(0, 160)}`);
  }
  if (typeof j.result !== 'string') throw new ServiceError('bad_response', 'Public RPC: unexpected result');
  return j.result;
}

const hexToBig = h => (h === '0x' || h === '' ? 0n : BigInt(h));

export async function lookup({ chain, address }) {
  const url = RPC[chain];
  const meta = CHAINS[chain];
  if (!url || !meta) throw new ServiceError('not_supported', `No public RPC configured for ${chain}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new ServiceError('bad_request', 'Not a valid 0x address.');
  const host = new URL(url).host;
  const out = baseResult(chain, address, `Public RPC (${host})`);

  out.balance = formatUnits(hexToBig(await rpc(url, 'eth_getBalance', [address, 'latest'])), meta.decimals);
  out.txCount = Number(hexToBig(await rpc(url, 'eth_getTransactionCount', [address, 'latest'])));
  const usdt = USDT[chain];
  if (usdt) {
    const data = '0x70a08231' + address.slice(2).toLowerCase().padStart(64, '0');
    const raw = await rpc(url, 'eth_call', [{ to: usdt.contract, data }, 'latest']);
    out.usdtBalance = formatUnits(hexToBig(raw), usdt.decimals);
  }
  out.notes.push('Tx count is outgoing transactions only (nonce); volume, first-seen and last-activity are not available without Etherscan.');
  out.notes.push(`Looked up through the public RPC ${host} because the Etherscan free plan does not cover this chain.`);
  return out;
}
