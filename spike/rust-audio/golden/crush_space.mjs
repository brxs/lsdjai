// Golden + analysis for the two HIGH-risk effects fundsp can't cleanly do:
//  - Crush: deterministic quantise-and-hold (faithful to crusher-kernel.js) — no
//    Chromium needed. Hand-rolled Rust should match; fundsp Shape::Crush (no hold)
//    should diverge.
//  - Space: characterised by reverb decay (RT60 via Schroeder EDC) on an impulse,
//    not sample parity (ConvolverNode IR vs fundsp FDN are different algorithms).
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const artifacts = join(here, '..', 'artifacts')
const SR = 48000
const readF32 = (n) => { const b = readFileSync(join(artifacts, n)); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4) }
const maxAbs = (a) => { let m = 0; for (const x of a) { const v = Math.abs(x); if (v > m) m = v } return m }

// --- Crush golden: faithful to frontend/public/crusher-kernel.js (shared counter) ---
function crushGolden(input, bits, reduction) {
  const frames = input.length / 2, levels = Math.pow(2, bits - 1), out = new Float32Array(frames * 2)
  let counter = 0; const held = [0, 0]
  for (let i = 0; i < frames; i++) {
    if (counter === 0) { held[0] = Math.round(input[2 * i] * levels) / levels; held[1] = Math.round(input[2 * i + 1] * levels) / levels }
    counter = (counter + 1) % reduction
    out[2 * i] = held[0]; out[2 * i + 1] = held[1]
  }
  return out
}

// --- Space golden: a seeded realisation of fxGraphs.ts impulseResponse (2.5 s,
//     decay^3 noise) so its RT60 is reproducible. ConvolverNode of an impulse = IR. ---
function mulberry32(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }
function goldenSpaceIR() {
  const seconds = 2.5, decayPower = 3, length = Math.floor(SR * seconds), rng = mulberry32(12345), ir = new Float32Array(length)
  for (let i = 0; i < length; i++) ir[i] = (rng() * 2 - 1) * Math.pow(1 - i / length, decayPower)
  return ir
}

// RT60 from a mono impulse response via Schroeder backward integration (RT30 ×2).
function rt60(ir) {
  const n = ir.length, edc = new Float64Array(n)
  let acc = 0
  for (let i = n - 1; i >= 0; i--) { acc += ir[i] * ir[i]; edc[i] = acc }
  const e0 = edc[0]; if (!(e0 > 0)) return null
  const db = (i) => 10 * Math.log10(edc[i] / e0)
  let t5 = -1, t35 = -1
  for (let i = 0; i < n; i++) { if (t5 < 0 && db(i) <= -5) t5 = i; if (t35 < 0 && db(i) <= -35) { t35 = i; break } }
  if (t5 < 0 || t35 < 0) return null
  return ((t35 - t5) / SR) * 2
}
const leftCh = (inter) => { const f = inter.length / 2, l = new Float32Array(f); for (let i = 0; i < f; i++) l[i] = inter[2 * i]; return l }

// === Crush ===
console.log('== Crush (quantise-and-hold, bits=10, reduction=21, 512 levels) ==')
const input = readF32('input.f32')
const golden = crushGolden(input, 10, 21)
writeFileSync(join(artifacts, 'golden_crush.f32'), Buffer.from(golden.buffer))
console.log(`golden_crush.f32 written (max|out|=${maxAbs(golden).toFixed(6)})`)
const diff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > m) m = d } return m }
if (existsSync(join(artifacts, 'rust_crush.f32')))
  console.log(`rust_crush (hand-roll)  vs golden: maxErr=${diff(readF32('rust_crush.f32'), golden).toExponential(2)}  -> ${diff(readF32('rust_crush.f32'), golden) <= 1e-6 ? 'PASS (matches worklet)' : 'check'}`)
else console.log('rust_crush.f32 missing (agent still running)')
if (existsSync(join(artifacts, 'rust_crush_fundsp.f32')))
  console.log(`rust_crush_fundsp       vs golden: maxErr=${diff(readF32('rust_crush_fundsp.f32'), golden).toExponential(2)}  (expected LARGE — no sample-hold)`)

// === Space ===
console.log('\n== Space (reverb decay — RT60, not sample parity) ==')
console.log(`golden ConvolverNode IR (2.5 s decay^3 noise): RT60 ≈ ${rt60(goldenSpaceIR()).toFixed(3)} s`)
if (existsSync(join(artifacts, 'rust_space.f32'))) {
  const r60 = rt60(leftCh(readF32('rust_space.f32')))
  console.log(`fundsp reverb_stereo impulse response:         RT60 ≈ ${r60 ? r60.toFixed(3) + ' s' : 'n/a (tail too short/long)'}`)
} else console.log('rust_space.f32 missing (agent still running)')
