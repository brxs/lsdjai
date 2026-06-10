// M4 exit-criteria verification (docs/ROADMAP.md, extended to the 2D style
// pad): a deck glides between an arbitrary set of prompts without a hard
// style jump — three targets on the pad, the cursor dragged from one to the
// next, an unbroken stream throughout (zero underruns, no errors) with the
// blend reflected in the UI. Run against a running backend (just run).
//
// Run: node scripts/verify_m4.mjs

import { chromium } from 'playwright'

const URL = 'http://127.0.0.1:8000/'
const TARGETS = ['warm disco funk', 'dark minimal techno', 'dub ambient']
const SECONDS_PER_LEG = 6

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
})

try {
  const page = await browser.newPage()
  await page.goto(URL)
  const deck = page.locator('section[aria-label="Deck a"]')

  await deck.getByText('Connected', { exact: true }).waitFor({ timeout: 10_000 })

  for (const target of TARGETS) {
    await deck.getByLabel('Style target').fill(target)
    await deck.getByRole('button', { name: 'Add' }).click()
  }
  await deck.getByLabel('Tempo hint (bpm)').fill('124')
  await deck.getByLabel('Tempo hint (bpm)').blur()
  await deck.getByText(/^Playing: /).waitFor({ timeout: 20_000 })
  console.log(`style: ${TARGETS.length} targets on the pad (with tempo hint)`)

  await deck.getByRole('button', { name: 'Play' }).click()
  await deck.getByRole('button', { name: 'Stop' }).waitFor({ timeout: 10_000 })

  // Drag the cursor to each target in turn; three targets sit on a circle
  // of radius 0.38 starting at 12 o'clock.
  const pad = deck.getByLabel('Style pad')
  const box = await pad.boundingBox()
  if (!box) throw new Error('style pad not visible')
  const at = (x, y) => [box.x + x * box.width, box.y + y * box.height]
  const positions = TARGETS.map((_, index) => {
    const angle = (2 * Math.PI * index) / TARGETS.length - Math.PI / 2
    return { x: 0.5 + 0.38 * Math.cos(angle), y: 0.5 + 0.38 * Math.sin(angle) }
  })

  await page.mouse.move(...at(0.5, 0.5))
  await page.mouse.down()
  for (const [index, position] of positions.entries()) {
    await page.mouse.move(...at(position.x, position.y), { steps: 20 })
    await page.waitForTimeout(SECONDS_PER_LEG * 1000)
    const summary = await deck.locator('.deck__active-prompt').textContent()
    console.log(`glide leg ${index + 1}: ${summary}`)
    if (!summary?.includes(`% ${TARGETS[index]}`)) {
      throw new Error(`blend summary does not reflect target ${TARGETS[index]}`)
    }
    const dominant = summary?.replace('Playing: ', '').split(' · ')[0] ?? ''
    if (!dominant.includes(TARGETS[index])) {
      throw new Error(`expected ${TARGETS[index]} to dominate at its corner: ${summary}`)
    }
  }
  await page.mouse.up()

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
  console.log(`after glide: buffer=${buffer}s underruns=${underruns} error=${errorVisible}`)

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
