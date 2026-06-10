// M2 exit-criteria verification: drives the real React UI in headless
// Chromium against a running backend (uv run magenta-dj) and checks that the
// deck is fully usable and that stream health is visible in the UI.
//
// Run: node scripts/verify_m2.mjs

import { chromium } from 'playwright'

const URL = 'http://127.0.0.1:8000/'
const PLAY_SECONDS = 20

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
})

try {
  const page = await browser.newPage()
  await page.goto(URL)
  const deckA = page.locator('section[aria-label="Deck a"]')

  // Deck connects on load.
  await deckA.getByText('Connected', { exact: true }).waitFor({ timeout: 10_000 })
  console.log('connected: deck socket open from the React app')

  // Set a prompt, then play.
  await deckA.getByLabel('Style target').fill('warm disco funk')
  await deckA.getByRole('button', { name: 'Add' }).click()
  await deckA.getByText('Playing: 100% warm disco funk').waitFor({ timeout: 20_000 })
  console.log('prompt: applied and reflected in the UI')

  await deckA.getByRole('button', { name: 'Play' }).click()
  await deckA.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 5_000 })

  // Let it stream, then read the health row from the UI.
  await page.waitForTimeout(PLAY_SECONDS * 1000)

  const underruns = Number(
    await deckA
      .locator('.ui-stat', { hasText: 'Underruns' })
      .locator('.ui-stat__value')
      .textContent(),
  )
  const bufferLabel = await deckA
    .locator('.ui-meter__label span')
    .nth(1)
    .textContent()
  const bufferedSeconds = Number.parseFloat(bufferLabel ?? '0')
  const genSpeedText = await deckA
    .locator('.ui-stat', { hasText: 'Gen speed' })
    .locator('.ui-stat__value')
    .textContent()

  console.log(
    `health after ${PLAY_SECONDS}s: buffer=${bufferedSeconds}s underruns=${underruns} genSpeed=${genSpeedText}`,
  )

  // Volume fader accepts input and reflects it.
  const volume = deckA.getByLabel('Volume')
  await volume.fill('0.3')
  if ((await volume.inputValue()) !== '0.3') {
    throw new Error('volume fader did not take the new value')
  }

  // Stop returns the transport to Play.
  await deckA.getByRole('button', { name: 'Stop' }).click()
  await deckA.getByRole('button', { name: 'Play' }).waitFor({ timeout: 5_000 })
  console.log('transport: play/stop round-trip works')

  await page.screenshot({ path: 'm2-verification.png', fullPage: true })

  if (Number.isNaN(underruns)) throw new Error('underrun stat not visible in the UI')
  if (underruns > 0) throw new Error(`underruns occurred and were visible: ${underruns}`)
  if (!(bufferedSeconds > 0))
    throw new Error(`buffer meter shows no audio buffered (${bufferLabel})`)

  console.log('VERDICT: PASS (screenshot: m2-verification.png)')
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
} finally {
  await browser.close()
}
