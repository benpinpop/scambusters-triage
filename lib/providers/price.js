// Spot USD prices for BTC / ETH / TRX via CoinGecko's keyless simple/price endpoint.
// One request covers all three coins. Results are cached in memory for a few
// minutes; failures are cached briefly so a blocked/rate-limited API is not
// hammered. Callers treat a null price as "no USD value" and never fail on it.

import { request } from '../net/queue.js';

const URL_ = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,tron&vs_currencies=usd';
const IDS = { btc: 'bitcoin', eth: 'ethereum', trx: 'tron' };
const TTL_MS = 5 * 60_000;
const FAIL_TTL_MS = 60_000;

let cache = null;     // { at, ttl, prices: {bitcoin: n, ...} | null }
let inflight = null;

export function resetPriceCache() { cache = null; inflight = null; }

async function fetchPrices() {
  try {
    const res = await request('coingecko', URL_, { retries: 0, timeoutMs: 8000 });
    const j = res.ok && res.json;
    if (!j || typeof j !== 'object') return null;
    const prices = {};
    for (const id of Object.values(IDS)) {
      const n = j[id] && j[id].usd;
      if (typeof n === 'number' && Number.isFinite(n) && n > 0) prices[id] = n;
    }
    return Object.keys(prices).length ? prices : null;
  } catch { return null; }
}

/** USD price for a chain code ('btc' | 'eth' | 'trx'), or null when unknown/unavailable. */
export async function usdPriceFor(chain) {
  const id = IDS[chain];
  if (!id) return null;
  if (!cache || Date.now() - cache.at > cache.ttl) {
    if (!inflight) {
      inflight = fetchPrices().then(prices => {
        cache = { at: Date.now(), ttl: prices ? TTL_MS : FAIL_TTL_MS, prices };
      }).finally(() => { inflight = null; });
    }
    await inflight;
  }
  return (cache && cache.prices && cache.prices[id]) || null;
}
