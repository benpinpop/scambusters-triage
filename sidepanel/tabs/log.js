import { h, spinner, btn, badge, errBox, fmtLocal, toast, copyText } from '../ui.js';

export function renderLog(ctx) {
  const ui = ctx.ui;
  const ts = x => { const t = typeof x.at === 'number' ? x.at : Date.parse(x.at); return Number.isNaN(t) ? 0 : t; };
  const entries = (ui.log || []).slice().sort((a, b) => ts(b) - ts(a));
  const loading = !!ui.pending.log;
  return h('div', { class: 'stack' },
    h('div', { class: 'scaninfo' },
      btn('Refresh', () => ctx.loadLog(), { class: 'tiny', disabled: loading }),
      btn('Export JSON', () => exportJson(entries), { class: 'tiny', disabled: !entries.length }),
      h('span', { class: 'spacer' }),
      ui.confirmClear
        ? h('span', { class: 'row' }, h('span', { class: 'small' }, 'Delete all entries?'),
          btn('Yes, clear', async () => {
            ui.confirmClear = false;
            await ctx.run('logclear', 'log/clear', {});
            ctx.loadLog();
          }, { class: 'tiny danger' }),
          btn('Cancel', () => { ui.confirmClear = false; ctx.render(); }, { class: 'tiny' }))
        : btn('Clear log', () => { ui.confirmClear = true; ctx.render(); }, { class: 'tiny', disabled: !entries.length })),
    loading ? spinner('Loading log…') : null,
    ui.errors.log ? errBox(ui.errors.log) : null,
    !loading && !entries.length ? h('div', { class: 'empty' }, h('p', null, 'No activity logged yet.')) : null,
    h('ul', { class: 'plain logs' }, entries.map(e => {
      const bad = e.error || /error|fail|rate|expired|not_approved/i.test(String(e.status || ''));
      return h('li', { class: 'logitem' },
        h('div', { class: 'row between' },
          h('span', null, badge(String(e.type || 'event'), 'grey'), ' ', badge(String(e.status || (e.error ? 'error' : 'ok')), bad ? 'red' : 'green')),
          h('span', { class: 'muted small', title: e.at ? new Date(e.at).toISOString() : '' }, fmtLocal(e.at))),
        h('div', { class: 'mono wrap small' }, String(e.siteUrl || '')),
        e.submission_id ? h('div', { class: 'small' }, 'ID ', h('span', { class: 'mono' }, e.submission_id), ' ',
          h('button', { type: 'button', class: 'link', onclick: () => copyText(e.submission_id, 'Copied') }, 'copy')) : null,
        e.wallet_count != null ? h('div', { class: 'muted small' }, `${e.wallet_count} wallet(s)`) : null,
        Array.isArray(e.fields) ? h('div', { class: 'muted small' }, 'Filled: ' + e.fields.join(', ') + (e.terms ? ` + ${e.terms} terms box(es)` : '')) : null,
        e.email ? h('div', { class: 'small' }, 'Email ', h('span', { class: 'mono' }, String(e.email)), ' ',
          h('button', { type: 'button', class: 'link', onclick: () => copyText(e.email, 'Copied') }, 'copy')) : null,
        e.username ? h('div', { class: 'small' }, 'Username ', h('span', { class: 'mono' }, String(e.username))) : null,
        e.error ? h('div', { class: 'errtxt small' }, typeof e.error === 'string' ? e.error : (e.error.message || JSON.stringify(e.error))) : null);
    })));
}

function exportJson(entries) {
  try {
    const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `scambusters-triage-log-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (e) { toast('Export failed: ' + e.message, 'err'); }
}
