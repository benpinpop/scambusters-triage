// Autofill profile and options: defaults, validation and small helpers. Pure.

export const DEFAULT_PROFILE = Object.freeze({
  username: 'username1202',
  email: 'example@example.com',
  password: 'Password1*',
  phone: '2025550123',
  country: 'United States of America',
  firstName: '',
  lastName: '',
  dob: '',          // yyyy-mm-dd
  address: '',
  city: '',
  state: '',
  zip: '',
  depositAmount: '100',   // typed into amount boxes on deposit pages; raised to the field's minimum if needed
  custom: [],       // [{ label, value }]: fills any field whose label/name contains `label`
});

export const DEFAULT_OPTS = Object.freeze({
  onLoad: true,           // fill automatically when the panel is open and the page matches
  domFallback: true,      // also treat a page with a visible password field as a sign-up/login page
  siteTagEmail: false,    // example+shopx@example.com
  siteTagUsername: false, // username1202shopx
  depositFill: true,      // fill amount boxes on deposit pages
  highlight: true,        // outline filled fields
  checkTerms: false,      // tick "I agree to the terms" boxes
});

export const TEXT_FIELDS = ['username', 'email', 'password', 'phone', 'country', 'firstName', 'lastName', 'address', 'city', 'state', 'zip', 'depositAmount'];
export const OPT_KEYS = Object.keys(DEFAULT_OPTS);

const MAX_LEN = 200;
const MAX_CUSTOM = 20;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CTRL_RE = /[\u0000-\u001f\u007f]/;

/** "label = value" per line -> [{label, value}]. Lines without "=" are ignored. */
export function parseCustom(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i < 1) continue;
    const label = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (label && value) out.push({ label, value });
  }
  return out;
}

export function formatCustom(list) {
  return (Array.isArray(list) ? list : []).map(c => `${c.label} = ${c.value}`).join('\n');
}

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Merge `patch` over `base` and validate. Returns {ok:true, profile} or {ok:false, errors}.
 * Unknown keys are dropped. Empty strings are allowed (that field is simply not filled).
 */
export function sanitizeProfile(patch, base = DEFAULT_PROFILE) {
  const src = patch && typeof patch === 'object' ? patch : {};
  const p = { ...DEFAULT_PROFILE, ...base, custom: Array.isArray(base.custom) ? base.custom.slice() : [] };
  const errors = [];
  for (const k of [...TEXT_FIELDS, 'dob']) {
    if (!(k in src)) continue;
    let v = src[k];
    if (typeof v !== 'string') { errors.push(`${k} must be text.`); continue; }
    if (k !== 'password') v = v.trim();
    if (v.length > MAX_LEN) { errors.push(`${k} is longer than ${MAX_LEN} characters.`); continue; }
    if (CTRL_RE.test(v)) { errors.push(`${k} contains control characters.`); continue; }
    if (k === 'email' && v && !EMAIL_RE.test(v)) { errors.push('Email is not a valid address.'); continue; }
    if (k === 'phone' && v) {
      const digits = v.replace(/\D/g, '');
      if (!/^[+()\-.\s\d]+$/.test(v) || digits.length < 7 || digits.length > 15) { errors.push('Phone number needs 7 to 15 digits.'); continue; }
    }
    if (k === 'depositAmount' && v && (!/^\d{1,9}(\.\d{1,2})?$/.test(v) || Number(v) <= 0)) { errors.push('Deposit amount must be a positive number like 100 or 49.99.'); continue; }
    if (k === 'dob' && v && !validDate(v)) { errors.push('Date of birth must be a real date (yyyy-mm-dd).'); continue; }
    if (k === 'username' && /\s/.test(v)) { errors.push('Username cannot contain spaces.'); continue; }
    p[k] = v;
  }
  if ('custom' in src) {
    if (!Array.isArray(src.custom)) errors.push('Custom fields must be a list.');
    else {
      const list = [];
      for (const c of src.custom.slice(0, MAX_CUSTOM)) {
        const label = c && typeof c.label === 'string' ? c.label.trim() : '';
        const value = c && typeof c.value === 'string' ? c.value.trim() : '';
        if (!label || !value) continue;
        if (label.length > 40 || value.length > MAX_LEN || CTRL_RE.test(label + value)) { errors.push(`Custom field "${label.slice(0, 20)}" is too long or has control characters.`); continue; }
        list.push({ label, value });
      }
      if (src.custom.length > MAX_CUSTOM) errors.push(`At most ${MAX_CUSTOM} custom fields are kept.`);
      p.custom = list;
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, profile: p };
}

export function sanitizeOpts(patch, base = DEFAULT_OPTS) {
  const o = { ...DEFAULT_OPTS, ...base };
  const src = patch && typeof patch === 'object' ? patch : {};
  for (const k of OPT_KEYS) if (k in src) o[k] = !!src[k];
  return o;
}

/** Short lowercase tag for a hostname: "www.shop-x.co.uk" -> "shopx". Empty if none. */
export function siteTagOf(hostname) {
  let labels = String(hostname || '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (labels.length < 2 || /^\d+$/.test(labels[labels.length - 1])) return ''; // single label or IP
  labels.pop(); // TLD
  if (labels.length > 1 && /^(co|com|org|net|gov|edu|ac)$/.test(labels[labels.length - 1])) labels.pop();
  return labels[labels.length - 1].replace(/[^a-z0-9]/g, '').slice(0, 20);
}
