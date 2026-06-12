import { describe, expect, it } from 'vitest'

import {
  buildLoopChannel,
  generatedLoopSeconds,
  quantiseLoopSeconds,
} from './loops'

function ramp(length: number): Float32Array {
  return Float32Array.from({ length }, (_, i) => i / length)
}

describe('buildLoopChannel', () => {
  it('returns the capture minus the crossfade surplus', () => {
    expect(buildLoopChannel(ramp(100), 10)).toHaveLength(90)
  })

  it('passes a constant signal through the seam exactly', () => {
    const out = buildLoopChannel(new Float32Array(64).fill(0.5), 16)
    for (const sample of out) expect(sample).toBe(0.5)
  })

  it('is continuous across the wrap point', () => {
    const samples = ramp(1000)
    const fade = 100
    const out = buildLoopChannel(samples, fade)
    // The wrap lands where the source was continuous: the last output
    // frame is samples[L-1], and frame 0 blends in samples[L] at full
    // weight — the very next source frame.
    expect(out[out.length - 1]).toBe(samples[out.length - 1])
    expect(out[0]).toBe(samples[out.length])
  })

  it('blends the surplus tail linearly into the head', () => {
    const samples = new Float32Array(8)
    samples.set([0, 0, 0, 0], 0) // head
    samples.set([1, 1, 1, 1], 4) // surplus tail
    const out = buildLoopChannel(samples, 4)
    expect(Array.from(out)).toEqual([1, 0.75, 0.5, 0.25])
  })

  it('leaves the body beyond the fade untouched', () => {
    const samples = ramp(200)
    const out = buildLoopChannel(samples, 20)
    for (let i = 20; i < out.length; i++) expect(out[i]).toBe(samples[i])
  })

  it('clamps the fade on captures too short for it', () => {
    const out = buildLoopChannel(new Float32Array(10).fill(1), 1000)
    expect(out).toHaveLength(5)
    for (const sample of out) expect(sample).toBe(1)
  })

  it('is the identity at zero fade', () => {
    const samples = ramp(50)
    expect(Array.from(buildLoopChannel(samples, 0))).toEqual(Array.from(samples))
  })
})

describe('quantiseLoopSeconds', () => {
  it('snaps the requested length to the nearest whole beat count', () => {
    // 128 bpm: beat 0.46875 s; 4 s ≈ 8.53 beats → 9 beats.
    expect(quantiseLoopSeconds(4, 128)).toBeCloseTo(9 * (60 / 128), 6)
  })

  it('is exact when the length already sits on the grid', () => {
    expect(quantiseLoopSeconds(2, 120)).toBeCloseTo(2, 6)
  })

  it('never quantises below one beat', () => {
    expect(quantiseLoopSeconds(0.2, 60)).toBe(1)
  })

  it('never quantises below the capture refusal floor', () => {
    // One beat at 200 bpm is 0.3 s — under MIN_LOOP_SECONDS; the
    // quantiser must add beats rather than produce a refused press.
    expect(quantiseLoopSeconds(0.2, 200)).toBeGreaterThanOrEqual(0.5)
  })
})

describe('generatedLoopSeconds', () => {
  it('snaps a long-enough request to the nearest whole bar count', () => {
    // 124 bpm: bar 1.935 s; 8 s ≈ 4.13 bars → 4 bars.
    expect(generatedLoopSeconds(8, 124)).toBeCloseTo(4 * 4 * (60 / 124), 6)
  })

  it('raises a short request to the quality floor in whole bars', () => {
    // 134 bpm: bar 1.791 s; 4 s would be 2 bars = 3.58 s — measured
    // garbled. The floor demands ceil(7 / 1.791) = 4 bars.
    expect(generatedLoopSeconds(4, 134)).toBeCloseTo(4 * 4 * (60 / 134), 6)
    expect(generatedLoopSeconds(4, 134)).toBeGreaterThanOrEqual(7)
  })

  it('rounding near the floor can never dip back under it', () => {
    // 103 bpm: bar 2.33 s; 7 s = 3.004 bars — nearest-rounding alone
    // would allow 3 bars from a slightly faster tempo to land at 6.x s.
    const result = generatedLoopSeconds(1, 103)
    expect(result).toBeGreaterThanOrEqual(7)
    const bars = result / (4 * (60 / 103))
    expect(Math.abs(bars - Math.round(bars))).toBeLessThan(1e-9)
  })

  it('applies the floor free-length when the gate is blank', () => {
    expect(generatedLoopSeconds(2, null)).toBe(7)
    expect(generatedLoopSeconds(8, null)).toBe(8)
  })
})
