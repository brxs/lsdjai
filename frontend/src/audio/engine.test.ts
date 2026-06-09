import { describe, expect, it } from 'vitest'

import { equalPowerGains } from './engine'

describe('equalPowerGains', () => {
  it('gives full A and silent B at position 0', () => {
    expect(equalPowerGains(0)).toEqual({ a: 1, b: 0 })
  })

  it('gives silent A and full B at position 1', () => {
    const { a, b } = equalPowerGains(1)
    expect(a).toBeCloseTo(0)
    expect(b).toBeCloseTo(1)
  })

  it('holds constant power across the sweep', () => {
    for (const x of [0, 0.25, 0.5, 0.75, 1]) {
      const { a, b } = equalPowerGains(x)
      expect(a * a + b * b).toBeCloseTo(1)
    }
  })

  it('clamps out-of-range positions', () => {
    expect(equalPowerGains(-1)).toEqual(equalPowerGains(0))
    expect(equalPowerGains(2)).toEqual(equalPowerGains(1))
  })
})
