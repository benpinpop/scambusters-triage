import { h, spinner, btn, badge, errBox, card, toast } from '../ui.js';
import { slotView } from './overview.js';
import { BAND_KIND } from '../helpers.js';

export function renderContent(ctx) {
  const s = ctx.state;
  const v = slotView(ctx, 'keywords', s.keywords);
  const d = v.data;
  const hl = !!(s.keywords && s.keywords.highlighted);
  const hlBusy = !!ctx.ui.pending.hl;
  const toggle = h('label', { class: 'switch' },
    h('input', { type: 'checkbox', role: 'switch', checked: hl, disabled: hlBusy || !d,
      onchange: e => ctx.run('hl', 'keywords/highlight', { on: e.target.checked }) }),
    h('span', { class: 'track', 'aria-hidden': 'true' }),
    h('span', null, 'Highlight matches on page'));
  const body = [
    h('div', { class: 'row between' }, btn(v.loading ? 'Checking…' : 'Run check', () => ctx.run('keywords', 'keywords/run', {}), { class: 'primary', disabled: v.loading }), toggle),
    v.loading ? spinner('Reading page text…') : null,
    v.error ? errBox(v.error, s.keywords) : null,
    ctx.ui.errors.hl ? errBox(ctx.ui.errors.hl) : null,
    d ? result(d) : (!v.loading && !v.error ? h('p', { class: 'muted' }, 'Run the check to score this page for scam language.') : null),
    h('p', { class: 'disclaimer' }, 'Heuristic aid for triage, not a verdict. A high score does not prove a scam and a low score does not clear a site.'),
  ];
  return h('div', { class: 'stack' }, card('Content keywords', body));
}

function result(d) {
  const kind = BAND_KIND[d.band] || 'grey';
  const cats = d.categories || [];
  const max = Math.max(1, ...cats.map(c => c.points || 0));
  return h('div', { class: 'result' },
    h('div', { class: 'scorebox' },
      h('div', { class: 'score ' + kind, role: 'img', 'aria-label': `Score ${d.score} of 100` }, String(d.score), h('small', null, '/100')),
      h('div', null, badge(d.band, kind, { class: 'badge big ' + kind }),
        h('div', { class: 'muted small' }, d.cryptoContext ? 'Crypto context detected' : 'No crypto context detected'),
        h('div', { class: 'muted small' }, `${d.frames ?? '?'} frame(s), ${d.chars ?? '?'} chars`))),
    cats.length ? h('div', null, h('h4', null, 'Categories'),
      h('ul', { class: 'plain bars' }, cats.map(c => h('li', null,
        h('div', { class: 'barlabel' }, h('span', null, c.category), h('span', { class: 'muted' }, `${c.points} pts · ${c.hits} hit${c.hits === 1 ? '' : 's'}`)),
        h('div', { class: 'bar' }, (() => { const f = h('i'); f.style.width = Math.max(2, Math.round(((c.points || 0) / max) * 100)) + '%'; return f; })()))))) : null,
    (d.top || []).length ? h('div', null, h('h4', null, 'Top matched phrases'),
      h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, ['Phrase', 'Count', 'Wt', 'Pts'].map(t => h('th', { scope: 'col' }, t)))),
        h('tbody', null, d.top.slice(0, 15).map(t => h('tr', null,
          h('td', { title: t.category }, t.keyword), h('td', null, String(t.count)), h('td', null, String(t.weight)), h('td', null, String(t.points))))))) : null);
}
