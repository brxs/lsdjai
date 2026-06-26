import { describe, expect, it } from 'vitest'

import { sameMask } from './selectionMask'

// The equality the pad-LED no-churn guard depends on: when it holds, App keeps
// the same padSelections reference so the LED effect doesn't re-fire on a no-op
// selection event.
describe('sameMask', () => {
  it('is true for identical masks', () => {
    expect(sameMask([true, false, true], [true, false, true])).toBe(true)
  })

  it('is false when a flag differs', () => {
    expect(sameMask([true, false], [true, true])).toBe(false)
  })

  it('is false when the length differs', () => {
    expect(sameMask([true], [true, false])).toBe(false)
  })
})
