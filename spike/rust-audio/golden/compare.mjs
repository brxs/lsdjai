// Parity comparator for Spike A (CONTRACT.md). Diffs rust_<case>.f32 against
// golden_<case>.f32 per the case rule; also self-validates the golden oracle.
// Usage: node compare.mjs [--validate-golden]
//
// Method notes baked in (from the spec's critics):
//  - DSP paths are cross-engine (fundsp vs Web Audio) -> epsilon, never bit-exact.
//  - Bit-exact is reserved for the dead-zone bypass.
//  - Group delay (the compressor's 288-frame / 6 ms latency) is removed by
//    cross-correlation before any diff.
//  - "Transparency" is a LEVEL property -> compared as an RMS ratio, phase-immune.
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const artifacts = join(here, '..', 'artifacts')
const SR = 48000
const CEIL = 0.9296875
const EPS = 1e-3
const SETTLE = Math.round(0.4 * SR) // skip the compressor release tail in the quiet seg

const readF32 = (name) => {
  const b = readFileSync(join(artifacts, name))
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)
}
const maxAbs = (a) => { let m = 0; for (const x of a) { const v = Math.abs(x); if (v > m) m = v } return m }
const seg = (a, s) => a.subarray(s * SR * 2, (s + 1) * SR * 2)
const rmsRange = (a, f0, f1) => { let x = 0, n = 0; for (let i = f0 * 2; i < f1 * 2; i += 2) { x += a[i] * a[i]; n++ } return Math.sqrt(x / n) }

// Integer frame offset (b vs a) minimising error over a steady window, range ±512.
function alignOffset(a, b, w0 = 55000, w1 = 90000) {
  let best = 0, bestErr = Infinity
  for (let off = -512; off <= 512; off++) {
    let s = 0, n = 0
    for (let f = w0; f < w1; f++) {
      const j = f + off
      if (j < 0 || j * 2 >= b.length) continue
      const d = a[f * 2] - b[j * 2]; s += d * d; n++
    }
    if (n && s / n < bestErr) { bestErr = s / n; best = off }
  }
  return best
}
function errStats(a, b, trim, off) {
  let maxE = 0, s = 0, sr = 0, n = 0
  for (let i = trim * 2; i < a.length; i++) {
    const j = i + off * 2
    if (j < 0 || j >= b.length) continue
    const d = a[i] - b[j]; const e = Math.abs(d)
    if (e > maxE) maxE = e; s += d * d; sr += a[i] * a[i]; n++
  }
  const rms = Math.sqrt(s / n), ref = Math.sqrt(sr / n)
  return { maxE, rmsDb: rms > 0 ? 20 * Math.log10(rms) : -Infinity, refDb: ref > 0 ? 20 * Math.log10(ref) : -Infinity }
}
// Left-channel error over a frame window [f0,f1) of two full arrays, b shifted by off.
function errWindow(a, b, f0, f1, off) {
  let maxE = 0, s = 0, sr = 0, n = 0
  for (let f = f0; f < f1; f++) {
    const j = f + off
    if (j < 0 || j * 2 >= b.length) continue
    const d = a[f * 2] - b[j * 2]; const e = Math.abs(d)
    if (e > maxE) maxE = e; s += d * d; sr += a[f * 2] * a[f * 2]; n++
  }
  const rms = Math.sqrt(s / n), ref = Math.sqrt(sr / n)
  return { maxE, rmsDb: rms > 0 ? 20 * Math.log10(rms) : -Infinity, refDb: ref > 0 ? 20 * Math.log10(ref) : -Infinity }
}
function bitexact(a, b) {
  if (a.length !== b.length) return { ok: false, firstDiff: -1 }
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !(a[i] === 0 && b[i] === 0)) return { ok: false, firstDiff: i, va: a[i], vb: b[i] }
  return { ok: true }
}
// Level transparency of the settled quiet seg vs input, in dB (phase-immune).
function transparencyDb(out) {
  const input = readF32('input.f32')
  const f0 = 3 * SR + SETTLE, f1 = 4 * SR - 2000
  return 20 * Math.log10(rmsRange(out, f0, f1) / rmsRange(input, f0, f1))
}

function validateGolden() {
  console.log('== golden oracle self-validation ==')
  const input = readF32('input.f32')
  const be = bitexact(input, readF32('golden_bypass.f32'))
  console.log(`bypass bit-exact vs input:        ${be.ok ? 'PASS' : `FAIL @${be.firstDiff}`}`)
  const ml = readF32('golden_master_limiter.f32')
  const peak = maxAbs(ml)
  console.log(`master_limiter ceiling:           peak=${peak.toFixed(7)} <= ${CEIL} -> ${peak <= CEIL ? 'PASS' : 'FAIL'}`)
  const off = alignOffset(ml, input, 3 * SR + SETTLE, 4 * SR - 2000)
  const al = errStats(seg(ml, 3).subarray(SETTLE * 2), seg(input, 3).subarray(SETTLE * 2), 0, off)
  console.log(`sub-threshold transparency:       level=${transparencyDb(ml).toFixed(3)} dB, aligned maxErr=${al.maxE.toExponential(2)} (latency ${off} fr) -> ${Math.abs(transparencyDb(ml)) < 0.1 ? 'PASS' : 'check'}`)
}

const RULES = { eq_flat: 'epsilon', eq_kill_low: 'epsilon', eq_boost: 'epsilon', filter_lp: 'epsilon', bypass: 'bitexact', master_limiter: 'invariant' }

function compareCase(name) {
  if (!existsSync(join(artifacts, `rust_${name}.f32`))) { console.log(`${name}: rust output missing (skip)`); return }
  const r = readF32(`rust_${name}.f32`), input = readF32('input.f32')
  const rule = RULES[name]
  if (rule === 'bitexact') {
    const be = bitexact(r, input)
    console.log(`${name.padEnd(15)} [bit-exact vs input]   ${be.ok ? 'PASS (0 ULP)' : `FAIL @${be.firstDiff} (${be.va} vs ${be.vb})`}`)
  } else if (rule === 'invariant') {
    const peak = maxAbs(r), tdb = transparencyDb(r)
    const g = readF32(`golden_${name}.f32`)
    const off = alignOffset(r, g, 2 * SR + 2000, 3 * SR - 2000)
    const div = errWindow(r, g, 2 * SR + 2000, 3 * SR - 2000, off)
    console.log(`${name.padEnd(15)} [ceiling]              peak=${peak.toFixed(7)} -> ${peak <= CEIL ? 'PASS' : 'FAIL'}`)
    console.log(`${''.padEnd(15)} [transparency]         level=${tdb.toFixed(3)} dB -> ${Math.abs(tdb) < 0.1 ? 'PASS' : 'check'}`)
    console.log(`${''.padEnd(15)} [loud-seg div, REPORT] aligned(${off}fr) maxErr=${div.maxE.toExponential(2)} rmsErr=${div.rmsDb.toFixed(1)} dBFS (ref ${div.refDb.toFixed(1)})`)
  } else {
    const g = readF32(`golden_${name}.f32`)
    const off = alignOffset(r, g)
    const e = errStats(r, g, 2048, off)
    console.log(`${name.padEnd(15)} [epsilon vs golden]    off=${off}fr maxErr=${e.maxE.toExponential(2)} rmsErr=${e.rmsDb.toFixed(1)} dBFS (ref ${e.refDb.toFixed(1)}) -> ${e.maxE <= EPS ? 'PASS' : 'MEASURE'}`)
  }
}

if (process.argv.includes('--validate-golden')) validateGolden()
else { console.log('== rust vs golden (Spike A offline parity) =='); for (const c of Object.keys(RULES)) compareCase(c) }
