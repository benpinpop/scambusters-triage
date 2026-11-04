// Settings and API key storage. Keys live only in chrome.storage.local
// (never sync), are format-checked before saving, and are never logged or
// returned to the panel (only a masked preview).

import { SB_KEY_RE } from './scambusters.js';

export const SERVICES = ['scambusters', 'urlscan', 'blockchain', 'etherscan', 'tronscan'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Expected formats. Third-party formats are as observed/documented; see README assumptions. */
export const KEY_FORMATS = {
  scambusters: { re: SB_KEY_RE, hint: 'sb_ followed by 32 lowercase hex characters' },
  urlscan:     { re: UUID_RE, hint: 'a UUID like 0000aaaa-bb11-cc22-dd33-eeeeeeeeeeee' },
  blockchain:  { re: UUID_RE, hint: 'a UUID (Blockchain.com API code)' },
  etherscan:   { re: /^[A-Za-z0-9]{34}$/, hint: '34 letters/digits' },
  tronscan:    { re: UUID_RE, hint: 'a UUID (TRON-PRO-API-KEY)' },
};

export const DEFAULT_SETTINGS = {
  autoScan: false,
  autoOnchain: false,
  autoCheck: true,
  autoRdap: false,
  autoContent: false,
  urlscanVisibility: 'unlisted',
  allSites: false,
};

const SB_WARN_DAYS = 25;

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function setSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur };
  for (const k of ['autoScan', 'autoOnchain', 'autoCheck', 'autoRdap', 'autoContent', 'allSites']) if (k in patch) next[k] = !!patch[k];
  if ('urlscanVisibility' in patch && ['public', 'unlisted', 'private'].includes(patch.urlscanVisibility)) {
    next.urlscanVisibility = patch.urlscanVisibility;
  }
  await chrome.storage.local.set({ settings: next });
  return next;
}

async function rawKeys() {
  const { apiKeys } = await chrome.storage.local.get('apiKeys');
  return apiKeys || {};
}

/** Plaintext keys for worker-internal use only. Never send this object to the panel or a log. */
export async function getKeys() {
  const k = await rawKeys();
  const out = {};
  for (const s of SERVICES) out[s] = (k[s] && k[s].value) || '';
  return out;
}

function mask(v) {
  return v.length <= 8 ? '••••' : `${v.slice(0, 3)}…${v.slice(-4)}`;
}

export async function keysStatus() {
  const k = await rawKeys();
  const out = {};
  for (const s of SERVICES) {
    const e = k[s];
    if (!e || !e.value) { out[s] = { state: 'not_set' }; continue; }
    const valid = KEY_FORMATS[s].re.test(e.value);
    const ageDays = e.savedAt ? Math.floor((Date.now() - e.savedAt) / 86_400_000) : null;
    out[s] = { state: valid ? 'saved' : 'invalid', masked: mask(e.value), savedAt: e.savedAt, ageDays };
    if (s === 'scambusters' && ageDays != null && ageDays >= SB_WARN_DAYS) out[s].warn = true;
  }
  return out;
}

/** Validate and save. Returns {ok:true} or {ok:false, hint}. */
export async function saveKey(service, value) {
  if (!SERVICES.includes(service)) return { ok: false, hint: 'unknown service' };
  const v = String(value || '').replace(/[​-‏﻿]/g, '').trim();
  if (!KEY_FORMATS[service].re.test(v)) return { ok: false, hint: `Invalid format: expected ${KEY_FORMATS[service].hint}.` };
  const k = await rawKeys();
  k[service] = { value: v, savedAt: Date.now() };
  await chrome.storage.local.set({ apiKeys: k });
  return { ok: true };
}

export async function clearKey(service) {
  const k = await rawKeys();
  delete k[service];
  await chrome.storage.local.set({ apiKeys: k });
}
