// Tiny DOM helpers. No HTML string parsing anywhere: every string goes through text nodes.

const PROPS = new Set([
  'value', 'checked', 'disabled', 'selected', 'open', 'indeterminate', 'hidden',
  'tabIndex', 'download', 'readOnly', 'multiple',
]);

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  const late = [];
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (PROPS.has(k)) late.push([k, v]);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  for (const [k, v] of late) el[k] = v; // after children so <select>.value works
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function trunc(s, head = 8, tail = 6) {
  s = String(s ?? '');
  return s.length > head + tail + 3 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

export function spinner(label) {
  return h('span', { class: 'spin-wrap', role: 'status' },
    h('span', { class: 'spinner', 'aria-hidden': 'true' }),
    label ? h('span', { class: 'muted' }, label) : null);
}

export function fmtLocal(v) {
  if (v == null || v === '') return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

export function fmtDate(v) {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString();
}

export function toast(msg, kind = 'ok') {
  const box = document.getElementById('toasts');
  if (!box) return;
  const t = h('div', { class: `toast ${kind}` }, msg);
  box.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

export async function copyText(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(String(text));
    toast(what);
  } catch (e) {
    toast('Copy failed: ' + (e && e.message ? e.message : e), 'err');
  }
}

/** Open a result/explorer link only on click, only https. */
export function openUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    toast('Refusing to open a non-https link', 'err');
    return;
  }
  try {
    globalThis.chrome.tabs.create({ url });
  } catch (e) {
    toast('Could not open link: ' + (e && e.message ? e.message : e), 'err');
  }
}

export function linkBtn(label, url, extra = {}) {
  return h('button', {
    type: 'button', class: 'link', title: url, ...extra,
    onclick: () => openUrl(url),
  }, label, h('span', { class: 'ext', 'aria-hidden': 'true' }, ' ↗'));
}

export function btn(label, onclick, props = {}) {
  return h('button', { type: 'button', onclick, ...props, class: 'btn ' + (props.class || '') }, label);
}

export function badge(text, kind = 'grey', props = {}) {
  return h('span', { ...props, class: `badge ${kind}` }, text);
}

/** Live countdown. Updated by the ticker in panel.js via data-until. */
export function countdown(untilMs, prefix = 'Retry in ') {
  return h('span', { class: 'countdown', dataset: { until: String(untilMs), prefix } },
    prefix + secsLeft(untilMs) + 's');
}

export function secsLeft(untilMs) {
  return Math.max(0, Math.ceil((untilMs - Date.now()) / 1000));
}

const errSeen = new WeakMap();
/** Absolute retry time for an error/slot, or null. */
export function retryUntil(err, slot) {
  if (slot && slot.retryAt) return slot.retryAt;
  if (err && err.retryAfterMs) {
    if (!errSeen.has(err)) errSeen.set(err, Date.now());
    return errSeen.get(err) + err.retryAfterMs;
  }
  return null;
}

/** Readable error block: message, guidance, details list, countdown. */
export function errBox(err, slot, extra) {
  if (!err) return null;
  const until = retryUntil(err, slot);
  return h('div', { class: 'errbox', role: 'alert' },
    h('div', { class: 'errmsg' }, String(err.message || err.code || 'Something went wrong')),
    err.guidance ? h('div', { class: 'errguide' }, String(err.guidance)) : null,
    Array.isArray(err.details) && err.details.length
      ? h('ul', { class: 'errlist' }, err.details.map(d => h('li', null, String(d)))) : null,
    until && until > Date.now() ? h('div', { class: 'errwait' }, countdown(until)) : null,
    extra || null);
}

export function kv(label, value, props = {}) {
  if (value == null || value === '') return null;
  return h('div', { class: 'kv' },
    h('span', { class: 'k' }, label),
    h('span', { class: 'v', ...props }, value));
}

export function card(title, body, actions) {
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, title), actions ? h('div', { class: 'card-actions' }, actions) : null),
    h('div', { class: 'card-body' }, body));
}

const RISK_KIND = { high: 'red', caution: 'amber', none: 'blue' };

/** Labels for a wallet: its own, else those on a finished on-chain lookup. */
export function walletLabels(w, onchainSlot) {
  if (w && Array.isArray(w.labels) && w.labels.length) return w.labels;
  const d = onchainSlot && onchainSlot.status === 'done' ? onchainSlot.data : null;
  return d && Array.isArray(d.labels) ? d.labels : [];
}

/** Small chips; label text via textContent, source in tooltip and small text. */
export function labelChips(labels) {
  if (!labels || !labels.length) return null;
  return h('span', { class: 'labels' }, labels.map(l => h('span', {
    class: `lchip ${RISK_KIND[l.risk] || 'blue'}`,
    title: `${l.text} — source: ${l.source || 'unknown'}${l.kind ? ' (' + l.kind + ')' : ''}${l.risk ? ', risk: ' + l.risk : ''}`,
  }, String(l.text), l.source ? h('small', null, String(l.source)) : null)));
}
