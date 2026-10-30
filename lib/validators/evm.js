// EVM address validation with EIP-55 mixed-case checksum (keccak-256).

import { keccak_256 } from '../vendor/noble-hashes/sha3.js';

const ENC = new TextEncoder();

/** Return the EIP-55 checksummed form of a 0x + 40-hex address. */
export function toChecksumAddress(addr) {
  const lower = addr.slice(2).toLowerCase();
  const hash = keccak_256(ENC.encode(lower));
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    const nibble = (hash[i >> 1] >> (i % 2 === 0 ? 4 : 0)) & 0x0f;
    const ch = lower[i];
    out += nibble >= 8 ? ch.toUpperCase() : ch;
  }
  return out;
}

/**
 * @returns {{ok:true, validation:'checksum'|'no_checksum', kind, normalized, checksummed} | {ok:false, reason}}
 */
export function validateEvm(addr) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    if (/^0x[0-9a-fA-F]*$/i.test(addr)) return { ok: false, reason: `EVM address must be 0x + 40 hex chars (got ${addr.length - 2})` };
    return { ok: false, reason: 'not a 0x-prefixed hex address' };
  }
  if (/^0X/.test(addr)) return { ok: false, reason: "prefix must be lowercase '0x'" };
  const body = addr.slice(2);
  const checksummed = toChecksumAddress(addr);
  const normalized = '0x' + body.toLowerCase();
  if (body === body.toLowerCase() || body === body.toUpperCase()) {
    return { ok: true, validation: 'no_checksum', kind: 'EVM (no EIP-55 checksum)', normalized, checksummed };
  }
  if (addr !== checksummed) {
    return { ok: false, reason: 'EIP-55 checksum mismatch: mixed-case address with wrong capitalization (typo or fake)' };
  }
  return { ok: true, validation: 'checksum', kind: 'EIP-55', normalized, checksummed };
}
