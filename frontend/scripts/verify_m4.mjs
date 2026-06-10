// M4 exit-criteria verification (docs/ROADMAP.md): a deck glides between two
// prompts without a hard style jump — apply a two-prompt style with a tempo
// hint, play, sweep the morph slider across the range, and require an
// unbroken stream (zero underruns, no errors) with the morph state reflected
// in the UI throughout. Run against a running backend (just run).
//
// Run: node scripts/verify_m4.mjs

import { chromium } from 'playwright'

const URL = 'http://127.0.0.1:8000/'
const SWEEP = ['0', '0.25', '0.5', '0.75', '1']
const SECONDS_PER_STEP = 5

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
})

try {
  const page = await browser.newPage()
  await page.goto(URL)
  const deck = page.locator('section[aria-label="Deck a"]')

  await deck.getByText('Connected', { exact: true }).waitFor({ timeout: 10_000 })

  await deck.getByLabel('Prompt A').fill('warm disco funk')
  await deck.getByLabel('Prompt B (morph target)').fill('dark minimal techno')
  await deck.getByLabel('Tempo hint (bpm)').fill('124')
  await deck.getByRole('button', { name: 'Set style' }).click()
  await deck
    .getByText('Playing: warm disco funk ↔ dark minimal techno')
    .waitFor({ timeout: 20_000 })
  console.log('style: two-prompt morph style applied (with tempo hint)')

  const morph = deck.getByLabel('Morph A ↔ B')
  if (!(await morph.isEnabled())) throw new Error('morph slider not enabled')

  await deck.getByRole('button', { name: 'Play' }).click()
  await deck.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 10_000 })

  for (const position of SWEEP) {
    await morph.fill(position)
    if ((await morph.inputValue()) !== position) {
      throw new Error(`morph slider did not take position ${position}`)
    }
    await page.waitForTimeout(SECONDS_PER_STEP * 1000)
    console.log(`morph: gliding at ${Math.round(Number(position) * 100)}% B`)
  }

  const underruns = Number(
    await deck
      .locator('.ui-stat', { hasText: 'Underruns' })
      .locator('.ui-stat__value')
      .textContent(),
  )
  const errorVisible = await deck.locator('.deck__error').isVisible()
  const buffer = Number.parseFloat(
    (await deck.locator('.ui-meter__label span').nth(1).textContent()) ?? '0',
  )
  console.log(
    `after sweep: buffer=${buffer}s underruns=${underruns} error=${errorVisible}`,
  )

  await deck.getByRole('button', { name: 'Stop' }).click()
  await page.screenshot({ path: 'm4-verification.png', fullPage: true })

  if (Number.isNaN(underruns)) throw new Error('underrun stat not visible')
  if (underruns > 0) throw new Error(`stream broke during the glide: ${underruns} underruns`)
  if (errorVisible) throw new Error('deck reported an error during the glide')
  if (!(buffer > 0)) throw new Error('deck stopped streaming during the glide')

  console.log('VERDICT: PASS (screenshot: m4-verification.png)')
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
} finally {
  await browser.close()
}
