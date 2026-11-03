// ScamBusters Triage side panel. Vanilla ES modules, DOM built with h() only.
import { h, clear, spinner, btn, badge, errBox, toast, retryUntil, secsLeft } from './ui.js';
import { createApi } from './api.js';
import { CHECK_INFO, submitGate, pageOk } from './helpers.js';
import { openSubmitSheet } from './sheet.js';
import { renderOverview, slotView } from './tabs/overview.js';
import { renderWallets } from './tabs/wallets.js';
import { renderOnchain } from './tabs/onchain.js';
import { renderContent } from './tabs/content.js';
import { renderLog } from './tabs/log.js';
import { renderSettings, allowAllSites, refreshAllSites } from './tabs/settings.js';

const TABS = [
  ['overview', 'Overview', renderOverview],
  ['wallets', 'Wallets', renderWallets],
  ['onchain', 'On-chain', renderOnchain],
  ['content', 'Content', renderContent],
  ['log', 'Log', renderLog],
  ['settings', 'Settings', renderSettings],
];
const NEEDS_PAGE = new Set(['overview', 'wallets', 'onchain', 'content']);
const FOOTER_TABS = new Set(['overview', 'wallets']);

const ui = {
  tab: 'overview', inputs: {}, open: {}, pending: {}, errors: {}, results: {}, rowErr: {}, keyMsg: {},
  log: [], submitting: false, allSites: false, confirmClear: false, fatal: null,
};
const ctx = { state: null, settings: {}, keys: {}, ui };

const $ = id => document.getElementById(id);
let api;
let renderQueued = false;

// ---------- ctx helpers ----------
ctx.call = (type, payload) => api.call(type, payload);
ctx.render = () => {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => { renderQueued = false; renderNow(); });
};
ctx.setTab = (name, focus) => {
  ui.tab = name;
  if (name === 'log') ctx.loadLog();
  renderNow();
  if (focus) $('tab-' + name).focus();
};
ctx.run = async (key, type, payload) => {
  ui.pending[key] = true; delete ui.errors[key];
  ctx.render();
  try {
    const data = await ctx.call(type, payload);
    ui.results[key] = data;
    return { ok: true, data };
  } catch (error) {
    ui.errors[key] = error;
    return { ok: false, error };
  } finally { delete ui.pending[key]; ctx.render(); }
};
ctx.input = (key, props = {}, tag = 'input', children = []) => {
  const stored = ui.inputs[key];
  const el = h(tag, { id: 'in-' + key, ...props, value: stored !== undefined ? stored : props.value, dataset: { fk: key } }, children);
  const ev = tag === 'select' || props.type === 'checkbox' ? 'change' : 'input';
  el.addEventListener(ev, () => { ui.inputs[key] = el.value; });
  return el;
};
ctx.loadLog = async () => {
  const r = await ctx.run('log', 'log/list', {});
  if (r.ok) ui.log = (r.data && r.data.entries) || [];
  ctx.render();
};
ctx.callSubmit = async payload => {
  ui.submitting = true; delete ui.errors.submit; ctx.render();
  try {
    const data = await ctx.call('sb/submit', payload);
    ui.results.submit = data;
    ctx.loadLog();
    ui.tab = 'overview';
    return { ok: true, data };
  } catch (error) {
    if (!error || error.code !== 'recent_submit') { ui.errors.submit = error; ui.tab = 'overview'; ctx.loadLog(); }
    return { ok: false, error };
  } finally { ui.submitting = false; ctx.render(); }
};

// ---------- state intake ----------
function onState(next) {
  const prev = ctx.state;
  if (!prev || prev.tabId !== next.tabId || prev.url !== next.url) {
    ui.results = {}; ui.errors = {}; ui.rowErr = {};
    delete ui.inputs.siteUrl;
  }
  const was = prev && prev.submit && prev.submit.status;
  ctx.state = next;
  if (next.submit && next.submit.status !== was && (next.submit.status === 'done' || next.submit.status === 'error')) ctx.loadLog();
  ctx.render();
}
function onSettings(settings, keys) {
  if (settings) ctx.settings = settings;
  if (keys) ctx.keys = keys;
  if (settings && typeof settings.allSites === 'boolean') ui.allSites = settings.allSites || ui.allSites;
  ctx.render();
}

// ---------- header / chip ----------
function chip() {
  const s = ctx.state;
  if (!s) return badge('Connecting…', 'grey');
  const v = slotView(ctx, 'check', s.check);
  if (v.loading) return h('span', { class: 'badge grey' }, h('span', { class: 'spinner sm', 'aria-hidden': 'true' }), 'Checking…');
  if (v.error) return badge('Check failed', 'red', { title: v.error.message || '' });
  const info = v.data && CHECK_INFO[v.data.state];
  return info ? badge(info.label, info.kind, { title: info.text }) : badge('Not checked', 'grey');
}

function renderHeader() {
  const s = ctx.state;
  const scanning = ui.pending.scan || (s && s.scan && (s.scan.status === 'scanning' || s.scan.status === 'loading'));
  const host = $('header');
  clear(host);
  host.append(
    h('div', { class: 'hostline' },
      h('div', { class: 'host', title: s ? s.url || '' : '' }, s ? (s.hostname || s.origin || 'No page') : 'ScamBusters Triage'),
      chip()),
    h('button', { type: 'button', class: 'icon' + (scanning ? ' spinning' : ''), title: 'Re-scan this page', 'aria-label': 'Re-scan this page',
      disabled: !s || !pageOk(s) || !!scanning, onclick: () => ctx.run('scan', 'scan/run', {}) }, '⟳'));
}

// ---------- tabs ----------
function buildTabs() {
  const bar = $('tabbar');
  TABS.forEach(([id, label]) => bar.appendChild(h('button', {
    type: 'button', role: 'tab', id: 'tab-' + id, 'aria-controls': 'main', class: 'tab', dataset: { tab: id },
    onclick: () => ctx.setTab(id),
  }, label)));
  bar.addEventListener('keydown', e => {
    const i = TABS.findIndex(t => t[0] === ui.tab);
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = TABS.length - 1;
    if (n >= 0) { e.preventDefault(); ctx.setTab(TABS[n][0], true); }
  });
}
function updateTabs() {
  const nW = ctx.state ? (ctx.state.wallets || []).length : 0;
  for (const [id, label] of TABS) {
    const b = $('tab-' + id);
    const on = ui.tab === id;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    b.classList.toggle('active', on);
    const text = id === 'wallets' ? `${label} (${nW})` : label;
    if (b.textContent !== text) b.textContent = text;
  }
  $('main').setAttribute('aria-labelledby', 'tab-' + ui.tab);
}

// ---------- page-state notices ----------
function pageNotice() {
  const s = ctx.state;
  const k = s.page && s.page.kind;
  if (k === 'restricted') {
    return h('div', { class: 'notice' }, h('h2', null, "Can't scan this page"),
      h('p', null, s.page.reason || 'This kind of page (chrome://, the Chrome Web Store, the PDF viewer, other extensions) cannot be read by extensions.'),
      h('p', { class: 'muted' }, 'Open a regular website tab to use the scanner. Settings and Log still work.'));
  }
  if (k === 'no_access') {
    return h('div', { class: 'notice' }, h('h2', null, 'Access needed for this tab'),
      h('p', null, 'Click the ScamBusters Triage toolbar icon while this tab is active to grant one-time access, or allow the extension on all sites so it follows you as you switch tabs.'),
      btn('Allow on all sites', () => allowAllSites(ctx), { class: 'primary' }),
      h('p', { class: 'muted small' }, 'You can revoke this at any time in Settings.'));
  }
  if (k === 'loading') return h('div', { class: 'notice' }, spinner('Page is loading…'));
  return null;
}

// ---------- footer ----------
function renderFooter() {
  const f = $('footer');
  clear(f);
  const show = ctx.state && FOOTER_TABS.has(ui.tab);
  f.hidden = !show;
  if (!show) return;
  const g = submitGate(ctx);
  const label = ui.submitting ? 'Submitting…' : g.n ? `Submit to ScamBusters (${g.n})` : 'Submit site only';
  // Native append() would render a null child as the text "null".
  if (!g.ok && g.reason && g.reason !== 'Submitting…') {
    f.append(h('div', { class: 'foothint', role: 'status' }, g.reason + ' ',
      g.until ? h('span', { class: 'countdown', dataset: { until: String(g.until), prefix: '' } }, secsLeft(g.until) + 's') : null));
  }
  f.append(
    h('button', { type: 'button', class: 'btn primary wide', id: 'submit-btn', disabled: !g.ok, onclick: () => openSubmitSheet(ctx) }, label));
}

// ---------- main render ----------
function focusPath(el) {
  const path = [];
  let n = el;
  while (n && n !== document.body) {
    const p = n.parentNode;
    if (!p) return null;
    path.unshift([...p.children].indexOf(n));
    n = p;
  }
  return n === document.body ? path : null;
}
function byPath(path) {
  let n = document.body;
  for (const i of path) { n = n && n.children[i]; }
  return n || null;
}

function renderNow() {
  const main = $('main');
  const act = document.activeElement;
  const inSheet = act && $('sheet-root').contains(act);
  const fk = act && act.dataset && act.dataset.fk;
  const path = !fk && act && act !== document.body && !inSheet ? focusPath(act) : null;
  const tag = act && act.tagName;
  let selStart = null, selEnd = null;
  try { if (act && fk) { selStart = act.selectionStart; selEnd = act.selectionEnd; } } catch { /* not a text input */ }
  const top = main.scrollTop;

  renderHeader();
  updateTabs();
  clear(main);
  try {
    if (ui.fatal) main.appendChild(fatalView());
    else if (!ctx.state) main.appendChild(h('div', { class: 'notice' }, spinner('Connecting to the extension…')));
    else {
      const def = TABS.find(t => t[0] === ui.tab);
      const notice = NEEDS_PAGE.has(ui.tab) ? pageNotice() : null;
      main.appendChild(notice || def[2](ctx));
    }
  } catch (e) {
    main.appendChild(h('div', { class: 'errbox', role: 'alert' }, h('div', { class: 'errmsg' }, 'UI error: ' + (e && e.message ? e.message : e))));
    console.error(e);
  }
  renderFooter();
  main.scrollTop = top;

  if (!inSheet) {
    let el = null;
    if (fk) el = document.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
    else if (path) { el = byPath(path); if (el && el.tagName !== tag) el = null; }
    if (el && el !== document.activeElement) {
      el.focus({ preventScroll: true });
      try { if (selStart != null) el.setSelectionRange(selStart, selEnd); } catch { /* ignore */ }
    }
  }
}

function fatalView() {
  return h('div', { class: 'notice' }, h('h2', null, 'Cannot reach the extension'),
    errBox(ui.fatal), btn('Retry', start, { class: 'primary' }));
}

// ---------- ticker for live countdowns ----------
setInterval(() => {
  let expired = false;
  for (const el of document.querySelectorAll('.countdown[data-until]')) {
    const until = Number(el.dataset.until);
    const left = secsLeft(until);
    const t = (el.dataset.prefix ?? 'Retry in ') + left + 's';
    if (el.textContent !== t) el.textContent = t;
    if (left <= 0 && !el.dataset.done) { el.dataset.done = '1'; expired = true; }
  }
  if (expired) ctx.render();
}, 1000);

// ---------- start ----------
async function start() {
  ui.fatal = null;
  try {
    const d = await api.start();
    if (d) {
      if (d.settings) ctx.settings = d.settings;
      if (d.keys) ctx.keys = d.keys;
      if (d.state) ctx.state = d.state;
    }
  } catch (e) { ui.fatal = e; }
  renderNow();
}

function init() {
  buildTabs();
  api = createApi({
    onState, onSettings,
    onReconnect: d => {
      if (d) { if (d.settings) ctx.settings = d.settings; if (d.keys) ctx.keys = d.keys; if (d.state) ctx.state = d.state; }
      ui.fatal = null; ui.submitting = false; ctx.render();
    },
  });
  renderNow();
  start();
  refreshAllSites(ctx);
}

init();
