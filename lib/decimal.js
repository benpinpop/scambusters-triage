// Exact decimal helpers for on-chain amounts. Raw amounts are integers in the
// smallest unit (wei, sun, satoshi, drops...). Never use floating point on them.

/** Parse a raw integer amount (string | number | bigint) into a BigInt. Throws on junk. */
export function toBigInt(raw) {
  if (typeof raw === 'bigint') return raw;
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) throw new Error(`unsafe integer amount: ${raw}`);
    return BigInt(raw);
  }
  const s = String(raw ?? '').trim();
  if (!/^-?\d+$/.test(s)) throw new Error(`not an integer amount: ${s.slice(0, 40)}`);
  return BigInt(s);
}

/**
 * Format a raw integer amount with `decimals` places as a decimal string,
 * trimming trailing zeros. formatUnits(1500000n, 6) === "1.5".
 */
export function formatUnits(raw, decimals) {
  let v = toBigInt(raw);
  const d = Number(decimals);
  if (!Number.isInteger(d) || d < 0 || d > 77) throw new Error(`bad decimals: ${decimals}`);
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(d);
  const whole = v / base;
  let frac = (v % base).toString().padStart(d, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '');
}

/**
 * Parse a decimal string ("1.5") into raw units for `decimals` places.
 * Extra precision beyond `decimals` is rejected rather than rounded.
 */
export function parseUnits(str, decimals) {
  const s = String(str).trim();
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) throw new Error(`not a decimal: ${s}`);
  const frac = m[3] || '';
  if (frac.length > decimals) throw new Error('too many decimal places');
  const v = BigInt((m[2] || '0') + frac.padEnd(decimals, '0'));
  return m[1] ? -v : v;
}

/** "-12.345" -> { v: -12345n, scale: 3 }. Returns null if not a plain decimal. */
function scaled(str) {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(str ?? '').trim());
  if (!m) return null;
  const frac = m[3] || '';
  const v = BigInt(m[2] + frac);
  return { v: m[1] ? -v : v, scale: frac.length };
}

/** Round a scaled value half away from zero to `places` and format with exactly `places` decimals. */
function fixed({ v, scale }, places) {
  const neg = v < 0n;
  let a = neg ? -v : v;
  if (scale < places) a *= 10n ** BigInt(places - scale);
  else if (scale > places) {
    const div = 10n ** BigInt(scale - places);
    const q = a / div;
    a = q + (a % div * 2n >= div ? 1n : 0n);
  }
  const s = a.toString().padStart(places + 1, '0');
  const body = places ? `${s.slice(0, -places)}.${s.slice(-places)}` : s;
  return (neg && a !== 0n ? '-' : '') + body;
}

/** Round a decimal string to exactly `places` decimals (half away from zero), no float math. */
export function roundDecimal(str, places) {
  const s = scaled(str);
  return s ? fixed(s, places) : null;
}

/** amount (decimal string) * price (number), rounded to cents, as a decimal string. null if unusable. */
export function usdValue(amountStr, price) {
  if (!(typeof price === 'number' && Number.isFinite(price) && price > 0)) return null;
  const a = scaled(amountStr), p = scaled(price.toFixed(8));
  if (!a || !p) return null;
  return fixed({ v: a.v * p.v, scale: a.scale + p.scale }, 2);
}

/** Add a thousands separator to the integer part for display only. */
export function groupDigits(decimalStr) {
  if (decimalStr == null) return decimalStr;
  const [i, f] = String(decimalStr).split('.');
  const g = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return f ? `${g}.${f}` : g;
}
