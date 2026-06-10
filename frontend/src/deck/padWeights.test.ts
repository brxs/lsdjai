import { describe, expect, it } from 'vitest'

import {
  padWeights,
  spawnPosition,
  sweepPosition,
  type PadPoint,
} from './padWeights'

describe('padWeights', () => {
  it('gives the full weight to a target the cursor sits on', () => {
    const targets = [
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.8 },
    ]
    expect(padWeights(targets, { x: 0.2, y: 0.2 })).toEqual([1, 0])
  })

  it('splits evenly at the midpoint of two targets', () => {
    const targets = [
      { x: 0, y: 0.5 },
      { x: 1, y: 0.5 },
    ]
    const [a, b] = padWeights(targets, { x: 0.5, y: 0.5 })
    expect(a).toBeCloseTo(0.5)
    expect(b).toBeCloseTo(0.5)
  })

  it('always normalizes to a total of 1', () => {
    const targets = [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.2 },
      { x: 0.4, y: 0.8 },
      { x: 0.6, y: 0.6 },
      { x: 0.2, y: 0.5 },
    ]
    const weights = padWeights(targets, { x: 0.31, y: 0.77 })
    expect(weights.reduce((sum, w) => sum + w, 0)).toBeCloseTo(1)
    for (const weight of weights) expect(weight).toBeGreaterThan(0)
  })

  it('weights the nearer target heavier', () => {
    const targets = [
      { x: 0.1, y: 0.5 },
      { x: 0.9, y: 0.5 },
    ]
    const [near, far] = padWeights(targets, { x: 0.3, y: 0.5 })
    expect(near).toBeGreaterThan(far)
  })

  it('lets a dragged cluster dominate together', () => {
    // Two targets clustered bottom-left, one far away top-right; a cursor
    // near the cluster gives the pair most of the weight.
    const targets = [
      { x: 0.2, y: 0.8 },
      { x: 0.25, y: 0.75 },
      { x: 0.9, y: 0.1 },
    ]
    const [a, b, far] = padWeights(targets, { x: 0.22, y: 0.78 })
    expect(a + b).toBeGreaterThan(0.9)
    expect(far).toBeLessThan(0.1)
  })
})

describe('spawnPosition', () => {
  it('starts at 12 o\'clock on an empty pad', () => {
    const first = spawnPosition([])
    expect(first.x).toBeCloseTo(0.5)
    expect(first.y).toBeCloseTo(0.12)
  })

  it('spawns opposite a single existing target', () => {
    const first = spawnPosition([])
    const second = spawnPosition([first])
    expect(second.x).toBeCloseTo(0.5)
    expect(second.y).toBeCloseTo(0.88)
  })

  it('never spawns on top of existing targets and stays inside the pad', () => {
    const placed: PadPoint[] = []
    for (let i = 0; i < 8; i++) {
      const next = spawnPosition(placed)
      for (const existing of placed) {
        expect(Math.hypot(existing.x - next.x, existing.y - next.y)).toBeGreaterThan(
          0.1,
        )
      }
      expect(next.x).toBeGreaterThanOrEqual(0)
      expect(next.x).toBeLessThanOrEqual(1)
      expect(next.y).toBeGreaterThanOrEqual(0)
      expect(next.y).toBeLessThanOrEqual(1)
      placed.push(next)
    }
  })

  it('is deterministic for the same arrangement', () => {
    const existing = [{ x: 0.3, y: 0.3 }]
    expect(spawnPosition(existing)).toEqual(spawnPosition(existing))
  })
})

describe('sweepPosition', () => {
  it('starts at 12 o\'clock, matching the first spawn slot', () => {
    const start = sweepPosition(0)
    expect(start.x).toBeCloseTo(0.5)
    expect(start.y).toBeCloseTo(0.12)
    expect(start).toEqual(spawnPosition([]))
  })

  it('sweeps clockwise: a quarter turn lands at 3 o\'clock', () => {
    const quarter = sweepPosition(0.25)
    expect(quarter.x).toBeCloseTo(0.88)
    expect(quarter.y).toBeCloseTo(0.5)
  })

  it('reaches the bottom at the halfway point', () => {
    const half = sweepPosition(0.5)
    expect(half.x).toBeCloseTo(0.5)
    expect(half.y).toBeCloseTo(0.88)
  })

  it('closes the loop: fraction 1 returns to the start', () => {
    const start = sweepPosition(0)
    const end = sweepPosition(1)
    expect(end.x).toBeCloseTo(start.x)
    expect(end.y).toBeCloseTo(start.y)
  })

  it('stays inside the pad for any fraction', () => {
    for (let i = 0; i <= 20; i++) {
      const point = sweepPosition(i / 20)
      expect(point.x).toBeGreaterThanOrEqual(0)
      expect(point.x).toBeLessThanOrEqual(1)
      expect(point.y).toBeGreaterThanOrEqual(0)
      expect(point.y).toBeLessThanOrEqual(1)
    }
  })
})
