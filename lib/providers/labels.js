// Address name-label lookups. Label = { text, source, risk: 'none'|'caution'|'high', kind? }.
//
// Sources verified live on 2026-10-27:
//  - Blockscout metadata service (keyless, multichain, all six EVM chainIds worked):
//      GET https://metadata.services.blockscout.com/api/v1/metadata?addresses=<a>&chainId=<id>
//      -> {addresses:{<a>:{tags:[{slug,name,tagType:'name'|'generic'|'protocol'|'note',meta:'<json string>'}]}}}
//      0x28C6c0..1d60 -> "Binance 14", "Binance: Hot Wallet", "Exchange". Responses carry no
//      Access-Control-Allow-Origin header, so it needs host_permissions in the extension.
//      (The per-chain Blockscout explorers are not usable: eth.blockscout.com's address API has
//      no tags for exchanges, several instances sit behind a Cloudflare challenge.)
//  - XRPScan  GET https://api.xrpscan.com/api/v1/account/<addr> -> accountName {name, desc?, verified}
//      (ACAO *). `advisory` is null for ordinary accounts; its non-null shape is UNVERIFIED.
//  - WalletExplorer (BTC)  GET https://www.walletexplorer.com/api/1/address-lookup?address=<a>&caller=<x>
//      -> {found:true,label:'Binance.com',wallet_id} or {found:false} (ACAO *). Uses the 'default' queue policy.
//  - Etherscan getsourcecode -> ContractName (free key). tokeninfo is API Pro only; nametag is
//      "API Exclusive"; both are skipped.
//  - Tronscan: see tronscan.js (accountv2 tags + /api/security/account/data).
// Not available keyless: Solana (Solscan public API 404s), LTC/DOGE/DASH, Blockchair (IP-blacklists).

import { ServiceError } from '../errors.js';
import { request } from '../net/queue.js';
import { CHAINS } from '../chains.js';
import { httpError } from './util.js';

export const MAX_LABELS = 6;

const HIGH = /phish|scam|hack|exploit|black.?list|sanction|ofac|fake|heist|stolen|ransom|rug.?pull|drainer|fraud/i;
const CAUTION = /gambl|casino|mixer|tumbler|suspicious|darknet|dark.?market|launder|high.?risk|spam/i;
const EXCHANGE = /exchange|binance|coinbase|kraken|okx|okex|bybit|kucoin|huobi|htx|bitfinex|gate\.io|crypto\.com|bitstamp|gemini|bitget|mexc|hot wallet|cold wallet/i;

export function riskFor(text) {
  const t = String(text || '');
  if (HIGH.test(t)) return 'high';
  if (CAUTION.test(t)) return 'caution';
  return 'none';
}

export function kindFor(text, risk, hint) {
  const t = String(text || '');
  if (/sanction|ofac/i.test(t)) return 'sanction';
  if (risk === 'high') return 'scam';
  if (hint) return hint;
  if (EXCHANGE.test(t)) return 'exchange';
  if (/stablecoin|token|usdt|usdc/i.test(t)) return 'token';
  return 'other';
}

/** Build a label; risk/kind derived from the text unless given. */
export function mkLabel(text, source, { risk, kind } = {}) {
  const t = String(text || '').trim().slice(0, 80);
  if (!t) return null;
  const r = risk || riskFor(t);
  return { text: t, source, risk: r, kind: kindFor(t, r, kind) };
}

const RANK = { high: 2, caution: 1, none: 0 };

/** Dedupe by lowercased text+source, riskiest first, capped. */
export function finalizeLabels(list) {
  const seen = new Map();
  for (const l of list) {
    if (!l) continue;
    const k = (l.text + '|' + l.source).toLowerCase();
    const prev = seen.get(k);
    if (!prev || RANK[l.risk] > RANK[prev.risk]) seen.set(k, l);
  }
  return [...seen.values()].sort((a, b) => RANK[b.risk] - RANK[a.risk]).slice(0, MAX_LABELS);
}

// ------------------------------------------------------------------ Blockscout metadata
export async function blockscoutLabels(chain, address) {
  const id = CHAINS[chain] && CHAINS[chain].evmChainId;
  if (!id) return [];
  const url = `https://metadata.services.blockscout.com/api/v1/metadata?addresses=${encodeURIComponent(address)}&chainId=${id}`;
  const res = await request('blockscout', url);
  if (res.status === 422 || res.status === 400) throw new ServiceError('bad_request', 'Blockscout metadata rejected the address.', { status: res.status });
  if (!res.ok) throw httpError('Blockscout metadata', res);
  const map = res.json && res.json.addresses;
  if (!map || typeof map !== 'object') throw new ServiceError('bad_response', 'Blockscout metadata: unexpected response');
  const entry = map[address] || map[address.toLowerCase()] || Object.values(map)[0];
  const tags = entry && Array.isArray(entry.tags) ? entry.tags : [];
  const out = [];
  for (const t of tags) {
    if (!t) continue;
    if (t.tagType === 'name' || t.tagType === 'generic') {
      out.push(mkLabel(t.name, 'Blockscout', { risk: riskFor(`${t.name} ${t.slug || ''}`) }));
    } else if (t.tagType === 'note') {
      let meta = {};
      try { meta = JSON.parse(t.meta || '{}'); } catch { /* ignore */ }
      if (meta.alertStatus === 'warning' || meta.alertStatus === 'error') {
        out.push(mkLabel(meta.data || t.name, 'Blockscout', { risk: riskFor(meta.data) === 'none' ? 'caution' : riskFor(meta.data) }));
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ XRPScan
export async function xrpscanLabels(address) {
  const res = await request('xrpscan', `https://api.xrpscan.com/api/v1/account/${encodeURIComponent(address)}`);
  if (res.status === 404) return [];
  if (!res.ok) throw httpError('XRPScan', res);
  const j = res.json;
  if (!j || typeof j !== 'object') throw new ServiceError('bad_response', 'XRPScan: unexpected response');
  const out = [];
  const n = j.accountName;
  if (n && n.name) out.push(mkLabel(n.desc && !/^\d+$/.test(String(n.desc)) ? `${n.name} (${n.desc})` : n.name, 'XRPScan'));
  // Shape of a non-null `advisory` is unverified; surface it conservatively as a high-risk flag.
  const adv = j.advisory;
  if (adv) {
    const txt = typeof adv === 'string' ? adv : (adv.description || adv.message || adv.type || 'XRPScan advisory');
    out.push(mkLabel(`Advisory: ${txt}`, 'XRPScan', { risk: 'high', kind: 'scam' }));
  }
  return out;
}

// ------------------------------------------------------------------ WalletExplorer (BTC)
export async function walletExplorerLabels(address) {
  const res = await request('walletexplorer', `https://www.walletexplorer.com/api/1/address-lookup?address=${encodeURIComponent(address)}&caller=scambusters-triage`);
  if (!res.ok) throw httpError('WalletExplorer', res);
  const j = res.json;
  if (!j || typeof j !== 'object') throw new ServiceError('bad_response', 'WalletExplorer: unexpected response');
  if (!j.found || !j.label) return [];
  return [mkLabel(j.label, 'WalletExplorer')];
}
