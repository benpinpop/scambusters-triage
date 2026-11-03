// Autofill profile storage. Lives only in chrome.storage.local (never sync). The profile is
// plaintext throwaway data, like the API keys; it is sent only to a tab that matched a
// sign-up/login page and is never written to the activity log.

import { DEFAULT_PROFILE, DEFAULT_OPTS, sanitizeProfile, sanitizeOpts } from '../lib/autofill/profile.js';
import { ServiceError } from '../lib/errors.js';

const KEY = 'autofill';

async function raw() {
  const { autofill } = await chrome.storage.local.get(KEY);
  return autofill && typeof autofill === 'object' ? autofill : {};
}

export async function getAutofill() {
  const a = await raw();
  const p = sanitizeProfile(a.profile || {}, DEFAULT_PROFILE);
  return { profile: p.ok ? p.profile : { ...DEFAULT_PROFILE, custom: [] }, opts: sanitizeOpts(a.opts || {}) };
}

/** Validate and save a partial profile and/or partial options. */
export async function saveAutofill(patch = {}) {
  const cur = await getAutofill();
  let profile = cur.profile;
  if (patch.profile) {
    const r = sanitizeProfile(patch.profile, cur.profile);
    if (!r.ok) throw new ServiceError('invalid_profile', 'Some profile values were not saved.', { details: r.errors });
    profile = r.profile;
  }
  const opts = patch.opts ? sanitizeOpts(patch.opts, cur.opts) : cur.opts;
  await chrome.storage.local.set({ [KEY]: { profile, opts } });
  return { profile, opts };
}

export async function resetAutofillProfile() {
  const cur = await getAutofill();
  await chrome.storage.local.set({ [KEY]: { profile: { ...DEFAULT_PROFILE, custom: [] }, opts: cur.opts } });
  return getAutofill();
}

export { DEFAULT_PROFILE, DEFAULT_OPTS };
