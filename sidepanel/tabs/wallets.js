import { h, spinner, btn, badge, trunc, copyText, openUrl, fmtLocal, toast, labelChips, walletLabels } from '../ui.js';
import { CHAINS, CHAIN_CODES, EVM_CHAINS, explorerUrl } from '../../lib/chains.js';
import { validateAddress } from '../../lib/validators/index.js';

const SWITCH_CHAINS = ['eth', 'bsc', 'matic', 'arb', 'avax', 'op'];
const chainLabel = c => (CHAINS[c] ? `${c.toUpperCase()} — ${CHAINS[c].name}` : c);

export function renderWallets(ctx) {
  const s = ctx.state;
  const sc = s.scan || {};
  const scanning = sc.status === 'scanning' || sc.status === 'loading' || !!ctx.ui.pending.scan;
  return h('div', { class: 'stack' },
    h('div', { class: 'scaninfo' },
      h('span', { class: 'muted' }, sc.at ? `Scanned ${fmtLocal(sc.at)} · ${sc.frames ?? '?'} frame${sc.frames === 1 ? '' : 's'} · ${sc.durationMs ?? '?'}ms` : 'Not scanned yet'),
      scanning ? spinner('Scanning…') : null,
      h('span', { class: 'spacer' }),
      btn('Re-scan', () => ctx.run('scan', 'scan/run', {}), { disabled: scanning })),
    ctx.ui.errors.scan ? errLine(ctx.ui.errors.scan.message) : null,
    sc.error ? errLine(sc.error.message || String(sc.error)) : null,
    addForm(ctx),
    walletList(ctx),
    rejectedList(ctx));
}

function errLine(msg) {
  return h('div', { class: 'errbox', role: 'alert' }, h('div', { class: 'errmsg' }, String(msg)));
}

/** The XRP destination tag field applies to XRP, or to r…/X… text while the chain is still auto-detect. */
const wantsTag = (chain, text) => chain === 'xrp' || (chain === 'auto' && /^[rX]/.test(text));

/** Re-detect the chain from the address text; keeps the dropdown and the EVM chooser in sync. */
function detectInput(ctx, text) {
  const ui = ctx.ui;
  // Store the text here: this handler runs before ctx.input's own listener, and the render below
  // would otherwise rebuild the box from the previous (stale) value and wipe what was pasted.
  ui.inputs.addInput = text;
  const r = text.trim() ? validateAddress(text) : null;
  if (r && r.ok) {
    ui.inputs.addChain = r.ambiguousEvm ? 'eth' : r.chain;
    ui.needChain = r.ambiguousEvm ? [...EVM_CHAINS] : null;
  } else { ui.inputs.addChain = 'auto'; ui.needChain = null; }
  ui.addErr = null;
  ctx.render();
}

function addForm(ctx) {
  const ui = ctx.ui;
  const chain = ui.inputs.addChain || 'auto';
  const raw = (ui.inputs.addInput || '').trim();
  const showTag = wantsTag(chain, raw);
  const busy = !!ui.pending.add;
  const submit = chosen => doAdd(ctx, chosen);
  const need = ui.needChain;
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, 'Add wallet manually')),
    h('div', { class: 'card-body' },
      h('div', { class: 'row' },
        ctx.input('addInput', { class: 'input grow mono', placeholder: 'Paste an address', 'aria-label': 'Wallet address', spellcheck: 'false', autocomplete: 'off',
          oninput: e => detectInput(ctx, e.target.value),
          onkeydown: e => { if (e.key === 'Enter') submit(); } }),
        ctx.input('addChain', { class: 'input chainsel', 'aria-label': 'Chain', value: 'auto',
          onchange: e => {
            ui.inputs.addChain = e.target.value; // see detectInput: store before the render
            if (!EVM_CHAINS.includes(e.target.value)) ui.needChain = null;
            ui.addErr = null;
            ctx.render();
          } }, 'select', [
          h('option', { value: 'auto' }, 'Auto-detect'),
          CHAIN_CODES.map(c => h('option', { value: c }, chainLabel(c)))])),
      h('div', { class: 'row' },
        showTag ? ctx.input('addTag', { class: 'input tag', inputmode: 'numeric', placeholder: 'XRP destination tag (optional)', 'aria-label': 'XRP destination tag',
          onkeydown: e => { if (e.key === 'Enter') submit(); } }) : null,
        h('span', { class: 'spacer' }),
        btn(busy ? 'Adding…' : 'Add', () => submit(), { class: 'primary', disabled: busy || !raw })),
      need ? h('div', { class: 'needchain', role: 'group', 'aria-label': 'Choose chain' },
        h('div', { class: 'small' }, 'This address could belong to more than one chain. Pick one (defaults to ETH):'),
        h('div', { class: 'row wrapr' }, need.map(c => btn(chainLabel(c), () => { ui.inputs.addChain = c; submit(c); }, { class: 'tiny', disabled: busy })))) : null,
      ui.addErr ? errLine(ui.addErr) : null));
}

async function doAdd(ctx, chosen) {
  const ui = ctx.ui;
  const input = (ui.inputs.addInput || '').trim();
  if (!input) return;
  const chain = chosen || ui.inputs.addChain || 'auto';
  const tag = (ui.inputs.addTag || '').trim();
  const showTag = wantsTag(chain, input);
  if (showTag && tag && (!/^\d{1,10}$/.test(tag) || Number(tag) > 4294967295)) {
    ui.addErr = 'Destination tag must be digits only, 0 to 4294967295.'; ctx.render(); return;
  }
  ui.pending.add = true; ui.addErr = null; ctx.render();
  try {
    const d = await ctx.call('wallet/add', { input, chain, ...(showTag && tag ? { xrpDestTag: tag } : {}) });
    if (d && d.needsChain) ui.needChain = d.options || [];
    else { ui.inputs.addInput = ''; ui.inputs.addTag = ''; ui.inputs.addChain = 'auto'; ui.needChain = null; toast('Wallet added'); }
  } catch (e) {
    if (e && e.needsChain) ui.needChain = e.options || [];
    else ui.addErr = e && e.message ? e.message : 'Could not add wallet';
  } finally { delete ui.pending.add; ctx.render(); }
}

function walletList(ctx) {
  const ws = ctx.state.wallets || [];
  const nSel = ws.filter(w => w.selected).length;
  if (!ws.length) {
    return h('div', { class: 'empty' }, h('p', null, 'No wallet addresses found.'),
      h('p', { class: 'muted' }, 'The extension scanned visible text, attributes, form values, links and shadow DOM in the page and its frames. Nothing that passed address validation turned up. You can add one manually above.'));
  }
  const selAll = on => ctx.call('wallet/select', { walletId: null, selected: on, all: true }).catch(e => toast(e.message, 'err'));
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, `Wallets (${ws.length})`),
      h('div', { class: 'card-actions' }, h('span', { class: 'muted' }, `${nSel} selected`),
        btn('Select all', () => selAll(true), { class: 'tiny' }), btn('None', () => selAll(false), { class: 'tiny' }),
        ctx.ui.confirmRemoveAll
          ? h('span', { class: 'row' }, h('span', { class: 'small' }, `Remove all ${ws.length}?`),
            btn('Yes, remove', async () => {
              ctx.ui.confirmRemoveAll = false;
              try { const d = await ctx.call('wallet/removeAll', {}); toast(`Removed ${d.removed} wallet(s)`); }
              catch (e) { toast(e && e.message || 'Failed', 'err'); }
              ctx.render();
            }, { class: 'tiny danger' }),
            btn('Cancel', () => { ctx.ui.confirmRemoveAll = false; ctx.render(); }, { class: 'tiny' }))
          : btn('Remove all', () => { ctx.ui.confirmRemoveAll = true; ctx.render(); }, { class: 'tiny danger' }))),
    h('ul', { class: 'plain wallets' }, ws.map(w => row(ctx, w))));
}

function row(ctx, w) {
  const call = (type, payload) => ctx.call(type, payload).catch(e => toast(e && e.message || 'Failed', 'err'));
  const val = { checksum: ['✓ checksum', 'green'], no_checksum: ['no checksum', 'amber'], unverified: ['unverified', 'grey'] }[w.validation] || [String(w.validation), 'red'];
  const isEvm = EVM_CHAINS.includes(w.chain);
  const ctxs = (w.contexts || []);
  const url = explorerUrl(w.chain, w.address);
  const sug = isEvm && w.suggestedChain && w.suggestedChain !== w.chain ? w.suggestedChain : null;
  const tagKey = 'tag:' + w.id;
  const tagErr = ctx.ui.rowErr[w.id];
  return h('li', { class: 'wallet' + (w.selected ? ' sel' : '') },
    h('input', { type: 'checkbox', checked: !!w.selected, 'aria-label': `Select ${w.address}`,
      onchange: e => call('wallet/select', { walletId: w.id, selected: e.target.checked }) }),
    h('div', { class: 'wbody' },
      h('div', { class: 'wline' },
        h('span', { class: 'chain-badge' }, w.chain.toUpperCase()),
        h('span', { class: 'mono addr', title: w.address }, trunc(w.address, 10, 8)),
        h('button', { type: 'button', class: 'icon tiny', title: 'Copy address', 'aria-label': 'Copy address', onclick: () => copyText(w.address, 'Address copied') }, '⧉'),
        badge(val[0], val[1], { title: w.kind || '' }),
        h('span', { class: 'tag ' + w.source }, w.source),
        labelChips(walletLabels(w, (ctx.state.onchain || {})[w.id]))),
      ctxs.length ? h('div', { class: 'ctx', title: ctxs.join('\n— ') }, ctxs[0]) : null,
      h('div', { class: 'wline wactions' },
        isEvm ? h('select', { class: 'input mini', 'aria-label': 'EVM chain', onchange: e => call('wallet/setChain', { walletId: w.id, chain: e.target.value }) },
          SWITCH_CHAINS.map(c => h('option', { value: c, selected: c === w.chain }, c))) : null,
        sug ? btn(`Suggested: ${sug.toUpperCase()}`, () => call('wallet/setChain', { walletId: w.id, chain: sug }), { class: 'tiny suggest' }) : null,
        w.chain === 'xrp' ? ctx.input(tagKey, { class: 'input mini tagin', inputmode: 'numeric', placeholder: 'dest tag', 'aria-label': 'XRP destination tag', value: w.xrpDestTag || '',
          onchange: async e => {
            const t = e.target.value.trim();
            if (t && (!/^\d{1,10}$/.test(t) || Number(t) > 4294967295)) { ctx.ui.rowErr[w.id] = 'Digits only, max 4294967295'; ctx.render(); return; }
            delete ctx.ui.rowErr[w.id];
            try { await ctx.call('wallet/setDestTag', { walletId: w.id, tag: t }); delete ctx.ui.inputs[tagKey]; }
            catch (er) { ctx.ui.rowErr[w.id] = er.message; }
            ctx.render();
          } }) : null,
        h('span', { class: 'spacer' }),
        url ? h('button', { type: 'button', class: 'icon tiny', title: 'Open in explorer', 'aria-label': 'Open in explorer', onclick: () => openUrl(url) }, '↗') : null,
        h('button', { type: 'button', class: 'icon tiny danger', title: 'Remove', 'aria-label': 'Remove wallet', onclick: () => call('wallet/remove', { walletId: w.id }) }, '✕')),
      tagErr ? h('div', { class: 'errline' }, tagErr) : null));
}

function rejectedList(ctx) {
  const rej = ctx.state.rejected || [];
  if (!rej.length) return null;
  return h('details', { class: 'card rejected', open: !!ctx.ui.open.rejected, ontoggle: e => { ctx.ui.open.rejected = e.target.open; } },
    h('summary', null, `Rejected (${rej.length})`),
    h('div', { class: 'card-body' },
      h('p', { class: 'muted small' }, 'These candidates failed validation and cannot be added.'),
      h('ul', { class: 'plain' }, rej.map(r => h('li', { class: 'rej' },
        h('div', { class: 'mono wrap', title: r.raw }, trunc(r.raw, 24, 12)),
        h('div', { class: 'small' }, r.chainGuess ? badge(r.chainGuess, 'grey') : null, ' ', h('span', { class: 'errtxt' }, String(r.reason || ''))),
        r.context ? h('div', { class: 'ctx' }, r.context) : null)))));
}
