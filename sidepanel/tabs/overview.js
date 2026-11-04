import { walletLabels, h, spinner, errBox, kv, card, btn, badge, linkBtn, copyText, fmtLocal, fmtDate, retryUntil, countdown } from '../ui.js';
import { CHECK_INFO, siteField, reportMarkdown } from '../helpers.js';
import { contentCard } from './content.js';

/** Merge a worker slot with locally-tracked call state. */
export function slotView(ctx, key, slot) {
  const ui = ctx.ui;
  const loading = !!ui.pending[key] || (slot && slot.status === 'loading');
  const error = slot && slot.status === 'error' ? slot.error : ui.errors[key] || null;
  const data = slot && slot.status === 'done' ? slot.data : (error ? null : ui.results[key]);
  return { loading, error, data, slot };
}

export function renderOverview(ctx) {
  const s = ctx.state;
  const flagged = (s.wallets || []).map(w => ({ w, hi: walletLabels(w, (s.onchain || {})[w.id]).filter(l => l.risk === 'high') })).filter(x => x.hi.length);
  const flags = flagged.length ? h('div', { class: 'flags', role: 'alert' },
    flagged.length === 1 ? '1 wallet carries risk labels: ' : `${flagged.length} wallets carry risk labels: `,
    flagged.flatMap(x => x.hi.map(l => `${l.text}${l.source ? ' (' + l.source + ')' : ''}`)).join(', ')) : null;
  return h('div', { class: 'stack' },
    flags,
    checkCard(ctx), submitCard(ctx), rdapCard(ctx), contentCard(ctx), urlscanCard(ctx),
    h('div', { class: 'card pad' }, btn('Copy triage report (Markdown)', () => copyText(reportMarkdown(ctx), 'Report copied'), { class: 'wide' })));
}

function checkCard(ctx) {
  const s = ctx.state;
  const v = slotView(ctx, 'check', s.check);
  const useFull = ctx.ui.inputs.siteUrl !== undefined && ctx.ui.inputs.siteUrl === s.url && s.url !== s.origin;
  const field = ctx.input('siteUrl', { value: siteField(ctx), class: 'input', 'aria-label': 'Site URL to check', placeholder: 'https://example.com',
    onkeydown: e => { if (e.key === 'Enter') doCheck(); } });
  const doCheck = () => ctx.run('check', 'sb/check', { siteUrl: siteField(ctx).trim() });
  const d = v.data;
  const info = d && CHECK_INFO[d.state];
  return card('ScamBusters check', [
    h('div', { class: 'row' }, field),
    h('div', { class: 'row between' },
      h('button', { type: 'button', class: 'link', onclick: () => {
        ctx.ui.inputs.siteUrl = useFull ? s.origin : s.url; ctx.render();
      } }, useFull ? 'Use origin only' : 'Use full URL'),
      btn(v.loading ? 'Checking…' : d ? 'Re-check site' : 'Check site', doCheck, { class: 'primary', disabled: v.loading || !siteField(ctx).trim() })),
    v.loading ? spinner('Checking ScamBusters…') : null,
    v.error ? errBox(v.error, s.check) : null,
    info && s.check.at ? h('div', { class: 'muted small', title: 'Saved for this domain until you re-check.' }, `Checked ${fmtLocal(s.check.at)}`) : null,
    info ? h('div', { class: 'result' },
      h('div', null, badge(info.label, info.kind, { class: 'badge big ' + info.kind })),
      h('p', { class: 'muted' }, info.text),
      kv('site_status', d.site_status != null ? String(d.site_status) : 'n/a'),
      kv('latest_wallet_collected_utc', d.latest_wallet_collected_utc
        ? h('span', { title: String(d.latest_wallet_collected_utc) }, fmtLocal(d.latest_wallet_collected_utc)) : 'n/a'),
      kv('site_key', d.site_key != null ? h('span', { class: 'mono' }, String(d.site_key)) : 'n/a'),
      d.queriedUrl ? kv('queried', h('span', { class: 'mono wrap' }, d.queriedUrl)) : null) : null,
  ]);
}

function submitCard(ctx) {
  const s = ctx.state;
  const v = slotView(ctx, 'submit', s.submit);
  const loading = v.loading || ctx.ui.submitting;
  if (!loading && !v.error && !v.data) return null;
  let body;
  if (loading) body = spinner('Submitting to ScamBusters…');
  else if (v.error) {
    const e = v.error;
    body = errBox(e, s.submit, e.code === 'rate_limited' ? h('p', { class: 'muted' }, 'Submit stays disabled until the countdown ends. It will not retry automatically.') : null);
  } else {
    const d = v.data;
    body = [
      h('div', null, badge(d.status === 'duplicate' ? 'Duplicate' : 'Queued', d.status === 'duplicate' ? 'amber' : 'green', { class: 'badge big ' + (d.status === 'duplicate' ? 'amber' : 'green') })),
      d.submission_id ? kv('submission_id', h('span', null, h('span', { class: 'mono' }, d.submission_id), ' ',
        btn('Copy', () => copyText(d.submission_id, 'Submission ID copied'), { class: 'tiny' }))) : null,
      kv('wallet_count', String(d.wallet_count ?? 0)),
      d.site_url ? kv('site', h('span', { class: 'mono wrap' }, d.site_url)) : null,
    ];
  }
  return card('Submit result', body);
}

function rdapCard(ctx) {
  const s = ctx.state;
  const v = slotView(ctx, 'rdap', s.rdap);
  const d = v.data;
  let age = null;
  if (d && d.ageDays != null) {
    const kind = d.ageDays < 30 ? 'red' : d.ageDays < 90 ? 'amber' : 'grey';
    age = kv('Age', kind === 'grey' ? `${d.ageDays} days` : badge(`Registered ${d.ageDays} days ago`, kind));
  }
  return card('Domain intel (RDAP)', [
    h('div', { class: 'row' }, btn(v.loading ? 'Looking up…' : d ? 'Re-run lookup' : 'Look up', () => ctx.run('rdap', 'rdap/lookup', {}), { disabled: v.loading }),
      d && s.rdap.at ? h('span', { class: 'muted small', title: 'Saved for this domain until you re-run the lookup.' }, `Looked up ${fmtLocal(s.rdap.at)}`) : null),
    v.loading ? spinner('Querying RDAP…') : null,
    v.error ? errBox(v.error, s.rdap) : null,
    d ? h('div', { class: 'result' },
      kv('Domain', d.domain), kv('Registrar', d.registrar || 'n/a'),
      kv('Created', d.created ? h('span', { title: d.created }, fmtDate(d.created)) : 'n/a'),
      age,
      kv('Expires', d.expires ? h('span', { title: d.expires }, fmtDate(d.expires)) : 'n/a'),
      d.status && d.status.length ? kv('Status', d.status.join(', ')) : null,
      d.nameservers && d.nameservers.length ? kv('Nameservers', h('span', { class: 'mono wrap' }, d.nameservers.join(', '))) : null,
      d.source ? h('div', { class: 'muted small' }, 'Source: ' + d.source) : null) : null,
  ]);
}

function noKeyHint(ctx, err) {
  if (!err || err.code !== 'no_key') return null;
  return h('div', { class: 'row' }, h('span', null, 'Add a URLScan key in Settings. '),
    btn('Open Settings', () => ctx.setTab('settings'), { class: 'tiny' }));
}

function shot(url, size) {
  if (typeof url !== 'string' || !url.startsWith('https://urlscan.io/screenshots/')) return null;
  return h('img', { class: 'shot ' + (size || ''), src: url, alt: 'URLScan screenshot', loading: 'lazy', referrerpolicy: 'no-referrer', width: size === 'lg' ? 320 : 96 });
}

function urlscanCard(ctx) {
  const s = ctx.state;
  const us = s.urlscan || {};
  const sv = slotView(ctx, 'uss', us.search);
  const scanSlot = us.scan;
  const scanLoading = !!ctx.ui.pending.usc || (scanSlot && scanSlot.status === 'loading');
  const scanErr = scanSlot && scanSlot.status === 'error' ? scanSlot.error : ctx.ui.errors.usc;
  const sc = scanSlot && scanSlot.status === 'done' ? scanSlot.data : null;
  const phaseText = { submitting: 'Submitting scan…', waiting: 'Waiting for URLScan to finish (can take up to a minute)…', done: 'Done' };
  const vis = ctx.ui.inputs.vis || (ctx.settings && ctx.settings.urlscanVisibility) || 'unlisted';
  const sel = ctx.input('vis', { class: 'input vissel', value: vis, 'aria-label': 'Scan visibility' }, 'select', ['public', 'unlisted', 'private'].map(o => h('option', { value: o }, o[0].toUpperCase() + o.slice(1))));
  const results = sv.data && sv.data.results ? sv.data.results.slice(0, 5) : null;
  return card('URLScan', [
    h('div', { class: 'row' }, btn(sv.loading ? 'Searching…' : 'Search existing scans', () => ctx.run('uss', 'urlscan/search', {}), { disabled: sv.loading })),
    sv.loading ? spinner('Searching URLScan…') : null,
    sv.error ? [errBox(sv.error, us.search), noKeyHint(ctx, sv.error)] : null,
    results ? (results.length ? h('ul', { class: 'plain scans' }, results.map(r => h('li', { class: 'scan-item' },
      shot(r.screenshot),
      h('div', { class: 'scan-meta' },
        h('div', { class: 'small', title: r.time }, fmtLocal(r.time)),
        h('div', { class: 'mono wrap small' }, String(r.url || '')),
        h('div', { class: 'muted small' }, [r.ip, r.asn ? `${r.asn}${r.asnname ? ' ' + r.asnname : ''}` : r.asnname, r.country, r.server].filter(Boolean).join(' · ')),
        r.malicious ? badge('malicious', 'red') : null,
        r.resultUrl ? linkBtn('Open', r.resultUrl) : null)))) : h('p', { class: 'muted' }, 'No existing scans found.')) : null,
    sv.data && sv.data.total != null ? h('div', { class: 'muted small' }, `${sv.data.total} total result${sv.data.total === 1 ? '' : 's'}`) : null,
    h('hr'),
    h('div', { class: 'row' }, h('label', { class: 'lbl inline', for: 'in-vis' }, 'Visibility'), sel,
      h('span', { class: 'spacer' }),
      btn(scanLoading ? 'Scanning…' : 'Scan now', () => ctx.run('usc', 'urlscan/scan', { url: s.url, visibility: ctx.ui.inputs.vis || vis }), { class: 'primary', disabled: scanLoading || !s.url })),
    scanLoading ? spinner(phaseText[scanSlot && scanSlot.phase] || 'Starting scan…') : null,
    scanErr ? [errBox(scanErr, scanSlot), noKeyHint(ctx, scanErr)] : null,
    sc ? scanResult(sc) : null,
  ]);
}

function scanResult(sc) {
  const v = sc.verdict || {}, p = sc.page || {};
  return h('div', { class: 'result' },
    kv('Score', v.score != null ? String(v.score) : 'n/a'),
    kv('Malicious', v.malicious ? badge('yes', 'red') : badge('no', 'grey')),
    v.categories && v.categories.length ? kv('Categories', v.categories.join(', ')) : null,
    v.brands && v.brands.length ? kv('Brands', v.brands.map(b => (typeof b === 'string' ? b : b.name || b.key)).join(', ')) : null,
    kv('IP', p.ip), kv('ASN', p.asn ? `${p.asn}${p.asnname ? ' ' + p.asnname : ''}` : null),
    kv('Country', p.country), kv('Server', p.server),
    shot(sc.screenshot, 'lg'),
    sc.resultUrl ? h('div', null, linkBtn('Open result', sc.resultUrl)) : null);
}
