// M3 exit-criteria verification (docs/ROADMAP.md): both decks on different
// prompts, blend between them live, and switch one deck's model while the
// other keeps playing. Drives the real React UI in headless Chromium against
// a running backend (just run).
//
// Run: node scripts/verify_m3.mjs

import { chromium } from 'playwright'

const URL = 'http://127.0.0.1:8000/'
const BLEND_SECONDS = 10
const MODEL_SWITCH_TIMEOUT_MS = 300_000 // mrt2_base load + warm-up is slow

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
})

function deckLocators(deck) {
  return {
    prompt: deck.getByLabel('Style target'),
    setPrompt: deck.getByRole('button', { name: 'Add' }),
    play: deck.getByRole('button', { name: 'Play' }),
    stop: deck.getByRole('button', { name: 'Stop' }),
    model: deck.getByLabel('Model'),
    underruns: deck
      .locator('.ui-stat', { hasText: 'Underruns' })
      .locator('.ui-stat__value'),
    buffer: deck.locator('.ui-meter__label span').nth(1),
  }
}

async function startDeck(name, locators, prompt) {
  await locators.prompt.fill(prompt)
  await locators.setPrompt.click()
  await locators.play.click()
  await locators.stop.waitFor({ timeout: 10_000 })
  console.log(`deck ${name}: playing "${prompt}"`)
}

try {
  const page = await browser.newPage()
  await page.goto(URL)
  const a = deckLocators(page.locator('section[aria-label="Deck a"]'))
  const b = deckLocators(page.locator('section[aria-label="Deck b"]'))

  // Both decks connect independently.
  await page
    .locator('section[aria-label="Deck a"]')
    .getByText('Connected', { exact: true })
    .waitFor({ timeout: 10_000 })
  await page
    .locator('section[aria-label="Deck b"]')
    .getByText('Connected', { exact: true })
    .waitFor({ timeout: 10_000 })
  console.log('connected: both decks')

  // Different prompts, both playing.
  await startDeck('a', a, 'warm disco funk')
  await startDeck('b', b, 'dark minimal techno')

  // Blend between them live while both stream.
  const crossfader = page.getByLabel('Crossfade')
  for (const position of ['0', '1', '0.5']) {
    await crossfader.fill(position)
    if ((await crossfader.inputValue()) !== position) {
      throw new Error(`crossfader did not take position ${position}`)
    }
    await page.waitForTimeout((BLEND_SECONDS / 3) * 1000)
  }
  const bufferA = Number.parseFloat((await a.buffer.textContent()) ?? '0')
  const bufferB = Number.parseFloat((await b.buffer.textContent()) ?? '0')
  console.log(`blend: crossfader swept A→B→centre (buffers a=${bufferA}s b=${bufferB}s)`)
  if (!(bufferA > 0 && bufferB > 0)) {
    throw new Error('both decks must be streaming while blending')
  }

  // Switch deck B's model while deck A keeps playing.
  await b.model.selectOption('mrt2_base')
  await page
    .locator('section[aria-label="Deck b"]')
    .getByText('Loading model…')
    .waitFor({ timeout: 10_000 })
  console.log('deck b: model switch started (mrt2_base loading)')

  await page
    .locator('section[aria-label="Deck b"]')
    .getByText('Connected', { exact: true })
    .waitFor({ timeout: MODEL_SWITCH_TIMEOUT_MS })
  if ((await b.model.inputValue()) !== 'mrt2_base') {
    throw new Error('deck b did not come back on mrt2_base')
  }
  console.log('deck b: ready on mrt2_base')

  // Deck A must have kept playing through the whole switch.
  const underrunsA = Number(await a.underruns.textContent())
  const stillPlayingA = await a.stop.isVisible()
  const bufferAfterA = Number.parseFloat((await a.buffer.textContent()) ?? '0')
  console.log(
    `deck a through the switch: playing=${stillPlayingA} buffer=${bufferAfterA}s underruns=${underrunsA}`,
  )

  await page.screenshot({ path: 'm3-verification.png', fullPage: true })

  if (!stillPlayingA) throw new Error('deck a stopped during the model switch')
  if (underrunsA > 0) throw new Error(`deck a underran during the switch: ${underrunsA}`)
  if (!(bufferAfterA > 0)) throw new Error('deck a buffer empty after the switch')

  console.log('VERDICT: PASS (screenshot: m3-verification.png)')
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
} finally {
  await browser.close()
}
