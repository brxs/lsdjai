import { describe, expect, it } from 'vitest'

import {
  crushCurve,
  DUB_ECHO_SECONDS,
  dubEchoCurve,
  echoDelaySeconds,
  FX_KINDS,
  filterCurve,
  fxBlend,
  fxRestPosition,
  isFxActive,
  noiseCurve,
  spaceCurve,
  sweepCurve,
} from './fx'

describe('rest positions and the dead zone', () => {
  it('rests the bipolar filter at centre and everything else at zero', () => {
    expect(fxRestPosition('filter')).toBe(0.5)
    for (const kind of FX_KINDS.filter((k) => k !== 'filter')) {
      expect(fxRestPosition(kind)).toBe(0)
    }
  })

  it('is inactive at rest and just around it, active beyond', () => {
    for (const kind of FX_KINDS) {
      const rest = fxRestPosition(kind)
      expect(isFxActive(kind, rest)).toBe(false)
      expect(isFxActive(kind, rest + 0.01)).toBe(false)
      expect(isFxActive(kind, rest + 0.05)).toBe(true)
    }
    expect(isFxActive('filter', 0.4)).toBe(true) // both directions
  })

  it('clamps out-of-range amounts', () => {
    expect(isFxActive('space', -1)).toBe(false)
    expect(isFxActive('space', 2)).toBe(true)
  })

  it('classifies replace vs additive blends', () => {
    expect(fxBlend('filter')).toBe('replace')
    expect(fxBlend('crush')).toBe('replace')
    expect(fxBlend('sweep')).toBe('replace')
    expect(fxBlend('dub_echo')).toBe('add')
    expect(fxBlend('space')).toBe('add')
    expect(fxBlend('noise')).toBe('add')
  })
})

describe('filterCurve', () => {
  it('sweeps a low-pass down on the left half', () => {
    const mid = filterCurve(0.25)
    const hard = filterCurve(0)
    expect(mid.type).toBe('lowpass')
    expect(hard.type).toBe('lowpass')
    expect(mid.frequency).toBeLessThan(18_000)
    expect(hard.frequency).toBeLessThan(mid.frequency)
    expect(hard.frequency).toBeCloseTo(80)
  })

  it('sweeps a high-pass up on the right half', () => {
    const mid = filterCurve(0.75)
    const hard = filterCurve(1)
    expect(mid.type).toBe('highpass')
    expect(mid.frequency).toBeGreaterThan(30)
    expect(hard.frequency).toBeCloseTo(6_000)
  })

  it('is effectively open at centre on both sides', () => {
    expect(filterCurve(0.5).frequency).toBeCloseTo(30) // highpass fully open
    expect(filterCurve(0.499).type).toBe('lowpass')
    expect(filterCurve(0.499).frequency).toBeGreaterThan(17_000)
  })
})

describe('dubEchoCurve', () => {
  it('rises wet and feedback together from silence', () => {
    expect(dubEchoCurve(0)).toEqual({ wet: 0, feedback: 0 })
    const half = dubEchoCurve(0.5)
    expect(half.wet).toBeCloseTo(0.45)
    expect(half.feedback).toBeCloseTo(0.45)
  })

  it('caps feedback below unity so tails always die', () => {
    expect(dubEchoCurve(1).feedback).toBeLessThan(1)
    expect(dubEchoCurve(5).feedback).toBeLessThan(1)
  })
})

describe('echoDelaySeconds', () => {
  it('free-runs without a beat period', () => {
    expect(echoDelaySeconds(null)).toBe(DUB_ECHO_SECONDS)
    expect(echoDelaySeconds(0)).toBe(DUB_ECHO_SECONDS)
  })

  it('snaps to the beat fraction nearest its free-running character', () => {
    // 120 bpm (0.5 s beat): 3/4 beat = 0.375 s beats 1/2 beat = 0.25 s.
    expect(echoDelaySeconds(0.5)).toBeCloseTo(0.375, 6)
    // 90 bpm (0.667 s beat): 1/2 beat = 0.333 s.
    expect(echoDelaySeconds(60 / 90)).toBeCloseTo(0.5 * (60 / 90), 6)
  })

  it('always lands on a musical fraction of the beat', () => {
    for (const bpm of [60, 90, 120, 128, 150, 174, 200]) {
      const beat = 60 / bpm
      const fraction = echoDelaySeconds(beat) / beat
      expect([0.25, 0.375, 0.5, 0.75, 1]).toContainEqual(
        expect.closeTo(fraction, 6),
      )
    }
  })

  it('respects the delay node ceiling on slow beats', () => {
    // 60 bpm: a full beat is exactly the 1 s ceiling — still allowed.
    expect(echoDelaySeconds(1)).toBeLessThanOrEqual(1)
    // Slower than the range allows: every usable fraction fits.
    expect(echoDelaySeconds(1.5)).toBeLessThanOrEqual(1)
  })
})

describe('crushCurve', () => {
  it('degrades from transparent to 4 bits and 40-sample hold', () => {
    expect(crushCurve(0)).toEqual({ bits: 16, reduction: 1 })
    expect(crushCurve(1)).toEqual({ bits: 4, reduction: 40 })
  })
})

describe('noiseCurve', () => {
  it('raises level and filter frequency together (a riser)', () => {
    expect(noiseCurve(0).level).toBe(0)
    const low = noiseCurve(0.2)
    const high = noiseCurve(0.9)
    expect(high.level).toBeGreaterThan(low.level)
    expect(high.frequency).toBeGreaterThan(low.frequency)
    expect(noiseCurve(1).frequency).toBeCloseTo(9_000)
  })
})

describe('sweepCurve', () => {
  it('speeds up and deepens together, depth capped at full', () => {
    expect(sweepCurve(0)).toEqual({ rateHz: 0.5, depth: 0 })
    expect(sweepCurve(1).rateHz).toBeCloseTo(8)
    expect(sweepCurve(1).depth).toBe(1)
    expect(sweepCurve(0.5).depth).toBeCloseTo(0.6)
  })
})

describe('spaceCurve', () => {
  it('is a plain clamped wet blend', () => {
    expect(spaceCurve(0).wet).toBe(0)
    expect(spaceCurve(0.7).wet).toBeCloseTo(0.7)
    expect(spaceCurve(2).wet).toBe(1)
  })
})
