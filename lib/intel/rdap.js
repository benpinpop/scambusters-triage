// Domain registration data via RDAP, using the rdap.org bootstrap redirector:
//   GET https://rdap.org/domain/<domain>   (302 -> the authoritative RDAP server)
//
// CORS findings (2026-10-27): rdap.org answers with `access-control-allow-origin: *`
// (also on its 302 and its 404), and every redirect target I probed did too:
//   rdap.verisign.com (com/net), tld-rdap.verisign.com (cc), rdap.publicinterestregistry.org (org),
//   rdap.identitydigital.services (info, live, world, online...), rdap.centralnic.com (xyz, icu, cfd, sbs),
//   rdap.zdnsgtld.com (top), pubapi.registry.google (app), rdap.radix.host (site, online),
//   rdap.gmoregistry.net (shop), rdap.nic.vip, rdap.nic.club, rdap.nominet.uk (uk) - including on 404s.
// Exceptions: rdap.denic.de (.de) sent no ACAO header, and some TLDs have no RDAP at
// all (.io, .co, .me, .ru: rdap.org answers 404 with no redirect). In an extension,
// requests to hosts not listed in host_permissions are CORS-checked, so those few
// fail with a network error here, which is reported as "RDAP unavailable".
// Node 24 (undici) gets a Cloudflare HTTP 403 challenge page from rdap.org, while curl gets the
// 302. Chrome's own network stack is expected to be fine (unverified), but to be safe a 403/5xx
// from rdap.org falls back to the IANA bootstrap file (https://data.iana.org/rdap/dns.json,
// ACAO *) and queries the TLD's registry RDAP server directly.
// Only rdap.org (+ data.iana.org for the fallback) needs to be in host_permissions for the common cases; listing the
// handful of registry hosts above is optional and only helps when a server omits ACAO.

import { ServiceError } from '../errors.js';
import { request } from '../net/queue.js';

/** Second-level labels that make a 3-label registrable domain (co.uk, com.au...). */
const SLD2 = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'nom']);

export function normalizeHost(hostname) {
  return String(hostname || '').trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

/** Minimum number of labels we will strip down to for this host. */
function minLabels(labels) {
  const n = labels.length;
  if (n >= 3 && labels[n - 1].length === 2 && SLD2.has(labels[n - 2])) return 3;
  return 2;
}

const first = (arr, f) => (Array.isArray(arr) ? arr.find(f) : undefined);
function ev(events, action) {
  const e = first(events, x => x && x.eventAction === action);
  return e && e.eventDate ? e.eventDate : null;
}
function registrarName(entities) {
  const reg = first(entities, e => e && Array.isArray(e.roles) && e.roles.includes('registrar'));
  if (!reg) return null;
  const card = reg.vcardArray && reg.vcardArray[1];
  const fn = first(card, f => Array.isArray(f) && f[0] === 'fn');
  if (fn && fn[3]) return String(fn[3]);
  const id = first(reg.publicIds, () => true);
  return reg.handle || (id && id.identifier) || null;
}

export function mapRdap(domainQueried, j, now = Date.now()) {
  const created = ev(j.events, 'registration');
  let ageDays = null;
  if (created) {
    const t = Date.parse(created);
    if (Number.isFinite(t)) ageDays = Math.max(0, Math.floor((now - t) / 86_400_000));
  }
  return {
    domain: String(j.ldhName || domainQueried).toLowerCase(),
    registrar: registrarName(j.entities),
    created,
    updated: ev(j.events, 'last changed'),
    expires: ev(j.events, 'expiration'),
    ageDays,
    status: Array.isArray(j.status) ? j.status.map(String) : [],
    nameservers: Array.isArray(j.nameservers) ? j.nameservers.map(n => String(n && n.ldhName || '').toLowerCase()).filter(Boolean) : [],
    source: 'RDAP',
  };
}

let bootstrap = null;
async function loadBootstrap() {
  if (!bootstrap) {
    bootstrap = request('rdap', 'https://data.iana.org/rdap/dns.json', { timeoutMs: 30_000 }).then(r => {
      if (!r.ok || !r.json || !Array.isArray(r.json.services)) throw new ServiceError('bad_response', 'RDAP bootstrap file unavailable');
      return r.json.services;
    }).catch(e => { bootstrap = null; throw e; });
  }
  return bootstrap;
}

async function registryUrl(domain) {
  const tld = domain.split('.').pop();
  const services = await loadBootstrap();
  const svc = services.find(s => Array.isArray(s[0]) && s[0].includes(tld));
  const base = svc && Array.isArray(svc[1]) && (svc[1].find(u => u.startsWith('https://')) || svc[1][0]);
  if (!base) return null;
  return `${base.endsWith('/') ? base : base + '/'}domain/${encodeURIComponent(domain)}`;
}

const RDAP_HEADERS = { accept: 'application/rdap+json, application/json' };

/** One domain: rdap.org first, IANA-bootstrap registry as fallback. */
async function fetchDomain(domain) {
  let res = null;
  try {
    res = await request('rdap', `https://rdap.org/domain/${encodeURIComponent(domain)}`, { headers: RDAP_HEADERS });
  } catch (e) {
    if (!(e && e.code === 'network')) throw e;
  }
  if (res && res.status !== 403 && res.status < 500 && res.status !== 429) return res;
  const direct = await registryUrl(domain).catch(() => null);
  if (!direct) {
    if (res) return res;
    throw new ServiceError('network', 'RDAP is unavailable (rdap.org did not answer).');
  }
  try {
    return await request('rdap', direct, { headers: RDAP_HEADERS });
  } catch (e) {
    if (e && e.code === 'network') {
      throw new ServiceError('network', 'RDAP is unavailable for this domain (the registry server did not answer or blocks browser requests).');
    }
    throw e;
  }
}

export async function rdapLookup(hostname) {
  const host = normalizeHost(hostname);
  if (!host || !host.includes('.') || /^[0-9.]+$/.test(host) || host.includes(':')) {
    throw new ServiceError('bad_request', 'RDAP needs a domain name (IP addresses and single labels are not supported).');
  }
  const labels = host.split('.');
  const floor = minLabels(labels);
  for (let n = labels.length; n >= floor; n--) {
    const domain = labels.slice(labels.length - n).join('.');
    const res = await fetchDomain(domain);
    if (res.status === 404) continue;
    if (res.status === 400) throw new ServiceError('bad_request', 'RDAP rejected the domain name.', { status: 400 });
    if (!res.ok) {
      if (res.status === 429) throw new ServiceError('rate_limited', 'RDAP: rate limited', { status: 429 });
      throw new ServiceError(res.status >= 500 ? 'server' : 'bad_response', `RDAP: HTTP ${res.status}`, { status: res.status });
    }
    if (!res.json || typeof res.json !== 'object') throw new ServiceError('bad_response', 'RDAP: response was not JSON');
    return mapRdap(domain, res.json);
  }
  throw new ServiceError('not_found', 'No RDAP record found (the TLD may not publish RDAP data).');
}
