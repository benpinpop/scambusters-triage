// ScamBusters Triage service worker (MV3, ES module).
// Owns all network access, keys, validation and per-tab state. The content
// script only reads the DOM; the side panel only renders and sends requests.

import { ensureState, getState, mutate, setState, blankState, dropState, onStateChange, allPersisted, hydrateFromDomain, domainOf } from './state.js';
import { getSettings, setSettings, getKeys, keysStatus, saveKey, clearKey, SERVICES } from './settings.js';
import { checkSite, submitSite, siteKeyOf, MAX_WALLETS } from './scambusters.js';
import { addLog, listLog, clearLog, recentSubmitAt, markSubmitted } from './log.js';
import { validateAddress, classifyCandidate, validateDestTag, cleanInput } from '../lib/validators/index.js';
import { EVM_CHAINS, isEvmChain, suggestEvmChain, canonicalChain } from '../lib/chains.js';
import { ServiceError, toPlainError } from '../lib/errors.js';
import { lookupWallet, testKey } from '../lib/providers/index.js';
import { rdapLookup } from '../lib/intel/rdap.js';
import { urlscanSearch, urlscanSubmit, urlscanResult } from '../lib/intel/urlscan.js';
import { loadKeywords, scoreText } from '../lib/keywords.js';

// ------------------------------------------------------------------ setup

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'sb-add-wallet', title: 'Add selected text as wallet', contexts: ['selection'] });
  });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// ------------------------------------------------------------------ panels

/** port -> windowId */
const ports = new Map();
/** windowId -> active tabId */
const activeTab = new Map();

onStateChange((tabId, st) => {
  updateBadge(tabId, st);
  for (const [port, win] of ports) {
    if (activeTab.get(win) === tabId) safePost(port, { type: 'state', state: publicState(st) });
  }
});

function publicState(st) {
  const { dismissed, ...rest } = st; // internal bookkeeping stays in the worker
  return rest;
}

function safePost(port, msg) {
  try { port.postMessage(msg); } catch { ports.delete(port); }
}

async function pushSettings() {
  const msg = { type: 'settings', settings: await getSettings(), keys: await keysStatus() };
  for (const port of ports.keys()) safePost(port, msg);
}

chrome.runtime.onConnect.addListener(port => {
  // Only our own panel page may use this channel (content scripts' sender.url is the web page).
  const panelUrl = chrome.runtime.getURL('sidepanel/panel.html');
  if (port.name !== 'sidepanel' || port.sender?.id !== chrome.runtime.id || !String(port.sender?.url || '').startsWith(panelUrl)) {
    port.disconnect();
    return;
  }
  ports.set(port, null);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(async msg => {
    if (!msg || typeof msg.type !== 'string') return;
    const { reqId, type } = msg;
    try {
      const data = await handle(port, type, msg);
      safePost(port, { type: 'response', reqId, ok: true, data: data ?? {} });
    } catch (e) {
      safePost(port, { type: 'response', reqId, ok: false, error: toPlainError(e) });
    }
  });
});

// ------------------------------------------------------------------ tab tracking

const RESTRICTED_HOSTS = ['chromewebstore.google.com', 'chrome.google.com'];

function pageKindFor(url) {
  // Without host access Chrome hides tab.url (we deliberately don't request "tabs").
  if (!url) return { kind: 'no_access', reason: 'Click the ScamBusters Triage toolbar icon on this tab to grant access, or allow all sites in Settings.' };
  let u;
  try { u = new URL(url); } catch { return { kind: 'restricted', reason: 'Unrecognized page address.' }; }
  if (!['http:', 'https:', 'file:'].includes(u.protocol)) {
    return { kind: 'restricted', reason: `Browser pages (${u.protocol}//) can't be scanned by extensions.` };
  }
  if (RESTRICTED_HOSTS.includes(u.hostname) && (u.hostname !== 'chrome.google.com' || u.pathname.startsWith('/webstore'))) {
    return { kind: 'restricted', reason: "The Chrome Web Store can't be scanned by extensions." };
  }
  if (/\.pdf$/i.test(u.pathname)) return { kind: 'restricted', reason: "PDFs open in Chrome's PDF viewer, which extensions can't read." };
  return { kind: 'ok' };
}

async function stateForTab(tab) {
  const st = await ensureState(tab.id, tab.url || tab.pendingUrl || '');
  if (!st.url && tab.url) { Object.assign(st, blankState(tab.id, tab.url)); await hydrateFromDomain(st); }
  if (st.page.kind === 'loading' || st.page.kind === 'restricted' || st.page.kind === 'no_access') {
    st.page = st.url ? pageKindFor(st.url) : await probePage(tab.id);
  }
  return st;
}

/**
 * Without host access Chrome hides tab.url, so we can't tell a chrome:// page
 * from an ordinary site. A no-op executeScript fails with a message that names
 * the reason; classify from it. Nothing is read from or sent about the page.
 */
async function probePage(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: () => true });
    return { kind: 'ok' };
  } catch (e) {
    return accessError(e) || { kind: 'no_access', reason: 'Click the ScamBusters Triage toolbar icon on this tab to grant access, or allow all sites in Settings.' };
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  activeTab.set(windowId, tabId);
  let tab;
  try { tab = await chrome.tabs.get(tabId); } catch { return; }
  const st = await stateForTab(tab);
  setState(tabId, st);
  if (st.page.kind === 'ok' && st.scan.status === 'idle' && hasPanel(windowId)) maybeAutoRun(tabId, { onOpen: true, onSwitch: true });
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status === 'loading' && !info.url && !tab.url) {
    // A navigation we can't see (no host access): never keep the previous site's
    // wallets around, or they could be submitted against the wrong site.
    const old = await getState(tabId);
    if (old && (old.url || old.wallets.length)) setState(tabId, blankState(tabId, ''));
  }
  if (info.url) {
    const old = await getState(tabId);
    if (!old || old.url !== info.url) {
      // Same document hash change keeps state; anything else resets.
      const sameDoc = old && stripHash(old.url) === stripHash(info.url);
      if (sameDoc) {
        await mutate(tabId, s => { s.url = info.url; });
      } else {
        const fresh = blankState(tabId, info.url);
        fresh.page = pageKindFor(info.url);
        if (old && old.hostname && domainOf(old.hostname) === domainOf(fresh.hostname)) {
          // Same domain, different page: keep the wallet list (not yet flushed to the store)
          // and the per-domain RDAP / ScamBusters check results.
          fresh.wallets = old.wallets;
          fresh.dismissed = old.dismissed;
          if (old.rdap.status === 'done') fresh.rdap = old.rdap;
          if (old.check.status === 'done') fresh.check = old.check;
          fresh.domainLoaded = true;
        } else {
          await hydrateFromDomain(fresh);
        }
        setState(tabId, fresh);
      }
    }
  }
  if (info.status === 'complete') {
    const st = await stateForTab(tab);
    setState(tabId, st); // push (page kind may have changed, e.g. navigated to chrome://)
    if (st.page.kind === 'ok') maybeAutoRun(tabId, { onLoad: true });
  }
});

chrome.tabs.onRemoved.addListener(tabId => { dropState(tabId); });

function stripHash(u) { return String(u || '').split('#')[0]; }
function hasPanel(windowId) { for (const w of ports.values()) if (w === windowId) return true; return false; }

async function maybeAutoRun(tabId, { onLoad = false, onOpen = false, onSwitch = false } = {}) {
  const s = await getSettings();
  const st = await getState(tabId);
  if (!st || st.page.kind !== 'ok') return;
  // Auto-scan needs all-sites access (activeTab is only granted by a click).
  if ((onLoad && s.autoScan) || onOpen) {
    if (st.scan.status === 'idle') runScan(tabId).catch(() => {});
  }
  // The ScamBusters check only runs when the panel is opened, never on page load or tab switch.
  if (onOpen && !onSwitch && s.autoCheck && st.check.status === 'idle' && st.origin) {
    const keys = await getKeys();
    if (keys.scambusters) runCheck(tabId, st.origin).catch(() => {});
  }
}

function updateBadge(tabId, st) {
  const n = st.wallets.length;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#2f6f4f' }).catch(() => {});
}

// ------------------------------------------------------------------ content script

async function inject(tabId) {
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content/content.js'] });
}

function accessError(e) {
  const m = String(e && e.message || e);
  if (/(chrome|edge|about|devtools|chrome-extension|view-source|chrome-search):/i.test(m)) {
    return { kind: 'restricted', reason: "Browser pages (chrome://, extension pages, about:) can't be scanned by extensions." };
  }
  if (/extensions gallery|webstore|cannot be scripted/i.test(m)) {
    return { kind: 'restricted', reason: "The Chrome Web Store can't be scanned by extensions." };
  }
  if (/pdf/i.test(m)) return { kind: 'restricted', reason: "PDFs open in Chrome's PDF viewer, which extensions can't read." };
  if (/Cannot access|permission|Missing host/i.test(m)) {
    return { kind: 'no_access', reason: 'Click the ScamBusters Triage toolbar icon on this tab to grant access, or allow all sites in Settings.' };
  }
  if (/file:/i.test(m)) return { kind: 'no_access', reason: 'Enable "Allow access to file URLs" for this extension in chrome://extensions.' };
  return null;
}

async function runScan(tabId) {
  const st0 = await getState(tabId);
  if (!st0 || st0.page.kind === 'restricted') return { added: 0, rejected: 0 };
  await mutate(tabId, s => { s.scan = { ...s.scan, status: 'loading', error: undefined }; });
  const t0 = Date.now();
  try {
    await inject(tabId);
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => (globalThis.__sbTriage ? globalThis.__sbTriage.scan() : null),
    });
    const frames = results.map(r => r.result).filter(Boolean);
    let added = 0, rej = 0;
    await mutate(tabId, s => {
      s.page = { kind: 'ok' };
      for (const f of frames) { const r = ingest(s, f); added += r.added; rej += r.rejected; }
      s.scan = { status: 'done', at: Date.now(), frames: frames.length, durationMs: Date.now() - t0 };
    });
    afterNewWallets(tabId, added);
    return { added, rejected: rej };
  } catch (e) {
    const acc = accessError(e);
    await mutate(tabId, s => {
      if (acc) s.page = acc;
      s.scan = { status: 'error', at: Date.now(), error: { code: acc ? 'no_access' : 'scan_failed', message: acc ? acc.reason : `Scan failed: ${e.message || e}` } };
    });
    throw new ServiceError(acc ? acc.kind : 'scan_failed', acc ? acc.reason : `Scan failed: ${e.message || e}`);
  }
}

const MAX_WALLETS_PER_TAB = 300;
const MAX_REJECTED = 200;

/** Merge one frame's scan() result into the tab state. Page data is untrusted: check shapes and cap sizes. */
function ingest(s, frame) {
  let added = 0, rejected = 0;
  const cands = Array.isArray(frame && frame.candidates) ? frame.candidates.slice(0, 2000) : [];
  for (const c of cands) {
    if (!c || typeof c.raw !== 'string' || c.raw.length > 200) continue;
    const contexts = (Array.isArray(c.contexts) ? c.contexts : [c.context])
      .filter(x => typeof x === 'string').map(x => x.slice(0, 200)).slice(0, 3);
    const scheme = typeof c.scheme === 'string' ? c.scheme : '';
    const res = classifyCandidate(c.raw, { context: contexts.join(' • '), scheme });
    if (res.status === 'valid') {
      if (upsertWallet(s, res.result, { source: 'auto', foundIn: typeof c.source === 'string' ? c.source : 'text', contexts })) added++;
    } else if (res.status === 'rejected') {
      if (!s.rejected.some(r => r.raw === c.raw) && s.rejected.length < MAX_REJECTED) {
        s.rejected.push({ raw: c.raw, chainGuess: res.chainGuess, reason: res.reason, context: contexts[0] || '' });
        rejected++;
      }
    }
  }
  return { added, rejected };
}

/** Insert or merge a validated wallet. Returns true if it is new. */
function upsertWallet(s, r, { source, foundIn, contexts = [], chainOverride }) {
  const chain = chainOverride || r.chain;
  const id = `${chain}:${r.normalized}`;
  // An EVM address the user already moved to another EVM chain is the same wallet.
  const existing = s.wallets.find(w => w.id === id) ||
    (r.family === 'evm' && !chainOverride ? s.wallets.find(w => w.family === 'evm' && w.normalized === r.normalized) : null);
  if (existing) {
    for (const c of contexts) if (c && !existing.contexts.includes(c) && existing.contexts.length < 3) existing.contexts.push(c);
    if (existing.family === 'evm' && !existing.suggestedChain) existing.suggestedChain = suggestEvmChain(existing.contexts.join(' '));
    return false;
  }
  if (source === 'auto' && s.dismissed.includes(id)) return false;
  if (s.wallets.length >= MAX_WALLETS_PER_TAB) return false;
  s.wallets.push({
    id, chain, address: r.address, normalized: r.normalized, family: r.family,
    validation: r.validation, kind: r.kind, source, contexts, foundIn,
    suggestedChain: r.family === 'evm' ? (r.suggestedChain || suggestEvmChain(contexts.join(' '))) : null,
    selected: true,
    xrpDestTag: r.xrpDestTag || '',
    labels: [],
  });
  return true;
}

async function afterNewWallets(tabId, added) {
  if (!added) return;
  const s = await getSettings();
  if (s.autoOnchain) runLookups(tabId, null, false).catch(() => {});
}

// Debounced MutationObserver results from content scripts.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (sender.id !== chrome.runtime.id || !sender.tab || !msg || msg.type !== 'content/mutation') return;
  const tabId = sender.tab.id;
  (async () => {
    const st = await getState(tabId);
    if (!st || st.page.kind !== 'ok' || stripHash(st.url) !== stripHash(sender.tab.url)) return;
    let added = 0;
    await mutate(tabId, s => { added = ingest(s, msg.result).added; });
    afterNewWallets(tabId, added);
  })();
});

// Context menu: validate the selection through the same pipeline.
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'sb-add-wallet' || !tab) return;
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {}); // user gesture: allowed
  const st = await stateForTab(tab);
  setState(tab.id, st);
  const text = cleanInput(String(info.selectionText || '').slice(0, 200));
  const r = validateAddress(text);
  await mutate(tab.id, s => {
    if (r.ok) {
      upsertWallet(s, r, { source: 'manual', foundIn: 'context-menu', contexts: ['Added from selection'] });
      s.dismissed = s.dismissed.filter(x => x !== `${r.chain}:${r.normalized}`);
    } else if (!s.rejected.some(x => x.raw === text)) {
      s.rejected.unshift({ raw: text, chainGuess: r.chainGuess, reason: `${r.reason} (selected text)`, context: 'Context menu' });
    }
  });
});

// ------------------------------------------------------------------ request router

async function activeTabId(port) {
  const win = ports.get(port);
  if (win == null) throw new ServiceError('internal', 'Panel not initialized.');
  let id = activeTab.get(win);
  if (id == null) {
    const [t] = await chrome.tabs.query({ active: true, windowId: win });
    if (!t) throw new ServiceError('internal', 'No active tab.');
    id = t.id;
    activeTab.set(win, id);
  }
  return id;
}

async function requireState(port) {
  const tabId = await activeTabId(port);
  let st = await getState(tabId);
  if (!st) {
    const tab = await chrome.tabs.get(tabId);
    st = await stateForTab(tab);
    setState(tabId, st);
  }
  return st;
}

function findWallet(st, id) {
  const w = st.wallets.find(x => x.id === id);
  if (!w) throw new ServiceError('not_found', 'That wallet is no longer in the list.');
  return w;
}

async function handle(port, type, p) {
  switch (type) {
    case 'panel/hello': {
      const win = Number.isInteger(p.windowId) ? p.windowId : (await chrome.windows.getCurrent()).id;
      ports.set(port, win);
      const [t] = await chrome.tabs.query({ active: true, windowId: win });
      if (t) activeTab.set(win, t.id);
      const st = t ? await stateForTab(t) : blankState(-1, '');
      if (t) setState(t.id, st);
      if (t && st.page.kind === 'ok') maybeAutoRun(t.id, { onOpen: true });
      return { state: publicState(st), settings: await getSettings(), keys: await keysStatus() };
    }

    case 'scan/run': {
      const st = await requireState(port);
      if (st.page.kind === 'restricted') throw new ServiceError('restricted', st.page.reason);
      return runScan(st.tabId);
    }

    case 'wallet/add': {
      const st = await requireState(port);
      const input = cleanInput(String(p.input || '').slice(0, 200));
      const chain = p.chain && p.chain !== 'auto' ? canonicalChain(p.chain) : null;
      if (p.chain && p.chain !== 'auto' && !chain) throw new ServiceError('invalid_address', `Unknown chain '${p.chain}'.`);
      const r = validateAddress(input, chain || undefined);
      if (!r.ok) throw new ServiceError('invalid_address', capitalize(r.reason));
      if (!chain && r.ambiguousEvm) return { needsChain: true, options: [...EVM_CHAINS], suggested: null };
      if (p.xrpDestTag && r.chain === 'xrp') {
        const t = validateDestTag(p.xrpDestTag);
        if (!t.ok) throw new ServiceError('invalid_address', capitalize(t.reason));
        if (r.xrpDestTag && r.xrpDestTag !== t.tag) throw new ServiceError('invalid_address', `This X-address already encodes destination tag ${r.xrpDestTag}.`);
        r.xrpDestTag = t.tag;
      }
      const id = `${r.chain}:${r.normalized}`;
      if (st.wallets.some(w => w.id === id)) throw new ServiceError('duplicate', 'That wallet is already in the list.');
      await mutate(st.tabId, s => {
        s.dismissed = s.dismissed.filter(x => x !== id);
        upsertWallet(s, r, { source: 'manual', foundIn: 'manual', contexts: [], chainOverride: r.chain });
      });
      afterNewWallets(st.tabId, 1);
      return { wallet: (await getState(st.tabId)).wallets.find(w => w.id === id) };
    }

    case 'wallet/remove': {
      const st = await requireState(port);
      findWallet(st, p.walletId);
      await mutate(st.tabId, s => {
        s.wallets = s.wallets.filter(w => w.id !== p.walletId);
        delete s.onchain[p.walletId];
        if (!s.dismissed.includes(p.walletId)) s.dismissed.push(p.walletId);
      });
      return {};
    }

    case 'wallet/setChain': {
      const st = await requireState(port);
      const w = findWallet(st, p.walletId);
      const chain = canonicalChain(p.chain);
      if (w.family !== 'evm' || !isEvmChain(chain)) throw new ServiceError('bad_request', 'Only 0x (EVM) wallets can switch chains.');
      const newId = `${chain}:${w.normalized}`;
      if (newId === w.id) return { wallet: w };
      const hadLookup = st.onchain[w.id] && st.onchain[w.id].status !== 'idle';
      await mutate(st.tabId, s => {
        const cur = s.wallets.find(x => x.id === w.id);
        if (s.wallets.some(x => x.id === newId)) { s.wallets = s.wallets.filter(x => x.id !== w.id); }
        else { cur.chain = chain; cur.id = newId; cur.labels = []; }
        delete s.onchain[w.id];
      });
      if (hadLookup) runLookups(st.tabId, newId, false).catch(() => {});
      return { wallet: (await getState(st.tabId)).wallets.find(x => x.id === newId) };
    }

    case 'wallet/select': {
      const st = await requireState(port);
      await mutate(st.tabId, s => {
        if (p.all) s.wallets.forEach(w => { w.selected = !!p.selected; });
        else { const w = s.wallets.find(x => x.id === p.walletId); if (w) w.selected = !!p.selected; }
      });
      return {};
    }

    case 'wallet/setDestTag': {
      const st = await requireState(port);
      const w = findWallet(st, p.walletId);
      if (w.chain !== 'xrp') throw new ServiceError('bad_request', 'Destination tags apply to XRP wallets only.');
      const t = validateDestTag(p.tag);
      if (!t.ok) throw new ServiceError('bad_request', capitalize(t.reason));
      await mutate(st.tabId, s => { s.wallets.find(x => x.id === w.id).xrpDestTag = t.tag; });
      return {};
    }

    case 'sb/check': {
      const st = await requireState(port);
      return runCheck(st.tabId, String(p.siteUrl || st.origin || '').trim());
    }

    case 'sb/submit': {
      const st = await requireState(port);
      return runSubmit(st, p);
    }

    case 'onchain/lookup': {
      const st = await requireState(port);
      if (p.walletId) findWallet(st, p.walletId);
      runLookups(st.tabId, p.walletId || null, !!p.force).catch(() => {});
      return {};
    }

    case 'keywords/run': {
      const st = await requireState(port);
      return runKeywords(st.tabId);
    }

    case 'keywords/highlight': {
      const st = await requireState(port);
      return runHighlight(st.tabId, !!p.on);
    }

    case 'rdap/lookup': {
      const st = await requireState(port);
      if (!st.hostname) throw new ServiceError('bad_request', 'This page has no domain.');
      return slotRun(st.tabId, s => s.rdap, (s, v) => { s.rdap = v; }, () => rdapLookup(st.hostname));
    }

    case 'urlscan/search': {
      const st = await requireState(port);
      const key = (await getKeys()).urlscan;
      if (!st.hostname) throw new ServiceError('bad_request', 'This page has no domain.');
      return slotRun(st.tabId, s => s.urlscan.search, (s, v) => { s.urlscan.search = v; }, () => urlscanSearch(st.hostname, key));
    }

    case 'urlscan/scan': {
      const st = await requireState(port);
      const key = (await getKeys()).urlscan;
      if (!key) throw new ServiceError('no_key', 'Add a URLScan API key in Settings to submit scans.');
      const visibility = ['public', 'unlisted', 'private'].includes(p.visibility) ? p.visibility : 'unlisted';
      const url = String(p.url || st.url);
      if (!/^https?:\/\//i.test(url)) throw new ServiceError('bad_request', 'Only http(s) pages can be scanned.');
      if (st.urlscan.scan.status === 'loading') throw new ServiceError('in_flight', 'A URLScan scan is already running for this tab.');
      runUrlscan(st.tabId, url, visibility, key).catch(() => {});
      return {};
    }

    case 'settings/set': {
      const settings = await setSettings(p.patch || {});
      await pushSettings();
      return { settings };
    }

    case 'keys/save': {
      const r = await saveKey(p.service, p.value);
      if (!r.ok) throw new ServiceError('invalid_format', r.hint);
      await pushSettings();
      return { keys: await keysStatus() };
    }

    case 'keys/clear': {
      if (!SERVICES.includes(p.service)) throw new ServiceError('bad_request', 'Unknown service.');
      await clearKey(p.service);
      await pushSettings();
      return { keys: await keysStatus() };
    }

    case 'keys/test':
      return runKeyTest(p.service);

    case 'log/list':
      return { entries: await listLog() };

    case 'log/clear':
      await clearLog();
      return {};

    default:
      throw new ServiceError('bad_request', `Unknown request '${type}'.`);
  }
}

function capitalize(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

/** Run an async job into a Slot. Rejects with the same error the slot shows. */
async function slotRun(tabId, get, set, job) {
  await mutate(tabId, s => set(s, { status: 'loading', at: Date.now() }));
  try {
    const data = await job();
    await mutate(tabId, s => set(s, { status: 'done', data, at: Date.now() }));
    return data;
  } catch (e) {
    const error = toPlainError(e);
    await mutate(tabId, s => set(s, {
      status: 'error', error, at: Date.now(),
      ...(error.retryAfterMs ? { retryAt: Date.now() + error.retryAfterMs } : {}),
    }));
    throw e;
  }
}

// ------------------------------------------------------------------ ScamBusters

/** Persisted client-side cooldowns after a 429 (no blind retries). */
async function sbCooldown(endpoint) {
  const { sbCooldowns } = await chrome.storage.local.get('sbCooldowns');
  const until = sbCooldowns && sbCooldowns[endpoint];
  return until && until > Date.now() ? until : 0;
}
async function setSbCooldown(endpoint, until) {
  const { sbCooldowns } = await chrome.storage.local.get('sbCooldowns');
  await chrome.storage.local.set({ sbCooldowns: { ...(sbCooldowns || {}), [endpoint]: until } });
}

async function runCheck(tabId, siteUrl) {
  if (!siteUrl) throw new ServiceError('bad_request', 'Enter a site URL to check.');
  const key = (await getKeys()).scambusters;
  return slotRun(tabId, s => s.check, (s, v) => { s.check = v; }, async () => {
    const until = await sbCooldown('check');
    if (until) throw new ServiceError('rate_limited', 'Waiting out the ScamBusters check rate limit.', { retryAfterMs: until - Date.now() });
    try {
      const r = await checkSite(siteUrl, key);
      addLog({ type: 'check', siteUrl, status: r.state, site_key: r.site_key });
      return r;
    } catch (e) {
      if (e.code === 'rate_limited' && e.retryAfterMs) await setSbCooldown('check', Date.now() + e.retryAfterMs);
      throw e;
    }
  });
}

const SUBMITTABLE = new Set(['checksum', 'no_checksum', 'unverified']);

async function runSubmit(st, p) {
  if (st.submit.status === 'loading') throw new ServiceError('in_flight', 'A submission is already in progress.');
  const siteUrl = String(p.siteUrl || st.origin || '').trim();
  const siteKey = siteKeyOf(siteUrl);
  if (!siteKey) throw new ServiceError('bad_request', 'Enter a valid site URL.');
  const ids = Array.isArray(p.walletIds) ? [...new Set(p.walletIds)] : [];
  if (ids.length > MAX_WALLETS) {
    throw new ServiceError('too_many', `ScamBusters accepts at most ${MAX_WALLETS} wallets per submission; ${ids.length} are selected. Untick ${ids.length - MAX_WALLETS} and try again.`);
  }
  // Re-validate every wallet right before sending. A wallet that fails is never submitted.
  const wallets = [];
  for (const id of ids) {
    const w = st.wallets.find(x => x.id === id);
    if (!w) throw new ServiceError('bad_request', 'A selected wallet is no longer in the list. Reopen the confirmation sheet.');
    const r = validateAddress(w.address, w.chain);
    if (!r.ok || !SUBMITTABLE.has(w.validation) || r.normalized !== w.normalized) {
      throw new ServiceError('invalid_wallet', `Wallet ${w.address} failed validation and cannot be submitted.`);
    }
    wallets.push({ address: w.address, chain: w.chain, xrp_dest_tag: w.chain === 'xrp' ? w.xrpDestTag : undefined });
  }
  if (!p.force) {
    const at = await recentSubmitAt(siteKey);
    if (at) {
      const mins = Math.max(1, Math.round((Date.now() - at) / 60_000));
      throw new ServiceError('recent_submit', `${siteKey} was submitted from this browser ${mins} minute${mins === 1 ? '' : 's'} ago. Submit again anyway?`);
    }
  }
  const key = (await getKeys()).scambusters;
  const until = await sbCooldown('submit');
  if (until) {
    throw new ServiceError('rate_limited', 'Waiting out the ScamBusters submit rate limit.', { retryAfterMs: until - Date.now() });
  }
  let result;
  try {
    result = await slotRun(st.tabId, s => s.submit, (s, v) => { s.submit = v; }, () => submitSite(siteUrl, wallets, key));
  } catch (e) {
    if (e.code === 'rate_limited' && e.retryAfterMs) await setSbCooldown('submit', Date.now() + e.retryAfterMs);
    addLog({ type: 'submit', siteUrl, status: 'error', wallet_count: wallets.length, error: { code: e.code, message: e.message } });
    throw e;
  }
  await markSubmitted(siteKey);
  await addLog({ type: 'submit', siteUrl, status: result.status, submission_id: result.submission_id, wallet_count: result.wallet_count, wallets: wallets.map(w => ({ chain: w.chain, address: w.address })) });
  runCheck(st.tabId, siteUrl).catch(() => {});
  return result;
}

// ------------------------------------------------------------------ on-chain

const ONCHAIN_TTL = 10 * 60_000;

async function runLookups(tabId, walletId, force) {
  const st = await getState(tabId);
  if (!st) return;
  const targets = walletId ? st.wallets.filter(w => w.id === walletId) : st.wallets;
  const keys = await getKeys();
  await Promise.allSettled(targets.map(w => lookupOne(tabId, w, keys, force)));
}

async function lookupOne(tabId, w, keys, force) {
  const ckey = `onchain:${w.chain}:${w.normalized}`;
  const set = v => mutate(tabId, s => {
    if (!s.wallets.some(x => x.id === w.id)) return;
    s.onchain[w.id] = v;
    if (v.status === 'done') { const x = s.wallets.find(y => y.id === w.id); x.labels = v.data.labels || []; }
  });
  if (!force) {
    const got = (await chrome.storage.session.get(ckey))[ckey];
    if (got && Date.now() - got.at < ONCHAIN_TTL) { await set({ status: 'done', data: got.data, at: got.at, cached: true }); return; }
  }
  await set({ status: 'loading', at: Date.now() });
  try {
    const data = await lookupWallet({ chain: w.chain, address: w.address }, keys);
    const at = Date.now();
    await chrome.storage.session.set({ [ckey]: { at, data } }).catch(() => {});
    await set({ status: 'done', data, at });
  } catch (e) {
    const error = toPlainError(e);
    await set({ status: 'error', error, at: Date.now(), ...(error.retryAfterMs ? { retryAt: Date.now() + error.retryAfterMs } : {}) });
  }
}

// ------------------------------------------------------------------ keywords

async function collectText(tabId) {
  await inject(tabId);
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => (globalThis.__sbTriage ? globalThis.__sbTriage.collectText() : null),
  });
  return results.map(r => r.result).filter(x => x && typeof x.text === 'string');
}

async function runKeywords(tabId) {
  return slotRun(tabId, s => s.keywords, (s, v) => { s.keywords = { highlighted: s.keywords.highlighted, ...v }; }, async () => {
    let frames;
    try { frames = await collectText(tabId); }
    catch (e) { const acc = accessError(e); throw new ServiceError(acc ? 'no_access' : 'scan_failed', acc ? acc.reason : String(e.message || e)); }
    const text = frames.map(f => [f.title, f.metaDescription, f.text].filter(Boolean).join('\n')).join('\n').slice(0, 2_000_000);
    const kw = await loadKeywords();
    const res = scoreText(text, kw);
    return { ...res, frames: frames.length, chars: text.length };
  });
}

async function runHighlight(tabId, on) {
  const st = await getState(tabId);
  let count = 0;
  try {
    await inject(tabId);
    if (on) {
      const phrases = (st.keywords.data && st.keywords.data.top || []).map(t => t.keyword).slice(0, 60);
      if (!phrases.length) throw new ServiceError('bad_request', 'Run the keyword check first.');
      const res = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: list => (globalThis.__sbTriage ? globalThis.__sbTriage.highlight(list) : { count: 0 }),
        args: [phrases],
      });
      count = res.reduce((a, r) => a + ((r.result && r.result.count) || 0), 0);
    } else {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => (globalThis.__sbTriage ? globalThis.__sbTriage.clearHighlight() : null),
      });
    }
  } catch (e) {
    if (e.name === 'ServiceError') throw e;
    throw new ServiceError('scan_failed', `Could not change highlighting: ${e.message || e}`);
  }
  await mutate(tabId, s => { s.keywords.highlighted = on; });
  return { count };
}

// ------------------------------------------------------------------ URLScan

const URLSCAN_FIRST_WAIT = 10_000, URLSCAN_POLL = 5_000, URLSCAN_TIMEOUT = 150_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runUrlscan(tabId, url, visibility, key) {
  const setScan = v => mutate(tabId, s => { s.urlscan.scan = v; });
  await setScan({ status: 'loading', phase: 'submitting', at: Date.now() });
  try {
    const sub = await urlscanSubmit(url, visibility, key);
    await setScan({ status: 'loading', phase: 'waiting', uuid: sub.uuid, startedAt: Date.now(), at: Date.now() });
    await pollUrlscan(tabId, sub.uuid, key, Date.now());
  } catch (e) {
    const error = toPlainError(e);
    await setScan({ status: 'error', error, at: Date.now(), ...(error.retryAfterMs ? { retryAt: Date.now() + error.retryAfterMs } : {}) });
  }
}

async function pollUrlscan(tabId, uuid, key, startedAt) {
  const setScan = v => mutate(tabId, s => { s.urlscan.scan = v; });
  const firstWait = Math.max(0, startedAt + URLSCAN_FIRST_WAIT - Date.now());
  await sleep(firstWait);
  while (Date.now() - startedAt < URLSCAN_TIMEOUT) {
    const st = await getState(tabId);
    if (!st || st.urlscan.scan.uuid !== uuid) return; // tab navigated or a new scan started
    const r = await urlscanResult(uuid, key);
    if (r) { await setScan({ status: 'done', phase: 'done', uuid, data: r, at: Date.now() }); return; }
    await sleep(URLSCAN_POLL);
  }
  await setScan({
    status: 'error', uuid, at: Date.now(),
    error: { code: 'timeout', message: 'URLScan did not finish within 2.5 minutes. The scan may still complete.', guidance: `Open https://urlscan.io/result/${uuid}/ later.` },
  });
}

// Resume URLScan polling after the worker was killed mid-scan.
(async () => {
  try {
    const key = (await getKeys()).urlscan;
    if (!key) return;
    for (const st of await allPersisted()) {
      const sc = st.urlscan && st.urlscan.scan;
      if (sc && sc.status === 'loading' && sc.phase === 'waiting' && sc.uuid) {
        await getState(st.tabId);
        pollUrlscan(st.tabId, sc.uuid, key, sc.startedAt || Date.now()).catch(() => {});
      }
    }
  } catch { /* best effort */ }
})();

// ------------------------------------------------------------------ key tests

async function runKeyTest(service) {
  const keys = await getKeys();
  const key = keys[service];
  if (!key) throw new ServiceError('no_key', 'No key saved for this service.');
  switch (service) {
    case 'scambusters': {
      const r = await checkSite('example.com', key, { fetchName: 'scambusters_check' });
      return { message: `Key works: /api/check answered (example.com is ${r.state}). Submitting still requires approval.` };
    }
    case 'urlscan': {
      const r = await urlscanSearch('example.com', key);
      return { message: `Key accepted: search returned ${r.total ?? r.results.length} results.` };
    }
    default:
      return testKey(service, key);
  }
}
