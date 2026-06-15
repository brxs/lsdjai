// Web Audio golden oracle: render artifacts/input.f32 through Chromium's real
// Web Audio engine (OfflineAudioContext) per CONTRACT.md case, -> golden_<case>.f32.
// Faithful replica of eq.ts / master.ts / fxGraphs.ts with STATIC params.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const artifacts = join(here, '..', 'artifacts')
// Resolve Playwright from the frontend's node_modules.
const require = createRequire('/Users/daniel.peter/Repos/magenta-dj/frontend/package.json')
const { chromium } = require('playwright')

const SR = 48000
const CASES = ['eq_flat', 'eq_kill_low', 'eq_boost', 'filter_lp', 'bypass', 'master_limiter']

const inBytes = readFileSync(join(artifacts, 'input.f32'))
const inputB64 = inBytes.toString('base64')

// Runs inside Chromium (passed to page.evaluate). Builds the exact Web Audio
// graph per case and renders. Must be self-contained — no Node-scope closures.
async function renderInPage({ b64, caseName, SR }) {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const inter = new Float32Array(bin.buffer)
  const frames = inter.length / 2
  const L = new Float32Array(frames), R = new Float32Array(frames)
  for (let i = 0; i < frames; i++) { L[i] = inter[2 * i]; R[i] = inter[2 * i + 1] }

  const ctx = new OfflineAudioContext(2, frames, SR)
  const buf = ctx.createBuffer(2, frames, SR)
  buf.copyToChannel(L, 0); buf.copyToChannel(R, 1)
  const src = ctx.createBufferSource(); src.buffer = buf

  const eqValueToDb = (v) => {
    const c = Math.min(1, Math.max(0, v))
    return c >= 0.5 ? ((c - 0.5) / 0.5) * 6 : (1 - c / 0.5) * -40
  }
  const shelf = (type, freq, db) => {
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.gain.value = db; return f
  }
  const bell = (freq, q, db) => {
    const f = ctx.createBiquadFilter(); f.type = 'peaking'; f.frequency.value = freq; f.Q.value = q; f.gain.value = db; return f
  }
  const eqChain = (low, mid, high) => {
    const a = shelf('lowshelf', 250, eqValueToDb(low))
    const b = bell(1000, 0.7, eqValueToDb(mid))
    const c = shelf('highshelf', 2500, eqValueToDb(high))
    a.connect(b); b.connect(c); return { head: a, tail: c }
  }

  let tail = src
  if (caseName === 'eq_flat') { const { head, tail: t } = eqChain(0.5, 0.5, 0.5); src.connect(head); tail = t }
  else if (caseName === 'eq_kill_low') { const { head, tail: t } = eqChain(0.0, 0.5, 0.5); src.connect(head); tail = t }
  else if (caseName === 'eq_boost') { const { head, tail: t } = eqChain(1.0, 1.0, 1.0); src.connect(head); tail = t }
  else if (caseName === 'filter_lp') {
    const freq = 18000 * Math.pow(80 / 18000, 0.5) // filterCurve(0.25)
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq // Q default (1)
    src.connect(f); tail = f
  } else if (caseName === 'bypass') {
    tail = src // identity
  } else if (caseName === 'master_limiter') {
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -6; comp.knee.value = 0; comp.ratio.value = 20
    comp.attack.value = 0.002; comp.release.value = 0.25
    const FULL_SCALE_GAIN_DB = -6 - (-6 / 20)
    const LIMITER_MAKEUP_DB = -0.6 * FULL_SCALE_GAIN_DB
    const makeup = ctx.createGain(); makeup.gain.value = Math.pow(10, -LIMITER_MAKEUP_DB / 20)
    const CEIL = 0.9296875
    const N = 4096, curve = new Float32Array(N)
    for (let i = 0; i < N; i++) { const x = (2 * i) / (N - 1) - 1; curve[i] = Math.max(-CEIL, Math.min(CEIL, x)) }
    const ws = ctx.createWaveShaper(); ws.curve = curve; ws.oversample = 'none'
    src.connect(comp); comp.connect(makeup); makeup.connect(ws); tail = ws
  }
  tail.connect(ctx.destination)
  src.start()
  const rendered = await ctx.startRendering()
  const out = new Float32Array(frames * 2)
  const oL = rendered.getChannelData(0), oR = rendered.getChannelData(1)
  for (let i = 0; i < frames; i++) { out[2 * i] = oL[i]; out[2 * i + 1] = oR[i] }
  let b = ''
  const u8 = new Uint8Array(out.buffer)
  for (let i = 0; i < u8.length; i++) b += String.fromCharCode(u8[i])
  return btoa(b)
}

const browser = await chromium.launch()
const page = await browser.newPage()
for (const c of CASES) {
  const outB64 = await page.evaluate(renderInPage, { b64: inputB64, caseName: c, SR })
  const bytes = Buffer.from(outB64, 'base64')
  writeFileSync(join(artifacts, `golden_${c}.f32`), bytes)
  console.log(`golden_${c}.f32: ${bytes.length} bytes`)
}
await browser.close()
console.log('done')
