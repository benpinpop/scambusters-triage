# ScamBusters Triage: design note

Short reference for how the pieces fit. README.md is the user-facing doc.

## File layout

```
scambusters-triage/
  manifest.json
  package.json                 "type":"module", npm test -> node --test
  background/
    service-worker.js          entry (module). Router, tab tracking, orchestration
    state.js                   TabState store (memory + chrome.storage.session mirror)
    settings.js                settings + API key storage (chrome.storage.local)
    scambusters.js             GET /api/check, POST /api/submit client + response mapping
    log.js                     submission/activity log (chrome.storage.local)
  content/
    content.js                 classic script, injected on demand. Reads DOM only.
  sidepanel/
    panel.html  panel.css  panel.js  (+ panel modules)
  lib/
    chains.js                  chain codes, aliases, explorers, EVM chain hints
    errors.js                  ServiceError + toPlainError
    decimal.js                 BigInt amount formatting
    net/queue.js               per-provider throttled queue, backoff, persisted cooldowns
    validators/                address validators (pure, sync, Node-testable)
      index.js                 validateAddress(), classifyCandidate(), cleanInput()
    providers/                 on-chain adapters, one module per provider
      index.js                 lookupWallet(chain, address, keys) dispatcher
      etherscan.js blockchain.js tronscan.js xrpl.js solana.js blockcypher.js
    intel/
      rdap.js urlscan.js       domain intel + URLScan clients
    keywords.js                CSV parser, text normalizer, scorer
    keys.js                    API key format checks
    vendor/noble-hashes/       @noble/hashes 1.8.0 (sha256, keccak_256), vendored
  data/crypto_scam_keywords.csv
  test/                        node:test unit tests, fixture.html, smoke/ (live, gitignored keys)
```

## Trust boundaries

- **Content script** runs in the page's isolated world. It never receives keys or
  network results. It exposes `globalThis.__sbTriage = { scan(), collectText(),
  highlight(phrases), clearHighlight() }` inside the isolated world only.
  The worker calls these with `chrome.scripting.executeScript({ func, allFrames })`
  and gets per-frame return values. The only message the content script *sends*
  on its own is `content/mutation` (debounced MutationObserver result).
- **Service worker** is the only code that talks to the network or reads keys.
  It validates every candidate address with `lib/validators` before it can enter
  a wallet list.
- **Side panel** is UI only. It never touches keys after saving them (it only
  ever gets a masked preview) and renders all page-derived data with
  `textContent`.

## Page access

No blanket host permission is requested at install. The worker scans a tab when:
1. `activeTab` was granted (user clicked the toolbar icon or the context menu on
   that tab), or
2. the user opted in to `optional_host_permissions: ["<all_urls>"]` from Settings
   (needed for "Auto-scan on page load" and for following tab switches without
   clicking the icon).
Otherwise the TabState reports `page.kind = "no_access"` and the panel explains
how to grant access.

## Content script API (isolated world)

`scan()` returns
```js
{ frameUrl, isTop, durationMs,
  candidates: [ { raw, context, source: 'text'|'attr'|'input'|'href'|'shadow', scheme?: 'bitcoin'|'ethereum'|... , attr?: 'value'|'data-x'|... } ] }
```
Candidates are deduped per frame by `raw` (the first context wins, up to 3 contexts kept
as `contexts`). `context` is <= 120 chars of surrounding text, whitespace-collapsed.

`collectText()` returns `{ frameUrl, isTop, title, metaDescription, text }` where
`text` already includes visible text plus alt/placeholder/aria-label/title attribute
values (capped at 500 kB per frame).

`highlight(phrases: string[])` wraps matches in `<mark data-sb-triage>` and returns
`{ count }`. `clearHighlight()` unwraps them and normalizes text nodes.

Content -> worker message: `{ type: 'content/mutation', result: <scan() result> }`.

## Panel <-> worker protocol

Panel opens `chrome.runtime.connect({ name: 'sidepanel' })` and reconnects on
disconnect (the worker can be killed). Every request carries a `reqId`:

```js
panel  -> worker  { reqId, type, ...payload }
worker -> panel   { type: 'response', reqId, ok: true, data }      // or
                  { type: 'response', reqId, ok: false, error: PlainError }
worker -> panel   { type: 'state', state: TabState }               // pushed on any change to the active tab
worker -> panel   { type: 'settings', settings: Settings, keys: KeysStatus }
```

Request types (payload fields):

| type | payload | data |
|---|---|---|
| `panel/hello` | `{ windowId }` | `{ state, settings, keys }` |
| `scan/run` | `{}` | `{ added, rejected }` |
| `wallet/add` | `{ input, chain: 'auto'\|code, xrpDestTag? }` | `{ wallet }` or ok:false (`error.code = 'invalid_address'`, `error.message` = reason) or `{ needsChain: true, options: [codes] }` |
| `wallet/remove` | `{ walletId }` | `{}` |
| `wallet/setChain` | `{ walletId, chain }` | `{ wallet }` (EVM only; re-runs lookup if it had one) |
| `wallet/select` | `{ walletId \| null, selected, all?: true }` | `{}` |
| `wallet/setDestTag` | `{ walletId, tag }` | `{}` (tag must be digits, 0..4294967295) |
| `sb/check` | `{ siteUrl }` | CheckResult |
| `sb/submit` | `{ siteUrl, walletIds: [] , force?: bool }` | SubmitResult, or ok:false with `error.code = 'recent_submit'` (panel asks then resends with `force: true`) |
| `onchain/lookup` | `{ walletId \| null (all), force?: bool }` | `{}` (results arrive via state) |
| `keywords/run` | `{}` | KeywordResult |
| `keywords/highlight` | `{ on: bool }` | `{ count }` |
| `rdap/lookup` | `{}` | RdapResult |
| `urlscan/search` | `{}` | UrlscanSearchResult |
| `urlscan/scan` | `{ url, visibility: 'public'\|'unlisted'\|'private' }` | `{}` (progress via state) |
| `settings/set` | `{ patch }` | `{ settings }` |
| `keys/save` | `{ service, value }` | `{ keys }` or ok:false `invalid_format` |
| `keys/clear` | `{ service }` | `{ keys }` |
| `keys/test` | `{ service }` | `{ message }` |
| `log/list` | `{}` | `{ entries }` |
| `log/clear` | `{}` | `{}` |

`service` is one of `scambusters | urlscan | blockchain | etherscan | tronscan`.

## Data shapes

```js
PlainError = { code, message, status?, retryAfterMs?, guidance?, details? }   // details: string[] for 400 errors[]

Slot<T> = { status: 'idle'|'loading'|'done'|'error', data?: T, error?: PlainError, at?: ms, retryAt?: ms }

TabState = {
  tabId, url, origin, hostname,
  page: { kind: 'ok'|'restricted'|'no_access'|'loading', reason? },
  scan: { status, at, frames, durationMs, error? },
  wallets: Wallet[],
  rejected: Rejected[],
  check: Slot<CheckResult>,
  submit: Slot<SubmitResult>,
  onchain: { [walletId]: Slot<OnchainResult> },
  keywords: Slot<KeywordResult> & { highlighted: boolean },
  rdap: Slot<RdapResult>,
  urlscan: { search: Slot<UrlscanSearchResult>, scan: Slot<UrlscanScanResult> & { phase?: 'submitting'|'waiting'|'done', uuid? } },
}

Wallet = {
  id,                 // `${chain}:${normalized}`
  chain,              // canonical code
  address,            // as found (original case), what gets submitted
  normalized,         // lowercase for EVM, exact for others
  family,             // 'evm'|'btc'|'trx'|'xrp'|'ltc'|'doge'|'dash'|'bch'|'ada'|'sol'
  validation,         // 'checksum' | 'no_checksum' | 'unverified'
  kind,               // human label, e.g. 'P2PKH', 'Bech32 (v0 P2WPKH)', 'EIP-55', 'CashAddr P2PKH'
  source,             // 'auto' | 'manual'
  contexts: string[], // up to 3 snippets (untrusted text)
  foundIn,            // 'text'|'attr'|'input'|'href'|'shadow'|'manual'|'context-menu'
  suggestedChain,     // EVM only: code suggested from context, or null
  selected,           // include in submission
  xrpDestTag,         // string of digits or ''
}

Rejected = { raw, chainGuess, reason, context }

CheckResult = { ...raw API fields (site_url, site_key, has_wallets, latest_wallet_collected_utc, stale, is_reported, site_status),
                state: 'has_wallets'|'stale'|'no_wallets'|'unsubmitted', queriedUrl }

SubmitResult = { httpStatus: 201|200, status: 'queued'|'duplicate', submission_id?, submission_key, queued_ts_utc, site_url, wallet_count }

OnchainResult = {
  chain, address, nativeSymbol,
  txCount: number|null,
  balance: string|null,               // decimal string, native units
  usdtBalance: string|null,           // decimal string, USDT; null = not applicable/unknown
  volumeIn:  { native: string|null, usdt: string|null },
  volumeOut: { native: string|null, usdt: string|null },
  sampled: false | { native?: number, usdt?: number },   // N txs examined when truncated
  firstSeen: ISO|null, lastActivity: ISO|null,
  notes: string[],                    // caveats to display
  source: 'Etherscan V2'|'Blockchain.com'|...,
  explorerUrl,
}

KeywordResult = { score: 0..100, band: 'Low'|'Medium'|'High'|'Very high', cryptoContext: bool, cryptoHits,
                  categories: [{ category, hits, points }], top: [{ keyword, category, weight, count, points }],
                  frames, chars }

RdapResult = { domain, registrar, created: ISO|null, updated, expires, ageDays, status: [], nameservers: [], source }
UrlscanSearchResult = { total, results: [ { uuid, time, url, ip, asn, asnname, country, server, screenshot, resultUrl, verdictScore?, malicious? } ] }
UrlscanScanResult = { uuid, resultUrl, screenshot, verdict: { score, malicious, categories, brands }, page: { ip, asn, asnname, country, server, domain, url } }

Settings = { autoScan: false, autoOnchain: false, autoCheck: true, urlscanVisibility: 'unlisted' }
KeysStatus = { [service]: { state: 'saved'|'not_set'|'invalid', masked?, savedAt?, ageDays?, warn? } }
```

## Service worker lifecycle

- TabState lives in memory and is mirrored (debounced 250 ms) to
  `chrome.storage.session` under `tab:<id>`; the worker rehydrates on wake.
  Slots persisted as `loading` are converted to `error: interrupted` on rehydrate.
- Queue timing, cooldowns and rolling-window history are persisted by
  `lib/net/queue.js` (session, or local for hour-long windows).
- On-chain results are cached in `chrome.storage.session` for 10 min keyed by
  `onchain:<chain>:<normalized>`.
- Recent submits (`recentSubmits`) and the log live in `chrome.storage.local`.
