// Deterministic Spike A test signal -> artifacts/input.f32
// Interleaved stereo float32 LE @ 48000, 4.0 s. Pure math, no RNG (CONTRACT.md).
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const artifacts = join(here, '..', 'artifacts')
mkdirSync(artifacts, { recursive: true })

const SR = 48000
const frames = SR * 4
const buf = new Float32Array(frames * 2)
const set = (i, v) => { buf[2 * i] = v; buf[2 * i + 1] = v }

// [0,1) three sines: 100 + 1000 + 6000 Hz, each 0.2 (one per EQ band)
for (let i = 0; i < SR; i++) {
  const t = i / SR
  set(i, 0.2 * Math.sin(2 * Math.PI * 100 * t)
       + 0.2 * Math.sin(2 * Math.PI * 1000 * t)
       + 0.2 * Math.sin(2 * Math.PI * 6000 * t))
}
// [1,2) exponential sweep 20 -> 20000 Hz, 0.25
{
  const f0 = 20, f1 = 20000, T = 1, k = Math.log(f1 / f0)
  for (let j = 0; j < SR; j++) {
    const t = j / SR
    set(SR + j, 0.25 * Math.sin((2 * Math.PI * f0 * T / k) * (Math.exp((t / T) * k) - 1)))
  }
}
// [2,3) loud burst 200 Hz @ 1.5 (drives the ceiling)
for (let j = 0; j < SR; j++) set(2 * SR + j, 1.5 * Math.sin(2 * Math.PI * 200 * (j / SR)))
// [3,4) quiet 440 Hz @ 0.02 (sub-threshold transparency)
for (let j = 0; j < SR; j++) set(3 * SR + j, 0.02 * Math.sin(2 * Math.PI * 440 * (j / SR)))

writeFileSync(join(artifacts, 'input.f32'), Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength))
console.log(`wrote input.f32: ${frames} frames (${buf.length} samples, ${buf.byteLength} bytes)`)
