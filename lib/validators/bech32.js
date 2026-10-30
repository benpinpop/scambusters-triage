// Bech32 (BIP-173) and Bech32m (BIP-350), plus SegWit address decoding.

export const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
export const BECH32_CONST = 1;
export const BECH32M_CONST = 0x2bc830a3;

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = (((chk & 0x1ffffff) << 5) ^ v) >>> 0;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk = (chk ^ GEN[i]) >>> 0;
  }
  return chk >>> 0;
}

function hrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

/**
 * Decode a bech32/bech32m string.
 * @param {number} limit max total length (90 per BIP-173; larger for Cardano CIP-19)
 * @returns {{ok:true, hrp, data:number[], encoding:'bech32'|'bech32m'} | {ok:false, reason}}
 */
export function bech32Decode(str, limit = 90) {
  if (str.length > limit) return { ok: false, reason: `too long (${str.length} > ${limit} chars)` };
  let lower = false, upper = false;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 33 || c > 126) return { ok: false, reason: 'invalid character' };
    if (c >= 97 && c <= 122) lower = true;
    if (c >= 65 && c <= 90) upper = true;
  }
  if (lower && upper) return { ok: false, reason: 'mixed case is not allowed in Bech32' };
  const s = str.toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length) return { ok: false, reason: 'missing separator or checksum' };
  const hrp = s.slice(0, pos);
  const data = [];
  for (let i = pos + 1; i < s.length; i++) {
    const d = CHARSET.indexOf(s[i]);
    if (d < 0) return { ok: false, reason: `invalid Bech32 character '${s[i]}'` };
    data.push(d);
  }
  const c = polymod(hrpExpand(hrp).concat(data));
  const encoding = c === BECH32_CONST ? 'bech32' : c === BECH32M_CONST ? 'bech32m' : null;
  if (!encoding) return { ok: false, reason: 'Bech32 checksum mismatch' };
  return { ok: true, hrp, data: data.slice(0, -6), encoding };
}

/** Regroup bits (e.g. 5-bit words -> bytes). Returns null on invalid padding. */
export function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const v of data) {
    if (v < 0 || v >> from) return null;
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
    acc &= (1 << bits) - 1; // keep accumulator small
  }
  if (pad) { if (bits > 0) out.push((acc << (to - bits)) & maxv); }
  else if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
  return out;
}

/**
 * Decode a SegWit address for the expected HRP ('bc' or 'ltc').
 * Enforces BIP-173/BIP-350 rules: v0 uses bech32 with a 20/32-byte program,
 * v1..v16 use bech32m with a 2..40-byte program.
 */
export function decodeSegwit(expectedHrp, addr) {
  const d = bech32Decode(addr, 90);
  if (!d.ok) return d;
  if (d.hrp !== expectedHrp) return { ok: false, reason: `wrong prefix '${d.hrp}1' (expected '${expectedHrp}1')` };
  if (d.data.length < 1) return { ok: false, reason: 'empty witness data' };
  const version = d.data[0];
  if (version > 16) return { ok: false, reason: `invalid witness version ${version}` };
  const program = convertBits(d.data.slice(1), 5, 8, false);
  if (!program) return { ok: false, reason: 'invalid witness program padding' };
  if (program.length < 2 || program.length > 40) return { ok: false, reason: `invalid witness program length ${program.length}` };
  if (version === 0 && program.length !== 20 && program.length !== 32) {
    return { ok: false, reason: `v0 witness program must be 20 or 32 bytes (got ${program.length})` };
  }
  if (version === 0 && d.encoding !== 'bech32') return { ok: false, reason: 'witness v0 must use Bech32, not Bech32m' };
  if (version !== 0 && d.encoding !== 'bech32m') return { ok: false, reason: `witness v${version} must use Bech32m (BIP-350)` };
  let kind;
  if (version === 0) kind = program.length === 20 ? 'Bech32 v0 P2WPKH' : 'Bech32 v0 P2WSH';
  else if (version === 1 && program.length === 32) kind = 'Bech32m v1 Taproot';
  else kind = `Bech32m v${version}`;
  return { ok: true, version, program, kind };
}
