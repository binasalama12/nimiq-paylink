/**
 * PayLink — payment requests for Nimiq Pay.
 *
 * Create a payment request (label + amount in NIM or USDT), share it as a
 * link/QR code, and let the recipient pay it in one tap inside Nimiq Pay:
 *  - NIM   -> @nimiq/mini-app-sdk `sendBasicTransaction()` (native Nimiq Pay dialog)
 *  - USDT  -> `window.ethereum` ERC-20 `transfer()` on Polygon (native Nimiq Pay dialog)
 *
 * Outside Nimiq Pay the app runs in a graceful fallback mode: requests can be
 * created, viewed and shared, and the pay page explains how to open the link
 * inside Nimiq Pay.
 */
import { init, getHostNetwork, getHostLanguage, NimiqProviderError } from '@nimiq/mini-app-sdk'
import QRCode from 'qrcode'
import './style.css'

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** USDT (Tether) contract on Polygon — from the official Mini Apps docs. */
const USDT_POLYGON = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'
const POLYGON_CHAIN_ID = '0x89' // 137
/** Smallest-unit decimals: NIM uses luna (1 NIM = 1e5 luna), USDT uses 6. */
const DECIMALS = { NIM: 5, USDT: 6 }
const STORAGE_KEY = 'paylink.requests.v1'
const APP_NAME = 'PayLink'

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  /** @type {import('@nimiq/mini-app-sdk').NimiqProvider | null} */
  nimiq: null,
  inside: false, // running inside Nimiq Pay with a live Nimiq provider
  detected: false, // environment detection finished
  network: undefined, // 'mainnet' | 'testnet' | undefined (outside Nimiq Pay)
  blockNumber: null,
  consensus: null,
  accounts: { nim: null, evm: null },
  sharedId: null, // request id whose share card is open on the home view
  formError: '',
}

const hostLanguage = (() => {
  try {
    return getHostLanguage() || window.nimiqPay?.language || undefined
  } catch {
    return undefined
  }
})()

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const $app = document.getElementById('app')

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Convert a decimal string ("12.5") to smallest units (BigInt), exactly. */
function toSmallestUnits(amountStr, decimals) {
  const [whole, frac = ''] = String(amountStr).split('.')
  if (!/^\d+$/.test(whole) || (frac && !/^\d+$/.test(frac))) throw new Error('Invalid amount')
  if (frac.length > decimals) throw new Error(`Too many decimal places (max ${decimals})`)
  return BigInt(whole + frac.padEnd(decimals, '0'))
}

function isValidAmount(amountStr, currency) {
  if (!/^\d+(\.\d+)?$/.test(amountStr)) return false
  try {
    return toSmallestUnits(amountStr, DECIMALS[currency]) > 0n
  } catch {
    return false
  }
}

/** Nimiq addresses: "NQ" + 34 base32 chars (spaces are cosmetic). */
function normalizeNimiqAddress(a) {
  return String(a || '').replace(/\s+/g, '').toUpperCase()
}
function isValidNimiqAddress(a) {
  return /^NQ[0-9A-Z]{34}$/.test(normalizeNimiqAddress(a))
}
function isValidEvmAddress(a) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(a || '').trim())
}
function isValidRecipient(currency, recipient) {
  return currency === 'NIM' ? isValidNimiqAddress(recipient) : isValidEvmAddress(recipient)
}

function shortAddr(a) {
  if (!a) return ''
  return a.length > 18 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a
}

function fmtDate(ms) {
  try {
    return new Intl.DateTimeFormat(hostLanguage, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms))
  } catch {
    return new Date(ms).toLocaleString()
  }
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/* ------------------------------------------------------------------ */
/* Request storage (localStorage)                                      */
/* ------------------------------------------------------------------ */

function loadRequests() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function saveRequests(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {
    /* storage unavailable (private mode etc.) — app keeps working in-memory */
  }
}

function upsertRequest(req) {
  const list = loadRequests()
  const i = list.findIndex((r) => r.id === req.id)
  if (i >= 0) list[i] = req
  else list.unshift(req)
  saveRequests(list)
}

function findRequest(id) {
  return loadRequests().find((r) => r.id === id) || null
}

function deleteRequest(id) {
  saveRequests(loadRequests().filter((r) => r.id !== id))
}

function setPaid(id, paid, txRef) {
  const req = findRequest(id)
  if (!req) return
  req.status = paid ? 'paid' : 'unpaid'
  req.paidAt = paid ? Date.now() : undefined
  req.txRef = paid ? txRef || req.txRef : undefined
  upsertRequest(req)
}

/* ------------------------------------------------------------------ */
/* Share links: the full request travels inside the URL hash, so a     */
/* link works on any device without a backend.                         */
/* ------------------------------------------------------------------ */

function encodePayload(req) {
  const payload = {
    v: 1,
    id: req.id,
    label: req.label,
    amount: req.amount,
    currency: req.currency,
    recipient: req.recipient,
    note: req.note || '',
    createdAt: req.createdAt,
  }
  // UTF-8-safe base64url without depending on TextEncoder (missing in some WebViews/harnesses)
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))))
  return b64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function decodePayload(b64url) {
  try {
    const b64 = b64url.replaceAll('-', '+').replaceAll('_', '/')
    const obj = JSON.parse(decodeURIComponent(escape(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')))))
    if (!obj || obj.v !== 1 || !obj.label || !obj.amount || !obj.recipient) return null
    if (!['NIM', 'USDT'].includes(obj.currency)) return null
    return obj
  } catch {
    return null
  }
}

function requestLink(req) {
  return `${location.origin}${location.pathname}#/pay/${encodePayload(req)}`
}

/** Deep link that opens this app (at the pay page) inside Nimiq Pay. */
function nimiqPayOpenLink(req) {
  const hostPath = `${location.host}${location.pathname}`
  return `https://nimpay.app/miniapps/open/${hostPath}#/pay/${encodePayload(req)}`
}

/* ------------------------------------------------------------------ */
/* Nimiq Pay environment                                               */
/* ------------------------------------------------------------------ */

async function detectEnvironment() {
  try {
    state.network = getHostNetwork() ?? window.nimiqPay?.network ?? undefined
  } catch {
    state.network = undefined
  }
  try {
    // init() waits for Nimiq Pay to inject window.nimiq; outside the app it
    // rejects after the timeout, which is exactly our fallback signal.
    state.nimiq = await init({ timeout: 2_500 })
    state.inside = true
    state.nimiq.on?.('accountsChanged', (accounts) => {
      state.accounts.nim = accounts?.[0] ?? null
    })
    refreshChainStatus()
  } catch {
    state.nimiq = null
    state.inside = false
  }
  state.detected = true
  render()
}

async function refreshChainStatus() {
  if (!state.nimiq) return
  try {
    const [consensus, blockNumber] = await Promise.all([
      state.nimiq.isConsensusEstablished(),
      state.nimiq.getBlockNumber(),
    ])
    state.consensus = consensus
    state.blockNumber = blockNumber
    renderStatusOnly()
  } catch {
    /* status RPCs are decorative — ignore failures */
  }
}

async function getNimiqProvider() {
  if (state.nimiq) return state.nimiq
  state.nimiq = await init({ timeout: 5_000 })
  state.inside = true
  return state.nimiq
}

async function connectNimAddress() {
  const nimiq = await getNimiqProvider()
  const accounts = await nimiq.listAccounts()
  state.accounts.nim = accounts?.[0] ?? null
  return state.accounts.nim
}

async function connectEvmAddress() {
  if (!window.ethereum) throw new Error('No EVM wallet provider found in this browser.')
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' })
  state.accounts.evm = accounts?.[0] ?? null
  return state.accounts.evm
}

/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */

/**
 * Pay a NIM request through Nimiq Pay. sendBasicTransaction() shows the
 * native confirmation dialog; it resolves with the serialized transaction
 * once the user approves, and rejects with a NimiqProviderError otherwise.
 */
async function payWithNim(req) {
  const nimiq = await getNimiqProvider()
  const luna = toSmallestUnits(req.amount, DECIMALS.NIM)
  const serializedTx = await nimiq.sendBasicTransaction({
    recipient: normalizeNimiqAddress(req.recipient),
    value: Number(luna),
  })
  return { kind: 'nim', ref: serializedTx }
}

/**
 * Pay a USDT request through the injected EVM provider: an ERC-20
 * transfer() call to the USDT contract on Polygon, per the official
 * "Using EVM Tokens in Mini Apps" docs (selector 0xa9059cbb, 6 decimals).
 */
async function payWithUsdt(req) {
  if (!window.ethereum) throw new Error('No EVM wallet provider found. Open this link inside Nimiq Pay to pay.')
  const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' })
  const from = accounts?.[0]
  if (!from) throw new Error('No EVM account was shared by the wallet.')
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: POLYGON_CHAIN_ID }],
    })
  } catch (e) {
    if (e && e.code === 4902) throw new Error('Polygon is not configured in this wallet.')
    throw e
  }
  const amount = toSmallestUnits(req.amount, DECIMALS.USDT)
  const data =
    '0xa9059cbb' +
    req.recipient.slice(2).toLowerCase().padStart(64, '0') +
    amount.toString(16).padStart(64, '0')
  const txHash = await window.ethereum.request({
    method: 'eth_sendTransaction',
    params: [{ from, to: USDT_POLYGON, data, value: '0x0' }],
  })
  return { kind: 'usdt', ref: txHash }
}

function friendlyError(e) {
  if (NimiqProviderError.is(e)) return `${e.message} (${e.type})`
  if (e && typeof e.message === 'string') return e.message
  return String(e || 'Unknown error')
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function logoSvg() {
  return `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <path d="M26 38a8 8 0 0 0 11.3 0l7.4-7.4a8 8 0 1 0-11.3-11.3l-3.7 3.7" stroke="#fff" stroke-width="5" stroke-linecap="round"/>
    <path d="M38 26a8 8 0 0 0-11.3 0l-7.4 7.4a8 8 0 1 0 11.3 11.3l3.7-3.7" stroke="#fff" stroke-width="5" stroke-linecap="round"/>
  </svg>`
}

function headerHtml() {
  const chip = !state.detected
    ? 'Detecting…'
    : state.inside
      ? `In Nimiq Pay${state.network ? ' · ' + state.network : ''}`
      : 'Browser mode'
  return `
  <header class="app-header">
    <div class="logo">${logoSvg()}</div>
    <div>
      <h1>${APP_NAME}</h1>
      <p class="tagline">Payment requests for NIM &amp; USDT</p>
    </div>
    <span class="env-chip ${state.inside ? 'live' : ''}">${esc(chip)}</span>
  </header>`
}

function statusHtml() {
  if (!state.detected) {
    return `<div class="status-bar" id="status-bar">Checking whether we are inside Nimiq Pay…</div>`
  }
  if (state.inside) {
    const bits = [`<span><b>Connected to Nimiq Pay</b></span>`]
    if (state.network) bits.push(`<span>Network: <b>${esc(state.network)}</b></span>`)
    if (state.blockNumber != null) bits.push(`<span>Block: <b>${esc(state.blockNumber)}</b></span>`)
    if (state.consensus != null)
      bits.push(`<span>Consensus: <b>${state.consensus ? 'established' : 'syncing…'}</b></span>`)
    if (state.accounts.nim) bits.push(`<span>Account: <b class="mono">${esc(shortAddr(state.accounts.nim))}</b></span>`)
    return `<div class="status-bar" id="status-bar">${bits.join('')}</div>`
  }
  return `<div class="status-bar" id="status-bar">
    <span><b>Browser mode.</b> You can create and share requests here. Paying works inside
    <b>Nimiq Pay</b>, where the wallet confirms every payment natively.</span>
  </div>`
}

function shareCardHtml(req) {
  const link = requestLink(req)
  return `
  <div class="card" id="share-card">
    <h2>Share this request</h2>
    <p class="sub">Anyone opening this link sees the request and can pay it inside Nimiq Pay. The request details travel inside the link — no account or server needed.</p>
    <div class="qr-box"><canvas id="qr-canvas" width="200" height="200"></canvas></div>
    <div class="share-link">
      <input type="text" readonly value="${esc(link)}" id="share-link-input" />
      <button class="btn secondary small" data-action="copy-link" data-link="${esc(link)}">Copy</button>
    </div>
    <div class="btn-row">
      <a class="btn secondary small" href="${esc(nimiqPayOpenLink(req))}" target="_blank" rel="noopener">Open in Nimiq Pay</a>
      <a class="btn ghost" href="#/pay/${esc(encodePayload(req))}">Preview pay page</a>
    </div>
  </div>`
}

function requestItemHtml(req) {
  const paid = req.status === 'paid'
  return `
  <div class="req">
    <div class="req-top">
      <span class="req-label">${esc(req.label)}</span>
      <span class="chip ${paid ? 'paid' : 'unpaid'}">${paid ? 'Paid' : 'Unpaid'}</span>
      <span class="req-amount">${esc(req.amount)} ${esc(req.currency)}</span>
    </div>
    <div class="req-meta">
      To ${esc(shortAddr(req.recipient))} · ${esc(fmtDate(req.createdAt))}
      ${req.note ? ` · ${esc(req.note)}` : ''}
      ${paid && req.txRef ? `<br/>Payment ref: <span class="mono">${esc(shortAddr(req.txRef))}</span>` : ''}
    </div>
    <div class="btn-row">
      <button class="btn secondary small" data-action="share" data-id="${esc(req.id)}">Share</button>
      <a class="btn ghost" href="#/pay/${esc(encodePayload(req))}">Pay page</a>
      <button class="btn ghost" data-action="toggle-paid" data-id="${esc(req.id)}">${paid ? 'Mark unpaid' : 'Mark paid'}</button>
      <button class="btn danger" data-action="delete" data-id="${esc(req.id)}">Delete</button>
    </div>
  </div>`
}

function homeHtml() {
  const requests = loadRequests()
  const shared = state.sharedId ? findRequest(state.sharedId) : null
  return `
  ${headerHtml()}
  ${statusHtml()}
  <div class="card">
    <h2>Create a payment request</h2>
    <p class="sub">Ask for NIM or USDT (on Polygon). You get a link and QR code to share anywhere.</p>
    ${state.formError ? `<div class="notice err"><p>${esc(state.formError)}</p></div>` : ''}
    <form id="create-form">
      <label class="field" for="f-label">What is it for?</label>
      <input type="text" id="f-label" maxlength="80" placeholder="e.g. Dinner split, Invoice #12, Coffee" required />
      <div class="field-row">
        <div>
          <label class="field" for="f-amount">Amount</label>
          <input type="number" id="f-amount" min="0" step="any" inputmode="decimal" placeholder="10.5" required />
        </div>
        <div>
          <label class="field" for="f-currency">Currency</label>
          <select id="f-currency">
            <option value="NIM">NIM</option>
            <option value="USDT">USDT (Polygon)</option>
          </select>
        </div>
      </div>
      <label class="field" for="f-recipient">Your receiving address</label>
      <div class="inline-action">
        <input type="text" id="f-recipient" placeholder="NQ… or 0x…" required />
        <button type="button" class="btn secondary small" data-action="fill-address">Use mine</button>
      </div>
      <p class="hint" id="recipient-hint">For NIM this is your Nimiq address; for USDT your EVM address (same on all chains).</p>
      <label class="field" for="f-note">Note (optional)</label>
      <input type="text" id="f-note" maxlength="120" placeholder="Anything the payer should know" />
      <div class="btn-row">
        <button type="submit" class="btn primary">Create request</button>
      </div>
    </form>
  </div>
  ${shared ? shareCardHtml(shared) : ''}
  <div class="card">
    <h2>My requests</h2>
    <p class="sub">Stored only in this browser (localStorage).</p>
    ${requests.length ? requests.map(requestItemHtml).join('') : '<div class="empty">No requests yet. Create your first one above.</div>'}
  </div>
  <footer class="app-footer">
    PayLink · Built for the Nimiq Mini Apps Competition — Cycle 3 · Category: Pay<br/>
    Payments are confirmed in the Nimiq Pay wallet. PayLink never sees or holds funds or keys.
  </footer>`
}

function payHtml(payloadB64) {
  const req = decodePayload(payloadB64)
  if (!req) {
    return `
    ${headerHtml()}
    <div class="notice err"><p><b>This payment link is invalid or incomplete.</b></p>
    <p>Ask the sender for a fresh PayLink link.</p></div>
    <p><a class="link" href="#/">← Create your own payment request</a></p>`
  }
  const local = findRequest(req.id)
  const alreadyPaid = local?.status === 'paid'
  const canPayNim = state.inside
  const canPayUsdt = typeof window !== 'undefined' && !!window.ethereum
  const showFallback = state.detected && ((req.currency === 'NIM' && !canPayNim) || (req.currency === 'USDT' && !canPayUsdt))

  return `
  ${headerHtml()}
  ${statusHtml()}
  <div class="card">
    <h2>Payment request</h2>
    <p class="sub">${esc(req.label)}</p>
    <div class="amount-big">${esc(req.amount)} ${esc(req.currency)}</div>
    <div class="detail-row"><span class="k">To</span><span class="v mono">${esc(req.recipient)}</span></div>
    ${req.note ? `<div class="detail-row"><span class="k">Note</span><span class="v">${esc(req.note)}</span></div>` : ''}
    <div class="detail-row"><span class="k">Requested</span><span class="v">${esc(fmtDate(req.createdAt))}</span></div>
    ${alreadyPaid ? `<div class="detail-row"><span class="k">Status</span><span class="v">Paid ✓</span></div>` : ''}
    <div id="pay-feedback"></div>
    ${
      req.currency === 'NIM'
        ? `<div class="btn-row"><button class="btn primary" data-action="pay" ${alreadyPaid ? 'disabled' : ''}>Pay ${esc(req.amount)} NIM with Nimiq Pay</button></div>`
        : `<div class="btn-row"><button class="btn primary" data-action="pay" ${alreadyPaid ? 'disabled' : ''}>Pay ${esc(req.amount)} USDT on Polygon</button></div>
             <p class="hint">USDT payments go through the wallet's EVM provider; you need a little POL on Polygon for gas.</p>`
    }
    ${
      showFallback
        ? `<div class="notice warn" style="margin-top:14px">
             <p><b>Open this link inside Nimiq Pay to pay.</b></p>
             <p>You are viewing this in a regular browser, so the wallet payment button cannot complete here. The request details above are final — you can also pay manually to the address shown.</p>
             <div class="btn-row"><a class="btn secondary small" href="${esc(nimiqPayOpenLink(req))}" target="_blank" rel="noopener">Open in Nimiq Pay</a></div>
           </div>`
        : ''
    }
    ${
      local && !alreadyPaid
        ? `<div class="btn-row"><button class="btn ghost" data-action="toggle-paid" data-id="${esc(req.id)}">Already paid another way? Mark as paid</button></div>`
        : ''
    }
  </div>
  <p><a class="link" href="#/">← Create your own payment request</a></p>`
}

/* ------------------------------------------------------------------ */
/* Router + render                                                     */
/* ------------------------------------------------------------------ */

function currentRoute() {
  const hash = location.hash || '#/'
  const payMatch = hash.match(/^#\/pay\/(.+)$/)
  if (payMatch) return { name: 'pay', payload: payMatch[1] }
  return { name: 'home' }
}

function render() {
  const route = currentRoute()
  $app.innerHTML = `<div class="wrap">${route.name === 'pay' ? payHtml(route.payload) : homeHtml()}</div>`
  afterRender(route)
}

function renderStatusOnly() {
  const el = document.getElementById('status-bar')
  if (!el) return
  const tmp = document.createElement('div')
  tmp.innerHTML = statusHtml()
  el.replaceWith(tmp.firstElementChild)
  const chip = document.querySelector('.env-chip')
  if (chip) {
    chip.textContent = state.inside ? `In Nimiq Pay${state.network ? ' · ' + state.network : ''}` : 'Browser mode'
    chip.classList.toggle('live', state.inside)
  }
}

async function drawQr(req) {
  const canvas = document.getElementById('qr-canvas')
  if (!canvas || !req) return
  try {
    await QRCode.toCanvas(canvas, requestLink(req), { width: 200, margin: 1 })
  } catch {
    canvas.style.display = 'none' // QR is a convenience; the link still works
  }
}

function afterRender(route) {
  if (route.name === 'home') {
    const form = document.getElementById('create-form')
    form?.addEventListener('submit', onCreateSubmit)
    if (state.sharedId) {
      const req = findRequest(state.sharedId)
      drawQr(req)
      document.getElementById('share-card')?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
    }
  }
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

async function onCreateSubmit(ev) {
  ev.preventDefault()
  const label = document.getElementById('f-label').value.trim()
  const amount = document.getElementById('f-amount').value.trim()
  const currency = document.getElementById('f-currency').value
  const recipient = document.getElementById('f-recipient').value.trim()
  const note = document.getElementById('f-note').value.trim()

  if (!label) return fail('Please add a label for the request.')
  if (!isValidAmount(amount, currency))
    return fail(`Please enter a valid amount (more than 0, max ${DECIMALS[currency]} decimal places).`)
  if (!isValidRecipient(currency, recipient))
    return fail(
      currency === 'NIM'
        ? 'That does not look like a Nimiq address (it starts with NQ and has 36 characters).'
        : 'That does not look like an EVM address (0x followed by 40 hex characters).',
    )

  const req = {
    id: newId(),
    label,
    amount,
    currency,
    recipient: currency === 'NIM' ? normalizeNimiqAddress(recipient) : recipient,
    note,
    createdAt: Date.now(),
    status: 'unpaid',
  }
  upsertRequest(req)
  state.formError = ''
  state.sharedId = req.id
  render()
}

function fail(msg) {
  state.formError = msg
  render()
  try {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  } catch {
    /* non-critical */
  }
}

async function onFillAddress() {
  const currency = document.getElementById('f-currency').value
  const input = document.getElementById('f-recipient')
  const hint = document.getElementById('recipient-hint')
  try {
    if (currency === 'NIM') {
      if (!state.inside && !state.nimiq) {
        hint.textContent = 'Open PayLink inside Nimiq Pay to fill your address automatically, or paste it here.'
        return
      }
      const addr = await connectNimAddress()
      if (addr) input.value = addr
    } else {
      const addr = await connectEvmAddress()
      if (addr) input.value = addr
    }
  } catch (e) {
    hint.textContent = `Could not read your address: ${friendlyError(e)}`
  }
  renderStatusOnly()
}

function setPayFeedback(html) {
  const el = document.getElementById('pay-feedback')
  if (el) el.innerHTML = html
}

async function onPay() {
  const route = currentRoute()
  if (route.name !== 'pay') return
  const req = decodePayload(route.payload)
  if (!req) return
  const btn = document.querySelector('[data-action="pay"]')
  if (btn) btn.disabled = true
  setPayFeedback(`<div class="notice"><p>Waiting for confirmation in the wallet…</p></div>`)
  try {
    const result = req.currency === 'NIM' ? await payWithNim(req) : await payWithUsdt(req)
    const local = findRequest(req.id)
    if (local) setPaid(req.id, true, result.ref)
    const explorer =
      result.kind === 'usdt'
        ? `<br/><a class="link" href="https://polygonscan.com/tx/${esc(result.ref)}" target="_blank" rel="noopener">View transaction on Polygonscan</a>`
        : ''
    setPayFeedback(
      `<div class="notice ok"><p><b>Payment sent ✓</b></p><p>The wallet confirmed and submitted your payment of ${esc(req.amount)} ${esc(req.currency)}.${explorer}</p></div>`,
    )
    if (btn) btn.textContent = 'Paid ✓'
  } catch (e) {
    setPayFeedback(
      `<div class="notice err"><p><b>Payment not completed.</b></p><p>${esc(friendlyError(e))}</p></div>`,
    )
    if (btn) btn.disabled = false
  }
}

/* Delegated clicks for buttons rendered inside views */
document.addEventListener('click', async (ev) => {
  const target = ev.target.closest('[data-action]')
  if (!target) return
  const action = target.dataset.action
  const id = target.dataset.id
  if (action === 'share') {
    state.sharedId = state.sharedId === id ? null : id
    render()
  } else if (action === 'toggle-paid') {
    const req = findRequest(id)
    if (req) setPaid(id, req.status !== 'paid')
    render()
  } else if (action === 'delete') {
    deleteRequest(id)
    if (state.sharedId === id) state.sharedId = null
    render()
  } else if (action === 'copy-link') {
    const link = target.dataset.link
    try {
      await navigator.clipboard.writeText(link)
      target.textContent = 'Copied ✓'
      setTimeout(() => (target.textContent = 'Copy'), 1500)
    } catch {
      document.getElementById('share-link-input')?.select()
    }
  } else if (action === 'fill-address') {
    onFillAddress()
  } else if (action === 'pay') {
    onPay()
  }
})

window.addEventListener('hashchange', render)

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

render() // paint immediately in fallback mode; wallet detection refines it
detectEnvironment()
