// Wallet address validation for all 15 ScamBusters chains.
//
// Rules are adapted from the user's `wallet_validation` package
// (github.com/benpinpop/urlscan-dashboard, ported from the ScamHunt CTF,
// Python, stdlib-only) and extended to the extension spec:
//   - DOGE 0x16 ("9"/"A") and DASH 0x10 ("7") version bytes
//   - XRP X-addresses decoded into classic address + destination tag (XLS-5d)
//   - SOL accepted with low confidence ("unverified": no checksum exists)
//   - LTC 0x05 ("3...") is valid only when the user explicitly picks ltc;
//     auto-detection treats it as BTC (spec: "BTC unless it validates under
//     another chain's version byte")
//   - legacy 1.../3... strings are BTC; an explicit `bch` choice converts them
//     to CashAddr (as the Python package does)
//
// All functions are pure and synchronous so they run in the service worker
// and in Node tests.

import { base58CheckDecode, base58CheckEncode, base58Decode, BTC_ALPHABET, XRP_ALPHABET } from './base58.js';
import { bech32Decode, convertBits, decodeSegwit, CHARSET } from './bech32.js';
import { decodeCashAddr } from './cashaddr.js';
import { validateEvm, toChecksumAddress } from './evm.js';
import { canonicalChain, EVM_CHAINS, isEvmChain, suggestEvmChain, CHAINS } from '../chains.js';

export { toChecksumAddress, base58CheckEncode, base58CheckDecode, base58Decode, BTC_ALPHABET, XRP_ALPHABET };

/** Back-compat helper named in DESIGN/fixture work: encode version byte + payload. */
export function encodeBase58Check(version, payload, alphabet = BTC_ALPHABET) {
  return base58CheckEncode(version, payload, alphabet);
}

// Zero-width / invisible characters stripped before validation.
const INVISIBLE_RE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;

/** Trim, strip zero-width/invisible characters and surrounding quotes/punctuation. */
export function cleanInput(s) {
  if (typeof s !== 'string') return '';
  return s.replace(INVISIBLE_RE, '').trim().replace(/^[\s"'`<(\[]+|[\s"'`>)\].,;:!?]+$/g, '');
}

// Base58Check version byte -> chain + human kind (for auto-detection).
const B58_VERSIONS = {
  0x00: ['btc', 'P2PKH (legacy)'],
  0x05: ['btc', 'P2SH'],
  0x41: ['trx', 'Base58Check (0x41)'],
  0x30: ['ltc', 'P2PKH (L…)'],
  0x32: ['ltc', 'P2SH (M…)'],
  0x1e: ['doge', 'P2PKH (D…)'],
  0x16: ['doge', 'P2SH (9…/A…)'],
  0x4c: ['dash', 'P2PKH (X…)'],
  0x10: ['dash', 'P2SH (7…)'],
};

// Per-chain allowed version bytes when the chain is given explicitly.
const CHAIN_VERSIONS = {
  btc:  { 0x00: 'P2PKH (legacy)', 0x05: 'P2SH' },
  ltc:  { 0x30: 'P2PKH (L…)', 0x32: 'P2SH (M…)', 0x05: 'P2SH (legacy 3…, shared with BTC)' },
  doge: { 0x1e: 'P2PKH (D…)', 0x16: 'P2SH (9…/A…)' },
  dash: { 0x4c: 'P2PKH (X…)', 0x10: 'P2SH (7…)' },
  trx:  { 0x41: 'Base58Check (0x41)' },
};
const PREFIX_HINT = { btc: '1, 3 or bc1', ltc: 'L, M, 3 or ltc1', doge: 'D, 9 or A', dash: 'X or 7', trx: 'T' };

const FAMILY = {
  btc: 'btc', eth: 'evm', bsc: 'evm', matic: 'evm', arb: 'evm', avax: 'evm', op: 'evm',
  trx: 'trx', xrp: 'xrp', ltc: 'ltc', doge: 'doge', dash: 'dash', bch: 'bch', ada: 'ada', sol: 'sol',
};

const XRP_CLASSIC_RE = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const XRP_X_RE = /^[X][1-9A-HJ-NP-Za-km-z]{46}$/;
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BARE_CASHADDR_RE = /^[qp][qpzry9x8gf2tvdw0s3jn54khce6mua7l]{41}$/;
export const XRP_DEST_TAG_MAX = 4294967295;

function fail(reason, chainGuess = null) {
  return { ok: false, reason, chainGuess };
}

function ok(chain, address, normalized, validation, kind, extra = {}) {
  return { ok: true, chain, address, normalized, validation, kind, family: FAMILY[chain], ...extra };
}

// ------------------------------------------------------------------ per chain

function b58Versions(chain, addr) {
  if (!B58_RE.test(addr)) return fail(`expected a Base58 address starting with ${PREFIX_HINT[chain]}`);
  const d = base58CheckDecode(addr, BTC_ALPHABET);
  if (!d.ok) {
    return fail(d.reason === 'checksum'
      ? 'Base58Check checksum mismatch (typo or fake address)'
      : 'not a valid Base58Check string');
  }
  if (d.bytes.length !== 21) return fail(`wrong decoded length (${d.bytes.length} bytes, expected 21)`);
  const kind = CHAIN_VERSIONS[chain][d.bytes[0]];
  if (!kind) {
    const other = B58_VERSIONS[d.bytes[0]];
    return fail(`wrong version byte 0x${d.bytes[0].toString(16).padStart(2, '0')}: expected an address starting with ${PREFIX_HINT[chain]}`
      + (other ? `; it looks like a ${CHAINS[other[0]].name} address` : ''), other ? other[0] : null);
  }
  return ok(chain, addr, addr, 'checksum', kind);
}

function validateBtc(addr) {
  if (/^bc1/i.test(addr)) {
    const s = decodeSegwit('bc', addr);
    if (!s.ok) return fail(s.reason);
    const lower = addr.toLowerCase();
    return ok('btc', lower, lower, 'checksum', s.kind);
  }
  return b58Versions('btc', addr);
}

function validateLtc(addr) {
  if (/^ltc1/i.test(addr)) {
    const s = decodeSegwit('ltc', addr);
    if (!s.ok) return fail(s.reason);
    const lower = addr.toLowerCase();
    return ok('ltc', lower, lower, 'checksum', s.kind);
  }
  return b58Versions('ltc', addr);
}

function validateTrx(addr) {
  if (addr.length !== 34 || addr[0] !== 'T') return fail('Tron addresses are 34 characters starting with T');
  return b58Versions('trx', addr);
}

function validateBch(addr) {
  const lower = addr.toLowerCase();
  if (lower.startsWith('bitcoincash:') || BARE_CASHADDR_RE.test(lower)) {
    const c = decodeCashAddr(addr);
    if (!c.ok) return fail(c.reason);
    const canonical = 'bitcoincash:' + c.normalized;
    return ok('bch', canonical, canonical, 'checksum', `CashAddr ${c.type}`);
  }
  if (B58_RE.test(addr) && /^[13]/.test(addr)) {
    const d = base58CheckDecode(addr, BTC_ALPHABET);
    if (!d.ok) return fail('Base58Check checksum mismatch (typo or fake address)');
    if (d.bytes.length !== 21 || (d.bytes[0] !== 0x00 && d.bytes[0] !== 0x05)) return fail('wrong version byte for a legacy address');
    const canonical = cashAddrEncode(d.bytes[0] === 0x00 ? 0 : 1, d.bytes.subarray(1));
    return ok('bch', canonical, canonical, 'checksum', 'Legacy (converted to CashAddr)');
  }
  return fail('expected bitcoincash:q…/p…, a bare q…/p… CashAddr, or a legacy 1…/3… address');
}

function validateAda(addr) {
  if (!/^addr1/i.test(addr)) {
    if (/^(addr_test1|stake1|stake_test1)/i.test(addr)) return fail('only mainnet Shelley payment addresses (addr1…) are accepted');
    if (/^(Ae2|DdzFf)/.test(addr)) return fail('Byron-era addresses are not supported; use the Shelley addr1… address');
    return fail('expected a mainnet Shelley address starting with addr1');
  }
  // CIP-19 addresses exceed BIP-173's 90-char limit.
  const d = bech32Decode(addr, 1023);
  if (!d.ok) return fail(d.reason);
  if (d.hrp !== 'addr' || d.encoding !== 'bech32') return fail('invalid Cardano Bech32 prefix or variant');
  const payload = convertBits(d.data, 5, 8, false);
  if (!payload || !payload.length) return fail('invalid Bech32 payload');
  const type = payload[0] >> 4, network = payload[0] & 0x0f;
  if (network !== 1) return fail('not a mainnet address');
  if (type > 7) return fail('not a payment address');
  const expected = { 0: 57, 1: 57, 2: 57, 3: 57, 6: 29, 7: 29 };
  if (type in expected && payload.length !== expected[type]) return fail(`wrong length for Shelley type ${type} (${payload.length} bytes)`);
  if ((type === 4 || type === 5) && payload.length < 32) return fail('pointer address too short');
  const kinds = ['base', 'base', 'base', 'base', 'pointer', 'pointer', 'enterprise', 'enterprise'];
  const lower = addr.toLowerCase();
  return ok('ada', lower, lower, 'checksum', `Shelley ${kinds[type]} (CIP-19)`);
}

/** Decode an XLS-5d X-address (mainnet only) into { classic, tag|null }. */
export function decodeXAddress(addr) {
  if (!XRP_X_RE.test(addr)) return fail('not an X-address');
  const d = base58CheckDecode(addr, XRP_ALPHABET);
  if (!d.ok) return fail(d.reason === 'checksum' ? 'X-address checksum mismatch' : 'invalid X-address encoding');
  const b = d.bytes;
  if (b.length !== 31) return fail('invalid X-address length');
  if (b[0] === 0x04 && b[1] === 0x93) return fail('testnet X-address');
  if (b[0] !== 0x05 || b[1] !== 0x44) return fail('unknown X-address prefix');
  const flag = b[22];
  if (flag > 1) return fail('unsupported X-address tag flag (64-bit tags are not used)');
  const tag = b[23] | (b[24] << 8) | (b[25] << 16) | (b[26] * 0x1000000);
  for (let i = 27; i < 31; i++) if (b[i] !== 0) return fail('reserved X-address bytes are not zero');
  if (flag === 0 && tag !== 0) return fail('X-address has a tag value but no tag flag');
  const classic = base58CheckEncode(0x00, b.subarray(2, 22), XRP_ALPHABET);
  return { ok: true, classic, tag: flag ? String(tag >>> 0) : null };
}

function validateXrp(addr) {
  if (XRP_X_RE.test(addr)) {
    const x = decodeXAddress(addr);
    if (!x.ok) return fail(x.reason);
    return ok('xrp', x.classic, x.classic, 'checksum', 'X-address (decoded to classic)', { xrpDestTag: x.tag || '', fromXAddress: addr });
  }
  if (!XRP_CLASSIC_RE.test(addr)) return fail('expected a classic XRP Ledger address starting with r');
  const d = base58CheckDecode(addr, XRP_ALPHABET);
  if (!d.ok) return fail(d.reason === 'checksum' ? 'Base58Check checksum mismatch (XRPL alphabet)' : 'invalid XRPL Base58 string');
  if (d.bytes.length !== 21 || d.bytes[0] !== 0x00) return fail('wrong version byte: expected an account address starting with r');
  return ok('xrp', addr, addr, 'checksum', 'Classic address (Base58Check, XRPL alphabet)');
}

function validateSol(addr) {
  if (!B58_RE.test(addr) || addr.length < 32 || addr.length > 44) return fail('Solana addresses are 32–44 Base58 characters');
  const bytes = base58Decode(addr, BTC_ALPHABET);
  if (!bytes || bytes.length !== 32) return fail(`does not decode to a 32-byte public key (got ${bytes ? bytes.length : 0})`);
  // Solana addresses carry no checksum, so this is a format check only.
  return ok('sol', addr, addr, 'unverified', 'Base58 32-byte key (no checksum exists)');
}

function validateEvmChain(chain, addr) {
  if (/^x-avax1/i.test(addr)) {
    if (chain !== 'avax') return fail('Avalanche X-Chain address; choose avax', 'avax');
    const d = bech32Decode(addr.slice(2), 90);
    const prog = d.ok ? convertBits(d.data, 5, 8, false) : null;
    if (!d.ok || d.hrp !== 'avax' || d.encoding !== 'bech32' || !prog || prog.length !== 20) return fail(d.ok ? 'invalid X-Chain address' : d.reason);
    const canonical = 'X-' + addr.slice(2).toLowerCase();
    return { ...ok('avax', canonical, canonical, 'checksum', 'Avalanche X-Chain (Bech32)'), family: 'avax-x' };
  }
  const r = validateEvm(addr);
  if (!r.ok) return fail(r.reason);
  // Submit the EIP-55 form; dedupe on lowercase.
  return ok(chain, r.checksummed, r.normalized, r.validation, r.kind);
}

const VALIDATORS = {
  btc: validateBtc, ltc: validateLtc, trx: validateTrx, bch: validateBch, ada: validateAda,
  xrp: validateXrp, sol: validateSol,
  doge: a => b58Versions('doge', a), dash: a => b58Versions('dash', a),
};

// ------------------------------------------------------------------ detection

/**
 * Guess the chain from the address format alone.
 * @returns {{chain: string|null, candidates: string[], note: string}}
 */
export function detectChain(input) {
  const a = cleanInput(input);
  if (!a) return { chain: null, candidates: [], note: '' };
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return { chain: 'eth', candidates: [...EVM_CHAINS], note: '0x addresses look identical on every EVM chain; pick the network the site uses.' };
  const l = a.toLowerCase();
  if (l.startsWith('x-avax1')) return { chain: 'avax', candidates: ['avax'], note: 'Avalanche X-Chain address' };
  if (l.startsWith('bc1')) return { chain: 'btc', candidates: ['btc'], note: '' };
  if (l.startsWith('ltc1')) return { chain: 'ltc', candidates: ['ltc'], note: '' };
  if (l.startsWith('addr1')) return { chain: 'ada', candidates: ['ada'], note: '' };
  if (l.startsWith('bitcoincash:') || BARE_CASHADDR_RE.test(l)) return { chain: 'bch', candidates: ['bch'], note: '' };
  if (XRP_CLASSIC_RE.test(a) || XRP_X_RE.test(a)) {
    // r... is unique to XRP among supported chains. 47-char X... could only be an X-address.
    if (XRP_X_RE.test(a) || base58CheckDecode(a, XRP_ALPHABET).ok || !base58CheckDecode(a, BTC_ALPHABET).ok) {
      return { chain: 'xrp', candidates: ['xrp'], note: '' };
    }
  }
  if (B58_RE.test(a)) {
    const d = base58CheckDecode(a, BTC_ALPHABET);
    if (d.ok && d.bytes.length === 21 && B58_VERSIONS[d.bytes[0]]) {
      const chain = B58_VERSIONS[d.bytes[0]][0];
      return { chain, candidates: chain === 'btc' ? ['btc', 'bch', ...(d.bytes[0] === 0x05 ? ['ltc'] : [])] : [chain], note: chain === 'btc' ? 'Legacy format is shared by Bitcoin and Bitcoin Cash (and Litecoin for 3…).' : '' };
    }
    const first = { '1': 'btc', '3': 'btc', T: 'trx', L: 'ltc', M: 'ltc', D: 'doge', X: 'dash' }[a[0]];
    if (first && a.length >= 26 && a.length <= 35) return { chain: first, candidates: [first], note: '' };
    const raw = base58Decode(a, BTC_ALPHABET);
    if (raw && raw.length === 32 && a.length >= 32 && a.length <= 44) return { chain: 'sol', candidates: ['sol'], note: 'Looks like a Solana key (no checksum; low confidence).' };
  }
  return { chain: null, candidates: [], note: '' };
}

/**
 * Validate an address, optionally for a specific chain.
 * @param {string} input   raw address (cleaned here)
 * @param {string} [chainHint] canonical code or alias; omit/'auto' to detect
 * @returns {{ok:true, chain, address, normalized, validation, kind, family, ambiguousEvm?, xrpDestTag?}
 *          | {ok:false, reason, chainGuess}}
 */
export function validateAddress(input, chainHint) {
  const a = cleanInput(input);
  if (!a) return fail('enter a wallet address');
  if (/\s/.test(a)) return fail('the address contains spaces');
  if (a.length > 128) return fail('too long to be a wallet address');
  if (/^[=+\-@\t\r]/.test(a)) return fail('addresses cannot start with = + - @ (CSV-injection guard)');

  let chain = null;
  if (chainHint && chainHint !== 'auto') {
    chain = canonicalChain(chainHint);
    if (!chain) return fail(`unsupported chain '${chainHint}'`);
  }
  const det = detectChain(a);
  if (!chain) {
    if (!det.chain) return fail('unrecognized address format for all supported chains');
    chain = det.chain;
    const r = isEvmChain(chain) ? validateEvmChain(chain, a) : VALIDATORS[chain](a);
    if (r.ok && isEvmChain(chain) && r.family === 'evm') r.ambiguousEvm = true;
    if (!r.ok) r.chainGuess = r.chainGuess || chain;
    return r;
  }
  const r = isEvmChain(chain) ? validateEvmChain(chain, a) : VALIDATORS[chain](a);
  if (!r.ok) {
    const name = CHAINS[chain].name;
    let reason = `Not a valid ${name} address: ${r.reason}`;
    if (det.chain && !det.candidates.includes(chain) && !r.chainGuess) reason += `. It looks like a ${CHAINS[det.chain].name} address`;
    return fail(reason, r.chainGuess || det.chain);
  }
  return r;
}

/** Validate an XRP destination tag: '' (none) or an unsigned 32-bit integer. */
export function validateDestTag(raw) {
  const t = String(raw ?? '').trim();
  if (t === '') return { ok: true, tag: '' };
  if (!/^\d{1,10}$/.test(t)) return { ok: false, reason: 'a destination tag is a whole number (digits only)' };
  const v = Number(t);
  if (v > XRP_DEST_TAG_MAX) return { ok: false, reason: `a destination tag is at most ${XRP_DEST_TAG_MAX}` };
  return { ok: true, tag: String(v) };
}

// ------------------------------------------------------- page candidate triage

const SOL_CONTEXT_RE = /\b(solana|sol|spl|phantom|solflare|raydium)\b/i;

/**
 * Classify a candidate string scraped from a page.
 *   { status: 'valid', result }                 result = validateAddress() success + suggestedChain
 *   { status: 'rejected', chainGuess, reason }  looks like an address for some chain but fails it
 *   { status: 'ignore' }                        noise
 * Only strongly-shaped strings become "rejected" so random words don't flood that list.
 */
export function classifyCandidate(raw, { context = '', scheme = '' } = {}) {
  const a = cleanInput(raw);
  if (!a || a.length < 25 || a.length > 128) return { status: 'ignore' };
  const det = detectChain(a);

  // SOL: no checksum, so only accept from a solana: link or a Solana-ish context.
  if (det.chain === 'sol') {
    if (scheme === 'solana' || SOL_CONTEXT_RE.test(context)) {
      const r = validateSol(a);
      return r.ok ? { status: 'valid', result: r } : { status: 'ignore' };
    }
    return { status: 'ignore' };
  }
  if (!det.chain) {
    // Distinctive shapes that failed every decoder: report as rejected.
    if (/^0x[0-9a-fA-F]{38,42}$/.test(a)) return { status: 'rejected', chainGuess: 'eth', reason: `EVM address must be 0x + 40 hex chars (got ${a.length - 2})` };
    return { status: 'ignore' };
  }
  const r = validateAddress(a, undefined);
  if (r.ok) {
    if (r.family === 'evm') {
      r.suggestedChain = suggestEvmChain(context) || null;
    }
    return { status: 'valid', result: r };
  }
  // Base58 strings with a known first letter but a bad checksum: only report
  // those whose length matches that chain's real addresses.
  if (B58_RE.test(a) && !/^r/.test(a)) {
    const lenOk = { trx: [34, 34], btc: [26, 35], ltc: [33, 34], doge: [34, 34], dash: [34, 34] }[det.chain];
    if (!lenOk || a.length < lenOk[0] || a.length > lenOk[1]) return { status: 'ignore' };
    // Ordinary words (single case, no digits) are not addresses.
    if (/^[A-Za-z]+$/.test(a) && (a === a.toLowerCase() || a === a.toUpperCase())) return { status: 'ignore' };
  }
  return { status: 'rejected', chainGuess: r.chainGuess || det.chain, reason: r.reason };
}

// --------------------------------------------------------------- CashAddr enc

const CASH_GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
function cashPolymod(values) {
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= CASH_GEN[i];
  }
  return c ^ 1n;
}
/** Encode a 20-byte hash as a mainnet CashAddr (type 0 = P2PKH, 1 = P2SH). */
export function cashAddrEncode(type, hash) {
  const payload = convertBits([type << 3, ...hash], 8, 5, true);
  const pre = [...'bitcoincash'].map(c => c.charCodeAt(0) & 0x1f);
  const mod = cashPolymod([...pre, 0, ...payload, 0, 0, 0, 0, 0, 0, 0, 0]);
  for (let i = 0; i < 8; i++) payload.push(Number((mod >> BigInt(5 * (7 - i))) & 0x1fn));
  return 'bitcoincash:' + payload.map(d => CHARSET[d]).join('');
}
