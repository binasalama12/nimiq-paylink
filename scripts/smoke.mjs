/**
 * Headless smoke test for the built PayLink app (dist/) using jsdom.
 * The managed Chromium in this VM refuses CLI startup (domain policy),
 * so jsdom is the fallback harness. It verifies fallback-mode behaviour:
 *  1. Home page renders, environment detection settles into "Browser mode".
 *  2. Creating a request writes localStorage and renders the share card.
 *  3. The pay page for a NIM request renders details + Nimiq Pay fallback notice.
 *  4. No uncaught JS errors on any route.
 */
import { JSDOM, VirtualConsole } from 'jsdom'

const BASE = 'http://127.0.0.1:8077/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeWindow(url) {
  const errors = []
  const vc = new VirtualConsole()
  vc.on('jsdomError', (e) => {
    // jsdom "not implemented" notices (scrolling etc.) are harness noise, not app errors
    if (!/Not implemented/i.test(e.message)) errors.push(`jsdomError: ${e.message}`)
  })
  vc.on('error', (...args) => errors.push(`console.error: ${args.join(' ')}`))
  return { vc, errors }
}

async function load(url) {
  const { vc, errors } = makeWindow(url)
  // jsdom (24.x) does not execute <script type="module">; the Vite bundle is
  // self-contained with no top-level import/export, so loading the identical
  // production file as a classic script executes the same code.
  const html = await (await fetch(url.split('#')[0])).text()
  const classicHtml = html.replace(' type="module"', '')
  const dom = new JSDOM(classicHtml, {
    url,
    resources: 'usable',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
  })
  dom.window.addEventListener('error', (e) => errors.push(`window.onerror: ${e.message}`))
  // wait for module scripts + env detection (init timeout is 2.5s)
  await sleep(4200)
  return { dom, errors }
}

const results = []
function check(name, ok, extra = '') {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`)
  if (!ok) process.exitCode = 1
}

/* ---- 1. Home route ---- */
const home = await load(BASE)
{
  const doc = home.dom.window.document
  check('home: app rendered', doc.querySelector('#app .wrap') !== null)
  check('home: fallback "Browser mode" status', doc.body.textContent.includes('Browser mode'))
  check('home: create form present', doc.querySelector('#create-form') !== null)
  check('home: empty request list', doc.body.textContent.includes('No requests yet'))

  /* ---- 2. Create a request through the real form ---- */
  doc.querySelector('#f-label').value = 'Smoke Test Coffee'
  doc.querySelector('#f-amount').value = '12.5'
  doc.querySelector('#f-currency').value = 'NIM'
  doc.querySelector('#f-recipient').value = 'NQ07 0000 0000 0000 0000 0000 0000 0000 0000'
  doc.querySelector('#create-form').dispatchEvent(new home.dom.window.Event('submit', { bubbles: true, cancelable: true }))
  await sleep(300)

  const stored = JSON.parse(home.dom.window.localStorage.getItem('paylink.requests.v1') || '[]')
  check('create: request stored in localStorage', stored.length === 1 && stored[0].label === 'Smoke Test Coffee')
  check('create: share card rendered', doc.querySelector('#share-card') !== null)
  const link = doc.querySelector('#share-link-input')?.value || ''
  check('create: share link contains payload', link.includes('#/pay/'), link.slice(0, 60) + '…')
  check('create: list shows the request', doc.body.textContent.includes('Smoke Test Coffee'))

  /* toggle paid via the real button */
  doc.querySelector('[data-action="toggle-paid"]').dispatchEvent(new home.dom.window.MouseEvent('click', { bubbles: true }))
  await sleep(200)
  const stored2 = JSON.parse(home.dom.window.localStorage.getItem('paylink.requests.v1') || '[]')
  check('toggle: request marked paid', stored2[0]?.status === 'paid')

  var payUrl = link
}
check('home: no uncaught JS errors', home.errors.length === 0, home.errors.join(' | '))

/* ---- 3. Pay route (fresh page, as a payer would see it) ---- */
const pay = await load(payUrl)
{
  const doc = pay.dom.window.document
  check('pay: label rendered', doc.body.textContent.includes('Smoke Test Coffee'))
  check('pay: amount rendered', doc.body.textContent.includes('12.5') && doc.body.textContent.includes('NIM'))
  check('pay: recipient rendered', doc.body.textContent.includes('NQ07'))
  check('pay: Nimiq Pay fallback notice shown', doc.body.textContent.includes('Open this link inside Nimiq Pay to pay'))
  check('pay: pay button present', doc.querySelector('[data-action="pay"]') !== null)
}
check('pay: no uncaught JS errors', pay.errors.length === 0, pay.errors.join(' | '))

console.log(results.join('\n'))
process.exit(process.exitCode || 0)
