import { describe, expect, it } from 'vitest'

import { buildLoopChannel, quantiseLoopSeconds } from './loops'

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
