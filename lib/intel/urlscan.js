// URLScan.io client. Header: `API-Key`.
//
// Live-verified (2026-10-27): keyless GET /api/v1/search/?q=domain:example.com&size=2
// returns HTTP 200 {results:[{task:{uuid,time,url,domain,visibility}, page:{url,ip,asn,
// asnname,server,domain,country?}, screenshot:"https://urlscan.io/screenshots/<uuid>.png",
// result:"https://urlscan.io/api/v1/result/<uuid>/"}], total, has_more}, with headers
// X-Rate-Limit-Limit: 30 (per minute, scope ip-address, action search). Search rows
// carry no verdict, so verdictScore/malicious are only set if a row has `verdicts`.
// Documented (docs.urlscan.io): scan submission 400 bodies are {message, description,
// status, errors[]} (DNS error, blacklisted, invalid URL); validation errors use
// {code:'validationerror', type, message, errors[]}. Result: verdicts.overall
// {score -100..100, malicious, categories, brands, hasVerdicts}, verdicts.urlscan
// {score, categories, brands[{key,name,country,vertical}]}, page.{ip,asn,asnname,
// country,server,domain,url}. Result is 404 until the scan finishes, 410 if deleted.
// UNVERIFIED without a key: POST /scan/ and /result/ live bodies (mocked in tests).

import { ServiceError } from '../errors.js';
import { request } from '../net/queue.js';

const BASE = 'https://urlscan.io';
const shot = uuid => `${BASE}/screenshots/${uuid}.png`;
const resultUrl = uuid => `${BASE}/result/${uuid}/`;

function headers(key, json) {
  const h = { accept: 'application/json' };
  if (key) h['API-Key'] = key;
  if (json) h['content-type'] = 'application/json';
  return h;
}

function errDetails(j) {
  if (!j || typeof j !== 'object') return null;
  const out = [];
  if (j.message) out.push(String(j.message));
  if (j.description && j.description !== j.message) out.push(String(j.description));
  if (Array.isArray(j.errors)) {
    for (const e of j.errors) {
      const t = e && (e.detail || e.description || e.title);
      if (t && !out.includes(String(t))) out.push(String(t));
    }
  }
  return out.length ? out : null;
}

function throwFor(res, what, hadKey) {
  const s = res.status;
  const details = errDetails(res.json);
  const text = details ? details[0] : '';
  if (s === 400) throw new ServiceError('bad_request', `URLScan: ${text || 'bad request'}`, { status: 400, details: details || undefined });
  if (s === 401 || s === 403) {
    throw new ServiceError(hadKey ? 'invalid_key' : 'no_key', hadKey ? 'URLScan rejected the API key.' : 'A URLScan API key is required for this action.', { status: s });
  }
  if (s === 429) {
    const ra = Number(res.headers['x-rate-limit-reset-after']);
    throw new ServiceError('rate_limited', `URLScan: rate limit reached (${what}).`, { status: 429, retryAfterMs: Number.isFinite(ra) ? ra * 1000 : undefined });
  }
  if (s === 404) throw new ServiceError('not_found', 'URLScan: not found', { status: 404 });
  if (s >= 500) throw new ServiceError('server', `URLScan: server error (HTTP ${s})`, { status: s });
  throw new ServiceError('bad_response', `URLScan: unexpected HTTP ${s}`, { status: s });
}

function verdictOf(v) {
  const o = (v && v.overall) || {};
  const u = (v && v.urlscan) || {};
  const brands = (arr) => (Array.isArray(arr) ? arr.map(b => (typeof b === 'string' ? b : (b && (b.name || b.key)))).filter(Boolean) : []);
  const ob = brands(o.brands), ub = brands(u.brands);
  return {
    score: Number.isFinite(Number(o.score)) ? Number(o.score) : (Number.isFinite(Number(u.score)) ? Number(u.score) : 0),
    malicious: !!(o.malicious ?? u.malicious),
    categories: [...new Set([...(o.categories || []), ...(u.categories || [])].map(String))],
    brands: [...new Set([...ob, ...ub])],
  };
}

/** Existing scans for a hostname. Works keyless (lower quota). */
export async function urlscanSearch(hostname, key) {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) throw new ServiceError('bad_request', 'No hostname to search.');
  const q = `domain:${host}`;
  const res = await request('urlscan', `${BASE}/api/v1/search/?q=${encodeURIComponent(q)}&size=10`, { headers: headers(key) });
  if (!res.ok) throwFor(res, 'search', !!key);
  const j = res.json;
  if (!j || !Array.isArray(j.results)) throw new ServiceError('bad_response', 'URLScan: unexpected search response');
  const results = j.results.filter(r => r && r.task && r.task.uuid).map(r => {
    const uuid = r.task.uuid, p = r.page || {};
    const item = {
      uuid,
      time: r.task.time || null,
      url: p.url || r.task.url || null,
      ip: p.ip || null,
      asn: p.asn || null,
      asnname: p.asnname || null,
      country: p.country || null,
      server: p.server || null,
      screenshot: shot(uuid),
      resultUrl: resultUrl(uuid),
    };
    if (r.verdicts) {
      const v = verdictOf(r.verdicts);
      item.verdictScore = v.score;
      item.malicious = v.malicious;
    }
    return item;
  });
  return { total: Number.isFinite(Number(j.total)) ? Number(j.total) : results.length, results };
}

/** Submit a scan. Returns { uuid, resultUrl, screenshot }. */
export async function urlscanSubmit(url, visibility, key) {
  if (!key) throw new ServiceError('no_key', 'A URLScan API key is required to submit scans.');
  const vis = ['public', 'unlisted', 'private'].includes(visibility) ? visibility : 'unlisted';
  const res = await request('urlscan', `${BASE}/api/v1/scan/`, {
    method: 'POST',
    headers: headers(key, true),
    body: JSON.stringify({ url, visibility: vis }),
    retries: 0,
  });
  if (!res.ok) throwFor(res, 'submit', true);
  const j = res.json;
  if (!j || !j.uuid) throw new ServiceError('bad_response', 'URLScan: submit response had no uuid');
  return { uuid: j.uuid, resultUrl: resultUrl(j.uuid), screenshot: shot(j.uuid) };
}

/** Fetch a finished scan. null while the scan is still running (HTTP 404). */
export async function urlscanResult(uuid, key) {
  if (!/^[0-9a-f-]{36}$/i.test(String(uuid))) throw new ServiceError('bad_request', 'Invalid scan id.');
  const res = await request('urlscan', `${BASE}/api/v1/result/${uuid}/`, { headers: headers(key), retries: 1 });
  if (res.status === 404) return null;
  if (res.status === 410) throw new ServiceError('not_found', 'URLScan: this scan was deleted.', { status: 410 });
  if (!res.ok) throwFor(res, 'result', !!key);
  const j = res.json;
  if (!j || typeof j !== 'object' || !j.page) throw new ServiceError('bad_response', 'URLScan: unexpected result shape');
  const p = j.page;
  return {
    uuid,
    resultUrl: resultUrl(uuid),
    screenshot: shot(uuid),
    verdict: verdictOf(j.verdicts),
    page: {
      ip: p.ip || null,
      asn: p.asn || null,
      asnname: p.asnname || null,
      country: p.country || null,
      server: p.server || null,
      domain: p.domain || null,
      url: p.url || null,
    },
  };
}
