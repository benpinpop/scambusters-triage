// Base58 / Base58Check with selectable alphabet (Bitcoin or Ripple).
// Double-SHA256 checksum per the Bitcoin wiki / XRPL "base58 encodings".

import { sha256 } from '../vendor/noble-hashes/sha2.js';

export const BTC_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const XRP_ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';

const maps = new Map();
function charMap(alphabet) {
  let m = maps.get(alphabet);
  if (!m) {
    m = new Int16Array(128).fill(-1);
    for (let i = 0; i < alphabet.length; i++) m[alphabet.charCodeAt(i)] = i;
    maps.set(alphabet, m);
  }
  return m;
}

/** Decode a base58 string to bytes, or return null if it contains a non-alphabet char. */
export function base58Decode(str, alphabet = BTC_ALPHABET) {
  const map = charMap(alphabet);
  const zeroChar = alphabet[0];
  let zeros = 0;
  while (zeros < str.length && str[zeros] === zeroChar) zeros++;
  const bytes = []; // little-endian base256 accumulator
  for (let i = zeros; i < str.length; i++) {
    const c = str.charCodeAt(i);
    const v = c < 128 ? map[c] : -1;
    if (v < 0) return null;
    let carry = v;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i];
  return out;
}

/** Encode bytes as base58. */
export function base58Encode(bytes, alphabet = BTC_ALPHABET) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let s = alphabet[0].repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) s += alphabet[digits[i]];
  return s;
}

function checksum4(payload) {
  return sha256(sha256(payload)).subarray(0, 4);
}

/**
 * Decode Base58Check. Returns
 *   { ok: true, bytes }               bytes = data without the 4-byte checksum
 *   { ok: false, reason }             'alphabet' | 'short' | 'checksum'
 */
export function base58CheckDecode(str, alphabet = BTC_ALPHABET) {
  const raw = base58Decode(str, alphabet);
  if (!raw) return { ok: false, reason: 'alphabet' };
  if (raw.length < 5) return { ok: false, reason: 'short' };
  const data = raw.subarray(0, raw.length - 4);
  const sum = raw.subarray(raw.length - 4);
  const want = checksum4(data);
  for (let i = 0; i < 4; i++) if (sum[i] !== want[i]) return { ok: false, reason: 'checksum', bytes: data };
  return { ok: true, bytes: data };
}

/** Base58Check-encode version byte(s) + payload. */
export function base58CheckEncode(version, payload, alphabet = BTC_ALPHABET) {
  const ver = typeof version === 'number' ? [version] : Array.from(version);
  const data = new Uint8Array(ver.length + payload.length);
  data.set(ver, 0);
  data.set(payload, ver.length);
  const full = new Uint8Array(data.length + 4);
  full.set(data, 0);
  full.set(checksum4(data), data.length);
  return base58Encode(full, alphabet);
}
