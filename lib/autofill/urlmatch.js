// Decides whether a URL looks like a sign-up or login page. Pure: no DOM, no chrome.*.
// Matching is token-based (path segments, hash route, a few query parameters and a
// leading subdomain) so "/designing-your-home" is not mistaken for "sign in".

const SIGNUP_EXACT = new Set(['signup', 'register', 'registration', 'registrations', 'join', 'enroll', 'enrol', 'enrollment', 'onboarding', 'joinnow', 'joinus', 'joinfree', 'getstarted', 'createaccount', 'newaccount', 'newuser', 'newmember', 'openaccount']);
const LOGIN_EXACT = new Set(['login', 'logon', 'signin', 'signon', 'sso', 'auth', 'authenticate', 'authorize']);
// Adjacent tokens that only mean something together ("log" + "in").
const PAIRS = new Map([
  ['login', 'login'], ['logon', 'login'], ['signin', 'login'], ['signon', 'login'],
  ['signup', 'signup'], ['createaccount', 'signup'], ['newaccount', 'signup'], ['newuser', 'signup'],
  ['newmember', 'signup'], ['joinnow', 'signup'], ['joinus', 'signup'], ['joinfree', 'signup'],
  ['getstarted', 'signup'], ['openaccount', 'signup'], ['createanaccount', 'signup'],
]);
const SIGNUP_PREFIX = /^(signup|register|registration)/;
const LOGIN_PREFIX = /^(login|signin)/;
const GLUED_SUFFIX = /(login|signin|signup)$/;
const QUERY_KEYS = new Set(['action', 'mode', 'view', 'form', 'type', 'tab', 'step', 'page', 'screen', 'flow', 'do', 'op', 'task', 'route', 'p', 'a', 'm', 'screen_hint', 'intent']);
const SUBDOMAIN_OK = new Set(['login', 'signin', 'signup', 'register', 'auth', 'sso', 'join']);

function tokens(s) {
  let str = String(s || '');
  try { str = decodeURIComponent(str); } catch { /* keep raw */ }
  return str.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** 'signup' | 'login' | null for one list of tokens. */
function classifyTokens(toks) {
  let login = false;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const pair = i + 1 < toks.length ? t + toks[i + 1] : '';
    const trio = i + 2 < toks.length ? t + toks[i + 1] + toks[i + 2] : '';
    for (const joined of [t, pair, trio]) {
      if (!joined) continue;
      if (SIGNUP_EXACT.has(joined) || PAIRS.get(joined) === 'signup') return 'signup';
      if (LOGIN_EXACT.has(joined) || PAIRS.get(joined) === 'login') login = true;
    }
    if (SIGNUP_PREFIX.test(t)) return 'signup';
    if (/(signup)$/.test(t)) return 'signup';
    if (LOGIN_PREFIX.test(t) || GLUED_SUFFIX.test(t)) login = true;
  }
  return login ? 'login' : null;
}

/**
 * @returns {{kind:'signup'|'login', via:string}|null} via says which part of the URL matched.
 */
export function matchAuthUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  let best = null;
  const consider = (kind, via) => {
    if (!kind) return;
    if (!best || (kind === 'signup' && best.kind === 'login')) best = { kind, via };
  };

  for (const seg of u.pathname.split('/')) consider(classifyTokens(tokens(seg)), 'path');

  const hash = u.hash.replace(/^#!?\/?/, '');
  if (hash) {
    const [hp, hq] = hash.split('?');
    for (const seg of hp.split('/')) consider(classifyTokens(tokens(seg)), 'hash');
    if (hq) consider(queryKind(new URLSearchParams(hq)), 'hash');
  }

  consider(queryKind(u.searchParams), 'query');

  const labels = u.hostname.split('.');
  if (labels.length >= 3 && SUBDOMAIN_OK.has(labels[0].toLowerCase())) {
    consider(classifyTokens(tokens(labels[0])), 'subdomain');
  }
  return best;
}

const DEPOSIT_EXACT = new Set(['deposit', 'deposits', 'depositfunds', 'makedeposit', 'adddeposit', 'newdeposit', 'addfunds', 'addmoney', 'fundaccount', 'fundwallet', 'topup', 'recharge', 'payin']);
const DEPOSIT_PAIRS = new Set(['topup', 'addfunds', 'addmoney', 'fundaccount', 'fundwallet', 'makedeposit', 'adddeposit', 'newdeposit', 'depositfunds', 'payin']);
const DEPOSIT_QUERY_KEYS = new Set([...QUERY_KEYS, 'section', 'menu', 'module', 'method']);

function isDepositTokens(toks) {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const pair = i + 1 < toks.length ? t + toks[i + 1] : '';
    if (DEPOSIT_EXACT.has(t) || DEPOSIT_PAIRS.has(pair)) return true;
    if (/^deposit(page|form|now|method|address)$/.test(t) || /deposit$/.test(t)) return true; // depositpage, usdtdeposit (not "depositary")
  }
  return false;
}

/**
 * Does this URL look like a deposit / top-up page?
 * @returns {{via:string}|null}
 */
export function matchDepositUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  for (const seg of u.pathname.split('/')) if (isDepositTokens(tokens(seg))) return { via: 'path' };
  const hash = u.hash.replace(/^#!?\/?/, '');
  if (hash) {
    const [hp, hq] = hash.split('?');
    for (const seg of hp.split('/')) if (isDepositTokens(tokens(seg))) return { via: 'hash' };
    if (hq) for (const [k, v] of new URLSearchParams(hq)) if (isDepositTokens(tokens(k)) || (DEPOSIT_QUERY_KEYS.has(k.toLowerCase()) && isDepositTokens(tokens(v)))) return { via: 'hash' };
  }
  for (const [k, v] of u.searchParams) {
    if ((!v || v === 'true' || v === '1') && isDepositTokens(tokens(k))) return { via: 'query' };
    if (DEPOSIT_QUERY_KEYS.has(k.toLowerCase()) && isDepositTokens(tokens(v))) return { via: 'query' };
  }
  const first = u.hostname.split('.');
  if (first.length >= 3 && isDepositTokens(tokens(first[0]))) return { via: 'subdomain' };
  return null;
}

function queryKind(params) {
  let kind = null;
  for (const [k, v] of params) {
    const fromKey = !v || v === 'true' || v === '1' ? classifyTokens(tokens(k)) : null;
    const fromVal = QUERY_KEYS.has(k.toLowerCase()) ? classifyTokens(tokens(v)) : null;
    for (const c of [fromKey, fromVal]) {
      if (c === 'signup') return 'signup';
      if (c) kind = c;
    }
  }
  return kind;
}
