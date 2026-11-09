# PayLink — Build Report

Built locally on 2026-11-09 in `~/workspace/nimiq-mini-app/`.
**Nothing was published, pushed, deployed, registered, or submitted** — this is
a local build + verification pass only, per instructions.

## What was built

**PayLink** (Category: **Pay**) — a Nimiq Pay Mini App for payment requests:

- **Create a request:** label + amount + currency (**NIM** or **USDT on
  Polygon**) + receiving address (typed, or filled from the wallet via
  “Use mine”) + optional note. Address format and amount precision are
  validated (NIM: `NQ` + 34 chars; EVM: `0x` + 40 hex; NIM ≤ 5 decimals,
  USDT ≤ 6; amount > 0).
- **Share:** the request is encoded into the URL hash (base64url JSON), so the
  generated **link and QR code** work on any device with no backend. A
  “Open in Nimiq Pay” deep link (`https://nimpay.app/miniapps/open/…`) is
  offered alongside.
- **Pay:** opening a link shows the request with one Pay button.
  - NIM → Mini App SDK `sendBasicTransaction()` → Nimiq Pay native
    confirmation dialog → serialized transaction returned on approval.
  - USDT → `window.ethereum`: `eth_requestAccounts` →
    `wallet_switchEthereumChain` (Polygon `0x89`) → `eth_sendTransaction`
    with a hand-encoded ERC-20 `transfer()` call to the USDT contract.
  - Outside Nimiq Pay (or without an EVM provider for USDT) the page shows a
    clear fallback panel: details remain visible, with manual-payment info
    and the Nimiq Pay deep link.
- **Request list:** stored in `localStorage`; paid/unpaid status can be
  toggled manually, and a request paid in-app from the same device is marked
  paid automatically with its transaction reference stored.
- **Status bar:** inside Nimiq Pay it shows host network, consensus state and
  block height from the SDK; outside it shows an honest “Browser mode” note.

Stack: Vite 8 build (relative `base: './'`), vanilla JS, the real
`@nimiq/mini-app-sdk` **0.2.5** (installed from npm in this VM), `qrcode` for
local QR rendering. Production bundle: **54.8 KB JS (19.3 KB gzip) + 4.9 KB
CSS**, fully static `dist/` output.

## Files

| Path | Contents |
|---|---|
| `index.html` | App shell |
| `src/main.js` | All app logic (routing, storage, payload codec, payments, rendering) |
| `src/style.css` | Mobile-first styling |
| `public/favicon.svg` | Icon |
| `vite.config.js`, `package.json`, `package-lock.json` | Build setup (`npm run dev/build/preview`) |
| `LICENSE` | MIT (competition requirement) |
| `README.md` | User/dev documentation incl. deploy steps |
| `scripts/smoke.mjs` | Headless smoke test harness (jsdom) |
| `dist/` | Built static site, ready to publish as-is |
| `BUILD-REPORT.md` | This file |

## SDK calls used, and where (all in `src/main.js`)

| Call | Function in main.js | Notes |
|---|---|---|
| `init({ timeout: 2500 })` | `detectEnvironment()` | Waits for the injected provider; rejection/timeout ⇒ fallback mode. Re-`init({ timeout: 5000 })` lazily in `getNimiqProvider()` before payments. |
| `getHostNetwork()` (+ `window.nimiqPay.network` fallback) | `detectEnvironment()` | Status bar + chip. |
| `getHostLanguage()` (+ `window.nimiqPay.language` fallback) | module scope | Date formatting locale. |
| `isConsensusEstablished()`, `getBlockNumber()` | `refreshChainStatus()` | Non-wallet status RPCs; failures ignored by design. |
| `listAccounts()` | `connectNimAddress()` | Behind the “Use mine” button (user gesture, since account access prompts in the wallet). |
| `on('accountsChanged')` | `detectEnvironment()` | Keeps displayed account in sync. |
| `sendBasicTransaction({ recipient, value })` | `payWithNim()` | Value in luna via exact string→BigInt conversion. Resolves with the serialized transaction (see gaps). Rejections handled via `NimiqProviderError.is()`. |
| `window.ethereum.request('eth_requestAccounts')` | `connectEvmAddress()`, `payWithUsdt()` | Per official “Using EVM Tokens in Mini Apps” docs. |
| `window.ethereum.request('wallet_switchEthereumChain', 0x89)` | `payWithUsdt()` | Error 4902 (chain not configured) is surfaced with a plain message. |
| `window.ethereum.request('eth_sendTransaction', …)` | `payWithUsdt()` | `transfer()` calldata hand-encoded (selector `0xa9059cbb` + padded address + padded uint256); USDT contract `0xc2132D05D31c914a87C6611C10748AEb04B58e8F`, 6 decimals — both taken verbatim from the official docs page. Returns the tx hash → Polygonscan link shown. |

## Verification performed

- **SDK/docs grounding:** `@nimiq/mini-app-sdk@0.2.5` was installed from npm
  and its shipped TypeScript definitions (`dist/index.d.ts`,
  `dist/provider.d.ts`) and README were read before coding; the USDT flow
  follows the official docs page “Using EVM Tokens in Mini Apps”
  (nimiq.dev/mini-apps/features/evm-tokens) exactly.
- **Build:** `npm run build` (Vite) succeeds cleanly; output inspected.
- **Headless smoke test:** the managed Chromium in this VM refuses CLI
  startup (“Hatch WebGL domain policy is required for browser startup”), so
  the built site was served locally (`python3 -m http.server` over `dist/`)
  and exercised with **jsdom** (`scripts/smoke.mjs`; the identical production
  bundle is executed as a classic script because jsdom 24 does not run
  `type="module"` scripts — the bundle contains no top-level import/export,
  which was verified). **16/16 checks pass:**
  - home renders; environment detection settles into “Browser mode” fallback;
  - create form works end-to-end → request written to `localStorage`, share
    card + payload link rendered, request appears in the list;
  - mark-paid toggle persists `status: 'paid'`;
  - pay page renders label/amount/recipient, shows the “Open this link
    inside Nimiq Pay to pay” fallback notice and the pay button;
  - **zero uncaught JS errors** on both routes.
  - A supplementary pass (USDT pay page, Unicode/emoji label) passed **5/5**,
    including the POL-gas hint and no-provider fallback.
- **Bug found & fixed during smoke:** payload encoding originally used
  `TextEncoder`/`TextDecoder`, which jsdom (and potentially older WebViews)
  lack. Encoding now uses a UTF-8-safe base64 path
  (`encodeURIComponent`/`escape`) with no such dependency. Also hardened:
  optional-chained `scrollIntoView`, guarded `window.scrollTo`.

## What is NOT verified (needs a real Nimiq Pay host)

- The **in-Nimiq Pay live behaviour**: `init()` resolving against a real
  injected `window.nimiq`, the native confirmation dialogs for
  `listAccounts()` / `sendBasicTransaction()`, consensus/block values, and
  the `accountsChanged` event. The code follows the SDK's shipped types and
  README semantics, but no Nimiq Pay app exists in this VM to run against.
- The **USDT transfer on Polygon** through Nimiq Pay's EVM provider
  (chain switch + `eth_sendTransaction`) — implemented exactly per the
  official worked example, not executed against a live wallet.
- QR canvas rendering inside the Nimiq Pay WebView (works in browsers;
  wrapped in try/catch so a canvas failure can never break the pay flow).

## SDK / doc gaps and notes

- `init()` has a default 10 s timeout; without passing a short `timeout`,
  fallback detection outside Nimiq Pay would hang the UI. We pass 2.5 s and
  render the UI immediately, refining when detection completes.
- `sendBasicTransaction()` resolves with the **serialized transaction**, not
  a transaction hash — so the UI honestly says “Payment sent / submitted by
  the wallet” and stores a reference tail rather than inventing an explorer
  link for NIM. (USDT via EVM does return a hash.)
- The SDK README notes `listAccounts()` returns the wallet address first,
  followed by the HTLC address holding spendable NIM — we use `accounts[0]`
  as the receiving address, matching the docs' own examples.
- No gap was found in the EVM-token docs: contract address, decimals,
  chain id and the full send pattern are all given in one worked example.

## Still needed from the main agent / user (not done here)

1. **GitHub:** create a **public** repo, push this directory (competition
   requires public + MIT — `LICENSE` is included; adjust the copyright holder
   name in `LICENSE` if desired), enable **GitHub Pages** on `dist/`
   (branch or Actions workflow — see README).
2. **Nimiq wallet payout address** (NQ…) for the submission form — must be
   the entrant's own wallet; also the address to receive USDC prizes.
3. **Registration + submission** at miniappscompetition.com (register, then
   submit via the GitHub-connected portal) with **Category: Pay**, before
   **Nov 11, 2026, 23:59 UTC**. Draft description (≤ 250 words) is ready to
   paste:

   > PayLink makes asking for crypto as easy as sending a link. Create a
   > payment request — a label, an amount in NIM or USDT, and your address —
   > and share it anywhere as a link or QR code. The request travels inside
   > the link itself, so there is no server, no account, and nothing to sign
   > up for. When the payer opens it inside Nimiq Pay, they see exactly who
   > is asking and how much, and pay with one tap: NIM payments go through
   > the Mini App SDK's native wallet confirmation, and USDT payments are
   > sent as an ERC-20 transfer on Polygon through the wallet's EVM
   > provider. Creators track their requests in the app and mark them paid
   > as payments land. PayLink is for splitting bills, invoices, tips, and
   > everyday person-to-person payments — built entirely on Nimiq Pay, with
   > payments as the core of the experience.

4. **Demo video** (optional for the main prize but encouraged; **required,
   3–5 min**, attached to the Skool Demo Day post to be eligible for the
   live demo slot and the $25 USDC raffle).
5. **Promotion points (5 pts):** a public shout-out post about PayLink / the
   competition (3 pts) and a post in the Skool community (2 pts).
6. **Real Usage points (up to 15):** get real users to open the app inside
   Nimiq Pay (25+ users for full points) — share the `nimpay.app` deep link.
7. **Demo Day:** Nov 11 — sources conflict on 15:00 vs 16:00 UTC; join Zoom
   at **15:00 UTC** to be safe. Registration is the Skool comment described
   in step 4.
8. **First live test:** open the deployed URL inside the real Nimiq Pay app
   on testnet and run one small NIM payment + one USDT payment end-to-end
   before the deadline, to close the “not verified” items above.
