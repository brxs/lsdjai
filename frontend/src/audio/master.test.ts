import { describe, expect, it } from 'vitest'

import {
  clipGuardCurve,
  createLoudnessTracker,
  dbToGain,
  gainToDb,
  LIMITER_CEILING,
  TRIM_RANGE_DB,
  TRIM_TARGET_RMS,
  trimDbFor,
} from './master'

describe('clipGuardCurve', () => {
  it('never exceeds the ceiling', () => {
    for (const value of clipGuardCurve()) {
      expect(Math.abs(value)).toBeLessThanOrEqual(LIMITER_CEILING)
    }
  })

  it('is transparent inside the ceiling', () => {
    const curve = clipGuardCurve(4097) // odd: exact sample at x = 0.5
    const at = (x: number) => curve[Math.round(((x + 1) / 2) * (curve.length - 1))]
    expect(at(0)).toBeCloseTo(0, 6)
    expect(at(0.5)).toBeCloseTo(0.5, 3)
    expect(at(-0.5)).toBeCloseTo(-0.5, 3)
  })

  it('clamps everything beyond the ceiling, symmetrically', () => {
    const curve = clipGuardCurve()
    expect(curve[0]).toBe(-LIMITER_CEILING)
    expect(curve[curve.length - 1]).toBe(LIMITER_CEILING)
  })
})

describe('trimDbFor', () => {
  it('is flat when the deck already sits on the target', () => {
    expect(trimDbFor(TRIM_TARGET_RMS)).toBeCloseTo(0, 6)
  })

  it('boosts a quiet deck and cuts a hot one toward the target', () => {
    expect(trimDbFor(TRIM_TARGET_RMS / 2)).toBeCloseTo(6.02, 1)
    expect(trimDbFor(TRIM_TARGET_RMS * 2)).toBeCloseTo(-6.02, 1)
  })

  it('clamps to the knob range', () => {
    expect(trimDbFor(0.006)).toBe(TRIM_RANGE_DB)
    expect(trimDbFor(1)).toBe(-TRIM_RANGE_DB)
  })

  it('holds (null) on silence instead of winding up', () => {
    expect(trimDbFor(0)).toBeNull()
    expect(trimDbFor(0.004)).toBeNull()
  })
})

describe('db/gain round trip', () => {
  it('is inverse within float precision', () => {
    for (const db of [-12, -6, 0, 6, 12]) {
      expect(gainToDb(dbToGain(db))).toBeCloseTo(db, 9)
    }
  })
})

describe('createLoudnessTracker', () => {
  const RATE = 48_000

  function constantChunk(amplitude: number, frames = 4800): Float32Array {
    const out = new Float32Array(frames * 2)
    for (let i = 0; i < out.length; i++) out[i] = amplitude
    return out
  }

  it('converges on the RMS of a steady signal', () => {
    const tracker = createLoudnessTracker(RATE, 2)
    for (let i = 0; i < 40; i++) tracker.push(constantChunk(0.25))
    expect(tracker.rms()).toBeCloseTo(0.25, 2)
  })

  it('reads the early signal as a plain average, not biased to zero', () => {
    const tracker = createLoudnessTracker(RATE, 10)
    tracker.push(constantChunk(0.25)) // one 0.1 s chunk
    expect(tracker.rms()).toBeCloseTo(0.25, 2)
  })

  it('moves slowly relative to its window', () => {
    const tracker = createLoudnessTracker(RATE, 10)
    for (let i = 0; i < 200; i++) tracker.push(constantChunk(0.25))
    tracker.push(constantChunk(0.025)) // 0.1 s of a 20 dB drop
    expect(tracker.rms()).toBeGreaterThan(0.2) // barely moved
  })

  it('resets to silence', () => {
    const tracker = createLoudnessTracker(RATE, 2)
    tracker.push(constantChunk(0.5))
    tracker.reset()
    expect(tracker.rms()).toBe(0)
  })
})
