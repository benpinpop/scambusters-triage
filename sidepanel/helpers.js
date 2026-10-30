import { CHAINS } from '../lib/chains.js';
import { groupDigits } from '../lib/decimal.js';
import { retryUntil, walletLabels } from './ui.js';

export const CHECK_INFO = {
  has_wallets: { kind: 'green', label: 'Submitted — has wallets', text: 'ScamBusters already has wallets on file for this site.' },
  stale: { kind: 'amber', label: 'Submitted — stale wallets', text: 'The wallets on file are out of date. Consider resubmitting freshly scanned wallets.' },
  no_wallets: { kind: 'blue', label: 'Submitted — no wallets', text: 'The site is known to ScamBusters but has no wallets recorded. Submit any wallets you found.' },
  unsubmitted: { kind: 'grey', label: 'Unsubmitted', text: 'ScamBusters has not seen this site yet.' },
};

export const BAND_KIND = { Low: 'grey', Medium: 'amber', High: 'red', 'Very high': 'dred' };

/** Current value of the site URL field (defaults to the origin). */
export function siteField(ctx) {
  const v = ctx.ui.inputs.siteUrl;
  return v === undefined ? (ctx.state.origin || ctx.state.url || '') : v;
}

export function chainName(code) {
  return CHAINS[code] ? CHAINS[code].name : String(code);
}

export function pageOk(state) {
  return !!state && state.page && state.page.kind === 'ok';
}

const OK_VALIDATION = new Set(['checksum', 'no_checksum', 'unverified']);

/** Returns { ok, reason, wallets } for the footer submit button. */
export function submitGate(ctx) {
  const s = ctx.state;
  if (!s) return { ok: false, reason: 'No active tab', n: 0 };
  const sel = (s.wallets || []).filter(w => w.selected);
  const n = sel.length;
  if (!pageOk(s)) return { ok: false, reason: 'This page cannot be scanned', n };
  if (ctx.ui.submitting || (s.submit && s.submit.status === 'loading')) return { ok: false, reason: 'Submitting…', n };
  if (n > 30) return { ok: false, reason: `Too many wallets selected (${n}). ScamBusters accepts at most 30 per submission; deselect some.`, n };
  const bad = sel.find(w => !OK_VALIDATION.has(w.validation));
  if (bad) return { ok: false, reason: `A selected wallet failed validation (${bad.address.slice(0, 12)}…). Deselect or remove it.`, n };
  const slotErr = s.submit && s.submit.status === 'error' ? s.submit : null;
  const err = slotErr ? slotErr.error : ctx.ui.errors.submit;
  if (err && err.code === 'rate_limited') {
    const until = retryUntil(err, slotErr);
    if (until && until > Date.now()) return { ok: false, reason: 'Rate limited. Submit is disabled for', n, until };
  }
  return { ok: true, n };
}

export function reportMarkdown(ctx) {
  const s = ctx.state;
  const L = [];
  const slotData = (slot, key) => (slot && slot.status === 'done' ? slot.data : ctx.ui.results[key]);
  L.push(`# ScamBusters triage report`, '');
  L.push(`- Site: ${s.url || s.origin || ''}`);
  L.push(`- Generated: ${new Date().toISOString()}`);
  const chk = slotData(s.check, 'check');
  if (chk && chk.state) {
    const i = CHECK_INFO[chk.state];
    L.push(`- ScamBusters: ${i ? i.label : chk.state} (site_status: ${chk.site_status ?? 'n/a'}, latest wallets: ${chk.latest_wallet_collected_utc ?? 'n/a'}, site_key: ${chk.site_key ?? 'n/a'})`);
  } else L.push('- ScamBusters: not checked');
  L.push('', `## Wallets (${(s.wallets || []).length})`);
  if (!(s.wallets || []).length) L.push('None found.');
  for (const w of s.wallets || []) {
    L.push(`- [${w.selected ? 'x' : ' '}] ${w.chain} \`${w.address}\` (${w.validation}, ${w.source})${w.xrpDestTag ? ` tag ${w.xrpDestTag}` : ''}`);
    const oc = s.onchain && s.onchain[w.id];
    const lbls = walletLabels(w, oc);
    if (lbls.length) L.push(`  - labels: ${lbls.map(l => `${l.text} [${l.risk || 'none'}${l.source ? ', ' + l.source : ''}]`).join('; ')}`);
    const o = oc && oc.status === 'done' ? oc.data : null;
    if (o) {
      L.push(`  - on-chain: ${o.txCount ?? '?'} txs, balance ${fmtAmt(o.balance)} ${o.nativeSymbol}` +
        (o.usdtBalance != null ? `, USDT ${fmtAmt(o.usdtBalance)}` : '') +
        `, in ${fmtAmt(o.volumeIn && o.volumeIn.native)} / out ${fmtAmt(o.volumeOut && o.volumeOut.native)} ${o.nativeSymbol}` +
        (o.firstSeen ? `, first seen ${o.firstSeen}` : '') + (o.lastActivity ? `, last ${o.lastActivity}` : '') +
        (o.sampled ? ' (sampled)' : '') + ` [${o.source}]`);
    }
  }
  if ((s.rejected || []).length) L.push('', `Rejected candidates: ${s.rejected.length}`);
  const kw = slotData(s.keywords, 'keywords');
  L.push('', '## Content keywords');
  if (kw) {
    L.push(`- Score ${kw.score}/100 (${kw.band}), crypto context: ${kw.cryptoContext ? 'yes' : 'no'}`);
    for (const t of (kw.top || []).slice(0, 8)) L.push(`  - "${t.keyword}" x${t.count} (${t.category})`);
    L.push('- Heuristic aid, not a verdict.');
  } else L.push('Not run.');
  const r = slotData(s.rdap, 'rdap');
  L.push('', '## Domain (RDAP)');
  if (r) {
    L.push(`- ${r.domain}: registrar ${r.registrar || 'n/a'}, created ${r.created || 'n/a'}${r.ageDays != null ? ` (${r.ageDays} days old)` : ''}, expires ${r.expires || 'n/a'}`);
    if (r.nameservers && r.nameservers.length) L.push(`- Nameservers: ${r.nameservers.join(', ')}`);
  } else L.push('Not looked up.');
  L.push('', '## URLScan');
  const us = s.urlscan || {};
  const sc = us.scan && us.scan.status === 'done' ? us.scan.data : null;
  const se = us.search && us.search.status === 'done' ? us.search.data : ctx.ui.results.uss;
  if (sc) {
    L.push(`- Scan: ${sc.resultUrl} score ${sc.verdict && sc.verdict.score}, malicious ${sc.verdict && sc.verdict.malicious}` +
      (sc.page ? `, IP ${sc.page.ip}, ${sc.page.asnname || sc.page.asn || ''}, ${sc.page.country || ''}` : ''));
  }
  if (se && se.results) {
    L.push(`- Existing scans: ${se.total ?? se.results.length}`);
    for (const x of se.results.slice(0, 5)) L.push(`  - ${x.time} ${x.url} ${x.ip || ''} ${x.resultUrl || ''}`);
  }
  if (!sc && !se) L.push('Not run.');
  return L.join('\n');
}

export function fmtAmt(v) {
  return v == null ? 'n/a' : groupDigits(v);
}
