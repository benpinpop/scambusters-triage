import { labelChips, h, spinner, btn, badge, trunc, errBox, kv, linkBtn, fmtLocal, openUrl, toast } from '../ui.js';
import { groupDigits, roundDecimal, usdValue } from '../../lib/decimal.js';
import { explorerUrl } from '../../lib/chains.js';

const amt = (v, unit) => (v == null ? 'n/a' : `${groupDigits(v)}${unit ? ' ' + unit : ''}`);

// Decimal places shown for the native asset of chains that get a USD value.
const NATIVE_PLACES = { btc: 4, eth: 2, trx: 2 };

/** Native amount: rounded for btc/eth/trx, with "(~$1,234.56)" when a price is known. */
function nativeAmt(o, v) {
  const places = NATIVE_PLACES[o.chain];
  if (places == null || v == null) return amt(v, o.nativeSymbol);
  const rounded = roundDecimal(v, places);
  if (rounded == null) return amt(v, o.nativeSymbol);
  const nonzero = /[1-9]/.test(String(v));
  const shown = nonzero && !/[1-9]/.test(rounded) ? `<0.${'0'.repeat(places - 1)}1` : groupDigits(rounded);
  const usd = usdValue(v, o.usdPrice);
  return `${shown} ${o.nativeSymbol}${usd != null ? ` (~$${groupDigits(usd)})` : ''}`;
}

export function renderOnchain(ctx) {
  const s = ctx.state;
  const ws = s.wallets || [];
  const busyAll = !!ctx.ui.pending['oc:all'];
  const lookup = (walletId, force) => {
    const k = walletId ? 'oc:' + walletId : 'oc:all';
    return ctx.run(k, 'onchain/lookup', walletId ? { walletId, force: true } : { walletId: null });
  };
  return h('div', { class: 'stack' },
    h('div', { class: 'scaninfo' },
      btn(busyAll ? 'Looking up…' : 'Look up all', () => lookup(null), { class: 'primary', disabled: busyAll || !ws.length }),
      h('span', { class: 'muted small' }, ctx.settings && ctx.settings.autoOnchain ? 'Auto-run is on.' : 'Auto-run is off: lookups only happen when you click.')),
    ctx.ui.errors['oc:all'] ? errBox(ctx.ui.errors['oc:all']) : null,
    !ws.length ? h('div', { class: 'empty' }, h('p', null, 'No wallets to look up yet.')) : null,
    ws.map(w => card(ctx, w, lookup)));
}

function card(ctx, w, lookup) {
  const slot = (ctx.state.onchain || {})[w.id];
  const local = ctx.ui.errors['oc:' + w.id];
  const loading = (slot && slot.status === 'loading') || ctx.ui.pending['oc:' + w.id];
  const url = explorerUrl(w.chain, w.address);
  const body = [];
  if (loading) body.push(h('div', { class: 'skeleton', 'aria-label': 'Loading' }, h('i'), h('i'), h('i')), spinner('Looking up…'));
  else if (slot && slot.status === 'error' || local) {
    const e = slot && slot.status === 'error' ? slot.error : local;
    body.push(errBox(e, slot && slot.status === 'error' ? slot : null,
      e.code === 'no_key' ? h('div', { class: 'row' }, btn('Open Settings', () => ctx.setTab('settings'), { class: 'tiny' })) :
        e.code === 'not_supported' && url ? h('div', null, linkBtn('Open in explorer', url)) : null));
  } else if (slot && slot.status === 'done' && slot.data) body.push(done(slot.data));
  else body.push(h('p', { class: 'muted' }, 'Not looked up yet'));
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', null, h('span', { class: 'chain-badge' }, w.chain.toUpperCase()), ' ', h('span', { class: 'mono', title: w.address }, trunc(w.address, 8, 6))),
      h('div', { class: 'card-actions' }, btn('Refresh', () => lookup(w.id, true), { class: 'tiny', disabled: !!loading }))),
    h('div', { class: 'card-body' }, body));
}

function done(o) {
  const sym = o.nativeSymbol || '';
  const sm = o.sampled;
  const sampledLabel = sm ? badge('sampled — first ' + [
    sm.native != null ? `${groupDigits(String(sm.native))} txs (${sym || 'native'})` : null,
    sm.usdt != null ? `${groupDigits(String(sm.usdt))} txs (USDT)` : null,
  ].filter(Boolean).join(', ') || 'sampled', 'amber') : null;
  const vol = (label, v) => h('div', { class: 'kv' }, h('span', { class: 'k' }, label),
    h('span', { class: 'v' }, h('div', null, nativeAmt(o, v && v.native)), v && v.usdt != null ? h('div', null, amt(v.usdt, 'USDT')) : null));
  return h('div', { class: 'result' },
    o.labels && o.labels.length ? h('div', null, labelChips(o.labels)) : null,
    sampledLabel ? h('div', null, sampledLabel) : null,
    kv('Transactions', o.txCount == null ? 'n/a' : groupDigits(String(o.txCount))),
    kv(`Balance`, nativeAmt(o, o.balance)),
    o.usdtBalance != null ? kv('USDT balance', amt(o.usdtBalance, 'USDT')) : null,
    vol('Volume in', o.volumeIn), vol('Volume out', o.volumeOut),
    kv('First seen', o.firstSeen ? h('span', { title: o.firstSeen }, fmtLocal(o.firstSeen)) : 'n/a'),
    kv('Last activity', o.lastActivity ? h('span', { title: o.lastActivity }, fmtLocal(o.lastActivity)) : 'n/a'),
    o.notes && o.notes.length ? h('ul', { class: 'notes' }, o.notes.map(n => h('li', null, String(n)))) : null,
    h('div', { class: 'row between small muted' }, h('span', null, o.source ? 'Source: ' + o.source : ''),
      o.explorerUrl ? linkBtn('Explorer', o.explorerUrl) : null));
}
