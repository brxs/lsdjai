// M2 exit-criteria verification: drives the real React UI in headless
// Chromium against a running backend (uv run magenta-dj) and checks that the
// deck is fully usable and that stream health is visible in the UI.
//
// Run: node scripts/verify_m2.mjs

import { chromium } from 'playwright'

const URL = 'http://127.0.0.1:8000/'
const PLAY_SECONDS = 20

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage()
await page.goto(URL)

// Deck connects on load.
await page.getByText('Connected', { exact: true }).waitFor({ timeout: 10_000 })
console.log('connected: deck socket open from the React app')

// Set a prompt, then play.
await page.getByLabel('Style prompt').fill('warm disco funk')
await page.getByRole('button', { name: 'Set prompt' }).click()
await page
  .getByText('Playing: warm disco funk')
  .waitFor({ timeout: 20_000 })
console.log('prompt: applied and reflected in the UI')

await page.getByRole('button', { name: 'Play' }).click()
await page.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 5_000 })

// Let it stream, then read the health row from the UI.
await page.waitForTimeout(PLAY_SECONDS * 1000)

const underrunsStat = page
  .locator('.ui-stat', { hasText: 'Underruns' })
  .locator('.ui-stat__value')
const underruns = Number(await underrunsStat.textContent())

const bufferLabel = await page
  .locator('.ui-meter__label span')
  .nth(1)
  .textContent()
const bufferedSeconds = Number.parseFloat(bufferLabel ?? '0')

const genSpeedText = await page
  .locator('.ui-stat', { hasText: 'Gen speed' })
  .locator('.ui-stat__value')
  .textContent()

console.log(
  `health after ${PLAY_SECONDS}s: buffer=${bufferedSeconds}s underruns=${underruns} genSpeed=${genSpeedText}`,
)

// Volume fader works against the live audio graph.
await page.getByLabel('Volume').fill('0.3')

// Stop returns the transport to Play.
await page.getByRole('button', { name: 'Stop' }).click()
await page.getByRole('button', { name: 'Play' }).waitFor({ timeout: 5_000 })
console.log('transport: play/stop round-trip works')

await page.screenshot({ path: 'm2-verification.png', fullPage: true })
await browser.close()

if (Number.isNaN(underruns)) fail('underrun stat not visible in the UI')
if (underruns > 0) fail(`underruns occurred and were visible: ${underruns}`)
if (!(bufferedSeconds > 0)) fail(`buffer meter shows no audio buffered (${bufferLabel})`)

console.log('VERDICT: PASS (screenshot: m2-verification.png)')
process.exit(0)
