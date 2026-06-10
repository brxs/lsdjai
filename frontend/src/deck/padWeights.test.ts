import { describe, expect, it } from 'vitest'

import { padWeights, targetPositions } from './padWeights'

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
    const targets = targetPositions(5)
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
})

describe('targetPositions', () => {
  it('centres a single target', () => {
    expect(targetPositions(1)).toEqual([{ x: 0.5, y: 0.5 }])
  })

  it('spreads several targets on a circle inside the pad', () => {
    const positions = targetPositions(6)
    expect(positions).toHaveLength(6)
    for (const { x, y } of positions) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(1)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(1)
      expect(Math.hypot(x - 0.5, y - 0.5)).toBeCloseTo(0.38)
    }
  })
})
