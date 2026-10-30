// Submit confirmation modal. Self-contained DOM so panel re-renders never disturb it.
import { h, clear, trunc, spinner, errBox } from './ui.js';
import { chainName, siteField } from './helpers.js';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function openSubmitSheet(ctx) {
  const root = document.getElementById('sheet-root');
  if (!root || root.firstChild) return;
  const wallets = ctx.state.wallets.filter(w => w.selected);
  const checked = new Set(wallets.map(w => w.id));
  const returnFocus = document.activeElement;
  let busy = false;
  let recent = null;
  let failure = null;

  const urlInput = h('input', { type: 'text', class: 'input', id: 'sheet-url', value: siteField(ctx), spellcheck: 'false', autocomplete: 'off' });
  const msg = h('div', { class: 'sheet-msg' });
  const confirm = h('button', { type: 'button', class: 'btn primary', onclick: () => go(false) });
  const cancel = h('button', { type: 'button', class: 'btn', onclick: close }, 'Cancel');
  const counter = h('span', { class: 'muted' });
  const boxes = [];

  const list = wallets.length ? h('ul', { class: 'sheet-list' }, wallets.map(w => {
    const cb = h('input', { type: 'checkbox', checked: true, id: 'sw-' + w.id, onchange: () => {
      if (cb.checked) checked.add(w.id); else checked.delete(w.id);
      refresh();
    } });
    boxes.push([w.id, cb]);
    return h('li', null,
      h('label', { for: 'sw-' + w.id, class: 'sheet-row' }, cb,
        h('span', { class: 'chain-badge' }, w.chain.toUpperCase()),
        h('span', { class: 'mono addr', title: w.address }, trunc(w.address, 12, 8)),
        w.xrpDestTag ? h('span', { class: 'muted' }, 'tag ' + w.xrpDestTag) : null));
  })) : null;

  function setAll(on) {
    for (const [id, cb] of boxes) { cb.checked = on; if (on) checked.add(id); else checked.delete(id); }
    refresh();
  }

  function refresh() {
    const n = checked.size;
    counter.textContent = wallets.length ? `${n} of ${wallets.length} selected` : 'No wallets selected';
    confirm.textContent = recent ? 'Submit anyway' : (n ? `Submit site + ${n} wallet${n === 1 ? '' : 's'}` : 'Submit site only');
    confirm.disabled = busy;
    cancel.disabled = busy;
    urlInput.disabled = busy;
    for (const [, cb] of boxes) cb.disabled = busy;
    clear(msg);
    if (busy) msg.appendChild(spinner('Submitting…'));
    if (recent) msg.appendChild(h('div', { class: 'errbox amber', role: 'alert' }, String(recent.message)));
    if (failure) msg.appendChild(errBox(failure));
  }

  async function go(force) {
    const siteUrl = urlInput.value.trim();
    if (!siteUrl) { failure = { message: 'Enter the site URL to submit.' }; refresh(); return; }
    busy = true; failure = null; refresh();
    const res = await ctx.callSubmit({
      siteUrl, walletIds: wallets.filter(w => checked.has(w.id)).map(w => w.id),
      ...(force || recent ? { force: true } : {}),
    });
    busy = false;
    if (res.ok) { close(); return; }
    if (res.error && res.error.code === 'recent_submit') { recent = res.error; refresh(); confirm.focus(); return; }
    close(); // other errors are shown on the Overview submit card
  }

  function close() {
    document.removeEventListener('keydown', onKey, true);
    clear(root);
    document.body.classList.remove('modal-open');
    if (returnFocus && returnFocus.focus && document.contains(returnFocus)) returnFocus.focus();
  }

  function onKey(e) {
    if (e.key === 'Escape') { if (!busy) { e.preventDefault(); close(); } return; }
    if (e.key !== 'Tab') return;
    const f = [...dialog.querySelectorAll(FOCUSABLE)];
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  }

  const dialog = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sheet-title' },
    h('h2', { id: 'sheet-title' }, wallets.length ? 'Confirm submission' : 'Submit site only'),
    h('label', { for: 'sheet-url', class: 'lbl' }, 'Site URL'),
    urlInput,
    wallets.length ? h('div', { class: 'sheet-tools' },
      counter,
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'link', onclick: () => setAll(true) }, 'Select all'),
      h('button', { type: 'button', class: 'link', onclick: () => setAll(false) }, 'None')) : h('p', { class: 'muted' }, 'No wallets are selected, so only the site will be submitted.'),
    list,
    msg,
    h('div', { class: 'sheet-foot' }, cancel, confirm));

  root.appendChild(h('div', { class: 'scrim' }, dialog));
  document.body.classList.add('modal-open');
  document.addEventListener('keydown', onKey, true);
  refresh();
  confirm.focus();
}
