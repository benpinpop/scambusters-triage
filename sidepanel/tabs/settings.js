import { h, spinner, btn, badge, errBox, linkBtn, toast } from '../ui.js';

const SB_RE = /^sb_[0-9a-f]{32}$/;
const SERVICES = [
  { id: 'scambusters', name: 'ScamBusters', hint: 'Format: sb_ followed by 32 lowercase hex characters.', placeholder: 'sb_…',
    get: h('span', { class: 'muted' }, 'Get one with /get-api-key in the ScamBusters Discord.'), testLabel: 'Test (runs a check on example.com)' },
  { id: 'urlscan', name: 'URLScan', url: 'https://urlscan.io/user/profile/', linkLabel: 'Get a URLScan key' },
  { id: 'blockchain', name: 'Blockchain.com (optional)', url: 'https://www.blockchain.com/explorer/api/api_create_code', linkLabel: 'Get a Blockchain.com key' },
  { id: 'etherscan', name: 'Etherscan', url: 'https://etherscan.io/myapikey', linkLabel: 'Get an Etherscan key' },
  { id: 'tronscan', name: 'Tronscan', url: 'https://tronscan.org/#/myaccount/apiKeys', linkLabel: 'Get a Tronscan key' },
];

export async function refreshAllSites(ctx) {
  try { ctx.ui.allSites = await globalThis.chrome.permissions.contains({ origins: ['<all_urls>'] }); }
  catch { ctx.ui.allSites = false; }
  ctx.render();
}

/** Must be called synchronously from a click handler. */
export function allowAllSites(ctx) {
  let p;
  try { p = globalThis.chrome.permissions.request({ origins: ['<all_urls>'] }); }
  catch (e) { toast('Permission request failed: ' + e.message, 'err'); return Promise.resolve(false); }
  return p.then(async granted => {
    if (!granted) { toast('Permission was not granted', 'err'); return false; }
    ctx.ui.allSites = true;
    try { await ctx.call('settings/set', { patch: { allSites: true } }); } catch (e) { toast(e.message, 'err'); }
    ctx.call('scan/run', {}).catch(() => {});
    ctx.render();
    return true;
  });
}

export function renderSettings(ctx) {
  const st = ctx.settings || {};
  const set = patch => ctx.run('settings', 'settings/set', { patch });
  const toggle = (label, key, note, onChange) => h('div', { class: 'setrow' },
    h('label', { class: 'switch' },
      h('input', { type: 'checkbox', role: 'switch', checked: !!st[key], onchange: onChange || (e => set({ [key]: e.target.checked })) }),
      h('span', { class: 'track', 'aria-hidden': 'true' }), h('span', null, label)),
    note ? h('div', { class: 'muted small' }, note) : null);
  return h('div', { class: 'stack' },
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Behavior')),
      h('div', { class: 'card-body' },
        toggle('Auto-scan on page load', 'autoScan', 'Needs access to all sites.', e => {
          const on = e.target.checked, box = e.target;
          if (!on) { set({ autoScan: false }); return; }
          let p;
          try { p = globalThis.chrome.permissions.request({ origins: ['<all_urls>'] }); } catch (er) { box.checked = false; toast(er.message, 'err'); return; }
          p.then(granted => {
            if (!granted) { box.checked = false; toast('Permission denied, auto-scan stays off', 'err'); return; }
            ctx.ui.allSites = true;
            set({ autoScan: true, allSites: true });
          });
        }),
        toggle('Auto-run on-chain lookup when wallets are found', 'autoOnchain', 'Off by default: lookups use the free-tier rate limits of the explorer APIs.'),
        toggle('Auto-check ScamBusters status on open', 'autoCheck'),
        toggle('Auto-run content keyword check on open', 'autoContent'),
        toggle('Auto-run RDAP domain lookup', 'autoRdap', 'Once per domain; the result is cached and not repeated when the URL changes. Needs the panel open.'),
        h('div', { class: 'setrow' }, h('label', { class: 'lbl inline', for: 'in-set-vis' }, 'URLScan default visibility'),
          ctx.input('set-vis', { value: st.urlscanVisibility || 'unlisted', class: 'input mini2', onchange: e => set({ urlscanVisibility: e.target.value }) }, 'select',
            ['public', 'unlisted', 'private'].map(o => h('option', { value: o }, o)))),
        h('div', { class: 'setrow' },
          h('div', null, 'Access to all sites: ', ctx.ui.allSites ? badge('allowed', 'green') : badge('not allowed', 'grey')),
          h('div', { class: 'row' },
            ctx.ui.allSites ? btn('Revoke', async () => {
              try { await globalThis.chrome.permissions.remove({ origins: ['<all_urls>'] }); } catch (e) { toast(e.message, 'err'); }
              await set({ allSites: false, autoScan: false });
              refreshAllSites(ctx);
            }, { class: 'tiny' }) : btn('Allow on all sites', () => allowAllSites(ctx), { class: 'tiny primary' }),
            btn('Re-check', () => refreshAllSites(ctx), { class: 'tiny' }))),
        ctx.ui.errors.settings ? errBox(ctx.ui.errors.settings) : null)),
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'API keys')),
      h('div', { class: 'card-body keys' }, SERVICES.map(s => keyBlock(ctx, s)),
        h('p', { class: 'muted small' }, 'Keys are stored locally in this browser (chrome.storage.local) and are only sent to their own service.'))));
}

function statusLine(k) {
  if (!k || k.state === 'not_set') return h('span', { class: 'muted' }, 'Not set');
  if (k.state === 'invalid') return h('span', { class: 'errtxt' }, 'Invalid format');
  const age = k.ageDays == null ? '' : k.ageDays === 0 ? ' · saved today' : ` · saved ${k.ageDays} day${k.ageDays === 1 ? '' : 's'} ago`;
  return h('span', { class: 'oktxt' }, `Saved (${k.masked || '…'})${age}`);
}

function keyBlock(ctx, s) {
  const ui = ctx.ui, id = s.id;
  const k = (ctx.keys || {})[id];
  const show = !!ui.open['show:' + id];
  const busy = n => !!ui.pending[`key:${id}:${n}`];
  const msg = ui.keyMsg[id];
  const save = async () => {
    const val = (ui.inputs['key:' + id] || '').trim();
    if (!val) { ui.keyMsg[id] = { ok: false, text: 'Enter a key first.' }; ctx.render(); return; }
    if (id === 'scambusters' && !SB_RE.test(val)) { ui.keyMsg[id] = { ok: false, text: 'Invalid format. Expected sb_ followed by 32 lowercase hex characters.' }; ctx.render(); return; }
    const r = await ctx.run(`key:${id}:save`, 'keys/save', { service: id, value: val });
    if (r.ok) { ui.inputs['key:' + id] = ''; ui.keyMsg[id] = { ok: true, text: 'Saved.' }; if (r.data && r.data.keys) ctx.keys = r.data.keys; }
    else ui.keyMsg[id] = { ok: false, text: r.error.message, guidance: r.error.guidance };
    ctx.render();
  };
  return h('div', { class: 'keyblock' },
    h('div', { class: 'row between' }, h('label', { class: 'lbl', for: 'in-key:' + id }, s.name), statusLine(k)),
    k && k.warn ? h('div', { class: 'errbox amber', role: 'alert' },
      `Key is ${k.ageDays} days old; ScamBusters keys expire after 30 days, rotate with /rotate-api-key in Discord.`) : null,
    h('div', { class: 'row' },
      ctx.input('key:' + id, { type: show ? 'text' : 'password', class: 'input grow mono', placeholder: s.placeholder || 'API key', autocomplete: 'off', spellcheck: 'false',
        'aria-label': s.name + ' API key', onkeydown: e => { if (e.key === 'Enter') save(); } }),
      h('button', { type: 'button', class: 'btn tiny', 'aria-pressed': String(show), onclick: () => { ui.open['show:' + id] = !show; ctx.render(); } }, show ? 'Hide' : 'Show')),
    s.hint ? h('div', { class: 'muted small' }, s.hint) : null,
    h('div', { class: 'row wrapr' },
      btn(busy('save') ? 'Saving…' : 'Save', save, { class: 'tiny primary', disabled: busy('save') }),
      btn('Clear', async () => {
        const r = await ctx.run(`key:${id}:clear`, 'keys/clear', { service: id });
        ui.keyMsg[id] = r.ok ? { ok: true, text: 'Cleared.' } : { ok: false, text: r.error.message };
        ctx.render();
      }, { class: 'tiny', disabled: busy('clear') || !k || k.state === 'not_set' }),
      btn(busy('test') ? 'Testing…' : (s.testLabel || 'Test'), async () => {
        const r = await ctx.run(`key:${id}:test`, 'keys/test', { service: id });
        ui.keyMsg[id] = r.ok ? { ok: true, text: (r.data && r.data.message) || 'OK' } : { ok: false, text: r.error.message, guidance: r.error.guidance };
        ctx.render();
      }, { class: 'tiny', disabled: busy('test') || !k || k.state !== 'saved' }),
      s.url ? linkBtn(s.linkLabel, s.url) : s.get),
    (busy('save') || busy('test') || busy('clear')) ? spinner('Working…') : null,
    msg ? h('div', { class: msg.ok ? 'oktxt small' : 'errtxt small', role: 'status' }, msg.text, msg.guidance ? ' ' + msg.guidance : '') : null);
}
