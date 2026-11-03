import { h, spinner, btn, badge, errBox, toast } from '../ui.js';
import { matchAuthUrl, matchDepositUrl } from '../../lib/autofill/urlmatch.js';
import { DEFAULT_PROFILE, TEXT_FIELDS, formatCustom, parseCustom } from '../../lib/autofill/profile.js';
import { allowAllSites } from './settings.js';

const MAIN_FIELDS = [
  ['username', 'Username', {}],
  ['email', 'Email', { type: 'email', autocomplete: 'off' }],
  ['password', 'Password', {}],
  ['phone', 'Phone number', { type: 'tel', autocomplete: 'off' }],
  ['country', 'Country', { list: 'af-countries' }],
  ['depositAmount', 'Deposit amount', { inputmode: 'decimal', placeholder: '100' }],
];
const MORE_FIELDS = [
  ['firstName', 'First name'], ['lastName', 'Last name'], ['dob', 'Date of birth', { type: 'date' }],
  ['address', 'Street address'], ['city', 'City'], ['state', 'State / province'], ['zip', 'ZIP / postal code'],
];
const COUNTRY_HINTS = ['United States of America', 'United Kingdom', 'Canada', 'Australia', 'Germany', 'France', 'India', 'Nigeria', 'Singapore', 'South Africa'];

const KIND_LABEL = {
  username: 'Username', email: 'Email', password: 'Password', phone: 'Phone', country: 'Country', firstName: 'First name',
  lastName: 'Last name', amount: 'Deposit amount', dialcode: 'Dial code', fullName: 'Full name', dob: 'Birth date', address: 'Address', city: 'City', state: 'State', zip: 'ZIP', custom: 'Custom',
};
const STATUS_BADGE = { filled: ['filled', 'green'], 'would-fill': ['would fill', 'blue'], manual: ['pick manually', 'amber'], skipped: ['skipped', 'grey'] };

export async function loadAutofill(ctx) {
  const r = await ctx.run('afload', 'autofill/get', {});
  if (r.ok) ctx.autofill = r.data;
  ctx.render();
}

export function renderAutofill(ctx) {
  const ui = ctx.ui;
  if (!ctx.autofill) {
    if (!ui.pending.afload && !ui.errors.afload) loadAutofill(ctx);
    return h('div', { class: 'stack' }, ui.errors.afload ? errBox(ui.errors.afload) : spinner('Loading autofill…'));
  }
  return h('div', { class: 'stack' }, pageCard(ctx), profileCard(ctx), behaviorCard(ctx));
}

// ---------------------------------------------------------------- current page
function pageCard(ctx) {
  const ui = ctx.ui, s = ctx.state, af = ctx.autofill;
  const pageOk = s && s.page && s.page.kind === 'ok';
  const slot = s && s.autofill && s.autofill.status === 'done' ? s.autofill.data : null;
  const match = pageOk && s.url ? matchAuthUrl(s.url) : null;
  const busy = k => !!ui.pending['af:' + k];
  let status;
  if (!pageOk) status = badge('No page access', 'grey');
  else if (match) status = badge(`${match.kind === 'signup' ? 'Sign-up' : 'Login'} page (from URL)`, 'green');
  else if ((s.url && matchDepositUrl(s.url)) || (slot && slot.deposit)) status = badge('Deposit page', 'green');
  else if (slot && slot.detected) status = badge('Sign-up/login form detected', 'green');
  else status = badge('Not a sign-up/login page', 'grey');

  const filledN = slot ? slot.fields.filter(f => f.status === 'filled').length : 0;
  return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'This page'), status),
    h('div', { class: 'card-body' },
      h('div', { class: 'row wrapr' },
        btn(busy('fill') ? 'Filling…' : 'Fill now', async () => {
          const r = await ctx.run('af:fill', 'autofill/fill', {});
          if (r.ok) toast(r.data && r.data.fields.some(f => f.status === 'filled') ? 'Filled' : 'Nothing to fill on this page');
        }, { class: 'tiny primary', disabled: !pageOk || busy('fill') }),
        btn(busy('preview') ? 'Looking…' : 'Detect fields', () => ctx.run('af:preview', 'autofill/preview', {}), { class: 'tiny', disabled: !pageOk || busy('preview') }),
        btn('Undo', async () => {
          const r = await ctx.run('af:undo', 'autofill/undo', {});
          if (r.ok) toast(r.data.restored ? `Restored ${r.data.restored} field(s)` : 'Nothing to undo');
        }, { class: 'tiny', disabled: !pageOk || busy('undo') || !filledN })),
      h('div', { class: 'muted small' }, af.opts.onLoad
        ? 'Auto-fill runs only while this panel is open, and only on pages that look like sign-up or login.'
        : 'Auto-fill on load is off. Use Fill now.'),
      ui.errors['af:fill'] ? errBox(ui.errors['af:fill']) : null,
      ui.errors['af:preview'] ? errBox(ui.errors['af:preview']) : null,
      ui.errors['af:undo'] ? errBox(ui.errors['af:undo']) : null,
      slot ? resultView(slot) : null));
}

function resultView(d) {
  const rows = d.fields.filter(f => f.status);
  return h('div', null,
    h('h4', null, d.dryRun ? 'Detected fields (nothing was changed)' : 'Last fill'),
    !rows.length ? h('div', { class: 'muted small' }, 'No fillable fields found on this page.') : null,
    h('ul', { class: 'plain' }, rows.map(f => {
      const [txt, kind] = STATUS_BADGE[f.status] || [f.status, 'grey'];
      return h('li', { class: 'row between' },
        h('span', { class: 'grow wrap' }, KIND_LABEL[f.kind] || f.kind, ' ', h('span', { class: 'muted small mono' }, f.label)),
        h('span', { title: f.reason || '' }, badge(txt, kind)));
    })),
    d.terms ? h('div', { class: 'muted small' }, `Ticked ${d.terms} terms box(es).`) : null);
}

// ---------------------------------------------------------------- profile
function profileCard(ctx) {
  const ui = ctx.ui, p = ctx.autofill.profile;
  const val = k => (ui.inputs['af:' + k] !== undefined ? ui.inputs['af:' + k] : p[k]);
  const customVal = ui.inputs['af:custom'] !== undefined ? ui.inputs['af:custom'] : formatCustom(p.custom);
  const dirty = [...TEXT_FIELDS, 'dob'].some(k => ui.inputs['af:' + k] !== undefined && ui.inputs['af:' + k] !== p[k]) ||
    (ui.inputs['af:custom'] !== undefined && ui.inputs['af:custom'] !== formatCustom(p.custom));
  const showPw = !!ui.open['show:afpw'];
  const busy = k => !!ui.pending['af:' + k];

  // ctx.input records the value in ui.inputs but does not re-render, so the Save button's
  // disabled state (derived from ui.inputs) would stay stale until something else re-rendered
  // (e.g. toggling the extra fields). Re-render after each edit; renderNow keeps focus/caret.
  const tracked = (key, props, tag) => {
    const el = ctx.input(key, props, tag);
    const ev = tag === 'select' || props.type === 'checkbox' ? 'change' : 'input';
    el.addEventListener(ev, () => ctx.render());
    return el;
  };

  const field = ([k, label, props = {}]) => {
    const isPw = k === 'password';
    return h('div', { class: 'setrow' },
      h('label', { class: 'lbl', for: 'in-af:' + k }, label),
      h('div', { class: 'row' },
        tracked('af:' + k, { type: isPw ? (showPw ? 'text' : 'password') : (props.type || 'text'), class: 'input grow' + (isPw ? ' mono' : ''),
          value: val(k), autocomplete: 'off', spellcheck: 'false', onkeydown: e => { if (e.key === 'Enter') save(); }, ...props }),
        isPw ? h('button', { type: 'button', class: 'btn tiny', 'aria-pressed': String(showPw), onclick: () => { ui.open['show:afpw'] = !showPw; ctx.render(); } }, showPw ? 'Hide' : 'Show') : null));
  };

  async function save() {
    const profile = {};
    for (const k of [...TEXT_FIELDS, 'dob']) if (ui.inputs['af:' + k] !== undefined) profile[k] = ui.inputs['af:' + k];
    if (ui.inputs['af:custom'] !== undefined) profile.custom = parseCustom(ui.inputs['af:custom']);
    if (!Object.keys(profile).length) { toast('No changes to save'); return; }
    const r = await ctx.run('af:save', 'autofill/save', { profile });
    if (r.ok) {
      for (const k of Object.keys(ui.inputs)) if (k.startsWith('af:')) delete ui.inputs[k];
      ctx.autofill = r.data;
      toast('Profile saved');
    }
    ctx.render();
  }

  return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Profile'), dirty ? badge('unsaved', 'amber') : null),
    h('div', { class: 'card-body' },
      MAIN_FIELDS.map(field),
      h('datalist', { id: 'af-countries' }, COUNTRY_HINTS.map(c => h('option', { value: c }))),
      h('div', { class: 'row' }, btn(ui.open.afmore ? 'Hide extra fields' : 'Extra fields (name, address, birth date, custom)', () => { ui.open.afmore = !ui.open.afmore; ctx.render(); }, { class: 'tiny' })),
      ui.open.afmore ? h('div', null,
        MORE_FIELDS.map(field),
        h('div', { class: 'setrow' },
          h('label', { class: 'lbl', for: 'in-af:custom' }, 'Custom fields'),
          tracked('af:custom', { class: 'input mono', rows: '3', value: customVal, placeholder: 'referral = ABC123\nsecurity answer = blue', spellcheck: 'false' }, 'textarea'),
          h('div', { class: 'muted small' }, 'One per line as "label = value". Fills any field whose label, name or placeholder contains the label.'))) : null,
      h('div', { class: 'row wrapr' },
        btn(busy('save') ? 'Saving…' : 'Save profile', save, { class: 'tiny primary', disabled: busy('save') || !dirty }),
        ui.confirmAfReset
          ? h('span', { class: 'row' }, h('span', { class: 'small' }, 'Reset all fields?'),
            btn('Yes, reset', async () => {
              ui.confirmAfReset = false;
              for (const k of Object.keys(ui.inputs)) if (k.startsWith('af:')) delete ui.inputs[k];
              const r = await ctx.run('af:reset', 'autofill/reset', {});
              if (r.ok) { ctx.autofill = r.data; toast('Profile reset to defaults'); }
            }, { class: 'tiny danger' }),
            btn('Cancel', () => { ui.confirmAfReset = false; ctx.render(); }, { class: 'tiny' }))
          : btn('Reset to defaults', () => { ui.confirmAfReset = true; ctx.render(); }, { class: 'tiny' })),
      ui.errors['af:save'] ? errBox(ui.errors['af:save']) : null,
      ui.errors['af:reset'] ? errBox(ui.errors['af:reset']) : null,
      h('p', { class: 'muted small' }, 'Stored in plain text in this browser, like your API keys. Use throwaway details only, never a real password.'),
      h('p', { class: 'muted small' }, `Defaults: ${DEFAULT_PROFILE.username} · ${DEFAULT_PROFILE.email} · ${DEFAULT_PROFILE.phone}`)));
}

// ---------------------------------------------------------------- behavior
function behaviorCard(ctx) {
  const o = ctx.autofill.opts;
  const setOpt = async (key, on) => {
    const r = await ctx.run('af:opts', 'autofill/save', { opts: { [key]: on } });
    if (r.ok) ctx.autofill = r.data;
    ctx.render();
  };
  const toggle = (label, key, note) => h('div', { class: 'setrow' },
    h('label', { class: 'switch' },
      h('input', { type: 'checkbox', role: 'switch', checked: !!o[key], onchange: e => setOpt(key, e.target.checked) }),
      h('span', { class: 'track', 'aria-hidden': 'true' }), h('span', null, label)),
    note ? h('div', { class: 'muted small' }, note) : null);

  return h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Behavior')),
    h('div', { class: 'card-body' },
      toggle('Auto-fill on page load', 'onLoad', 'Only while this panel is open, on sign-up and login pages.'),
      o.onLoad && !ctx.ui.allSites ? h('div', { class: 'errbox amber', role: 'status' },
        'Auto-fill on load needs access to all sites. Without it, Fill now still works on the tab you opened the panel from.',
        h('div', null, btn('Allow on all sites', () => allowAllSites(ctx), { class: 'tiny primary' }))) : null,
      toggle('Also detect forms without a sign-up URL', 'domFallback', 'Treats any page with a visible password field as a sign-up/login page.'),
      toggle('Fill deposit amounts', 'depositFill', 'On deposit pages (URL or heading says deposit / top up), types the deposit amount into amount boxes, raised to the field\'s minimum. Never clicks Pay.'),
      toggle('Tag the email per site', 'siteTagEmail', 'example+shopx@example.com, so later spam traces back to the scam site. Some sites reject "+".'),
      toggle('Tag the username per site', 'siteTagUsername', 'username1202shopx. Falls back to the plain username if the field is too short.'),
      toggle('Outline filled fields', 'highlight'),
      toggle('Tick "I agree to the terms" boxes', 'checkTerms', 'Off by default. Marketing and newsletter boxes are never ticked. It never submits the form.'),
      ctx.ui.errors['af:opts'] ? errBox(ctx.ui.errors['af:opts']) : null));
}
