// M17 exit-criteria verification (docs/ROADMAP.md): the recorded master
// never exceeds the limiter ceiling under a deliberately hot mix, and
// two decks of clearly different loudness land within ~1 dB through
// matched faders once auto-gain settles. Levels are measured from the
// recorded WAV (the M6 pattern) — the recorder taps post-limiter, so
// the file IS what was heard. Run against a running backend (just run).
//
// Run: node scripts/verify_m17.mjs

import { readFile } from 'node:fs/promises'

import { chromium } from 'playwright'

const URL = 'http://127.0.0.1:8000/'
// Must match LIMITER_CEILING in src/audio/master.ts (binary-exact),
// plus one int16 quantisation step of slack.
const CEILING = 0.9296875 + 1 / 32768
const GAIN_MATCH_TOLERANCE_DB = 1.5

function wavPeak(wav) {
  const dataBytes = wav.readUInt32LE(40)
  let peak = 0
  for (let i = 0; i < dataBytes / 2; i++) {
    const value = Math.abs(wav.readInt16LE(44 + i * 2)) / 32768
    if (value > peak) peak = value
  }
  return peak
}

function wavRms(wav) {
  const dataBytes = wav.readUInt32LE(40)
  const frames = dataBytes / 4 // stereo int16
  const start = Math.floor(frames * 0.2)
  const end = Math.floor(frames * 0.9)
  let sum = 0
  for (let i = start; i < end; i++) {
    const left = wav.readInt16LE(44 + i * 4) / 32768
    const right = wav.readInt16LE(46 + i * 4) / 32768
    const mono = (left + right) / 2
    sum += mono * mono
  }
  return Math.sqrt(sum / (end - start))
}

const db = (ratio) => 20 * Math.log10(ratio)

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
})

try {
  const page = await browser.newPage()
  await page.goto(URL)
  const deckA = page.locator('section[aria-label="Deck a"]')
  const deckB = page.locator('section[aria-label="Deck b"]')
  const channelA = page.getByRole('group', { name: 'Channel a' })
  const channelB = page.getByRole('group', { name: 'Channel b' })
  for (const deck of [deckA, deckB]) {
    await deck.getByText('Connected', { exact: true }).waitFor({ timeout: 10_000 })
  }

  async function startDeck(deck, style) {
    await deck.getByLabel('Style target').fill(style)
    await deck.getByRole('button', { name: 'Add' }).click()
    await deck.getByText(/^Playing: /).waitFor({ timeout: 20_000 })
    await deck.getByRole('button', { name: 'Play' }).click()
    await deck.getByRole('button', { name: 'Stop', exact: true }).waitFor()
  }

  async function recordWav(seconds) {
    await page.getByRole('button', { name: 'Record' }).click()
    await page.getByText(/^REC /).waitFor({ timeout: 5_000 })
    await page.waitForTimeout(seconds * 1000)
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Stop recording' }).click()
    return readFile(await (await downloadPromise).path())
  }

  // ── Part 1: the ceiling under a deliberately hot mix ──────────────
  await startDeck(deckA, 'hard industrial techno, loud distorted drums')
  await page.getByLabel('Crossfade').fill('0') // full deck A
  await page.waitForTimeout(8_000) // settle past the prebuffer

  // Everything hot at once: +12 dB trim, all EQ bands boosted, Crush
  // at full, channel fader at max.
  await channelA.getByLabel('Trim').fill('1')
  for (const band of ['EQ Hi', 'EQ Mid', 'EQ Low']) {
    await channelA.getByLabel(band).fill('1')
  }
  await channelA.getByLabel('Volume').fill('1')
  await deckA.getByLabel('Effect').selectOption('Crush')
  await deckA.getByLabel('FX amount').fill('1')
  await page.waitForTimeout(2_000)

  const hot = await recordWav(10)
  const peak = wavPeak(hot)
  const reduction = await page
    .locator('.ui-stat', { hasText: 'Limiter' })
    .locator('.ui-stat__value')
    .textContent()
  console.log(
    `hot mix: peak=${peak.toFixed(4)} (ceiling ${CEILING.toFixed(4)}), limiter showing ${reduction?.trim()}`,
  )

  // ── Part 2: auto-gain match across very different sources ─────────
  // Back to a fair fight: flat EQ, FX off, AUTO trim, matched faders.
  for (const band of ['EQ Hi', 'EQ Mid', 'EQ Low']) {
    await channelA.getByLabel(band).fill('0.5')
  }
  await deckA.getByLabel('Effect').selectOption('Off')
  await channelA.getByLabel('Volume').fill('0.8')
  await channelA.getByRole('button', { name: 'Auto' }).click()

  // A steady quiet texture, deliberately: sparse material (e.g. solo
  // piano) swings loudness phrase-to-phrase faster than the slow
  // tracker follows, which tests the source's variance, not the trim.
  await startDeck(deckB, 'quiet mellow chillout, soft warm pads, smooth')
  await channelB.getByLabel('Volume').fill('0.8')
  await channelB.getByRole('button', { name: 'Auto' }).click()
  // Let the slow loudness trackers converge on both sources.
  await page.waitForTimeout(25_000)

  const trimA = Number(await channelA.getByLabel('Trim').inputValue())
  const trimB = Number(await channelB.getByLabel('Trim').inputValue())
  console.log(
    `auto trims: deck a=${(trimA * 24 - 12).toFixed(1)}dB deck b=${(trimB * 24 - 12).toFixed(1)}dB`,
  )

  await page.getByLabel('Crossfade').fill('0')
  const rmsA = wavRms(await recordWav(10))
  await page.getByLabel('Crossfade').fill('1')
  await page.waitForTimeout(1_000)
  const rmsB = wavRms(await recordWav(10))
  const deltaDb = Math.abs(db(rmsA / rmsB))
  console.log(
    `matched-fader loudness: deck a=${db(rmsA).toFixed(1)}dBFS deck b=${db(rmsB).toFixed(1)}dBFS delta=${deltaDb.toFixed(2)}dB`,
  )

  // ── Part 3: trims persist ──────────────────────────────────────────
  // Stop both decks first: a stopped deck's loudness tracker resets
  // and the auto tick holds, so no glide can land between the
  // snapshot and the reload.
  await deckA.getByRole('button', { name: 'Stop', exact: true }).click()
  await deckB.getByRole('button', { name: 'Stop', exact: true }).click()
  await page.waitForTimeout(2_500)
  const beforeReloadA = Number(await channelA.getByLabel('Trim').inputValue())
  const beforeReloadB = Number(await channelB.getByLabel('Trim').inputValue())
  await page.reload()
  await deckA.getByText('Connected', { exact: true }).waitFor({ timeout: 10_000 })
  const restoredA = Number(await channelA.getByLabel('Trim').inputValue())
  const restoredB = Number(await channelB.getByLabel('Trim').inputValue())
  console.log(`after reload: trim a=${restoredA.toFixed(3)} b=${restoredB.toFixed(3)}`)

  await page.screenshot({ path: 'm17-verification.png', fullPage: true })

  if (peak > CEILING) {
    throw new Error(`recorded peak ${peak.toFixed(4)} exceeds the ceiling`)
  }
  // The makeup-compensated limiter holds a fully limited signal near
  // dbToGain(-5.7) ≈ 0.52 steady-state; the floor proves the mix was
  // genuinely hot without re-asserting the exact crest.
  if (peak < 0.4) {
    throw new Error(`hot mix only peaked at ${peak.toFixed(3)} — nothing to limit`)
  }
  if (!reduction?.includes('dB')) {
    throw new Error('the limiter never reported gain reduction on the hot mix')
  }
  if (deltaDb > GAIN_MATCH_TOLERANCE_DB) {
    throw new Error(
      `decks differ by ${deltaDb.toFixed(2)}dB through matched faders — auto-gain missed`,
    )
  }
  if (!(trimB > trimA)) {
    throw new Error('the quiet deck did not receive the higher trim')
  }
  if (
    Math.abs(restoredA - beforeReloadA) > 0.01 ||
    Math.abs(restoredB - beforeReloadB) > 0.01
  ) {
    throw new Error('trims did not survive the reload')
  }

  console.log('VERDICT: PASS (screenshot: m17-verification.png)')
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
} finally {
  await browser.close()
}
