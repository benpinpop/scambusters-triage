# ScamBusters Triage

A Chrome side-panel extension for Intelligence for Good ScamBusters students. Open it on a suspected crypto-scam site and it will:

- **Find wallet addresses** on the page and check them with real checksums (15 chains)
- **Check the site in ScamBusters** and submit it, with or without wallets
- **Look up on-chain activity** and public name labels for each wallet
- **Score the page text** for scam language
- **Show domain age** (RDAP) and URLScan results

No build step: plain ES modules and CSS.

| Overview | Wallets |
|---|---|
| <img src="docs/screenshots/overview.png" width="380" alt="Overview tab: ScamBusters check, submit result and domain info"> | <img src="docs/screenshots/wallets.png" width="380" alt="Wallets tab: detected wallets with checksum status"> |

| On-chain | Content | Log |
|---|---|---|
| <img src="docs/screenshots/onchain.png" width="300" alt="On-chain tab: balances and volumes per wallet"> | <img src="docs/screenshots/content.png" width="300" alt="Content tab: keyword scam score"> | <img src="docs/screenshots/log.png" width="300" alt="Log tab: history of checks and submissions"> |

## Install

You need Chrome 116 or later.

1. Download or clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `scambusters-triage` folder.
4. Pin the extension, then click its icon on any page. The side panel opens and scans that tab.
5. Open **Settings** and paste your API keys (see below).

Optional: in Settings, click **Allow on all sites** to scan automatically on page load and follow tab switches. Without it, click the icon on each tab.

## API keys

Only the ScamBusters key is required. The others unlock extra features.

| Service | Used for | Get it |
|---|---|---|
| ScamBusters (required) | Check and submit | `/get-api-key` in the ScamBusters Discord. Expires after 30 days; use `/rotate-api-key`. |
| URLScan | "Scan now" (search works without a key, but is rate-limited) | https://urlscan.io/user/profile/ |
| Etherscan | ETH, Polygon and Arbitrum lookups | https://etherscan.io/myapikey |
| Tronscan | TRX lookups | https://tronscan.org/#/myaccount/apiKeys |
| Blockchain.com | Optional; BTC works without it | https://www.blockchain.com/explorer/api/api_create_code |

Keys are stored only in your browser (`chrome.storage.local`), never logged, and each is sent only to its own service. Etherscan only accepts keys as a URL parameter; the others use headers.

### Submitting needs approval

A valid key lets you **check** sites. To **submit**, your student account must be approved: push your code to GitHub, invite **smabryCFRL** (Sam Mabry) as a collaborator, then DM Sam Mabry (I4G) in Discord with the repo URL. The panel tells you whether a 403 means "not approved" or "key expired".

## How to use it

1. **Overview:** check the site in ScamBusters, look up domain age, search or run a URLScan.
2. **Wallets:** review the detected wallets. Add missing ones by hand, remove false positives, and fix the chain on ambiguous `0x…` addresses.
3. **On-chain:** look up balances, volume, first and last activity, and name labels. Red labels (scam, phishing, sanctioned) are flagged on Overview.
4. **Content:** run the keyword check. The score is a triage aid, not a verdict.
5. **Submit:** use the button at the bottom to send the site, with the selected wallets, to ScamBusters.
6. **Log:** every check and submission, with IDs you can copy or export.

## Supported chains

| Wallet checksum | On-chain lookup |
|---|---|
| BTC, ETH and EVM (BSC, Polygon, Arbitrum, Avalanche, Optimism), TRX, XRP, LTC, DOGE, DASH, BCH, ADA, SOL | ETH, Polygon, Arbitrum (Etherscan), BTC, TRX, XRP, SOL, LTC, DOGE, DASH. BSC, Avalanche and Optimism give balance only (free Etherscan tier). BCH and ADA show an explorer link only. |

SOL addresses have no checksum, so they are marked **unverified**. EVM addresses default to ETH; nearby text such as "BEP20" only suggests another chain.

## Privacy and security

- The extension only reads the page. Page content never leaves your browser.
- Nothing is sent anywhere unless you click. The page URL goes to URLScan only when you click **Scan now** (unlisted by default). Wallet addresses go to block explorers only for lookups.
- All page data is treated as hostile and rendered as plain text (no `innerHTML`).
- Wallets are re-validated right before submit, so an invalid one can never be sent.
- Permissions: `storage`, `activeTab`, `scripting`, `sidePanel`, `contextMenus`, host access to the API hosts listed in `manifest.json`, and optional all-sites access that you grant yourself.

## Known limits

- Auto-scan needs the optional all-sites permission.
- Cross-origin iframes are not scanned unless that origin is accessible.
- Volumes are sampled (first 200 to 2,000 transactions) and labelled as such. There is no USD conversion.
- Domains whose TLD has no RDAP service (.io, .co, .me, .ru) show "no RDAP data".
- Byron-era ADA addresses are not accepted.
- ScamBusters rate-limit countdowns (60 s per minute, 15 min per hour) are our assumption; the API sends no `Retry-After`.

## For developers

```
npm test                          # validators, keywords, providers (mocked), content (jsdom)
node test/smoke/run-smoke.mjs     # live read-only provider calls; needs test/.env.test
node test/e2e/run-e2e.mjs <thisDir> <dir containing node_modules/puppeteer-core>
```

- `DESIGN.md` has the message protocol and data shapes.
- `background/` is the service worker (all network calls, queueing, caching, per-tab state). `content/` is the read-only page scanner. `sidepanel/` is UI only. `lib/` holds validators, providers and keyword scoring.
- `test/fixture.html` is a fake scam page with valid addresses for every chain. Serve it (`npx http-server test`) and open it with the extension loaded.
- `test/.env.test` holds your own Etherscan and Tronscan keys for live tests (`ETHERSCAN_API_KEY=…`, `TRONSCAN_API_KEY=…`). It is gitignored; never commit it.
- Vendored code: `lib/vendor/noble-hashes/` is `@noble/hashes` 1.8.0 (MIT) with one import path changed so it loads without a bundler.
