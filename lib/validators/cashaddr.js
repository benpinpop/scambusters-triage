// Bitcoin Cash CashAddr (spec: github.com/bitcoincashorg/bitcoincash.org/blob/master/spec/cashaddr.md).
// 40-bit BCH-code polymod, computed with BigInt for exactness.

import { CHARSET, convertBits } from './bech32.js';

const GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];

function polymod(values) {
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= GEN[i];
  }
  return c ^ 1n;
}

const SIZES = [160, 192, 224, 256, 320, 384, 448, 512];

/**
 * Decode a CashAddr with or without the 'bitcoincash:' prefix (mainnet only).
 * @returns {{ok:true, type:'P2PKH'|'P2SH', hash:number[], normalized:string} | {ok:false, reason}}
 */
export function decodeCashAddr(input) {
  let s = input;
  const hasLower = /[a-z]/.test(s), hasUpper = /[A-Z]/.test(s);
  if (hasLower && hasUpper) return { ok: false, reason: 'mixed case is not allowed in CashAddr' };
  s = s.toLowerCase();
  let prefix = 'bitcoincash';
  const colon = s.indexOf(':');
  if (colon >= 0) {
    prefix = s.slice(0, colon);
    s = s.slice(colon + 1);
    if (prefix !== 'bitcoincash') return { ok: false, reason: `unsupported CashAddr prefix '${prefix}'` };
  }
  const data = [];
  for (const ch of s) {
    const v = CHARSET.indexOf(ch);
    if (v < 0) return { ok: false, reason: `invalid CashAddr character '${ch}'` };
    data.push(v);
  }
  if (data.length < 9) return { ok: false, reason: 'too short' };
  const pre = [...prefix].map(c => c.charCodeAt(0) & 0x1f);
  if (polymod([...pre, 0, ...data]) !== 0n) return { ok: false, reason: 'CashAddr checksum mismatch' };
  const bytes = convertBits(data.slice(0, -8), 5, 8, false);
  if (!bytes || bytes.length < 1) return { ok: false, reason: 'invalid CashAddr payload' };
  const ver = bytes[0];
  if (ver & 0x80) return { ok: false, reason: 'reserved version bit set' };
  const typeBits = (ver >> 3) & 0x0f;
  const size = SIZES[ver & 0x07];
  const hash = bytes.slice(1);
  if (hash.length * 8 !== size) return { ok: false, reason: `hash length ${hash.length * 8} does not match version size ${size}` };
  const type = typeBits === 0 ? 'P2PKH' : typeBits === 1 ? 'P2SH' : null;
  if (!type) return { ok: false, reason: `unknown CashAddr type ${typeBits}` };
  return { ok: true, type, hash, normalized: s };
}
