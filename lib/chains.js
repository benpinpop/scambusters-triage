// Chain metadata shared by the worker, side panel and providers.
// Canonical codes and aliases come from the ScamBusters API reference (skill:
// scambusters-submissions, "Valid Chain Codes" / "Accepted Chain Aliases").

/** Canonical ScamBusters chain codes, in the order the API lists them. */
export const CHAIN_CODES = [
  'btc', 'eth', 'trx', 'xrp', 'bsc', 'sol', 'ltc', 'doge',
  'bch', 'ada', 'dash', 'matic', 'arb', 'avax', 'op',
];

/** Aliases accepted by the API, normalized to canonical codes. */
export const CHAIN_ALIASES = {
  bnb: 'bsc', polygon: 'matic', erc20: 'eth', 'erc-20': 'eth',
  trc20: 'trx', 'trc-20': 'trx', bep20: 'bsc', 'bep-20': 'bsc',
};

/** EVM chains that share the 0x address format. `eth` is the detection default. */
export const EVM_CHAINS = ['eth', 'bsc', 'matic', 'arb', 'avax', 'op'];

/**
 * Per-chain display + explorer info.
 * - evmChainId: Etherscan V2 `chainid` parameter.
 * - explorer(address): URL of a public explorer page (opened only on user click).
 */
export const CHAINS = {
  btc:   { name: 'Bitcoin',         symbol: 'BTC',  decimals: 8,  explorer: a => `https://www.blockchain.com/explorer/addresses/btc/${a}` },
  eth:   { name: 'Ethereum',        symbol: 'ETH',  decimals: 18, evmChainId: 1,     explorer: a => `https://etherscan.io/address/${a}` },
  trx:   { name: 'Tron',            symbol: 'TRX',  decimals: 6,  explorer: a => `https://tronscan.org/#/address/${a}` },
  xrp:   { name: 'XRP Ledger',      symbol: 'XRP',  decimals: 6,  explorer: a => `https://livenet.xrpl.org/accounts/${a}` },
  bsc:   { name: 'BNB Smart Chain', symbol: 'BNB',  decimals: 18, evmChainId: 56,    explorer: a => `https://bscscan.com/address/${a}` },
  sol:   { name: 'Solana',          symbol: 'SOL',  decimals: 9,  explorer: a => `https://explorer.solana.com/address/${a}` },
  ltc:   { name: 'Litecoin',        symbol: 'LTC',  decimals: 8,  explorer: a => `https://blockchair.com/litecoin/address/${a}` },
  doge:  { name: 'Dogecoin',        symbol: 'DOGE', decimals: 8,  explorer: a => `https://blockchair.com/dogecoin/address/${a}` },
  bch:   { name: 'Bitcoin Cash',    symbol: 'BCH',  decimals: 8,  explorer: a => `https://blockchair.com/bitcoin-cash/address/${a.replace(/^bitcoincash:/i, '')}` },
  ada:   { name: 'Cardano',         symbol: 'ADA',  decimals: 6,  explorer: a => `https://cardanoscan.io/address/${a}` },
  dash:  { name: 'Dash',            symbol: 'DASH', decimals: 8,  explorer: a => `https://blockchair.com/dash/address/${a}` },
  matic: { name: 'Polygon',         symbol: 'POL',  decimals: 18, evmChainId: 137,   explorer: a => `https://polygonscan.com/address/${a}` },
  arb:   { name: 'Arbitrum One',    symbol: 'ETH',  decimals: 18, evmChainId: 42161, explorer: a => `https://arbiscan.io/address/${a}` },
  avax:  { name: 'Avalanche C',     symbol: 'AVAX', decimals: 18, evmChainId: 43114, explorer: a => `https://snowtrace.io/address/${a}` },
  op:    { name: 'Optimism',        symbol: 'ETH',  decimals: 18, evmChainId: 10,    explorer: a => `https://optimistic.etherscan.io/address/${a}` },
};

/** Normalize user/API chain input to a canonical code, or null. */
export function canonicalChain(input) {
  if (typeof input !== 'string') return null;
  const c = input.trim().toLowerCase();
  if (CHAIN_CODES.includes(c)) return c;
  return CHAIN_ALIASES[c] || null;
}

export function isEvmChain(code) {
  return EVM_CHAINS.includes(code);
}

export function explorerUrl(chain, address) {
  const meta = CHAINS[chain];
  return meta ? meta.explorer(encodeURIComponent(address).replace(/%3A/gi, ':')) : null;
}

/**
 * Context keywords used to *suggest* (never force) an EVM chain from the text
 * found near an address. Order matters: first match wins.
 */
const EVM_HINTS = [
  ['bsc',   /\b(bsc|bep-?20|bnb(\s+smart)?(\s+chain)?|binance\s+smart\s+chain|bscscan)\b/i],
  ['matic', /\b(polygon|matic|pol\s+network|polygonscan)\b/i],
  ['arb',   /\b(arbitrum|arb\s*one|arbiscan)\b/i],
  ['avax',  /\b(avalanche|avax|c-chain|snowtrace)\b/i],
  ['op',    /\b(optimism|op\s+mainnet|optimistic)\b/i],
  ['eth',   /\b(ethereum|erc-?20|etherscan)\b/i],
];

/** Suggest an EVM chain from a context snippet. Returns a code or null. */
export function suggestEvmChain(context) {
  if (!context) return null;
  for (const [code, re] of EVM_HINTS) if (re.test(context)) return code;
  return null;
}
