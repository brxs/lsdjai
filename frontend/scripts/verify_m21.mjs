// M21 exit-criteria verification (docs/ROADMAP.md, ADR-0015), the
// scripted half: a gridded techno track loads onto deck B playing; a
// hot cue set from the pad jumps the playhead back while the track
// plays; LOOP IN + LOOP OUT close a whole-beat region the playhead
// audibly folds through (the overview position wraps instead of
// growing); EXIT releases it cleanly past the old boundary. Pad LEDs
// and the gridless degrade live in docs/m21-hardware-checklist.md.
//
// Honest caveat: like verify_m20, the grid is fitted to real
// generated material — a Magenta render that refuses a grid gets two
// more takes, and three refusals is the kill-criterion conversation,
// not a flake.
//
// Run: node scripts/verify_m21.mjs (against a running backend)

import { chromium } from 'playwright'

const URL = 'http://127.0.0.1:8000/'

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
})

try {
  const page = await browser.newPage()
  let lastGrid = null
  page.on('console', (msg) => {
    const text = msg.text()
    if (text.includes('[beatgrid] verdict')) {
      lastGrid = !text.includes('verdict b null')
    }
  })
  await page.goto(URL)
  const deckB = page.locator('section[aria-label="Deck b"]')
  const explorer = page.locator('section[aria-label="Media explorer"]')
  await deckB.getByText('Connected', { exact: true }).waitFor({ timeout: 10_000 })

  // ── Compose a gridded track onto deck B ──────────────────────────
  await explorer.getByRole('tab', { name: 'Generate' }).click()
  await explorer
    .getByLabel('Track prompt')
    .fill('rolling techno, four on the floor, 126 BPM')
  await explorer.getByLabel('Engine').selectOption('track')
  await explorer.getByLabel('Length').selectOption('120')
  let trackBpm = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    await explorer.getByRole('button', { name: 'Compose' }).click()
    const trackName = `rolling techno, four on the floor, 126 BPM #${attempt}`
    const load = explorer.getByRole('button', {
      name: `Load ${trackName} to deck B`,
    })
    await load.waitFor({ timeout: 300_000 })
    lastGrid = null
    await load.click()
    await deckB.getByText(/^Track — /).waitFor({ timeout: 15_000 })
    const text = (
      await deckB
        .locator('.ui-stat', { hasText: 'BPM' })
        .locator('.ui-stat__value')
        .textContent()
    ).trim()
    if (lastGrid === true && text !== '—') {
      trackBpm = Number(text)
      console.log(`take ${attempt} gridded: ${trackBpm} BPM`)
      break
    }
    console.log(`take ${attempt} refused a grid — composing another`)
  }
  if (trackBpm === null) {
    throw new Error(
      'no take gridded in three composes — the kill-criterion conversation',
    )
  }
  await deckB.getByRole('button', { name: 'Play' }).click()
  await deckB.getByRole('button', { name: 'Stop', exact: true }).waitFor()

  const position = async () =>
    Number(
      await page.evaluate(() =>
        document
          .querySelector('section[aria-label="Deck b"] [role="slider"]')
          ?.getAttribute('aria-valuenow'),
      ),
    )
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  // ── Hot cue: set from the pad, jump back to it while playing ─────
  await sleep(3_000)
  const cueAt = await position()
  await deckB.getByRole('button', { name: 'Hot cue 1' }).click()
  const litClass = await deckB
    .getByRole('button', { name: 'Hot cue 1' })
    .getAttribute('class')
  if (!litClass.includes('--lit')) {
    throw new Error('a set hot cue pad did not light')
  }
  console.log(`hot cue 1 set near ${cueAt}s`)
  await sleep(5_000)
  const before = await position()
  await deckB.getByRole('button', { name: 'Hot cue 1' }).click()
  const after = await position()
  // aria-valuenow is whole seconds; the snap exactness is unit-tested.
  if (Math.abs(after - cueAt) > 2) {
    throw new Error(
      `hot cue jump landed at ${after}s, expected ~${cueAt}s (was at ${before}s)`,
    )
  }
  if (before - after < 3) {
    throw new Error(
      `the jump barely moved (${before}s → ${after}s) — nothing was proven`,
    )
  }
  console.log(`hot cue jump: ${before}s → ${after}s (cue at ${cueAt}s)`)

  // ── Loop: IN … OUT closes a whole-beat region; the playhead folds ─
  await deckB.getByRole('button', { name: 'Loop in' }).click()
  await sleep(4_200)
  await deckB.getByRole('button', { name: 'Loop out' }).click()
  const lengthLabel = await deckB.getByText(/-beat loop/).textContent()
  const beats = Number(lengthLabel.match(/^(\d+)/)[1])
  // ~4.2 s at the measured BPM, rounded to the lattice by quantise.
  const expected = (4.2 * trackBpm) / 60
  if (Math.abs(beats - expected) > 1.5) {
    throw new Error(
      `loop claims ${beats} beats; ~${expected.toFixed(1)} were armed`,
    )
  }
  console.log(`loop closed: ${lengthLabel} at ${trackBpm} BPM`)

  // The playhead must fold: across three laps it wraps (decreases)
  // and never escapes the region's ceiling.
  const loopSeconds = (beats * 60) / trackBpm
  const samples = []
  const lapMillis = loopSeconds * 1000
  for (let i = 0; i < 12; i++) {
    samples.push(await position())
    await sleep(lapMillis / 4)
  }
  const ceiling = Math.max(...samples)
  let wraps = 0
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] < samples[i - 1]) wraps++
  }
  if (wraps < 2) {
    throw new Error(
      `the playhead never folded (positions ${samples.join(', ')}) — that is not a loop`,
    )
  }
  const span = ceiling - Math.min(...samples)
  if (span > loopSeconds + 2) {
    throw new Error(
      `positions span ${span}s inside a ${loopSeconds.toFixed(1)}s loop — the seam and the playhead disagree`,
    )
  }
  console.log(
    `playhead folded ${wraps}× over three laps, span ${span}s (loop ${loopSeconds.toFixed(1)}s)`,
  )

  // ── EXIT releases cleanly: the playhead escapes the old ceiling ──
  await deckB.getByRole('button', { name: 'Exit loop' }).click()
  await sleep(Math.min(lapMillis * 1.5, 8_000))
  const released = await position()
  if (released <= ceiling) {
    throw new Error(
      `after EXIT the playhead sits at ${released}s, still under the loop ceiling ${ceiling}s`,
    )
  }
  console.log(`exit released: playhead ran to ${released}s past ${ceiling}s`)

  await page.screenshot({ path: 'm21-verification.png' })
  console.log('VERDICT: PASS (screenshot: m21-verification.png)')
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
} finally {
  await browser.close()
}
