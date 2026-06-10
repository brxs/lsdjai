// M6 exit-criteria verification (docs/ROADMAP.md): killing an EQ band
// measurably removes it from the recorded spectrum while the other deck is
// unaffected, and EQ settings survive a reload.
//
// Method: the kill is measured with ONLY deck A playing (a second deck in
// the master would need perfect crossfader isolation, and generative
// content makes that flaky). Record once flat, once with deck A's LOW
// killed; compare low-band vs high-band energy with a Goertzel filter
// bank. Deck B then starts and must stream cleanly (its own EQ untouched)
// while deck A's bands move. Run against a running backend (just run).
//
// Run: node scripts/verify_m6.mjs

import { readFile } from 'node:fs/promises'

import { chromium } from 'playwright'

const URL = 'http://127.0.0.1:8000/'
const RECORD_SECONDS = 8
const LOW_FREQS = [50, 80, 110, 140, 180]
const HIGH_FREQS = [2_000, 3_500, 5_000, 7_000]

function goertzelPower(samples, sampleRate, freq) {
  const omega = (2 * Math.PI * freq) / sampleRate
  const coeff = 2 * Math.cos(omega)
  let s1 = 0
  let s2 = 0
  for (const x of samples) {
    const s0 = x + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2
}

function bandEnergies(wav) {
  const sampleRate = wav.readUInt32LE(24)
  const dataBytes = wav.readUInt32LE(40)
  const frames = dataBytes / 4 // stereo int16
  // Mono mix of the middle of the recording (skip edges/prebuffer wobble).
  const start = Math.floor(frames * 0.2)
  const end = Math.floor(frames * 0.9)
  const mono = new Float64Array(end - start)
  for (let i = start; i < end; i++) {
    const left = wav.readInt16LE(44 + i * 4) / 32768
    const right = wav.readInt16LE(46 + i * 4) / 32768
    mono[i - start] = (left + right) / 2
  }
  const sum = (freqs) =>
    freqs.reduce((total, f) => total + goertzelPower(mono, sampleRate, f), 0) /
    mono.length
  return { low: sum(LOW_FREQS), high: sum(HIGH_FREQS) }
}

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
})

try {
  const page = await browser.newPage()
  await page.goto(URL)
  const deckA = page.locator('section[aria-label="Deck a"]')
  const deckB = page.locator('section[aria-label="Deck b"]')
  for (const deck of [deckA, deckB]) {
    await deck.getByText('Connected', { exact: true }).waitFor({ timeout: 10_000 })
  }

  // Deck A: bass-heavy content, isolated on the master via the crossfader.
  await deckA.getByLabel('Style target').fill('deep dub techno, heavy sub bass')
  await deckA.getByRole('button', { name: 'Add' }).click()
  await deckA.getByText(/^Playing: /).waitFor({ timeout: 20_000 })
  await deckA.getByRole('button', { name: 'Play' }).click()
  await deckA.getByRole('button', { name: 'Stop', exact: true }).waitFor()

  await page.getByLabel('Crossfade').fill('0') // full deck A
  await page.waitForTimeout(8_000) // settle past prebuffer

  async function recordWav() {
    await page.getByRole('button', { name: 'Record' }).click()
    await page.getByText(/^REC /).waitFor({ timeout: 5_000 })
    await page.waitForTimeout(RECORD_SECONDS * 1000)
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Stop recording' }).click()
    const download = await downloadPromise
    return readFile(await download.path())
  }

  const flat = bandEnergies(await recordWav())
  console.log(`flat:   low=${flat.low.toExponential(2)} high=${flat.high.toExponential(2)}`)

  const channelA = page.getByRole('group', { name: 'Channel a' })
  const channelB = page.getByRole('group', { name: 'Channel b' })
  await channelA.getByLabel('EQ Low').fill('0') // kill the lows on deck A
  await page.waitForTimeout(1_000) // EQ is client-side: applies instantly
  const killed = bandEnergies(await recordWav())
  console.log(`killed: low=${killed.low.toExponential(2)} high=${killed.high.toExponential(2)}`)

  const lowRatio = killed.low / flat.low
  const highRatio = killed.high / flat.high
  console.log(
    `ratios: low=${lowRatio.toFixed(3)} (${(10 * Math.log10(lowRatio)).toFixed(1)}dB) high=${highRatio.toFixed(2)}`,
  )

  // Deck B starts now and must stream cleanly while deck A's EQ moves.
  await deckB.getByLabel('Style target').fill('uplifting trance')
  await deckB.getByRole('button', { name: 'Add' }).click()
  await deckB.getByText(/^Playing: /).waitFor({ timeout: 20_000 })
  await deckB.getByRole('button', { name: 'Play' }).click()
  await deckB.getByRole('button', { name: 'Stop', exact: true }).waitFor()
  for (const value of ['1', '0.3', '0.5']) {
    await channelA.getByLabel('EQ Mid').fill(value)
    await page.waitForTimeout(2_000)
  }
  if ((await channelB.getByLabel('EQ Mid').inputValue()) !== '0.5') {
    throw new Error("deck a's EQ moves leaked into deck b's controls")
  }
  const underrunsB = Number(
    await deckB.locator('.ui-stat', { hasText: 'Underruns' }).locator('.ui-stat__value').textContent(),
  )
  const bufferB = Number.parseFloat(
    (await deckB.locator('.ui-meter__label span').nth(1).textContent()) ?? '0',
  )
  console.log(`deck b through the kill: buffer=${bufferB}s underruns=${underrunsB}`)

  // Reload: the kill must be restored on deck A, flat elsewhere.
  await page.reload()
  await deckA.getByText('Connected', { exact: true }).waitFor({ timeout: 10_000 })
  const restoredLow = await channelA.getByLabel('EQ Low').inputValue()
  const restoredHi = await channelA.getByLabel('EQ Hi').inputValue()
  console.log(`after reload: deck a EQ Low=${restoredLow} EQ Hi=${restoredHi}`)

  await page.screenshot({ path: 'm6-verification.png', fullPage: true })

  if (lowRatio > 0.05) {
    throw new Error(`low band only dropped to ${lowRatio.toFixed(3)} of flat — not a kill`)
  }
  if (highRatio < 0.25) {
    throw new Error(`high band dropped too (${highRatio.toFixed(2)}) — that's volume, not EQ`)
  }
  if (underrunsB > 0) throw new Error(`deck b underran during deck a's EQ moves`)
  if (!(bufferB > 0)) throw new Error('deck b stopped streaming')
  if (restoredLow !== '0') throw new Error(`EQ Low not restored (${restoredLow})`)
  if (restoredHi !== '0.5') throw new Error(`EQ Hi should be flat (${restoredHi})`)

  console.log('VERDICT: PASS (screenshot: m6-verification.png)')
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
} finally {
  await browser.close()
}
