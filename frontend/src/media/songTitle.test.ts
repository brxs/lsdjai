import { afterEach, describe, expect, it, vi } from 'vitest'

import { randomSongTitle } from './songTitle'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('randomSongTitle', () => {
  it('combines the first adjective and noun at the low boundary', () => {
    // 0 → index 0 of each list, so the pick is deterministic.
    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(randomSongTitle()).toBe('Velvet Mirage')
  })

  it('always returns two capitalised words across the range', () => {
    // Sweep [0, 1) including the top boundary so every index is reachable.
    const picks = [0, 0.33, 0.66, 0.9999]
    let i = 0
    vi.spyOn(Math, 'random').mockImplementation(() => picks[i++ % picks.length])
    for (let n = 0; n < 16; n++) {
      const words = randomSongTitle().split(' ')
      expect(words).toHaveLength(2)
      for (const word of words) {
        expect(word).toMatch(/^[A-Z][a-z]+$/)
      }
    }
  })
})
