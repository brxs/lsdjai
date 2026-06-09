import { describe, expect, it } from 'vitest'

import { combinedRamWarning } from './ramWarning'

const ramInfo = {
  totalGb: 16,
  estimateGbByModel: { mrt2_small: 2, mrt2_base: 6 },
}

describe('combinedRamWarning', () => {
  it('stays quiet while a deck model is unknown', () => {
    expect(combinedRamWarning({ a: 'mrt2_small', b: null }, ramInfo)).toBeNull()
    expect(combinedRamWarning({ a: 'mrt2_small', b: 'mrt2_small' }, null)).toBeNull()
  })

  it('stays quiet for a comfortable combination', () => {
    expect(combinedRamWarning({ a: 'mrt2_small', b: 'mrt2_base' }, ramInfo)).toBeNull()
  })

  it('warns when the combination crowds the machine', () => {
    expect(combinedRamWarning({ a: 'mrt2_base', b: 'mrt2_base' }, ramInfo)).toEqual({
      combined: '12',
      total: '16',
    })
  })
})
