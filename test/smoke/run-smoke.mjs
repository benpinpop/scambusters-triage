// Live, read-only smoke test for the on-chain providers and RDAP.
// Usage: node test/smoke/run-smoke.mjs [filter]   (filter = substring of a case label)
// Keys come from test/.env.test (KEY=VALUE lines); they are never printed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { lookupWallet, lookupSupport, lookupLabels } from '../../lib/providers/index.js';
import { rdapLookup } from '../../lib/intel/rdap.js';

const here = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const env = {};
  try {
    for (const line of readFileSync(join(here, '..', '.env.test'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* no env file: key-requiring cases will report no_key */ }
  return env;
}
const env = loadEnv();
const keys = { etherscan: env.ETHERSCAN_API_KEY || '', tronscan: env.TRONSCAN_API_KEY || '', blockchain: env.BLOCKCHAIN_API_KEY || '' };

const ETH_USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const ETH_USDT_BSC = '0x55d398326f99059fF775485246999027B3197955';
const USDT_AVAX = '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7';
const USDT_OP = '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58';
const EIP55 = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRON_ORD = 'TDY65riaD8aA2KhbTT2W8AxhLKnYJFHweG'; // ordinary account seen in the USDT contract's transfer list

const cases = [
  // keyless public-RPC cases (empty etherscan key forces the evmrpc path)
  ['rpc:bsc', ETH_USDT_BSC], ['rpc:avax', USDT_AVAX], ['rpc:op', USDT_OP],
  ['eth', ETH_USDT], ['eth', EIP55],
  ['bsc', EIP55], ['matic', EIP55], ['arb', EIP55], ['avax', EIP55], ['op', EIP55],
  ['trx', TRON_USDT], ['trx', TRON_ORD],
  ['btc', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'],
  ['xrp', 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'],
  ['sol', 'Vote111111111111111111111111111111111111111'],
  ['sol', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
  ['ltc', 'LdP8Qox1VAhCzLJNqrr74YovaWYyNBUWvL'],
  ['doge', 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L'],
  ['dash', 'XdAUmwtig27HBG6WfYyHAzP8n6XC9jESEw'],
  ['bch', 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'],
];

const labelCases = [
  ['eth', ETH_USDT], ['eth', '0x28C6c06298d514Db089934071355E5743bf21d60'], ['bsc', '0x28C6c06298d514Db089934071355E5743bf21d60'],
  ['trx', TRON_USDT], ['trx', 'TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G'],
  ['xrp', 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh'], ['xrp', 'rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh'],
  ['btc', '1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s'],
];
const lrows = [];
const filter = process.argv[2] || '';
const rows = [];
const short = a => (a.length > 16 ? a.slice(0, 8) + '..' + a.slice(-4) : a);
const trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '~' : String(s));
const f = v => (v == null ? '-' : String(v));

for (const [rawChain, address] of cases) {
  const keyless = rawChain.startsWith('rpc:');
  const chain = keyless ? rawChain.slice(4) : rawChain;
  const k = keyless ? { ...keys, etherscan: '' } : keys;
  const label = `${rawChain} ${short(address)}`;
  if (filter && !label.includes(filter)) continue;
  const t0 = Date.now();
  try {
    const sup = lookupSupport(chain);
    const r = await lookupWallet({ chain, address }, k);
    rows.push({
      case: label, ok: 'OK', tx: f(r.txCount), bal: trunc(f(r.balance), 14), usdt: trunc(f(r.usdtBalance), 14),
      in: trunc(f(r.volumeIn.native), 12), out: trunc(f(r.volumeOut.native), 12),
      uin: trunc(f(r.volumeIn.usdt), 12), uout: trunc(f(r.volumeOut.usdt), 12),
      smp: r.sampled ? JSON.stringify(r.sampled) : '-', first: f(r.firstSeen).slice(0, 10), last: f(r.lastActivity).slice(0, 10),
      ms: Date.now() - t0, note: r.source,
    });
  } catch (e) {
    rows.push({ case: label, ok: 'ERR ' + (e.code || e.name), note: trunc(String(e.message).replace(/\s+/g, ' '), 90), ms: Date.now() - t0 });
  }
}

for (const d of ['example.com', 'google.com', 'login.example.co.uk']) {
  if (filter && !('rdap ' + d).includes(filter)) continue;
  const t0 = Date.now();
  try {
    const r = await rdapLookup(d);
    rows.push({ case: 'rdap ' + d, ok: 'OK', first: f(r.created).slice(0, 10), tx: f(r.ageDays) + 'd', note: `${r.domain} / ${r.registrar} / ns=${r.nameservers.length} / exp ${f(r.expires).slice(0, 10)}`, ms: Date.now() - t0 });
  } catch (e) {
    rows.push({ case: 'rdap ' + d, ok: 'ERR ' + (e.code || e.name), note: trunc(String(e.message), 90), ms: Date.now() - t0 });
  }
}

for (const [chain, address] of labelCases) {
  const label = `labels ${chain} ${short(address)}`;
  if (filter && !label.includes(filter)) continue;
  try {
    const ls = await lookupLabels({ chain, address }, keys);
    lrows.push({ case: label, ok: 'OK', labels: ls.length ? ls.map(l => `${l.text} [${l.risk}/${l.kind}/${l.source}]`).join('; ').slice(0, 140) : '(none)' });
  } catch (e) {
    lrows.push({ case: label, ok: 'ERR ' + (e.code || e.name), labels: trunc(String(e.message), 90) });
  }
}
console.table(rows);
if (lrows.length) console.table(lrows);
const bad = rows.filter(r => r.ok !== 'OK');
console.log(`${rows.length - bad.length}/${rows.length} ok`);
