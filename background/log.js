// Activity log (submits and checks), kept in chrome.storage.local. Never contains keys.

const MAX = 500;

export async function addLog(entry) {
  const { activityLog } = await chrome.storage.local.get('activityLog');
  const list = Array.isArray(activityLog) ? activityLog : [];
  list.push({ at: Date.now(), ...entry });
  while (list.length > MAX) list.shift();
  await chrome.storage.local.set({ activityLog: list });
}

export async function listLog() {
  const { activityLog } = await chrome.storage.local.get('activityLog');
  return (Array.isArray(activityLog) ? activityLog : []).slice().reverse();
}

export async function clearLog() {
  await chrome.storage.local.set({ activityLog: [] });
}

// Recent-submit guard: siteKey -> timestamp (local, survives worker restarts).
export const RECENT_SUBMIT_MS = 10 * 60_000;

export async function recentSubmitAt(siteKey) {
  const { recentSubmits } = await chrome.storage.local.get('recentSubmits');
  const at = recentSubmits && recentSubmits[siteKey];
  return at && Date.now() - at < RECENT_SUBMIT_MS ? at : null;
}

export async function markSubmitted(siteKey) {
  const { recentSubmits } = await chrome.storage.local.get('recentSubmits');
  const r = recentSubmits || {};
  const now = Date.now();
  for (const k of Object.keys(r)) if (now - r[k] > RECENT_SUBMIT_MS) delete r[k];
  r[siteKey] = now;
  await chrome.storage.local.set({ recentSubmits: r });
}
