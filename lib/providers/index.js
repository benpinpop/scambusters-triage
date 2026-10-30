// On-chain lookup dispatcher.

import { ServiceError } from '../errors.js';
import { isEvmChain, CHAINS } from '../chains.js';
import * as etherscan from './etherscan.js';
import * as blockchain from './blockchain.js';
import * as tronscan from './tronscan.js';
import * as xrpl from './xrpl.js';
import * as solana from './solana.js';
import * as blockcypher from './blockcypher.js';
import * as evmrpc from './evmrpc.js';
import { usdPriceFor } from './price.js';
import { blockscoutLabels, xrpscanLabels, walletExplorerLabels, finalizeLabels } from './labels.js';

/** What can we do for a chain? needsKey is a REQUIRED key; BTC's key is optional. */
export function lookupSupport(chain) {
  if (evmrpc.RPC_CHAINS.includes(chain)) return { supported: true, provider: evmrpc.SOURCE, needsKey: null }; // Etherscan if keyed, else public RPC
  if (isEvmChain(chain)) return { supported: true, provider: etherscan.SOURCE, needsKey: 'etherscan' };
  switch (chain) {
    case 'btc':  return { supported: true, provider: blockchain.SOURCE, needsKey: null };
    case 'trx':  return { supported: true, provider: tronscan.SOURCE, needsKey: 'tronscan' };
    case 'xrp':  return { supported: true, provider: xrpl.SOURCE, needsKey: null };
    case 'sol':  return { supported: true, provider: solana.SOURCE, needsKey: null };
    case 'ltc': case 'doge': case 'dash':
      return { supported: true, provider: blockcypher.SOURCE, needsKey: null };
    default:     return { supported: false, provider: null, needsKey: null };
  }
}

/**
 * @param {{chain:string,address:string}} w
 * @param {{etherscan?:string,tronscan?:string,blockchain?:string}} [keys]
 */
async function lookupCore({ chain, address }, keys = {}) {
  const sup = lookupSupport(chain);
  if (!sup.supported) {
    const name = CHAINS[chain] ? CHAINS[chain].name : String(chain);
    throw new ServiceError('not_supported', `Lookup not supported for ${name} yet. Use the explorer link.`);
  }
  const k = keys || {};
  if (sup.needsKey && !k[sup.needsKey]) {
    throw new ServiceError('no_key', `A ${sup.needsKey === 'etherscan' ? 'Etherscan' : 'Tronscan'} API key is required for ${CHAINS[chain].name} lookups. Add it in Settings.`);
  }
  const w = { chain, address };
  if (evmrpc.RPC_CHAINS.includes(chain)) {
    if (k.etherscan) {
      try { return await etherscan.lookup(w, k.etherscan); }
      catch (e) { if (!(e && e.code === 'not_supported')) throw e; }
    }
    return evmrpc.lookup(w);
  }
  switch (sup.provider) {
    case evmrpc.SOURCE:      return evmrpc.lookup(w);
    case etherscan.SOURCE:   return etherscan.lookup(w, k.etherscan);
    case blockchain.SOURCE:  return blockchain.lookup(w, k.blockchain || '');
    case tronscan.SOURCE:    return tronscan.lookup(w, k.tronscan);
    case xrpl.SOURCE:        return xrpl.lookup(w);
    case solana.SOURCE:      return solana.lookup(w);
    case blockcypher.SOURCE: return blockcypher.lookup(w);
    default: throw new ServiceError('not_supported', `No adapter for ${chain}`);
  }
}

/**
 * Name labels for an address. Returns [] when nothing is known; throws a
 * ServiceError only when every source failed (a real failure).
 */
export async function lookupLabels({ chain, address }, keys = {}) {
  const k = keys || {};
  const jobs = [];
  if (isEvmChain(chain)) {
    // Etherscan's getsourcecode (can be a large payload) only runs when Blockscout had no name.
    jobs.push(async () => {
      let bs = [];
      let err = null;
      try { bs = await blockscoutLabels(chain, address); } catch (e) { err = e; }
      if (bs.length || !k.etherscan) { if (err && !bs.length) throw err; return bs; }
      try { return [...bs, ...await etherscan.contractNameLabels(chain, address, k.etherscan)]; }
      catch (e) { throw err || e; }
    });
  } else if (chain === 'trx') {
    if (k.tronscan) jobs.push(() => tronscan.lookupLabels({ address }, k.tronscan));
  } else if (chain === 'xrp') jobs.push(() => xrpscanLabels(address));
  else if (chain === 'btc') jobs.push(() => walletExplorerLabels(address));
  const all = [];
  let firstErr = null, ok = 0;
  for (const job of jobs) {
    try { all.push(...await job()); ok++; } catch (e) { firstErr = firstErr || e; }
  }
  if (!ok && firstErr) throw firstErr;
  return finalizeLabels(all);
}

/** Full lookup including labels (label failures never fail the lookup; they add a note). */
export async function lookupWallet(w, keys = {}) {
  const r = await lookupCore(w, keys);
  r.usdPrice = await usdPriceFor(w.chain).catch(() => null); // soft: null means no USD shown
  if (w.chain === 'trx') return r; // tronscan.lookup already attached labels
  try {
    const have = r.labels || [];
    let labels = await lookupLabels(w, keys);
    if (have.length) labels = finalizeLabels([...have, ...labels]);
    r.labels = labels;
  } catch (e) {
    r.labels = r.labels || [];
    r.notes.push('Name labels unavailable: ' + ((e && e.message) || 'error'));
  }
  return r;
}

/** Cheap key check; throws ServiceError on failure. */
export async function testKey(service, key) {
  switch (service) {
    case 'etherscan':  return etherscan.testKey(key);
    case 'tronscan':   return tronscan.testKey(key);
    case 'blockchain': return blockchain.testKey(key);
    default: throw new ServiceError('bad_request', `No key test for ${service}`);
  }
}
