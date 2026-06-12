// M20 exit-criteria verification (docs/ROADMAP.md, ADR-0014), the
// scripted half: deck A streams techno until the gate shows a BPM; a
// Magenta track composed at that tempo loads onto deck B playing; the
// TEMPO knob visibly scales the effective BPM readout; SYNC matches
// deck B's readout to deck A's gated BPM; and the phase meter's
// needle appears once both clocks are confident. Phase-nudge feel and
// the audible lock live in docs/m20-hardware-checklist.md.
//
// Honest caveat: the grid is fitted to real generated material here —
// if Magenta techno stops being beat-trackable, this fails, and that
// is the milestone's kill-criterion conversation, not a flake.
//
// Run: node scripts/verify_m20.mjs (against a running backend)

import { chromium } from 'playwright'

const URL = 'http://127.0.0.1:8000/'

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
})

try {
  const page = await browser.newPage()
  await page.goto(URL)
  const deckA = page.locator('section[aria-label="Deck a"]')
  const deckB = page.locator('section[aria-label="Deck b"]')
  const explorer = page.locator('section[aria-label="Media explorer"]')
  for (const deck of [deckA, deckB]) {
    await deck.getByText('Connected', { exact: true }).waitFor({ timeout: 10_000 })
  }

  const bpmStat = (deck) =>
    deck.locator('.ui-stat', { hasText: 'BPM' }).locator('.ui-stat__value')

  // ── Deck A streams techno until the gate shows a tempo ──────────────
  await deckA.getByLabel('Style target').fill('driving techno, four on the floor, 124 BPM')
  await deckA.getByRole('button', { name: 'Add' }).click()
  await deckA.getByText(/^Playing: /).waitFor({ timeout: 20_000 })
  await deckA.getByRole('button', { name: 'Play' }).click()
  await deckA.getByRole('button', { name: 'Stop', exact: true }).waitFor()
  await page.waitForFunction(
    () => {
      const decks = document.querySelectorAll('section[aria-label="Deck a"] .ui-stat')
      const stat = [...decks].find((s) => s.textContent.includes('BPM'))
      return stat && !stat.textContent.includes('—')
    },
    { timeout: 45_000 },
  )
  const liveBpm = Number(await bpmStat(deckA).textContent())
  console.log(`deck A gated at ${liveBpm} BPM`)

  // ── Compose a track at that tempo, load it onto deck B ──────────────
  await explorer.getByRole('tab', { name: 'Generate' }).click()
  await explorer
    .getByLabel('Track prompt')
    .fill(`rolling techno, four on the floor, ${Math.round(liveBpm)} BPM`)
  await explorer.getByLabel('Engine').selectOption('magenta')
  await explorer.getByLabel('Length').selectOption('30')
  await explorer.getByRole('button', { name: 'Compose' }).click()
  const trackName = `rolling techno, four on the floor, ${Math.round(liveBpm)} BPM #1`
  await explorer
    .getByRole('button', { name: `Load ${trackName} to deck B` })
    .waitFor({ timeout: 300_000 })
  await explorer.getByRole('button', { name: `Load ${trackName} to deck B` }).click()
  await deckB.getByText(/^Track — /).waitFor({ timeout: 15_000 })
  const gridBpmText = (await bpmStat(deckB).textContent()).trim()
  if (gridBpmText === '—') {
    throw new Error(
      'the composed track yielded no tempo — the grid/kill-criterion conversation',
    )
  }
  const trackBpm = Number(gridBpmText)
  console.log(`track loaded, offline verdict ${trackBpm} BPM`)
  await deckB.getByRole('button', { name: 'Play' }).click()
  await deckB.getByText('Track — playing').waitFor({ timeout: 5_000 })

  // ── TEMPO scales the readout ─────────────────────────────────────────
  await deckB.getByLabel('Tempo').fill('1.04')
  await page.waitForTimeout(300)
  const sped = Number(await bpmStat(deckB).textContent())
  console.log(`tempo 1.04 → readout ${sped} BPM`)

  // ── SYNC matches deck A ──────────────────────────────────────────────
  await deckB.getByRole('button', { name: 'Sync', exact: true }).click()
  await page.waitForTimeout(300)
  const refused = await deckB
    .getByText('Sync refused — tempo out of range')
    .isVisible()
  const synced = Number(await bpmStat(deckB).textContent())
  console.log(`SYNC → readout ${synced} BPM (deck A ${liveBpm}), refused=${refused}`)

  // ── Phase meter: a needle once both clocks are confident ────────────
  await page
    .locator('.ui-phasemeter__needle')
    .waitFor({ timeout: 20_000 })
    .catch(() => null)
  const needle = await page.locator('.ui-phasemeter__needle').isVisible()
  console.log(`phase meter needle visible: ${needle}`)

  await page.screenshot({ path: 'm20-verification.png', fullPage: true })
  await deckA.getByRole('button', { name: 'Stop', exact: true }).click()
  await deckB.getByRole('button', { name: 'Stop', exact: true }).click()

  if (Math.abs(sped - trackBpm * 1.04) > trackBpm * 0.01) {
    throw new Error(`tempo knob did not scale the readout: ${trackBpm} → ${sped}`)
  }
  if (refused) {
    throw new Error(
      `SYNC refused: track ${trackBpm} vs live ${liveBpm} — outside ±8%`,
    )
  }
  if (Math.abs(synced - liveBpm) > liveBpm * 0.005) {
    throw new Error(`SYNC missed: readout ${synced} vs target ${liveBpm}`)
  }
  if (!needle) {
    throw new Error('the phase meter never gained a needle (a clock stayed blank)')
  }

  console.log('VERDICT: PASS (screenshot: m20-verification.png)')
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
} finally {
  await browser.close()
}
