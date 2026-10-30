// Small helpers shared by the on-chain adapters.

import { ServiceError } from '../errors.js';
import { CHAINS, explorerUrl } from '../chains.js';

/** Skeleton OnchainResult (DESIGN.md). Adapters fill in what they can know. */
export function baseResult(chain, address, source) {
  return {
    chain,
    address,
    nativeSymbol: CHAINS[chain] ? CHAINS[chain].symbol : '',
    txCount: null,
    balance: null,
    usdtBalance: null,
    volumeIn: { native: null, usdt: null },
    volumeOut: { native: null, usdt: null },
    sampled: false,
    firstSeen: null,
    lastActivity: null,
    labels: [],
    notes: [],
    source,
    explorerUrl: explorerUrl(chain, address),
  };
}

/** Unix seconds (or ms when ms=true), number or numeric string -> ISO string, or null. */
export function isoFromUnix(v, ms = false) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(ms ? n : n * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Map a non-OK HTTP response to a ServiceError (generic cases). */
export function httpError(provider, res) {
  const s = res.status;
  if (s === 429) return new ServiceError('rate_limited', `${provider}: rate limited`, { status: s });
  if (s >= 500) return new ServiceError('server', `${provider}: server error (HTTP ${s})`, { status: s });
  if (s === 401 || s === 403) return new ServiceError('invalid_key', `${provider}: access denied (HTTP ${s})`, { status: s });
  if (s === 404) return new ServiceError('not_found', `${provider}: not found`, { status: s });
  if (s === 400) return new ServiceError('bad_request', `${provider}: bad request`, { status: s });
  return new ServiceError('bad_response', `${provider}: unexpected HTTP ${s}`, { status: s });
}

/**
 * Read an integer field exactly from the raw JSON text. JSON.parse turns numbers
 * above 2^53 into floats (BlockCypher DOGE totals do exceed that), so amounts
 * are taken from the text; falls back to the parsed value.
 */
export function rawInt(res, field) {
  const m = new RegExp(String.raw`"${field}"\s*:\s*(-?\d+)(?![\d.eE])`).exec(res.text || '');
  if (m) return m[1];
  const v = res.json ? res.json[field] : undefined;
  return v === undefined || v === null ? '0' : v;
}
