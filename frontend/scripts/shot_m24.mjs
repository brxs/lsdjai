// M24 look-and-feel screenshot: render the booth against the Vite dev
// server (no backend) and capture the restyle — dark, square, mono.
// Input-only (no MIDI) so the renderer stays alive headless.
// Run: node scripts/shot_m24.mjs   (with `npm run dev` running)

import { chromium } from 'playwright'

const URL = 'http://localhost:5173/'

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  await page.goto(URL, { waitUntil: 'networkidle' })
  await page.locator('.app').waitFor({ timeout: 10_000 })

  // Confirm Space Mono actually loaded (not a silent system-mono fallback).
  const fontLoaded = await page.evaluate(async () => {
    await document.fonts.ready
    return document.fonts.check("12px 'Space Mono'")
  })
  console.log(`Space Mono loaded: ${fontLoaded}`)

  await page.screenshot({ path: 'm24-verification.png', fullPage: true })
  console.log('screenshot: m24-verification.png')
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : error}`)
  process.exitCode = 1
} finally {
  await browser.close()
}
