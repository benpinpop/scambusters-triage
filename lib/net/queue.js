// Per-provider request queue: serializes requests, spaces them out, enforces
// rolling-window limits, applies exponential backoff on rate-limit responses,
// and persists its timing state so a restarted MV3 service worker keeps
// honoring cooldowns.
//
// Works in the extension (chrome.storage.session / .local) and in plain Node
// (in-memory fallback) so provider adapters can be smoke-tested from the CLI.

import { ServiceError } from '../errors.js';

/**
 * Provider policies. minIntervalMs is the spacing between request starts.
 * windows: [[windowMs, maxRequests], ...] rolling limits tracked client-side.
 * persist: 'local' survives browser restarts (needed for hour-long windows).
 */
export const POLICIES = {
  // ScamBusters: 50/min and 500/hr per endpoint (skill: Rate Limits). The skill
  // recommends 1.5 s between batch requests; we use 1.3 s for interactive use,
  // which still caps a burst at ~46/min.
  scambusters_check:  { minIntervalMs: 1300, windows: [[60_000, 45], [3_600_000, 480]], persist: 'local' },
  scambusters_submit: { minIntervalMs: 1500, windows: [[60_000, 45], [3_600_000, 480]], persist: 'local' },
  // Etherscan free tier is ~5 req/s; stay well under at ~2.5 req/s.
  etherscan:   { minIntervalMs: 400 },
  tronscan:    { minIntervalMs: 500 },
  blockchain:  { minIntervalMs: 1500 },
  blockcypher: { minIntervalMs: 1200, windows: [[3_600_000, 90]], persist: 'local' },
  xrpl:        { minIntervalMs: 500 },
  solana:      { minIntervalMs: 600 },
  urlscan:     { minIntervalMs: 1000 },
  rdap:        { minIntervalMs: 500 },
  evmrpc:      { minIntervalMs: 400 },
  blockscout:  { minIntervalMs: 500 },
  xrpscan:     { minIntervalMs: 1000 },
  walletexplorer: { minIntervalMs: 1000 },
  default:     { minIntervalMs: 1000 },
};

// ---------------------------------------------------------------- storage shim
const mem = new Map();
function area(kind) {
  const c = globalThis.chrome;
  if (c && c.storage) {
    const a = kind === 'local' ? c.storage.local : (c.storage.session || c.storage.local);
    if (a) return a;
  }
  return null;
}
async function loadState(name, persist) {
  const key = `queue:${name}`;
  const a = area(persist);
  if (!a) return mem.get(key) || { lastAt: 0, cooldownUntil: 0, history: [] };
  const got = await a.get(key);
  return got[key] || { lastAt: 0, cooldownUntil: 0, history: [] };
}
async function saveState(name, persist, st) {
  const key = `queue:${name}`;
  const a = area(persist);
  if (!a) { mem.set(key, st); return; }
  await a.set({ [key]: st });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const chains = new Map(); // name -> tail promise (in-memory serialization)

/** Longest we will silently wait for a slot before failing fast with rate_limited. */
const MAX_SILENT_WAIT_MS = 20_000;

/**
 * Reserve a request slot for `name`, waiting as needed. Returns when the caller
 * may start its request. Throws rate_limited if the wait would be too long.
 */
async function acquire(name, policy) {
  const st = await loadState(name, policy.persist);
  const now = Date.now();
  st.history = (st.history || []).filter(t => now - t < 3_600_000);
  let readyAt = Math.max(now, st.cooldownUntil || 0, (st.lastAt || 0) + policy.minIntervalMs);
  for (const [win, max] of policy.windows || []) {
    const inWin = st.history.filter(t => now - t < win);
    if (inWin.length >= max) readyAt = Math.max(readyAt, inWin[inWin.length - max] + win);
  }
  const wait = readyAt - now;
  if (wait > MAX_SILENT_WAIT_MS) {
    throw new ServiceError('rate_limited', `Client-side rate limit for ${name}; try again in ${Math.ceil(wait / 1000)} s.`, { retryAfterMs: wait });
  }
  st.lastAt = readyAt;
  st.history.push(readyAt);
  await saveState(name, policy.persist, st);
  if (wait > 0) await sleep(wait);
}

async function setCooldown(name, policy, until) {
  const st = await loadState(name, policy.persist);
  st.cooldownUntil = Math.max(st.cooldownUntil || 0, until);
  await saveState(name, policy.persist, st);
}

/** Read the cooldown deadline (ms epoch) for a provider, 0 if none. */
export async function getCooldown(name) {
  const policy = POLICIES[name] || POLICIES.default;
  const st = await loadState(name, policy.persist);
  return st.cooldownUntil > Date.now() ? st.cooldownUntil : 0;
}

function parseRetryAfter(h) {
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n)) return n * 1000;
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : null;
}

/**
 * Perform a throttled HTTP request.
 *
 * @param {string} name     provider name (key of POLICIES)
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.method='GET']
 * @param {object} [opts.headers]
 * @param {string} [opts.body]
 * @param {number} [opts.timeoutMs=20000]
 * @param {number} [opts.retries=2]       automatic retries on rate limit (0 = never)
 * @param {(res)=>boolean|{retryAfterMs:number}} [opts.isRateLimited]
 *        detect provider-specific rate limiting in a 200 body (e.g. Etherscan)
 * @returns {Promise<{status:number, ok:boolean, headers:object, text:string, json:any}>}
 *          Non-2xx responses are returned, not thrown (callers map them), except
 *          rate limits that exhausted their retries, which throw rate_limited.
 */
export function request(name, url, opts = {}) {
  const policy = POLICIES[name] || POLICIES.default;
  const prev = chains.get(name) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => doRequest(name, policy, url, opts));
  // Serialize only the slot acquisition + request start; keep the chain alive on errors.
  chains.set(name, run.catch(() => {}));
  return run;
}

async function doRequest(name, policy, url, opts) {
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    await acquire(name, policy);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
    let resp, text;
    try {
      resp = await fetch(url, {
        method: opts.method || 'GET',
        headers: opts.headers,
        body: opts.body,
        signal: ctrl.signal,
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'follow',
      });
      text = await resp.text();
    } catch (e) {
      const timedOut = e && e.name === 'AbortError';
      throw new ServiceError('network', timedOut ? `${name}: request timed out` : `${name}: network error (${e && e.message || e})`);
    } finally {
      clearTimeout(timer);
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    const headers = {};
    for (const h of ['retry-after', 'content-type', 'x-ratelimit-remaining', 'x-rate-limit-reset']) {
      const v = resp.headers.get(h);
      if (v != null) headers[h] = v;
    }
    const res = { status: resp.status, ok: resp.ok, headers, text, json };

    let rl = resp.status === 429;
    let retryAfterMs = parseRetryAfter(headers['retry-after']);
    if (!rl && opts.isRateLimited) {
      const r = opts.isRateLimited(res);
      if (r) { rl = true; if (typeof r === 'object' && r.retryAfterMs) retryAfterMs = r.retryAfterMs; }
    }
    if (!rl) return res;

    // Exponential backoff with jitter: 1 s, 2 s, 4 s ... unless the server told us.
    const backoff = retryAfterMs ?? (1000 * 2 ** attempt + Math.floor(Math.random() * 300));
    await setCooldown(name, policy, Date.now() + backoff);
    if (attempt >= retries) {
      const err = new ServiceError('rate_limited', `${name}: rate limited`, { status: resp.status, retryAfterMs: backoff });
      err.response = res; // lets callers read the server's message
      throw err;
    }
  }
}
