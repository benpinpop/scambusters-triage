// Per-tab TabState store. Memory is the fast path; every change is mirrored
// (debounced) to chrome.storage.session so a killed MV3 worker rehydrates.

const mem = new Map();          // tabId -> TabState
const timers = new Map();       // tabId -> persist timer
let listener = () => {};

const idle = () => ({ status: 'idle' });

export function blankState(tabId, url = '') {
  let origin = '', hostname = '';
  try { const u = new URL(url); origin = u.origin; hostname = u.hostname; } catch { /* non-URL */ }
  return {
    tabId, url, origin, hostname,
    page: { kind: 'loading' },
    scan: { status: 'idle' },
    wallets: [],
    rejected: [],
    dismissed: [],              // wallet ids the user removed (not re-added by re-scans)
    domainLoaded: false,        // true once wallets/dismissed were loaded from the per-domain store
    check: idle(),
    submit: idle(),
    onchain: {},
    keywords: { status: 'idle', highlighted: false },
    rdap: idle(),
    urlscan: { search: idle(), scan: idle() },
  };
}

// ---- Per-domain wallet store -------------------------------------------------
// Wallets and removed-wallet ids are kept per domain (hostname without "www."),
// not per URL or tab, so they survive navigating between pages of the same site,
// closing the tab, and browser restarts. Scoping by domain also means they are
// never carried over to a different site.
// The RDAP lookup and ScamBusters check results are cached the same way: they
// are only recomputed when the user clicks the lookup / re-check button.

const DOMAIN_STORE = 'domainWallets';
const MAX_DOMAINS = 200;
let domainWrites = Promise.resolve();

export function domainOf(hostname) { return String(hostname || '').toLowerCase().replace(/^www\./, ''); }

const isIdle = s => !s || s.status === 'idle';

/** Load the saved wallets and cached intel for st's domain into st. Call before the state is published. */
export async function hydrateFromDomain(st) {
  const d = domainOf(st.hostname);
  if (!d) return st;
  const got = await chrome.storage.local.get(DOMAIN_STORE);
  const e = got[DOMAIN_STORE] && got[DOMAIN_STORE][d];
  if (e) {
    if (!st.wallets.length && !st.dismissed.length) { st.wallets = e.wallets || []; st.dismissed = e.dismissed || []; }
    if (e.rdap && isIdle(st.rdap)) st.rdap = e.rdap;
    if (e.check && isIdle(st.check)) st.check = e.check;
  }
  st.domainLoaded = true;
  return st;
}

function saveDomain(st) {
  const d = domainOf(st.hostname);
  if (!d || !st.domainLoaded) return;   // never overwrite the store with a not-yet-loaded blank state
  // Only finished results are cached; loading and error slots are transient.
  domainWrites = domainWrites.then(async () => {
    const got = await chrome.storage.local.get(DOMAIN_STORE);
    const all = got[DOMAIN_STORE] || {};
    // A re-run in flight (or failed) keeps the previously cached result.
    const prev = all[d] || {};
    const entry = {
      wallets: st.wallets, dismissed: st.dismissed, updatedAt: Date.now(),
      ...(st.rdap.status === 'done' ? { rdap: st.rdap } : prev.rdap ? { rdap: prev.rdap } : {}),
      ...(st.check.status === 'done' ? { check: st.check } : prev.check ? { check: prev.check } : {}),
    };
    if (entry.wallets.length || entry.dismissed.length || entry.rdap || entry.check) all[d] = entry; else delete all[d];
    const keys = Object.keys(all);
    if (keys.length > MAX_DOMAINS) {
      keys.sort((a, b) => all[a].updatedAt - all[b].updatedAt);
      for (const k of keys.slice(0, keys.length - MAX_DOMAINS)) delete all[k];
    }
    await chrome.storage.local.set({ [DOMAIN_STORE]: all });
  }).catch(() => {});
}

/** Called after every change so the worker can push the state to panels. */
export function onStateChange(fn) { listener = fn; }

/** Convert slots persisted mid-flight into a readable error. */
function fixInterrupted(st) {
  const fix = s => {
    if (s && s.status === 'loading' && !(s.phase === 'waiting' && s.uuid)) {
      s.status = 'error';
      s.error = { code: 'interrupted', message: 'Interrupted because the extension restarted. Please retry.' };
    }
  };
  [st.check, st.submit, st.keywords, st.rdap, st.urlscan.search, st.urlscan.scan, st.scan].forEach(fix);
  Object.values(st.onchain).forEach(fix);
  return st;
}

export async function getState(tabId) {
  if (mem.has(tabId)) return mem.get(tabId);
  const key = `tab:${tabId}`;
  const got = await chrome.storage.session.get(key);
  if (got[key]) {
    const st = fixInterrupted(got[key]);
    mem.set(tabId, st);
    return st;
  }
  return null;
}

/** Get or create. */
export async function ensureState(tabId, url) {
  const st = await getState(tabId);
  if (st) return st;
  const fresh = await hydrateFromDomain(blankState(tabId, url));
  mem.set(tabId, fresh);
  return fresh;
}

export function setState(tabId, st) {
  mem.set(tabId, st);
  changed(tabId);
}

/** Mutate a tab's state in place and notify. Returns the state, or null if gone. */
export async function mutate(tabId, fn) {
  const st = await getState(tabId);
  if (!st) return null;
  fn(st);
  changed(tabId);
  return st;
}

function changed(tabId) {
  const st = mem.get(tabId);
  if (st) listener(tabId, st);
  clearTimeout(timers.get(tabId));
  timers.set(tabId, setTimeout(() => {
    timers.delete(tabId);
    const s = mem.get(tabId);
    if (s) {
      chrome.storage.session.set({ [`tab:${tabId}`]: s }).catch(() => {});
      saveDomain(s);
    }
  }, 250));
}

export async function dropState(tabId) {
  mem.delete(tabId);
  clearTimeout(timers.get(tabId));
  await chrome.storage.session.remove(`tab:${tabId}`).catch(() => {});
}

/** All persisted tab states (used on wake to resume URLScan polling). */
export async function allPersisted() {
  const all = await chrome.storage.session.get(null);
  return Object.entries(all).filter(([k]) => k.startsWith('tab:')).map(([, v]) => v);
}
