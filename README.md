# ScamBusters Triage (Chrome extension, Manifest V3)

A side-panel tool for Intelligence for Good ScamBusters students. On a suspected
crypto-scam site it:

1. detects wallet addresses and validates them with real checksums (15 chains),
2. checks the site in ScamBusters and submits it (with or without wallets),
3. looks up on-chain activity and public name labels for each wallet,
4. runs a keyword-based scam-likelihood heuristic on the page text, and
5. shows domain age (RDAP) and URLScan results.

Plain ES modules and CSS, with no build step. The only third-party code is vendored
(`lib/vendor/noble-hashes`, see below).

## Install (Load unpacked)

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this `scambusters-triage/` folder.
3. Pin the extension, then click its toolbar icon on a page. The side panel opens
   and scans that tab.
4. Open **Settings**, paste your API keys, and optionally turn on **Allow on all
   sites**. That setting is needed for auto-scan on page load and for following tab
   switches without clicking the icon.

Requires Chrome 116 or later (side panel and module service worker).

## API keys

| Service | Needed for | Where to get it | Format check |
|---|---|---|---|
| ScamBusters | check and submit | `/get-api-key` in the ScamBusters Discord (expires after 30 days; `/rotate-api-key`) | `^sb_[0-9a-f]{32}$` |
| URLScan | "Scan now"; search works without a key but is rate-limited | https://urlscan.io/user/profile/ | UUID |
| Etherscan | ETH / Polygon / Arbitrum lookups (Etherscan V2 multichain) | https://etherscan.io/myapikey | 34 alphanumerics |
| Tronscan | TRX lookups (sent as `TRON-PRO-API-KEY`) | https://tronscan.org/#/myaccount/apiKeys | UUID |
| Blockchain.com | optional; the public endpoints work without it | https://www.blockchain.com/explorer/api/api_create_code | UUID |

- **Storage:** keys are stored only in `chrome.storage.local`, never in `sync`.
  They are never logged and never returned to the panel (only a masked preview is).
- **Where keys are sent:** each key goes only to its own service. They travel in
  headers wherever the API allows: ScamBusters `Authorization: Bearer`, URLScan
  `API-Key`, Tronscan `TRON-PRO-API-KEY`.
- **Exception:** Etherscan only accepts the key as the `apikey` query parameter.
  This is documented in `lib/providers/etherscan.js`.
- **Expiry warning:** the panel warns when the ScamBusters key is 25 or more days
  old, because keys expire after 30 days.

### `POST /api/submit` needs approval

A valid key is enough for `GET /api/check`, but **submitting requires your student
account to be approved**. Push your code to GitHub, invite **smabryCFRL** (Sam Mabry)
as a collaborator, then DM Sam Mabry (I4G) in Discord with the repo URL.

The panel tells the two kinds of 403 apart:
- **Not approved:** it shows the approval guidance above.
- **Expired key:** it tells you to run `/rotate-api-key`.

A 503 on submit means the approval check is temporarily unavailable. The API fails
closed, so nothing was submitted; retry shortly.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Settings, keys, the activity log, and persisted rate-limit cooldowns (`local`). Per-tab state and the 10-minute lookup cache (`session`). |
| `activeTab` | Read the page you clicked the toolbar icon or context menu on, with no blanket site access. |
| `scripting` | Inject the read-only content script into that tab's frames on demand. |
| `sidePanel` | The UI is a Chrome side panel. |
| `contextMenus` | "Add selected text as wallet". |
| `optional_host_permissions: <all_urls>` | Only requested when you click **Allow on all sites** (or enable auto-scan). Lets the panel follow tab switches and scan on page load. You can revoke it in Settings. |
| `host_permissions` | Only the API hosts the worker calls: `scambuster.intelligenceforgood.org`, `urlscan.io`, `api.etherscan.io`, `blockchain.info`, `apilist.tronscanapi.com`, `xrplcluster.com`, `api.xrpscan.com`, `api.mainnet-beta.solana.com`, `api.blockcypher.com`, `bsc-dataseed.binance.org`, `api.avax.network`, `mainnet.optimism.io`, `metadata.services.blockscout.com`, `www.walletexplorer.com`, `rdap.org`, `data.iana.org`. |

- **RDAP registry servers:** `rdap.org` redirects to each TLD's own RDAP server.
  Those servers are not listed above. The ones probed send
  `Access-Control-Allow-Origin: *`, so the fetch works without a host permission.
  `rdap.denic.de` (.de) does not, and it fails with a readable error.
- **No `tabs` permission:** for tabs the extension can't access, Chrome hides the
  URL. The panel then says "click the toolbar icon to grant access".

## Security model

- **Content script:**
  - It only reads the DOM (text, attributes, input values, hrefs, open shadow roots).
    It never executes, follows or fetches anything from the page.
  - It never sees keys or network results.
  - All page-derived data is treated as hostile.
- **Side panel:**
  - It renders everything with `textContent` and DOM APIs; there is no `innerHTML`
    anywhere in the extension.
  - CSP: `script-src 'self'; object-src 'self'; img-src 'self' https://urlscan.io`.
- **Network calls on explicit action only:** nothing goes to an external service
  except on a click or a clearly labelled opt-in toggle.
  - Page content never leaves the browser.
  - The page URL goes to URLScan only when you click **Scan now**. Visibility
    defaults to **unlisted**.
  - Wallet addresses go to explorers only for on-chain or label lookups.
- **Wallet re-validation:** every wallet is re-validated in the worker right before
  submit. A wallet that fails validation can never be submitted.

## Architecture

`DESIGN.md` has the message protocol and data shapes. In brief:
- **Service worker** (`background/`): all network calls, the per-provider queue
  (`lib/net/queue.js`: spacing, rolling windows, exponential backoff, persisted
  cooldowns), caching, validation, and per-tab state.
- **MV3 lifecycle:** the worker can be killed at any time.
  - Tab state is mirrored to `chrome.storage.session`. Requests that were in
    flight become "Interrupted, please retry".
  - Cooldowns and ScamBusters 429 lockouts live in `chrome.storage.local`.
  - URLScan polling resumes after a restart.
- **Content script** (`content/content.js`): a classic script, injected into all
  frames on demand. It has a debounced MutationObserver for content added later.
- **Side panel** (`sidepanel/`): UI only. It talks to the worker over a
  long-lived port and reconnects when the worker restarts.

## Wallet validation (`lib/validators/`)

- **Rule source:** adapted from the `wallet_validation` package in
  github.com/benpinpop/urlscan-dashboard (Python, ported from the ScamHunt CTF),
  plus the extras this spec requires.
- **Checksums:** real verification for every chain, with mainnet only:

  | Chain | Rule |
  |---|---|
  | BTC | Base58Check 0x00/0x05, Bech32 v0, Bech32m v1+ (BIP-173/350 version rules) |
  | EVM (6 chains) | EIP-55 via keccak-256 when mixed-case; all-lower/all-upper is tagged "no checksum" |
  | TRX | Base58Check 0x41 |
  | XRP | Base58Check over the Ripple alphabet, plus X-address decoding to classic address + destination tag (XLS-5d, checked against the xrpl.js codec vectors) |
  | LTC | 0x30/0x32 and `ltc1` |
  | DOGE | 0x1e / 0x16 |
  | DASH | 0x4c / 0x10 |
  | BCH | CashAddr polymod, with or without the prefix |
  | ADA | Shelley Bech32, CIP-19 header and length checks |
  | SOL | Base58 decoding to 32 bytes |

- **SOL is low confidence.** It is tagged **unverified** because Solana addresses
  have no checksum. It is auto-detected only from a `solana:` link or
  Solana-related nearby text.
- **Chain ambiguity:**
  - `0x…` defaults to `eth`. Nearby text (BEP20, Polygon, ...) only *suggests*
    another chain; you decide.
  - Legacy `1…`/`3…` is BTC. If you explicitly pick BCH, it is converted to
    CashAddr.
  - LTC `3…` is accepted only when you pick LTC.
- **Dedupe key:** `(chain, normalized)`. EVM addresses are lowercased; Bech32,
  CashAddr and ADA are lowercased because they are case-insensitive; Base58 keeps
  exact case.
- **Input cleaning:** whitespace and zero-width/invisible characters are stripped
  before validating.

## On-chain lookups (`lib/providers/`)

Every adapter returns
`{txCount, volumeIn, volumeOut, balance, usdtBalance, sampled, firstSeen, lastActivity, labels, notes, source, explorerUrl}`.
Amounts are exact decimal strings computed with BigInt; no floats are ever used on
raw amounts.

| Chain | Source | Notes |
|---|---|---|
| eth, matic, arb | Etherscan V2 (`balance`, `txlist`, `tokenbalance`, `tokentx`) | Up to 2 pages × 1000 txs; beyond that, marked "sampled — first N txs". Native volume excludes internal txs. |
| bsc, avax, op | Etherscan V2 if your plan covers them, otherwise the keyless public RPC | **The Etherscan free tier does not cover BSC, Avalanche or Optimism** (observed live). The RPC fallback gives balance, USDT balance and nonce (outgoing tx count only), with no volume. |
| btc | Blockchain.com `rawaddr?limit=0` | Exact totals in one call. |
| trx | Tronscan `accountv2` plus transfer endpoints | Key required; keyless calls get 401. Volume is capped at 200 transfers per list (sampled). |
| xrp | XRPL public JSON-RPC (`xrplcluster.com`) | Balance and a sampled tx count; no volume. |
| sol | Solana public RPC | Balance, sampled signature count, USDT SPL balance. |
| ltc, doge, dash | BlockCypher keyless | Exact totals. Keyless limit is about 100/hr, which the queue enforces. |
| bch, ada | none | "Lookup not supported for this chain yet", with an explorer link. |

USDT contracts were verified on-chain on 2026-10-27 with `symbol()`/`decimals()`
calls. Decimals are read per chain; no single value is hard-coded for all chains.

| Chain | Contract | Decimals |
|---|---|---|
| ETH | `0xdAC17F958D2ee523a2206206994597C13D831ec7` | 6 |
| BSC | `0x55d398326f99059fF775485246999027B3197955` | 18 |
| Polygon | `0xc2132D05D31c914a87C6611C10748AEb04B58e8F` | 6 (now "USDT0") |
| Arbitrum | `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` | 6 ("USD₮0") |
| Avalanche | `0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7` | 6 |
| Optimism | `0x94b008aA00579c1307B0EF2c499aD98a8ce58e58` | 6 |
| Tron | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` | 6 |
| Solana | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` | from the token account |

These were verified on-chain, not against Tether's own web page.

### Address name labels

Labels are fetched with each on-chain lookup and cached with it. Each label has the
shape `{text, source, risk}`.
- **Red:** phishing, scam, blacklisted or sanctioned. Wallets with a red label are
  flagged on Overview.
- **Amber:** caution, such as mixers or gambling.
- **Blue:** neutral, such as exchanges or contracts.

| Chains | Source |
|---|---|
| EVM | Blockscout metadata service (keyless). Etherscan `getsourcecode` contract name when Blockscout has nothing. |
| TRX | Tronscan `accountv2` tags plus `/api/security/account/data` (blacklist and fraud flags) |
| XRP | XRPScan account names (keyless) |
| BTC | WalletExplorer (keyless) |

Not used:
- Etherscan `tokeninfo` and name tags are Pro-only.
- The per-chain Blockscout explorers are unreliable or behind Cloudflare.
- No keyless label source was found for SOL, LTC, DOGE, DASH, BCH or ADA.
- Blockchair blocks keyless clients.

Note that the Tron USDT *contract* itself carries a real Tronscan "blacklist" flag.

## Keyword check (`lib/keywords.js`)

Text is taken from all frames (visible text, title, meta description,
alt/placeholder/aria-label). It is normalized: lowercase, straight quotes,
whitespace collapsed. Keywords are matched on word boundaries.

Scoring:
- Each keyword contributes `weight × min(count, 3)`.
- `crypto_context` hits add no points. They only gate the score: with fewer than 2
  distinct crypto-context hits, the score is halved.
- The 0–100 score is `round(100·(1−e^(−points/30)))`.
- Bands are set by `BAND_THRESHOLDS`: Low < 25 ≤ Medium < 50 ≤ High < 75 ≤ Very high.

Calibration on test pages:

| Test page | Score | Band |
|---|---|---|
| Crypto news | 0 | Low |
| Bakery ad | 11 | Low |
| Typical investment-scam copy | 76 | Very high |

**These thresholds are heuristics. The result is a triage aid, not a verdict.**

"Highlight matches on page" wraps matches in `<mark>` elements and fully restores
the DOM when turned off.

## Tests

```
npm test                                   # node --test "test/*.test.js": validators, keywords, providers (mocked), content (jsdom)
SB_JSDOM_PATH=<dir with jsdom> npm test    # enables the jsdom content-script test (skipped otherwise)
node test/smoke/run-smoke.mjs              # LIVE read-only provider calls; needs test/.env.test (gitignored)
node test/e2e/run-e2e.mjs <thisDir> <dir containing node_modules/puppeteer-core> [--live]
```

`test/e2e/run-e2e.mjs` is a full test in real Chrome (headless, via puppeteer-core):
- It loads a temporary copy of the extension and serves the fixture over http.
- It points the ScamBusters base URL at a **local mock server**, so check and
  submit are exercised end to end without contacting the real API.
- It covers:
  - detection, dedupe, the MutationObserver and re-scan,
  - manual add and the chain switcher,
  - keyword highlighting,
  - every check and submit response mapping, the 429 lockout and the log,
  - restricted pages,
  - screenshots of the real panel.
- `--live` adds a few read-only on-chain lookups using the keys in
  `test/.env.test`.

`test/fixture.html` is a fake scam page. It contains:
- valid addresses for every chain, placed in text, attributes, inputs, hrefs, a
  shadow root and an iframe,
- duplicates, look-alikes and a zero-width-split address,
- addresses injected later,
- scammy copy, and
- an expected-results table.

Serve it over http (for example `npx http-server test`) and open it with the
extension loaded.

`test/.env.test` holds development keys and is gitignored. Never commit it.

## Known limitations

- **Auto-scan needs permission:** auto-scan on load and following tab switches
  require the optional all-sites permission. Otherwise you click the toolbar icon
  per tab (an `activeTab` limitation).
- **Cross-origin iframes:** these are not scanned unless that origin is
  accessible.
- **Byron ADA addresses** (`Ae2…`/`DdzF…`) are not accepted.
- **BCH and ADA lookups:** no keyless lookup source.
- **Etherscan free tier:** it covers only eth, matic and arb. bsc, avax and op fall
  back to the public RPC, which has no volume and counts outgoing transactions
  only.
- **Sampled volumes:** these cover only the first N transactions and are labelled
  that way. There is no USD conversion.
- **ScamBusters 429s:** the API sends no `Retry-After`. The countdown is 60 s for
  the per-minute limit and 15 min for the per-hour limit. That is our assumption.

## Assumptions

1. **URLScan:** submit and result response shapes come from the docs, not a live
   call (we had no key).
   - Result 404 means not ready yet. We poll every 5 s after a 10 s wait, with a
     2.5 min timeout.
   - Search rows carry no verdicts.
2. **Third-party key formats:** URLScan, Tronscan and Blockchain.com keys are
   UUIDs; Etherscan keys are 34 alphanumerics. These formats are as observed.
3. **Blockchain.com key:** an `api_code` is not validated by Blockchain.com, so its
   "Test key" can only confirm the endpoint responds.
4. **Recent-submit warning:** it covers the same site within 10 minutes from this
   browser. "Submit anyway" overrides it.
5. **Removed wallets:** a wallet you remove is not re-added by re-scans of the same
   page. Manual entries survive re-scans.
6. **X-addresses:** they are accepted and stored as classic address + destination
   tag. If the tag is set separately it must match the embedded one.
7. **RDAP:** domains whose TLD has no RDAP service (.io, .co, .me, .ru) show
   "no RDAP data". In Node, `rdap.org` returned 403, so there is an IANA-bootstrap
   fallback. It is unverified whether Chrome hits the same 403.
8. **ScamBusters check:** the "Check site" field defaults to the page origin. A
   toggle switches it to the full URL.

## Vendored code

`lib/vendor/noble-hashes/` contains `@noble/hashes` **1.8.0** (MIT, see LICENSE):
`sha3.js`, `sha2.js`, `_md.js`, `_u64.js`, `utils.js` and `crypto.js`, copied from
the npm package's `esm/` folder. The only change is in `utils.js`: the bare import
`@noble/hashes/crypto` was replaced with `./crypto.js` so it loads without a
bundler.
