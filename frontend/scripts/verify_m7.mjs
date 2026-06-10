// M7 smoke verification (docs/ROADMAP.md): the Web MIDI integration is
// wired through the real app — provider, statusbar controls, and the
// genuine permission/connect flow — up to the point a physical device
// would take over. Full exit-criteria verification is the manual run of
// docs/m7-hardware-checklist.md; hardware cannot be e2e-automated
// (ADR-0005). Run against a running backend (just run).
//
// Run: node scripts/verify_m7.mjs

import { chromium } from 'playwright'

const ORIGIN = 'http://127.0.0.1:8000'
const URL = `${ORIGIN}/`

const browser = await chromium.launch()

try {
  const context = await browser.newContext()
  // Pre-grant so the headless run doesn't hang on the permission prompt
  // (the prompt itself is part of the manual checklist). Chromium gates
  // even plain requestMIDIAccess behind the sysex permission.
  await context.grantPermissions(['midi', 'midi-sysex'], { origin: ORIGIN })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(URL)

  // Statusbar offers the connect flow (headless Chromium ships Web MIDI).
  const connect = page.getByRole('button', { name: 'Connect MIDI' })
  await connect.waitFor({ timeout: 10_000 })
  console.log('statusbar: Connect MIDI offered')

  // Playwright's Chromium build crashes the renderer on MIDI *output*
  // (verified by bisection: access + input listeners are fine, send is
  // not). Connecting with a FLX4 attached fires the pad-LED echo, so
  // probe for the device first — reading port names is safe — and only
  // drive the connect flow when no hardware is present. With hardware
  // attached the connect flow is covered by the manual checklist anyway.
  const hasDevice = await page.evaluate(async () => {
    const access = await navigator.requestMIDIAccess()
    return [...access.inputs.values()].some((port) =>
      port.name?.includes('DDJ-FLX4'),
    )
  })
  if (hasDevice) {
    console.log(
      'connect flow: SKIPPED — FLX4 attached; LED echo would crash this ' +
        'Chromium build. Run docs/m7-hardware-checklist.md in real Chrome.',
    )
  } else {
    // Real requestMIDIAccess round-trip: the honest outcome without a
    // device is the no-device status with the button left for a retry.
    await connect.click()
    await page.getByText('No DDJ-FLX4 found').waitFor({ timeout: 10_000 })
    await connect.waitFor()
    console.log('connect flow: access granted, no device → retry offered')
  }

  // The booth must be fully usable regardless of MIDI state.
  const deckA = page.locator('section[aria-label="Deck a"]')
  await deckA.getByText('Connected', { exact: true }).waitFor({ timeout: 10_000 })
  console.log('booth: decks connected alongside the MIDI statusbar')

  await page.screenshot({ path: 'm7-verification.png', fullPage: true })

  if (pageErrors.length > 0) {
    throw new Error(`page errors: ${pageErrors.join(' | ')}`)
  }

  console.log('VERDICT: PASS (screenshot: m7-verification.png)')
  console.log('Reminder: exit criteria need docs/m7-hardware-checklist.md on the device.')
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
} finally {
  await browser.close()
}
