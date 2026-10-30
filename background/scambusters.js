// ScamBusters API client. Source of truth: the `scambusters-submissions` skill
// (ScamBusters_Submission_API_MD_Doc.md). Endpoints, headers, field names and
// every error string below follow that reference.

import { request } from '../lib/net/queue.js';
import { ServiceError } from '../lib/errors.js';

export const SB_BASE = 'https://scambuster.intelligenceforgood.org';
export const SB_KEY_RE = /^sb_[0-9a-f]{32}$/;
export const MAX_WALLETS = 30;

const GUIDE = {
  expired: 'Your ScamBusters key expired (keys last 30 days). Run /rotate-api-key in the ScamBusters Discord, then paste the new key in Settings.',
  notApproved: 'Your key works, but your account is not approved for POST /api/submit yet. Push your scraper/tool code to GitHub, invite smabryCFRL (Sam Mabry) as a collaborator, then DM Sam Mabry (I4G) in Discord with the repo URL. GET /api/check keeps working meanwhile.',
  invalidKey: 'The key was not recognized or was revoked. Check it in Settings, or run /get-api-key (or /rotate-api-key) in Discord.',
  unavailable: 'The approval check is temporarily unavailable, so the submission was refused (fail-closed). Nothing was submitted. Retry shortly; if it persists, DM Sam Mabry (I4G).',
  server: 'Server error. Retry in a few seconds; if it persists, DM Sam Mabry (I4G) in Discord.',
};

/** The API's site_key normalization, approximated client-side for local bookkeeping. */
export function siteKeyOf(siteUrl) {
  try {
    const u = new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : `https://${siteUrl}`);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch { return null; }
}

/** Map a /api/check 200 body to exactly one of the four UI states. */
export function checkState(d) {
  if (!d.is_reported && !d.has_wallets) return 'unsubmitted';
  if (d.has_wallets && d.stale) return 'stale';
  if (d.has_wallets) return 'has_wallets';
  return 'no_wallets';
}

/** 429 body -> cooldown. The API sends no Retry-After; infer from the window named in the message. */
function rateLimitError(res, endpoint) {
  const msg = (res && res.json && res.json.error) || 'Rate limit exceeded.';
  const hourly = /per hour/i.test(msg);
  const retryAfterMs = hourly ? 15 * 60_000 : 60_000;
  return new ServiceError('rate_limited', msg, {
    status: 429, retryAfterMs,
    guidance: hourly
      ? `Hourly ${endpoint} limit (500/hr) reached. The window is rolling; wait before trying again.`
      : `Per-minute ${endpoint} limit (50/min) reached. Wait about a minute; there is no automatic retry.`,
  });
}

function mapError(res, endpoint) {
  const j = res.json || {};
  const msg = typeof j.error === 'string' ? j.error : `HTTP ${res.status}`;
  switch (res.status) {
    case 400:
      if (Array.isArray(j.errors)) {
        return new ServiceError('bad_request', 'The API rejected the request:', { status: 400, details: j.errors.map(String) });
      }
      return new ServiceError('bad_request', msg, { status: 400 });
    case 401:
      return new ServiceError('invalid_key', msg, { status: 401, guidance: GUIDE.invalidKey });
    case 403:
      if (/not approved/i.test(msg)) return new ServiceError('not_approved', msg, { status: 403, guidance: GUIDE.notApproved });
      if (/expired/i.test(msg)) return new ServiceError('expired_key', msg, { status: 403, guidance: GUIDE.expired });
      return new ServiceError('forbidden', msg, { status: 403 });
    case 429:
      return rateLimitError(res, endpoint);
    case 500:
      return new ServiceError('server', msg, { status: 500, guidance: GUIDE.server });
    case 503:
      return new ServiceError('unavailable', msg, { status: 503, guidance: GUIDE.unavailable });
    default:
      return new ServiceError(res.status >= 500 ? 'server' : 'bad_response', msg, { status: res.status });
  }
}

function requireKey(key) {
  if (!key) throw new ServiceError('no_key', 'Add your ScamBusters API key in Settings first.', { guidance: 'Get one with /get-api-key in the ScamBusters Discord.' });
  if (!SB_KEY_RE.test(key)) throw new ServiceError('invalid_key', 'Saved ScamBusters key has an invalid format (expected sb_ + 32 hex chars).');
}

async function send(name, url, opts, endpoint) {
  try {
    // retries: 0, so a 429 is surfaced immediately: no blind automatic retry.
    return await request(name, url, { ...opts, retries: 0 });
  } catch (e) {
    if (e && e.code === 'rate_limited' && e.response) throw rateLimitError(e.response, endpoint);
    throw e;
  }
}

/** GET /api/check. Returns CheckResult (DESIGN.md). */
export async function checkSite(siteUrl, key, { fetchName = 'scambusters_check' } = {}) {
  requireKey(key);
  const url = new URL(`${SB_BASE}/api/check`);
  url.searchParams.set('site_url', siteUrl);
  // No Content-Type on GET (skill: not needed). Exactly one space after Bearer.
  const res = await send(fetchName, url.toString(), { headers: { Authorization: `Bearer ${key}` } }, 'check');
  if (res.status !== 200) throw mapError(res, 'check');
  const d = res.json;
  if (!d || typeof d !== 'object' || typeof d.has_wallets !== 'boolean') {
    throw new ServiceError('bad_response', 'Unexpected response from /api/check.');
  }
  const pick = ({ site_url, site_key, has_wallets, latest_wallet_collected_utc, stale, is_reported, site_status }) =>
    ({ site_url, site_key, has_wallets, latest_wallet_collected_utc, stale: !!stale, is_reported: !!is_reported, site_status });
  return { ...pick(d), state: checkState(d), queriedUrl: siteUrl };
}

/**
 * POST /api/submit. `wallets` = [{address, chain, xrp_dest_tag?}] already validated.
 * Returns SubmitResult (DESIGN.md).
 */
export async function submitSite(siteUrl, wallets, key) {
  requireKey(key);
  if (!siteUrl || !String(siteUrl).trim()) throw new ServiceError('bad_request', 'site_url is required.');
  if (wallets.length > MAX_WALLETS) {
    throw new ServiceError('bad_request', `Maximum ${MAX_WALLETS} wallets per submission (${wallets.length} selected). Untick some wallets.`);
  }
  const body = { site_url: String(siteUrl).trim() };
  if (wallets.length) {
    body.wallets = wallets.map(w => {
      const o = { address: w.address, chain: w.chain };
      if (w.chain === 'xrp' && w.xrp_dest_tag) o.xrp_dest_tag = String(w.xrp_dest_tag);
      return o;
    });
  }
  const res = await send('scambusters_submit', `${SB_BASE}/api/submit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 'submit');
  if (res.status === 201 || res.status === 200) {
    const d = res.json || {};
    return {
      httpStatus: res.status,
      status: d.status || (res.status === 201 ? 'queued' : 'duplicate'),
      submission_id: d.submission_id,
      submission_key: d.submission_key,
      queued_ts_utc: d.queued_ts_utc,
      site_url: d.site_url,
      wallet_count: d.wallet_count,
    };
  }
  throw mapError(res, 'submit');
}
