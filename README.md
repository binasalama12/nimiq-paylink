# PayLink — Payment Requests for Nimiq Pay

**Category: Pay** · Nimiq Mini Apps Competition, Cycle 3

PayLink lets anyone create a **payment request** — a label, an amount, and your
receiving address — and share it as a **link or QR code**. Whoever opens the link
inside **Nimiq Pay** can pay it in one tap: the wallet shows its native
confirmation dialog and PayLink never touches funds, keys, or a server.

- 💸 **Two currencies:** NIM (native Nimiq payment) and USDT on Polygon (ERC-20)
- 🔗 **Serverless sharing:** the request travels inside the link itself (base64url
  payload in the URL hash), so links work anywhere, forever, with no backend
- 📱 **Built for the Nimiq Pay WebView:** mobile-first, detects Nimiq Pay via the
  Mini App SDK, shows network / block height / consensus in the status bar
- 🖥️ **Graceful browser fallback:** outside Nimiq Pay, requests can still be
  created, viewed and shared; the pay page explains how to open the link inside
  Nimiq Pay (with a one-tap `nimpay.app` deep link) and shows the raw details for
  manual payment

## How it works

### Creating a request
1. Enter a label (e.g. “Dinner split”), an amount, and pick **NIM** or **USDT**.
2. Enter your receiving address — or tap **Use mine** inside Nimiq Pay and
   PayLink fills it from your wallet (`listAccounts()` for NIM,
   `eth_requestAccounts` for USDT/EVM).
3. PayLink stores the request locally (browser `localStorage`) and renders a
   shareable link + QR code.

### Paying a request
Opening a PayLink link shows the request and a single Pay button:

- **NIM:** the Mini App SDK's `sendBasicTransaction({ recipient, value })`
  asks Nimiq Pay to sign and send the payment (value converted to luna,
  1 NIM = 100,000 luna). Nimiq Pay shows the native confirmation dialog.
- **USDT:** the app switches the wallet's EVM provider to Polygon
  (`wallet_switchEthereumChain`, chain `0x89`) and sends an ERC-20
  `transfer()` call to the USDT contract
  (`0xc2132D05D31c914a87C6611C10748AEb04B58e8F`, 6 decimals) via
  `eth_sendTransaction`. A small POL balance is needed for gas.

After the wallet confirms, the requester sees the payment immediately; on the
creator's device the request can be marked **paid/unpaid** in the request list
(a request paid from the same device is marked automatically and stores the
transaction reference).

## Nimiq Pay integration (SDK surface used)

Built against the real [`@nimiq/mini-app-sdk`](https://www.npmjs.com/package/@nimiq/mini-app-sdk)
**v0.2.5** and the official docs at [nimiq.dev/mini-apps](https://nimiq.dev/mini-apps):

| API | Where | Purpose |
|---|---|---|
| `init({ timeout })` | environment detection | Waits for the injected Nimiq provider; rejection ⇒ browser fallback mode |
| `listAccounts()` | create form, “Use mine” | Fills the creator's Nimiq receiving address |
| `sendBasicTransaction()` | pay page (NIM) | Requests the NIM payment through the wallet's native dialog |
| `isConsensusEstablished()`, `getBlockNumber()` | status bar | Live chain status inside Nimiq Pay |
| `getHostNetwork()`, `getHostLanguage()` | status bar, dates | Host network (mainnet/testnet) and UI language |
| `accountsChanged` event | state | Keeps the shown account in sync |
| `window.ethereum` (`eth_requestAccounts`, `wallet_switchEthereumChain`, `eth_sendTransaction`) | USDT flow | ERC-20 USDT transfer on Polygon, per the docs' “Using EVM Tokens in Mini Apps” |

Wallet errors are surfaced via `NimiqProviderError` (`type` + `message`), e.g.
when a user cancels the confirmation dialog.

## Run it locally

```bash
npm install
npm run dev        # Vite dev server
npm run build      # production build into dist/
npm run preview    # serve the production build
```

There is no backend and no configuration. `dist/` is a fully static site.

### Smoke test

`scripts/smoke.mjs` loads the **built** site headlessly (jsdom), verifies the
fallback rendering, drives the create-request form end-to-end (localStorage +
share card), toggles a request to paid, and loads a pay page — asserting no
uncaught JS errors. It needs a static server for `dist/` and jsdom available:

```bash
npm run build
npx serve dist -p 8077 &          # any static server on :8077 works
npm i --no-save jsdom@24          # or provide jsdom on NODE_PATH
node --experimental-vm-modules scripts/smoke.mjs
```

Latest result: **16/16 checks pass** (see BUILD-REPORT.md), plus a supplementary
USDT/Unicode pay-page pass (5/5).

## Deploy to GitHub Pages

Vite is configured with `base: './'`, so the build works from any path
(domain root or project subpath).

1. Push this repository to GitHub (MIT licensed — the competition requires a
   public repo).
2. Either serve the `dist/` folder (e.g. commit it to a `gh-pages` branch), or
   use a GitHub Actions static-pages workflow that runs `npm ci && npm run build`
   and uploads `dist/`.
3. Open the published URL once in a normal browser (fallback mode), then open
   it inside Nimiq Pay via `https://nimpay.app/miniapps/open/<your-host>/<path>`.

## Architecture

```
index.html          App shell (loads src/main.js as a module)
src/main.js         All app logic: environment detection, routing (#/ and #/pay/<payload>),
                    request CRUD on localStorage, share-link payload codec,
                    NIM payment via Mini App SDK, USDT payment via window.ethereum, QR rendering
src/style.css       Mobile-first styling (Nimiq-blue → green gradient, card UI)
public/favicon.svg  App icon
vite.config.js      Vite config (relative base for static hosting anywhere)
scripts/smoke.mjs   Headless smoke test for the production build
```

Design choices worth knowing:

- **Payload-in-link:** a request is `{ v, id, label, amount, currency, recipient,
  note, createdAt }`, JSON-encoded as base64url in the URL hash. No database, no
  accounts, nothing to leak or take down. Paid status is local bookkeeping on
  the creator's device (plus automatic marking when payment happens in-app).
- **Exact money math:** amounts are converted to smallest units with string
  math + `BigInt` (5 decimals for NIM luna, 6 for USDT) — no float rounding.
- **Validation:** Nimiq (`NQ…`, 36 chars) and EVM (`0x…`, 40 hex) address
  formats are checked before a request can be created; amounts must be > 0 and
  within the currency's decimal precision.
- **No secrets, ever:** the app holds no keys and no credentials; every payment
  is requested from the wallet and confirmed by the user in Nimiq Pay's native
  dialogs.

## Competition notes

- **Competition:** Nimiq Mini Apps Competition — Cycle 3 (deadline
  **Nov 11, 2026, 23:59 UTC**), category **Pay** (bill splitting / invoices /
  payment requests are named Pay-theme examples).
- **License:** MIT (see `LICENSE`), as required by the competition rules.
- PayLink is fully functional end-to-end: create → share → open in Nimiq Pay →
  wallet-confirmed payment → paid status. No mockups, no placeholder flows.
